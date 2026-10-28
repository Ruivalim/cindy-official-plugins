/**
 * Gitea plugin logic page (browser sandbox, not Node).
 *
 * - Instances come from network.connections (key gitea_conn). The user adds an
 *   instance host and access token in settings.html; the host encrypts the
 *   token and injects `Authorization: token <value>` only into requests to that
 *   connection's host. This file never sees, stores or returns the token.
 * - Tool surface is a two-stage catalog: list_tools describes operations,
 *   call_tool runs one. Operations live in the OPS table below.
 * - Writes are confirmed through cindy.confirm before the single request is
 *   sent and are never retried. A failure after the request may have reached
 *   the server is reported as an unknown outcome.
 * - Every path segment taken from arguments is validated and percent-encoded
 *   so values cannot change which API endpoint is called.
 */

/* global cindy */

var CONNECTION_KEY = 'gitea_conn';
var CHANNEL_NAME = 'gitea';
var API_PREFIX = '/api/v1';
var REQUEST_TIMEOUT_MS = 30000;
var RESULT_MAX_CHARS = 50000;
var DEFAULT_LIMIT = 20;
var MAX_LIMIT = 50;
var MAX_PAGE = 100000;
var TEXT_DEFAULT_CHARS = 20000;
var TEXT_MAX_CHARS = 40000;
var FILE_MAX_BYTES = 1024 * 1024;
var DIR_MAX_ENTRIES = 300;
var CONFIRM_BODY_MAX = 300;
var MESSAGE_SNIPPET_MAX = 300;
var LIST_BODY_MAX = 300;
var ITEM_BODY_MAX = 20000;
var COMMENT_BODY_MAX = 4000;
var WRITE_TEXT_MAX = 60000;
var MERGE_STYLES = ['merge', 'rebase', 'rebase-merge', 'squash', 'fast-forward-only'];
var NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
var HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/* ── errors ─────────────────────────────────────────────────────────── */

function opError(code, message) {
  var e = new Error(message);
  e.code = code;
  e.safe = true;
  return e;
}

/**
 * Remove anything that looks like a credential from text that came from the
 * server or the host before it is shown to the agent. Gitea tokens are 40 hex
 * characters, the same shape as a SHA-1, so hex runs of that length are
 * redacted in error text (never in successful data).
 */
function redact(text) {
  return String(text)
    .replace(/(authorization\s*[:=]\s*)\S+(\s+\S+)?/gi, '$1[redacted]')
    .replace(/\b(token|bearer)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 [redacted]')
    .replace(/\b[0-9a-f]{40}\b/gi, '[redacted]');
}

function cleanText(text, max) {
  var s = String(text === undefined || text === null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim();
  if (s.length > max) s = s.slice(0, max) + '...';
  return s;
}

function clip(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? text.slice(0, max) + '...[truncated]' : text;
}

/* ── argument validation ────────────────────────────────────────────── */

function invalid(message) {
  return opError('INVALID_ARGS', message);
}

function reqString(a, key, max) {
  var v = a[key];
  if (typeof v !== 'string' || !v.trim()) throw invalid(key + ' is required and must be a non-empty string.');
  if (max && v.length > max) throw invalid(key + ' is too long (max ' + max + ' characters).');
  return v;
}

function optString(a, key, max) {
  var v = a[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw invalid(key + ' must be a string.');
  if (max && v.length > max) throw invalid(key + ' is too long (max ' + max + ' characters).');
  return v;
}

function optBool(a, key) {
  var v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw invalid(key + ' must be true or false.');
  return v;
}

function toPositiveInt(v) {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v)) {
    var n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

function reqInt(a, key) {
  var n = toPositiveInt(a[key]);
  if (n === null) throw invalid(key + ' is required and must be a positive integer.');
  return n;
}

function optInt(a, key) {
  if (a[key] === undefined || a[key] === null || a[key] === '') return undefined;
  var n = toPositiveInt(a[key]);
  if (n === null) throw invalid(key + ' must be a positive integer.');
  return n;
}

function optEnum(a, key, values) {
  var v = a[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (values.indexOf(v) < 0) throw invalid(key + ' must be one of: ' + values.join(', ') + '.');
  return v;
}

function intList(a, key, max) {
  var v = a[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw invalid(key + ' must be an array of positive integers.');
  if (v.length > max) throw invalid(key + ' accepts at most ' + max + ' items.');
  return v.map(function (x) {
    var n = toPositiveInt(x);
    if (n === null) throw invalid(key + ' must contain only positive integers.');
    return n;
  });
}

function stringList(a, key, max) {
  var v = a[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) throw invalid(key + ' must be an array of strings.');
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') throw invalid(key + ' must contain only strings.');
    var s = v[i].trim();
    if (s) out.push(s);
  }
  if (out.length > max) throw invalid(key + ' accepts at most ' + max + ' items.');
  return out;
}

function checkName(value, key) {
  if (typeof value !== 'string' || !NAME_RE.test(value) || value === '.' || value === '..') {
    throw invalid(key + ' must be a Gitea owner or repository name (letters, digits, "-", "_" and "."; not "." or "..").');
  }
  return value;
}

/** '/repos/{owner}/{repo}' with both names validated and encoded. */
function repoPath(a) {
  var owner = a.owner;
  var repo = a.repo;
  if ((owner === undefined || owner === null || owner === '') && typeof repo === 'string' && repo.split('/').length === 2) {
    var parts = repo.split('/');
    owner = parts[0];
    repo = parts[1];
  }
  if (owner === undefined || owner === null || owner === '') throw invalid('owner is required (or pass repo as "owner/name").');
  if (repo === undefined || repo === null || repo === '') throw invalid('repo is required.');
  checkName(owner, 'owner');
  checkName(repo, 'repo');
  return { path: '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo), full: owner + '/' + repo };
}

/**
 * Repository file path to an encoded multi-segment path. "." and ".." are
 * rejected outright: URL parsers collapse them (even percent-encoded), which
 * would let a value walk out of the contents endpoint.
 */
function filePath(value, key) {
  if (typeof value !== 'string') throw invalid(key + ' must be a string.');
  var trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) throw invalid(key + ' contains control characters or backslashes.');
  var segments = trimmed.split('/');
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (!seg) throw invalid(key + ' must not contain empty segments ("//").');
    if (seg === '.' || seg === '..' || /^(%2e|\.){1,2}$/i.test(seg)) throw invalid(key + ' must not contain "." or ".." segments.');
  }
  return segments.map(encodeURIComponent).join('/');
}

function readPaging(a) {
  var page = 1;
  if (a.page !== undefined && a.page !== null && a.page !== '') {
    page = toPositiveInt(a.page);
    if (page === null || page > MAX_PAGE) throw invalid('page must be an integer from 1 to ' + MAX_PAGE + '.');
  }
  var limit = DEFAULT_LIMIT;
  var capped = false;
  if (a.limit !== undefined && a.limit !== null && a.limit !== '') {
    limit = toPositiveInt(a.limit);
    if (limit === null) throw invalid('limit must be a positive integer.');
    if (limit > MAX_LIMIT) {
      limit = MAX_LIMIT;
      capped = true;
    }
  }
  return { page: page, limit: limit, capped: capped };
}

function textWindow(a) {
  var max = TEXT_DEFAULT_CHARS;
  if (a.max_chars !== undefined && a.max_chars !== null && a.max_chars !== '') {
    max = toPositiveInt(a.max_chars);
    if (max === null) throw invalid('max_chars must be a positive integer.');
    if (max > TEXT_MAX_CHARS) max = TEXT_MAX_CHARS;
  }
  // null = not given (logs then read from the end); 0 is an explicit start.
  var offset = null;
  if (a.offset === 0 || a.offset === '0') {
    offset = 0;
  } else if (a.offset !== undefined && a.offset !== null && a.offset !== '') {
    offset = toPositiveInt(a.offset);
    if (offset === null) throw invalid('offset must be a non-negative integer.');
  }
  return { max: max, offset: offset };
}

/* ── instances ──────────────────────────────────────────────────────── */

/**
 * Normalize a user-supplied instance (host, or https URL without a path) to a
 * bare lowercase host. The host network channel only reaches https on 443.
 */
function parseInstanceHost(raw) {
  var s = String(raw).trim();
  var scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    if (scheme[1].toLowerCase() !== 'https') {
      throw opError('INVALID_INSTANCE_URL', 'Only https Gitea instances are supported; "' + cleanText(raw, 100) + '" uses ' + scheme[1].toLowerCase() + '://.');
    }
    s = s.slice(scheme[0].length);
  }
  s = s.replace(/\/+$/, '');
  if (/[\/?#@\s]/.test(s)) {
    throw opError('INVALID_INSTANCE_URL', 'Instance must be a bare host such as git.example.com. Gitea served under a sub-path is not supported.');
  }
  var port = /:([^:]*)$/.exec(s);
  if (port) {
    if (port[1] !== '443') {
      throw opError('INVALID_INSTANCE_URL', 'Only the default https port 443 is supported; "' + cleanText(raw, 100) + '" uses port ' + cleanText(port[1], 10) + '.');
    }
    s = s.slice(0, s.length - port[0].length);
  }
  s = s.toLowerCase();
  if (!HOST_RE.test(s)) throw opError('INVALID_INSTANCE_URL', 'Instance "' + cleanText(raw, 100) + '" is not a valid host name.');
  return s;
}

async function listConnections() {
  var list;
  try {
    list = await (await fetch('/connections')).json();
  } catch (e) {
    throw opError('CONNECTIONS_UNAVAILABLE', 'Could not read the configured Gitea instances from Cindy. Reopen the plugin and try again.');
  }
  if (!Array.isArray(list)) return [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].key === CONNECTION_KEY) {
      return Array.isArray(list[i].connections) ? list[i].connections.filter(function (c) { return c && typeof c.host === 'string'; }) : [];
    }
  }
  return [];
}

/**
 * Pick the connection for this call. Precedence: args.instance (id or host),
 * the only configured connection, then the default connection for reads.
 * Writes with several instances must name one explicitly.
 */
async function resolveInstance(a, isWrite) {
  var conns = await listConnections();
  if (!conns.length) {
    throw opError('NO_INSTANCE', 'No Gitea instance is configured. Ask the user to open the Gitea plugin settings in Cindy and add the instance URL and an access token.');
  }
  var hosts = conns.map(function (c) { return c.host; }).join(', ');
  var chosen = null;
  if (a.instance !== undefined && a.instance !== null && a.instance !== '') {
    if (typeof a.instance !== 'string') throw invalid('instance must be a connection id or host string.');
    for (var i = 0; i < conns.length; i++) {
      if (conns[i].id === a.instance) chosen = conns[i];
    }
    if (!chosen) {
      var want = parseInstanceHost(a.instance);
      for (var j = 0; j < conns.length; j++) {
        if (String(conns[j].host).toLowerCase() === want) chosen = conns[j];
      }
    }
    if (!chosen) throw opError('UNKNOWN_INSTANCE', 'No configured Gitea instance matches "' + cleanText(a.instance, 100) + '". Configured: ' + hosts + '.');
  } else if (conns.length === 1) {
    chosen = conns[0];
  } else if (isWrite) {
    throw opError('AMBIGUOUS_INSTANCE', 'Several Gitea instances are configured (' + hosts + '). Writes require args.instance (connection id or host) and never fall back to the default.');
  } else {
    for (var d = 0; d < conns.length; d++) {
      if (conns[d].isDefault) chosen = conns[d];
    }
    if (!chosen) throw opError('AMBIGUOUS_INSTANCE', 'Several Gitea instances are configured (' + hosts + ') and none is the default. Pass args.instance (connection id or host).');
  }
  return { id: chosen.id, host: parseInstanceHost(chosen.host) };
}

/* ── HTTP ───────────────────────────────────────────────────────────── */

function buildQuery(params) {
  var parts = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null || v === '') continue;
    var values = Array.isArray(v) ? v : [v];
    for (var i = 0; i < values.length; i++) {
      if (values[i] === undefined || values[i] === null || values[i] === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(values[i])));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function header(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  var lower = name.toLowerCase();
  for (var k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

function giteaMessage(body) {
  if (typeof body !== 'string' || !body) return '';
  var msg = '';
  try {
    var data = JSON.parse(body);
    if (data && typeof data === 'object') {
      if (typeof data.message === 'string') msg = data.message;
      if (Array.isArray(data.errors) && data.errors.length) {
        msg += (msg ? ' ' : '') + data.errors.map(function (e) { return typeof e === 'string' ? e : JSON.stringify(e); }).join('; ');
      }
    }
  } catch (e) {
    msg = body;
  }
  return cleanText(redact(msg), MESSAGE_SNIPPET_MAX);
}

/**
 * Map a non-2xx response to an error. For writes, 4xx means Gitea rejected the
 * request (nothing changed) while 5xx may hide a partially applied change.
 */
function statusError(status, r, ctx) {
  var msg = giteaMessage(r.body);
  var said = msg ? ' Gitea said: ' + msg : '';
  var notRun = ctx.write ? 'Not executed: ' : '';
  if (status === 401) {
    return opError('AUTH_FAILED', notRun + 'Gitea at ' + ctx.host + ' rejected the access token (HTTP 401). The token is missing, expired or revoked; ask the user to replace it in the Gitea plugin settings.');
  }
  if (status === 403) {
    return opError('FORBIDDEN', notRun + 'Gitea at ' + ctx.host + ' denied the request (HTTP 403). This operation needs a token with the "' + ctx.scope + '" scope, and the account must have permission on the target.' + said);
  }
  if (status === 404) {
    return opError('NOT_FOUND', notRun + 'Not found on ' + ctx.host + ' (HTTP 404): the owner, repository, number, branch or path does not exist, or this account cannot see it.' + said);
  }
  if (status === 429) {
    var retry = header(r.headers, 'retry-after');
    return opError('RATE_LIMITED', notRun + 'Gitea at ' + ctx.host + ' is rate limiting requests (HTTP 429). Wait' + (retry ? ' ' + cleanText(retry, 20) + ' seconds' : '') + ' before retrying.');
  }
  if (status >= 500) {
    if (ctx.write) {
      return opError('OUTCOME_UNKNOWN', 'Gitea at ' + ctx.host + ' returned HTTP ' + status + ' after receiving the write. It may or may not have been applied. Check the current state before retrying; the plugin did not retry.' + said);
    }
    return opError('SERVER_ERROR', 'Gitea at ' + ctx.host + ' returned a server error (HTTP ' + status + '). Try again later.' + said);
  }
  var codes = { 400: 'BAD_REQUEST', 405: 'NOT_ALLOWED', 409: 'CONFLICT', 412: 'PRECONDITION_FAILED', 422: 'VALIDATION_FAILED', 423: 'LOCKED' };
  return opError(codes[status] || 'HTTP_ERROR', notRun + 'Gitea at ' + ctx.host + ' refused the request (HTTP ' + status + ').' + (said || ' No details were returned.'));
}

/**
 * One request, never retried. ctx = { host, callId, write, scope }.
 * Returns { data, text, status, headers }.
 */
async function request(ctx, spec) {
  var req = {
    url: 'https://' + ctx.host + API_PREFIX + spec.path + buildQuery(spec.query || {}),
    method: spec.method || 'GET',
    headers: { Accept: spec.accept || 'application/json' },
    as: 'text',
    timeoutMs: REQUEST_TIMEOUT_MS,
    callId: ctx.callId,
  };
  if (spec.body !== undefined) {
    req.headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(spec.body);
  }
  var r;
  try {
    r = await cindy.fetch(req);
  } catch (e) {
    r = { ok: false, message: e && e.message ? e.message : String(e) };
  }
  if (!r || r.ok !== true) {
    var why = cleanText(redact((r && r.message) || 'no response'), 200);
    if (ctx.write) {
      throw opError('OUTCOME_UNKNOWN', 'The write to ' + ctx.host + ' did not complete (' + why + '). It may or may not have reached Gitea. Check the current state before retrying; the plugin did not retry.');
    }
    throw opError('NETWORK_ERROR', 'Could not get a response from ' + ctx.host + ' (' + why + '). Check that the instance is reachable, then retry.');
  }
  var status = r.status;
  if (typeof status !== 'number' || status < 200 || status >= 300) throw statusError(status, r, ctx);
  var body = typeof r.body === 'string' ? r.body : '';
  if (r.truncated && !ctx.write) {
    throw opError('OUTPUT_TOO_LARGE', 'The response from ' + ctx.host + ' was too large and was cut off by Cindy. Narrow the request (smaller limit, a specific path or a single item).');
  }
  if (spec.text) return { text: body, status: status, headers: r.headers || {} };
  var data = null;
  if (body) {
    try {
      data = JSON.parse(body);
    } catch (e) {
      if (!ctx.write) throw opError('BAD_RESPONSE', 'Gitea at ' + ctx.host + ' returned a response that is not JSON. Check that the instance URL points at Gitea.');
      data = null;
    }
  }
  return { data: data, status: status, headers: r.headers || {} };
}

/* ── trimming ───────────────────────────────────────────────────────── */

function login(u) {
  return u && typeof u === 'object' ? u.login || u.username || null : null;
}

function firstLine(s) {
  return typeof s === 'string' ? s.split('\n')[0] : s;
}

function names(list) {
  return Array.isArray(list) ? list.map(function (x) { return x && x.name; }) : [];
}

function logins(list) {
  return Array.isArray(list) ? list.map(login) : [];
}

function trimUser(u) {
  if (!u) return null;
  return {
    id: u.id, login: u.login, full_name: u.full_name || '', email: u.email || '',
    html_url: u.html_url, is_admin: u.is_admin === true, created: u.created,
  };
}

function trimRepo(r, full) {
  if (!r) return null;
  var out = {
    full_name: r.full_name, description: clip(r.description || '', LIST_BODY_MAX), private: r.private,
    fork: r.fork, archived: r.archived, mirror: r.mirror, default_branch: r.default_branch,
    html_url: r.html_url, updated_at: r.updated_at, stars_count: r.stars_count,
    open_issues_count: r.open_issues_count, open_pr_counter: r.open_pr_counter,
  };
  if (full) {
    out.clone_url = r.clone_url;
    out.ssh_url = r.ssh_url;
    out.language = r.language;
    out.size_kb = r.size;
    out.forks_count = r.forks_count;
    out.topics = r.topics || [];
    out.has_issues = r.has_issues;
    out.has_pull_requests = r.has_pull_requests;
    out.has_actions = r.has_actions;
    out.has_releases = r.has_releases;
    out.default_merge_style = r.default_merge_style;
    out.merge_styles_allowed = [
      r.allow_merge_commits && 'merge', r.allow_rebase && 'rebase', r.allow_rebase_explicit && 'rebase-merge',
      r.allow_squash_merge && 'squash', r.allow_fast_forward_only_merge && 'fast-forward-only',
    ].filter(Boolean);
    out.permissions = r.permissions || null;
    out.parent = r.parent ? r.parent.full_name : null;
  }
  return out;
}

function trimBranch(b) {
  return {
    name: b.name, protected: b.protected === true,
    commit_sha: b.commit && b.commit.id, commit_message: clip(firstLine(b.commit && b.commit.message), 200),
    commit_date: b.commit && b.commit.timestamp,
  };
}

function trimCommit(c) {
  var commit = c.commit || {};
  var author = commit.author || {};
  return {
    sha: c.sha, message: clip(commit.message || '', 1000), author: author.name, author_login: login(c.author),
    date: author.date, html_url: c.html_url,
  };
}

function trimIssue(i, full) {
  var out = {
    number: i.number, title: i.title, state: i.state, user: login(i.user),
    labels: names(i.labels), assignees: logins(i.assignees), milestone: i.milestone ? i.milestone.title : null,
    comments: i.comments, created_at: i.created_at, updated_at: i.updated_at, html_url: i.html_url,
  };
  if (i.pull_request) out.is_pull_request = true;
  if (full) {
    out.body = clip(i.body || '', ITEM_BODY_MAX);
    out.closed_at = i.closed_at;
    out.due_date = i.due_date;
    out.is_locked = i.is_locked;
  } else {
    out.body_preview = clip(i.body || '', LIST_BODY_MAX);
  }
  return out;
}

function trimComment(c) {
  return {
    id: c.id, user: login(c.user), created_at: c.created_at, updated_at: c.updated_at,
    body: clip(c.body || '', COMMENT_BODY_MAX), html_url: c.html_url,
  };
}

function trimPull(p, full) {
  var out = {
    number: p.number, title: p.title, state: p.state, draft: p.draft === true, merged: p.merged === true,
    mergeable: p.mergeable, user: login(p.user), head: p.head && p.head.ref, base: p.base && p.base.ref,
    labels: names(p.labels), created_at: p.created_at, updated_at: p.updated_at, html_url: p.html_url,
  };
  if (full) {
    out.body = clip(p.body || '', ITEM_BODY_MAX);
    out.head_sha = p.head && p.head.sha;
    out.head_repo = p.head && p.head.repo ? p.head.repo.full_name : null;
    out.merge_base = p.merge_base;
    out.merged_at = p.merged_at;
    out.merged_by = login(p.merged_by);
    out.merge_commit_sha = p.merge_commit_sha;
    out.assignees = logins(p.assignees);
    out.requested_reviewers = logins(p.requested_reviewers);
    out.milestone = p.milestone ? p.milestone.title : null;
    out.comments = p.comments;
    out.additions = p.additions;
    out.deletions = p.deletions;
    out.changed_files = p.changed_files;
    out.closed_at = p.closed_at;
  }
  return out;
}

function trimChangedFile(f) {
  return {
    filename: f.filename, previous_filename: f.previous_filename || undefined, status: f.status,
    additions: f.additions, deletions: f.deletions, changes: f.changes,
  };
}

function trimLabel(l) {
  return { id: l.id, name: l.name, color: l.color, description: clip(l.description || '', LIST_BODY_MAX), exclusive: l.exclusive === true, is_archived: l.is_archived === true };
}

function trimMilestone(m) {
  return {
    id: m.id, title: m.title, state: m.state, open_issues: m.open_issues, closed_issues: m.closed_issues,
    due_on: m.due_on, description: clip(m.description || '', LIST_BODY_MAX),
  };
}

function trimRun(r) {
  return {
    id: r.id, run_number: r.run_number, title: r.display_title, status: r.status, conclusion: r.conclusion,
    event: r.event, head_branch: r.head_branch, head_sha: r.head_sha, workflow: r.path,
    actor: login(r.actor), started_at: r.started_at, completed_at: r.completed_at, html_url: r.html_url,
  };
}

function trimJob(j) {
  return {
    id: j.id, run_id: j.run_id, name: j.name, status: j.status, conclusion: j.conclusion,
    started_at: j.started_at, completed_at: j.completed_at, runner_name: j.runner_name, html_url: j.html_url,
    steps: Array.isArray(j.steps) ? j.steps.map(function (s) { return { number: s.number, name: s.name, status: s.status, conclusion: s.conclusion }; }) : [],
  };
}

function trimTask(t) {
  return {
    id: t.id, name: t.name, title: t.display_title, status: t.status, event: t.event, workflow_id: t.workflow_id,
    head_branch: t.head_branch, head_sha: t.head_sha, run_number: t.run_number,
    created_at: t.created_at, run_started_at: t.run_started_at, updated_at: t.updated_at, url: t.url,
  };
}

function trimRelease(r) {
  return {
    id: r.id, tag_name: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease,
    target_commitish: r.target_commitish, author: login(r.author), created_at: r.created_at,
    published_at: r.published_at, html_url: r.html_url, body: clip(r.body || '', 2000),
    assets: Array.isArray(r.assets) ? r.assets.map(function (x) { return { name: x.name, size: x.size, download_count: x.download_count, browser_download_url: x.browser_download_url }; }) : [],
  };
}

function trimNotification(n) {
  var s = n.subject || {};
  return {
    id: n.id, unread: n.unread, pinned: n.pinned, updated_at: n.updated_at,
    repository: n.repository ? n.repository.full_name : null,
    subject: { type: s.type, title: s.title, state: s.state, html_url: s.html_url },
  };
}

function listResult(items, paging, headers, trim) {
  var arr = Array.isArray(items) ? items : [];
  var totalRaw = header(headers, 'x-total-count');
  var total = totalRaw !== undefined && /^[0-9]+$/.test(String(totalRaw)) ? Number(totalRaw) : null;
  var out = {
    items: arr.map(trim),
    page: paging.page,
    limit: paging.limit,
    count: arr.length,
    has_more: total !== null ? paging.page * paging.limit < total : arr.length >= paging.limit,
  };
  if (total !== null) out.total = total;
  if (paging.capped) out.note = 'limit was capped at ' + MAX_LIMIT + '; use page to continue.';
  return out;
}

/* ── base64 and text windows ────────────────────────────────────────── */

function decodeBase64(b64) {
  var bin = atob(String(b64).replace(/\s+/g, ''));
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function looksBinary(bytes) {
  var n = Math.min(bytes.length, 8000);
  for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

function windowText(text, win, fromEnd) {
  var total = text.length;
  var start;
  if (fromEnd && win.offset === null) {
    start = Math.max(0, total - win.max);
  } else {
    start = Math.min(win.offset || 0, total);
  }
  var end = Math.min(total, start + win.max);
  var out = { content: text.slice(start, end), offset: start, returned_chars: end - start, total_chars: total, truncated: start > 0 || end < total };
  if (end < total) out.next_offset = end;
  return out;
}

/* ── operation catalog ──────────────────────────────────────────────── */

var CATEGORIES = {
  user: 'The account behind the token',
  repos: 'List, search and inspect repositories',
  code: 'Branches, file contents and commits',
  issues: 'Issues and comments (comments also work on pull requests); writes: create, comment, state, labels',
  pulls: 'Pull requests, changed files and diffs; writes: create and merge',
  labels: 'Repository labels and milestones',
  actions: 'Gitea Actions workflow runs, jobs, tasks and job logs',
  releases: 'Releases; write: create',
  notifications: 'Notification inbox of the token account',
};

var OPS = {};

var REPO_DOC = 'owner*:string, repo*:string (or repo:"owner/name")';
var PAGE_DOC = 'page?:int>=1, limit?:1-' + MAX_LIMIT + ' (default ' + DEFAULT_LIMIT + ')';
var INSTANCE_DOC = 'instance?:connection id or host';

function readOp(name, cat, scope, desc, params, run) {
  OPS[name] = { cat: cat, scope: scope, desc: desc, params: params + ', ' + INSTANCE_DOC, run: run, write: false };
}

/** prepare(a, inst) -> { request, confirm: { body, button, danger }, shape(data) } */
function writeOp(name, cat, scope, desc, params, prepare) {
  OPS[name] = {
    cat: cat, scope: scope, desc: 'WRITE (asks the user to confirm in Cindy first): ' + desc,
    params: params + ', instance?:required when several instances are configured', prepare: prepare, write: true,
  };
}

/* user */

readOp('get_current_user', 'user', 'read:user', 'The user that owns the token (login, name, email, admin flag).', 'no parameters',
  async function (a, http) {
    var r = await http({ path: '/user' });
    return trimUser(r.data);
  });

/* repos */

readOp('list_my_repos', 'repos', 'read:user + read:repository', 'Repositories the token user owns or can access.', PAGE_DOC,
  async function (a, http) {
    var p = readPaging(a);
    var r = await http({ path: '/user/repos', query: { page: p.page, limit: p.limit } });
    return listResult(r.data, p, r.headers, function (x) { return trimRepo(x, false); });
  });

readOp('search_repos', 'repos', 'read:repository', 'Search repositories visible to the token user.',
  'q?:string, sort?:alpha|created|updated|size|stars|forks|id, order?:asc|desc, mode?:fork|source|mirror|collaborative, archived?:bool, ' + PAGE_DOC,
  async function (a, http) {
    var p = readPaging(a);
    var r = await http({
      path: '/repos/search',
      query: {
        q: optString(a, 'q', 200),
        sort: optEnum(a, 'sort', ['alpha', 'created', 'updated', 'size', 'stars', 'forks', 'id']),
        order: optEnum(a, 'order', ['asc', 'desc']),
        mode: optEnum(a, 'mode', ['fork', 'source', 'mirror', 'collaborative']),
        archived: optBool(a, 'archived'),
        page: p.page, limit: p.limit,
      },
    });
    var items = r.data && Array.isArray(r.data.data) ? r.data.data : [];
    return listResult(items, p, r.headers, function (x) { return trimRepo(x, false); });
  });

readOp('get_repo', 'repos', 'read:repository', 'Repository details: default branch, clone URLs, allowed merge styles, permissions.', REPO_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var r = await http({ path: rp.path });
    return trimRepo(r.data, true);
  });

/* code */

readOp('list_branches', 'code', 'read:repository', 'Branches with their head commit.', REPO_DOC + ', ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({ path: rp.path + '/branches', query: { page: p.page, limit: p.limit } });
    return listResult(r.data, p, r.headers, trimBranch);
  });

readOp('get_file', 'code', 'read:repository',
  'Read a text file (decoded from base64, files up to 1 MiB, text window via offset/max_chars) or list a directory. Binary files return metadata only.',
  REPO_DOC + ', path*:string (file or directory; "" for the root), ref?:branch, tag or commit, offset?:int, max_chars?:1-' + TEXT_MAX_CHARS + ' (default ' + TEXT_DEFAULT_CHARS + ')',
  async function (a, http) {
    var rp = repoPath(a);
    if (a.path === undefined || a.path === null) throw invalid('path is required ("" for the repository root).');
    var encoded = filePath(a.path, 'path');
    var ref = optString(a, 'ref', 250);
    var win = textWindow(a);
    var r = await http({ path: rp.path + '/contents' + (encoded ? '/' + encoded : ''), query: { ref: ref } });
    var d = r.data;
    if (Array.isArray(d)) {
      var entries = d.slice(0, DIR_MAX_ENTRIES).map(function (e) { return { name: e.name, path: e.path, type: e.type, size: e.size }; });
      var dir = { type: 'dir', path: typeof a.path === 'string' ? a.path : '', ref: ref || null, entries: entries, count: d.length };
      if (d.length > DIR_MAX_ENTRIES) dir.truncated = true;
      return dir;
    }
    if (!d || typeof d !== 'object') throw opError('BAD_RESPONSE', 'Gitea returned an unexpected contents response.');
    var meta = { type: d.type, path: d.path, name: d.name, ref: ref || null, sha: d.sha, size: d.size, html_url: d.html_url };
    if (d.type === 'symlink') { meta.target = d.target; return meta; }
    if (d.type === 'submodule') { meta.submodule_git_url = d.submodule_git_url; return meta; }
    if (d.type !== 'file') return meta;
    if (typeof d.size === 'number' && d.size > FILE_MAX_BYTES) {
      throw opError('OUTPUT_TOO_LARGE', 'File ' + d.path + ' is ' + d.size + ' bytes; get_file reads files up to ' + FILE_MAX_BYTES + ' bytes. Open it in the browser instead: ' + d.html_url);
    }
    if (typeof d.content !== 'string' || d.encoding !== 'base64') {
      throw opError('OUTPUT_TOO_LARGE', 'Gitea did not include the content of ' + d.path + ' (usually because it exceeds the server blob limit). Open it in the browser instead: ' + d.html_url);
    }
    var bytes = decodeBase64(d.content);
    if (looksBinary(bytes)) {
      meta.binary = true;
      meta.note = 'Binary file; content not returned.';
      return meta;
    }
    var text = new TextDecoder('utf-8').decode(bytes);
    var w = windowText(text, win, false);
    for (var k in w) if (Object.prototype.hasOwnProperty.call(w, k)) meta[k] = w[k];
    return meta;
  });

readOp('list_commits', 'code', 'read:repository', 'Commit history, optionally for a branch/sha, a path or a date range.',
  REPO_DOC + ', sha?:branch, tag or commit, path?:string, since?:RFC3339, until?:RFC3339, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/commits',
      query: {
        sha: optString(a, 'sha', 250), path: optString(a, 'path', 1000),
        since: optString(a, 'since', 64), until: optString(a, 'until', 64),
        stat: false, verification: false, files: false, page: p.page, limit: p.limit,
      },
    });
    return listResult(r.data, p, r.headers, trimCommit);
  });

/* issues */

readOp('list_issues', 'issues', 'read:issue', 'Issues of a repository (pull requests excluded), filterable by state, labels, assignee, author, milestone and text.',
  REPO_DOC + ', state?:open|closed|all (default open), labels?:string[] or comma list of names, assignee?:username, created_by?:username, mentioned_by?:username, milestones?:string (comma list), q?:search text, since?:RFC3339, before?:RFC3339, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var labels = stringList(a, 'labels', 20);
    var r = await http({
      path: rp.path + '/issues',
      query: {
        type: 'issues',
        state: optEnum(a, 'state', ['open', 'closed', 'all']),
        labels: labels && labels.length ? labels.join(',') : undefined,
        assigned_by: optString(a, 'assignee', 100),
        created_by: optString(a, 'created_by', 100),
        mentioned_by: optString(a, 'mentioned_by', 100),
        milestones: optString(a, 'milestones', 500),
        q: optString(a, 'q', 200),
        since: optString(a, 'since', 64), before: optString(a, 'before', 64),
        page: p.page, limit: p.limit,
      },
    });
    return listResult(r.data, p, r.headers, function (x) { return trimIssue(x, false); });
  });

readOp('get_issue', 'issues', 'read:issue', 'One issue (or pull request seen as an issue) with its body.', REPO_DOC + ', index*:int',
  async function (a, http) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var r = await http({ path: rp.path + '/issues/' + index });
    return trimIssue(r.data, true);
  });

readOp('list_issue_comments', 'issues', 'read:issue',
  'Comments on an issue or pull request, oldest first. Gitea returns all comments; page/limit slice them here.',
  REPO_DOC + ', index*:int, since?:RFC3339, before?:RFC3339, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/issues/' + index + '/comments',
      query: { since: optString(a, 'since', 64), before: optString(a, 'before', 64) },
    });
    var all = Array.isArray(r.data) ? r.data : [];
    var start = (p.page - 1) * p.limit;
    var slice = all.slice(start, start + p.limit);
    var out = listResult(slice, p, {}, trimComment);
    out.total = all.length;
    out.has_more = start + slice.length < all.length;
    return out;
  });

writeOp('create_issue', 'issues', 'write:issue', 'Create an issue.',
  REPO_DOC + ', title*:string, body?:string, labels?:int[] (label ids from list_labels), assignees?:string[] (usernames), milestone?:int (milestone id)',
  function (a, inst) {
    var rp = repoPath(a);
    var title = reqString(a, 'title', 255);
    var body = optString(a, 'body', WRITE_TEXT_MAX);
    var payload = { title: title };
    if (body !== undefined) payload.body = body;
    var labels = intList(a, 'labels', 20);
    if (labels) payload.labels = labels;
    var assignees = stringList(a, 'assignees', 10);
    if (assignees) payload.assignees = assignees;
    var milestone = optInt(a, 'milestone');
    if (milestone) payload.milestone = milestone;
    return {
      request: { method: 'POST', path: rp.path + '/issues', body: payload },
      confirm: { body: 'Create an issue in ' + rp.full + ' on ' + inst.host + '?\nTitle: ' + title, button: 'Create', danger: false },
      shape: function (d) { return { created: true, issue: trimIssue(d || {}, false) }; },
    };
  });

writeOp('comment_issue', 'issues', 'write:issue', 'Add a comment to an issue or pull request.',
  REPO_DOC + ', index*:int (issue or PR number), body*:string',
  function (a, inst) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var body = reqString(a, 'body', WRITE_TEXT_MAX);
    return {
      request: { method: 'POST', path: rp.path + '/issues/' + index + '/comments', body: { body: body } },
      confirm: { body: 'Post a comment on #' + index + ' in ' + rp.full + ' (' + inst.host + ')?\n' + body, button: 'Comment', danger: false },
      shape: function (d) { return { created: true, comment: trimComment(d || {}) }; },
    };
  });

writeOp('set_issue_state', 'issues', 'write:issue', 'Close or reopen an issue or pull request.',
  REPO_DOC + ', index*:int, state*:open|closed',
  function (a, inst) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var state = optEnum(a, 'state', ['open', 'closed']);
    if (!state) throw invalid('state is required: open or closed.');
    var verb = state === 'closed' ? 'Close' : 'Reopen';
    return {
      request: { method: 'PATCH', path: rp.path + '/issues/' + index, body: { state: state } },
      confirm: { body: verb + ' #' + index + ' in ' + rp.full + ' (' + inst.host + ')?', button: verb, danger: false },
      shape: function (d) { return { updated: true, issue: trimIssue(d || {}, false) }; },
    };
  });

writeOp('edit_issue_labels', 'issues', 'write:issue',
  'Change labels of an issue or pull request. action add or replace takes labels (ids or names); action remove takes one label_id.',
  REPO_DOC + ', index*:int, action*:add|replace|remove, labels?:(int|string)[] (add/replace; replace with [] clears all), label_id?:int (remove)',
  function (a, inst) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var action = optEnum(a, 'action', ['add', 'replace', 'remove']);
    if (!action) throw invalid('action is required: add, replace or remove.');
    var base = rp.path + '/issues/' + index + '/labels';
    var where = ' on #' + index + ' in ' + rp.full + ' (' + inst.host + ')';
    var shapeLabels = function (d) { return { updated: true, labels: Array.isArray(d) ? d.map(function (l) { return l.name; }) : null }; };
    if (action === 'remove') {
      var id = reqInt(a, 'label_id');
      return {
        request: { method: 'DELETE', path: base + '/' + id },
        confirm: { body: 'Remove label id ' + id + where + '?', button: 'Remove', danger: false },
        shape: function () { return { updated: true, removed_label_id: id }; },
      };
    }
    if (!Array.isArray(a.labels)) throw invalid('labels is required for add/replace and must be an array of label ids or names.');
    if (a.labels.length > 20) throw invalid('labels accepts at most 20 items.');
    if (action === 'add' && !a.labels.length) throw invalid('labels must not be empty for add.');
    var labels = a.labels.map(function (x) {
      var n = toPositiveInt(x);
      if (typeof x === 'number' && n !== null) return n;
      if (typeof x === 'string' && x.trim() && x.length <= 100) return x.trim();
      throw invalid('labels must contain label ids or non-empty names.');
    });
    var shown = labels.length ? labels.join(', ') : '(none)';
    return {
      request: { method: action === 'add' ? 'POST' : 'PUT', path: base, body: { labels: labels } },
      confirm: { body: (action === 'add' ? 'Add labels ' : 'Replace all labels with ') + shown + where + '?', button: action === 'add' ? 'Add' : 'Replace', danger: false },
      shape: shapeLabels,
    };
  });

/* pulls */

readOp('list_pull_requests', 'pulls', 'read:repository', 'Pull requests of a repository.',
  REPO_DOC + ', state?:open|closed|all (default open), sort?:oldest|recentupdate|recentclose|leastupdate|mostcomment|leastcomment|priority, labels?:int[] (label ids), poster?:username, base_branch?:string, milestone?:int, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/pulls',
      query: {
        state: optEnum(a, 'state', ['open', 'closed', 'all']),
        sort: optEnum(a, 'sort', ['oldest', 'recentupdate', 'recentclose', 'leastupdate', 'mostcomment', 'leastcomment', 'priority']),
        labels: intList(a, 'labels', 20),
        poster: optString(a, 'poster', 100),
        base_branch: optString(a, 'base_branch', 250),
        milestone: optInt(a, 'milestone'),
        page: p.page, limit: p.limit,
      },
    });
    return listResult(r.data, p, r.headers, function (x) { return trimPull(x, false); });
  });

readOp('get_pull_request', 'pulls', 'read:repository', 'One pull request with body, head/base, mergeability and stats.', REPO_DOC + ', index*:int',
  async function (a, http) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var r = await http({ path: rp.path + '/pulls/' + index });
    return trimPull(r.data, true);
  });

readOp('list_pull_request_files', 'pulls', 'read:repository', 'Files changed by a pull request with line counts.',
  REPO_DOC + ', index*:int, whitespace?:ignore-all|ignore-change|ignore-eol|show-all, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/pulls/' + index + '/files',
      query: { whitespace: optEnum(a, 'whitespace', ['ignore-all', 'ignore-change', 'ignore-eol', 'show-all']), page: p.page, limit: p.limit },
    });
    return listResult(r.data, p, r.headers, trimChangedFile);
  });

readOp('get_pull_request_diff', 'pulls', 'read:repository',
  'Unified diff (or patch) of a pull request as text, windowed by offset/max_chars.',
  REPO_DOC + ', index*:int, format?:diff|patch (default diff), offset?:int, max_chars?:1-' + TEXT_MAX_CHARS + ' (default ' + TEXT_DEFAULT_CHARS + ')',
  async function (a, http) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    var format = optEnum(a, 'format', ['diff', 'patch']) || 'diff';
    var win = textWindow(a);
    var r = await http({ path: rp.path + '/pulls/' + index + '.' + format, accept: 'text/plain', text: true });
    var out = windowText(r.text, win, false);
    out.format = format;
    return out;
  });

writeOp('create_pull_request', 'pulls', 'write:repository', 'Open a pull request from head into base.',
  REPO_DOC + ', head*:branch (or "owner:branch" from a fork), base*:branch, title*:string, body?:string, assignees?:string[], labels?:int[], milestone?:int',
  function (a, inst) {
    var rp = repoPath(a);
    var head = reqString(a, 'head', 250);
    var base = reqString(a, 'base', 250);
    var title = reqString(a, 'title', 255);
    var payload = { head: head, base: base, title: title };
    var body = optString(a, 'body', WRITE_TEXT_MAX);
    if (body !== undefined) payload.body = body;
    var assignees = stringList(a, 'assignees', 10);
    if (assignees) payload.assignees = assignees;
    var labels = intList(a, 'labels', 20);
    if (labels) payload.labels = labels;
    var milestone = optInt(a, 'milestone');
    if (milestone) payload.milestone = milestone;
    return {
      request: { method: 'POST', path: rp.path + '/pulls', body: payload },
      confirm: { body: 'Open a pull request in ' + rp.full + ' (' + inst.host + ') from ' + head + ' into ' + base + '?\nTitle: ' + title, button: 'Open PR', danger: false },
      shape: function (d) { return { created: true, pull_request: trimPull(d || {}, false) }; },
    };
  });

writeOp('merge_pull_request', 'pulls', 'write:repository',
  'Merge a pull request. style is required (no default). Pass head_commit_id to refuse merging if the PR changed since you reviewed it.',
  REPO_DOC + ', index*:int, style*:' + MERGE_STYLES.join('|') + ', title?:string, message?:string, delete_branch_after_merge?:bool, head_commit_id?:string (expected head sha)',
  function (a, inst) {
    var rp = repoPath(a);
    var index = reqInt(a, 'index');
    if (a.style === undefined || a.style === null || a.style === '') throw invalid('style is required: ' + MERGE_STYLES.join(', ') + '. Ask the user which merge style to use.');
    var style = optEnum(a, 'style', MERGE_STYLES);
    var payload = { Do: style };
    var title = optString(a, 'title', 255);
    if (title !== undefined) payload.MergeTitleField = title;
    var message = optString(a, 'message', WRITE_TEXT_MAX);
    if (message !== undefined) payload.MergeMessageField = message;
    var del = optBool(a, 'delete_branch_after_merge');
    if (del !== undefined) payload.delete_branch_after_merge = del;
    var head = optString(a, 'head_commit_id', 64);
    if (head !== undefined) {
      if (!/^[0-9a-f]{7,64}$/i.test(head)) throw invalid('head_commit_id must be a hex commit sha.');
      payload.head_commit_id = head;
    }
    return {
      request: { method: 'POST', path: rp.path + '/pulls/' + index + '/merge', body: payload },
      confirm: {
        body: 'Merge pull request #' + index + ' in ' + rp.full + ' (' + inst.host + ') using "' + style + '"' + (del ? ' and delete the head branch' : '') + '? This cannot be undone.',
        button: 'Merge', danger: true,
      },
      shape: function () { return { merged: true, index: index, style: style }; },
    };
  });

/* labels and milestones */

readOp('list_labels', 'labels', 'read:issue', 'Labels of a repository (ids are needed by create_issue and create_pull_request).', REPO_DOC + ', ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({ path: rp.path + '/labels', query: { page: p.page, limit: p.limit } });
    return listResult(r.data, p, r.headers, trimLabel);
  });

readOp('list_milestones', 'labels', 'read:issue', 'Milestones of a repository.', REPO_DOC + ', state?:open|closed|all, name?:string, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/milestones',
      query: { state: optEnum(a, 'state', ['open', 'closed', 'all']), name: optString(a, 'name', 200), page: p.page, limit: p.limit },
    });
    return listResult(r.data, p, r.headers, trimMilestone);
  });

/* actions */

readOp('list_workflow_runs', 'actions', 'read:repository', 'Gitea Actions workflow runs of a repository, newest first.',
  REPO_DOC + ', status?:pending|queued|in_progress|failure|success|skipped, branch?:string, event?:string, actor?:username, head_sha?:string, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/actions/runs',
      query: {
        status: optEnum(a, 'status', ['pending', 'queued', 'in_progress', 'failure', 'success', 'skipped']),
        branch: optString(a, 'branch', 250), event: optString(a, 'event', 100),
        actor: optString(a, 'actor', 100), head_sha: optString(a, 'head_sha', 64),
        page: p.page, limit: p.limit,
      },
    });
    var d = r.data || {};
    var out = listResult(d.workflow_runs, p, {}, trimRun);
    if (typeof d.total_count === 'number') {
      out.total = d.total_count;
      out.has_more = p.page * p.limit < d.total_count;
    }
    return out;
  });

readOp('list_run_jobs', 'actions', 'read:repository', 'Jobs of one workflow run with their steps.',
  REPO_DOC + ', run_id*:int, status?:string, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var run = reqInt(a, 'run_id');
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/actions/runs/' + run + '/jobs',
      query: { status: optString(a, 'status', 50), page: p.page, limit: p.limit },
    });
    var d = r.data || {};
    var out = listResult(d.jobs, p, {}, trimJob);
    if (typeof d.total_count === 'number') {
      out.total = d.total_count;
      out.has_more = p.page * p.limit < d.total_count;
    }
    return out;
  });

readOp('list_action_tasks', 'actions', 'read:repository', 'Recent Actions tasks (one per job attempt) across all workflows of a repository.',
  REPO_DOC + ', ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({ path: rp.path + '/actions/tasks', query: { page: p.page, limit: p.limit } });
    var d = r.data || {};
    var out = listResult(d.workflow_runs, p, {}, trimTask);
    if (typeof d.total_count === 'number') {
      out.total = d.total_count;
      out.has_more = p.page * p.limit < d.total_count;
    }
    return out;
  });

readOp('get_job_log', 'actions', 'read:repository',
  'Log text of one Actions job. By default returns the last max_chars characters (where failures usually are); pass offset to read from a position instead.',
  REPO_DOC + ', job_id*:int, offset?:int, max_chars?:1-' + TEXT_MAX_CHARS + ' (default ' + TEXT_DEFAULT_CHARS + ')',
  async function (a, http) {
    var rp = repoPath(a);
    var job = reqInt(a, 'job_id');
    var win = textWindow(a);
    var r = await http({ path: rp.path + '/actions/jobs/' + job + '/logs', accept: 'text/plain', text: true });
    var out = windowText(r.text, win, true);
    out.job_id = job;
    return out;
  });

/* releases */

readOp('list_releases', 'releases', 'read:repository', 'Releases of a repository, newest first.',
  REPO_DOC + ', draft?:bool, pre_release?:bool, ' + PAGE_DOC,
  async function (a, http) {
    var rp = repoPath(a);
    var p = readPaging(a);
    var r = await http({
      path: rp.path + '/releases',
      query: { draft: optBool(a, 'draft'), 'pre-release': optBool(a, 'pre_release'), page: p.page, limit: p.limit },
    });
    return listResult(r.data, p, r.headers, trimRelease);
  });

writeOp('create_release', 'releases', 'write:repository',
  'Create a release. If tag_name does not exist yet, Gitea creates the tag at target_commitish (default branch when omitted).',
  REPO_DOC + ', tag_name*:string, target_commitish?:branch or sha, name?:string, body?:string, draft?:bool, prerelease?:bool',
  function (a, inst) {
    var rp = repoPath(a);
    var tag = reqString(a, 'tag_name', 250);
    var payload = { tag_name: tag };
    var target = optString(a, 'target_commitish', 250);
    if (target !== undefined) payload.target_commitish = target;
    var name = optString(a, 'name', 255);
    if (name !== undefined) payload.name = name;
    var body = optString(a, 'body', WRITE_TEXT_MAX);
    if (body !== undefined) payload.body = body;
    var draft = optBool(a, 'draft');
    if (draft !== undefined) payload.draft = draft;
    var pre = optBool(a, 'prerelease');
    if (pre !== undefined) payload.prerelease = pre;
    var kind = draft ? 'draft release' : pre ? 'pre-release' : 'release';
    return {
      request: { method: 'POST', path: rp.path + '/releases', body: payload },
      confirm: {
        body: 'Create ' + kind + ' ' + tag + ' in ' + rp.full + ' (' + inst.host + ')' + (target ? ' at ' + target : '') + '?' + (name ? '\nName: ' + name : ''),
        button: 'Create', danger: false,
      },
      shape: function (d) { return { created: true, release: trimRelease(d || {}) }; },
    };
  });

/* notifications */

readOp('list_notifications', 'notifications', 'read:notification', 'Notifications of the token user (unread and pinned by default).',
  'all?:bool (include read), status_types?:("unread"|"read"|"pinned")[], subject_type?:("issue"|"pull"|"commit"|"repository")[], since?:RFC3339, before?:RFC3339, ' + PAGE_DOC,
  async function (a, http) {
    var p = readPaging(a);
    var statusTypes = stringList(a, 'status_types', 3);
    var subjectTypes = stringList(a, 'subject_type', 4);
    (statusTypes || []).forEach(function (s) { if (['unread', 'read', 'pinned'].indexOf(s) < 0) throw invalid('status_types must contain unread, read or pinned.'); });
    (subjectTypes || []).forEach(function (s) { if (['issue', 'pull', 'commit', 'repository'].indexOf(s) < 0) throw invalid('subject_type must contain issue, pull, commit or repository.'); });
    var r = await http({
      path: '/notifications',
      query: {
        all: optBool(a, 'all'), 'status-types': statusTypes, 'subject-type': subjectTypes,
        since: optString(a, 'since', 64), before: optString(a, 'before', 64),
        page: p.page, limit: p.limit,
      },
    });
    return listResult(r.data, p, r.headers, trimNotification);
  });

/* ── list_tools / call_tool ─────────────────────────────────────────── */

function listTools(args) {
  var category = args && typeof args.category === 'string' ? args.category : '';
  if (!category) {
    var overview = {};
    for (var cat in CATEGORIES) {
      if (Object.prototype.hasOwnProperty.call(CATEGORIES, cat)) overview[cat] = { count: 0, writes: 0, description: CATEGORIES[cat] };
    }
    for (var name in OPS) {
      if (!Object.prototype.hasOwnProperty.call(OPS, name)) continue;
      overview[OPS[name].cat].count++;
      if (OPS[name].write) overview[OPS[name].cat].writes++;
    }
    return {
      categories: overview,
      hint: 'Pass category to see its operations, then run one with call_tool({name, args}). Repository operations need owner and repo. With several instances, pass args.instance.',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) {
    throw opError('UNKNOWN_CATEGORY', 'Unknown category "' + cleanText(category, 50) + '". Available: ' + Object.keys(CATEGORIES).join(', ') + '.');
  }
  var tools = [];
  for (var n in OPS) {
    if (!Object.prototype.hasOwnProperty.call(OPS, n) || OPS[n].cat !== category) continue;
    tools.push({ name: n, description: OPS[n].desc, params: OPS[n].params, token_scope: OPS[n].scope, write: OPS[n].write });
  }
  return { category: category, tools: tools, hint: 'Notation: * = required, ? = optional.' };
}

function withParams(err, entry) {
  if (err && err.code === 'INVALID_ARGS') err.message += ' Parameters: ' + entry.params;
  return err;
}

async function confirmWrite(msg, confirm) {
  if (typeof cindy.confirm !== 'function') {
    throw opError('CONFIRM_UNAVAILABLE', 'Not executed: this Cindy version cannot show a confirmation dialog, so writes are disabled. Update Cindy to use write operations.');
  }
  var spec = {
    body: cleanText(confirm.body, CONFIRM_BODY_MAX - 3),
    confirmText: confirm.button,
    cancelText: 'Cancel',
    danger: confirm.danger === true,
  };
  if (msg && typeof msg.mobilePageId === 'string') spec.mobilePageId = msg.mobilePageId;
  var answer;
  try {
    answer = await cindy.confirm(spec);
  } catch (e) {
    throw opError('CONFIRM_UNAVAILABLE', 'Not executed: the confirmation dialog could not be shown (' + cleanText(e && e.message ? e.message : String(e), 120) + ').');
  }
  if (!answer || answer.ok !== true) {
    var reason = answer && (answer.message || answer.errorCode || answer.code);
    throw opError('CONFIRM_UNAVAILABLE', 'Not executed: the confirmation dialog could not be shown' + (reason ? ' (' + cleanText(reason, 120) + ')' : '') + '. Try again in a few seconds.');
  }
  if (answer.confirmed !== true) {
    throw opError('CONFIRM_DECLINED', 'Not executed: the user declined the confirmation (or it timed out). Do not retry unless the user asks again.');
  }
}

async function callTool(args, msg) {
  var name = typeof args.name === 'string' ? args.name : '';
  if (!name) throw opError('INVALID_ARGS', 'name is required; use list_tools to see the operations.');
  if (!Object.prototype.hasOwnProperty.call(OPS, name)) {
    throw opError('UNKNOWN_OPERATION', 'Unknown operation "' + cleanText(name, 64) + '". Use list_tools (categories: ' + Object.keys(CATEGORIES).join(', ') + ').');
  }
  var entry = OPS[name];
  var a = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};
  var inst = await resolveInstance(a, entry.write);
  var ctx = { host: inst.host, callId: msg.callId, write: entry.write, scope: entry.scope };

  if (!entry.write) {
    var result;
    try {
      result = await entry.run(a, function (spec) { return request(ctx, spec); });
    } catch (e) {
      throw withParams(e, entry);
    }
    var size = JSON.stringify(result === undefined ? null : result).length;
    if (size > RESULT_MAX_CHARS) {
      throw opError('OUTPUT_TOO_LARGE', 'The result is ' + size + ' characters, over the ' + RESULT_MAX_CHARS + ' limit. Narrow it: lower limit, use page, a smaller max_chars or a more specific path.');
    }
    return { instance: inst.host, data: result };
  }

  var plan;
  try {
    plan = entry.prepare(a, inst);
  } catch (e) {
    throw withParams(e, entry);
  }
  await confirmWrite(msg, plan.confirm);
  var r = await request(ctx, plan.request);
  var shaped;
  try {
    shaped = plan.shape(r.data);
  } catch (e) {
    shaped = { executed: true, note: 'Gitea accepted the write (HTTP ' + r.status + ') but the response could not be summarized.' };
  }
  return { instance: inst.host, data: shaped };
}

/* ── settings page connection test (BroadcastChannel) ───────────────── */

if (typeof BroadcastChannel === 'function') {
  var channel = new BroadcastChannel(CHANNEL_NAME);
  var seenTests = {};
  channel.onmessage = function (ev) {
    var m = ev && ev.data;
    if (!m || m.type !== 'test-connection' || !m.reqId) return;
    if (seenTests[m.reqId]) return;
    if (Object.keys(seenTests).length > 200) seenTests = {};
    seenTests[m.reqId] = 1;
    void (async function () {
      var reply = { type: 'test-connection-result', reqId: m.reqId, ok: false };
      try {
        var inst = await resolveInstance(m.connectionId ? { instance: m.connectionId } : {}, false);
        var r = await request({ host: inst.host, write: false, scope: 'read:user' }, { path: '/user' });
        var user = (r.data && r.data.login) || '';
        try {
          var kv = await (await fetch('/kv')).json();
          kv = kv && typeof kv === 'object' ? kv : {};
          var users = kv.connectedUsers && typeof kv.connectedUsers === 'object' ? kv.connectedUsers : {};
          users[inst.id] = user;
          kv.connectedUsers = users;
          await fetch('/kv', { method: 'PUT', body: JSON.stringify(kv) });
        } catch (e) {
          /* The cached login only decorates the settings list. */
        }
        reply = { type: 'test-connection-result', reqId: m.reqId, ok: true, username: user, host: inst.host };
      } catch (e) {
        reply.message = e && e.safe ? e.message : 'Connection test failed.';
      }
      channel.postMessage(reply);
    })();
  };
}

/* ── dispatch ───────────────────────────────────────────────────────── */

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  var reply;
  try {
    var result;
    if (msg.tool === 'list_tools') {
      result = listTools(msg.args || {});
    } else if (msg.tool === 'call_tool') {
      result = await callTool(msg.args || {}, msg);
    } else {
      throw opError('UNKNOWN_TOOL', 'Unknown tool "' + cleanText(msg.tool, 64) + '".');
    }
    reply = { type: 'tool-result', callId: msg.callId, ok: true, result: result };
  } catch (e) {
    var safe = e && e.safe;
    reply = {
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: safe ? e.code : 'INTERNAL_ERROR',
      message: safe ? e.message : 'The Gitea plugin hit an unexpected error: ' + cleanText(redact(e && e.message ? e.message : String(e)), 200),
    };
  }
  await cindy.send(reply);
});
