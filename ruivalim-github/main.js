/**
 * GitHub (Rui): GitHub service plugin (PAT mode, github.com only).
 *
 * Unofficial personal English copy of the official cindy-github plugin, under
 * the ruivalim- id prefix. Auth is a pasted Personal Access Token only: the
 * host's local GitHub CLI login (secret source gh-cli) is reserved for the
 * official cindy-github id.
 *
 * How it works:
 * - Host-proxied allowlist: cindy.fetch can only reach the hosts declared in
 *   ghost.json and the host sends the request, so the sandbox never connects
 *   directly. The PAT lives in the host vault and is injected only into the
 *   Authorization header for api.github.com; this file never has, and cannot
 *   have, any token bytes.
 * - Tool surface = two-step catalog (FORGE_GUIDE 3.5): only the list_tools /
 *   call_tool meta tools are declared, and the 117 operations sit in this
 *   file's OPS table across 15 categories. Same progressive shape as the old
 *   lizi_github MCP, so the main agent has nothing new to learn; changing tools
 *   only updates the plugin, not the app.
 * - Repo-level operations require explicit owner/repo: the sandbox has no file
 *   system, so it cannot derive them from the session workdir's git remote like
 *   the old MCP did. The main agent derives them and passes them in.
 * - Result guardrail: by default, API link fields (url / *_url, except
 *   html_url) are stripped recursively from GitHub responses to cut size. Over
 *   50KB (or when the caller names out_file), the full JSON is written to the
 *   session work directory through the fs slot and only the path is returned
 *   (the equivalent of the old MCP out_file spill, restored once the fs slot
 *   shipped in 2026-07). Truncation is only the fallback when writing is not
 *   available (plan mode / SSH remote workspace). call_tool with raw=true
 *   returns the JSON as is (file and inline output match; raw decides whether
 *   to strip).
 * - Actions artifacts / log zips: the old MCP only returned a 302 signed URL;
 *   here they are actually downloaded to disk (as:'file' + save_dir ticket;
 *   GitHub's download redirect hosts are in the allowlist).
 */

/* global cindy */

var API = 'https://api.github.com';
/** Result size guardrail (same as xd-atlassian). */
var RESULT_MAX_CHARS = 50 * 1000;

/* ── Basic helpers ───────────────────────────────────────────────────────── */

function fail(message) {
  return { ok: false, message: message };
}

function qs(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v[i])));
    } else {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** Pass pagination through (GitHub-wide per_page / page). */
function pg(a) {
  return { per_page: a.per_page, page: a.page };
}

/** Encode a multi-segment path one segment at a time (get_contents and other paths containing /). */
function encPath(p) {
  return String(p)
    .split('/')
    .map(function (seg) { return encodeURIComponent(seg); })
    .join('/');
}

/** HTTP status to readable text (401 here = token missing or expired). */
function classifyStatus(status, bodySnippet) {
  if (status === 401) return 'GitHub authorization is missing or expired: open Plugins > "GitHub (Rui)" settings and save a new personal access token';
  if (status === 403) {
    if (bodySnippet && bodySnippet.indexOf('rate limit') >= 0) return 'GitHub API rate limit hit (HTTP 403 rate limit), try again later';
    return 'No permission for this operation (HTTP 403). Check repository access and token scopes; other features of the account may still work: ' + bodySnippet;
  }
  if (status === 404) return 'Not found or no access (HTTP 404)';
  if (status === 422) return 'GitHub rejected the request parameters (HTTP 422): ' + bodySnippet;
  if (status === 429) return 'GitHub API rate limit hit (HTTP 429), try again later';
  return 'GitHub API returned HTTP ' + status + ': ' + bodySnippet;
}

/**
 * Shared GitHub REST call. The host injects credentials; this only handles
 * URL / method / body. Success: { data, status, headers }; failure: { err }.
 */
async function api(opts) {
  var req = {
    url: opts.url,
    method: opts.method || 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    callId: opts.callId,
  };
  if (opts.body !== undefined) {
    req.headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(opts.body);
  }
  var r = await cindy.fetch(req);
  if (!r.ok) return { err: r.message };
  var data = null;
  if (r.body) {
    try {
      data = JSON.parse(r.body);
    } catch (e) {
      data = r.body;
    }
  }
  if (r.status < 200 || r.status >= 300) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    return { err: classifyStatus(r.status, snippet) };
  }
  return { data: data, status: r.status, headers: r.headers || {} };
}

/** GraphQL call (github.com always uses /graphql; non-empty errors count as failure). */
async function gql(query, variables, callId) {
  var r = await api({ url: API + '/graphql', method: 'POST', body: { query: query, variables: variables || {} }, callId: callId });
  if (r.err) return { err: r.err };
  var d = r.data;
  if (d && Array.isArray(d.errors) && d.errors.length) {
    return { err: 'GitHub GraphQL error: ' + JSON.stringify(d.errors).slice(0, 500) };
  }
  if (!d || d.data === undefined) return { err: 'GitHub GraphQL response has no data' };
  return { data: d.data };
}

/**
 * Slimming: about half of a GitHub response is API link fields, useless to an
 * LLM, so url / *_url and gravatar_id are stripped recursively. Three links
 * with a real use are kept: html_url (the page for humans) and download_url /
 * browser_download_url (download URLs for large get_contents files and release
 * assets; stripping them would make the operation descriptions meaningless).
 * Skipped when raw=true.
 */
var SLIM_KEEP_URLS = { html_url: 1, download_url: 1, browser_download_url: 1 };

function slim(value) {
  if (Array.isArray(value)) return value.map(slim);
  if (value && typeof value === 'object') {
    var out = {};
    for (var k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
      if (k === 'gravatar_id') continue;
      if (k === 'url' || (k.length > 4 && k.slice(-4) === '_url' && !SLIM_KEEP_URLS[k])) continue;
      out[k] = slim(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Deliver the result: slimmed by default. When too long (or the caller names
 * out_file), write the full JSON to the session work directory through the fs
 * slot and return only the file path (the equivalent of the old MCP out_file
 * spill; the agent reads the relative path itself or hands it to a script).
 * Writing follows the session permission mode (silent in auto-approve mode,
 * the host shows a confirmation card in per-call mode). When refused, failed,
 * or in a remote workspace, fall back to truncation plus a pagination hint.
 */
async function deliver(data, raw, outFile, callId) {
  var payload = raw ? data : slim(data === undefined ? null : data);
  var text = JSON.stringify(payload === undefined ? null : payload);
  if (!outFile && text.length <= RESULT_MAX_CHARS) return { ok: true, result: { data: payload } };
  var spillNote = null;
  if (callId) {
    var fileName = outFile || 'github-result-' + String(callId).slice(0, 8) + '.json';
    var w = await cindy.send({
      type: 'fs-request', op: 'write', root: 'workdir',
      path: fileName, content: text, callId: callId,
    });
    if (w && w.ok) {
      return {
        ok: true,
        result: {
          saved_to: w.path,
          bytes: w.bytes,
          hint: 'Full result written to this path relative to the session work directory; read it with a file tool or hand it to a script',
        },
      };
    }
    spillNote = w && w.message ? 'Writing to disk failed (' + w.message + ')' : 'Writing to disk failed';
  }
  if (text.length <= RESULT_MAX_CHARS) {
    // out_file was named but the write was refused or failed, and the size is within
    // limits: return inline with an honest note.
    return { ok: true, result: { data: payload, note: spillNote } };
  }
  return {
    ok: true,
    result: {
      truncated: true,
      hint:
        (spillNote ? spillNote + '; ' : '') +
        'Response too large and truncated: paginate with per_page / page, or use a narrower operation (such as a single get)',
      preview: text.slice(0, RESULT_MAX_CHARS),
    },
  };
}

/** Validate owner/repo for repo-level operations and build the base URL. */
function repoBase(a) {
  if (!a.owner || !a.repo) {
    return { err: 'Repo-level operations require explicit owner and repo (when working in a git repository, the main agent can derive them from `git remote get-url origin` and pass them in)' };
  }
  return { base: API + '/repos/' + encodeURIComponent(a.owner) + '/' + encodeURIComponent(a.repo) };
}

/** Download a zip (Actions artifact / logs) to the user directory; requires a save_dir ticket. */
async function downloadZip(url, a, callId, suggestedName) {
  if (!a.save_deposit || !a.save_deposit.token) {
    return { err: 'Download needs a destination directory: the main agent must pass the absolute path of the target directory in the top-level save_dir parameter of ghost_call' };
  }
  var r = await cindy.fetch({
    url: url,
    as: 'file',
    saveTo: { token: a.save_deposit.token, filename: a.filename || suggestedName },
    timeoutMs: 300000,
    callId: callId,
  });
  if (!r.ok) return { err: r.message };
  if (!r.file) {
    var snippet = typeof r.body === 'string' ? r.body.slice(0, 300) : '';
    return { err: classifyStatus(r.status, snippet) };
  }
  return {
    result: {
      downloaded: true,
      dir_name: a.save_deposit.dir_name,
      file_name: r.file.file_name,
      bytes: r.file.bytes,
      note: 'Saved to ' + a.save_deposit.dir_name + '/' + r.file.file_name,
    },
  };
}

/* ── Operation catalog ───────────────────────────────────────────────────
 * Each operation: { cat, desc, params (parameter notes for list_tools and the
 * error echo), run }.
 * run(a, callId) returns { err } | { data } | { result } (result = final
 * result body). Parameter notation: * = required; [repo] = owner and repo
 * required together; pp = per_page?/page?.
 * ──────────────────────────────────────────────────────────────────── */

var REPO_DOC = 'owner*:string, repo*:string(required together)';
var PP_DOC = 'per_page?:1-100, page?:int';

var CATEGORIES = {
  issues: 'issues and comments / labels / assignees / sub-issues',
  pulls: 'full PR lifecycle: create / files and commits / reviews and line comments / threads / merge',
  repo: 'repo metadata / branches / read and write file contents / collaborators / topics / create repo',
  meta: 'current user and the GraphQL escape hatch',
  events: 'user / org / repo event streams',
  commits: 'commit list / details / compare / check runs',
  search: 'site-wide search: repos / issues / commits / code / users',
  users: 'user profiles / orgs / accessible repos',
  actions: 'GitHub Actions: workflows / runs / jobs / artifacts / log download',
  releases: 'releases and assets',
  notifications: 'notifications',
  orgs: 'org members / teams',
  gists: 'gists',
  git_data: 'low-level git objects: refs / trees / commits / atomic multi-file commit',
  reactions: 'reactions on issues / comments / review comments',
};

var OPS = {};

function op(name, cat, desc, params, run) {
  OPS[name] = { cat: cat, desc: desc, params: params, run: run };
}

/* ── issues(14) ────────────────────────────────────────────────────── */

op('list_issues', 'issues', 'List issues (note: PRs also show up in the results, with a pull_request field)',
  REPO_DOC + ', state?:open|closed|all, labels?:string(comma-separated), sort?:created|updated|comments, direction?:asc|desc, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/issues' + qs({ state: a.state, labels: a.labels, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page }), callId: c });
  });

op('get_issue', 'issues', 'Get a single issue', REPO_DOC + ', issue_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    return api({ url: r.base + '/issues/' + a.issue_number, callId: c });
  });

op('create_issue', 'issues', 'Create an issue (write; confirm the content with the user first)',
  REPO_DOC + ', title*:string, body?:string, labels?:string[], assignees?:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.title) return { err: 'Required: title' };
    return api({ url: r.base + '/issues', method: 'POST', body: { title: a.title, body: a.body, labels: a.labels, assignees: a.assignees }, callId: c });
  });

op('list_issue_comments', 'issues', 'List comments on an issue/PR', REPO_DOC + ', issue_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/comments?per_page=100', callId: c });
  });

op('add_issue_comment', 'issues', 'Add a comment to an issue/PR (write)', REPO_DOC + ', issue_number*:int, body*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !a.body) return { err: 'Required: issue_number / body' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/comments', method: 'POST', body: { body: a.body }, callId: c });
  });

op('update_issue_labels', 'issues', 'Add/remove labels incrementally (reads the current labels, merges, writes back)',
  REPO_DOC + ', issue_number*:int, add_labels?:string[], remove_labels?:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    var cur = await api({ url: r.base + '/issues/' + a.issue_number, callId: c });
    if (cur.err) return cur;
    var names = {};
    var labels = (cur.data && cur.data.labels) || [];
    for (var i = 0; i < labels.length; i++) names[typeof labels[i] === 'string' ? labels[i] : labels[i].name] = 1;
    (a.add_labels || []).forEach(function (n) { names[n] = 1; });
    (a.remove_labels || []).forEach(function (n) { delete names[n]; });
    return api({ url: r.base + '/issues/' + a.issue_number, method: 'PATCH', body: { labels: Object.keys(names) }, callId: c });
  });

op('update_issue', 'issues', 'Update an issue (title/body/open-close/labels/assignees; write)',
  REPO_DOC + ', issue_number*:int, title?, body?, state?:open|closed, state_reason?:completed|not_planned|reopened, labels?:string[], assignees?:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    return api({
      url: r.base + '/issues/' + a.issue_number, method: 'PATCH',
      body: { title: a.title, body: a.body, state: a.state, state_reason: a.state_reason, labels: a.labels, assignees: a.assignees },
      callId: c,
    });
  });

op('add_issue_assignees', 'issues', 'Add assignees', REPO_DOC + ', issue_number*:int, assignees*:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !Array.isArray(a.assignees) || !a.assignees.length) return { err: 'Required: issue_number / assignees' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/assignees', method: 'POST', body: { assignees: a.assignees }, callId: c });
  });

op('remove_issue_assignees', 'issues', 'Remove assignees', REPO_DOC + ', issue_number*:int, assignees*:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !Array.isArray(a.assignees) || !a.assignees.length) return { err: 'Required: issue_number / assignees' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/assignees', method: 'DELETE', body: { assignees: a.assignees }, callId: c });
  });

op('add_issue_labels', 'issues', 'Add labels (keeps the existing ones)', REPO_DOC + ', issue_number*:int, labels*:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !Array.isArray(a.labels) || !a.labels.length) return { err: 'Required: issue_number / labels' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/labels', method: 'POST', body: { labels: a.labels }, callId: c });
  });

op('remove_issue_label', 'issues', 'Remove a single label', REPO_DOC + ', issue_number*:int, name*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !a.name) return { err: 'Required: issue_number / name' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/labels/' + encodeURIComponent(a.name), method: 'DELETE', callId: c });
  });

op('get_label', 'issues', 'Get a single label definition from the repo', REPO_DOC + ', name*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.name) return { err: 'Required: name' };
    return api({ url: r.base + '/labels/' + encodeURIComponent(a.name), callId: c });
  });

op('list_sub_issues', 'issues', 'List sub-issues', REPO_DOC + ', issue_number*:int, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/sub_issues' + qs(pg(a)), callId: c });
  });

op('add_sub_issue', 'issues', 'Add a sub-issue (sub_issue_id is the global issue id, not the number)',
  REPO_DOC + ', issue_number*:int, sub_issue_id*:int, replace_parent?:bool',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !a.sub_issue_id) return { err: 'Required: issue_number / sub_issue_id' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/sub_issues', method: 'POST', body: { sub_issue_id: a.sub_issue_id, replace_parent: a.replace_parent }, callId: c });
  });

/* ── pulls(25) ─────────────────────────────────────────────────────── */

op('list_pull_requests', 'pulls', 'List PRs',
  REPO_DOC + ', state?:open|closed|all, base?:string, head?:string, sort?:created|updated|popularity|long-running, direction?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/pulls' + qs({ state: a.state, base: a.base, head: a.head, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page }), callId: c });
  });

op('get_pull_request', 'pulls', 'Get a single PR (with merged / draft / mergeable state)', REPO_DOC + ', pr_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number, callId: c });
  });

op('create_pull_request', 'pulls', 'Create a PR (write; for a cross-fork head use "owner:branch")',
  REPO_DOC + ', title*:string, head*:string, base*:string, body?:string, draft?:bool',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.title || !a.head || !a.base) return { err: 'Required: title / head / base' };
    return api({ url: r.base + '/pulls', method: 'POST', body: { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft }, callId: c });
  });

op('list_pull_request_files', 'pulls', 'List files changed in a PR (with patch; paginate for large PRs)',
  REPO_DOC + ', pr_number*:int, per_page?:1-100(default 100), page?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/files' + qs({ per_page: a.per_page || 100, page: a.page }), callId: c });
  });

op('list_pull_request_commits', 'pulls', 'List commits in a PR', REPO_DOC + ', pr_number*:int, per_page?(default 100), page?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/commits' + qs({ per_page: a.per_page || 100, page: a.page }), callId: c });
  });

op('list_pull_request_reviews', 'pulls', 'List reviews (approve / request_changes / comment; node_id is what line comments on a pending review need)',
  REPO_DOC + ', pr_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/reviews?per_page=100', callId: c });
  });

op('list_pull_request_review_comments', 'pulls', 'List inline code comments', REPO_DOC + ', pr_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/comments?per_page=100', callId: c });
  });

op('merge_pull_request', 'pulls', 'Merge a PR (write; confirm with the user first)',
  REPO_DOC + ', pr_number*:int, merge_method?:merge|squash|rebase, commit_title?, commit_message?, sha?:string(head check)',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({
      url: r.base + '/pulls/' + a.pr_number + '/merge', method: 'PUT',
      body: { commit_title: a.commit_title, commit_message: a.commit_message, sha: a.sha, merge_method: a.merge_method },
      callId: c,
    });
  });

op('update_pull_request', 'pulls', 'Update a PR (title/body/open-close/base; write)',
  REPO_DOC + ', pr_number*:int, title?, body?, state?:open|closed, base?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number, method: 'PATCH', body: { title: a.title, body: a.body, state: a.state, base: a.base }, callId: c });
  });

op('create_pull_request_review', 'pulls', 'Submit a review in one call (may include inline comments; write)',
  REPO_DOC + ', pr_number*:int, event*:APPROVE|REQUEST_CHANGES|COMMENT, body?, commit_id?, comments?:[{path*, line?, side?:LEFT|RIGHT, position?, body*}]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.event) return { err: 'Required: pr_number / event' };
    return api({
      url: r.base + '/pulls/' + a.pr_number + '/reviews', method: 'POST',
      body: { event: a.event, body: a.body, commit_id: a.commit_id, comments: a.comments },
      callId: c,
    });
  });

op('create_pull_request_review_comment', 'pulls', 'Create a single inline comment (write)',
  REPO_DOC + ', pr_number*:int, body*, commit_id*, path*, line*:int, side?:LEFT|RIGHT, start_line?:int, start_side?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.body || !a.commit_id || !a.path || !a.line) return { err: 'Required: pr_number / body / commit_id / path / line' };
    return api({
      url: r.base + '/pulls/' + a.pr_number + '/comments', method: 'POST',
      body: { body: a.body, commit_id: a.commit_id, path: a.path, line: a.line, side: a.side, start_line: a.start_line, start_side: a.start_side },
      callId: c,
    });
  });

op('reply_pull_request_review_comment', 'pulls', 'Reply to an inline comment (finds the thread root automatically)',
  REPO_DOC + ', pr_number*:int, comment_id*:int, body*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.comment_id || !a.body) return { err: 'Required: pr_number / comment_id / body' };
    var got = await api({ url: r.base + '/pulls/comments/' + a.comment_id, callId: c });
    if (got.err) return got;
    var rootId = (got.data && got.data.in_reply_to_id) || a.comment_id;
    return api({ url: r.base + '/pulls/' + a.pr_number + '/comments/' + rootId + '/replies', method: 'POST', body: { body: a.body }, callId: c });
  });

op('request_pull_request_reviewers', 'pulls', 'Request reviewers', REPO_DOC + ', pr_number*:int, reviewers?:string[], team_reviewers?:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/requested_reviewers', method: 'POST', body: { reviewers: a.reviewers, team_reviewers: a.team_reviewers }, callId: c });
  });

op('remove_pull_request_reviewers', 'pulls', 'Remove requested reviewers', REPO_DOC + ', pr_number*:int, reviewers?:string[], team_reviewers?:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/requested_reviewers', method: 'DELETE', body: { reviewers: a.reviewers, team_reviewers: a.team_reviewers }, callId: c });
  });

op('list_pull_request_requested_reviewers', 'pulls', 'List requested reviewers who have not reviewed yet', REPO_DOC + ', pr_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/requested_reviewers', callId: c });
  });

op('create_pending_pull_request_review', 'pulls', 'Start a pending review (then collect line comments with add_pending_pull_request_review_comment and submit at the end)',
  REPO_DOC + ', pr_number*:int, body?, commit_id?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/reviews', method: 'POST', body: { body: a.body, commit_id: a.commit_id }, callId: c });
  });

op('add_pending_pull_request_review_comment', 'pulls', 'Add an inline comment to a pending review (GraphQL; review_node_id is the node_id of the review, starting with PRR_)',
  REPO_DOC + ', review_node_id*:string, body*, path*, line*:int, side?:LEFT|RIGHT, start_line?, start_side?, subject_type?:LINE|FILE',
  async function (a, c) {
    if (!a.review_node_id || !a.body || !a.path) return { err: 'Required: review_node_id / body / path' };
    if (a.subject_type !== 'FILE' && !a.line) return { err: 'Required for LINE-level comments: line' };
    var input = {
      pullRequestReviewId: a.review_node_id,
      body: a.body,
      path: a.path,
    };
    if (a.subject_type) input.subjectType = a.subject_type;
    if (a.line) input.line = a.line;
    if (a.side) input.side = a.side;
    if (a.start_line) input.startLine = a.start_line;
    if (a.start_side) input.startSide = a.start_side;
    return gql(
      'mutation($input: AddPullRequestReviewThreadInput!) { addPullRequestReviewThread(input: $input) { thread { id } } }',
      { input: input }, c,
    );
  });

op('submit_pending_pull_request_review', 'pulls', 'Submit a pending review (write)',
  REPO_DOC + ', pr_number*:int, review_id*:int, event*:APPROVE|REQUEST_CHANGES|COMMENT, body?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.review_id || !a.event) return { err: 'Required: pr_number / review_id / event' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/reviews/' + a.review_id + '/events', method: 'POST', body: { event: a.event, body: a.body }, callId: c });
  });

op('delete_pending_pull_request_review', 'pulls', 'Delete a pending review', REPO_DOC + ', pr_number*:int, review_id*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.review_id) return { err: 'Required: pr_number / review_id' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/reviews/' + a.review_id, method: 'DELETE', callId: c });
  });

op('dismiss_pull_request_review', 'pulls', 'Dismiss a submitted review (write)',
  REPO_DOC + ', pr_number*:int, review_id*:int, message*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number || !a.review_id || !a.message) return { err: 'Required: pr_number / review_id / message' };
    return api({ url: r.base + '/pulls/' + a.pr_number + '/reviews/' + a.review_id + '/dismissals', method: 'PUT', body: { message: a.message }, callId: c });
  });

op('list_pull_request_review_threads', 'pulls', 'List review threads (GraphQL; with resolved/outdated, path/line, the first 50 comments of each thread, pagination cursor)',
  REPO_DOC + ', pr_number*:int, first?:int(default 50, <=100), after?:string(endCursor of the previous page)',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    var first = Math.min(100, Math.max(1, a.first || 50));
    var out = await gql(
      'query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {' +
      ' repository(owner: $owner, name: $repo) { pullRequest(number: $number) {' +
      '  reviewThreads(first: $first, after: $after) {' +
      '   pageInfo { hasNextPage endCursor }' +
      '   nodes { id isResolved isOutdated path line startLine diffSide' +
      '    comments(first: 50) { totalCount nodes { id databaseId author { login } body createdAt url } } } } } } }',
      { owner: a.owner, repo: a.repo, number: a.pr_number, first: first, after: a.after || null }, c,
    );
    if (out.err) return out;
    var repo = out.data && out.data.repository;
    var pr = repo && repo.pullRequest;
    if (!pr) return { err: 'Not found or no access (HTTP 404)' };
    return { data: pr.reviewThreads };
  });

op('resolve_review_thread', 'pulls', 'Resolve a review thread (GraphQL; thread_id is the node id starting with PRRT_)', 'thread_id*:string',
  async function (a, c) {
    if (!a.thread_id) return { err: 'Required: thread_id (see list_pull_request_review_threads)' };
    return gql('mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }', { id: a.thread_id }, c);
  });

op('unresolve_review_thread', 'pulls', 'Unresolve a review thread (GraphQL)', 'thread_id*:string',
  async function (a, c) {
    if (!a.thread_id) return { err: 'Required: thread_id' };
    return gql('mutation($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }', { id: a.thread_id }, c);
  });

op('update_pull_request_branch', 'pulls', 'Merge the latest base code into the PR head branch (202 accepted)',
  REPO_DOC + ', pr_number*:int, expected_head_sha?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    var out = await api({ url: r.base + '/pulls/' + a.pr_number + '/update-branch', method: 'PUT', body: a.expected_head_sha ? { expected_head_sha: a.expected_head_sha } : {}, callId: c });
    if (out.err) return out;
    return { data: out.data || { updated: true } };
  });

op('request_copilot_review', 'pulls', 'Add the Copilot bot as a reviewer', REPO_DOC + ', pr_number*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.pr_number) return { err: 'Required: pr_number' };
    return api({
      url: r.base + '/pulls/' + a.pr_number + '/requested_reviewers', method: 'POST',
      body: { reviewers: ['copilot-pull-request-reviewer[bot]'] }, callId: c,
    });
  });

/* ── repo(22) ──────────────────────────────────────────────────────── */

op('list_branches', 'repo', 'List branches (single page of 100)', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/branches?per_page=100', callId: c });
  });

op('list_labels', 'repo', 'List repo labels (single page of 100)', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/labels?per_page=100', callId: c });
  });

op('ensure_labels', 'repo', 'Ensure labels exist (missing ones are created with the default color, existing ones are skipped)', REPO_DOC + ', names*:string[]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!Array.isArray(a.names) || !a.names.length) return { err: 'Required: names (at least one)' };
    var cur = await api({ url: r.base + '/labels?per_page=100', callId: c });
    if (cur.err) return cur;
    var have = {};
    (cur.data || []).forEach(function (l) { have[l.name] = 1; });
    var created = [];
    for (var i = 0; i < a.names.length; i++) {
      var n = a.names[i];
      if (have[n]) continue;
      var made = await api({ url: r.base + '/labels', method: 'POST', body: { name: n, color: '428BCA' }, callId: c });
      // 422 = already created concurrently: treat as success and skip; report other errors as is.
      if (made.err && made.err.indexOf('422') < 0) return made;
      if (!made.err) created.push(n);
    }
    return { data: { ensured: a.names, created: created } };
  });

op('get_repo', 'repo', 'Repo metadata (default branch/visibility/permissions, etc.)', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base, callId: c });
  });

op('list_tags', 'repo', 'List tags', REPO_DOC + ', ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/tags' + qs(pg(a)), callId: c });
  });

op('get_readme', 'repo', 'Get the README (content is base64)', REPO_DOC + ', ref?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/readme' + qs({ ref: a.ref }), callId: c });
  });

op('list_deployments', 'repo', 'List deployments', REPO_DOC + ', sha?, ref?, task?, environment?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/deployments' + qs({ sha: a.sha, ref: a.ref, task: a.task, environment: a.environment, per_page: a.per_page, page: a.page }), callId: c });
  });

op('get_contents', 'repo', 'Get file contents (base64) or a directory listing; large files (>1MB) return only download_url metadata',
  REPO_DOC + ', path?:string(default: repo root), ref?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/contents/' + (a.path ? encPath(a.path) : '') + qs({ ref: a.ref }), callId: c });
  });

op('list_repo_topics', 'repo', 'List topics', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/topics', callId: c });
  });

op('replace_repo_topics', 'repo', 'Replace all topics (write; an empty array clears them)', REPO_DOC + ', names*:string[](may be an empty array)',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!Array.isArray(a.names)) return { err: 'Required: names (array, may be empty)' };
    return api({ url: r.base + '/topics', method: 'PUT', body: { names: a.names }, callId: c });
  });

op('list_repo_contributors', 'repo', 'List contributors', REPO_DOC + ', anon?:bool, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/contributors' + qs({ anon: a.anon, per_page: a.per_page, page: a.page }), callId: c });
  });

op('list_repo_languages', 'repo', 'Language byte counts', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/languages', callId: c });
  });

op('list_stargazers', 'repo', 'List stargazers', REPO_DOC + ', ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/stargazers' + qs(pg(a)), callId: c });
  });

op('list_forks', 'repo', 'List forks', REPO_DOC + ', sort?:newest|oldest|stargazers|watchers, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/forks' + qs({ sort: a.sort, per_page: a.per_page, page: a.page }), callId: c });
  });

op('create_fork', 'repo', 'Fork the repo (write)', REPO_DOC + ', organization?, name?, default_branch_only?:bool',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/forks', method: 'POST', body: { organization: a.organization, name: a.name, default_branch_only: a.default_branch_only }, callId: c });
  });

op('list_repo_collaborators', 'repo', 'List collaborators', REPO_DOC + ', affiliation?:outside|direct|all, permission?:pull|triage|push|maintain|admin, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/collaborators' + qs({ affiliation: a.affiliation, permission: a.permission, per_page: a.per_page, page: a.page }), callId: c });
  });

op('list_repo_hooks', 'repo', 'List webhooks (single page of 100)', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/hooks?per_page=100', callId: c });
  });

op('list_branch_protection', 'repo', 'Get branch protection settings (404 when unprotected)', REPO_DOC + ', branch*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.branch) return { err: 'Required: branch' };
    return api({ url: r.base + '/branches/' + encodeURIComponent(a.branch) + '/protection', callId: c });
  });

op('create_or_update_file_contents', 'repo', 'Create/update a single file (content must be base64; updating an existing file requires its current blob sha; write)',
  REPO_DOC + ', path*, message*, content*:base64, sha?(required when updating), branch?, committer?:{name*,email*}, author?:{name*,email*}',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.path || !a.message || !a.content) return { err: 'Required: path / message / content (base64)' };
    return api({
      url: r.base + '/contents/' + encPath(a.path), method: 'PUT',
      body: { message: a.message, content: a.content, sha: a.sha, branch: a.branch, committer: a.committer, author: a.author },
      callId: c,
    });
  });

op('delete_file', 'repo', 'Delete a single file (requires the current blob sha; write)',
  REPO_DOC + ', path*, message*, sha*, branch?, committer?, author?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.path || !a.message || !a.sha) return { err: 'Required: path / message / sha' };
    return api({
      url: r.base + '/contents/' + encPath(a.path), method: 'DELETE',
      body: { message: a.message, sha: a.sha, branch: a.branch, committer: a.committer, author: a.author },
      callId: c,
    });
  });

op('create_repository', 'repo', 'Create a repository (write; created under that org when org is given)',
  'name*, description?, private?:bool, auto_init?:bool, org?, homepage?, has_issues?, has_projects?, has_wiki?, gitignore_template?, license_template?',
  async function (a, c) {
    if (!a.name) return { err: 'Required: name' };
    var body = {
      name: a.name, description: a.description, private: a.private, auto_init: a.auto_init,
      homepage: a.homepage, has_issues: a.has_issues, has_projects: a.has_projects, has_wiki: a.has_wiki,
      gitignore_template: a.gitignore_template, license_template: a.license_template,
    };
    var url = a.org ? API + '/orgs/' + encodeURIComponent(a.org) + '/repos' : API + '/user/repos';
    return api({ url: url, method: 'POST', body: body, callId: c });
  });

op('get_tag', 'repo', 'Get the ref object of a tag', REPO_DOC + ', tag*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.tag) return { err: 'Required: tag' };
    // Use encPath like get_ref/create_branch: tag names containing / only resolve when encoded segment by segment.
    return api({ url: r.base + '/git/ref/tags/' + encPath(a.tag), callId: c });
  });

/* ── meta(2) ───────────────────────────────────────────────────────── */

op('get_current_user', 'meta', 'User behind the current token (login / id / profile page)', 'no parameters',
  async function (a, c) {
    return api({ url: API + '/user', callId: c });
  });

op('graphql', 'meta', 'Generic GraphQL escape hatch (for queries/mutations that REST does not cover)', 'query*:string, variables?:object',
  async function (a, c) {
    if (!a.query) return { err: 'Required: query' };
    return gql(a.query, a.variables, c);
  });

/* ── events(5) ─────────────────────────────────────────────────────── */

op('list_user_events', 'events', 'Events of a user (as visible to the authenticated user, including your own private events)', 'username*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.username) return { err: 'Required: username' };
    return api({ url: API + '/users/' + encodeURIComponent(a.username) + '/events' + qs(pg(a)), callId: c });
  });

op('list_user_public_events', 'events', 'Public events of a user', 'username*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.username) return { err: 'Required: username' };
    return api({ url: API + '/users/' + encodeURIComponent(a.username) + '/events/public' + qs(pg(a)), callId: c });
  });

op('list_org_events', 'events', 'Public event stream of an org', 'org*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.org) return { err: 'Required: org' };
    return api({ url: API + '/orgs/' + encodeURIComponent(a.org) + '/events' + qs(pg(a)), callId: c });
  });

op('list_authenticated_user_org_events', 'events', 'Events in an org visible to the authenticated user (including private repos)', 'org*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.org) return { err: 'Required: org' };
    var me = await api({ url: API + '/user', callId: c });
    if (me.err) return me;
    return api({
      url: API + '/users/' + encodeURIComponent(me.data.login) + '/events/orgs/' + encodeURIComponent(a.org) + qs(pg(a)),
      callId: c,
    });
  });

op('list_repo_events', 'events', 'Repo events', REPO_DOC + ', ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/events' + qs(pg(a)), callId: c });
  });

/* ── commits(4) ────────────────────────────────────────────────────── */

op('list_commits', 'commits', 'List commits (filter by author/path/time)',
  REPO_DOC + ', sha?:string(branch or starting point), path?, author?, committer?, since?:ISO, until?:ISO, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({
      url: r.base + '/commits' + qs({ sha: a.sha, path: a.path, author: a.author, committer: a.committer, since: a.since, until: a.until, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

op('get_commit', 'commits', 'Get a single commit (with stats and file diffs)', REPO_DOC + ', sha*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.sha) return { err: 'Required: sha' };
    return api({ url: r.base + '/commits/' + encodeURIComponent(a.sha), callId: c });
  });

op('compare_commits', 'commits', 'Compare two refs (base...head)', REPO_DOC + ', base*:string, head*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.base || !a.head) return { err: 'Required: base / head' };
    return api({ url: r.base + '/compare/' + encodeURIComponent(a.base) + '...' + encodeURIComponent(a.head), callId: c });
  });

op('list_check_runs_for_ref', 'commits', 'List check runs for a ref (CI status)',
  REPO_DOC + ', ref*:string, check_name?, status?:queued|in_progress|completed, filter?:latest|all, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.ref) return { err: 'Required: ref' };
    return api({
      url: r.base + '/commits/' + encodeURIComponent(a.ref) + '/check-runs' + qs({ check_name: a.check_name, status: a.status, filter: a.filter, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

/* ── search(5) ─────────────────────────────────────────────────────── */

op('search_repos', 'search', 'Search repositories (GitHub search syntax)', 'q*:string, sort?:stars|forks|help-wanted-issues|updated, order?:asc|desc, ' + PP_DOC,
  async function (a, c) {
    if (!a.q) return { err: 'Required: q' };
    return api({ url: API + '/search/repositories' + qs({ q: a.q, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page }), callId: c });
  });

op('search_issues_and_prs', 'search', 'Search issues and PRs (narrow with is:pr / is:issue / repo:owner/name in q)',
  'q*:string, sort?, order?:asc|desc, ' + PP_DOC,
  async function (a, c) {
    if (!a.q) return { err: 'Required: q' };
    return api({ url: API + '/search/issues' + qs({ q: a.q, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page }), callId: c });
  });

op('search_commits', 'search', 'Search commits', 'q*:string, sort?:author-date|committer-date, order?, ' + PP_DOC,
  async function (a, c) {
    if (!a.q) return { err: 'Required: q' };
    return api({ url: API + '/search/commits' + qs({ q: a.q, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page }), callId: c });
  });

op('search_code', 'search', 'Search code (narrow with repo: / path: / language: in q)', 'q*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.q) return { err: 'Required: q' };
    return api({ url: API + '/search/code' + qs({ q: a.q, per_page: a.per_page, page: a.page }), callId: c });
  });

op('search_users', 'search', 'Search users', 'q*:string, sort?:followers|repositories|joined, order?, ' + PP_DOC,
  async function (a, c) {
    if (!a.q) return { err: 'Required: q' };
    return api({ url: API + '/search/users' + qs({ q: a.q, sort: a.sort, order: a.order, per_page: a.per_page, page: a.page }), callId: c });
  });

/* ── users(4) ──────────────────────────────────────────────────────── */

op('get_user', 'users', 'Public user profile', 'username*:string',
  async function (a, c) {
    if (!a.username) return { err: 'Required: username' };
    return api({ url: API + '/users/' + encodeURIComponent(a.username), callId: c });
  });

op('list_user_orgs', 'users', 'Public orgs of a user (single page of 100)', 'username*:string',
  async function (a, c) {
    if (!a.username) return { err: 'Required: username' };
    return api({ url: API + '/users/' + encodeURIComponent(a.username) + '/orgs?per_page=100', callId: c });
  });

op('list_authenticated_user_repos', 'users', 'Repos the authenticated user can access',
  'visibility?:all|public|private, type?:all|owner|public|private|member, sort?:created|updated|pushed|full_name, direction?, ' + PP_DOC,
  async function (a, c) {
    return api({
      url: API + '/user/repos' + qs({ visibility: a.visibility, type: a.type, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

op('list_org_repos', 'users', 'Repos of an org', 'org*:string, type?:all|public|private|forks|sources|member, sort?, direction?, ' + PP_DOC,
  async function (a, c) {
    if (!a.org) return { err: 'Required: org' };
    return api({
      url: API + '/orgs/' + encodeURIComponent(a.org) + '/repos' + qs({ type: a.type, sort: a.sort, direction: a.direction, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

/* ── actions(10) ───────────────────────────────────────────────────── */

op('list_workflow_runs', 'actions', 'List workflow runs',
  REPO_DOC + ', branch?, event?, status?:completed|success|failure|in_progress|queued|..., actor?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({
      url: r.base + '/actions/runs' + qs({ branch: a.branch, event: a.event, status: a.status, actor: a.actor, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

op('get_workflow_run', 'actions', 'Get a single run', REPO_DOC + ', run_id*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    return api({ url: r.base + '/actions/runs/' + a.run_id, callId: c });
  });

op('list_workflow_run_jobs', 'actions', 'List jobs in a run (with step status)', REPO_DOC + ', run_id*:int, filter?:latest|all, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    return api({ url: r.base + '/actions/runs/' + a.run_id + '/jobs' + qs({ filter: a.filter, per_page: a.per_page, page: a.page }), callId: c });
  });

op('list_workflows', 'actions', 'List workflow definitions', REPO_DOC + ', ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/actions/workflows' + qs(pg(a)), callId: c });
  });

op('dispatch_workflow', 'actions', 'Trigger workflow_dispatch (write; workflow can be a file name or a numeric id)',
  REPO_DOC + ', workflow*:string|int, ref*:string, inputs?:object(values must be strings)',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.workflow || !a.ref) return { err: 'Required: workflow / ref' };
    var out = await api({
      url: r.base + '/actions/workflows/' + encodeURIComponent(String(a.workflow)) + '/dispatches',
      method: 'POST', body: { ref: a.ref, inputs: a.inputs }, callId: c,
    });
    if (out.err) return out;
    return { data: { dispatched: true } };
  });

op('rerun_workflow_run', 'actions', 'Re-run a run (write)', REPO_DOC + ', run_id*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    var out = await api({ url: r.base + '/actions/runs/' + a.run_id + '/rerun', method: 'POST', callId: c });
    if (out.err) return out;
    return { data: { rerun: true } };
  });

op('cancel_workflow_run', 'actions', 'Cancel a run (write)', REPO_DOC + ', run_id*:int',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    var out = await api({ url: r.base + '/actions/runs/' + a.run_id + '/cancel', method: 'POST', callId: c });
    if (out.err) return out;
    return { data: { cancelled: true } };
  });

op('list_workflow_run_artifacts', 'actions', 'List artifacts of a run', REPO_DOC + ', run_id*:int, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    return api({ url: r.base + '/actions/runs/' + a.run_id + '/artifacts' + qs(pg(a)), callId: c });
  });

op('download_artifact', 'actions', 'Download an artifact zip to a local user directory (the main agent must pass the absolute path of the target directory in the top-level save_dir parameter of ghost_call)',
  REPO_DOC + ', artifact_id*:int, filename?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.artifact_id) return { err: 'Required: artifact_id' };
    var done = await downloadZip(r.base + '/actions/artifacts/' + a.artifact_id + '/zip', a, c, 'artifact-' + a.artifact_id + '.zip');
    if (done.err) return done;
    return { result: done.result };
  });

op('download_run_logs', 'actions', 'Download the full log zip of a run to a local user directory (requires the top-level save_dir parameter of ghost_call)',
  REPO_DOC + ', run_id*:int, filename?:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.run_id) return { err: 'Required: run_id' };
    var done = await downloadZip(r.base + '/actions/runs/' + a.run_id + '/logs', a, c, 'run-' + a.run_id + '-logs.zip');
    if (done.err) return done;
    return { result: done.result };
  });

/* ── releases(5) ───────────────────────────────────────────────────── */

op('list_releases', 'releases', 'List releases', REPO_DOC + ', ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/releases' + qs(pg(a)), callId: c });
  });

op('get_release_by_tag', 'releases', 'Get a release by tag', REPO_DOC + ', tag*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.tag) return { err: 'Required: tag' };
    return api({ url: r.base + '/releases/tags/' + encodeURIComponent(a.tag), callId: c });
  });

op('create_release', 'releases', 'Create a release (write)',
  REPO_DOC + ', tag_name*, target_commitish?, name?, body?, draft?:bool, prerelease?:bool, generate_release_notes?:bool',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.tag_name) return { err: 'Required: tag_name' };
    return api({
      url: r.base + '/releases', method: 'POST',
      body: { tag_name: a.tag_name, target_commitish: a.target_commitish, name: a.name, body: a.body, draft: a.draft, prerelease: a.prerelease, generate_release_notes: a.generate_release_notes },
      callId: c,
    });
  });

op('get_latest_release', 'releases', 'Latest published release', REPO_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    return api({ url: r.base + '/releases/latest', callId: c });
  });

op('list_release_assets', 'releases', 'List release assets', REPO_DOC + ', release_id*:int, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.release_id) return { err: 'Required: release_id' };
    return api({ url: r.base + '/releases/' + a.release_id + '/assets' + qs(pg(a)), callId: c });
  });

/* ── notifications(2) ──────────────────────────────────────────────── */

op('list_notifications', 'notifications', 'List notifications', 'all?:bool, participating?:bool, since?:ISO, before?:ISO, ' + PP_DOC,
  async function (a, c) {
    return api({
      url: API + '/notifications' + qs({ all: a.all, participating: a.participating, since: a.since, before: a.before, per_page: a.per_page, page: a.page }),
      callId: c,
    });
  });

op('mark_notification_read', 'notifications', 'Mark a notification thread as read', 'thread_id*:string',
  async function (a, c) {
    if (!a.thread_id) return { err: 'Required: thread_id' };
    var out = await api({ url: API + '/notifications/threads/' + encodeURIComponent(a.thread_id), method: 'PATCH', callId: c });
    if (out.err) return out;
    return { data: { marked_read: true } };
  });

/* ── orgs(4) ───────────────────────────────────────────────────────── */

op('list_org_members', 'orgs', 'Org members', 'org*:string, filter?:2fa_disabled|all, role?:all|admin|member, ' + PP_DOC,
  async function (a, c) {
    if (!a.org) return { err: 'Required: org' };
    return api({ url: API + '/orgs/' + encodeURIComponent(a.org) + '/members' + qs({ filter: a.filter, role: a.role, per_page: a.per_page, page: a.page }), callId: c });
  });

op('list_org_teams', 'orgs', 'Org teams', 'org*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.org) return { err: 'Required: org' };
    return api({ url: API + '/orgs/' + encodeURIComponent(a.org) + '/teams' + qs(pg(a)), callId: c });
  });

op('list_team_members', 'orgs', 'Team members', 'org*:string, team_slug*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.org || !a.team_slug) return { err: 'Required: org / team_slug' };
    return api({ url: API + '/orgs/' + encodeURIComponent(a.org) + '/teams/' + encodeURIComponent(a.team_slug) + '/members' + qs(pg(a)), callId: c });
  });

op('list_team_repos', 'orgs', 'Repos a team can access', 'org*:string, team_slug*:string, ' + PP_DOC,
  async function (a, c) {
    if (!a.org || !a.team_slug) return { err: 'Required: org / team_slug' };
    return api({ url: API + '/orgs/' + encodeURIComponent(a.org) + '/teams/' + encodeURIComponent(a.team_slug) + '/repos' + qs(pg(a)), callId: c });
  });

/* ── gists(2) ──────────────────────────────────────────────────────── */

op('list_gists', 'gists', 'List gists of the authenticated user', 'since?:ISO, ' + PP_DOC,
  async function (a, c) {
    return api({ url: API + '/gists' + qs({ since: a.since, per_page: a.per_page, page: a.page }), callId: c });
  });

op('get_gist', 'gists', 'Get a single gist (with file contents)', 'id*:string',
  async function (a, c) {
    if (!a.id) return { err: 'Required: id' };
    return api({ url: API + '/gists/' + encodeURIComponent(a.id), callId: c });
  });

/* ── git_data(7) ───────────────────────────────────────────────────── */

op('get_ref', 'git_data', 'Get a single ref (e.g. heads/main, tags/v1.0.0)', REPO_DOC + ', ref*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.ref) return { err: 'Required: ref (e.g. heads/main)' };
    return api({ url: r.base + '/git/ref/' + encPath(a.ref), callId: c });
  });

op('create_branch', 'git_data', 'Create a branch (from_sha or from_ref, pick one; when both are omitted, branch from the repo default branch)',
  REPO_DOC + ', branch*:string, from_sha?:string, from_ref?:string(default: the repo default_branch)',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.branch) return { err: 'Required: branch' };
    var sha = a.from_sha;
    if (!sha) {
      var fromRef = a.from_ref;
      if (!fromRef) {
        var repo = await api({ url: r.base, callId: c });
        if (repo.err) return repo;
        fromRef = repo.data && repo.data.default_branch;
        if (!fromRef) return { err: 'Could not get the repo default branch' };
      }
      var got = await api({ url: r.base + '/git/ref/heads/' + encPath(fromRef), callId: c });
      if (got.err) return got;
      sha = got.data && got.data.object && got.data.object.sha;
      if (!sha) return { err: 'Could not get the sha of the starting branch' };
    }
    return api({ url: r.base + '/git/refs', method: 'POST', body: { ref: 'refs/heads/' + a.branch, sha: sha }, callId: c });
  });

op('create_ref', 'git_data', 'Create a raw ref (refs/heads/... or refs/tags/...)', REPO_DOC + ', ref*:string, sha*:string',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.ref || !a.sha) return { err: 'Required: ref / sha' };
    return api({ url: r.base + '/git/refs', method: 'POST', body: { ref: a.ref, sha: a.sha }, callId: c });
  });

op('get_tree', 'git_data', 'Get a git tree (recursive=true fetches the whole tree; watch the truncated flag)', REPO_DOC + ', tree_sha*:string, recursive?:bool',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.tree_sha) return { err: 'Required: tree_sha' };
    return api({ url: r.base + '/git/trees/' + encodeURIComponent(a.tree_sha) + qs({ recursive: a.recursive ? 1 : undefined }), callId: c });
  });

op('create_tree', 'git_data', 'Create a git tree', REPO_DOC + ', base_tree?, tree*:[{path*, mode*:100644|100755|040000|160000|120000, type*:blob|tree|commit, sha?, content?}]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!Array.isArray(a.tree) || !a.tree.length) return { err: 'Required: tree (array of entries)' };
    return api({ url: r.base + '/git/trees', method: 'POST', body: { base_tree: a.base_tree, tree: a.tree }, callId: c });
  });

op('create_commit', 'git_data', 'Create a commit object (does not move any ref; to update a branch use create_ref / push_files)',
  REPO_DOC + ', message*, tree*:string, parents*:string[], author?:{name*,email*,date?}, committer?',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.message || !a.tree || !Array.isArray(a.parents)) return { err: 'Required: message / tree / parents' };
    return api({
      url: r.base + '/git/commits', method: 'POST',
      body: { message: a.message, tree: a.tree, parents: a.parents, author: a.author, committer: a.committer },
      callId: c,
    });
  });

op('push_files', 'git_data', 'Push several files atomically as one commit to a branch (read head -> create blob/tree/commit -> fast-forward ref; write)',
  REPO_DOC + ', branch*, message*, files*:[{path*, content*, encoding?:utf-8|base64}]',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.branch || !a.message || !Array.isArray(a.files) || !a.files.length) return { err: 'Required: branch / message / files' };
    var head = await api({ url: r.base + '/git/ref/heads/' + encPath(a.branch), callId: c });
    if (head.err) return head;
    var headSha = head.data && head.data.object && head.data.object.sha;
    if (!headSha) return { err: 'Could not get the branch head sha' };
    var headCommit = await api({ url: r.base + '/git/commits/' + headSha, callId: c });
    if (headCommit.err) return headCommit;
    var baseTree = headCommit.data && headCommit.data.tree && headCommit.data.tree.sha;
    // Cannot continue without base_tree: GitHub would build an orphan tree with only these files,
    // which effectively deletes every other file on the branch.
    if (!baseTree) return { err: 'Could not get the base tree of the head commit; refusing to continue (to avoid an orphan tree that drops every other file)' };
    var entries = [];
    for (var i = 0; i < a.files.length; i++) {
      var f = a.files[i];
      if (!f || !f.path || typeof f.content !== 'string') return { err: 'Each files entry requires path / content' };
      // A misspelled encoding (e.g. 'Base64') committed as utf-8 would silently corrupt the file, so only the enum is accepted.
      if (f.encoding !== undefined && f.encoding !== 'utf-8' && f.encoding !== 'base64') {
        return { err: 'files[].encoding accepts only utf-8 / base64, got: ' + f.encoding };
      }
      if (f.encoding === 'base64') {
        var blob = await api({ url: r.base + '/git/blobs', method: 'POST', body: { content: f.content, encoding: 'base64' }, callId: c });
        if (blob.err) return blob;
        entries.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.data.sha });
      } else {
        entries.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
      }
    }
    var tree = await api({ url: r.base + '/git/trees', method: 'POST', body: { base_tree: baseTree, tree: entries }, callId: c });
    if (tree.err) return tree;
    var commit = await api({
      url: r.base + '/git/commits', method: 'POST',
      body: { message: a.message, tree: tree.data.sha, parents: [headSha] }, callId: c,
    });
    if (commit.err) return commit;
    var moved = await api({
      url: r.base + '/git/refs/heads/' + encPath(a.branch), method: 'PATCH',
      body: { sha: commit.data.sha, force: false }, callId: c,
    });
    if (moved.err) return moved;
    return { data: { pushed: true, commit_sha: commit.data.sha, files: a.files.length } };
  });

/* ── reactions(6) ──────────────────────────────────────────────────── */

var REACTION_DOC = 'content enum: +1|-1|laugh|confused|heart|hooray|rocket|eyes';

op('list_issue_reactions', 'reactions', 'List reactions on an issue (' + REACTION_DOC + ')', REPO_DOC + ', issue_number*:int, content?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number) return { err: 'Required: issue_number' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/reactions' + qs({ content: a.content, per_page: a.per_page, page: a.page }), callId: c });
  });

op('add_issue_reaction', 'reactions', 'Add a reaction to an issue', REPO_DOC + ', issue_number*:int, content*(' + REACTION_DOC + ')',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.issue_number || !a.content) return { err: 'Required: issue_number / content' };
    return api({ url: r.base + '/issues/' + a.issue_number + '/reactions', method: 'POST', body: { content: a.content }, callId: c });
  });

op('list_issue_comment_reactions', 'reactions', 'List reactions on an issue comment', REPO_DOC + ', comment_id*:int, content?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.comment_id) return { err: 'Required: comment_id' };
    return api({ url: r.base + '/issues/comments/' + a.comment_id + '/reactions' + qs({ content: a.content, per_page: a.per_page, page: a.page }), callId: c });
  });

op('add_issue_comment_reaction', 'reactions', 'Add a reaction to an issue comment', REPO_DOC + ', comment_id*:int, content*',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.comment_id || !a.content) return { err: 'Required: comment_id / content' };
    return api({ url: r.base + '/issues/comments/' + a.comment_id + '/reactions', method: 'POST', body: { content: a.content }, callId: c });
  });

op('list_pull_request_review_comment_reactions', 'reactions', 'List reactions on a PR review comment', REPO_DOC + ', comment_id*:int, content?, ' + PP_DOC,
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.comment_id) return { err: 'Required: comment_id' };
    return api({ url: r.base + '/pulls/comments/' + a.comment_id + '/reactions' + qs({ content: a.content, per_page: a.per_page, page: a.page }), callId: c });
  });

op('add_pull_request_review_comment_reaction', 'reactions', 'Add a reaction to a PR review comment', REPO_DOC + ', comment_id*:int, content*',
  async function (a, c) {
    var r = repoBase(a); if (r.err) return r;
    if (!a.comment_id || !a.content) return { err: 'Required: comment_id / content' };
    return api({ url: r.base + '/pulls/comments/' + a.comment_id + '/reactions', method: 'POST', body: { content: a.content }, callId: c });
  });

/* ── list_tools / call_tool meta tools ─────────────────────────────────── */

function listTools(args) {
  var category = args && args.category ? String(args.category) : '';
  if (!category) {
    var overview = {};
    for (var cat in CATEGORIES) {
      if (!Object.prototype.hasOwnProperty.call(CATEGORIES, cat)) continue;
      overview[cat] = { count: 0, description: CATEGORIES[cat] };
    }
    for (var name in OPS) {
      if (!Object.prototype.hasOwnProperty.call(OPS, name)) continue;
      overview[OPS[name].cat].count++;
    }
    return {
      ok: true,
      result: {
        categories: overview,
        hint: 'Pass category to see the operations in it; run one with call_tool({name, args}). Repo-level operations require explicit owner/repo.',
      },
    };
  }
  if (!CATEGORIES[category]) {
    return { ok: false, message: 'Unknown category: ' + category + ' (available: ' + Object.keys(CATEGORIES).join(' / ') + ')' };
  }
  var tools = [];
  for (var n in OPS) {
    if (!Object.prototype.hasOwnProperty.call(OPS, n)) continue;
    if (OPS[n].cat !== category) continue;
    tools.push({ name: n, description: OPS[n].desc, params: OPS[n].params });
  }
  return {
    ok: true,
    result: { category: category, tools: tools, hint: 'Run with call_tool({name, args}); parameter notation: * = required, pp = per_page/page.' },
  };
}

async function callTool(args, callId) {
  var name = args && args.name ? String(args.name) : '';
  if (!name) return fail('Required: name (see list_tools)');
  var entry = OPS[name];
  if (!entry) {
    return fail('Unknown operation: ' + name + '. Use list_tools to browse the catalog (categories: ' + Object.keys(CATEGORIES).join(' / ') + ')');
  }
  var inner = args.args && typeof args.args === 'object' ? args.args : {};
  // save_dir / dir tickets are injected by the host at the call_tool level; pass them down to the operation.
  if (args.save_deposit) inner.save_deposit = args.save_deposit;
  if (args.dir_deposit) inner.dir_deposit = args.dir_deposit;
  var out = await entry.run(inner, callId);
  if (out.err) {
    // On failure, include the parameter notes so the AI can self-correct and retry (two-step convention).
    return fail(out.err + '\nParameters for this operation: ' + entry.params);
  }
  if (out.result) return { ok: true, result: out.result };
  var outFile = typeof args.out_file === 'string' && args.out_file ? args.out_file : null;
  return deliver(out.data, Boolean(args.raw), outFile, callId);
}

/* ── Settings page connection test (BroadcastChannel; settings.js calls /wake, then broadcasts) ── */

var bc = new BroadcastChannel('ruivalim-github');
var seenTestReqs = {};

bc.onmessage = function (ev) {
  var m = ev && ev.data;
  if (!m || m.type !== 'test-connection' || !m.reqId) return;
  if (seenTestReqs[m.reqId]) return;
  // The dedup table only absorbs the settings page resend storm; past the limit it is reset (no leak while resident).
  if (Object.keys(seenTestReqs).length > 200) seenTestReqs = {};
  seenTestReqs[m.reqId] = 1;
  void (async function () {
    var r = await api({ url: API + '/user' });
    if (r.err) {
      bc.postMessage({ type: 'test-connection-result', reqId: m.reqId, ok: false, message: r.err });
      // The result also goes out as a system notification (notify slot; the host draws the frame with
      // the plugin identity): failures too, told apart by tone. Repeat clicks within the 5-second rate
      // limit are refused by the host (ok:false); the in-page status is still there, so no retry.
      void cindy.send({ type: 'notify', text: 'GitHub connection test failed: ' + String(r.err).slice(0, 150), tone: 'error' });
      return;
    }
    // Note: scope info is in the X-OAuth-Scopes response header, but the host response header
    // allowlist does not pass custom headers through, so the sandbox cannot see it. Report only
    // the username, no scopes.
    var login = (r.data && r.data.login) || '';
    bc.postMessage({
      type: 'test-connection-result', reqId: m.reqId, ok: true,
      login: login, name: (r.data && r.data.name) || '',
    });
    void cindy.send({ type: 'notify', text: 'Connected: @' + login, tone: 'success' });
  })();
};

/* ── Dispatch ──────────────────────────────────────────────────────────── */

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  try {
    var r;
    if (msg.tool === 'list_tools') {
      r = listTools(msg.args || {});
    } else if (msg.tool === 'call_tool') {
      r = await callTool(msg.args || {}, msg.callId);
    } else {
      r = fail('Unknown tool: ' + msg.tool);
    }
    if (r.ok) {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: r.result });
    } else {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: r.message });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: 'GitHub tool failed: ' + (err && err.message ? err.message : String(err)),
    });
  }
});
