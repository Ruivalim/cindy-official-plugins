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
    return { ...CLOUDS[cloud], cloud, account:account.id };
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
  return {CLOUDS,MailError,validate,build,accounts,accountInfo,run,encodePage,decodePage};
})();
// OAuth, token refresh and Authorization injection belong to the Host.
// The plugin receives account metadata only; every mail request uses cindy.fetch.
if (typeof cindy !== 'undefined') cindy.onHostMessage(async msg => {
  if (msg.type !== 'tool-call') return;
  try {
    let result;
    if (msg.tool === 'outlook_accounts') result = await OutlookMail.accountInfo(msg.args || {},msg.callId,req=>cindy.fetch(req));
    else if (msg.tool === 'outlook_mail') result = await OutlookMail.run(msg.args || {},msg.callId,req=>cindy.fetch(req));
    else throw new OutlookMail.MailError('UNKNOWN_MAIL_TOOL','Unknown mail tool; reload the plugin tool list.');
    await cindy.send({type:'tool-result',callId:msg.callId,ok:true,result});
  } catch (err) {
    const known = err instanceof OutlookMail.MailError;
    const execution = known ? err.execution : 'unknown';
    const message = execution === 'unknown' ? 'The outcome is uncertain; check the mailbox first for its actual state and do not repeat the operation directly.'
      : execution === 'executed' ? 'The service accepted the operation, but the result was not returned completely; check the mailbox first for its actual state and do not repeat the operation directly.' : err.message;
    await cindy.send({type:'tool-result',callId:msg.callId,ok:false,errorCode:known ? err.code : 'MAIL_OPERATION_FAILED',
      message:'[execution_status='+execution+'] '+message});
  }
});
