/**
 * Gitea settings page script (loaded externally; CSP forbids inline script).
 * Data plane, all same-origin:
 *   GET    /app-context                    -> { context: { locale } } (only language source)
 *   GET    /connections                    -> [{ key, connections: [{ id, host, isDefault, tail }] }]
 *   POST   /connections/gitea_conn         { host, token } -> host confirms and stores the token
 *   DELETE /connections/gitea_conn/<id>
 *   POST   /connections/gitea_conn/default { connectionId }
 *   GET/PUT /kv                            -> { connectedUsers: { <connectionId>: login } } display cache
 *   GET    /wake                           -> wake the logic page
 * "Test" posts { type: 'test-connection', reqId, connectionId } on the
 * BroadcastChannel and waits for the matching test-connection-result.
 */
(function () {
  'use strict';

  var KEY = 'gitea_conn';
  var bc = new BroadcastChannel('gitea');

  // The UI ships in English only; other host locales fall back to it.
  var STRINGS = {
    en: {
      title: 'Gitea instances',
      badge: 'Self-hosted',
      help: 'Create a token in Gitea under Settings > Applications. Reads need read:user, read:repository, read:issue and read:notification; writes also need write:issue and write:repository. Only https on port 443 is supported.',
      hostPlaceholder: 'Instance, e.g. git.example.com or https://git.example.com',
      tokenPlaceholder: 'Access token',
      add: 'Add',
      empty: 'No Gitea instance added yet.',
      tail: 'ends in ',
      isDefault: 'Default',
      makeDefault: 'Make default',
      test: 'Test',
      remove: 'Remove',
      loadFailed: 'Could not load the instance list. Try again.',
      needHost: 'Enter the instance address first (for example git.example.com).',
      needToken: 'Paste an access token first.',
      onlyHttps: 'Only https instances are supported.',
      onlyPort443: 'Only the default https port 443 is supported.',
      noPath: 'Enter only the host. Gitea under a sub-path is not supported.',
      badHost: 'That does not look like a host name.',
      confirmAdd: 'Confirm adding the instance in the system dialog...',
      confirmReplace: 'This instance already exists; confirm replacing its token in the system dialog...',
      added: 'Added ',
      replaced: 'Replaced the token for ',
      addFailed: 'Could not add the instance',
      testing: 'Contacting Gitea...',
      testOk: 'Connected as @',
      testTimeout: 'Test timed out: the plugin did not answer. Try again.',
      testFailed: 'Connection failed.',
      removed: 'Removed.',
      removeFailed: 'Could not remove the instance. Try again.',
      defaultFailed: 'Could not change the default. Try again.',
      errors: {
        INVALID_HOST: 'Invalid instance address: use a bare host such as git.example.com (https, port 443).',
        INVALID_TOKEN: 'The token is empty or malformed; paste it again.',
        TOKEN_TOO_LONG: 'The token is too long; check what was pasted.',
        INVALID_LABEL: 'Invalid label.',
        LIMIT: 'Instance limit reached (8). Remove one first.',
        CONFIRM_DENIED: 'Cancelled: the system dialog was not confirmed.',
        VAULT_WRITE_FAILED: 'Saving the token failed. Try again.',
      },
    },
  };
  var T = STRINGS.en;

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  async function loadLocale() {
    var locale = 'en';
    try {
      var ctx = await (await fetch('/app-context')).json();
      var requested = ctx && ctx.context && ctx.context.locale;
      if (typeof requested === 'string' && Object.prototype.hasOwnProperty.call(STRINGS, requested)) locale = requested;
    } catch (e) { /* English fallback */ }
    T = STRINGS[locale];
    if (document.documentElement) document.documentElement.lang = locale;
    $('title').textContent = T.title;
    $('badge').textContent = T.badge;
    $('help').textContent = T.help;
    $('host').placeholder = T.hostPlaceholder;
    $('token').placeholder = T.tokenPlaceholder;
    $('add').textContent = T.add;
  }

  var currentConns = [];

  function miniButton(label, onClick) {
    var b = document.createElement('button');
    b.className = 'mini';
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', function () { onClick(b); });
    return b;
  }

  function renderList(conns, users) {
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
      row.className = 'account';
      var who = document.createElement('span');
      who.className = 'who';
      who.textContent = cn.host;
      var user = users && users[cn.id];
      if (user) {
        var u = document.createElement('span');
        u.className = 'user';
        u.textContent = ' @' + user;
        who.appendChild(u);
      }
      row.appendChild(who);
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = cn.tail ? T.tail + cn.tail : '';
      row.appendChild(tag);
      if (cn.isDefault) {
        var badge = document.createElement('span');
        badge.className = 'default-badge';
        badge.textContent = T.isDefault;
        row.appendChild(badge);
      } else {
        row.appendChild(miniButton(T.makeDefault, function () { void setDefault(cn.id); }));
      }
      row.appendChild(miniButton(T.test, function (b) { void test(cn.id, b); }));
      row.appendChild(miniButton(T.remove, function () { void remove(cn.id); }));
      box.appendChild(row);
    });
  }

  async function load() {
    try {
      var conns = [];
      var list = await (await fetch('/connections')).json();
      if (Array.isArray(list)) {
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].key === KEY) {
            conns = Array.isArray(list[i].connections) ? list[i].connections : [];
            break;
          }
        }
      }
      currentConns = conns;
      var users = null;
      try {
        var kv = await (await fetch('/kv')).json();
        if (kv && typeof kv.connectedUsers === 'object') users = kv.connectedUsers;
      } catch (e) { /* only affects the @login decoration */ }
      renderList(conns, users);
    } catch (e) {
      showStatus(T.loadFailed);
    }
  }

  /**
   * Bare lowercase host, or { error }. Mirrors the logic page: https only,
   * port 443 only, no path.
   */
  function normalizeHost(raw) {
    var s = String(raw || '').trim();
    var scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
    if (scheme) {
      if (scheme[1].toLowerCase() !== 'https') return { error: T.onlyHttps };
      s = s.slice(scheme[0].length);
    }
    s = s.replace(/\/+$/, '');
    if (!s) return { host: '' };
    if (/[\/?#@\s]/.test(s)) return { error: T.noPath };
    var port = /:([^:]*)$/.exec(s);
    if (port) {
      if (port[1] !== '443') return { error: T.onlyPort443 };
      s = s.slice(0, s.length - port[0].length);
    }
    s = s.toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s)) return { error: T.badHost };
    return { host: s };
  }

  function findByHost(host) {
    for (var i = 0; i < currentConns.length; i++) {
      if (currentConns[i].host === host) return currentConns[i];
    }
    return null;
  }

  function syncEye() {
    var input = $('token');
    var eye = $('eye');
    var empty = input.value.length === 0;
    eye.classList.toggle('hidden', empty);
    if (empty) {
      input.type = 'password';
      eye.classList.remove('revealed');
    }
  }

  async function add() {
    var parsed = normalizeHost($('host').value);
    var token = $('token').value.trim();
    if (parsed.error) { showStatus(parsed.error, true); return; }
    var host = parsed.host;
    if (!host) { showStatus(T.needHost); return; }
    if (!token) { showStatus(T.needToken); return; }
    var replacing = findByHost(host);
    $('add').disabled = true;
    showStatus(replacing ? T.confirmReplace : T.confirmAdd, true);
    try {
      var r = await fetch('/connections/' + KEY, { method: 'POST', body: JSON.stringify({ host: host, token: token }) });
      var d = null;
      try { d = await r.json(); } catch (e) { /* non-JSON body counts as failure */ }
      if (d && d.ok === true) {
        $('host').value = '';
        $('token').value = '';
        syncEye();
        showStatus((replacing ? T.replaced : T.added) + host);
        await load();
        var added = findByHost(host);
        if (added) void test(added.id, null);
        return;
      }
      var code = (d && (d.error || d.errorCode)) || '';
      showStatus(T.errors[code] || (T.addFailed + ' (' + (code || r.status) + ').'), true);
    } catch (e) {
      showStatus(T.addFailed + '.', true);
    } finally {
      $('add').disabled = false;
    }
  }

  var testSeq = 0;
  async function test(connectionId, btn) {
    var reqId = 'test-' + Date.now() + '-' + (++testSeq);
    if (btn) btn.disabled = true;
    showStatus(T.testing, true);
    try { await fetch('/wake'); } catch (e) { /* resends below cover a slow wake */ }
    var settled = false;
    var timer = null;
    var deadline = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      showStatus(T.testTimeout, true);
      if (btn) btn.disabled = false;
      void load();
    }, 15000);
    bc.addEventListener('message', function onMsg(ev) {
      var m = ev && ev.data;
      if (!m || m.type !== 'test-connection-result' || m.reqId !== reqId || settled) return;
      settled = true;
      bc.removeEventListener('message', onMsg);
      clearTimeout(deadline);
      if (timer) clearInterval(timer);
      if (btn) btn.disabled = false;
      showStatus(m.ok ? T.testOk + (m.username || '') + ' (' + (m.host || '') + ')' : (m.message || T.testFailed), !m.ok);
      void load();
    });
    var send = function () { bc.postMessage({ type: 'test-connection', reqId: reqId, connectionId: connectionId }); };
    send();
    timer = setInterval(function () {
      if (settled) { clearInterval(timer); return; }
      send();
    }, 400);
  }

  async function remove(connectionId) {
    try {
      await fetch('/connections/' + KEY + '/' + encodeURIComponent(connectionId), { method: 'DELETE' });
      try {
        var kv = await (await fetch('/kv')).json();
        if (kv && typeof kv === 'object' && kv.connectedUsers && typeof kv.connectedUsers === 'object') {
          delete kv.connectedUsers[connectionId];
          await fetch('/kv', { method: 'PUT', body: JSON.stringify(kv) });
        }
      } catch (e) { /* stale display cache is harmless */ }
      showStatus(T.removed);
    } catch (e) {
      showStatus(T.removeFailed);
    } finally {
      void load();
    }
  }

  async function setDefault(connectionId) {
    try {
      await fetch('/connections/' + KEY + '/default', { method: 'POST', body: JSON.stringify({ connectionId: connectionId }) });
    } catch (e) {
      showStatus(T.defaultFailed);
    } finally {
      void load();
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
  $('token').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); void add(); }
  });
  $('host').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); $('token').focus(); }
  });
  syncEye();
  void loadLocale().then(load);
})();
