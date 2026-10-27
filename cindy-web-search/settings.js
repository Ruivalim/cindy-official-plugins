/**
 * Web Search settings page script (CSP forbids inline scripts, so it is loaded externally).
 * Plain preferences are stored via /kv, only as overrides that differ from the code defaults.
 * The credential data plane keeps using the host's write-only /secrets channel (absolute
 * path, protocol-reserved):
 *   GET /secrets           → [{ key, saved, tail? }] (status + last-4 fingerprint only, never the value)
 *   PUT /secrets/<key>     → { value } one-way store (kept by the host with OS-level encryption)
 *   DELETE /secrets/<key>  → clear
 * All credentials (Brave / Tavily / DeepSeek) share one shape: row structure and copy come
 * from the data-* attributes in settings.html, and this script wires every .secret container
 * the same way. Values are accepted, not kept: on a successful save the input is cleared and
 * "Saved" lights up. The plaintext cannot be read back; to change a key, paste a new value
 * over it.
 */
(function () {
  'use strict';

  var statusTimer = null;
  var preferenceWriteQueue = Promise.resolve();
  var preferencesReady = false;
  var lastSavedPreferences = null;

  function showStatus(text) {
    var el = document.getElementById('status');
    el.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { el.textContent = ''; }, 2500);
  }

  async function readKv() {
    var response = await fetch('/kv');
    if (!response.ok) throw new Error('kv read failed');
    var value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('kv response invalid');
    }
    return value;
  }

  function isByoProvider(value) {
    return value === 'brave' || value === 'tavily' || value === 'deepseek';
  }

  function normalizePreferences(kv) {
    return {
      cindyAiEnabled: typeof kv.cindyAiEnabled === 'boolean' ? kv.cindyAiEnabled : true,
      byoDefaultProvider: isByoProvider(kv.byoDefaultProvider) ? kv.byoDefaultProvider : 'brave',
    };
  }

  function setPreferenceControlsDisabled(disabled) {
    document.getElementById('cindy-ai-enabled').disabled = disabled;
    document.getElementById('byo-default-provider').disabled = disabled;
  }

  function applyPreferences(preferences) {
    document.getElementById('cindy-ai-enabled').checked = preferences.cindyAiEnabled;
    document.getElementById('byo-default-provider').value = preferences.byoDefaultProvider;
  }

  async function loadPreferences() {
    try {
      var preferences = normalizePreferences(await readKv());
      applyPreferences(preferences);
      lastSavedPreferences = preferences;
      preferencesReady = true;
      setPreferenceControlsDisabled(false);
    } catch (e) {
      preferencesReady = false;
      setPreferenceControlsDisabled(true);
      showStatus('Failed to load search preferences. Please reopen the settings page.');
    }
  }

  function persistPreferences() {
    if (!preferencesReady) return;
    var nextPreferences = {
      cindyAiEnabled: document.getElementById('cindy-ai-enabled').checked,
      byoDefaultProvider: document.getElementById('byo-default-provider').value,
    };
    preferencesReady = false;
    setPreferenceControlsDisabled(true);
    preferenceWriteQueue = preferenceWriteQueue
      .then(async function savePreferences() {
        var kv = await readKv();
        if (nextPreferences.cindyAiEnabled) delete kv.cindyAiEnabled;
        else kv.cindyAiEnabled = false;
        if (nextPreferences.byoDefaultProvider === 'brave') delete kv.byoDefaultProvider;
        else kv.byoDefaultProvider = nextPreferences.byoDefaultProvider;
        var response = await fetch('/kv', {
          method: 'PUT',
          body: JSON.stringify(kv),
        });
        if (!response.ok) throw new Error('kv write failed');
        lastSavedPreferences = nextPreferences;
        showStatus('Search preferences saved');
      })
      .catch(function preferenceSaveFailed() {
        showStatus('Failed to save search preferences. Please try again.');
        if (lastSavedPreferences) applyPreferences(lastSavedPreferences);
      })
      .finally(function preferenceSaveFinished() {
        preferencesReady = true;
        setPreferenceControlsDisabled(false);
      });
  }

  /** Wiring context for one credential row (DOM refs + data-* copy). */
  function wireRow(root) {
    var key = root.getAttribute('data-key');
    var tailPrefix = root.getAttribute('data-tail-prefix') || '…';
    var emptyPh = root.getAttribute('data-empty-ph') || 'Paste key';
    var input = root.querySelector('.key-input');
    var eye = root.querySelector('.eye');
    var badge = root.querySelector('.badge');

    /**
     * saved = whether it is stored; tail = the last-4 fingerprint kept by the host (helps
     * recall which key was entered). The fingerprint goes straight into the input placeholder;
     * when the value is too short to yield one, fall back to the plain "Saved" copy.
     */
    function setSaved(saved, tail) {
      badge.className = saved ? 'badge on' : 'badge';
      input.placeholder = saved
        ? (tail ? tailPrefix + tail + '; paste a new value to replace' : 'Saved; paste a new value to replace')
        : emptyPh;
    }

    /**
     * The eye only helps check the new value being typed: a stored value can never be read
     * back, so on an empty input clicking it would do nothing, and it is hidden instead.
     * Hiding also resets the masked state, so the next paste is masked by default.
     */
    function syncEye() {
      var empty = input.value.length === 0;
      eye.classList.toggle('hidden', empty);
      if (empty) {
        input.type = 'password';
        eye.classList.remove('revealed');
      }
    }

    eye.addEventListener('click', function () {
      var reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      eye.classList.toggle('revealed', reveal);
    });
    input.addEventListener('input', syncEye);
    root.querySelector('.save').addEventListener('click', function () {
      var value = input.value.trim();
      if (!value) {
        showStatus('Paste a key before saving');
        return;
      }
      fetch('/secrets/' + key, { method: 'PUT', body: JSON.stringify({ value: value }) })
        .then(function (r) {
          if (r.status === 204) {
            // Burn after accepting: the value is stored one-way and the page keeps no
            // plaintext; the tail fingerprint is fetched back from /secrets.
            input.value = '';
            syncEye();
            setSaved(true, null);
            void load();
            showStatus('Credential saved');
          } else {
            showStatus('Save failed (' + r.status + '). Please try again.');
          }
        })
        .catch(function () { showStatus('Save failed. Please try again.'); });
    });
    root.querySelector('.clear').addEventListener('click', function () {
      fetch('/secrets/' + key, { method: 'DELETE' })
        .then(function (r) {
          if (r.status === 204) {
            input.value = '';
            syncEye();
            setSaved(false, null);
            showStatus('Credential cleared');
          } else {
            showStatus('Clear failed (' + r.status + '). Please try again.');
          }
        })
        .catch(function () { showStatus('Clear failed. Please try again.'); });
    });
    syncEye();
    return { key: key, setSaved: setSaved };
  }

  var rows = [];
  var nodes = document.querySelectorAll('.secret');
  for (var i = 0; i < nodes.length; i++) rows.push(wireRow(nodes[i]));

  async function load() {
    var list = null;
    try {
      var r = await fetch('/secrets');
      list = await r.json();
    } catch (e) {
      list = null;
    }
    for (var i = 0; i < rows.length; i++) {
      var entry = Array.isArray(list)
        ? list.filter(function (s) { return s && s.key === rows[i].key; })[0]
        : null;
      rows[i].setSaved(
        Boolean(entry && entry.saved),
        entry && typeof entry.tail === 'string' ? entry.tail : null,
      );
    }
  }

  document.getElementById('cindy-ai-enabled').addEventListener('change', persistPreferences);
  document.getElementById('byo-default-provider').addEventListener('change', persistPreferences);

  void loadPreferences();
  void load();
})();
