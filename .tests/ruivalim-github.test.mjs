import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import { createContext, Script } from 'node:vm';

const pluginDir = new URL('../ruivalim-github/', import.meta.url);
const githubSource = readFileSync(new URL('main.js', pluginDir), 'utf8');
const settingsSource = readFileSync(new URL('settings.js', pluginDir), 'utf8');
const settingsHtml = readFileSync(new URL('settings.html', pluginDir), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('ghost.json', pluginDir), 'utf8'));

function jsonResponse(data, status = 200) {
  return { ok: true, status, body: JSON.stringify(data), headers: {} };
}

function loadMain(respond) {
  let channel;
  let channelName;
  let handler;
  const posted = [];
  const sent = [];
  class FakeBroadcastChannel {
    constructor(name) { channel = this; channelName = name; }
    postMessage(message) { posted.push(message); }
  }
  const cindy = {
    onHostMessage(next) { handler = next; },
    send(message) { sent.push(message); },
    fetch: async (request) => respond(request),
  };
  new Script(githubSource, { filename: 'ruivalim-github/main.js' }).runInContext(
    createContext({
      cindy,
      BroadcastChannel: FakeBroadcastChannel,
      fetch: async (url) => { throw new Error(`unexpected fetch: ${url}`); },
      setTimeout,
      clearTimeout,
      URL,
      encodeURIComponent,
    }),
  );
  return { channel: () => channel, channelName: () => channelName, handler: () => handler, posted, sent };
}

async function testConnection() {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const harness = loadMain((request) => {
    assert.equal(request.url, 'https://api.github.com/user');
    return jsonResponse({ login: 'octocat' });
  });
  const channel = harness.channel();
  const original = channel.postMessage.bind(channel);
  channel.postMessage = (message) => {
    original(message);
    if (message?.type === 'test-connection-result') resolveResult(message);
  };
  await channel.onmessage({ data: { type: 'test-connection', reqId: 'req-1' } });
  const message = await result;
  assert.equal(message.ok, true);
  assert.equal(harness.channelName(), 'ruivalim-github');
}

test('manifest uses the ruivalim- id and pins pasted-token injection to the GitHub API', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.minCindyVersion, '0.1.64');
  assert.equal(manifest.id, 'ruivalim-github');
  assert.equal(manifest.command, 'ruivalim-github');
  assert.equal(manifest.author, 'Rui Valim');
  assert.equal(manifest.name, 'GitHub (Rui)');
  assert.equal('slots' in manifest, false);
  assert.equal(manifest.notify, true);
  assert.equal(manifest.fs, true);
  assert.deepEqual(manifest.network.hosts, [
    'api.github.com',
    'objects.githubusercontent.com',
    '*.blob.core.windows.net',
  ]);
  assert.equal(manifest.network.secrets.length, 1);
  const auth = manifest.network?.secrets?.find((secret) => secret.key === 'github_pat');
  assert.equal(manifest.version, '1.0.0');
  // gh-cli is reserved for the official cindy-github id; this copy must use the
  // default user-pasted source (omitted) and inject only into api.github.com.
  assert.equal('source' in auth, false);
  assert.deepEqual(auth, {
    key: 'github_pat',
    label: 'GitHub personal access token',
    hint: 'Paste a personal access token (ghp_... or github_pat_...). It is only injected into requests to api.github.com.',
    url: 'https://github.com/settings/tokens',
    inject: {
      header: 'Authorization',
      format: 'Bearer {value}',
      hosts: ['api.github.com'],
    },
  });
});

test('every locale names the copy GitHub (Rui)', () => {
  for (const [locale, file] of Object.entries(manifest.locales)) {
    const data = JSON.parse(readFileSync(new URL(file, pluginDir), 'utf8'));
    assert.equal(data.name, 'GitHub (Rui)', locale);
  }
});

test('no Chinese or full-width punctuation remains outside the zh-CN/ja/ko locale files', () => {
  const skip = new Set(['locales/zh-CN.json', 'locales/ja.json', 'locales/ko.json']);
  const walk = (dir, prefix = '') => readdirSync(dir).flatMap((name) => {
    const rel = prefix + name;
    const full = new URL(name, dir);
    if (statSync(full).isDirectory()) return walk(new URL(`${name}/`, dir), `${rel}/`);
    return [rel];
  });
  for (const rel of walk(pluginDir)) {
    if (skip.has(rel) || !/\.(js|json|html)$/.test(rel)) continue;
    const text = readFileSync(new URL(rel, pluginDir), 'utf8');
    const match = text.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef\u2014\u2013]/);
    assert.equal(match, null, `${rel} still contains ${match?.[0]}`);
  }
});

test('connection tests never cache an identity that the plugin cannot attribute atomically', async () => {
  await testConnection();
  assert.doesNotMatch(githubSource, /connectedLogin|connectedSource/);
});

test('401 points the user at the pasted token in this plugin\'s settings', async () => {
  const harness = loadMain(() => ({ ok: true, status: 401, body: '{"message":"Bad credentials"}' }));
  await harness.handler()({ type: 'tool-call', tool: 'call_tool', callId: 'c1', args: { name: 'get_current_user', args: {} } });
  const result = harness.sent.findLast((m) => m.type === 'tool-result');
  assert.equal(result.ok, false);
  assert.match(result.message, /GitHub \(Rui\)/);
  assert.match(result.message, /personal access token/);
  assert.match(result.message, /\nParameters for this operation: no parameters$/);
});

test('ensure_labels still treats a concurrent 422 as success (error text keeps the status code)', async () => {
  const harness = loadMain((request) => {
    if (request.url.endsWith('/labels?per_page=100')) return jsonResponse([]);
    if (request.url.endsWith('/labels') && request.method === 'POST') {
      return { ok: true, status: 422, body: '{"message":"already_exists"}' };
    }
    throw new Error(`unexpected request ${request.url}`);
  });
  await harness.handler()({ type: 'tool-call', tool: 'call_tool', callId: 'c2',
    args: { name: 'ensure_labels', args: { owner: 'acme', repo: 'demo', names: ['bug'] } } });
  const result = harness.sent.findLast((m) => m.type === 'tool-result');
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.result.data)), { ensured: ['bug'], created: [] });
});

test('settings manage only the pasted token and never claim a host GitHub login', () => {
  assert.match(settingsHtml, /<html lang="en">/);
  assert.match(settingsHtml, /cannot use your computer's GitHub CLI login/);
  assert.doesNotMatch(settingsSource, /hostSource|hostAvailable|hostManagedSetup|renderHostAccount/);
  assert.doesNotMatch(settingsSource, /connectedLogin|connectedSource|fetch\(['"]\/kv/);
  assert.doesNotMatch(settingsSource, /else void test\(\)/);
  assert.match(settingsSource, /Checking the GitHub connection/);
  assert.match(settingsSource, /new BroadcastChannel\('ruivalim-github'\)/);
  assert.doesNotMatch(settingsSource, /gh auth token/);
});

for (const [saved, tail] of [[true, 'abcd'], [false, '']]) {
  test(`settings reflect token storage state: saved=${saved}`, async () => {
    const elements = new Map();
    const element = () => ({ value: '', textContent: '', placeholder: '', hidden: false, disabled: false,
      children: [], classList: { toggle() {}, remove() {} },
      appendChild(child) { this.children.push(child); }, addEventListener() {} });
    const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element };
    new Script(settingsSource).runInContext(createContext({
      document, BroadcastChannel: class {}, setTimeout: () => 0, clearTimeout() {},
      // Even if a host ever returned gh-cli fields for this id, the page must ignore them.
      fetch: async () => ({ json: async () => [{ key: 'github_pat', saved, ...(tail ? { tail } : {}),
        hostSource: 'gh-cli', hostAvailable: true, hostManagedSetup: true }] }),
    }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(elements.get('test').disabled, !saved);
    assert.equal(elements.get('clear').disabled, !saved);
    assert.equal(elements.get('test').hidden, false);
    assert.equal(elements.get('save').textContent, saved ? 'Replace' : 'Save');
    const account = elements.get('token-account');
    assert.equal(account.children.length, saved ? 1 : 0);
    if (saved) assert.equal(account.children[0].children[1].textContent, 'ends in abcd');
  });
}
