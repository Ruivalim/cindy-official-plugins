import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createContext, Script } from 'node:vm';

const pluginRoot = new URL('../ruivalim-icloud-mail/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('ghost.json', pluginRoot), 'utf8'));
const mainSource = readFileSync(new URL('main.js', pluginRoot), 'utf8');
const settingsSource = readFileSync(new URL('settings.js', pluginRoot), 'utf8');
const require = createRequire(import.meta.url);
const worker = require('../ruivalim-icloud-mail/src/worker.cjs');

class FakeBroadcastChannel {
  static instances = [];

  constructor(name) {
    this.name = name;
    this.messages = [];
    this.onmessage = null;
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }
}

function response(value, ok = true) {
  return {
    ok,
    async json() {
      return value;
    },
  };
}

function createMainHarness(nodeResponder, initial = {}) {
  FakeBroadcastChannel.instances.length = 0;
  const nodeRequests = [];
  const sent = [];
  const kv = {
    email: initial.email || 'user@icloud.com',
    credentialSlot: initial.credentialSlot || 'a',
  };
  const secretSaved = {
    a: initial.secretSaved !== false,
    b: initial.secretSavedB === true,
  };
  let hostHandler;
  let resolveToolResult;
  const fetchCalls = [];
  const cindy = {
    node: {
      async request(request) {
        nodeRequests.push(request);
        return nodeResponder(request);
      },
    },
    onHostMessage(handler) {
      hostHandler = handler;
    },
    async send(message) {
      sent.push(message);
      if (message.type === 'tool-result' && resolveToolResult) {
        const resolve = resolveToolResult;
        resolveToolResult = null;
        resolve(message);
      }
    },
  };
  async function fetch(path, options = {}) {
    fetchCalls.push({ path, options });
    if (path === '/kv') return response({ ...kv });
    if (path === '/secrets') {
      return response([
        { key: 'icloud_mail_app_password', saved: secretSaved.a },
        { key: 'icloud_mail_app_password_b', saved: secretSaved.b },
      ]);
    }
    return response(null, false);
  }
  new Script(mainSource, { filename: 'ruivalim-icloud-mail/main.js' }).runInContext(createContext({
    BroadcastChannel: FakeBroadcastChannel,
    Map,
    Number,
    Object,
    Promise,
    String,
    cindy,
    fetch,
    isFinite,
    setTimeout,
  }));
  return {
    channel: FakeBroadcastChannel.instances[0],
    fetchCalls,
    nodeRequests,
    sent,
    setSecretSaved(slot, value) {
      secretSaved[slot] = value;
    },
    async settings(action, payload, reqId = `settings-${action}`) {
      const channel = FakeBroadcastChannel.instances[0];
      channel.onmessage({ data: { type: 'settings-request', reqId, action, payload } });
      for (let index = 0; index < 20; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const result = channel.messages.find((message) => message.reqId === reqId);
        if (result) return result;
      }
      throw new Error('settings response timed out');
    },
    call(tool, args = {}) {
      return new Promise((resolve) => {
        resolveToolResult = resolve;
        hostHandler({ type: 'tool-call', tool, args, callId: `call-${tool}` });
      });
    },
  };
}

function createWorkerHarness(overrides = {}, parseMessage = async () => ({})) {
  const client = {
    async connect() {},
    async logout() {},
    async getMailboxLock() {
      return { release() {} };
    },
    ...overrides,
  };
  return {
    client,
    deps: {
      createImap() {
        return client;
      },
      createSmtp() {
        throw new Error('unexpected SMTP');
      },
      createComposer() {
        throw new Error('unexpected composer');
      },
      parseMessage,
    },
  };
}

test('manifest declares Cindy persistent credentials and their minimal Node injection scope', () => {
  assert.equal(manifest.id, 'ruivalim-icloud-mail');
  // Shape, not a pinned value: this test is about the secret bindings, and a
  // hardcoded version goes stale on every release bump.
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(Object.hasOwn(manifest, 'slots'), false);
  assert.deepEqual(manifest.node.secretBindings, [
    {
      key: 'icloud_mail_app_password',
      label: 'Apple Account app-specific password A',
      methods: ['account/connect-a', 'mail/action-a'],
      hint: 'An app-specific password generated on the Apple Account website, not your Apple Account password',
      url: 'https://account.apple.com/',
    },
    {
      key: 'icloud_mail_app_password_b',
      label: 'Apple Account app-specific password B',
      methods: ['account/connect-b', 'mail/action-b'],
      hint: 'An app-specific password generated on the Apple Account website, not your Apple Account password',
      url: 'https://account.apple.com/',
    },
  ]);
  manifest.node.secretBindings.forEach((binding) => {
    assert.match(binding.key, /^[a-z][a-z0-9_]{0,31}$/);
  });
  assert.match(manifest.description, /Cindy stores the app-specific password securely/);
});

test('settings page switches safely between two credential slots and BroadcastChannel never sends the app-specific password', () => {
  assert.match(settingsSource, /fetch\('\/secrets\/'\s*\+\s*SECRET_KEYS\[credentialSlot\]/);
  assert.match(settingsSource, /body:\s*JSON\.stringify\(\{\s*value:\s*value\s*\}\)/);
  assert.match(
    settingsSource,
    /payload:\s*\{\s*email:\s*email,\s*credentialSlot:\s*credentialSlot\s*\}/,
  );
  assert.doesNotMatch(mainSource, /appSpecificPassword/);
  assert.match(
    settingsSource,
    /fetch\('\/wake'\)\.then\(beginPosting,\s*beginPosting\)/,
    'the settings page must wait for /wake to finish before posting connect requests',
  );
  const stageIndex = settingsSource.indexOf(
    'await saveAppSpecificPassword(candidateSlot, appSpecificPassword)',
  );
  const validateIndex = settingsSource.indexOf(
    'await sendConnect(email, candidateSlot, 50000)',
  );
  const commitIndex = settingsSource.indexOf(
    'await saveAccountState(email, candidateSlot)',
  );
  const commitStartedIndex = settingsSource.indexOf('commitStarted = true');
  assert.ok(stageIndex >= 0 && stageIndex < validateIndex);
  assert.ok(validateIndex < commitStartedIndex && commitStartedIndex < commitIndex);
  assert.match(settingsSource, /candidateStored\s*&&\s*!commitStarted/);
  assert.doesNotMatch(settingsSource, /candidateStored\s*&&\s*!committed/);
  assert.match(settingsSource, /render\(previousState\s*\|\|\s*\{\s*connected:\s*false\s*\}\)/);
});

test('main.js connect and mail requests carry only the email and the non-sensitive credential slot', async () => {
  const harness = createMainHarness(async (request) => ({
    ok: true,
    result: request.method === 'account/connect-b'
      ? { connected: true, email: 'user@icloud.com', persistence: 'cindy-safe-storage' }
      : { folder: 'INBOX', messages: [] },
  }));

  const connected = await harness.settings('connect', {
    email: 'USER@ICLOUD.COM',
    credentialSlot: 'b',
  });
  assert.equal(connected.ok, true);
  assert.equal(harness.nodeRequests[0].method, 'account/connect-b');
  assert.equal(
    JSON.stringify(harness.nodeRequests[0].params),
    JSON.stringify({ email: 'user@icloud.com', credentialSlot: 'b' }),
  );

  const result = await harness.call('icloud_mail', { action: 'search', text: 'invoice' });
  assert.equal(result.ok, true);
  assert.equal(harness.nodeRequests[1].method, 'mail/action-a');
  assert.equal(harness.nodeRequests[1].params.email, 'user@icloud.com');
  assert.equal(harness.nodeRequests[1].params.credentialSlot, 'a');
  assert.equal('credentials' in harness.nodeRequests[1].params, false);
  assert.equal('appSpecificPassword' in harness.nodeRequests[1].params, false);
});

test('status comes from Cindy persistent storage and does not depend on the Worker running', async () => {
  const harness = createMainHarness(async () => {
    throw new Error('status must not wake the Worker');
  });
  const connected = await harness.call('icloud_mail_status');
  assert.equal(
    JSON.stringify(connected.result),
    JSON.stringify({
      connected: true,
      email: 'user@icloud.com',
      persistence: 'cindy-safe-storage',
    }),
  );
  assert.equal(harness.nodeRequests.length, 0);

  harness.setSecretSaved('a', false);
  const disconnected = await harness.call('icloud_mail_status');
  assert.equal(disconnected.result.connected, false);
  assert.equal(disconnected.result.email, 'user@icloud.com');
});

test('Worker builds safe search criteria and keeps the IMAP folder + UID identity', () => {
  const criteria = worker.buildSearchCriteria({
    text: 'project',
    unread: true,
    from: 'alice@example.com',
    since: '2026-07-01',
  });
  assert.equal(criteria.seen, false);
  assert.equal(criteria.from, 'alice@example.com');
  assert.equal(criteria.since instanceof Date, true);
  assert.deepEqual(criteria.or, [
    { subject: 'project' },
    { from: 'project' },
    { to: 'project' },
    { body: 'project' },
  ]);
  const summary = worker.summaryFromMessage({
    uid: 42,
    envelope: {
      from: [{ name: 'Alice', address: 'alice@example.com' }],
      to: [{ address: 'user@icloud.com' }],
      subject: 'Hello',
      date: new Date('2026-07-24T08:00:00Z'),
    },
    flags: new Set(),
    size: 100,
  }, 'INBOX');
  assert.equal(summary.uid, 42);
  assert.equal(summary.folder, 'INBOX');
  assert.equal(summary.unread, true);
});

test('Worker uses the official Apple IMAP and SMTP STARTTLS settings', () => {
  const credentials = {
    email: 'user@icloud.com',
    appSpecificPassword: 'abcd-efgh-ijkl-mnop',
  };
  assert.deepEqual(worker.ICLOUD, {
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
  });

  const imap = worker.imapOptions(credentials);
  assert.equal(imap.host, 'imap.mail.me.com');
  assert.equal(imap.port, 993);
  assert.equal(imap.secure, true);
  assert.equal(imap.auth.user, 'user@icloud.com');
  assert.equal(imap.auth.pass, 'abcd-efgh-ijkl-mnop');

  const smtp = worker.smtpOptions(credentials);
  assert.equal(smtp.host, 'smtp.mail.me.com');
  assert.equal(smtp.port, 587);
  assert.equal(smtp.secure, false);
  assert.equal(smtp.requireTLS, true);
  assert.equal(smtp.auth.user, 'user@icloud.com');
  assert.equal(smtp.auth.pass, 'abcd-efgh-ijkl-mnop');
});

test('Worker only consumes host-injected credentials per request and wraps IMAP operations in connect + logout', async () => {
  const calls = [];
  class FakeImap {
    async connect() { calls.push('connect'); }
    async logout() { calls.push('logout'); }
    close() { calls.push('close'); }
    async list() {
      calls.push('list');
      return [{ path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox', flags: new Set() }];
    }
  }
  const deps = {
    createImap(options) {
      assert.equal(options.email, 'user@icloud.com');
      assert.equal(options.appSpecificPassword, 'abcd-efgh-ijkl-mnop');
      return new FakeImap();
    },
    createSmtp() {
      throw new Error('unexpected SMTP');
    },
    createComposer() {
      throw new Error('unexpected composer');
    },
    parseMessage() {
      throw new Error('unexpected parser');
    },
  };
  const connectRequest = {
    method: 'account/connect-b',
    params: { email: 'user@icloud.com', credentialSlot: 'b' },
    cindy: {
      secrets: {
        icloud_mail_app_password_b: 'abcd-efgh-ijkl-mnop',
      },
    },
  };
  const connected = await worker.handleRequest(connectRequest, {
    ...deps,
    createSmtp() {
      return {
        async verify() { calls.push('smtp-verify'); },
        close() { calls.push('smtp-close'); },
      };
    },
  });
  assert.equal(connected.persistence, 'cindy-safe-storage');
  assert.equal(connectRequest.cindy.secrets.icloud_mail_app_password_b, '');

  calls.length = 0;
  const actionRequest = {
    method: 'mail/action-a',
    params: {
      email: 'user@icloud.com',
      credentialSlot: 'a',
      action: { action: 'list_folders' },
    },
    cindy: {
      secrets: {
        icloud_mail_app_password: 'abcd-efgh-ijkl-mnop',
      },
    },
  };
  const result = await worker.handleRequest(actionRequest, deps);
  assert.deepEqual(calls, ['connect', 'list', 'logout']);
  assert.equal(result.folders[0].path, 'INBOX');
  assert.equal(actionRequest.cindy.secrets.icloud_mail_app_password, '');
  assert.equal(JSON.stringify(result).includes('abcd-efgh-ijkl-mnop'), false);
});

test('Worker rejects an app-specific password forged in params and trusts only the host-injected field', async () => {
  await assert.rejects(
    worker.handleRequest({
      method: 'mail/action-a',
      params: {
        email: 'user@icloud.com',
        appSpecificPassword: 'forged-code',
        action: { action: 'list_folders' },
      },
    }),
    /app-specific password/,
  );
});

test('Worker rejects a credential slot that does not match the method binding', async () => {
  await assert.rejects(
    worker.handleRequest({
      method: 'mail/action-a',
      params: {
        email: 'user@icloud.com',
        credentialSlot: 'b',
        action: { action: 'list_folders' },
      },
      cindy: {
        secrets: {
          icloud_mail_app_password: 'abcd-efgh-ijkl-mnop',
        },
      },
    }),
    /Invalid iCloud Mail credential state/,
  );
});

test('Worker does not report a missing or unchanged UID as successfully marked', async () => {
  let mutationCalls = 0;
  const missing = createWorkerHarness({
    async fetchOne() {
      return false;
    },
    async messageFlagsAdd() {
      mutationCalls += 1;
      return true;
    },
  });
  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'mark_read', folder: 'INBOX', message_uid: 404 },
      missing.deps,
    ),
    /MESSAGE_NOT_FOUND/,
  );
  assert.equal(mutationCalls, 0);

  const unchanged = createWorkerHarness({
    async fetchOne() {
      return { uid: 42, flags: new Set() };
    },
    async messageFlagsAdd() {
      mutationCalls += 1;
      return false;
    },
  });
  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'mark_read', folder: 'INBOX', message_uid: 42 },
      unchanged.deps,
    ),
    /MESSAGE_NOT_FOUND/,
  );
  assert.equal(mutationCalls, 1);
});

test('Worker reports a move as successful only when the server returns the destination UID mapping', async () => {
  let moveCalls = 0;
  const missing = createWorkerHarness({
    async fetchOne() {
      return false;
    },
    async messageMove() {
      moveCalls += 1;
      return { path: 'INBOX', destination: 'Archive' };
    },
  });
  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'move', folder: 'INBOX', target_folder: 'Archive', message_uid: 404 },
      missing.deps,
    ),
    /MESSAGE_NOT_FOUND/,
  );
  assert.equal(moveCalls, 0);

  const unchanged = createWorkerHarness({
    async fetchOne() {
      return { uid: 42 };
    },
    async messageMove() {
      moveCalls += 1;
      return false;
    },
  });
  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'move', folder: 'INBOX', target_folder: 'Archive', message_uid: 42 },
      unchanged.deps,
    ),
    /MESSAGE_NOT_FOUND/,
  );
  assert.equal(moveCalls, 1);

  const withoutCopyUid = createWorkerHarness({
    async fetchOne() {
      return { uid: 42 };
    },
    async messageMove() {
      moveCalls += 1;
      return { path: 'INBOX', destination: 'Archive' };
    },
  });
  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'move', folder: 'INBOX', target_folder: 'Archive', message_uid: 42 },
      withoutCopyUid.deps,
    ),
    /MESSAGE_MOVE_UNCONFIRMED/,
  );

  const withCopyUid = createWorkerHarness({
    async fetchOne() {
      return { uid: 42 };
    },
    async messageMove() {
      moveCalls += 1;
      return { uidMap: new Map([[42, 142]]) };
    },
  });
  const result = await worker.performAction(
    { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
    { action: 'move', folder: 'INBOX', target_folder: 'Archive', message_uid: 42 },
    withCopyUid.deps,
  );
  assert.equal(result.moved, true);
  assert.equal(result.destination_uid, 142);
  assert.equal(moveCalls, 3);
});

test('Worker does not report an IMAP append that returned false as a saved draft', async () => {
  const harness = createWorkerHarness({
    async list() {
      return [{ path: 'Drafts', specialUse: '\\Drafts' }];
    },
    async append() {
      return false;
    },
  });
  harness.deps.createComposer = () => ({
    async sendMail() {
      return { message: Buffer.from('Subject: Test\r\n\r\nDraft') };
    },
    close() {},
  });

  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      {
        action: 'draft',
        to: 'recipient@example.com',
        subject: 'Test',
        body_text: 'Draft',
      },
      harness.deps,
    ),
    /DRAFT_SAVE_FAILED/,
  );
});

test('Worker reads messages in chunks and rejects content over 12 MiB before parsing', async () => {
  const maxSourceBytes = 12 * 1024 * 1024;
  let parseCalls = 0;
  const harness = createWorkerHarness({
    async fetchOne(_uid, query) {
      assert.equal(query.source, undefined);
      return {
        uid: 42,
        envelope: {},
        flags: new Set(),
        size: null,
      };
    },
    async download(_uid, part, options) {
      assert.equal(part, undefined);
      assert.equal(options.uid, true);
      assert.equal(options.maxBytes, maxSourceBytes + 1);
      return {
        meta: { expectedSize: null },
        content: Readable.from([Buffer.alloc(maxSourceBytes + 1)]),
      };
    },
  }, async () => {
    parseCalls += 1;
    return {};
  });

  await assert.rejects(
    worker.performAction(
      { email: 'user@icloud.com', appSpecificPassword: 'abcd-efgh-ijkl-mnop' },
      { action: 'read', folder: 'INBOX', message_uid: 42 },
      harness.deps,
    ),
    /MESSAGE_TOO_LARGE/,
  );
  assert.equal(parseCalls, 0);
});

test('Worker turns auth, network, and rate limit errors into actionable messages', () => {
  assert.match(worker.humanizeError(Object.assign(new Error('Authentication failed'), { code: 'EAUTH' })), /app-specific password/);
  assert.match(worker.humanizeError(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), /network/);
  assert.match(worker.humanizeError(new Error('Too many simultaneous connections')), /Try again later/);
  assert.match(worker.humanizeError(new Error('MESSAGE_MOVE_UNCONFIRMED')), /Search the mailbox again/);
  assert.match(worker.humanizeError(new Error('DRAFT_SAVE_FAILED')), /draft/);
});
