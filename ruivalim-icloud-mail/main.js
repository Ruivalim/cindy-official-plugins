/**
 * iCloud Mail plugin (unofficial English copy of the official icloud-mail plugin).
 *
 * The settings page writes the app-specific password straight to Cindy's write-only
 * /secrets channel. The browser main.js only handles the non-sensitive email address;
 * the host injects the password temporarily into the matching Worker's
 * request.cindy.secrets, and only for the Node methods bound in ghost.json. Neither
 * Agent arguments nor plugin messages ever carry it.
 */

/* global BroadcastChannel, cindy, fetch, setTimeout */

var SETTINGS_CHANNEL = 'icloud-mail-settings';
var SECRET_KEYS = {
  a: 'icloud_mail_app_password',
  b: 'icloud_mail_app_password_b',
};
var settingsRequests = new Map();

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  return { ok: false, message: message };
}

function normalizeEmail(value) {
  var email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('Enter a valid iCloud Mail email address');
  }
  return email;
}

async function readJson(path) {
  var response = await fetch(path);
  if (!response.ok) throw new Error('Failed to read the iCloud Mail configuration');
  var value = await response.json();
  return value;
}

function normalizeCredentialSlot(value) {
  if (value === undefined || value === null || value === '') return 'a';
  if (value !== 'a' && value !== 'b') {
    throw new Error('Invalid iCloud Mail credential slot. Reconnect the account.');
  }
  return value;
}

function nodeMethod(baseMethod, credentialSlot) {
  return baseMethod + '-' + normalizeCredentialSlot(credentialSlot);
}

async function loadStoredAccount() {
  var values = await Promise.all([readJson('/kv'), readJson('/secrets')]);
  var kv = isObject(values[0]) ? values[0] : {};
  var secretItems = Array.isArray(values[1]) ? values[1] : [];
  var email = typeof kv.email === 'string' ? kv.email.trim().toLowerCase() : '';
  var credentialSlot = normalizeCredentialSlot(kv.credentialSlot);
  var secretSaved = secretItems.some(function hasSavedSecret(item) {
    return isObject(item)
      && item.key === SECRET_KEYS[credentialSlot]
      && item.saved === true;
  });
  return {
    connected: Boolean(email && secretSaved),
    email: email || null,
    credentialSlot: credentialSlot,
    persistence: 'cindy-safe-storage',
  };
}

async function loadAccountState() {
  var state = await loadStoredAccount();
  return {
    connected: state.connected,
    email: state.email,
    persistence: state.persistence,
  };
}

async function requireConfiguredAccount() {
  var state = await loadStoredAccount();
  if (!state.connected || !state.email) {
    throw new Error('iCloud Mail is not configured yet. Open the "iCloud Mail (Rui)" plugin details and connect the account.');
  }
  return { email: state.email, credentialSlot: state.credentialSlot };
}

async function nodeRequest(method, params, timeoutMs) {
  var response = await cindy.node.request({
    method: method,
    params: params,
    timeoutMs: timeoutMs || 30000,
  });
  if (!response || response.ok !== true) {
    throw new Error(response && response.message
      ? response.message
      : 'The iCloud Mail Worker call failed. Try again later.');
  }
  return response.result;
}

async function handleSettingsRequest(action, payload) {
  if (action !== 'connect') throw new Error('Unknown settings action');
  var email = normalizeEmail(payload.email);
  var credentialSlot = normalizeCredentialSlot(payload.credentialSlot);
  return nodeRequest(nodeMethod('account/connect', credentialSlot), {
    email: email,
    credentialSlot: credentialSlot,
  }, 45000);
}

var settingsChannel = typeof BroadcastChannel === 'function'
  ? new BroadcastChannel(SETTINGS_CHANNEL)
  : null;

if (settingsChannel) {
  settingsChannel.onmessage = function onSettingsMessage(event) {
    var message = event && event.data;
    if (
      !isObject(message)
      || message.type !== 'settings-request'
      || typeof message.reqId !== 'string'
      || typeof message.action !== 'string'
    ) {
      return;
    }

    var existing = settingsRequests.get(message.reqId);
    if (existing) {
      if (existing.response) settingsChannel.postMessage(existing.response);
      return;
    }

    var entry = { response: null };
    settingsRequests.set(message.reqId, entry);
    var payload = isObject(message.payload) ? message.payload : {};
    void handleSettingsRequest(message.action, payload)
      .then(function success(result) {
        return { type: 'settings-result', reqId: message.reqId, ok: true, result: result };
      })
      .catch(function failure(error) {
        return {
          type: 'settings-result',
          reqId: message.reqId,
          ok: false,
          message: error && error.message ? error.message : 'iCloud Mail connection failed. Try again.',
        };
      })
      .then(function reply(response) {
        entry.response = response;
        settingsChannel.postMessage(response);
        setTimeout(function releaseRequest() {
          if (settingsRequests.get(message.reqId) === entry) settingsRequests.delete(message.reqId);
        }, 5000);
      });
  };
}

function validateUid(value) {
  var uid = Number(value);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('message_uid must be a valid positive integer');
  return uid;
}

function sanitizeMailArgs(args) {
  var action = typeof args.action === 'string' ? args.action : '';
  var allowed = {
    list_folders: true,
    search: true,
    read: true,
    send: true,
    draft: true,
    mark_read: true,
    mark_unread: true,
    move: true,
  };
  if (!allowed[action]) throw new Error('Unknown action: ' + action);

  var output = { action: action };
  var folder = typeof args.folder === 'string' && args.folder.trim()
    ? args.folder.trim()
    : 'INBOX';
  output.folder = folder;

  if (action === 'read' || action === 'mark_read' || action === 'mark_unread' || action === 'move') {
    output.message_uid = validateUid(args.message_uid);
  }
  if (action === 'move') {
    if (typeof args.target_folder !== 'string' || !args.target_folder.trim()) {
      throw new Error('move requires target_folder; call list_folders first');
    }
    output.target_folder = args.target_folder.trim();
  }

  if (action === 'search') {
    ['text', 'from', 'to', 'subject', 'since', 'before'].forEach(function copyString(key) {
      if (typeof args[key] === 'string' && args[key].trim()) output[key] = args[key].trim();
    });
    if (typeof args.unread === 'boolean') output.unread = args.unread;
    var max = Number(args.max_results);
    output.max_results = Number.isFinite(max) ? Math.min(20, Math.max(1, Math.floor(max))) : 10;
  }

  if (action === 'send' || action === 'draft') {
    if (args.to === undefined || typeof args.subject !== 'string' || typeof args.body_text !== 'string') {
      throw new Error(action + ' requires to, subject, and body_text');
    }
    output.to = args.to;
    if (args.cc !== undefined) output.cc = args.cc;
    if (args.bcc !== undefined) output.bcc = args.bcc;
    output.subject = args.subject;
    output.body_text = args.body_text;
  }

  return output;
}

async function runMail(args) {
  var action;
  try {
    action = sanitizeMailArgs(args);
  } catch (error) {
    return fail(error && error.message ? error.message : 'Invalid iCloud Mail arguments');
  }

  try {
    var account = await requireConfiguredAccount();
    var result = await nodeRequest(nodeMethod('mail/action', account.credentialSlot), {
      email: account.email,
      credentialSlot: account.credentialSlot,
      action: action,
    }, action.action === 'send' || action.action === 'draft' ? 60000 : 45000);
    return { ok: true, result: result };
  } catch (error) {
    return fail(error && error.message ? error.message : 'iCloud Mail operation failed. Try again later.');
  }
}

async function statusResult() {
  try {
    return { ok: true, result: await loadAccountState() };
  } catch (error) {
    return fail(error && error.message ? error.message : 'Failed to check the iCloud Mail connection status');
  }
}

cindy.onHostMessage(function onHostMessage(message) {
  if (!message || message.type !== 'tool-call') return;
  void (async function dispatch() {
    try {
      var result = message.tool === 'icloud_mail_status'
        ? await statusResult()
        : message.tool === 'icloud_mail'
          ? await runMail(isObject(message.args) ? message.args : {})
          : fail('Unknown tool: ' + message.tool);
      if (result.ok) {
        await cindy.send({
          type: 'tool-result',
          callId: message.callId,
          ok: true,
          result: result.result,
        });
      } else {
        await cindy.send({
          type: 'tool-result',
          callId: message.callId,
          ok: false,
          message: result.message,
        });
      }
    } catch (error) {
      await cindy.send({
        type: 'tool-result',
        callId: message.callId,
        ok: false,
        message: error && error.message ? error.message : 'iCloud Mail tool execution failed',
      });
    }
  })();
});
