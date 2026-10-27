(function () {
  'use strict';
  var connecting = false;
  var KEY = 'gmail_account';
  var LABEL = 'Gmail';
  var $ = function (id) { return document.getElementById(id); };
  var REAUTH_MESSAGES = {
    'zh-CN': 'Google 授权已失效，请重新连接账号。',
    en: 'Your Google authorization has expired. Please reconnect your account.',
    ja: 'Google の認証が期限切れです。アカウントを再接続してください。',
    ko: 'Google 인증이 만료되었습니다. 계정을 다시 연결하세요.',
  };
  var CONNECT_UNKNOWN_MESSAGES = {
    'zh-CN': '无法确认连接结果，请重新打开插件详情核对账号状态，再决定是否重试。',
    en: 'Connection outcome is unknown. Reopen plugin details and check the account status before deciding whether to retry.',
    ja: '接続結果を確認できません。プラグインの詳細を開き直してアカウントの状態を確認してから、再試行するか判断してください。',
    ko: '연결 결과를 확인할 수 없습니다. 플러그인 상세 페이지를 다시 열어 계정 상태를 확인한 후 재시도 여부를 결정하세요.',
  };
  async function loadLocale() {
    var locale = 'en';
    var controller = new AbortController();
    var timeout = setTimeout(function abortLocaleRequest() {
      controller.abort();
    }, 2000);
    try {
      var response = await fetch('/app-context', { signal: controller.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json();
      var requested = result && result.context && result.context.locale;
      if (Object.prototype.hasOwnProperty.call(REAUTH_MESSAGES, requested)) locale = requested;
    } catch (_err) {
      locale = 'en';
    } finally {
      clearTimeout(timeout);
    }
    document.documentElement.lang = locale;
    $('reauth').textContent = REAUTH_MESSAGES[locale];
  }
  function status(text) { $('status').textContent = text; }
  function connectionUnknownMessage() {
    return CONNECT_UNKNOWN_MESSAGES[document.documentElement.lang] || CONNECT_UNKNOWN_MESSAGES.en;
  }
  function connectError(result) {
    var labels = {
      NO_CLIENT_CONFIG: 'The plugin is missing its OAuth client configuration. Update the plugin.',
      INVALID_CONFIG: 'Invalid OAuth configuration. Update the plugin.',
      CALLBACK_INVALID: 'Authorization callback verification failed. Try again.',
      EXCHANGE_FAILED: 'Google token exchange failed. Check the plugin version.',
      NETWORK: 'Could not connect to Google. Check your network and try again.',
      TIMEOUT: 'Timed out waiting for authorization. Try again.',
      CANCELLED: 'Authorization cancelled',
      ACCOUNT_LIMIT: 'Account limit reached',
      VAULT_WRITE_FAILED: 'Could not save the account. Try again.',
    };
    var code = result && result.error ? String(result.error) : '';
    var message = labels[code] || connectionUnknownMessage();
    var detail = result && result.detail ? String(result.detail).trim() : '';
    return detail ? message + ' (' + detail + ')' : message;
  }
  function render(entry) {
    window.renderGoogleAccounts(KEY, (entry && entry.accounts) || [], load, connect);
  }
  async function load() {
    try {
      var response = await fetch('/oauth');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var list = await response.json();
      if (!Array.isArray(list)) throw new Error('invalid response');
      var entry = list.find(function (item) { return item && item.key === KEY; });
      var accounts = await googleAccountMetadata.list(KEY, (entry && entry.accounts) || []);
      render({ accounts: accounts });
    } catch (_err) {
      render(null);
      status('Could not load the account status. Try again.');
    }
  }
  async function connect(target) {
      if (connecting) return;
      connecting = true;
      $('connect').disabled = true;
      status(target ? 'In the browser, select ' + (target.label || target.id) + ' to reauthorize this account.' : 'Browser opened. Complete the ' + LABEL + ' authorization…');
      try {
        var response = await fetch('/oauth/' + KEY + '/connect', { method: 'POST' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var result = await response.json();
      if (result.ok) {
        if (target && result.account && result.account.id !== target.id) {
          status('Connected ' + (result.account.label || result.account.id) + ', but that is not the selected account; ' + (target.label || target.id) + ' still needs to be reconnected.');
        } else {
          status('Connected ' + (result.account && result.account.label ? result.account.label : 'account'));
        }
      } else {
        status(connectError(result));
      }
      await load();
    } catch (_err) {
      status(connectionUnknownMessage());
    } finally {
      connecting = false;
      $('connect').disabled = false;
    }
  }
  $('connect').onclick = function () { void connect(); };
  void loadLocale().then(load);
})();
