(function () {
  'use strict';

  var CHANNEL = 'icloud-mail-settings';
  var SECRET_KEYS = {
    a: 'icloud_mail_app_password',
    b: 'icloud_mail_app_password_b',
  };
  var channel = new BroadcastChannel(CHANNEL);
  var pending = {};

  function $(id) {
    return document.getElementById(id);
  }

  function requestId() {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Date.now()) + '-' + String(Math.random()).slice(2);
  }

  function showStatus(message, error) {
    $('status').textContent = message || '';
    $('status').classList.toggle('error', Boolean(error));
  }

  function setBusy(busy) {
    $('connect').disabled = busy;
    $('disconnect').disabled = busy;
    $('email').disabled = busy;
    $('appSpecificPassword').disabled = busy;
    $('toggleSecret').disabled = busy;
  }

  function render(state) {
    var connected = Boolean(state && state.connected);
    $('stateBadge').textContent = connected ? 'Connected' : 'Not connected';
    $('stateBadge').classList.toggle('connected', connected);
    $('connectedCard').hidden = !connected;
    $('connectForm').hidden = connected;
    $('connectedEmail').textContent = connected && state.email ? state.email : '';
  }

  async function readJson(path) {
    var response = await fetch(path);
    if (!response.ok) throw new Error('Failed to read the iCloud Mail configuration');
    return response.json();
  }

  async function loadState() {
    var values = await Promise.all([readJson('/kv'), readJson('/secrets')]);
    var kv = values[0] && typeof values[0] === 'object' && !Array.isArray(values[0])
      ? values[0]
      : {};
    var secretItems = Array.isArray(values[1]) ? values[1] : [];
    var email = typeof kv.email === 'string' ? kv.email.trim().toLowerCase() : '';
    var credentialSlot = kv.credentialSlot === 'b' ? 'b' : 'a';
    var savedSlots = { a: false, b: false };
    secretItems.forEach(function recordSavedSecret(item) {
      if (!item || item.saved !== true) return;
      if (item.key === SECRET_KEYS.a) savedSlots.a = true;
      if (item.key === SECRET_KEYS.b) savedSlots.b = true;
    });
    return {
      connected: Boolean(email && savedSlots[credentialSlot]),
      email: email || null,
      credentialSlot: credentialSlot,
      savedSlots: savedSlots,
    };
  }

  async function saveAccountState(email, credentialSlot) {
    var current = await readJson('/kv');
    var data = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    data.email = email;
    data.credentialSlot = credentialSlot;
    var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(data) });
    if (!response.ok) throw new Error('Failed to save the iCloud Mail connection state');
  }

  async function clearAccountState() {
    var current = await readJson('/kv');
    var data = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
    delete data.email;
    delete data.credentialSlot;
    var response = await fetch('/kv', { method: 'PUT', body: JSON.stringify(data) });
    if (!response.ok) throw new Error('Failed to clear the iCloud Mail connection state');
  }

  async function saveAppSpecificPassword(credentialSlot, value) {
    var response = await fetch('/secrets/' + SECRET_KEYS[credentialSlot], {
      method: 'PUT',
      body: JSON.stringify({ value: value }),
    });
    if (!response.ok) throw new Error('Failed to securely save the app-specific password');
  }

  async function removeAppSpecificPassword(credentialSlot) {
    var response = await fetch('/secrets/' + SECRET_KEYS[credentialSlot], { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to remove the app-specific password');
  }

  function sendConnect(email, credentialSlot, timeoutMs) {
    var reqId = requestId();
    var message = {
      type: 'settings-request',
      reqId: reqId,
      action: 'connect',
      payload: { email: email, credentialSlot: credentialSlot },
    };
    return new Promise(function (resolve, reject) {
      var settled = false;
      var retry = null;
      var deadline = setTimeout(function () {
        if (settled) return;
        settled = true;
        if (retry) clearInterval(retry);
        delete pending[reqId];
        reject(new Error('Timed out waiting for the connection. Make sure the plugin is enabled, then try again.'));
      }, timeoutMs || 20000);
      pending[reqId] = function finish(response) {
        if (settled) return;
        settled = true;
        if (retry) clearInterval(retry);
        clearTimeout(deadline);
        delete pending[reqId];
        if (response.ok) resolve(response.result || {});
        else reject(new Error(response.message || 'iCloud Mail operation failed'));
      };
      function beginPosting() {
        if (settled) return;
        channel.postMessage(message);
        retry = setInterval(function () {
          if (!settled) channel.postMessage(message);
        }, 400);
      }
      // The settings page wakes the browser main.js first; the message carries only the email address, never the app-specific password.
      void fetch('/wake').then(beginPosting, beginPosting);
    });
  }

  channel.addEventListener('message', function (event) {
    var message = event && event.data;
    if (!message || message.type !== 'settings-result' || !pending[message.reqId]) return;
    pending[message.reqId](message);
  });

  async function connect(event) {
    event.preventDefault();
    var email = $('email').value.trim().toLowerCase();
    var appSpecificPassword = $('appSpecificPassword').value.replace(/\s+/g, '');
    if (!email || !appSpecificPassword) {
      showStatus('Enter your iCloud Mail address and app-specific password', true);
      return;
    }
    setBusy(true);
    showStatus('Securely saving the app-specific password and testing the IMAP and SMTP connections...');
    $('appSpecificPassword').value = '';
    var previousState = null;
    var candidateSlot = 'a';
    var candidateStored = false;
    var commitStarted = false;
    try {
      previousState = await loadState();
      candidateSlot = previousState.savedSlots[previousState.credentialSlot]
        ? (previousState.credentialSlot === 'a' ? 'b' : 'a')
        : previousState.credentialSlot;
      await saveAppSpecificPassword(candidateSlot, appSpecificPassword);
      candidateStored = true;
      appSpecificPassword = '';
      var state = await sendConnect(email, candidateSlot, 50000);
      // The PUT response can get lost; once the commit starts, KV may already reference the candidate slot, so it must not be deleted anymore.
      commitStarted = true;
      await saveAccountState(email, candidateSlot);
      render({ connected: true, email: state.email || email });
      showStatus('Connected. Cindy has securely saved the app-specific password.');

      // Only after the new password is verified and committed, try to clear the old slot; a failed cleanup does not affect the new connection.
      if (
        previousState.credentialSlot !== candidateSlot
        && previousState.savedSlots[previousState.credentialSlot]
      ) {
        try {
          await removeAppSpecificPassword(previousState.credentialSlot);
        } catch (_removeOldError) {
          // The old slot is no longer referenced; it will be cleaned up again on the next connect or disconnect.
        }
      }
    } catch (error) {
      appSpecificPassword = '';
      // The candidate slot can only be cleaned up safely if the failure happened before the commit started.
      // When the commit outcome is unknown, keep both slots; the unused one is cleaned up on the next successful connect or disconnect.
      if (candidateStored && !commitStarted) {
        try {
          await removeAppSpecificPassword(candidateSlot);
        } catch (_removeError) {
          // A cleanup failure does not replace the original error; KV does not reference the candidate slot.
        }
      }
      render(previousState || { connected: false });
      showStatus(error && error.message ? error.message : 'Connection failed. Try again.', true);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    showStatus('');
    try {
      var state = await loadState();
      var inactiveSlot = state.credentialSlot === 'a' ? 'b' : 'a';
      if (state.savedSlots[inactiveSlot]) await removeAppSpecificPassword(inactiveSlot);
      if (state.savedSlots[state.credentialSlot]) {
        await removeAppSpecificPassword(state.credentialSlot);
      }
      await clearAccountState();
      render({ connected: false });
      showStatus('Disconnected and removed the app-specific password from Cindy secure storage.');
    } catch (error) {
      showStatus(error && error.message ? error.message : 'Disconnect failed. Try again.', true);
    } finally {
      setBusy(false);
    }
  }

  function toggleSecret() {
    var input = $('appSpecificPassword');
    var reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    $('toggleSecret').textContent = reveal ? 'Hide' : 'Show';
    $('toggleSecret').setAttribute(
      'aria-label',
      reveal ? 'Hide app-specific password' : 'Show app-specific password',
    );
  }

  $('connectForm').addEventListener('submit', function (event) { void connect(event); });
  $('disconnect').addEventListener('click', function () { void disconnect(); });
  $('toggleSecret').addEventListener('click', toggleSecret);

  void (async function init() {
    try {
      var state = await loadState();
      if (state.email) $('email').value = state.email;
      render(state);
    } catch (_error) {
      render({ connected: false });
      showStatus('Could not read the saved connection state right now', true);
    }
  })();
})();
