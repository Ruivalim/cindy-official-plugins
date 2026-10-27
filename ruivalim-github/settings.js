/**
 * GitHub (Rui) settings page script (CSP forbids inline scripts, so it is loaded as a file).
 * Data plane:
 *   GET  /secrets                -> [{ key, saved, tail? }]
 *                                  (the PAT value can never be read back)
 *   PUT  /secrets/github_pat     -> { value } stored once (204)
 *   DELETE /secrets/github_pat   -> clear
 *   GET  /wake                   -> wake the brain (idempotent)
 * This unofficial copy has no host-managed GitHub login (gh-cli is reserved for the
 * official cindy-github id), so the pasted PAT is the only credential.
 * Test connection is relayed to the brain over BroadcastChannel('ruivalim-github'):
 *   send { type:'test-connection', reqId }, resent every 400ms per reqId until
 *   { type:'test-connection-result', reqId, ok, login, message } arrives; 15s timeout.
 */
(function () {
  'use strict';

  var KEY = 'github_pat';
  var bc = new BroadcastChannel('ruivalim-github');

  function $(id) { return document.getElementById(id); }

  var statusTimer = null;
  function showStatus(text, sticky) {
    $('status').textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (!sticky) statusTimer = setTimeout(function () { $('status').textContent = ''; }, 4000);
  }

  /** Render the saved PAT state (saved + tail fingerprint). */
  function renderTokenAccount(saved, tail) {
    var box = $('token-account');
    box.textContent = '';
    if (!saved) return;
    var row = document.createElement('div');
    row.className = 'account';
    var who = document.createElement('span');
    who.className = 'who';
    who.textContent = 'Token saved';
    row.appendChild(who);
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = tail ? 'ends in ' + tail : '';
    row.appendChild(tag);
    box.appendChild(row);
  }

  async function load() {
    try {
      var saved = false;
      var tail = '';
      var list = await (await fetch('/secrets')).json();
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === KEY) {
          saved = Boolean(list[i].saved);
          tail = list[i].tail || '';
        }
      }
      renderTokenAccount(saved, tail);
      // Make the single-credential meaning explicit on the input row: with a token saved, an
      // empty input reads like "add another one", but saving again replaces the only one.
      $('token').placeholder = saved ? 'Paste a new token to replace the current one' : 'Paste a personal access token';
      $('save').textContent = saved ? 'Replace' : 'Save';
      $('test').disabled = !saved;
      $('clear').disabled = !saved;
    } catch (e) {
      showStatus('Could not load the status, try again later');
    }
  }

  /**
   * The eye button only helps check the new value being typed. A saved value can never be
   * read back, so with an empty input it would do nothing; hide it so it is not mistaken for
   * a broken "show saved token" button. Hiding also resets to masked mode, so the next paste
   * is masked by default. (Same behavior as the xd-mivo settings page.)
   */
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

  async function save() {
    var input = $('token');
    var value = input.value.trim();
    if (!value) { showStatus('Paste a token first'); return; }
    $('save').disabled = true;
    try {
      var r = await fetch('/secrets/' + KEY, { method: 'PUT', body: JSON.stringify({ value: value }) });
      if (r.status !== 204) { showStatus('Save failed (' + r.status + '), try again', true); return; }
      input.value = '';
      syncEye();
      await load();
      // Saving only confirms the credential was stored, not that GitHub accepts it.
      showStatus('Token saved. Click "Test connection" to check it against GitHub');
    } catch (e) {
      showStatus('Save failed, try again', true);
    } finally {
      $('save').disabled = false;
    }
  }

  var testSeq = 0;
  async function test() {
    var reqId = 'test-' + Date.now() + '-' + (++testSeq);
    var btn = $('test');
    btn.disabled = true;
    showStatus('Checking the GitHub connection...', true);
    try {
      await fetch('/wake');
    } catch (e) { /* if the wake call fails, the resend loop covers it */ }
    var settled = false;
    var timer = null;
    var deadline = setTimeout(function () {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      showStatus('Test timed out: the brain did not respond, try again later', true);
      void load();
    }, 15000);
    bc.addEventListener('message', function onMsg(ev) {
      var m = ev && ev.data;
      if (!m || m.type !== 'test-connection-result' || m.reqId !== reqId) return;
      if (settled) return;
      settled = true;
      bc.removeEventListener('message', onMsg);
      clearTimeout(deadline);
      if (timer) clearInterval(timer);
      if (m.ok) {
        // Success is announced by a system notification (notify); do not repeat it in the
        // page, just clear the "Checking..." text.
        showStatus('');
      } else {
        // Keep failures in the page: a toast disappears after a few seconds and the reason
        // should stay visible while fixing it; notify is also rate limited to one per 5s, so
        // for quick retries the page is the only feedback.
        showStatus(m.message || 'Connection failed', true);
      }
      void load();
    });
    var send = function () { bc.postMessage({ type: 'test-connection', reqId: reqId }); };
    send();
    timer = setInterval(function () {
      if (settled) { clearInterval(timer); return; }
      send();
    }, 400);
  }

  async function clearToken() {
    $('clear').disabled = true;
    try {
      var response = await fetch('/secrets/' + KEY, { method: 'DELETE' });
      if (response.status !== 204) throw new Error('clear-failed');
      showStatus('Cleared');
    } catch (e) {
      showStatus('Clear failed, try again');
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
  $('save').addEventListener('click', function () { void save(); });
  $('test').addEventListener('click', function () { void test(); });
  $('clear').addEventListener('click', function () { void clearToken(); });
  $('token').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); void save(); }
  });
  syncEye();
  void load();
})();
