/**
 * ntfy Notifications: publishes push notifications to user-configured ntfy servers.
 *
 * - Servers come from the host's `network.connections` slot `ntfy_conn`. The user
 *   adds "server host + access token" in settings.html; the host encrypts the token
 *   and injects `Authorization: Bearer <token>` only into requests whose URL matches
 *   that connection. This file never sees, stores or returns a token.
 * - The per-server default topic is a non-secret preference kept in the plugin KV
 *   (`/kv` -> `{ defaultTopics: { <connectionId>: "<topic>" } }`).
 * - Publishing uses ntfy's JSON API (POST to the server root with a JSON body), not
 *   the X-Title/X-Tags headers: HTTP headers must be ASCII, so accented titles would
 *   arrive mangled.
 * - A send is never retried. When the request may have reached the server (timeout,
 *   network failure, HTTP 5xx, unexpected status) the result says the outcome is
 *   unknown so the agent asks the user instead of sending a duplicate.
 */

/* global cindy */

var CONNECTION_KEY = 'ntfy_conn';
var MAX_MESSAGE_BYTES = 4096;
var REQUEST_TIMEOUT_MS = 20000;
var TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
var PRIORITY_NAMES = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
// Host fetch failures that happen before anything leaves the machine. Anything
// not listed is treated as "the request may have been sent".
var PREFLIGHT_ERROR_CODES = { PERMISSION_DENIED: true, INVALID_INPUT: true, INVALID_PARAMS: true };
var PREFLIGHT_MESSAGE_RE = /not allowed|not configured|allowlist|whitelist|no (?:matching )?connection|credential|permission denied/i;

function failure(errorCode, message) {
  return { ok: false, errorCode: errorCode, message: message };
}

function success(result) {
  return { ok: true, result: result };
}

/** UTF-8 byte length without TextEncoder (lone surrogates count as U+FFFD, 3 bytes). */
function utf8Length(text) {
  var bytes = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      var next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Text that came from the server or host goes back to the agent only after this:
 * control characters removed, anything shaped like an ntfy token or a bearer
 * credential redacted, length capped.
 */
function safeText(value) {
  var text = typeof value === 'string' ? value : '';
  text = text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\btk_[A-Za-z0-9]{4,}/g, '[redacted]')
    .trim();
  return text.length > 200 ? text.slice(0, 200) + '...' : text;
}

function normalizeServerRef(value) {
  return String(value).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

async function readJson(url) {
  var response = await fetch(url);
  if (!response || response.ok === false) throw new Error('HTTP ' + (response && response.status));
  return response.json();
}

/** Configured servers, newest host data on every call (the list is tiny). */
async function loadServers() {
  var list;
  try {
    list = await readJson('/connections');
  } catch (e) {
    return { error: failure('SETTINGS_UNAVAILABLE', 'Could not read the configured ntfy servers. Ask the user to reopen the ntfy plugin settings and try again.') };
  }
  var slot = null;
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].key === CONNECTION_KEY) {
        slot = list[i];
        break;
      }
    }
  }
  var connections = slot && Array.isArray(slot.connections) ? slot.connections : [];
  var topics = {};
  try {
    var kv = await readJson('/kv');
    if (kv && typeof kv.defaultTopics === 'object' && kv.defaultTopics !== null) topics = kv.defaultTopics;
  } catch (e) {
    // Default topics are optional; a send without an explicit topic reports it.
    topics = {};
  }
  var servers = [];
  for (var j = 0; j < connections.length; j++) {
    var c = connections[j];
    if (!c || typeof c.id !== 'string' || typeof c.host !== 'string' || !c.host) continue;
    var topic = Object.prototype.hasOwnProperty.call(topics, c.id) ? topics[c.id] : null;
    servers.push({
      id: c.id,
      host: c.host.toLowerCase(),
      defaultTopic: typeof topic === 'string' && TOPIC_RE.test(topic) ? topic : null,
    });
  }
  return { servers: servers };
}

function hostList(servers) {
  return servers.map(function (s) { return s.host; }).join(', ');
}

function resolveServer(servers, requested) {
  if (!servers.length) {
    return { error: failure('NOT_CONFIGURED', 'No ntfy server is configured. Ask the user to add one (server URL and access token) in the ntfy plugin settings.') };
  }
  if (requested !== undefined && requested !== null && requested !== '') {
    if (typeof requested !== 'string') {
      return { error: failure('INVALID_ARGUMENT', 'server must be a string: a server id or host from ntfy_servers.') };
    }
    var wanted = normalizeServerRef(requested);
    for (var i = 0; i < servers.length; i++) {
      if (servers[i].id === requested || servers[i].host === wanted) return { server: servers[i] };
    }
    return { error: failure('SERVER_NOT_FOUND', 'No configured ntfy server matches "' + safeText(requested) + '". Configured servers: ' + hostList(servers) + '.') };
  }
  if (servers.length === 1) return { server: servers[0] };
  return { error: failure('AMBIGUOUS_SERVER', 'Several ntfy servers are configured (' + hostList(servers) + '). Ask the user which one to use and pass it as server.') };
}

function parsePriority(value) {
  if (typeof value === 'number' && value % 1 === 0 && value >= 1 && value <= 5) return value;
  if (typeof value === 'string') {
    var text = value.trim().toLowerCase();
    if (/^[1-5]$/.test(text)) return Number(text);
    if (Object.prototype.hasOwnProperty.call(PRIORITY_NAMES, text)) return PRIORITY_NAMES[text];
  }
  return null;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  if (typeof URL === 'function') {
    try {
      var parsed = new URL(value);
      return parsed.protocol === 'https:' && parsed.hostname.length > 0;
    } catch (e) {
      return false;
    }
  }
  return /^https:\/\/[^\/?#\s]+/i.test(value);
}

/** Validates everything that does not need the server list. */
function validateSendArgs(args) {
  var fields = {};
  if (typeof args.message !== 'string' || !args.message.trim()) {
    return { error: failure('INVALID_ARGUMENT', 'message is required and must be non-empty text.') };
  }
  var size = utf8Length(args.message);
  if (size > MAX_MESSAGE_BYTES) {
    return { error: failure('MESSAGE_TOO_LARGE', 'message is ' + size + ' bytes; ntfy accepts at most ' + MAX_MESSAGE_BYTES + ' UTF-8 bytes. Shorten it (nothing was sent and nothing was truncated).') };
  }
  fields.message = args.message;

  if (args.topic !== undefined && args.topic !== null && args.topic !== '') {
    if (typeof args.topic !== 'string' || !TOPIC_RE.test(args.topic)) {
      return { error: failure('INVALID_TOPIC', 'Invalid topic "' + safeText(String(args.topic)) + '". ntfy topics use only letters, digits, - and _, 1 to 64 characters.') };
    }
    fields.topic = args.topic;
  }

  if (args.title !== undefined && args.title !== null) {
    if (typeof args.title !== 'string') return { error: failure('INVALID_ARGUMENT', 'title must be text.') };
    if (args.title.trim()) fields.title = args.title;
  }

  if (args.priority !== undefined && args.priority !== null && args.priority !== '') {
    var priority = parsePriority(args.priority);
    if (priority === null) {
      return { error: failure('INVALID_PRIORITY', 'Invalid priority "' + safeText(String(args.priority)) + '". Use 1-5 or one of min, low, default, high, urgent.') };
    }
    fields.priority = priority;
  }

  if (args.tags !== undefined && args.tags !== null) {
    if (!Array.isArray(args.tags)) return { error: failure('INVALID_ARGUMENT', 'tags must be an array of strings.') };
    var tags = [];
    for (var i = 0; i < args.tags.length; i++) {
      var tag = args.tags[i];
      if (typeof tag !== 'string' || !tag.trim()) {
        return { error: failure('INVALID_ARGUMENT', 'tags must be an array of non-empty strings.') };
      }
      tags.push(tag.trim());
    }
    if (tags.length) fields.tags = tags;
  }

  if (args.click !== undefined && args.click !== null && args.click !== '') {
    if (!isHttpsUrl(args.click)) {
      return { error: failure('INVALID_CLICK_URL', 'click must be an absolute https:// URL.') };
    }
    fields.click = args.click;
  }

  if (args.markdown !== undefined && args.markdown !== null) {
    if (typeof args.markdown !== 'boolean') return { error: failure('INVALID_ARGUMENT', 'markdown must be true or false.') };
    if (args.markdown) fields.markdown = true;
  }
  return { fields: fields };
}

function unknownOutcome(server, topic, reason) {
  return failure(
    'SEND_OUTCOME_UNKNOWN',
    'Outcome unknown: ' + reason + '. The request may have reached ' + server.host +
      ' and the notification may already have been delivered to topic "' + topic +
      '". Do not resend automatically; ask the user to check the topic in their ntfy app before sending again.'
  );
}

function ntfyErrorText(body) {
  if (typeof body !== 'string' || !body) return '';
  try {
    var parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === 'string') return safeText(parsed.error);
  } catch (e) {
    /* not JSON */
  }
  return safeText(body);
}

function classifyHttpFailure(status, body, server, topic) {
  var detail = ntfyErrorText(body);
  var suffix = detail ? ' Server said: ' + detail : '';
  if (status === 401) {
    return failure('NTFY_UNAUTHORIZED', 'Not sent: ' + server.host + ' rejected the access token (HTTP 401). The token is missing, invalid or expired; ask the user to replace it in the ntfy plugin settings.' + suffix);
  }
  if (status === 403) {
    return failure('NTFY_FORBIDDEN', 'Not sent: the access token has no write permission on topic "' + topic + '" at ' + server.host + ' (HTTP 403). Ask the user to grant write access to this topic (ntfy access control) or use another topic.' + suffix);
  }
  if (status === 404) {
    return failure('NTFY_NOT_FOUND', 'Not sent: ' + server.host + ' answered HTTP 404. Check that it is an ntfy server served at the root of the domain.' + suffix);
  }
  if (status === 413) {
    return failure('MESSAGE_TOO_LARGE', 'Not sent: ' + server.host + ' rejected the notification as too large (HTTP 413). Shorten the message.' + suffix);
  }
  if (status === 429) {
    return failure('NTFY_RATE_LIMITED', 'Not sent: ' + server.host + ' is rate limiting requests (HTTP 429). Wait before sending again and do not retry in a loop.' + suffix);
  }
  if (status >= 400 && status < 500) {
    return failure('NTFY_REJECTED', 'Not sent: ' + server.host + ' rejected the notification (HTTP ' + status + ').' + suffix);
  }
  if (status >= 500) {
    return unknownOutcome(server, topic, server.host + ' returned a server error (HTTP ' + status + ')');
  }
  return unknownOutcome(server, topic, server.host + ' answered with unexpected HTTP status ' + status);
}

async function sendNotification(args, callId, state) {
  var checked = validateSendArgs(args);
  if (checked.error) return checked.error;
  var fields = checked.fields;

  var loaded = await loadServers();
  if (loaded.error) return loaded.error;
  var resolved = resolveServer(loaded.servers, args.server);
  if (resolved.error) return resolved.error;
  var server = resolved.server;

  var topic = fields.topic || server.defaultTopic;
  if (!topic) {
    return failure('NO_TOPIC', 'No topic given and ' + server.host + ' has no default topic. Pass topic, or ask the user to set a default topic in the ntfy plugin settings.');
  }

  var body = { topic: topic, message: fields.message };
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.priority !== undefined) body.priority = fields.priority;
  if (fields.tags !== undefined) body.tags = fields.tags;
  if (fields.click !== undefined) body.click = fields.click;
  if (fields.markdown) body.markdown = true;

  var response;
  state.dispatched = true;
  try {
    // No Authorization header here: the host injects the connection token.
    response = await cindy.fetch({
      url: 'https://' + server.host + '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      as: 'text',
      timeoutMs: REQUEST_TIMEOUT_MS,
      callId: callId,
    });
  } catch (e) {
    return unknownOutcome(server, topic, 'the request failed (' + (safeText(e && e.message) || 'no details') + ')');
  }

  if (!response || response.ok !== true) {
    var reason = safeText(response && response.message);
    var code = response && typeof response.errorCode === 'string' ? response.errorCode : '';
    if (PREFLIGHT_ERROR_CODES[code] === true || PREFLIGHT_MESSAGE_RE.test(reason)) {
      return failure('SEND_NOT_DISPATCHED', 'Not sent: Cindy blocked the request before it left this machine' + (reason ? ' (' + reason + ')' : '') + '. Check the server in the ntfy plugin settings; after fixing it, sending again is safe.');
    }
    return unknownOutcome(server, topic, 'no response from ' + server.host + (reason ? ' (' + reason + ')' : ' (timeout or network error)'));
  }

  var status = response.status;
  if (typeof status !== 'number' || status < 200 || status >= 300) {
    return classifyHttpFailure(status, response.body, server, topic);
  }

  var published = null;
  try {
    published = typeof response.body === 'string' && response.body ? JSON.parse(response.body) : null;
  } catch (e) {
    published = null;
  }
  var result = { sent: true, server: server.host, topic: topic };
  if (published && typeof published.id === 'string') {
    result.id = published.id;
    if (typeof published.time === 'number') result.time = published.time;
    if (typeof published.expires === 'number') result.expires = published.expires;
  } else {
    result.id = null;
    result.note = 'ntfy accepted the notification (HTTP ' + status + ') but did not return a message id.';
  }
  return success(result);
}

async function listServers() {
  var loaded = await loadServers();
  if (loaded.error) return loaded.error;
  var result = {
    count: loaded.servers.length,
    servers: loaded.servers.map(function (s) {
      return { id: s.id, host: s.host, url: 'https://' + s.host, default_topic: s.defaultTopic };
    }),
  };
  if (!loaded.servers.length) {
    result.note = 'No ntfy server is configured. Ask the user to add one (server URL and access token) in the ntfy plugin settings.';
  }
  return success(result);
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  var args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
  var state = { dispatched: false };
  var outcome;
  try {
    if (msg.tool === 'ntfy_send') outcome = await sendNotification(args, msg.callId, state);
    else if (msg.tool === 'ntfy_servers') outcome = await listServers();
    else outcome = failure('UNKNOWN_TOOL', 'Unknown tool: ' + safeText(String(msg.tool)));
  } catch (e) {
    outcome = state.dispatched
      ? failure('SEND_OUTCOME_UNKNOWN', 'Outcome unknown: an internal error happened after the request was handed to the network. Do not resend automatically; ask the user to check their ntfy app first.')
      : failure('INTERNAL', 'Internal error in the ntfy plugin; nothing was sent.');
  }
  if (outcome.ok) {
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: outcome.result });
  } else {
    await cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: outcome.errorCode, message: outcome.message });
  }
});
