/**
 * ntfy settings page script (loaded from settings.html; CSP blocks inline scripts).
 *
 * Data plane used here (same as cindy-gitlab):
 *   GET    /connections                    -> [{ key, connections: [{ id, host, label, isDefault, tail }] }]
 *   POST   /connections/ntfy_conn          -> { host, token }; the host asks the user to confirm,
 *                                             encrypts the token and answers { ok } or { ok:false, error }.
 *                                             Posting an existing host replaces its token.
 *   DELETE /connections/ntfy_conn/<id>     -> removes one server
 *   GET/PUT /kv                            -> { defaultTopics: { <connectionId>: topic } } (not secret)
 *   GET    /app-context                    -> { context: { locale } }, the only language source
 * The page never reads a token back; it only lists hosts.
 */
(function () {
  'use strict';

  var KEY = 'ntfy_conn';
  var TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;

  // English is the only runtime language for now; other host locales fall back to it.
  var MESSAGES = {
    en: {
      title: 'ntfy servers',
      badge: 'self-hosted',
      hint: 'https only, default port 443, ntfy served at the domain root.',
      hostPlaceholder: 'Server URL, e.g. https://ntfy.example.com',
      tokenPlaceholder: 'Access token (tk_...)',
      topicPlaceholder: 'Default topic (optional)',
      eye: 'Show or hide token',
      add: 'Add',
      empty: 'No ntfy server added yet.',
      topicLabel: 'Default topic for ',
      save: 'Save topic',
      remove: 'Remove',
      hostRequired: 'Enter the server URL first (for example https://ntfy.example.com).',
      httpNotSupported: 'Only https servers are supported. Use the https:// address of your ntfy server.',
      portNotSupported: 'Custom ports are not supported; the server must answer on https port 443.',
      pathNotSupported: 'Enter only the server address, without a path. ntfy must be served at the root of the domain.',
      invalidHost: 'That does not look like a valid server address.',
      tokenRequired: 'Paste the access token first.',
      invalidTopic: 'Topics may contain only letters, digits, - and _ (1 to 64 characters).',
      confirmAdd: 'Confirm adding the server in the system dialog...',
      confirmReplace: 'This server already exists; its token will be replaced. Confirm in the system dialog...',
      added: 'Added ',
      replaced: 'Replaced the token for ',
      addFailed: 'Could not add the server. Please try again.',
      topicSaved: 'Default topic saved.',
      topicCleared: 'Default topic cleared.',
      topicSaveFailed: 'Could not save the default topic. Please try again.',
      addedTopicFailed: 'The server was added, but its default topic could not be saved. Set it again in the list.',
      removed: 'Server removed.',
      removeFailed: 'Could not remove the server. Please try again.',
      loadFailed: 'Could not load the server list. Please try again later.',
      errors: {
        INVALID_HOST: 'The host rejected this address. Enter only the domain (for example ntfy.example.com), https on port 443.',
        INVALID_TOKEN: 'The token is empty or malformed. Paste it again.',
        TOKEN_TOO_LONG: 'The token is too long. Check what was pasted.',
        INVALID_LABEL: 'Invalid label.',
        LIMIT: 'Server limit reached (8). Remove one you no longer use first.',
        CONFIRM_DENIED: 'Cancelled: the system dialog was not confirmed.',
        VAULT_WRITE_FAILED: 'The token could not be saved. Please try again.',
      },
    },
  };
  var T = MESSAGES.en;

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    if (!sticky && text) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  async function loadLocale() {
    var locale = 'en';
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 2000) : null;
    try {
      var response = await fetch('/app-context', controller ? { signal: controller.signal } : undefined);
      if (response && response.ok !== false) {
        var data = await response.json();
        var requested = data && data.context && data.context.locale;
        if (typeof requested === 'string' && Object.prototype.hasOwnProperty.call(MESSAGES, requested)) locale = requested;
      }
    } catch (e) {
      locale = 'en';
    } finally {
      if (timer) clearTimeout(timer);
    }
    T = MESSAGES[locale];
    document.documentElement.lang = locale;
    $('title').textContent = T.title;
    $('badge').textContent = T.badge;
    $('hint').textContent = T.hint;
    $('host').placeholder = T.hostPlaceholder;
    $('host').setAttribute('aria-label', T.hostPlaceholder);
    $('token').placeholder = T.tokenPlaceholder;
    $('token').setAttribute('aria-label', T.tokenPlaceholder);
    $('topic').placeholder = T.topicPlaceholder;
    $('topic').setAttribute('aria-label', T.topicPlaceholder);
    $('eye').title = T.eye;
    $('eye').setAttribute('aria-label', T.eye);
    $('add').textContent = T.add;
  }

  /**
   * Accepts "ntfy.example.com" or "https://ntfy.example.com[/]" and returns the bare
   * lowercase host. The host only supports https on port 443 for connections, and
   * ntfy cannot be served under a sub-path, so http, ports and paths are refused here.
   */
  function parseServerUrl(raw) {
    var text = String(raw || '').trim();
    if (!text) return { error: 'hostRequired' };
    if (/^http:\/\//i.test(text)) return { error: 'httpNotSupported' };
    var rest = text.replace(/^https:\/\//i, '');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) return { error: 'invalidHost' };
    rest = rest.replace(/\/+$/, '');
    if (/[\/?#]/.test(rest)) return { error: 'pathNotSupported' };
    if (rest.indexOf('@') >= 0) return { error: 'invalidHost' };
    rest = rest.replace(/:443$/, '');
    if (rest.indexOf(':') >= 0) return { error: 'portNotSupported' };
    var host = rest.toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      return { error: 'invalidHost' };
    }
    return { host: host };
  }

  async function readKv() {
    var response = await fetch('/kv');
    if (!response || response.ok === false) throw new Error('kv read failed');
    var data = await response.json();
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  }

  /** Read-modify-write of the whole KV object, keeping unrelated keys. */
  async function writeTopic(connectionId, topic) {
    var kv = await readKv();
    var topics = kv.defaultTopics && typeof kv.defaultTopics === 'object' && !Array.isArray(kv.defaultTopics)
      ? kv.defaultTopics : {};
    if (topic) topics[connectionId] = topic;
    else delete topics[connectionId];
    kv.defaultTopics = topics;
    var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(kv) });
    if (!response || response.ok === false) throw new Error('kv write failed');
  }

  var currentConns = [];

  function findByHost(host) {
    for (var i = 0; i < currentConns.length; i++) {
      if (String(currentConns[i].host).toLowerCase() === host) return currentConns[i];
    }
    return null;
  }

  function renderList(conns, topics) {
    var box = $('list');
    box.textContent = '';
    if (!conns.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = T.empty;
      box.appendChild(empty);
      return;
    }
    conns.forEach(function (cn) {
      var row = document.createElement('div');
      row.className = 'server';

      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = cn.host;
      row.appendChild(who);

      var topicInput = document.createElement('input');
      topicInput.className = 'topic';
      topicInput.type = 'text';
      topicInput.placeholder = T.topicPlaceholder;
      topicInput.setAttribute('aria-label', T.topicLabel + cn.host);
      topicInput.value = typeof topics[cn.id] === 'string' ? topics[cn.id] : '';
      row.appendChild(topicInput);

      var saveBtn = document.createElement('button');
      saveBtn.className = 'mini';
      saveBtn.type = 'button';
      saveBtn.textContent = T.save;
      saveBtn.addEventListener('click', function () { void saveTopic(cn.id, topicInput, saveBtn); });
      row.appendChild(saveBtn);

      var removeBtn = document.createElement('button');
      removeBtn.className = 'mini';
      removeBtn.type = 'button';
      removeBtn.textContent = T.remove;
      removeBtn.addEventListener('click', function () { void remove(cn.id, removeBtn); });
      row.appendChild(removeBtn);

      box.appendChild(row);
    });
  }

  async function load() {
    try {
      var list = await (await fetch('/connections')).json();
      var conns = [];
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].key === KEY) {
            conns = Array.isArray(list[i].connections) ? list[i].connections : [];
            break;
          }
        }
      }
      currentConns = conns;
      var topics = {};
      try {
        var kv = await readKv();
        if (kv.defaultTopics && typeof kv.defaultTopics === 'object') topics = kv.defaultTopics;
      } catch (e) {
        /* topics are only a display convenience here */
      }
      renderList(conns, topics);
    } catch (e) {
      showStatus(T.loadFailed, true);
    }
  }

  async function saveTopic(connectionId, input, btn) {
    var topic = String(input.value || '').trim();
    if (topic && !TOPIC_RE.test(topic)) { showStatus(T.invalidTopic, true); return; }
    btn.disabled = true;
    try {
      await writeTopic(connectionId, topic);
      showStatus(topic ? T.topicSaved : T.topicCleared);
    } catch (e) {
      showStatus(T.topicSaveFailed, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function add() {
    var parsed = parseServerUrl($('host').value);
    if (parsed.error) { showStatus(T[parsed.error], true); return; }
    var host = parsed.host;
    var token = String($('token').value || '').trim();
    if (!token) { showStatus(T.tokenRequired, true); return; }
    var topic = String($('topic').value || '').trim();
    if (topic && !TOPIC_RE.test(topic)) { showStatus(T.invalidTopic, true); return; }

    var replacing = findByHost(host);
    $('add').disabled = true;
    showStatus(replacing ? T.confirmReplace : T.confirmAdd, true);
    try {
      var response = await fetch('/connections/' + KEY, {
        method: 'POST',
        body: JSON.stringify({ host: host, token: token }),
      });
      var data = null;
      try { data = await response.json(); } catch (e) { data = null; }
      if (!data || data.ok !== true) {
        var code = (data && (data.error || data.errorCode)) || '';
        showStatus(T.errors[code] || T.addFailed, true);
        return;
      }
      $('host').value = '';
      $('token').value = '';
      $('topic').value = '';
      syncEye();
      await load();
      var added = findByHost(host);
      if (topic && added) {
        try {
          await writeTopic(added.id, topic);
          await load();
        } catch (e) {
          showStatus(T.addedTopicFailed, true);
          return;
        }
      } else if (topic) {
        showStatus(T.addedTopicFailed, true);
        return;
      }
      showStatus((replacing ? T.replaced : T.added) + host);
    } catch (e) {
      showStatus(T.addFailed, true);
    } finally {
      $('add').disabled = false;
    }
  }

  async function remove(connectionId, btn) {
    btn.disabled = true;
    try {
      var response = await fetch('/connections/' + KEY + '/' + encodeURIComponent(connectionId), { method: 'DELETE' });
      if (response && response.ok === false) throw new Error('delete failed');
      try {
        await writeTopic(connectionId, '');
      } catch (e) {
        /* a stale topic entry is harmless: it is keyed by a connection id that no longer exists */
      }
      showStatus(T.removed);
    } catch (e) {
      showStatus(T.removeFailed, true);
      btn.disabled = false;
    } finally {
      void load();
    }
  }

  /** The eye only reveals what is being typed; a saved token can never be read back. */
  function syncEye() {
    var input = $('token');
    var eye = $('eye');
    var empty = String(input.value || '').length === 0;
    eye.classList.toggle('hidden', empty);
    if (empty) {
      input.type = 'password';
      eye.classList.remove('revealed');
    }
  }

  $('eye').addEventListener('click', function () {
    var input = $('token');
    var reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('eye').classList.toggle('revealed', reveal);
  });
  $('token').addEventListener('input', syncEye);
  $('add').addEventListener('click', function () { void add(); });
  $('host').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('token').focus(); }
  });
  $('token').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('topic').focus(); }
  });
  $('topic').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); void add(); }
  });
  syncEye();
  void loadLocale().then(load);
})();
