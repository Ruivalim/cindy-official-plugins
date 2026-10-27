import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const plugins = { 'ruivalim-gmail': 'gmail' };

for (const [id, prefix] of Object.entries(plugins)) {
  test(`${id}: gog parameters are visible through the Cindy tool contract`, () => {
    const manifest = JSON.parse(readFileSync(new URL(`../${id}/ghost.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.schemaVersion, 3);
    // Cindy 0.1.112 is the first released client with the shared mail flow
    // and native reader from makecindy/cindy#6404.
    assert.equal(manifest.minCindyVersion, '0.1.112');
    assert.equal(Object.hasOwn(manifest, 'slots'), false);
    assert.equal(manifest.sessionContext, true);
    const secret = manifest.network.secrets.find(secret => secret.source === 'oauth');
    assert.equal(secret.oauth.clientId, '948713214926-onmd8lp4prlfl78qppbfjpl568mc504r.apps.googleusercontent.com');
    assert.equal(manifest.node.secretBindings[0].oauthSecret, secret.key);
    assert.deepEqual(secret.oauth.scopes, ['openid', 'https://www.googleapis.com/auth/userinfo.email',
      ...(id === 'ruivalim-gmail' ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify']
        : ['https://www.googleapis.com/auth/' + (id === 'google-calendar' ? 'calendar' : 'drive')])]);
    // ghost_info projects only name, description and parameters to the model.
    const tools = manifest.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const schema = tools.find(tool => tool.name === `${prefix}_schema`);
    const run = tools.find(tool => tool.name === `${prefix}_run`);
    assert.equal(schema.parameters.properties.command.type, 'array');
    assert.deepEqual(Object.keys(run.parameters.properties).sort(), ['account', 'arguments', 'command', 'options']);
    assert.deepEqual(run.parameters.required, ['command']);
    assert.equal(run.parameters.additionalProperties, false);
    assert.equal(run.parameters.properties.arguments.items.type, 'string');
    for (const name of [`${prefix}_schema`, `${prefix}_run`]) {
      assert.equal(Object.hasOwn(manifest.tools.find(tool => tool.name === name), 'inputSchema'), false);
    }
    assert.deepEqual(tools.map(tool => tool.name), [`${prefix}_read_message`, `${prefix}_schema`, `${prefix}_run`, `${prefix}_accounts`]);
    const reader = tools.find(tool => tool.name === manifest.mailReader.tool);
    assert.equal(reader.parameters.properties.url.type, 'string');
    assert.deepEqual(reader.parameters.required, ['url']);
    assert.equal(reader.parameters.additionalProperties, false);
    const main = readFileSync(new URL(`../${id}/main.js`, import.meta.url), 'utf8');
    // Host-managed attachment preview fetches are allowed; credentials remain
    // Host-owned. The compose tests verify the selected authAccount at runtime.
    assert.doesNotMatch(main, /gog_access_token|Bearer\s|Authorization\s*:/);
    assert.match(main, /cindy\.node\.request/);
    assert.match(run.parameters.properties.account.description, /Multiple accounts require an explicit choice/);
  });
}

test('ruivalim-gmail: unofficial identity never collides with the official Gmail plugin', () => {
  const manifest = JSON.parse(readFileSync(new URL('../ruivalim-gmail/ghost.json', import.meta.url), 'utf8'));
  const official = JSON.parse(readFileSync(new URL('../google-gmail/ghost.json', import.meta.url), 'utf8'));
  assert.equal(manifest.id, 'ruivalim-gmail');
  assert.equal(manifest.command, 'ruivalim-gmail');
  assert.equal(manifest.author, 'Rui Valim');
  assert.equal(manifest.name, 'Gmail (Rui)');
  assert.equal(manifest.version, '1.0.0');
  // Cindy refuses user installs of cindy- ids and plugins whose command is already taken.
  assert.equal(manifest.id.startsWith('cindy-'), false);
  assert.notEqual(manifest.id, official.id);
  assert.notEqual(manifest.command.toLowerCase(), official.command.toLowerCase());
  // Tool names stay the same so prompts and the mail reader keep working.
  assert.deepEqual(manifest.tools.map(tool => tool.name), official.tools.map(tool => tool.name));
  assert.deepEqual(manifest.network, { ...official.network, secrets: manifest.network.secrets });
  assert.deepEqual(manifest.network.secrets.map(secret => secret.oauth), official.network.secrets.map(secret => secret.oauth));
  assert.deepEqual(manifest.node, official.node);
  assert.deepEqual(manifest.cindy, official.cindy);
  assert.deepEqual(JSON.parse(readFileSync(new URL('../ruivalim-gmail/binary-dependencies.json', import.meta.url), 'utf8')),
    JSON.parse(readFileSync(new URL('../google-gmail/binary-dependencies.json', import.meta.url), 'utf8')));
  for (const locale of ['en', 'zh-CN', 'ja', 'ko']) {
    const resource = JSON.parse(readFileSync(new URL(`../ruivalim-gmail/locales/${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(resource.name, 'Gmail (Rui)', locale);
    assert.match(resource.description, /Rui Valim/, locale);
    // Cindy caps description and whenToUse at 300 characters.
    for (const text of [resource.description, resource.whenToUse]) assert.ok([...text].length <= 300, `${locale}: ${text}`);
  }
  assert.match(readFileSync(new URL('../ruivalim-gmail/main.js', import.meta.url), 'utf8'), /var PLUGIN_NAME = 'Gmail \(Rui\)';/);
  // Account metadata helpers are shared verbatim with the official Google plugins.
  for (const file of ['account-metadata.js', 'account-nickname.js']) {
    assert.equal(readFileSync(new URL(`../ruivalim-gmail/${file}`, import.meta.url), 'utf8'),
      readFileSync(new URL(`../google-gmail/${file}`, import.meta.url), 'utf8'), file);
  }
});

import './ruivalim-gmail-accounts.test.mjs';
import './ruivalim-gmail-worker.test.mjs';
import './ruivalim-gmail-packaging.test.mjs';
import './ruivalim-gmail-compose.test.mjs';
