/* global cindy */
'use strict';
var OutlookMail = (() => {
  const CLOUDS = Object.freeze({
    global: { key: 'outlook_global', base: 'https://graph.microsoft.com/v1.0' },
  });
  const ACTIONS = ['search', 'read', 'send', 'draft', 'list_folders', 'mark_read', 'mark_unread', 'move'];
  const WRITES = ['send', 'draft', 'mark_read', 'mark_unread', 'move'];
  const SUMMARY = 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,isDraft,hasAttachments,parentFolderId,webLink,internetMessageId';
  class MailError extends Error {
    constructor(code, message, execution = 'not_executed') { super(message); this.code = code; this.execution = execution; }
  }
  const invalid = message => { throw new MailError('INVALID_ARGUMENT', message); };
  function text(value, name, max = 2048, empty = false) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) invalid(name + ' must be valid text; check the arguments.');
    return value;
  }
  function segment(value, name) {
    const s = text(value, name);
    if (s === '.' || s === '..' || /[\x00-\x1f\x7f]/.test(s)) invalid(name + ' is invalid; use the original ID returned by the plugin.');
    return encodeURIComponent(s);
  }
  function recipients(value, name) {
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : text(value, name, 20000).split(/[,;]/);
    if (values.length > 100) invalid(name + ' supports at most 100 addresses.');
    return values.map(v => {
      const address = text(v, name, 320).trim();
      if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address)) invalid(name + ' must be complete email addresses, without names or line breaks.');
      return { emailAddress: { address } };
    });
  }
  function date(value, name) {
    text(value, name, 40);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) invalid(name + ' must be an ISO date or a time with a time zone.');
    const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) invalid(name + ' is not a valid date.');
    const d = new Date(value);
    if (!Number.isFinite(d.getTime()) || (value.length === 10 && d.toISOString().slice(0, 10) !== value)) invalid(name + ' is not a valid date.');
    return d.toISOString();
  }
  function validate(a) {
    if (!a || !ACTIONS.includes(a.action)) invalid('Choose a supported mail action.');
    const fields = {
      search: ['query','from','subject','unread','since','before','folder','max_results','page_token'],
      list_folders: ['folder','max_results','page_token'],
      read: ['message_id'], send: ['to','cc','bcc','subject','body_text'], draft: ['to','cc','bcc','subject','body_text'],
      mark_read: ['message_id'], mark_unread: ['message_id'], move: ['message_id','target_folder'],
    };
    const allowed = ['action','cloud','account',...fields[a.action]];
    if (Object.keys(a).some(k => !allowed.includes(k))) invalid('This action includes arguments that do not apply; adjust them per the tool description. To choose the sender account, use account.');
    if (a.cloud !== undefined && !Object.hasOwn(CLOUDS, a.cloud)) invalid('cloud only supports global.');
    if (a.account !== undefined) text(a.account, 'account');
    if (a.max_results !== undefined && (!Number.isInteger(a.max_results) || a.max_results < 1 || a.max_results > 50)) invalid('max_results must be an integer from 1 to 50.');
    if (a.page_token !== undefined) {
      if (!['search', 'list_folders'].includes(a.action)) invalid('This action does not support pagination.');
      text(a.page_token, 'page_token', 24000);
      if (['query','from','subject','unread','since','before','folder','max_results'].some(k => a[k] !== undefined)) invalid('When continuing pagination, pass only action, account, cloud and page_token.');
    }
    if (['read','mark_read','mark_unread','move'].includes(a.action)) segment(a.message_id, 'message_id');
    if (a.folder !== undefined) segment(a.folder, 'folder');
    if (a.action === 'move') segment(a.target_folder, 'target_folder');
    if (a.action === 'search') {
      if (a.query !== undefined) {
        text(a.query, 'query', 1000);
        if (['from','subject','unread','since','before'].some(k => a[k] !== undefined)) invalid('Do not combine query with structured filters; put the conditions in the Microsoft KQL query instead.');
      }
      for (const k of ['from','subject']) if (a[k] !== undefined) text(a[k], k, 500);
      if (a.unread !== undefined && typeof a.unread !== 'boolean') invalid('unread must be a boolean.');
      for (const k of ['since','before']) if (a[k] !== undefined) date(a[k], k);
      if (a.since && a.before && date(a.since,'since') >= date(a.before,'before')) invalid('since must be earlier than before.');
    }
    if (['send','draft'].includes(a.action)) {
      text(a.subject,'subject',998,true); text(a.body_text,'body_text',200000,true);
      const total = ['to','cc','bcc'].map(k => recipients(a[k],k).length).reduce((x,y) => x+y,0);
      if (a.action === 'send' && total === 0) invalid('Sending mail requires at least one recipient.');
      if (total > 100) invalid('A single message supports at most 100 recipients.');
    }
  }
  async function local(path) {
    try {
      const r = await fetch(path);
      if (!r.ok) throw new Error('LOCAL_STATE_FAILED');
      return await r.json();
    } catch (_) {
      throw new MailError('LOCAL_STATE_FAILED','Unable to read plugin settings; reopen the plugin details page and retry.');
    }
  }
  async function accounts() {
    const entries = await local('/oauth');
    if (!Array.isArray(entries)) throw new MailError('LOCAL_STATE_FAILED','Account state is invalid; reopen the plugin details page.');
    return Object.entries(CLOUDS).map(([cloud,cfg]) => {
      const e = entries.find(e => e.key === cfg.key);
      return { cloud, configured: !!e?.clientConfigured, accounts: (e?.accounts || []).map(a => ({
        id:a.id, label:a.label, status:a.status, is_default:!!a.isDefault, needs_reauthorization:!!a.scopeStale,
      })) };
    });
  }
  async function choose(a) {
    const groups = await accounts();
    let cloud = a.cloud;
    if (a.account) {
      const found = groups.filter(g => (!cloud || g.cloud === cloud) && g.accounts.some(x => x.id === a.account));
      if (found.length !== 1) throw new MailError('ACCOUNT_NOT_FOUND','The account does not belong to the selected service region or does not exist; call outlook_accounts first.');
      cloud = found[0].cloud;
    }
    if (!cloud) {
      const cfg = await local('/kv') || {};
      cloud = Object.hasOwn(CLOUDS,cfg.default_cloud) ? cfg.default_cloud : 'global';
    }
    const g = groups.find(g => g.cloud === cloud);
    if (!g.configured) throw new MailError('CLIENT_NOT_CONFIGURED','No Microsoft application is configured for this region; set a Client ID in the plugin details page, then connect an account.');
    const account = a.account ? g.accounts.find(x => x.id === a.account) : g.accounts.find(x => x.is_default);
    if (!account) throw new MailError('ACCOUNT_NOT_CONNECTED','This region has no default account; connect one in the plugin details page and set it as default, or specify account explicitly.');
    if (account.status !== 'connected') throw new MailError('ACCOUNT_EXPIRED','The account authorization has expired; reconnect the same account in the plugin details page.');
    return { ...CLOUDS[cloud], cloud, account:account.id, is_default:account.is_default };
  }
  async function accountInfo(a,callId,transport) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => k !== 'profile_account')) invalid('Account lookup only supports the optional profile_account.');
    if (a.profile_account !== undefined) text(a.profile_account,'profile_account');
    const regions = await accounts();
    if (a.profile_account === undefined) return {regions};
    const ctx = await choose({account:a.profile_account});
    const data = await api({url:ctx.base+'/me?$select=mail,userPrincipalName',method:'GET'},ctx,callId,'profile',transport);
    if (![data.mail,data.userPrincipalName].every(v => v === null || typeof v === 'string')) throw new MailError('INVALID_RESPONSE','Microsoft did not return a complete account profile; query again.');
    return {regions,profile:{cloud:ctx.cloud,account:ctx.account,mail:data.mail,user_principal_name:data.userPrincipalName}};
  }
  function validPageUrl(raw,ctx,action) {
    let u; try { u = new URL(raw); } catch (_) { invalid('Invalid pagination URL; query again.'); }
    // Graph nextLink can use lowercase navigation names and OData key syntax.
    // Accept only the same /me collections; never follow /users or action URLs.
    const valid = action === 'search' ? /^\/v1\.0\/me\/(?:messages|mailFolders(?:\/[^/]+|\('[^'/]+'\))\/messages)$/i.test(u.pathname)
      : /^\/v1\.0\/me\/mailFolders(?:(?:\/[^/]+|\('[^'/]+'\))\/childFolders)?$/i.test(u.pathname);
    if (u.origin !== new URL(ctx.base).origin || u.username || u.password || u.hash || !valid) invalid('The pagination URL does not belong to the current mailbox region or action; query again.');
    return u.href;
  }
  function encodePage(url,ctx,action) {
    validPageUrl(url,ctx,action);
    const bytes = new TextEncoder().encode(JSON.stringify({url,cloud:ctx.cloud,account:ctx.account,action}));
    return btoa(Array.from(bytes,b => String.fromCharCode(b)).join(''));
  }
  function decodePage(token,ctx,action) {
    let p; try { p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token),c => c.charCodeAt(0)))); }
    catch (_) { invalid('Invalid page token; query again.'); }
    if (!p || p.cloud !== ctx.cloud || p.account !== ctx.account || p.action !== action) invalid('The page token does not match the account or action; query again.');
    return validPageUrl(p.url,ctx,action);
  }
  function build(a,ctx) {
    const method = ['mark_read','mark_unread'].includes(a.action) ? 'PATCH' : WRITES.includes(a.action) ? 'POST' : 'GET';
    let path, body;
    const q = new URLSearchParams();
    if (['search','list_folders'].includes(a.action)) {
      if (a.page_token) return {url:decodePage(a.page_token,ctx,a.action),method};
      path = a.action === 'list_folders'
        ? a.folder ? '/me/mailFolders/'+segment(a.folder,'folder')+'/childFolders' : '/me/mailFolders'
        : a.folder ? '/me/mailFolders/'+segment(a.folder,'folder')+'/messages' : '/me/messages';
      q.set('$top',String(a.max_results || 10));
      if (a.action === 'list_folders') q.set('$select','id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount');
      else {
        q.set('$select',SUMMARY);
        if (a.query !== undefined) q.set('$search',JSON.stringify(a.query));
        else {
          const filters = [];
          if (a.since) filters.push('receivedDateTime ge '+date(a.since,'since'));
          if (a.before) filters.push('receivedDateTime lt '+date(a.before,'before'));
          const quote = s => "'"+s.replace(/'/g,"''")+"'";
          if (a.from) filters.push('from/emailAddress/address eq '+quote(a.from));
          if (a.subject) filters.push('contains(subject,'+quote(a.subject)+')');
          if (a.unread !== undefined) filters.push('isRead eq '+!a.unread);
          if (filters.length) q.set('$filter',filters.join(' and '));
          // Graph requires ordered properties to lead the filter; do not add a hidden date cutoff.
          if (!filters.length || a.since || a.before) q.set('$orderby','receivedDateTime desc');
        }
      }
    } else if (['send','draft'].includes(a.action)) {
      const message = {subject:a.subject,body:{contentType:'Text',content:a.body_text},
        toRecipients:recipients(a.to,'to'),ccRecipients:recipients(a.cc,'cc'),bccRecipients:recipients(a.bcc,'bcc')};
      path = a.action === 'send' ? '/me/sendMail' : '/me/messages';
      body = a.action === 'send' ? {message,saveToSentItems:true} : message;
    } else {
      path = '/me/messages/'+segment(a.message_id,'message_id');
      if (a.action === 'read') q.set('$select',SUMMARY+',body,ccRecipients,bccRecipients,replyTo,conversationId');
      if (a.action === 'move') { path += '/move'; body = {destinationId:a.target_folder}; }
      if (['mark_read','mark_unread'].includes(a.action)) body = {isRead:a.action === 'mark_read'};
    }
    const request = {url:ctx.base+path+(q.size ? '?'+q : ''),method};
    if (body !== undefined) request.body = JSON.stringify(body);
    if (request.body && new TextEncoder().encode(request.body).length > 250000) invalid('Message is too large; shorten the body and retry (request limit is about 250 KB).');
    return request;
  }
  function failureMessage(status,code) {
    if (/MailboxNotEnabledForRESTAPI/.test(code)) return 'This account has no usable cloud mailbox; confirm an Exchange Online mailbox is assigned. On-premises Exchange and other providers cannot be connected through this plugin.';
    if (status === 401) return 'Microsoft authorization has expired; reconnect the account in the plugin details page.';
    if (status === 403) return 'Microsoft denied this operation; reconnect to grant mail read/write and send permissions. If it still fails, ask your organization administrator to check the application access policy.';
    if (status === 404) return 'Message or folder not found; query again and use the latest ID.';
    if (status === 429) return 'Microsoft is temporarily throttling requests; retry later.';
    if (status >= 500) return 'Microsoft mail service is temporarily unavailable; check the status later.';
    return 'Microsoft rejected the request (HTTP '+status+'); check the arguments, service region and mailbox permissions.';
  }
  async function api(request,ctx,callId,action,transport) {
    const write = WRITES.includes(action);
    let r;
    try { r = await transport({...request,callId,authAccount:ctx.account,as:'text',timeoutMs:30000,
      headers:{Accept:'application/json',Prefer:'outlook.body-content-type="text"',...(request.body ? {'Content-Type':'application/json'} : {})}}); }
    catch (_) { throw new MailError('REQUEST_FAILED','Connection interrupted; '+(write ? 'the outcome is unknown. Check the mailbox first and do not repeat the operation directly.' : 'check the network and retry.'),write ? 'unknown' : 'not_executed'); }
    if (!r.ok) throw new MailError('REQUEST_FAILED','The host could not complete the request; '+(write ? 'the outcome is unknown. Check the mailbox first and do not repeat the operation directly.' : 'check the account authorization and network, then retry.'),write ? 'unknown' : 'not_executed');
    if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599) throw new MailError('INVALID_RESPONSE','The host did not return a valid HTTP status; check the actual state in the mailbox.',write ? 'unknown' : 'not_executed');
    const success = r.status >= 200 && r.status < 300;
    const state = success && write ? 'executed' : write && (r.status >= 500 || r.status === 408) ? 'unknown' : 'not_executed';
    let data = null;
    if (!r.truncated && r.body) { try { data = JSON.parse(r.body); } catch (_) { /* checked below */ } }
    if (!success) throw new MailError('GRAPH_REQUEST_FAILED',failureMessage(r.status,typeof data?.error?.code === 'string' ? data.error.code : '')
      +(state === 'unknown' ? ' The outcome is unknown; check the mailbox first and do not repeat the operation directly.' : ''),state);
    if (action === 'send' && r.status === 202) return {accepted:true,delivery_confirmed:false,execution_status:'executed',note:'Microsoft accepted the send request; this does not mean the recipients have received it.'};
    if (r.truncated || !data || typeof data !== 'object' || Array.isArray(data)) throw new MailError('INVALID_RESPONSE',
      'Incomplete Microsoft response; '+(write ? 'the service accepted the operation. Check the mailbox first and do not repeat the operation directly.' : 'reduce max_results and query again.'),state);
    if (action === 'send') throw new MailError('UNEXPECTED_SEND_RESPONSE','Microsoft returned an unexpected send response; check Sent Items first and do not resend directly.','unknown');
    return data;
  }
  function summary(m) {
    return {id:m.id,subject:m.subject,from:m.from?.emailAddress,to:m.toRecipients?.map(r => r.emailAddress),
      received_at:m.receivedDateTime,preview:m.bodyPreview,is_read:m.isRead,is_draft:m.isDraft,
      has_attachments:m.hasAttachments,folder_id:m.parentFolderId,web_url:m.webLink,internet_message_id:m.internetMessageId};
  }
  async function run(a,callId,transport) {
    validate(a);
    const ctx = await choose(a);
    const data = await api(build(a,ctx),ctx,callId,a.action,transport);
    const common = {cloud:ctx.cloud,account:ctx.account};
    if (['search','list_folders'].includes(a.action)) {
      if (!Array.isArray(data.value)) throw new MailError('INVALID_RESPONSE','Microsoft returned an incomplete list; query again.');
      const page = data['@odata.nextLink'] ? encodePage(data['@odata.nextLink'],ctx,a.action) : null;
      if (a.action === 'search') return {...common,messages:data.value.map(summary),next_page_token:page,returned_count:data.value.length,search_limit:a.query ? 1000 : undefined};
      return {...common,folders:data.value.map(f => ({id:f.id,name:f.displayName,parent_id:f.parentFolderId,
        child_folder_count:f.childFolderCount,unread_count:f.unreadItemCount,total_count:f.totalItemCount})),next_page_token:page};
    }
    if (a.action === 'send') return {...common,...data};
    if (!data.id) throw new MailError('INVALID_RESPONSE','The Microsoft response is missing the message ID; check the mailbox state again.',WRITES.includes(a.action) ? 'executed' : 'not_executed');
    if (a.action === 'read') {
      const body = data.body?.content || '';
      return {...common,...summary(data),cc:data.ccRecipients?.map(r => r.emailAddress),bcc:data.bccRecipients?.map(r => r.emailAddress),
        body:body.slice(0,50000),body_content_type:data.body?.contentType,body_truncated:body.length > 50000,conversation_id:data.conversationId};
    }
    return {...common,execution_status:'executed',message:summary(data),...(a.action === 'move' ? {previous_id:a.message_id,note:'Use the returned new ID for further operations.'} : {})};
  }
  return {CLOUDS,MailError,validate,build,accounts,accountInfo,run,encodePage,decodePage,choose,text,segment,recipients,date};
})();
var OutlookCalendar = (() => {
  const {MailError,choose,text,segment,recipients,date} = OutlookMail;
  const CAL_SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite';
  const READS = ['list_calendars','list_events','get_event','search_events','free_busy'];
  const WRITES = ['create_event','update_event','delete_event','respond_event'];
  const ACTIONS = [...READS,...WRITES];
  const MAX_RANGE_DAYS = 92, MAX_FREE_BUSY_DAYS = 31, SEARCH_PAGE = 50, SEARCH_MAX_PAGES = 10;
  const DAY = 86400000;
  const EVENT_FIELDS = 'id,subject,start,end,isAllDay,location,organizer,attendees,isOnlineMeeting,onlineMeeting,webLink,showAs,responseStatus,isCancelled,isOrganizer,type,seriesMasterId,bodyPreview';
  const RESPONSES = {accept:['accept','Accept'],tentative:['tentativelyAccept','Tentative'],decline:['decline','Decline']};
  const FIELDS = {
    list_calendars:['max_results','page_token'],
    list_events:['calendar_id','start','end','time_zone','max_results','page_token'],
    search_events:['query','calendar_id','start','end','time_zone','max_results','page_token'],
    get_event:['event_id','time_zone'],
    free_busy:['start','end','time_zone','emails','interval_minutes'],
    create_event:['calendar_id','subject','start','end','time_zone','is_all_day','location','body_text','attendees','optional_attendees','is_online_meeting'],
    update_event:['event_id','subject','start','end','time_zone','is_all_day','location','body_text','attendees','optional_attendees','is_online_meeting'],
    delete_event:['event_id'],
    respond_event:['event_id','response','comment','send_response'],
  };
  const invalid = message => { throw new MailError('INVALID_ARGUMENT', message); };
  const strip = s => String(s ?? '').replace(/[\x00-\x1f\x7f]+/g,' ').trim();
  const clip = (s,n) => { s = strip(s); return s.length > n ? s.slice(0,n-1)+'…' : s; };
  function zone(value) {
    if (value === undefined) return 'UTC';
    text(value,'time_zone',64);
    // IANA (Europe/Lisbon) or Windows (E. South America Standard Time) names; never quotes or separators.
    if (!/^[A-Za-z][A-Za-z0-9 _+\-/().]{0,63}$/.test(value)) invalid('time_zone must be an IANA name such as America/Sao_Paulo or a Windows name such as E. South America Standard Time.');
    return value;
  }
  function range(a,maxDays) {
    if (a.start === undefined || a.end === undefined) invalid('start and end are required: an ISO date or a date-time with Z or an offset, e.g. 2026-11-02T00:00:00-03:00.');
    const start = date(a.start,'start'), end = date(a.end,'end');
    if (end <= start) invalid('end must be later than start.');
    if (Date.parse(end) - Date.parse(start) > maxDays*DAY) invalid('The time range can cover at most '+maxDays+' days; split it into smaller ranges.');
    return {start,end};
  }
  function localDateTime(value,name) {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
    if (!m || +m[2] > 23 || +m[3] > 59 || +(m[4] || 0) > 59) return null;
    const d = new Date(m[1]+'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== m[1]) invalid(name+' is not a valid date.');
    return m[1]+'T'+m[2]+':'+m[3]+':'+(m[4] || '00');
  }
  // Event times: local wall-clock time + time_zone, or an absolute time with Z/offset (sent as UTC).
  function eventTime(value,name,a) {
    text(value,name,40);
    if (a.is_all_day === true) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('All-day events need start and end as dates (YYYY-MM-DD); end is the day after the last day.');
      date(value,name);
      return {kind:'day',key:value,value:{dateTime:value+'T00:00:00',timeZone:zone(a.time_zone)}};
    }
    const local = localDateTime(value,name);
    if (local) {
      if (a.time_zone === undefined) invalid(name+' has no offset; pass time_zone (for example America/Sao_Paulo) or include Z or an offset in the time.');
      return {kind:'local',key:local,value:{dateTime:local,timeZone:zone(a.time_zone)}};
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(name+' needs a time; for a whole day set is_all_day to true.');
    const iso = date(value,name);
    return {kind:'instant',key:iso,value:{dateTime:iso.slice(0,19),timeZone:'UTC'}};
  }
  function eventSpan(a) {
    const s = eventTime(a.start,'start',a), e = eventTime(a.end,'end',a);
    if (s.kind !== e.kind) invalid('start and end must use the same form: both with an offset, or both local times with time_zone.');
    if (e.key <= s.key) invalid('end must be later than start.');
    return {start:s.value,end:e.value};
  }
  function validate(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !ACTIONS.includes(a.action)) invalid('Choose a supported calendar action.');
    const allowed = ['action','cloud','account',...FIELDS[a.action]];
    if (Object.keys(a).some(k => !allowed.includes(k))) invalid('This action includes arguments that do not apply; adjust them per the tool description.');
    if (a.cloud !== undefined && a.cloud !== 'global') invalid('cloud only supports global.');
    if (a.account !== undefined) text(a.account,'account');
    if (a.max_results !== undefined && (!Number.isInteger(a.max_results) || a.max_results < 1 || a.max_results > 50)) invalid('max_results must be an integer from 1 to 50.');
    if (a.page_token !== undefined) {
      text(a.page_token,'page_token',24000);
      if (Object.keys(a).some(k => !['action','cloud','account','page_token'].includes(k))) invalid('When continuing pagination, pass only action, account, cloud and page_token; the range, query and time zone travel in the token.');
      return;
    }
    if (a.time_zone !== undefined) zone(a.time_zone);
    for (const k of ['calendar_id','event_id']) if (a[k] !== undefined || (k === 'event_id' && FIELDS[a.action].includes(k))) segment(a[k],k);
    if (['list_events','search_events'].includes(a.action)) range(a,MAX_RANGE_DAYS);
    if (a.action === 'search_events') text(a.query,'query',200);
    if (a.action === 'free_busy') {
      range(a,MAX_FREE_BUSY_DAYS);
      if (a.emails !== undefined) {
        const n = recipients(a.emails,'emails').length;
        if (!n) invalid('emails must contain at least one address, or be omitted for your own calendar.');
        if (n > 20) invalid('free_busy supports at most 20 addresses.');
      }
      if (a.interval_minutes !== undefined && (!Number.isInteger(a.interval_minutes) || a.interval_minutes < 5 || a.interval_minutes > 1440)) invalid('interval_minutes must be an integer from 5 to 1440.');
    }
    if (['create_event','update_event'].includes(a.action)) {
      if (a.subject !== undefined) text(a.subject,'subject',255,a.action === 'update_event');
      if (a.location !== undefined) text(a.location,'location',500,true);
      if (a.body_text !== undefined) text(a.body_text,'body_text',100000,true);
      for (const k of ['is_all_day','is_online_meeting']) if (a[k] !== undefined && typeof a[k] !== 'boolean') invalid(k+' must be a boolean.');
      const total = recipients(a.attendees,'attendees').length + recipients(a.optional_attendees,'optional_attendees').length;
      if (total > 100) invalid('An event supports at most 100 attendees here.');
      if (a.action === 'create_event') {
        text(a.subject,'subject',255);
        eventSpan(a);
      } else {
        const timed = a.start !== undefined || a.end !== undefined;
        if (timed || a.is_all_day !== undefined) {
          if (a.start === undefined || a.end === undefined) invalid('To change the time, pass both start and end (and time_zone for local times).');
          eventSpan(a);
        } else if (a.time_zone !== undefined) invalid('time_zone applies to update_event only together with start and end.');
        if (!['subject','location','body_text','attendees','optional_attendees','is_online_meeting'].some(k => a[k] !== undefined) && !timed) invalid('Nothing to update; pass at least one field to change.');
      }
    }
    if (a.action === 'respond_event') {
      if (!Object.hasOwn(RESPONSES,a.response)) invalid('response must be accept, tentative or decline.');
      if (a.comment !== undefined) text(a.comment,'comment',2000,true);
      if (a.send_response !== undefined && typeof a.send_response !== 'boolean') invalid('send_response must be a boolean.');
    }
  }
  // Page tokens bind to cloud/account/action and carry the time zone (and search text) the
  // first page used, because nextLink keeps the query string but not the Prefer header.
  function validPageUrl(raw,ctx,action) {
    let u; try { u = new URL(raw); } catch (_) { invalid('Invalid pagination URL; query again.'); }
    const key = "(?:/[^/]+|\\('[^'/]+'\\))";
    const re = action === 'list_calendars' ? new RegExp('^/v1\\.0/me/calendars$','i')
      : new RegExp('^/v1\\.0/me(?:/calendars'+key+')?/calendarview$','i');
    if (u.origin !== new URL(ctx.base).origin || u.username || u.password || u.hash || !re.test(u.pathname)) invalid('The pagination URL does not belong to this account or action; query again.');
    return u.href;
  }
  function encodePage(url,ctx,action,extra) {
    validPageUrl(url,ctx,action);
    const bytes = new TextEncoder().encode(JSON.stringify({url,cloud:ctx.cloud,account:ctx.account,action,...extra}));
    return btoa(Array.from(bytes,b => String.fromCharCode(b)).join(''));
  }
  function decodePage(token,ctx,action) {
    let p; try { p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token),c => c.charCodeAt(0)))); }
    catch (_) { invalid('Invalid page token; query again.'); }
    if (!p || p.cloud !== ctx.cloud || p.account !== ctx.account || p.action !== action) invalid('The page token does not match the account or action; query again.');
    const tz = zone(p.tz);
    if (action === 'search_events') text(p.query,'query',200);
    return {url:validPageUrl(p.url,ctx,action),tz,query:p.query};
  }
  function failure(status,code,action,retryAfter) {
    if (status === 401) return ['RECONNECT_REQUIRED','Microsoft did not accept this account\'s authorization for the calendar. Reconnect the account in the Outlook (Rui) plugin details to grant calendar access.'];
    if (status === 403) return ['RECONNECT_REQUIRED','Microsoft denied calendar access. Calendar support needs a one-time reconnect: open the Outlook (Rui) plugin details and reconnect this account to grant calendar access. Work or school accounts may also need administrator approval.'
      +(action === 'free_busy' ? ' Free/busy lookup only works for work or school accounts and for people your organization lets you see.' : '')];
    if (status === 404) return ['NOT_FOUND','Event or calendar not found; list again and use the latest ID.'];
    if (status === 409 || status === 412) return ['CONFLICT','Microsoft reported a conflict with the current state of the event (HTTP '+status+'); get the event again and retry only if the user still wants the change.'];
    if (status === 429) return ['THROTTLED','Microsoft is throttling requests'+(retryAfter ? '; wait at least '+retryAfter+' seconds' : '; wait')+' before trying again. Nothing was changed.'];
    if (status >= 500 || status === 408) return ['SERVICE_UNAVAILABLE','Microsoft calendar service is temporarily unavailable (HTTP '+status+').'];
    if (action === 'free_busy' && status === 400) return ['GRAPH_REQUEST_FAILED','Microsoft rejected the free/busy request (HTTP 400'+(code ? ', '+code : '')+'). It only works for work or school accounts; check the addresses and time range.'];
    return ['GRAPH_REQUEST_FAILED','Microsoft rejected the request (HTTP '+status+(code ? ', '+code : '')+'); check the arguments, IDs and time zone.'];
  }
  function reportMissingScope(ctx) {
    // Host evidence channel: lets plugin settings show "reconnect" for the default account.
    if (!ctx.is_default) return;
    try {
      Promise.resolve(fetch('/oauth/'+ctx.key+'/insufficient-scopes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scopes:[CAL_SCOPE]})})).catch(() => {});
    } catch (_) { /* best effort */ }
  }
  const UNKNOWN = ' The outcome is unknown; check the calendar first and do not repeat the operation directly.';
  async function api(request,ctx,callId,action,transport,tz,write) {
    const prefer = ['outlook.body-content-type="text"'];
    if (tz) prefer.unshift('outlook.timezone="'+tz+'"');
    let r;
    try { r = await transport({...request,callId,authAccount:ctx.account,as:'text',timeoutMs:30000,
      headers:{Accept:'application/json',Prefer:prefer.join(', '),...(request.body ? {'Content-Type':'application/json'} : {})}}); }
    catch (_) { throw new MailError('REQUEST_FAILED','Connection interrupted;'+(write ? UNKNOWN : ' check the network and retry.'),write ? 'unknown' : 'not_executed'); }
    if (!r || !r.ok) throw new MailError('REQUEST_FAILED','The host could not complete the request;'+(write ? UNKNOWN : ' check the account authorization and network, then retry.'),write ? 'unknown' : 'not_executed');
    if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599) throw new MailError('INVALID_RESPONSE','The host did not return a valid HTTP status; check the calendar for the actual state.',write ? 'unknown' : 'not_executed');
    const success = r.status >= 200 && r.status < 300;
    let data = null;
    if (!r.truncated && r.body) { try { data = JSON.parse(r.body); } catch (_) { /* checked below */ } }
    if (!success) {
      const state = write && (r.status >= 500 || r.status === 408) ? 'unknown' : 'not_executed';
      const code = typeof data?.error?.code === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(data.error.code) ? data.error.code : '';
      const ra = r.headers && (r.headers['retry-after'] ?? r.headers['Retry-After']);
      const retryAfter = /^\d{1,6}$/.test(String(ra ?? '')) ? Number(ra) : null;
      const [errCode,message] = failure(r.status,code,action,retryAfter);
      if (r.status === 403 && action !== 'free_busy') reportMissingScope(ctx);
      const err = new MailError(errCode,message+(state === 'unknown' ? UNKNOWN : ''),state);
      if (retryAfter !== null) err.retryAfter = retryAfter;
      throw err;
    }
    if (write && (r.status === 202 || r.status === 204)) return null;
    if (r.truncated || !data || typeof data !== 'object' || Array.isArray(data)) throw new MailError('INVALID_RESPONSE',
      'Incomplete Microsoft response; '+(write ? 'the service accepted the operation. Check the calendar first and do not repeat it directly.' : 'narrow the range or lower max_results and query again.'),write ? 'executed' : 'not_executed');
    return data;
  }
  const person = e => e?.emailAddress ? {name:e.emailAddress.name,address:e.emailAddress.address} : undefined;
  function shape(e) {
    return {id:e.id,subject:e.subject,start:e.start?.dateTime,end:e.end?.dateTime,time_zone:e.start?.timeZone,
      is_all_day:e.isAllDay,location:e.location?.displayName || undefined,organizer:person(e.organizer),
      attendees:Array.isArray(e.attendees) ? e.attendees.map(x => ({...person(x),type:x.type,response:x.status?.response})) : undefined,
      is_online_meeting:e.isOnlineMeeting,join_url:e.onlineMeeting?.joinUrl || undefined,web_link:e.webLink,show_as:e.showAs,
      response_status:e.responseStatus?.response,is_organizer:e.isOrganizer,is_cancelled:e.isCancelled || undefined,
      type:e.type,series_master_id:e.seriesMasterId || undefined};
  }
  function eventPath(ctx,a) { return ctx.base+'/me/events/'+segment(a.event_id,'event_id'); }
  function viewUrl(ctx,a,start,end,top) {
    const q = new URLSearchParams({startDateTime:start,endDateTime:end,$top:String(top),$select:EVENT_FIELDS,$orderby:'start/dateTime'});
    return ctx.base+'/me'+(a.calendar_id ? '/calendars/'+segment(a.calendar_id,'calendar_id') : '')+'/calendarView?'+q;
  }
  function matches(e,needle) {
    const hay = [e.subject,e.location?.displayName,e.bodyPreview,e.organizer?.emailAddress?.name,e.organizer?.emailAddress?.address,
      ...(Array.isArray(e.attendees) ? e.attendees.flatMap(x => [x.emailAddress?.name,x.emailAddress?.address]) : [])];
    return hay.some(v => typeof v === 'string' && v.toLowerCase().includes(needle));
  }
  function list(data) {
    if (!Array.isArray(data.value)) throw new MailError('INVALID_RESPONSE','Microsoft returned an incomplete list; query again.');
    return data.value;
  }
  async function reads(a,ctx,callId,transport,common) {
    if (a.action === 'list_calendars') {
      const url = a.page_token ? decodePage(a.page_token,ctx,a.action).url
        : ctx.base+'/me/calendars?'+new URLSearchParams({$top:String(a.max_results || 50),$select:'id,name,color,isDefaultCalendar,canEdit,owner'});
      const data = await api({url,method:'GET'},ctx,callId,a.action,transport,null,false);
      return {...common,calendars:list(data).map(c => ({id:c.id,name:c.name,is_default:c.isDefaultCalendar,can_edit:c.canEdit,owner:c.owner?.address,color:c.color})),
        next_page_token:data['@odata.nextLink'] ? encodePage(data['@odata.nextLink'],ctx,a.action,{}) : null};
    }
    if (a.action === 'get_event') {
      const tz = zone(a.time_zone);
      const e = await api({url:eventPath(ctx,a)+'?$select='+EVENT_FIELDS+',body',method:'GET'},ctx,callId,a.action,transport,tz,false);
      if (!e.id) throw new MailError('INVALID_RESPONSE','The Microsoft response is missing the event ID; query again.');
      const body = typeof e.body?.content === 'string' ? e.body.content : '';
      return {...common,time_zone:tz,event:{...shape(e),body:body.slice(0,20000),body_truncated:body.length > 20000}};
    }
    if (a.action === 'free_busy') {
      const tz = zone(a.time_zone), {start,end} = range(a,MAX_FREE_BUSY_DAYS);
      let emails = a.emails === undefined ? null : recipients(a.emails,'emails').map(x => x.emailAddress.address);
      if (!emails) {
        const me = await api({url:ctx.base+'/me?$select=mail,userPrincipalName',method:'GET'},ctx,callId,a.action,transport,null,false);
        if (typeof me.mail !== 'string' || !me.mail) throw new MailError('NO_MAILBOX_ADDRESS','This account has no mailbox address in its profile; pass emails explicitly.');
        emails = [me.mail];
      }
      const interval = a.interval_minutes || 30;
      const body = {schedules:emails,startTime:{dateTime:start.slice(0,19),timeZone:'UTC'},endTime:{dateTime:end.slice(0,19),timeZone:'UTC'},availabilityViewInterval:interval};
      const data = await api({url:ctx.base+'/me/calendar/getSchedule',method:'POST',body:JSON.stringify(body)},ctx,callId,a.action,transport,tz,false);
      return {...common,time_zone:tz,interval_minutes:interval,legend:'availability_view digits: 0 free, 1 tentative, 2 busy, 3 out of office, 4 working elsewhere',
        schedules:list(data).map(s => ({email:s.scheduleId,availability_view:s.availabilityView,error:s.error?.message ? clip(s.error.message,200) : undefined,
          items:Array.isArray(s.scheduleItems) ? s.scheduleItems.map(i => ({status:i.status,start:i.start?.dateTime,end:i.end?.dateTime,subject:i.subject,location:i.location})) : undefined}))};
    }
    // list_events / search_events over calendarView
    let url, tz, query;
    if (a.page_token) ({url,tz,query} = decodePage(a.page_token,ctx,a.action));
    else {
      tz = zone(a.time_zone); query = a.query;
      const {start,end} = range(a,MAX_RANGE_DAYS);
      url = viewUrl(ctx,a,start,end,a.action === 'search_events' ? SEARCH_PAGE : (a.max_results || 25));
    }
    if (a.action === 'list_events') {
      const data = await api({url,method:'GET'},ctx,callId,a.action,transport,tz,false);
      return {...common,time_zone:tz,events:list(data).map(shape),
        next_page_token:data['@odata.nextLink'] ? encodePage(data['@odata.nextLink'],ctx,a.action,{tz}) : null};
    }
    // Graph documents $search for messages and people, not events, so search filters calendarView pages here.
    const needle = query.toLowerCase(), want = a.max_results || 25, found = [];
    let scanned = 0, pages = 0, next = url;
    while (next && pages < SEARCH_MAX_PAGES && found.length < want) {
      const data = await api({url:next,method:'GET'},ctx,callId,a.action,transport,tz,false);
      const value = list(data);
      scanned += value.length; pages++;
      found.push(...value.filter(e => matches(e,needle)).map(shape));
      next = data['@odata.nextLink'] ? validPageUrl(data['@odata.nextLink'],ctx,a.action) : null;
    }
    return {...common,time_zone:tz,query,events:found,scanned_count:scanned,
      next_page_token:next ? encodePage(next,ctx,a.action,{tz,query}) : null,
      note:'Matches subject, location, body preview, organizer and attendees (case-insensitive) inside the range.'+(next ? ' More events remain in the range; pass next_page_token to keep searching.' : '')};
  }
  function eventBody(a) {
    const ev = {};
    if (a.subject !== undefined) ev.subject = a.subject;
    if (a.body_text !== undefined) ev.body = {contentType:'Text',content:a.body_text};
    if (a.location !== undefined) ev.location = {displayName:a.location};
    if (a.start !== undefined) { const s = eventSpan(a); ev.start = s.start; ev.end = s.end; }
    if (a.is_all_day !== undefined) ev.isAllDay = a.is_all_day;
    if (a.is_online_meeting !== undefined) ev.isOnlineMeeting = a.is_online_meeting;
    if (a.attendees !== undefined || a.optional_attendees !== undefined) {
      ev.attendees = [...recipients(a.attendees,'attendees').map(x => ({...x,type:'required'})),
        ...recipients(a.optional_attendees,'optional_attendees').map(x => ({...x,type:'optional'}))];
    }
    return ev;
  }
  function when(e) { return e?.start?.dateTime ? e.start.dateTime.slice(0,16).replace('T',' ')+' '+(e.start.timeZone || '') : ''; }
  // Host confirm body limit is 300 characters, so warnings come first and details are clipped.
  function confirmText(a,ev,current) {
    const subject = clip(ev.subject ?? current?.subject ?? '(no subject)',60);
    const invited = (ev.attendees || []).map(x => x.emailAddress.address);
    const existing = Array.isArray(current?.attendees) ? current.attendees.length : 0;
    let warn = '', head, button, danger = false;
    if (a.action === 'create_event') {
      if (invited.length) warn = 'This SENDS a meeting invitation to '+invited.length+' attendee(s): '+clip(invited.join(', '),90)+'. ';
      head = 'Create event "'+subject+'" '+ev.start.dateTime.slice(0,16).replace('T',' ')+' '+ev.start.timeZone+'?';
      button = invited.length ? 'Send invite' : 'Create';
    } else if (a.action === 'update_event') {
      if (ev.attendees) warn = 'This REPLACES the attendee list and SENDS invitations/updates to '+invited.length+' attendee(s)'+(invited.length ? ': '+clip(invited.join(', '),70) : '')+'. ';
      else if (existing && current?.isOrganizer) warn = 'Outlook SENDS an update to the '+existing+' attendee(s) of this meeting. ';
      head = 'Update event "'+subject+'" ('+when(current)+'): change '+Object.keys(ev).join(', ')+'?';
      button = ev.attendees || (existing && current?.isOrganizer) ? 'Send update' : 'Save';
    } else if (a.action === 'delete_event') {
      if (existing && current?.isOrganizer) warn = 'You organize this meeting: deleting it SENDS a cancellation to '+existing+' attendee(s). ';
      else if (current && current.isOrganizer === false) warn = 'To tell the organizer you will not attend, use respond_event decline instead. ';
      head = 'Delete event "'+subject+'" ('+when(current)+')? This cannot be undone.';
      button = 'Delete'; danger = true;
    } else {
      const send = a.send_response !== false;
      head = RESPONSES[a.response][1]+' "'+subject+'" ('+when(current)+')? '+(send ? 'Your response is sent to the organizer.' : 'No response is sent to the organizer.');
      button = RESPONSES[a.response][1];
    }
    return {body:clip(warn+head,300),button,danger};
  }
  async function confirm(msg,spec) {
    if (typeof cindy === 'undefined' || typeof cindy.confirm !== 'function') throw new MailError('CONFIRM_UNAVAILABLE','Not executed: this Cindy version cannot show a confirmation dialog, so calendar changes are disabled. Update Cindy.');
    const req = {body:spec.body,confirmText:spec.button,cancelText:'Cancel',danger:spec.danger};
    if (msg && typeof msg.mobilePageId === 'string') req.mobilePageId = msg.mobilePageId;
    let answer;
    try { answer = await cindy.confirm(req); }
    catch (_) { throw new MailError('CONFIRM_UNAVAILABLE','Not executed: the confirmation dialog could not be shown. Try again in a few seconds.'); }
    if (!answer || answer.ok !== true) throw new MailError('CONFIRM_UNAVAILABLE','Not executed: the confirmation dialog could not be shown'+(answer?.errorCode === 'RATE_LIMITED' || answer?.errorCode === 'BUSY' ? ' (another dialog is open or one was shown seconds ago)' : '')+'. Try again in a few seconds.');
    if (answer.confirmed !== true) throw new MailError('CONFIRM_DECLINED','Not executed: the user declined the confirmation (or it timed out). Do not retry unless the user asks again.');
  }
  async function writes(a,ctx,callId,transport,common,msg) {
    const tz = a.time_zone !== undefined && a.action !== 'respond_event' && a.action !== 'delete_event' ? zone(a.time_zone) : 'UTC';
    let current = null;
    if (a.action !== 'create_event') {
      // Read first (no side effects) so the confirmation names the real event and its attendees.
      current = await api({url:eventPath(ctx,a)+'?$select=id,subject,start,end,attendees,isOrganizer',method:'GET'},ctx,callId,'get_event',transport,tz,false);
    }
    const ev = ['create_event','update_event'].includes(a.action) ? eventBody(a) : {};
    const spec = confirmText(a,ev,current);
    await confirm(msg,spec);
    let request;
    if (a.action === 'create_event') request = {url:ctx.base+'/me'+(a.calendar_id ? '/calendars/'+segment(a.calendar_id,'calendar_id') : '')+'/events',method:'POST',body:JSON.stringify(ev)};
    else if (a.action === 'update_event') request = {url:eventPath(ctx,a),method:'PATCH',body:JSON.stringify(ev)};
    else if (a.action === 'delete_event') request = {url:eventPath(ctx,a),method:'DELETE'};
    else request = {url:eventPath(ctx,a)+'/'+RESPONSES[a.response][0],method:'POST',body:JSON.stringify({...(a.comment !== undefined ? {comment:a.comment} : {}),sendResponse:a.send_response !== false})};
    if (request.body && new TextEncoder().encode(request.body).length > 250000) invalid('Event is too large; shorten the body.');
    const data = await api(request,ctx,callId,a.action,transport,tz,true);
    const invites = (ev.attendees || []).length;
    if (a.action === 'delete_event') return {...common,execution_status:'executed',deleted:true,event_id:a.event_id};
    if (a.action === 'respond_event') return {...common,execution_status:'executed',response:a.response,response_sent:a.send_response !== false,event_id:a.event_id};
    if (!data || !data.id) throw new MailError('INVALID_RESPONSE','Microsoft accepted the change but returned no event; check the calendar first and do not repeat it directly.','executed');
    return {...common,execution_status:'executed',time_zone:tz,event:shape(data),
      ...(invites ? {invitations_sent_to:invites} : {})};
  }
  async function run(a,callId,transport,msg) {
    validate(a);
    const ctx = await choose(a);
    const common = {cloud:ctx.cloud,account:ctx.account};
    return READS.includes(a.action) ? reads(a,ctx,callId,transport,common) : writes(a,ctx,callId,transport,common,msg);
  }
  return {CAL_SCOPE,validate,run,encodePage,decodePage,MAX_RANGE_DAYS};
})();
// OAuth, token refresh and Authorization injection belong to the Host.
// The plugin receives account metadata only; every mail request uses cindy.fetch.
if (typeof cindy !== 'undefined') cindy.onHostMessage(async msg => {
  if (msg.type !== 'tool-call') return;
  try {
    let result;
    if (msg.tool === 'outlook_accounts') result = await OutlookMail.accountInfo(msg.args || {},msg.callId,req=>cindy.fetch(req));
    else if (msg.tool === 'outlook_mail') result = await OutlookMail.run(msg.args || {},msg.callId,req=>cindy.fetch(req));
    else if (msg.tool === 'outlook_calendar') result = await OutlookCalendar.run(msg.args || {},msg.callId,req=>cindy.fetch(req),msg);
    else throw new OutlookMail.MailError('UNKNOWN_MAIL_TOOL','Unknown mail tool; reload the plugin tool list.');
    await cindy.send({type:'tool-result',callId:msg.callId,ok:true,result});
  } catch (err) {
    const known = err instanceof OutlookMail.MailError;
    const execution = known ? err.execution : 'unknown';
    const place = msg.tool === 'outlook_calendar' ? 'calendar' : 'mailbox';
    const message = execution === 'unknown' ? 'The outcome is uncertain; check the '+place+' first for its actual state and do not repeat the operation directly.'
      : execution === 'executed' ? 'The service accepted the operation, but the result was not returned completely; check the '+place+' first for its actual state and do not repeat the operation directly.' : err.message;
    await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:known ? err.code : 'MAIL_OPERATION_FAILED',
      message:'[execution_status='+execution+'] '+message});
  }
});
