import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { validateGhostManifest } from './contracts/plugin-manifest.bcdea7e27f97.mjs';

const root = path.resolve(import.meta.dirname, '..');
const pluginDir = path.join(root, 'ntfy');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'ghost.json'), 'utf8'));
const source = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(pluginDir, 'settings.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(pluginDir, 'settings.html'), 'utf8');
const localeNames = ['en', 'zh-CN', 'ja', 'ko'];
const locales = Object.fromEntries(localeNames.map((locale) => [
  locale,
  JSON.parse(fs.readFileSync(path.join(pluginDir, 'locales', `${locale}.json`), 'utf8')),
]));

// Fixture credential: only the simulated host knows it, exactly like the real host.
const TOKEN = 'tk_0123456789abcdefghijklmnopqrs';
const SERVER_A = { id: 'conn-a', host: 'ntfy.example.test', label: 'ntfy.example.test', isDefault: true, tail: 'pqrs' };
const SERVER_B = { id: 'conn-b', host: 'push.example.test', label: 'push.example.test', isDefault: false, tail: 'wxyz' };

const plain = (value) => JSON.parse(JSON.stringify(value));

async function flushAsync(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function published(extra = {}) {
  return {
    ok: true,
    status: 200,
    body: JSON.stringify({
      id: 'msg123',
      time: 1761570000,
      expires: 1761613200,
      event: 'message',
      topic: 'alerts',
      message: 'ok',
      ...extra,
    }),
  };
}

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(TOKEN), false, 'a tool result leaked the access token');
  assert.equal(text.includes(TOKEN.slice(3)), false, 'a tool result leaked part of the access token');
}

function hasAuthorizationHeader(headers) {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'authorization');
}

function createHarness(options = {}) {
  const connections = options.connections ?? [SERVER_A];
  const kv = options.kv ?? { defaultTopics: { 'conn-a': 'alerts' } };
  const networkCalls = [];
  const sentHeaders = [];
  const toolResults = [];
  const dataPlane = [];
  let handler = null;

  const cindy = {
    onHostMessage(fn) {
      handler = fn;
    },
    async fetch(request) {
      networkCalls.push(request);
      // Simulate the host: inject the connection token for the matching host only.
      const headers = { ...(request.headers ?? {}) };
      if (connections.some((connection) => request.url.startsWith(`https://${connection.host}/`))) {
        headers.Authorization = `Bearer ${TOKEN}`;
      }
      sentHeaders.push(headers);
      if (!options.respond) throw new Error('unexpected network request');
      return options.respond(request, headers);
    },
    async send(message) {
      if (message.type === 'tool-result') {
        toolResults.push(message);
        return { ok: true };
      }
      throw new Error(`unexpected cindy.send type ${message.type}`);
    },
  };

  const fetchMock = async (url, init) => {
    dataPlane.push({ url, init });
    if (url === '/connections') {
      if (options.connectionsFail) throw new Error('data plane unavailable');
      return {
        ok: true,
        status: 200,
        async json() {
          return [{ key: 'ntfy_conn', label: 'ntfy server', maxConnections: 8, connections }];
        },
      };
    }
    if (url === '/kv') {
      if (options.kvFail) throw new Error('kv unavailable');
      return {
        ok: true,
        status: 200,
        async json() {
          return kv;
        },
      };
    }
    throw new Error(`unexpected data plane request ${url}`);
  };

  vm.runInNewContext(source, { cindy, fetch: fetchMock, URL });
  assert.equal(typeof handler, 'function');

  return {
    networkCalls,
    sentHeaders,
    toolResults,
    dataPlane,
    async call(tool, args) {
      const before = toolResults.length;
      await handler({ type: 'tool-call', tool, callId: 'call-1', args });
      assert.equal(toolResults.length, before + 1, 'exactly one tool-result per tool call');
      const result = toolResults.at(-1);
      assert.equal(result.type, 'tool-result');
      assert.equal(result.callId, 'call-1');
      assertNoSecret(result);
      return plain(result);
    },
    send(args) {
      return this.call('ntfy_send', args);
    },
  };
}

/* ── Manifest, locales and package files ─────────────────────────────── */

test('manifest is a v3 package using host-managed connections only', () => {
  const validated = validateGhostManifest(manifest);
  assert.ok(validated.ok, validated.reason);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(Object.hasOwn(manifest, 'slots'), false);
  assert.equal(manifest.id, 'ntfy');
  assert.equal(manifest.command, 'ntfy');
  assert.equal(manifest.name, 'ntfy');
  assert.equal(manifest.minCindyVersion, '0.1.64');
  assert.equal(manifest.author, 'Rui Valim');
  assert.equal(manifest.settingsHtml, 'settings.html');
  assert.equal(manifest.network.hosts, undefined, 'no static host: servers come from connections');
  assert.deepEqual(manifest.network.connections.map((c) => c.key), ['ntfy_conn']);
  assert.deepEqual(manifest.network.connections[0].inject, { header: 'Authorization', format: 'Bearer {value}' });
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ['ntfy_send', 'ntfy_servers']);
  const send = manifest.tools[0].parameters;
  assert.deepEqual(send.required, ['message']);
  assert.deepEqual(send.properties.priority.enum, ['1', '2', '3', '4', '5', 'min', 'low', 'default', 'high', 'urgent']);
  assert.equal(send.properties.tags.type, 'array');
  assert.equal(send.properties.markdown.type, 'boolean');
  for (const tool of manifest.tools) assert.match(tool.name, /^[a-z][a-z0-9_]*$/);
});

test('four locales fully cover the catalog with real translations', () => {
  const expectedTools = manifest.tools.map((tool) => tool.name).sort();
  for (const locale of localeNames) {
    const resource = locales[locale];
    for (const key of ['name', 'description', 'whenToUse']) {
      assert.equal(typeof resource[key], 'string', `${locale}.${key}`);
      assert.ok(resource[key].trim(), `${locale}.${key}`);
    }
    assert.deepEqual(Object.keys(resource.tools).sort(), expectedTools, `${locale} tool keys`);
    for (const name of expectedTools) assert.ok(resource.tools[name].description.trim(), `${locale}.${name}`);
    assert.ok(resource.network.connections.ntfy_conn.label.trim(), `${locale} connection label`);
    assert.match(resource.tools.ntfy_send.description, /4096/, `${locale} keeps the size limit`);
  }
  assert.equal(locales.en.description, manifest.description);
  assert.equal(locales.en.whenToUse, manifest.whenToUse);
  for (const locale of ['zh-CN', 'ja', 'ko']) {
    assert.notEqual(locales[locale].description, locales.en.description, `${locale} must be translated`);
    assert.notEqual(locales[locale].tools.ntfy_send.description, locales.en.tools.ntfy_send.description, `${locale} must be translated`);
  }
});

test('package files exist, the icon is a PNG and no text uses en or em dashes', () => {
  const icon = fs.readFileSync(path.join(pluginDir, manifest.icon));
  assert.deepEqual([...icon.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const textFiles = ['ghost.json', 'main.js', 'settings.html', 'settings.js', ...localeNames.map((l) => `locales/${l}.json`)];
  for (const file of textFiles) {
    const text = fs.readFileSync(path.join(pluginDir, file), 'utf8');
    assert.doesNotMatch(text, /[\u2013\u2014]/, `${file} contains an en or em dash`);
  }
});

test('settings page reads the language only from /app-context and loads its script externally', () => {
  assert.match(settingsSource, /fetch\('\/app-context'/);
  assert.doesNotMatch(settingsSource, /navigator\./);
  assert.doesNotMatch(settingsHtml, /navigator\./);
  assert.match(settingsHtml, /<script src="\/settings\.js"><\/script>/);
  assert.doesNotMatch(settingsHtml, /<script>(?!<\/script>)/, 'no inline script');
  assert.doesNotMatch(source, /navigator\./);
});

/* ── ntfy_send: happy path ───────────────────────────────────────────── */

test('happy path publishes a JSON body to the server root and keeps UTF-8 titles intact', async () => {
  const harness = createHarness({ respond: () => published() });
  const result = await harness.send({
    message: 'Backup finished without errors',
    title: 'Backup: início às 03:00',
    priority: 'high',
    tags: ['white_check_mark', ' backup '],
    click: 'https://example.test/report',
    markdown: true,
  });

  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.result, {
    sent: true,
    server: 'ntfy.example.test',
    topic: 'alerts',
    id: 'msg123',
    time: 1761570000,
    expires: 1761613200,
  });

  assert.equal(harness.networkCalls.length, 1);
  const request = harness.networkCalls[0];
  assert.equal(request.url, 'https://ntfy.example.test/');
  assert.equal(request.method, 'POST');
  assert.equal(request.callId, 'call-1');
  assert.equal(request.as, 'text');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(hasAuthorizationHeader(request.headers), false, 'the plugin must not set credentials itself');
  assert.equal(harness.sentHeaders[0].Authorization, `Bearer ${TOKEN}`, 'the simulated host injects the token');
  for (const name of Object.keys(request.headers)) {
    assert.doesNotMatch(name, /^x-/i, 'metadata travels in the JSON body, never in X- headers');
  }

  assert.equal(typeof request.body, 'string');
  assert.ok(request.body.includes('início às 03:00'), 'title stays raw UTF-8 in the body');
  assert.deepEqual(JSON.parse(request.body), {
    topic: 'alerts',
    message: 'Backup finished without errors',
    title: 'Backup: início às 03:00',
    priority: 4,
    tags: ['white_check_mark', 'backup'],
    click: 'https://example.test/report',
    markdown: true,
  });
});

test('a minimal send carries only topic and message', async () => {
  const harness = createHarness({ respond: () => published() });
  const result = await harness.send({ message: 'hello' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(harness.networkCalls[0].body), { topic: 'alerts', message: 'hello' });
});

test('markdown false and empty optional fields are left out of the body', async () => {
  const harness = createHarness({ respond: () => published() });
  const result = await harness.send({ message: 'hello', markdown: false, title: '  ', tags: [], click: '', priority: '' });
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(harness.networkCalls[0].body), { topic: 'alerts', message: 'hello' });
});

test('explicit topic overrides the default topic', async () => {
  const harness = createHarness({ respond: () => published() });
  const result = await harness.send({ message: 'hello', topic: 'deploy-prod_2' });
  assert.equal(result.ok, true);
  assert.equal(result.result.topic, 'deploy-prod_2');
  assert.equal(JSON.parse(harness.networkCalls[0].body).topic, 'deploy-prod_2');
});

test('priority accepts 1-5 and ntfy names, sent as integers', async () => {
  const cases = [
    [1, 1], [5, 5], ['1', 1], ['3', 3], [' 4 ', 4],
    ['min', 1], ['low', 2], ['default', 3], ['high', 4], ['urgent', 5], ['URGENT', 5],
  ];
  for (const [input, expected] of cases) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message: 'hello', priority: input });
    assert.equal(result.ok, true, `priority ${JSON.stringify(input)}`);
    assert.equal(JSON.parse(harness.networkCalls[0].body).priority, expected, `priority ${JSON.stringify(input)}`);
  }
});

test('a 2xx without a message id still reports the notification as sent', async () => {
  const harness = createHarness({ respond: () => ({ ok: true, status: 200, body: 'not json' }) });
  const result = await harness.send({ message: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(result.result.sent, true);
  assert.equal(result.result.id, null);
  assert.match(result.result.note, /did not return a message id/);
});

/* ── ntfy_send: argument validation (nothing reaches the network) ────── */

test('empty or missing message is rejected before any network or settings access', async () => {
  for (const args of [{}, { message: '' }, { message: '   \n ' }, { message: 42 }, { message: null }]) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send(args);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.errorCode, 'INVALID_ARGUMENT');
    assert.match(result.message, /message is required/);
    assert.equal(harness.networkCalls.length, 0);
    assert.equal(harness.dataPlane.length, 0);
  }
});

test('null or non-object args are treated as an empty call', async () => {
  for (const args of [null, undefined, 'hello', ['hello']]) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send(args);
    assert.equal(result.errorCode, 'INVALID_ARGUMENT');
    assert.equal(harness.networkCalls.length, 0);
  }
});

test('messages are limited to 4096 UTF-8 bytes, counted in bytes and never truncated', async () => {
  // Each of these is exactly 4096 bytes.
  const accepted = ['a'.repeat(4096), 'é'.repeat(2048), '😀'.repeat(1024), `${'a'.repeat(4094)}é`];
  for (const message of accepted) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message });
    assert.equal(result.ok, true, `${message.length} chars should fit`);
    assert.equal(JSON.parse(harness.networkCalls[0].body).message, message, 'message is sent unchanged');
  }

  const rejected = [
    ['a'.repeat(4097), 4097],
    ['é'.repeat(2049), 4098],
    ['😀'.repeat(1025), 4100],
    [`${'a'.repeat(4095)}é`, 4097],
  ];
  for (const [message, bytes] of rejected) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'MESSAGE_TOO_LARGE');
    assert.match(result.message, new RegExp(`${bytes} bytes`));
    assert.match(result.message, /nothing was sent/);
    assert.equal(harness.networkCalls.length, 0);
  }
});

test('invalid topics are rejected with the ntfy topic rule', async () => {
  for (const topic of ['has space', 'a'.repeat(65), 'ação', 'x/y', 'topic.name', 42, true]) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message: 'hello', topic });
    assert.equal(result.ok, false, JSON.stringify(topic));
    assert.equal(result.errorCode, 'INVALID_TOPIC');
    assert.match(result.message, /letters, digits, - and _/);
    assert.equal(harness.networkCalls.length, 0);
  }
  const longest = createHarness({ respond: () => published() });
  assert.equal((await longest.send({ message: 'hello', topic: 'a'.repeat(64) })).ok, true);
});

test('invalid priorities are rejected', async () => {
  for (const priority of [0, 6, 2.5, -1, 'max', 'highest', 'p1', true, ['high']]) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message: 'hello', priority });
    assert.equal(result.ok, false, JSON.stringify(priority));
    assert.equal(result.errorCode, 'INVALID_PRIORITY');
    assert.match(result.message, /1-5 or one of min, low, default, high, urgent/);
    assert.equal(harness.networkCalls.length, 0);
  }
});

test('click must be an absolute https URL', async () => {
  for (const click of ['http://example.test/x', 'javascript:alert(1)', 'example.test/x', 'https://', 'ftp://example.test', 'https://exa mple.test', 7]) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message: 'hello', click });
    assert.equal(result.ok, false, JSON.stringify(click));
    assert.equal(result.errorCode, 'INVALID_CLICK_URL');
    assert.equal(harness.networkCalls.length, 0);
  }
});

test('malformed tags, title and markdown are rejected', async () => {
  const cases = [
    { tags: 'warning' },
    { tags: ['ok', ''] },
    { tags: ['ok', 3] },
    { title: 12 },
    { markdown: 'yes' },
    { server: 3 },
  ];
  for (const extra of cases) {
    const harness = createHarness({ respond: () => published() });
    const result = await harness.send({ message: 'hello', ...extra });
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(result.errorCode, 'INVALID_ARGUMENT');
    assert.equal(harness.networkCalls.length, 0);
  }
});

/* ── ntfy_send: server and topic resolution ──────────────────────────── */

test('no configured server explains how to add one', async () => {
  const harness = createHarness({ connections: [], respond: () => published() });
  const result = await harness.send({ message: 'hello', topic: 'alerts' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NOT_CONFIGURED');
  assert.match(result.message, /plugin settings/);
  assert.equal(harness.networkCalls.length, 0);
});

test('unreadable connection list fails without sending', async () => {
  const harness = createHarness({ connectionsFail: true, respond: () => published() });
  const result = await harness.send({ message: 'hello', topic: 'alerts' });
  assert.equal(result.errorCode, 'SETTINGS_UNAVAILABLE');
  assert.equal(harness.networkCalls.length, 0);
});

test('several servers require an explicit choice', async () => {
  const connections = [SERVER_A, SERVER_B];
  const kv = { defaultTopics: { 'conn-a': 'alerts', 'conn-b': 'home' } };

  const ambiguous = createHarness({ connections, kv, respond: () => published() });
  const result = await ambiguous.send({ message: 'hello' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'AMBIGUOUS_SERVER');
  assert.match(result.message, /ntfy\.example\.test/);
  assert.match(result.message, /push\.example\.test/);
  assert.equal(ambiguous.networkCalls.length, 0, 'isDefault on a connection is not a silent pick');

  for (const server of ['push.example.test', 'conn-b', 'https://PUSH.example.test/']) {
    const harness = createHarness({ connections, kv, respond: () => published() });
    const sent = await harness.send({ message: 'hello', server });
    assert.equal(sent.ok, true, server);
    assert.equal(harness.networkCalls[0].url, 'https://push.example.test/');
    assert.equal(JSON.parse(harness.networkCalls[0].body).topic, 'home', 'uses that server default topic');
  }

  const unknown = createHarness({ connections, kv, respond: () => published() });
  const missing = await unknown.send({ message: 'hello', server: 'other.example.test' });
  assert.equal(missing.errorCode, 'SERVER_NOT_FOUND');
  assert.match(missing.message, /ntfy\.example\.test, push\.example\.test/);
  assert.equal(unknown.networkCalls.length, 0);
});

test('missing topic without a default topic is reported, and KV failure only loses defaults', async () => {
  const noDefault = createHarness({ kv: {}, respond: () => published() });
  const result = await noDefault.send({ message: 'hello' });
  assert.equal(result.errorCode, 'NO_TOPIC');
  assert.match(result.message, /default topic/);
  assert.equal(noDefault.networkCalls.length, 0);

  const invalidDefault = createHarness({ kv: { defaultTopics: { 'conn-a': 'bad topic' } }, respond: () => published() });
  assert.equal((await invalidDefault.send({ message: 'hello' })).errorCode, 'NO_TOPIC');

  const kvDown = createHarness({ kvFail: true, respond: () => published() });
  assert.equal((await kvDown.send({ message: 'hello' })).errorCode, 'NO_TOPIC');
  const kvDownExplicit = createHarness({ kvFail: true, respond: () => published() });
  assert.equal((await kvDownExplicit.send({ message: 'hello', topic: 'alerts' })).ok, true);
});

/* ── ntfy_send: HTTP and transport failures ──────────────────────────── */

test('401 and 403 say the token is invalid or lacks write access, and nothing was sent', async () => {
  const unauthorized = createHarness({
    respond: () => ({ ok: true, status: 401, body: '{"code":40101,"http":401,"error":"unauthorized"}' }),
  });
  const r401 = await unauthorized.send({ message: 'hello' });
  assert.equal(r401.errorCode, 'NTFY_UNAUTHORIZED');
  assert.match(r401.message, /^Not sent/);
  assert.match(r401.message, /token/);

  const forbidden = createHarness({
    respond: () => ({ ok: true, status: 403, body: '{"code":40301,"http":403,"error":"forbidden"}' }),
  });
  const r403 = await forbidden.send({ message: 'hello' });
  assert.equal(r403.errorCode, 'NTFY_FORBIDDEN');
  assert.match(r403.message, /^Not sent/);
  assert.match(r403.message, /no write permission on topic "alerts"/);
  assert.match(r403.message, /forbidden/);
  assert.equal(forbidden.networkCalls.length, 1);
});

test('404, 413, 429 and other 4xx are definite rejections', async () => {
  const cases = [
    [404, 'NTFY_NOT_FOUND', /root of the domain/],
    [413, 'MESSAGE_TOO_LARGE', /too large/],
    [429, 'NTFY_RATE_LIMITED', /do not retry in a loop/],
    [400, 'NTFY_REJECTED', /invalid request: priority/],
  ];
  for (const [status, errorCode, pattern] of cases) {
    const harness = createHarness({
      respond: () => ({ ok: true, status, body: JSON.stringify({ code: status * 100, http: status, error: 'invalid request: priority' }) }),
    });
    const result = await harness.send({ message: 'hello' });
    assert.equal(result.ok, false, String(status));
    assert.equal(result.errorCode, errorCode);
    assert.match(result.message, /^Not sent/);
    assert.match(result.message, pattern);
    assert.equal(harness.networkCalls.length, 1, 'never retried');
  }
});

test('5xx is an unknown outcome and is never retried', async () => {
  for (const status of [500, 502, 503, 504]) {
    const harness = createHarness({ respond: () => ({ ok: true, status, body: 'upstream error' }) });
    const result = await harness.send({ message: 'hello' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SEND_OUTCOME_UNKNOWN');
    assert.match(result.message, /^Outcome unknown/);
    assert.match(result.message, new RegExp(`HTTP ${status}`));
    assert.match(result.message, /may already have been delivered/);
    assert.match(result.message, /Do not resend automatically/);
    assert.equal(harness.networkCalls.length, 1, `HTTP ${status} must not be retried`);
  }
});

test('unexpected statuses are an unknown outcome', async () => {
  const harness = createHarness({ respond: () => ({ ok: true, status: 302, body: '' }) });
  const result = await harness.send({ message: 'hello' });
  assert.equal(result.errorCode, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(harness.networkCalls.length, 1);
});

test('timeouts, network errors and thrown fetches are unknown outcomes and never retried', async () => {
  const responders = [
    () => ({ ok: false, errorCode: 'TIMEOUT', message: 'Request timed out after 20000ms' }),
    () => ({ ok: false, errorCode: 'NETWORK_ERROR', message: 'ECONNRESET' }),
    () => ({ ok: false }),
    () => undefined,
    () => { throw new Error('socket hang up'); },
    () => Promise.reject(new Error('aborted')),
  ];
  for (const respond of responders) {
    const harness = createHarness({ respond });
    const result = await harness.send({ message: 'hello' });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'SEND_OUTCOME_UNKNOWN', String(respond));
    assert.match(result.message, /^Outcome unknown/);
    assert.match(result.message, /Do not resend automatically/);
    assert.equal(harness.networkCalls.length, 1, 'never retried');
  }
});

test('host rejections before dispatch say nothing was sent', async () => {
  const cases = [
    { ok: false, errorCode: 'PERMISSION_DENIED', message: 'The user denied the network request' },
    { ok: false, errorCode: 'HOST_ERROR', message: 'host ntfy.example.test is not allowed' },
  ];
  for (const response of cases) {
    const harness = createHarness({ respond: () => response });
    const result = await harness.send({ message: 'hello' });
    assert.equal(result.errorCode, 'SEND_NOT_DISPATCHED');
    assert.match(result.message, /^Not sent/);
    assert.equal(harness.networkCalls.length, 1);
  }
});

test('the access token never appears in results, even when echoed back', async () => {
  const echoes = [
    () => ({ ok: true, status: 400, body: JSON.stringify({ error: `bad header Authorization: Bearer ${TOKEN}` }) }),
    () => ({ ok: true, status: 401, body: `token ${TOKEN} rejected` }),
    () => ({ ok: false, errorCode: 'NETWORK_ERROR', message: `failed with Bearer ${TOKEN}` }),
    () => { throw new Error(`proxy said ${TOKEN}`); },
  ];
  for (const respond of echoes) {
    const harness = createHarness({ respond });
    // createHarness.call asserts the token is absent from every tool result.
    const result = await harness.send({ message: 'hello' });
    assert.equal(result.ok, false);
    assert.equal(hasAuthorizationHeader(harness.networkCalls[0].headers), false);
  }
});

test('unknown tools get exactly one failure result', async () => {
  const harness = createHarness();
  const result = await harness.call('ntfy_delete', {});
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'UNKNOWN_TOOL');
});

/* ── ntfy_servers ────────────────────────────────────────────────────── */

test('ntfy_servers lists id, host, url and default topic, never token data', async () => {
  const harness = createHarness({
    connections: [SERVER_A, SERVER_B],
    kv: { defaultTopics: { 'conn-a': 'alerts', 'conn-b': 'bad topic' } },
  });
  const result = await harness.call('ntfy_servers', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, {
    count: 2,
    servers: [
      { id: 'conn-a', host: 'ntfy.example.test', url: 'https://ntfy.example.test', default_topic: 'alerts' },
      { id: 'conn-b', host: 'push.example.test', url: 'https://push.example.test', default_topic: null },
    ],
  });
  const text = JSON.stringify(result);
  assert.equal(text.includes('pqrs'), false, 'token tail is not exposed');
  assert.equal(text.includes('tail'), false);
  assert.equal(harness.networkCalls.length, 0);
});

test('ntfy_servers with nothing configured says how to add a server', async () => {
  const harness = createHarness({ connections: [] });
  const result = await harness.call('ntfy_servers', {});
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 0);
  assert.deepEqual(result.result.servers, []);
  assert.match(result.result.note, /plugin settings/);
});

/* ── Settings page behavior (DOM and data plane mocked) ──────────────── */

function createSettingsHarness(options = {}) {
  let connections = (options.connections ?? []).map((c) => ({ ...c }));
  let kv = options.kv ?? {};
  const fetchCalls = [];
  const posts = [];

  function element(tag = 'div') {
    const listeners = new Map();
    let text = '';
    return {
      tagName: tag.toUpperCase(),
      value: '',
      type: '',
      placeholder: '',
      title: '',
      className: '',
      disabled: false,
      attributes: {},
      children: [],
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = String(value);
        this.children = [];
      },
      classList: {
        names: new Set(),
        toggle(name, force) {
          const on = force === undefined ? !this.names.has(name) : Boolean(force);
          if (on) this.names.add(name);
          else this.names.delete(name);
          return on;
        },
        add(name) { this.names.add(name); },
        remove(name) { this.names.delete(name); },
        contains(name) { return this.names.has(name); },
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      focus() {},
      emit(type, event = {}) {
        const listener = listeners.get(type);
        assert.ok(listener, `missing ${type} listener`);
        return listener({ preventDefault() {}, ...event });
      },
    };
  }

  const ids = ['title', 'badge', 'hint', 'list', 'host', 'token', 'eye', 'topic', 'add', 'status'];
  const elements = new Map(ids.map((id) => [id, element(id === 'add' || id === 'eye' ? 'button' : 'div')]));
  const document = {
    documentElement: { lang: '' },
    getElementById(id) {
      return elements.get(id);
    },
    createElement(tag) {
      return element(tag);
    },
  };

  const json = (data, ok = true) => ({ ok, status: ok ? 200 : 500, async json() { return data; } });
  const fetchMock = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    const method = init.method ?? 'GET';
    if (url === '/app-context') return json(options.appContext ?? { ok: true, context: { region: 'global', locale: 'ja' } });
    if (url === '/connections' && method === 'GET') {
      return json([{ key: 'ntfy_conn', label: 'ntfy server', maxConnections: 8, connections }]);
    }
    if (url === '/connections/ntfy_conn' && method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      const result = options.addResult ?? { ok: true };
      if (result.ok && !connections.some((c) => c.host === body.host)) {
        connections.push({ id: `conn-${connections.length + 1}`, host: body.host, label: body.host, isDefault: false, tail: body.token.slice(-4) });
      }
      return json(result);
    }
    if (url.startsWith('/connections/ntfy_conn/') && method === 'DELETE') {
      const id = decodeURIComponent(url.slice('/connections/ntfy_conn/'.length));
      connections = connections.filter((c) => c.id !== id);
      return json({ ok: true });
    }
    if (url === '/kv' && method === 'GET') return json(kv);
    if (url === '/kv' && method === 'PUT') {
      if (options.kvWriteFails) return json({ ok: false }, false);
      kv = JSON.parse(init.body);
      return json({ ok: true });
    }
    throw new Error(`unexpected settings request ${method} ${url}`);
  };

  // No navigator in this context: reading it would throw.
  vm.runInNewContext(settingsSource, {
    document,
    fetch: fetchMock,
    setTimeout: () => 1,
    clearTimeout: () => {},
    encodeURIComponent,
  });

  return {
    document,
    el: (id) => elements.get(id),
    fetchCalls,
    posts,
    get kv() {
      return kv;
    },
    rows() {
      return elements.get('list').children.filter((child) => child.className === 'server');
    },
  };
}

test('settings page reads /app-context and falls back to English', async () => {
  const page = createSettingsHarness();
  await flushAsync();
  assert.equal(page.fetchCalls[0].url, '/app-context');
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.el('add').textContent, 'Add');
  assert.match(page.el('list').children[0].textContent, /No ntfy server added yet/);
});

test('settings page adds a server, sends the token only to the host and stores the default topic', async () => {
  const page = createSettingsHarness({ kv: { unrelated: 1 } });
  await flushAsync();
  page.el('host').value = '  https://NTFY.example.test/ ';
  page.el('token').value = ` ${TOKEN} `;
  page.el('topic').value = 'alerts';
  page.el('add').emit('click');
  await flushAsync();

  assert.deepEqual(plain(page.posts), [{ host: 'ntfy.example.test', token: TOKEN }]);
  assert.deepEqual(plain(page.kv), { unrelated: 1, defaultTopics: { 'conn-1': 'alerts' } });
  assert.equal(JSON.stringify(page.kv).includes(TOKEN), false, 'the token never lands in KV');
  assert.equal(page.el('token').value, '');
  assert.equal(page.el('host').value, '');
  assert.match(page.el('status').textContent, /Added ntfy\.example\.test/);
  assert.equal(page.rows().length, 1);
  assert.equal(page.rows()[0].children[1].value, 'alerts');
});

test('settings page accepts an explicit :443 and refuses http, ports, paths, bad topics and missing input', async () => {
  const ok443 = createSettingsHarness();
  await flushAsync();
  ok443.el('host').value = 'ntfy.example.test:443';
  ok443.el('token').value = TOKEN;
  ok443.el('add').emit('click');
  await flushAsync();
  assert.deepEqual(plain(ok443.posts), [{ host: 'ntfy.example.test', token: TOKEN }]);

  const cases = [
    [{ host: 'http://ntfy.example.test', token: TOKEN }, /Only https/],
    [{ host: 'ntfy.example.test:8080', token: TOKEN }, /Custom ports/],
    [{ host: 'https://example.test/ntfy', token: TOKEN }, /without a path/],
    [{ host: 'user@ntfy.example.test', token: TOKEN }, /valid server address/],
    [{ host: 'localhost', token: TOKEN }, /valid server address/],
    [{ host: '', token: TOKEN }, /Enter the server URL/],
    [{ host: 'ntfy.example.test', token: '  ' }, /Paste the access token/],
    [{ host: 'ntfy.example.test', token: TOKEN, topic: 'bad topic' }, /Topics may contain/],
  ];
  for (const [input, pattern] of cases) {
    const page = createSettingsHarness();
    await flushAsync();
    page.el('host').value = input.host;
    page.el('token').value = input.token;
    page.el('topic').value = input.topic ?? '';
    page.el('add').emit('click');
    await flushAsync();
    assert.equal(page.posts.length, 0, JSON.stringify(input));
    assert.match(page.el('status').textContent, pattern);
  }
});

test('settings page reports host errors from adding a connection', async () => {
  const page = createSettingsHarness({ addResult: { ok: false, error: 'CONFIRM_DENIED' } });
  await flushAsync();
  page.el('host').value = 'ntfy.example.test';
  page.el('token').value = TOKEN;
  page.el('topic').value = 'alerts';
  page.el('add').emit('click');
  await flushAsync();
  assert.equal(page.posts.length, 1);
  assert.match(page.el('status').textContent, /Cancelled/);
  assert.deepEqual(plain(page.kv), {}, 'no topic stored for a server that was not added');
  assert.equal(page.el('add').disabled, false);
});

test('settings page edits and clears the default topic, and removal drops it', async () => {
  const page = createSettingsHarness({
    connections: [SERVER_A],
    kv: { defaultTopics: { 'conn-a': 'alerts' }, unrelated: 1 },
  });
  await flushAsync();
  const [row] = page.rows();
  const [, topicInput, saveButton, removeButton] = row.children;
  assert.equal(topicInput.value, 'alerts');

  topicInput.value = 'not valid!';
  saveButton.emit('click');
  await flushAsync();
  assert.match(page.el('status').textContent, /Topics may contain/);
  assert.equal(page.kv.defaultTopics['conn-a'], 'alerts');

  topicInput.value = 'deploys';
  saveButton.emit('click');
  await flushAsync();
  assert.equal(page.kv.defaultTopics['conn-a'], 'deploys');

  removeButton.emit('click');
  await flushAsync();
  assert.ok(page.fetchCalls.some((call) => call.url === '/connections/ntfy_conn/conn-a' && call.init.method === 'DELETE'));
  assert.deepEqual(plain(page.kv), { defaultTopics: {}, unrelated: 1 });
  assert.equal(page.rows().length, 0);
});
