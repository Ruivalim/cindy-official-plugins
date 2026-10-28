import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'gitea');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'ghost.json'), 'utf8'));
const source = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(pluginDir, 'settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(pluginDir, 'settings.html'), 'utf8');
const LOCALES = ['en', 'zh-CN', 'ja', 'ko'];

// Placeholder credential in the 40-hex shape Gitea uses. The fake host below
// "injects" it like Cindy does; the plugin must never see or echo it.
const TOKEN = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'git.example.test';
const DEFAULT_CONNECTIONS = [{ id: 'conn-1', host: HOST, isDefault: true, tail: '4567' }];

// Values created inside the vm realm have foreign prototypes; normalize them
// so strict deep equality compares data only.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function json(data, status = 200, headers = {}) {
  return { ok: true, status, body: JSON.stringify(data), headers };
}

function text(body, status = 200) {
  return { ok: true, status, body, headers: {} };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const connections = options.connections ?? DEFAULT_CONNECTIONS;
  const requests = [];
  const confirms = [];
  const results = [];
  const kvWrites = [];
  let handler = null;
  let channel = null;

  const cindy = {
    onHostMessage(fn) {
      handler = fn;
    },
    async fetch(req) {
      const r = plain(req);
      requests.push(r);
      // What the host would add for a matching connection. Kept out of the
      // plugin's view on purpose; responders may echo it to prove redaction.
      const injected = { ...r.headers, Authorization: `token ${TOKEN}` };
      if (options.respond) return options.respond(r, injected, requests.length);
      return json({});
    },
    async send(message) {
      results.push(plain(message));
      return { ok: true };
    },
  };
  if (options.confirm !== false) {
    cindy.confirm = async (spec) => {
      confirms.push(plain(spec));
      if (typeof options.confirmAnswer === 'function') return options.confirmAnswer(spec);
      return options.confirmAnswer ?? { ok: true, confirmed: true };
    };
  }

  class FakeBroadcastChannel {
    constructor() {
      channel = this;
      this.posted = [];
    }

    postMessage(message) {
      this.posted.push(plain(message));
    }
  }

  const localFetch = async (url, init) => {
    if (url === '/connections') {
      return { ok: true, json: async () => [{ key: 'gitea_conn', connections }] };
    }
    if (url === '/kv') {
      if (init?.method === 'PUT') {
        kvWrites.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({}) };
    }
    throw new Error(`unexpected local fetch ${url}`);
  };

  vm.runInNewContext(source, {
    cindy,
    fetch: localFetch,
    BroadcastChannel: FakeBroadcastChannel,
    atob,
    TextDecoder,
  }, { filename: 'gitea/main.js' });
  assert.equal(typeof handler, 'function');

  return {
    requests,
    confirms,
    results,
    kvWrites,
    get channel() {
      return channel;
    },
    async call(name, args = {}, extra = {}) {
      await handler({ type: 'tool-call', tool: 'call_tool', callId: 'call-1', args: { name, args }, ...extra });
      return results.at(-1);
    },
    async listTools(category) {
      await handler({ type: 'tool-call', tool: 'list_tools', callId: 'call-1', args: category ? { category } : {} });
      return results.at(-1);
    },
  };
}

function urlOf(request) {
  return new URL(request.url);
}

function assertFailure(result, code) {
  assert.equal(result.type, 'tool-result');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.errorCode, code, result.message);
  return result.message;
}

function assertSuccess(result) {
  assert.equal(result.type, 'tool-result');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result.data;
}

/* ── manifest, locales, static policy ──────────────────────────────── */

test('manifest declares a v3 package with per-instance token injection and business confirmation', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.id, 'gitea');
  assert.equal(manifest.minCindyVersion, '0.1.64');
  assert.equal(manifest.command, 'gitea');
  assert.equal(manifest.author, 'Rui Valim');
  assert.equal('slots' in manifest, false);
  assert.equal(manifest.confirm, true);
  assert.equal(manifest.settingsHtml, 'settings.html');
  assert.equal('notify' in manifest, false);
  assert.equal('fs' in manifest, false);
  assert.equal(manifest.network.hosts, undefined, 'no static hosts: every instance comes from a connection');
  assert.deepEqual(manifest.network.connections.map((c) => [c.key, c.inject]), [
    ['gitea_conn', { header: 'Authorization', format: 'token {value}' }],
  ]);
  assert.deepEqual(manifest.tools.map((t) => t.name), ['list_tools', 'call_tool']);
  assert.ok(fs.statSync(path.join(pluginDir, manifest.icon)).size > 0);
});

test('four locales cover the catalog, connection label and every tool with real text', () => {
  const seen = new Set();
  for (const locale of LOCALES) {
    const resource = JSON.parse(fs.readFileSync(path.join(pluginDir, manifest.locales[locale]), 'utf8'));
    for (const key of ['name', 'description', 'whenToUse']) {
      assert.ok(resource[key].trim().length > 0 && resource[key].length <= 300, `${locale}.${key}`);
    }
    assert.deepEqual(Object.keys(resource.tools).sort(), ['call_tool', 'list_tools']);
    for (const tool of Object.values(resource.tools)) assert.ok(tool.description.trim().length > 0);
    assert.ok(resource.network.connections.gitea_conn.label.trim());
    assert.ok(resource.network.connections.gitea_conn.hint.length <= 200);
    seen.add(resource.tools.call_tool.description);
  }
  assert.equal(seen.size, LOCALES.length, 'each locale must carry its own translation');
});

test('plugin sources contain no em or en dashes and never read the browser language', () => {
  for (const file of ['ghost.json', 'main.js', 'settings.js', 'settings.html', ...LOCALES.map((l) => `locales/${l}.json`)]) {
    const content = fs.readFileSync(path.join(pluginDir, file), 'utf8');
    assert.doesNotMatch(content, /[\u2013\u2014]/, file);
    assert.doesNotMatch(content, /navigator\.language/, file);
  }
  assert.match(settingsSource, /fetch\('\/app-context'\)/);
  assert.match(settingsHtml, /<script src="\/settings\.js"><\/script>/);
});

/* ── catalog ───────────────────────────────────────────────────────── */

test('list_tools gives an overview and per-category details with scopes and write flags', async () => {
  const h = createHarness();
  const overview = (await h.listTools()).result;
  const total = Object.values(overview.categories).reduce((sum, c) => sum + c.count, 0);
  assert.ok(total >= 20 && total <= 30, `operation count ${total}`);
  assert.equal(overview.categories.pulls.writes, 2);

  const pulls = (await h.listTools('pulls')).result.tools;
  const merge = pulls.find((t) => t.name === 'merge_pull_request');
  assert.equal(merge.write, true);
  assert.equal(merge.token_scope, 'write:repository');
  assert.match(merge.description, /^WRITE/);
  assert.equal(pulls.find((t) => t.name === 'list_pull_requests').write, false);

  assertFailure(await h.listTools('admin'), 'UNKNOWN_CATEGORY');
  assertFailure(await h.call('delete_repo', {}), 'UNKNOWN_OPERATION');
  assert.equal(h.requests.length, 0);
});

/* ── instance resolution ───────────────────────────────────────────── */

test('no configured instance fails before any request', async () => {
  const h = createHarness({ connections: [] });
  const message = assertFailure(await h.call('get_current_user'), 'NO_INSTANCE');
  assert.match(message, /settings/);
  assertFailure(await h.call('create_issue', { owner: 'o', repo: 'r', title: 'x' }), 'NO_INSTANCE');
  assert.equal(h.requests.length, 0);
  assert.equal(h.confirms.length, 0);
});

test('several instances without a default are ambiguous for reads; writes always need an explicit instance', async () => {
  const two = [
    { id: 'a', host: 'git.one.test' },
    { id: 'b', host: 'git.two.test' },
  ];
  const h = createHarness({ connections: two, respond: () => json({ login: 'alice' }) });
  const message = assertFailure(await h.call('get_current_user'), 'AMBIGUOUS_INSTANCE');
  assert.match(message, /git\.one\.test/);
  assert.match(message, /git\.two\.test/);
  assert.equal(h.requests.length, 0);

  assertSuccess(await h.call('get_current_user', { instance: 'git.two.test' }));
  assert.equal(urlOf(h.requests[0]).host, 'git.two.test');
  assertSuccess(await h.call('get_current_user', { instance: 'a' }));
  assert.equal(urlOf(h.requests[1]).host, 'git.one.test');
  assertFailure(await h.call('get_current_user', { instance: 'git.three.test' }), 'UNKNOWN_INSTANCE');

  const withDefault = createHarness({
    connections: [{ ...two[0] }, { ...two[1], isDefault: true }],
    respond: () => json({ login: 'alice' }),
  });
  assertSuccess(await withDefault.call('get_current_user'));
  assert.equal(urlOf(withDefault.requests[0]).host, 'git.two.test');
  assertFailure(await withDefault.call('create_issue', { owner: 'o', repo: 'r', title: 'x' }), 'AMBIGUOUS_INSTANCE');
  assert.equal(withDefault.confirms.length, 0);
  assert.equal(withDefault.requests.length, 1);
});

test('instances must be https on port 443 without a path', async () => {
  const h = createHarness({ respond: () => json({ login: 'alice' }) });
  for (const instance of ['http://git.example.test', 'git.example.test:3000', 'https://git.example.test:8443', 'https://git.example.test/gitea', 'ftp://git.example.test']) {
    assertFailure(await h.call('get_current_user', { instance }), 'INVALID_INSTANCE_URL');
  }
  assert.equal(h.requests.length, 0);
  assertSuccess(await h.call('get_current_user', { instance: 'https://GIT.example.test:443/' }));
  assert.equal(h.requests[0].url, 'https://git.example.test/api/v1/user');

  const badStored = createHarness({ connections: [{ id: 'x', host: 'git.example.test:8443' }] });
  assertFailure(await badStored.call('get_current_user'), 'INVALID_INSTANCE_URL');
  assert.equal(badStored.requests.length, 0);
});

/* ── request shape and HTTP errors ─────────────────────────────────── */

test('reads carry the call id and no credential header from the plugin', async () => {
  const h = createHarness({ respond: () => json({ id: 1, login: 'alice', full_name: 'Alice', avatar_url: 'https://x.test/a.png', is_admin: false }) });
  const data = assertSuccess(await h.call('get_current_user'));
  assert.equal(data.login, 'alice');
  assert.equal('avatar_url' in data, false);
  const req = h.requests[0];
  assert.equal(req.method, 'GET');
  assert.equal(req.callId, 'call-1');
  assert.equal(req.as, 'text');
  assert.equal(req.timeoutMs, 30000);
  assert.deepEqual(Object.keys(req.headers).map((k) => k.toLowerCase()), ['accept']);
});

for (const [status, code, pattern] of [
  [401, 'AUTH_FAILED', /HTTP 401.*replace it/],
  [403, 'FORBIDDEN', /"read:issue" scope/],
  [404, 'NOT_FOUND', /HTTP 404/],
  [409, 'CONFLICT', /Gitea said: branch already exists/],
  [422, 'VALIDATION_FAILED', /Gitea said: branch already exists/],
  [429, 'RATE_LIMITED', /Wait 30 seconds/],
  [500, 'SERVER_ERROR', /HTTP 500/],
  [503, 'SERVER_ERROR', /HTTP 503/],
]) {
  test(`read HTTP ${status} maps to ${code}`, async () => {
    const h = createHarness({
      respond: () => ({ ok: true, status, body: JSON.stringify({ message: 'branch already exists' }), headers: { 'Retry-After': '30' } }),
    });
    const message = assertFailure(await h.call('list_issues', { owner: 'o', repo: 'r' }), code);
    assert.match(message, pattern);
    assert.equal(h.requests.length, 1, 'reads are not retried either');
  });
}

test('network failures and timeouts on reads are reported as network errors', async () => {
  const timeout = createHarness({ respond: () => ({ ok: false, message: 'request timed out after 30000ms' }) });
  assert.match(assertFailure(await timeout.call('get_repo', { owner: 'o', repo: 'r' }), 'NETWORK_ERROR'), /timed out/);
  const thrown = createHarness({ respond: () => { throw new Error('ECONNRESET'); } });
  assert.match(assertFailure(await thrown.call('get_repo', { owner: 'o', repo: 'r' }), 'NETWORK_ERROR'), /ECONNRESET/);
});

test('the token never appears in any result, even when servers or the host echo it', async () => {
  const scenarios = [
    (r, injected) => ({ ok: true, status: 401, body: JSON.stringify({ message: `bad ${injected.Authorization}` }), headers: {} }),
    () => ({ ok: true, status: 403, body: JSON.stringify({ message: `token ${TOKEN} does not have at least one of required scope(s): [read:issue]` }), headers: {} }),
    () => ({ ok: true, status: 422, body: JSON.stringify({ message: `invalid ${TOKEN}` }), headers: {} }),
    () => ({ ok: true, status: 500, body: `Authorization: token ${TOKEN}`, headers: {} }),
    () => ({ ok: false, message: `socket hang up (Authorization: token ${TOKEN})` }),
    () => { throw new Error(`proxy rejected token ${TOKEN}`); },
  ];
  for (const respond of scenarios) {
    const h = createHarness({ respond });
    const read = await h.call('list_issues', { owner: 'o', repo: 'r' });
    assert.equal(read.ok, false);
    assert.doesNotMatch(JSON.stringify(read), new RegExp(TOKEN));
    const write = await h.call('comment_issue', { owner: 'o', repo: 'r', index: 1, body: 'hi' });
    assert.equal(write.ok, false);
    assert.doesNotMatch(JSON.stringify(write), new RegExp(TOKEN));
    for (const req of h.requests) {
      assert.equal(Object.keys(req.headers).some((k) => k.toLowerCase() === 'authorization'), false);
    }
  }
});

/* ── pagination, trimming and size caps ────────────────────────────── */

function rawIssue(n, extra = {}) {
  return {
    id: 1000 + n, number: n, title: `Issue ${n}`, state: 'open', body: 'x'.repeat(5000),
    user: { id: 7, login: 'alice', avatar_url: 'https://x.test/a.png', email: 'a@example.test' },
    labels: [{ id: 1, name: 'bug', color: 'ff0000', url: 'https://x.test/l' }],
    assignees: [{ login: 'bob', avatar_url: 'https://x.test/b.png' }],
    milestone: { id: 3, title: 'v1' }, comments: 2,
    repository: { id: 9, full_name: 'o/r', owner: 'o' },
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    html_url: `https://${HOST}/o/r/issues/${n}`, url: 'api', original_author: '', assets: [],
    ...extra,
  };
}

test('pagination defaults to 20, caps limit at 50 and validates page/limit', async () => {
  const h = createHarness({ respond: () => json([]) });
  assertSuccess(await h.call('list_issues', { owner: 'o', repo: 'r' }));
  let q = urlOf(h.requests[0]).searchParams;
  assert.equal(q.get('page'), '1');
  assert.equal(q.get('limit'), '20');
  assert.equal(q.get('type'), 'issues');

  const capped = assertSuccess(await h.call('list_issues', { owner: 'o', repo: 'r', limit: 500, page: 3 }));
  q = urlOf(h.requests[1]).searchParams;
  assert.equal(q.get('limit'), '50');
  assert.equal(q.get('page'), '3');
  assert.equal(capped.limit, 50);
  assert.match(capped.note, /capped/);

  for (const bad of [{ page: 0 }, { page: -1 }, { page: 'x' }, { limit: 0 }, { limit: 2.5 }, { page: 1e9 }]) {
    assertFailure(await h.call('list_issues', { owner: 'o', repo: 'r', ...bad }), 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 2);
});

test('has_more follows X-Total-Count; comment lists are sliced locally', async () => {
  const h = createHarness({
    respond: (req) => {
      if (req.url.includes('/comments')) {
        return json(Array.from({ length: 25 }, (_, i) => ({ id: i + 1, body: 'c', user: { login: 'u' } })));
      }
      return json([rawIssue(1)], 200, { 'X-Total-Count': '45' });
    },
  });
  assert.equal(assertSuccess(await h.call('list_issues', { owner: 'o', repo: 'r', page: 2 })).has_more, true);
  const last = assertSuccess(await h.call('list_issues', { owner: 'o', repo: 'r', page: 3 }));
  assert.equal(last.has_more, false);
  assert.equal(last.total, 45);

  const page2 = assertSuccess(await h.call('list_issue_comments', { owner: 'o', repo: 'r', index: 4, page: 2, limit: 10 }));
  assert.deepEqual(page2.items.map((c) => c.id), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(page2.total, 25);
  assert.equal(page2.has_more, true);
  const page3 = assertSuccess(await h.call('list_issue_comments', { owner: 'o', repo: 'r', index: 4, page: 3, limit: 10 }));
  assert.equal(page3.items.length, 5);
  assert.equal(page3.has_more, false);
});

test('issue lists are trimmed to useful fields', async () => {
  const h = createHarness({ respond: () => json([rawIssue(1), rawIssue(2, { pull_request: { merged: false } })]) });
  const data = assertSuccess(await h.call('list_issues', { owner: 'o', repo: 'r', state: 'all', labels: ['bug', 'ui'], assignee: 'bob' }));
  const q = urlOf(h.requests[0]).searchParams;
  assert.equal(q.get('labels'), 'bug,ui');
  assert.equal(q.get('assigned_by'), 'bob');
  assert.equal(q.get('state'), 'all');
  const [first, second] = data.items;
  assert.deepEqual(Object.keys(first).sort(), [
    'assignees', 'body_preview', 'comments', 'created_at', 'html_url', 'labels', 'milestone',
    'number', 'state', 'title', 'updated_at', 'user',
  ]);
  assert.deepEqual(first.labels, ['bug']);
  assert.deepEqual(first.assignees, ['bob']);
  assert.equal(first.user, 'alice');
  assert.ok(first.body_preview.length < 400);
  assert.equal(second.is_pull_request, true);
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /avatar_url|a@example\.test|"repository"/);
  assertFailure(await h.call('list_issues', { owner: 'o', repo: 'r', state: 'merged' }), 'INVALID_ARGS');
});

test('oversized results fail with OUTPUT_TOO_LARGE instead of flooding the agent', async () => {
  const big = createHarness({
    respond: () => json(Array.from({ length: 50 }, (_, i) => rawIssue(i + 1, { title: 'T'.repeat(1200) }))),
  });
  assert.match(assertFailure(await big.call('list_issues', { owner: 'o', repo: 'r', limit: 50 }), 'OUTPUT_TOO_LARGE'), /limit/);

  const cut = createHarness({ respond: () => ({ ok: true, status: 200, body: '[', headers: {}, truncated: true }) });
  assertFailure(await cut.call('list_branches', { owner: 'o', repo: 'r' }), 'OUTPUT_TOO_LARGE');

  const hugeFile = createHarness({
    respond: () => json({ type: 'file', path: 'big.bin', size: 2 * 1024 * 1024, encoding: 'base64', content: 'AAAA', html_url: 'https://x.test/big' }),
  });
  assertFailure(await hugeFile.call('get_file', { owner: 'o', repo: 'r', path: 'big.bin' }), 'OUTPUT_TOO_LARGE');
});

test('get_file decodes base64 UTF-8 within a text window and refuses binary content', async () => {
  const body = 'olá ✓\nsecond line';
  const responses = {
    'README.md': { type: 'file', name: 'README.md', path: 'README.md', size: Buffer.byteLength(body), encoding: 'base64', content: Buffer.from(body).toString('base64').replace(/(.{8})/g, '$1\n'), sha: 'abc' },
    'logo.png': { type: 'file', name: 'logo.png', path: 'logo.png', size: 4, encoding: 'base64', content: Buffer.from([0x89, 0x50, 0x00, 0x01]).toString('base64') },
  };
  const h = createHarness({
    respond: (req) => {
      const p = urlOf(req).pathname;
      if (p.endsWith('/contents')) return json([{ name: 'src', path: 'src', type: 'dir', size: 0, sha: 's', _links: {} }]);
      return json(responses[decodeURIComponent(p.split('/').pop())]);
    },
  });
  const full = assertSuccess(await h.call('get_file', { owner: 'o', repo: 'r', path: 'README.md' }));
  assert.equal(full.content, body);
  assert.equal(full.truncated, false);
  const part = assertSuccess(await h.call('get_file', { owner: 'o', repo: 'r', path: 'README.md', max_chars: 3 }));
  assert.equal(part.content, 'olá');
  assert.equal(part.truncated, true);
  assert.equal(part.next_offset, 3);
  const bin = assertSuccess(await h.call('get_file', { owner: 'o', repo: 'r', path: 'logo.png' }));
  assert.equal(bin.binary, true);
  assert.equal('content' in bin, false);
  const dir = assertSuccess(await h.call('get_file', { owner: 'o', repo: 'r', path: '' }));
  assert.equal(dir.type, 'dir');
  assert.deepEqual(dir.entries, [{ name: 'src', path: 'src', type: 'dir', size: 0 }]);
  assert.equal(urlOf(h.requests[3]).pathname, '/api/v1/repos/o/r/contents');
});

test('diffs and job logs are capped text; logs return the tail by default', async () => {
  const log = 'a'.repeat(50000) + 'ERROR at end';
  const h = createHarness({
    respond: (req) => (req.url.includes('/logs') ? text(log) : text('diff --git a/x b/x\n+line\n')),
  });
  const diff = assertSuccess(await h.call('get_pull_request_diff', { owner: 'o', repo: 'r', index: 5 }));
  assert.equal(urlOf(h.requests[0]).pathname, '/api/v1/repos/o/r/pulls/5.diff');
  assert.equal(h.requests[0].headers.Accept, 'text/plain');
  assert.match(diff.content, /^diff --git/);

  const tail = assertSuccess(await h.call('get_job_log', { owner: 'o', repo: 'r', job_id: 77 }));
  assert.equal(urlOf(h.requests[1]).pathname, '/api/v1/repos/o/r/actions/jobs/77/logs');
  assert.equal(tail.content.length, 20000);
  assert.ok(tail.content.endsWith('ERROR at end'));
  assert.equal(tail.truncated, true);
  const capped = assertSuccess(await h.call('get_job_log', { owner: 'o', repo: 'r', job_id: 77, max_chars: 999999 }));
  assert.equal(capped.content.length, 40000);
  const head = assertSuccess(await h.call('get_job_log', { owner: 'o', repo: 'r', job_id: 77, offset: 0, max_chars: 10 }));
  assert.equal(head.content, 'a'.repeat(10));
  assert.equal(head.offset, 0);
  assert.equal(head.next_offset, 10);
  assertFailure(await h.call('get_job_log', { owner: 'o', repo: 'r', job_id: 77, offset: -5 }), 'INVALID_ARGS');
  assertFailure(await h.call('get_job_log', { owner: 'o', repo: 'r', job_id: '7/../../admin' }), 'INVALID_ARGS');
});

test('Actions runs and jobs use total_count for has_more', async () => {
  const h = createHarness({
    respond: (req) => (req.url.includes('/jobs')
      ? json({ total_count: 1, jobs: [{ id: 3, run_id: 2, name: 'build', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'checkout', status: 'completed', conclusion: 'success' }] }] })
      : json({ total_count: 30, workflow_runs: [{ id: 2, run_number: 9, status: 'completed', conclusion: 'failure', actor: { login: 'alice', avatar_url: 'x' }, repository: { big: true } }] })),
  });
  const runs = assertSuccess(await h.call('list_workflow_runs', { owner: 'o', repo: 'r', status: 'failure', limit: 10 }));
  assert.equal(runs.total, 30);
  assert.equal(runs.has_more, true);
  assert.equal(runs.items[0].actor, 'alice');
  assert.equal('repository' in runs.items[0], false);
  assert.equal(urlOf(h.requests[0]).searchParams.get('status'), 'failure');
  const jobs = assertSuccess(await h.call('list_run_jobs', { owner: 'o', repo: 'r', run_id: 2 }));
  assert.equal(urlOf(h.requests[1]).pathname, '/api/v1/repos/o/r/actions/runs/2/jobs');
  assert.equal(jobs.items[0].steps[0].name, 'checkout');
  assert.equal(jobs.has_more, false);
});

/* ── path injection ────────────────────────────────────────────────── */

test('owner, repo and numeric ids are validated before any request', async () => {
  const h = createHarness({ respond: () => json({}) });
  const bad = [
    { owner: '..', repo: 'r' },
    { owner: '../admin', repo: 'r' },
    { owner: 'o', repo: '.' },
    { owner: 'o', repo: 'r?x=1' },
    { owner: 'o', repo: 'r#frag' },
    { owner: 'a/b', repo: 'r' },
    { owner: 'o', repo: 'r/../../admin' },
    { owner: 'o%2F..', repo: 'r' },
    { repo: 'o/r/x' },
  ];
  for (const args of bad) assertFailure(await h.call('get_repo', args), 'INVALID_ARGS');
  for (const index of ['1/../../admin', '1?x', -1, 0, 1.5, '01']) {
    assertFailure(await h.call('get_issue', { owner: 'o', repo: 'r', index }), 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 0);
  assertSuccess(await h.call('get_repo', { repo: 'o/r' }));
  assert.equal(urlOf(h.requests[0]).pathname, '/api/v1/repos/o/r');
});

test('file paths and refs are encoded and cannot leave the contents endpoint', async () => {
  const h = createHarness({ respond: () => json([]) });
  for (const p of ['../../admin/users', 'docs/../../../user', 'a/./b', 'a//b', 'a/%2e%2e/b', 'a\\..\\b', 'a/\u0000/b']) {
    assertFailure(await h.call('get_file', { owner: 'o', repo: 'r', path: p }), 'INVALID_ARGS');
  }
  assert.equal(h.requests.length, 0);

  assertSuccess(await h.call('get_file', { owner: 'o', repo: 'r', path: '/docs/a?b#c.md', ref: 'feature/x?y#z&path=evil' }));
  const url = urlOf(h.requests[0]);
  assert.equal(url.host, HOST);
  assert.equal(url.pathname, '/api/v1/repos/o/r/contents/docs/a%3Fb%23c.md');
  assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()], ['ref']);
  assert.equal(url.searchParams.get('ref'), 'feature/x?y#z&path=evil');

  assertSuccess(await h.call('list_commits', { owner: 'o', repo: 'r', sha: 'main&path=x', path: 'src/a b.js' }));
  const commits = urlOf(h.requests[1]);
  assert.equal(commits.pathname, '/api/v1/repos/o/r/commits');
  assert.equal(commits.searchParams.get('sha'), 'main&path=x');
  assert.equal(commits.searchParams.get('path'), 'src/a b.js');
  assert.equal(commits.searchParams.getAll('path').length, 1);
});

/* ── writes: confirmation, single attempt, outcome reporting ───────── */

test('a declined confirmation sends nothing', async () => {
  const h = createHarness({ confirmAnswer: { ok: true, confirmed: false } });
  const message = assertFailure(await h.call('create_issue', { owner: 'o', repo: 'r', title: 'Bug' }), 'CONFIRM_DECLINED');
  assert.match(message, /Not executed/);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.requests.length, 0);
});

test('an unavailable, busy or failing confirmation sends nothing', async () => {
  const noApi = createHarness({ confirm: false });
  assertFailure(await noApi.call('merge_pull_request', { owner: 'o', repo: 'r', index: 1, style: 'merge' }), 'CONFIRM_UNAVAILABLE');
  assert.equal(noApi.requests.length, 0);

  const busy = createHarness({ confirmAnswer: { ok: false, message: 'BUSY' } });
  assertFailure(await busy.call('comment_issue', { owner: 'o', repo: 'r', index: 1, body: 'hi' }), 'CONFIRM_UNAVAILABLE');
  assert.equal(busy.requests.length, 0);

  const throws = createHarness({ confirmAnswer: () => { throw new Error('no window'); } });
  assertFailure(await throws.call('create_release', { owner: 'o', repo: 'r', tag_name: 'v1' }), 'CONFIRM_UNAVAILABLE');
  assert.equal(throws.requests.length, 0);
});

test('invalid write arguments fail before the confirmation dialog', async () => {
  const h = createHarness();
  assertFailure(await h.call('create_issue', { owner: 'o', repo: 'r' }), 'INVALID_ARGS');
  assertFailure(await h.call('merge_pull_request', { owner: 'o', repo: 'r', index: 1 }), 'INVALID_ARGS');
  assertFailure(await h.call('merge_pull_request', { owner: 'o', repo: 'r', index: 1, style: 'yolo' }), 'INVALID_ARGS');
  assertFailure(await h.call('set_issue_state', { owner: 'o', repo: 'r', index: 1, state: 'merged' }), 'INVALID_ARGS');
  assertFailure(await h.call('edit_issue_labels', { owner: 'o', repo: 'r', index: 1, action: 'add', labels: [] }), 'INVALID_ARGS');
  assertFailure(await h.call('comment_issue', { owner: '..', repo: 'r', index: 1, body: 'x' }), 'INVALID_ARGS');
  assert.equal(h.confirms.length, 0);
  assert.equal(h.requests.length, 0);
});

test('a confirmed write sends exactly one request with a bounded confirmation', async () => {
  const h = createHarness({ respond: () => json(rawIssue(12, { title: 'Bug' }), 201) });
  const longTitle = 'B'.repeat(250);
  const data = assertSuccess(await h.call(
    'create_issue',
    { owner: 'o', repo: 'r', title: longTitle, body: 'Details', labels: [1, '2'] },
    { mobilePageId: '0f0e0d0c-0b0a-4908-8706-050403020100' },
  ));
  assert.equal(data.created, true);
  assert.equal(data.issue.number, 12);
  assert.equal(h.requests.length, 1);
  const req = h.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `https://${HOST}/api/v1/repos/o/r/issues`);
  assert.equal(req.callId, 'call-1');
  assert.deepEqual(JSON.parse(req.body), { title: longTitle, body: 'Details', labels: [1, 2] });
  const spec = h.confirms[0];
  assert.ok(spec.body.length <= 300, `confirm body ${spec.body.length}`);
  assert.match(spec.body, /o\/r/);
  assert.match(spec.body, /git\.example\.test/);
  assert.equal(spec.confirmText, 'Create');
  assert.ok(spec.confirmText.length <= 12 && spec.cancelText.length <= 12);
  assert.equal(spec.danger, false);
  assert.equal(spec.mobilePageId, '0f0e0d0c-0b0a-4908-8706-050403020100');
});

test('merge requires an explicit style, is marked dangerous and maps fields to Gitea names', async () => {
  const h = createHarness({ respond: () => ({ ok: true, status: 200, body: '', headers: {} }) });
  const head = 'a'.repeat(40);
  const data = assertSuccess(await h.call('merge_pull_request', {
    owner: 'o', repo: 'r', index: 9, style: 'squash', title: 'T', message: 'M', delete_branch_after_merge: true, head_commit_id: head,
  }));
  assert.deepEqual(data, { merged: true, index: 9, style: 'squash' });
  assert.equal(h.confirms[0].danger, true);
  assert.match(h.confirms[0].body, /squash/);
  const req = h.requests[0];
  assert.equal(urlOf(req).pathname, '/api/v1/repos/o/r/pulls/9/merge');
  assert.deepEqual(JSON.parse(req.body), {
    Do: 'squash', MergeTitleField: 'T', MergeMessageField: 'M', delete_branch_after_merge: true, head_commit_id: head,
  });
});

test('issue state and label writes use the documented methods and paths', async () => {
  const h = createHarness({ respond: (req) => (req.method === 'PATCH' ? json(rawIssue(3, { state: 'closed' }), 201) : json([{ id: 1, name: 'bug' }])) });
  const closed = assertSuccess(await h.call('set_issue_state', { owner: 'o', repo: 'r', index: 3, state: 'closed' }));
  assert.equal(closed.issue.state, 'closed');
  assert.equal(h.requests[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(h.requests[0].body), { state: 'closed' });
  assert.match(h.confirms[0].body, /^Close #3/);

  assertSuccess(await h.call('edit_issue_labels', { owner: 'o', repo: 'r', index: 3, action: 'replace', labels: ['bug', 4] }));
  assert.equal(h.requests[1].method, 'PUT');
  assert.equal(urlOf(h.requests[1]).pathname, '/api/v1/repos/o/r/issues/3/labels');
  assert.deepEqual(JSON.parse(h.requests[1].body), { labels: ['bug', 4] });

  assertSuccess(await h.call('edit_issue_labels', { owner: 'o', repo: 'r', index: 3, action: 'remove', label_id: 7 }));
  assert.equal(h.requests[2].method, 'DELETE');
  assert.equal(urlOf(h.requests[2]).pathname, '/api/v1/repos/o/r/issues/3/labels/7');
  assert.equal(h.requests[2].body, undefined);
});

test('writes are never retried: 5xx, timeouts and thrown errors report an unknown outcome', async () => {
  const scenarios = [
    ['HTTP 500', () => ({ ok: true, status: 500, body: '{"message":"internal"}', headers: {} })],
    ['HTTP 502', () => ({ ok: true, status: 502, body: '', headers: {} })],
    ['timeout', () => ({ ok: false, message: 'request timed out' })],
    ['thrown', () => { throw new Error('connection reset'); }],
  ];
  for (const [label, respond] of scenarios) {
    const h = createHarness({ respond });
    const message = assertFailure(await h.call('create_release', { owner: 'o', repo: 'r', tag_name: 'v1.0.0' }), 'OUTCOME_UNKNOWN');
    assert.match(message, /may or may not/, label);
    assert.match(message, /Check the current state before retrying/, label);
    assert.equal(h.requests.length, 1, `${label}: exactly one attempt`);
  }
});

test('write rejections (4xx) say nothing was executed and pass Gitea\'s message', async () => {
  for (const [status, code] of [[401, 'AUTH_FAILED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [405, 'NOT_ALLOWED'], [409, 'CONFLICT'], [422, 'VALIDATION_FAILED'], [429, 'RATE_LIMITED']]) {
    const h = createHarness({ respond: () => ({ ok: true, status, body: JSON.stringify({ message: 'head branch does not exist' }), headers: {} }) });
    const message = assertFailure(await h.call('create_pull_request', { owner: 'o', repo: 'r', head: 'feat', base: 'main', title: 'T' }), code);
    assert.match(message, /^Not executed/);
    if (status === 403) assert.match(message, /"write:repository" scope/);
    if (status === 409 || status === 422 || status === 405) assert.match(message, /head branch does not exist/);
    assert.equal(h.requests.length, 1);
  }
});

/* ── settings connection test channel ──────────────────────────────── */

test('the settings connection test reports the login and caches it per connection', async () => {
  const h = createHarness({ respond: () => json({ login: 'alice', avatar_url: 'x' }) });
  h.channel.onmessage({ data: { type: 'test-connection', reqId: 'r1', connectionId: 'conn-1' } });
  h.channel.onmessage({ data: { type: 'test-connection', reqId: 'r1', connectionId: 'conn-1' } });
  await flush();
  assert.equal(h.requests.length, 1, 'repeated broadcasts of one reqId run once');
  assert.equal(h.requests[0].url, `https://${HOST}/api/v1/user`);
  assert.deepEqual(h.channel.posted, [{ type: 'test-connection-result', reqId: 'r1', ok: true, username: 'alice', host: HOST }]);
  assert.deepEqual(h.kvWrites.at(-1), { connectedUsers: { 'conn-1': 'alice' } });

  const failing = createHarness({ respond: () => ({ ok: true, status: 401, body: '', headers: {} }) });
  failing.channel.onmessage({ data: { type: 'test-connection', reqId: 'r2', connectionId: 'conn-1' } });
  await flush();
  assert.equal(failing.channel.posted[0].ok, false);
  assert.match(failing.channel.posted[0].message, /HTTP 401/);
});

/* ── settings page ─────────────────────────────────────────────────── */

function createSettingsHarness(locale = 'ja') {
  const elements = new Map();
  const fetchCalls = [];
  function control() {
    const listeners = new Map();
    return {
      value: '', textContent: '', placeholder: '', disabled: false, type: 'password', className: '',
      classList: { toggle() {}, remove() {} },
      appendChild() {},
      focus() {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      emit(type, ev = {}) { return listeners.get(type)?.({ preventDefault() {}, ...ev }); },
    };
  }
  const document = {
    documentElement: { lang: '' },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, control());
      return elements.get(id);
    },
    createElement: control,
  };
  const fetch = async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url === '/app-context') return { json: async () => ({ ok: true, context: { locale } }) };
    if (url === '/connections') return { json: async () => [{ key: 'gitea_conn', connections: [] }] };
    if (url === '/kv') return { json: async () => ({}) };
    if (url === '/connections/gitea_conn') return { status: 200, json: async () => ({ ok: false, error: 'CONFIRM_DENIED' }) };
    throw new Error(`unexpected settings fetch ${url}`);
  };
  vm.runInNewContext(settingsSource, {
    document,
    fetch,
    BroadcastChannel: class { postMessage() {} addEventListener() {} removeEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    Date,
  });
  return { el: (id) => document.getElementById(id), document, fetchCalls };
}

test('settings read the locale only from /app-context and fall back to English', async () => {
  const s = createSettingsHarness('ja');
  await flush();
  assert.equal(s.fetchCalls[0].url, '/app-context');
  assert.equal(s.document.documentElement.lang, 'en');
  assert.equal(s.el('add').textContent, 'Add');
  assert.equal(s.el('list').textContent, '');
});

test('settings reject http, custom ports and sub-paths before contacting the host', async () => {
  const s = createSettingsHarness('en');
  await flush();
  for (const [host, pattern] of [
    ['http://git.example.test', /Only https/],
    ['git.example.test:3000', /port 443/],
    ['https://git.example.test/gitea', /sub-path/],
  ]) {
    s.el('host').value = host;
    s.el('token').value = 'placeholder-token';
    s.el('add').emit('click');
    await flush();
    assert.match(s.el('status').textContent, pattern);
  }
  assert.equal(s.fetchCalls.some((c) => c.method === 'POST'), false);

  s.el('host').value = 'https://Git.Example.test:443/';
  s.el('add').emit('click');
  await flush();
  const post = s.fetchCalls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/connections/gitea_conn');
  assert.deepEqual(JSON.parse(post.body), { host: 'git.example.test', token: 'placeholder-token' });
  assert.match(s.el('status').textContent, /Cancelled/);
});
