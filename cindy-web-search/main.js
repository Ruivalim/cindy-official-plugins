/**
 * Web Search · Cyberbrain: Cindy's built-in web search ghost (cindy + network slots).
 *
 * Each provider path is billed strictly separately:
 * - cindy: Cindy Desktop host proxies -> LiteLLM /v1/messages -> model-native Web Search,
 *   using Cindy AI quota;
 * - brave: network slot -> Brave, using the user's own Brave key;
 * - tavily: network slot -> Tavily, using the user's own Tavily key;
 * - deepseek: network slot -> DeepSeek Search API, using the user's own DeepSeek key.
 *
 * When no provider is given, only the plain preferences are read:
 * - cindyAiEnabled defaults to true -> cindy;
 * - once explicitly turned off -> byoDefaultProvider (defaults to brave).
 * Any failure is returned as-is, with no cross-provider fallback, so another set of
 * credentials is never silently consumed.
 */

/* global cindy */

var BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
var TAVILY_URL = 'https://api.tavily.com/search';
var DEEPSEEK_URL = 'https://api.deepseek.com/v1/tools/search';

function clampLimit(n) {
  var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 5;
  return Math.min(10, Math.max(1, v));
}

function isByoProvider(value) {
  return value === 'brave' || value === 'tavily' || value === 'deepseek';
}

async function readSearchPrefs() {
  var prefs = {
    cindyAiEnabled: true,
    byoDefaultProvider: 'brave',
  };
  var response = await fetch('/kv');
  if (!response.ok) throw new Error('Failed to read search preferences');
  var kv = await response.json();
  if (!kv || typeof kv !== 'object' || Array.isArray(kv)) {
    throw new Error('Search preferences have an invalid format');
  }
  if (typeof kv.cindyAiEnabled === 'boolean') prefs.cindyAiEnabled = kv.cindyAiEnabled;
  if (isByoProvider(kv.byoDefaultProvider)) {
    prefs.byoDefaultProvider = kv.byoDefaultProvider;
  }
  return prefs;
}

/** Cindy AI: the host pins the search model, tools and managed credentials; the plugin only passes the query intent. */
async function searchCindy(query, limit, callId, callerTool) {
  try {
    return await cindy.send({
      type: 'cindy-request',
      kind: 'search_web',
      query: query,
      limit: limit,
      provider: 'cindy',
      callId: callId,
      callerTool: callerTool,
    });
  } catch (e) {
    return {
      ok: false,
      errorCode: e && e.errorCode ? e.errorCode : 'INTERNAL',
      message: e && e.errorCode && typeof e.message === 'string'
        ? e.message
        : 'Cindy AI search is temporarily unavailable. Please try again later.',
    };
  }
}

/** Brave: GET + query params; the host injects the key as X-Subscription-Token. */
async function searchBrave(query, limit) {
  var url = BRAVE_URL + '?q=' + encodeURIComponent(query) + '&count=' + limit;
  var r = await cindy.fetch({ url: url, headers: { Accept: 'application/json' } });
  if (!r.ok) return r;
  if (r.status !== 200) {
    return { ok: false, message: 'Brave returned HTTP ' + r.status + ': ' + r.body.slice(0, 200) };
  }
  var data = JSON.parse(r.body);
  var items = (data.web && data.web.results) || [];
  return {
    ok: true,
    provider: 'brave',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.description || '' };
    }),
  };
}

/** Tavily BYO: POST JSON; the host injects the key as Authorization: Bearer. */
async function searchTavily(query, limit) {
  var r = await cindy.fetch({
    url: TAVILY_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query,
      max_results: limit,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    }),
  });
  if (!r.ok) return r;
  if (r.status !== 200) {
    return { ok: false, message: 'Tavily returned HTTP ' + r.status + ': ' + r.body.slice(0, 200) };
  }
  var data = JSON.parse(r.body);
  var items = data.results || [];
  return {
    ok: true,
    provider: 'tavily',
    results: items.slice(0, limit).map(function (it) {
      return { title: it.title, url: it.url, snippet: it.content || '' };
    }),
  };
}

function deepSeekFailure(errorCode) {
  var messages = {
    NOT_CONFIGURED: 'Configure a DeepSeek API Key in "Plugins" > "Web Search" details.',
    AUTH_REJECTED: 'The DeepSeek API Key is invalid. Update the key in "Plugins" > "Web Search" details.',
    PERMISSION_DENIED: 'The DeepSeek search request was not authorized. Check the Cindy authorization and the API permissions of your DeepSeek account.',
    QUOTA_EXHAUSTED: 'Your DeepSeek account balance is insufficient. Top up before searching again.',
    RATE_LIMITED: 'Too many DeepSeek search requests. Please try again later (at most 5 requests per second per account).',
    INVALID_INPUT: 'Invalid DeepSeek search parameters. Retry with a query of 1 to 128 Unicode characters.',
    UPSTREAM_UNAVAILABLE: 'DeepSeek search is temporarily unavailable. Check your network connection and try again later.',
    UPSTREAM_REJECTED: 'DeepSeek did not accept the search request. Check your account permissions or update the Web Search plugin, then try again.',
    RESPONSE_INVALID: 'DeepSeek returned search results with an invalid format or that are too large. Lower the number of results and try again.',
  };
  var code = typeof errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)
    ? errorCode : 'INTERNAL';
  return {
    ok: false,
    errorCode: code,
    message: messages[code] || 'The DeepSeek search request did not complete. Check your network connection and the Cindy authorization, and make sure a valid DeepSeek API Key is configured in "Plugins" > "Web Search" details.',
  };
}

/** Independent Search API; the Host alone injects the Bearer credential. */
async function searchDeepSeek(query, limit, callId) {
  // Count Unicode code points, not UTF-16 units (e.g. emoji count as one).
  if (Array.from(query).length > 128) return deepSeekFailure('INVALID_INPUT');
  var r;
  try {
    r = await cindy.fetch({
      url: DEEPSEEK_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, count: limit, need_content: false }),
      callId: callId,
    });
  } catch (e) {
    return deepSeekFailure(e && e.errorCode);
  }
  if (!r || !r.ok) return deepSeekFailure(r && r.errorCode);
  if (r.status !== 200) {
    var codes = {
      400: 'INVALID_INPUT',
      401: 'AUTH_REJECTED',
      402: 'QUOTA_EXHAUSTED',
      403: 'PERMISSION_DENIED',
      408: 'UPSTREAM_UNAVAILABLE',
      413: 'INVALID_INPUT',
      429: 'RATE_LIMITED',
    };
    return deepSeekFailure(codes[r.status] || (r.status >= 500 && r.status <= 599
      ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_REJECTED'));
  }
  // Do not parse truncated/oversized responses or pass upstream error bodies on.
  if (r.truncated || typeof r.body !== 'string' || r.body.length > 1000000) {
    return deepSeekFailure('RESPONSE_INVALID');
  }
  var data;
  try {
    data = JSON.parse(r.body);
  } catch (e) {
    return deepSeekFailure('RESPONSE_INVALID');
  }
  if (!data || !Array.isArray(data.results) || data.results.some(function (item) {
    return !item || typeof item.title !== 'string' || typeof item.url !== 'string'
      || typeof item.snippet !== 'string' || typeof item.summary !== 'string';
  })) return deepSeekFailure('RESPONSE_INVALID');
  return {
    ok: true,
    provider: 'deepseek',
    results: data.results.slice(0, limit).map(function (item) {
      return { title: item.title, url: item.url, snippet: item.summary || item.snippet };
    }),
  };
}

function searchByo(provider, query, limit, callId) {
  if (provider === 'deepseek') return searchDeepSeek(query, limit, callId);
  if (provider === 'tavily') return searchTavily(query, limit);
  return searchBrave(query, limit);
}

async function searchWeb(args, callId, callerTool) {
  var query = args && typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { ok: false, message: 'query must not be empty' };
  if (query.length > 2000) return { ok: false, message: 'query is too long (max 2000 characters)' };
  var limit = clampLimit(args.limit);
  var provider = args && args.provider;

  if (provider !== undefined && provider !== 'cindy' && !isByoProvider(provider)) {
    return { ok: false, message: 'provider only supports cindy / brave / tavily / deepseek' };
  }
  if (provider === 'cindy') return searchCindy(query, limit, callId, callerTool);
  if (isByoProvider(provider)) return searchByo(provider, query, limit, callId);

  var prefs;
  try {
    prefs = await readSearchPrefs();
  } catch (e) {
    return { ok: false, message: 'Failed to read search preferences. Try again later or choose a provider explicitly.' };
  }
  return prefs.cindyAiEnabled
    ? searchCindy(query, limit, callId, callerTool)
    : searchByo(prefs.byoDefaultProvider, query, limit, callId);
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (msg.tool !== 'search_web') {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: 'Unknown tool: ' + msg.tool });
    return;
  }
  try {
    var r = await searchWeb(msg.args || {}, msg.callId, msg.tool);
    if (r.ok) {
      cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: true,
        result: {
          provider: r.provider,
          results: r.results,
          note: 'Found ' + r.results.length + ' results via ' + r.provider,
        },
      });
    } else {
      cindy.send({
        type: 'tool-result',
        callId: msg.callId,
        ok: false,
        errorCode: r.errorCode,
        message: r.message,
      });
    }
  } catch (err) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      errorCode: err && err.errorCode ? err.errorCode : 'INTERNAL',
      message: 'Search failed: ' +(err && err.message ? err.message : String(err)),
    });
  }
});
