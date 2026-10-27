import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext, Script } from 'node:vm';
import test from 'node:test';

const ID = 'ruivalim-google-calendar';
const PREFIX = 'google_calendar';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = read(`${ID}/main.js`);
const event = { id: 'event-1', summary: '<Product review>', location: 'Meeting room',
  htmlLink: 'https://calendar.google.com/calendar/event?eid=abc&x=1',
  start: { date: '2026-09-17' }, end: { date: '2026-09-18' } };

async function call(command, data, options = {}) {
  const messages = [], requests = [];
  let handler;
  const ctx = createContext({
    fetch: async url => {
      assert.ok(url === '/oauth' || url === '/kv');
      return { ok: true, json: async () => url === '/kv' ? {} : options.oauth || [{ key: 'google_calendar_account',
        clientConfigured: true, accounts: [{ id: 'acc-1', label: 'work@example.test', status: 'connected' }] }] };
    },
    cindy: { onHostMessage: fn => { assert.equal(handler, undefined); handler = fn; },
      send: async message => {
        if (options.cardFailure && message.type === 'card-update') throw new Error('card unavailable');
        messages.push(JSON.parse(JSON.stringify(message)));
      },
      node: { request: async request => { requests.push(request);
        if (options.throw) throw new Error('worker stopped');
        return { ok: true, result: options.failure || { ok: true, data } };
      } },
    },
  });
  runInContext(source, ctx);
  await handler({ type: 'tool-call', tool: options.tool || 'google_calendar_run', callId: 'call-1',
    args: { command: [command], arguments: ['primary'], options: options.flags || {},
      session_context: { workdir_is_read_only: false, workdir_is_local: true, workdir: '/test-workdir' } } });
  assert.equal(messages.filter(m => m.type === 'tool-result').length, 1);
  return { messages, requests };
}

test('raw gog event output renders a card without calling a second Google API', async () => {
  for (const [command, data, label] of [
    ['events', { events: [event] }, 'Events'], ['event', { event }, 'Event details'],
    ['create', { event }, 'Event created'], ['update', { event }, 'Event updated'],
  ]) {
    const { messages, requests } = await call(command, data, { flags: { location: 'Meeting room' } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authAccount, 'acc-1');
    assert.equal(requests[0].params.options.location, 'Meeting room');
    assert.equal(messages[0].type, 'card-update');
    assert.match(messages[0].html, new RegExp(label));
    assert.match(messages[0].html, /&lt;Product review&gt;|All day/);
    assert.match(messages[0].html, /data-ghost-link=.*abc&amp;x=1/);
    assert.ok(messages[0].height >= 104 && messages[0].height <= 720);
    assert.deepEqual(messages.at(-1).result, data);
  }
});

test('card text is English, including all-day events and date headings', async () => {
  const two = { events: [event, { ...event, id: 'event-2', summary: '' }] };
  const { html } = (await call('events', two)).messages[0];
  assert.match(html, /All day/);
  assert.match(html, /September 17/);
  assert.match(html, /2 events/);
  assert.match(html, /Untitled event/);
  assert.doesNotMatch(html, /[　-〿一-鿿＀-￯]/);
});

test('empty calendars and delete receipts are shown as-is, without inventing pre-delete details', async () => {
  assert.match((await call('events', { events: [] })).messages[0].html, /No events in this period/);
  const deleted = await call('delete', { deleted: true, eventId: 'event-1' });
  assert.match(deleted.messages[0].html, /Event deleted from Google Calendar/);
  assert.doesNotMatch(deleted.messages[0].html, /All day|data-ghost-link=/);
});

test('unrecognized results, unknown outcomes and card failures never fake a business result', async () => {
  assert.equal((await call('events', 'unexpected output')).messages.length, 1);
  assert.equal((await call('update', { event }, { cardFailure: true })).messages[0].ok, true);
  const failed = await call('update', null, { failure: { ok: false, execution: 'unknown', message: 'Check remote state before retrying' } });
  assert.equal(failed.messages.length, 1);
  assert.match(failed.messages[0].message, /\[unknown\]/);
  assert.equal((await call('update', null, { throw: true })).messages[0].ok, false);
});

test('the old tool never sends a request; schema needs no account credential', async () => {
  const old = await call('events', {}, { tool: 'google_calendar' });
  assert.equal(old.requests.length, 0);
  assert.equal(old.messages[0].ok, false);
  assert.match(old.messages[0].message, /^Not executed: unknown tool/);
  const schema = await call('events', { name: 'events' }, { tool: 'google_calendar_schema' });
  assert.equal(schema.requests[0].method, 'schema');
  assert.equal(schema.requests[0].authAccount, undefined);
});

test('account errors say "Not executed", name the plugin and never fall back to another account', async () => {
  const none = await call('events', {}, { oauth: [{ key: 'google_calendar_account', clientConfigured: true, accounts: [] }] });
  assert.equal(none.requests.length, 0);
  assert.equal(none.messages[0].ok, false);
  assert.match(none.messages[0].message, /^Not executed: No account connected yet\. .*"Google Calendar \(Rui\)" details page/);
  const many = await call('events', {}, { oauth: [{ key: 'google_calendar_account', clientConfigured: true, accounts: [
    { id: 'acc-1', label: 'work@example.test', status: 'connected' },
    { id: 'acc-2', label: 'home@example.test', status: 'connected' }] }] });
  assert.equal(many.requests.length, 0);
  assert.match(many.messages[0].message, /^Not executed: multiple accounts are connected/);
  const expired = await call('events', {}, { oauth: [{ key: 'google_calendar_account', clientConfigured: true, accounts: [
    { id: 'acc-1', label: 'work@example.test', status: 'expired' }] }] });
  assert.equal(expired.requests.length, 0);
  assert.match(expired.messages[0].message, /^Not executed: the authorization for account work@example\.test has expired/);
  const unconfigured = await call('events', {}, { oauth: [{ key: 'google_calendar_account', clientConfigured: false, accounts: [] }] });
  assert.equal(unconfigured.requests.length, 0);
  assert.match(unconfigured.messages[0].message, /^Not executed: The built-in app identity is missing/);
});

test(`${ID}: gog parameters are visible through the Cindy tool contract`, () => {
  const manifest = JSON.parse(read(`${ID}/ghost.json`));
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.minCindyVersion, '0.1.92');
  assert.equal(Object.hasOwn(manifest, 'slots'), false);
  assert.equal(manifest.sessionContext, true);
  assert.deepEqual(manifest.card, {});
  const secret = manifest.network.secrets.find(secret => secret.source === 'oauth');
  assert.equal(secret.oauth.clientId, '948713214926-onmd8lp4prlfl78qppbfjpl568mc504r.apps.googleusercontent.com');
  // Unofficial plugins get OAuth only because the client pair is declared here.
  assert.ok(secret.oauth.clientSecret);
  assert.equal(manifest.node.secretBindings[0].oauthSecret, secret.key);
  assert.deepEqual(secret.oauth.scopes, ['openid', 'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/calendar']);
  // These are first-party-only host privileges; an unofficial copy must not depend on them.
  for (const field of ['tokenBroker', 'redirectPort', 'avatarPath']) {
    assert.equal(JSON.stringify(manifest).includes(`"${field}"`), false, field);
  }
  // ghost_info projects only name, description and parameters to the model.
  const tools = manifest.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const schema = tools.find(tool => tool.name === `${PREFIX}_schema`);
  const run = tools.find(tool => tool.name === `${PREFIX}_run`);
  assert.equal(schema.parameters.properties.command.type, 'array');
  assert.deepEqual(Object.keys(run.parameters.properties).sort(), ['account', 'arguments', 'command', 'options']);
  assert.deepEqual(run.parameters.required, ['command']);
  assert.equal(run.parameters.additionalProperties, false);
  assert.equal(run.parameters.properties.arguments.items.type, 'string');
  for (const name of [`${PREFIX}_schema`, `${PREFIX}_run`]) {
    assert.equal(Object.hasOwn(manifest.tools.find(tool => tool.name === name), 'inputSchema'), false);
  }
  assert.deepEqual(tools.map(tool => tool.name), [`${PREFIX}_schema`, `${PREFIX}_run`, `${PREFIX}_accounts`]);
  assert.doesNotMatch(source, /cindy\.fetch|async function api\(|https:\/\/.*googleapis\.com/);
  assert.match(source, /cindy\.node\.request/);
  assert.match(run.parameters.properties.account.description, /Multiple accounts require an explicit choice/);
  const declaration = JSON.parse(read(`${ID}/binary-dependencies.json`));
  assert.equal(declaration.dependencies.length, 1);
  assert.equal(declaration.dependencies[0].name, 'gog');
  assert.equal(declaration.dependencies[0].version, '0.39.1');
  assert.equal(declaration.dependencies[0].assets.length, 6);
  for (const asset of declaration.dependencies[0].assets) {
    assert.equal(asset.platforms.length, 1);
    assert.equal(asset.files.length, 1);
    assert.equal(asset.files[0].executable, true);
    assert.equal(Object.hasOwn(asset.files[0], 'encoding'), false);
  }
  const worker = read(`${ID}/node/gog.cjs`);
  assert.doesNotMatch(worker, /brotli|binaries\.json|checksum|createHash/);
  assert.match(worker, /vendor\/gog/);
});

test(`${ID}: tool descriptions and settings scope notice follow the selected locale`, () => {
  const english = JSON.parse(read(`${ID}/locales/en.json`));
  for (const locale of ['zh-CN', 'ja', 'ko']) {
    const localized = JSON.parse(read(`${ID}/locales/${locale}.json`));
    for (const name of [`${PREFIX}_schema`, `${PREFIX}_run`, `${PREFIX}_accounts`]) {
      assert.notEqual(localized.tools[name].description, english.tools[name].description);
    }
  }
  const html = read(`${ID}/settings.html`);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /id="settings-title"/);
  assert.match(html, /id="scope-hint"/);
  const settings = read(`${ID}/settings.js`);
  for (const locale of ["'zh-CN'", 'en', 'ja', 'ko']) assert.match(settings, new RegExp(`${locale}: \\{ title:`));
  assert.match(settings, /\$\('scope-hint'\)\.textContent = MESSAGES\[locale\]\.scopeHint/);
});

function connectError(error, detail) {
  const match = read(`${ID}/settings.js`).match(/function connectError\(result\) \{([\s\S]*?)\n  \}\n  function render/);
  assert.ok(match, 'settings.js declares connectError');
  const context = createContext({ input: { error, detail }, output: '', String,
    connectionUnknownMessage: () => 'UNKNOWN_FALLBACK' });
  new Script(`function connectError(result) {${match[1]}\n  }\noutput = connectError(input);`).runInContext(context);
  return context.output;
}

test(`${ID}: settings page shows structured OAuth errors in English with the safe detail`, () => {
  assert.equal(connectError('EXCHANGE_FAILED', 'invalid_client'),
    'Google token exchange failed. Check the plugin version. (invalid_client)');
  // Unknown codes fall back to the locale-aware "outcome unknown" copy and keep the server detail.
  assert.equal(connectError('UNKNOWN', 'callback rejected'), 'UNKNOWN_FALLBACK (callback rejected)');
  assert.equal(connectError('CANCELLED', ''), 'Authorization cancelled');
});

test(`${ID}: runtime, manifest and settings shell carry no Chinese text`, () => {
  const cjk = /[　-〿一-鿿＀-￯]/;
  for (const file of ['main.js', 'ghost.json', 'settings.html', 'node/gog.cjs', 'manual/gog/MANUAL.md', 'locales/en.json']) {
    assert.doesNotMatch(read(`${ID}/${file}`), cjk, file);
  }
  // Per-locale string tables stay; everything outside them is English.
  const settings = read(`${ID}/settings.js`).split('\n')
    .filter(line => !/^\s*('zh-CN'|ja|ko): /.test(line)).join('\n');
  assert.doesNotMatch(settings, cjk);
});

test(`${ID}: unofficial identity never collides with the official Google Calendar plugin`, () => {
  const manifest = JSON.parse(read(`${ID}/ghost.json`));
  const official = JSON.parse(read('google-calendar/ghost.json'));
  assert.equal(manifest.id, ID);
  assert.equal(manifest.command, ID);
  assert.equal(manifest.author, 'Rui Valim');
  assert.equal(manifest.name, 'Google Calendar (Rui)');
  assert.equal(manifest.version, '1.0.0');
  // Cindy refuses user installs of cindy- ids and plugins whose command is already taken.
  assert.equal(manifest.id.startsWith('cindy-'), false);
  assert.notEqual(manifest.id, official.id);
  assert.notEqual(manifest.command.toLowerCase(), official.command.toLowerCase());
  // Tool names and schemas stay the same so prompts keep working.
  assert.deepEqual(manifest.tools, official.tools);
  assert.deepEqual(manifest.network, { ...official.network, secrets: manifest.network.secrets });
  assert.deepEqual(manifest.network.secrets.map(secret => secret.oauth), official.network.secrets.map(secret => secret.oauth));
  assert.deepEqual(manifest.network.secrets.map(secret => secret.key), official.network.secrets.map(secret => secret.key));
  assert.deepEqual(manifest.node, official.node);
  assert.deepEqual(manifest.manual, official.manual);
  assert.deepEqual(manifest.card, official.card);
  assert.equal(manifest.minCindyVersion, official.minCindyVersion);
  assert.deepEqual(JSON.parse(read(`${ID}/binary-dependencies.json`)), JSON.parse(read('google-calendar/binary-dependencies.json')));
  for (const locale of ['en', 'zh-CN', 'ja', 'ko']) {
    const resource = JSON.parse(read(`${ID}/locales/${locale}.json`));
    const officialResource = JSON.parse(read(`google-calendar/locales/${locale}.json`));
    assert.equal(resource.name, 'Google Calendar (Rui)', locale);
    assert.match(resource.description, /Rui Valim/, locale);
    assert.deepEqual(resource.tools, officialResource.tools, locale);
    // Cindy caps description and whenToUse at 300 characters.
    for (const text of [resource.description, resource.whenToUse]) assert.ok([...text].length <= 300, `${locale}: ${text}`);
  }
  for (const text of [manifest.description, manifest.whenToUse]) assert.ok([...text].length <= 300, text);
  assert.match(source, /var PLUGIN_NAME = 'Google Calendar \(Rui\)';/);
  // Account metadata helpers are shared verbatim with the official Google plugins.
  for (const file of ['account-metadata.js', 'account-nickname.js', 'settings.css', 'node/gog.cjs', 'manual/gog/MANUAL.md']) {
    assert.equal(read(`${ID}/${file}`), read(`google-calendar/${file}`), file);
  }
});

import './ruivalim-google-calendar-accounts.test.mjs';
