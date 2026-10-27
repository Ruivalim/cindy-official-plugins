import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../ruivalim-outlook-mail/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../../ruivalim-outlook-mail/ghost.json', import.meta.url)));
const BASE = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'https://graph.microsoft.com/Calendars.ReadWrite';
const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOi.secret-token-value';
const json = (data, status = 200, headers = {}) => ({ ok: true, status, headers, body: data === null ? '' : JSON.stringify(data) });
const fixture = () => [{ key: 'outlook_global', clientConfigured: true, accounts: [
  { id: 'g1', label: 'Primary', status: 'connected', isDefault: true },
  { id: 'g2', label: 'Second', status: 'connected', isDefault: false },
] }];
const event = (over = {}) => ({
  id: 'ev/1+=', subject: 'Planning', start: { dateTime: '2026-11-03T14:00:00.0000000', timeZone: 'America/Sao_Paulo' },
  end: { dateTime: '2026-11-03T15:00:00.0000000', timeZone: 'America/Sao_Paulo' }, isAllDay: false,
  location: { displayName: 'Room 1' }, organizer: { emailAddress: { name: 'Org', address: 'org@example.test' } },
  attendees: [{ emailAddress: { name: 'Ann', address: 'ann@example.test' }, type: 'required', status: { response: 'accepted' } }],
  isOnlineMeeting: true, onlineMeeting: { joinUrl: 'https://teams.example.test/join' }, webLink: 'https://outlook.example.test/ev',
  showAs: 'busy', responseStatus: { response: 'organizer' }, isOrganizer: true, type: 'singleInstance', bodyPreview: 'agenda',
  internalField: 'drop me', ...over,
});

// Each call to `reply` gets (request, index); default replies an empty list.
function harness({ accounts = fixture(), reply = () => json({ value: [] }), confirm = { ok: true, confirmed: true }, noConfirm = false } = {}) {
  const requests = [], results = [], locals = [], confirms = [];
  let listener;
  const cindy = {
    onHostMessage: (fn) => { listener = fn; },
    send: (r) => results.push(JSON.parse(JSON.stringify(r))),
    fetch: async (req) => {
      requests.push(req);
      const r = reply(req, requests.length - 1);
      if (r instanceof Error) throw r;
      return r;
    },
  };
  if (!noConfirm) cindy.confirm = async (spec) => { confirms.push(JSON.parse(JSON.stringify(spec))); if (confirm instanceof Error) throw confirm; return confirm; };
  const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, btoa, atob, Promise,
    fetch: async (path, init) => { locals.push({ path, init }); return { ok: true, json: async () => (path === '/oauth' ? accounts : {}) }; },
    cindy });
  vm.runInContext(source, context);
  return {
    requests, results, locals, confirms,
    writes: () => requests.filter((r) => r.method !== 'GET'),
    call: async (args, extra = {}) => { await listener({ type: 'tool-call', tool: 'outlook_calendar', args, callId: 'cal-call', ...extra }); return results.at(-1); },
  };
}
const range = { start: '2026-11-01T00:00:00-03:00', end: '2026-11-08T00:00:00-03:00' };
const create = { action: 'create_event', subject: 'Planning', start: '2026-11-03T14:00', end: '2026-11-03T15:00', time_zone: 'America/Sao_Paulo' };
const q = (req) => new URL(req.url).searchParams;

test('manifest requests calendar scope, declares confirm and the calendar tool, version bumped', () => {
  assert.equal(manifest.version, '1.1.0');
  assert.equal(manifest.confirm, true);
  const scopes = manifest.network.secrets[0].oauth.scopes;
  assert(scopes.includes(SCOPE));
  for (const s of ['openid', 'offline_access', 'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.Send']) assert(scopes.includes(s), s);
  const tool = manifest.tools.find((t) => t.name === 'outlook_calendar');
  assert(tool);
  assert.deepEqual(tool.parameters.properties.action.enum.slice().sort(),
    ['create_event', 'delete_event', 'free_busy', 'get_event', 'list_calendars', 'list_events', 'respond_event', 'search_events', 'update_event']);
  assert.match(tool.description, /SENDS invitations/);
  assert.match(tool.parameters.properties.attendees.description, /SENDS them an invitation/);
  assert(manifest.description.length <= 300 && manifest.whenToUse.length <= 300);
  for (const lang of ['en', 'zh-CN', 'ja', 'ko']) {
    const l = JSON.parse(fs.readFileSync(new URL('../../ruivalim-outlook-mail/' + manifest.locales[lang], import.meta.url)));
    assert(l.tools.outlook_calendar.description.length > 50, lang);
    assert(l.description.length <= 300 && l.whenToUse.length <= 300, lang);
    if (lang !== 'en') assert.notEqual(l.tools.outlook_calendar.description, JSON.parse(fs.readFileSync(new URL('../../ruivalim-outlook-mail/locales/en.json', import.meta.url))).tools.outlook_calendar.description);
  }
});

test('list_calendars trims fields and paginates through nextLink', async () => {
  const next = BASE + '/me/calendars?$skip=2';
  const h = harness({ reply: (req, i) => (i === 0
    ? json({ value: [{ id: 'c1', name: 'Calendar', isDefaultCalendar: true, canEdit: true, owner: { address: 'me@example.test' }, changeKey: 'x' }], '@odata.nextLink': next })
    : json({ value: [] })) });
  const r = await h.call({ action: 'list_calendars' });
  assert(r.ok, r.message);
  assert.deepEqual(r.result.calendars[0], { id: 'c1', name: 'Calendar', is_default: true, can_edit: true, owner: 'me@example.test' });
  assert.equal(h.requests[0].authAccount, 'g1'); assert.equal(h.requests[0].callId, 'cal-call');
  const r2 = await h.call({ action: 'list_calendars', page_token: r.result.next_page_token });
  assert(r2.ok); assert.equal(h.requests[1].url, next); assert.equal(r2.result.next_page_token, null);
});

test('list_events uses calendarView with UTC range, time zone header and explicit zone in result', async () => {
  const h = harness({ reply: () => json({ value: [event()] }) });
  const r = await h.call({ action: 'list_events', ...range, time_zone: 'America/Sao_Paulo', calendar_id: 'cal/2' });
  assert(r.ok, r.message);
  const req = h.requests[0];
  assert(req.url.startsWith(BASE + '/me/calendars/cal%2F2/calendarView?'));
  assert.equal(q(req).get('startDateTime'), '2026-11-01T03:00:00.000Z');
  assert.equal(q(req).get('endDateTime'), '2026-11-08T03:00:00.000Z');
  assert.equal(q(req).get('$top'), '25');
  assert.equal(q(req).get('$orderby'), 'start/dateTime');
  assert.match(req.headers.Prefer, /^outlook\.timezone="America\/Sao_Paulo"/);
  assert.equal(req.method, 'GET'); assert.equal(req.headers.Authorization, undefined);
  assert.equal(r.result.time_zone, 'America/Sao_Paulo');
  const e = r.result.events[0];
  assert.equal(e.id, 'ev/1+='); assert.equal(e.start, '2026-11-03T14:00:00.0000000'); assert.equal(e.time_zone, 'America/Sao_Paulo');
  assert.equal(e.location, 'Room 1'); assert.deepEqual(e.organizer, { name: 'Org', address: 'org@example.test' });
  assert.deepEqual(e.attendees[0], { name: 'Ann', address: 'ann@example.test', type: 'required', response: 'accepted' });
  assert.equal(e.join_url, 'https://teams.example.test/join'); assert.equal(e.show_as, 'busy'); assert.equal(e.response_status, 'organizer');
  assert.equal(e.internalField, undefined); assert.equal(e.bodyPreview, undefined);
});

test('time zone defaults to UTC and is stated in the result', async () => {
  const h = harness();
  const r = await h.call({ action: 'list_events', ...range });
  assert(r.ok); assert.equal(r.result.time_zone, 'UTC');
  assert.match(h.requests[0].headers.Prefer, /outlook\.timezone="UTC"/);
  assert(h.requests[0].url.startsWith(BASE + '/me/calendarView?'));
});

test('calendarView range is required, ordered, valid and capped at 92 days', async () => {
  const bad = [
    { action: 'list_events' }, { action: 'list_events', start: range.start },
    { action: 'list_events', start: '2026-11-08', end: '2026-11-01' }, { action: 'list_events', start: '2026-11-01', end: '2026-11-01' },
    { action: 'list_events', start: '2026-01-01', end: '2026-04-03T00:00:01Z' },
    { action: 'list_events', start: '2026-02-30', end: '2026-03-02' }, { action: 'list_events', start: 'tomorrow', end: '2026-03-02' },
    { action: 'list_events', start: '2026-11-01T10:00:00', end: '2026-11-02T10:00:00' },
    { action: 'search_events', ...range }, { action: 'search_events', ...range, query: '' },
    { action: 'list_events', ...range, time_zone: 'UTC", outlook.body-content-type="html' },
    { action: 'list_events', ...range, time_zone: '' }, { action: 'list_events', ...range, max_results: 51 },
    { action: 'list_events', ...range, bogus: 1 }, { action: 'list_events', ...range, cloud: 'china' },
    { action: 'free_busy', start: '2026-11-01', end: '2026-12-03' },
    { action: 'nope' },
  ];
  for (const args of bad) {
    const h = harness(); const r = await h.call(args);
    assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.message, /execution_status=not_executed/);
    assert.equal(h.requests.length, 0, JSON.stringify(args));
  }
  const h = harness();
  assert((await h.call({ action: 'list_events', start: '2026-01-01', end: '2026-04-03' })).ok, 'exactly 92 days is allowed');
});

test('page tokens keep the time zone, bind to account/action and reject hostile URLs', async () => {
  const next = BASE + "/me/calendars('c1')/calendarview?startDateTime=a&$skip=25";
  const h = harness({ reply: (req, i) => (i === 0 ? json({ value: [], '@odata.nextLink': next }) : json({ value: [] })) });
  const r = await h.call({ action: 'list_events', ...range, time_zone: 'Europe/Lisbon' });
  const token = r.result.next_page_token;
  assert(token);
  const r2 = await h.call({ action: 'list_events', page_token: token });
  assert(r2.ok); assert.equal(h.requests[1].url, next); assert.match(h.requests[1].headers.Prefer, /Europe\/Lisbon/); assert.equal(r2.result.time_zone, 'Europe/Lisbon');
  for (const args of [{ action: 'list_events', account: 'g2', page_token: token }, { action: 'search_events', page_token: token }, { action: 'list_events', page_token: token, time_zone: 'UTC' }]) {
    const n = h.requests.length; const bad = await h.call(args); assert.equal(bad.ok, false); assert.equal(h.requests.length, n);
  }
  for (const url of ['https://attacker.example.test/v1.0/me/calendarView', BASE + '/users/other/calendarView', BASE + '/me/events', BASE + '/me/calendarView#x', 'https://u:p@graph.microsoft.com/v1.0/me/calendarView']) {
    const h2 = harness();
    const forged = btoa(JSON.stringify({ url, cloud: 'global', account: 'g1', action: 'list_events', tz: 'UTC' }));
    const bad = await h2.call({ action: 'list_events', page_token: forged }); assert.equal(bad.ok, false, url); assert.equal(h2.requests.length, 0);
  }
});

test('search_events filters calendarView client-side across nextLink pages and returns a continuation', async () => {
  const pages = [
    { value: [event({ id: 'a', subject: 'Lunch' }), event({ id: 'b', subject: 'Budget review' })], '@odata.nextLink': BASE + '/me/calendarView?p=2' },
    { value: [event({ id: 'c', subject: 'Other', attendees: [{ emailAddress: { name: 'Budget Bot', address: 'bot@example.test' } }] })], '@odata.nextLink': BASE + '/me/calendarView?p=3' },
    { value: [event({ id: 'd', subject: 'budget again' })] },
  ];
  const h = harness({ reply: (req, i) => json(pages[i]) });
  const r = await h.call({ action: 'search_events', ...range, query: 'BUDGET', max_results: 2 });
  assert(r.ok, r.message);
  assert.deepEqual(r.result.events.map((e) => e.id), ['b', 'c']);
  assert.equal(r.result.scanned_count, 3); assert.equal(h.requests.length, 2);
  assert.equal(q(h.requests[0]).get('$search'), null); assert.equal(q(h.requests[0]).get('$top'), '50');
  assert(r.result.next_page_token);
  const r2 = await h.call({ action: 'search_events', page_token: r.result.next_page_token });
  assert(r2.ok); assert.equal(h.requests[2].url, BASE + '/me/calendarView?p=3'); assert.deepEqual(r2.result.events.map((e) => e.id), ['d']);
  assert.equal(r2.result.query, 'BUDGET'); assert.equal(r2.result.next_page_token, null);
});

test('get_event returns trimmed fields and body text with the zone', async () => {
  const h = harness({ reply: () => json(event({ body: { contentType: 'text', content: 'x'.repeat(20001) } })) });
  const r = await h.call({ action: 'get_event', event_id: 'ev/1+=', time_zone: 'Asia/Tokyo' });
  assert(r.ok);
  assert.equal(h.requests[0].url.split('?')[0], BASE + '/me/events/ev%2F1%2B%3D');
  assert.match(h.requests[0].headers.Prefer, /outlook\.timezone="Asia\/Tokyo"/);
  assert.equal(r.result.time_zone, 'Asia/Tokyo'); assert.equal(r.result.event.body.length, 20000); assert.equal(r.result.event.body_truncated, true);
});

test('free_busy uses the account address by default and posts getSchedule without confirmation', async () => {
  const h = harness({ reply: (req, i) => (i === 0 ? json({ mail: 'me@example.test', userPrincipalName: 'login@example.test' })
    : json({ value: [{ scheduleId: 'me@example.test', availabilityView: '0220', scheduleItems: [{ status: 'busy', start: { dateTime: '2026-11-03T10:00:00' }, end: { dateTime: '2026-11-03T11:00:00' }, subject: 'Busy' }] }] })) });
  const r = await h.call({ action: 'free_busy', start: '2026-11-03T08:00:00Z', end: '2026-11-03T18:00:00Z', time_zone: 'UTC', interval_minutes: 60 });
  assert(r.ok, r.message);
  assert.equal(h.confirms.length, 0);
  const body = JSON.parse(h.requests[1].body);
  assert.equal(h.requests[1].url, BASE + '/me/calendar/getSchedule');
  assert.deepEqual(body, { schedules: ['me@example.test'], startTime: { dateTime: '2026-11-03T08:00:00', timeZone: 'UTC' }, endTime: { dateTime: '2026-11-03T18:00:00', timeZone: 'UTC' }, availabilityViewInterval: 60 });
  assert.equal(r.result.schedules[0].availability_view, '0220'); assert.equal(r.result.schedules[0].items[0].status, 'busy');
  const none = harness({ reply: () => json({ mail: null, userPrincipalName: 'login@example.test' }) });
  const r2 = await none.call({ action: 'free_busy', start: '2026-11-03', end: '2026-11-04' });
  assert.equal(r2.errorCode, 'NO_MAILBOX_ADDRESS'); assert.doesNotMatch(r2.message, /login@example/);
});

test('create_event confirms first, then posts once with local times in the given zone', async () => {
  const h = harness({ reply: () => json(event({ id: 'new' }), 201) });
  const r = await h.call({ ...create, location: 'Room 1', body_text: 'Agenda', is_online_meeting: true, calendar_id: 'c1' }, { mobilePageId: 'page-1' });
  assert(r.ok, r.message);
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0].body, /Create event "Planning" 2026-11-03 14:00 America\/Sao_Paulo/);
  assert.doesNotMatch(h.confirms[0].body, /invitation/);
  assert.equal(h.confirms[0].confirmText, 'Create'); assert.equal(h.confirms[0].mobilePageId, 'page-1');
  assert(h.confirms[0].body.length <= 300 && h.confirms[0].confirmText.length <= 12);
  assert.equal(h.requests.length, 1);
  const req = h.requests[0];
  assert.equal(req.method, 'POST'); assert.equal(req.url, BASE + '/me/calendars/c1/events');
  assert.deepEqual(JSON.parse(req.body), { subject: 'Planning', body: { contentType: 'Text', content: 'Agenda' }, location: { displayName: 'Room 1' },
    start: { dateTime: '2026-11-03T14:00:00', timeZone: 'America/Sao_Paulo' }, end: { dateTime: '2026-11-03T15:00:00', timeZone: 'America/Sao_Paulo' }, isOnlineMeeting: true });
  assert.match(req.headers.Prefer, /outlook\.timezone="America\/Sao_Paulo"/);
  assert.equal(r.result.execution_status, 'executed'); assert.equal(r.result.event.id, 'new'); assert.equal(r.result.time_zone, 'America/Sao_Paulo');
});

test('create_event with attendees says plainly that invitations are sent', async () => {
  const h = harness({ reply: () => json(event({ id: 'new' }), 201) });
  const r = await h.call({ ...create, subject: 'S'.repeat(255), attendees: ['ann@example.test', 'bob@example.test'], optional_attendees: 'cy@example.test' });
  assert(r.ok, r.message);
  const c = h.confirms[0];
  assert.match(c.body, /^This SENDS a meeting invitation to 3 attendee\(s\): ann@example\.test, bob@example\.test, cy@example\.test/);
  assert(c.body.length <= 300); assert.equal(c.confirmText, 'Send invite');
  const body = JSON.parse(h.requests[0].body);
  assert.deepEqual(body.attendees.map((a) => [a.emailAddress.address, a.type]), [['ann@example.test', 'required'], ['bob@example.test', 'required'], ['cy@example.test', 'optional']]);
  assert.equal(r.result.invitations_sent_to, 3);
});

test('event time validation: offsets, all-day dates, end after start, same form', async () => {
  const bad = [
    { ...create, end: '2026-11-03T14:00' }, { ...create, end: '2026-11-03T13:00' },
    { ...create, time_zone: undefined }, { ...create, start: '2026-11-03T25:00' }, { ...create, start: '2026-02-30T10:00' },
    { ...create, start: '2026-11-03T14:00-03:00' }, { ...create, start: '2026-11-03', end: '2026-11-04' },
    { ...create, is_all_day: true }, { ...create, is_all_day: 'yes' }, { ...create, subject: '' },
    { ...create, attendees: 'Name <ann@example.test>' }, { ...create, attendees: Array.from({ length: 101 }, (_, i) => `a${i}@example.test`) },
    { action: 'update_event', event_id: 'e', start: '2026-11-03T10:00Z' }, { action: 'update_event', event_id: 'e' },
    { action: 'update_event', event_id: 'e', time_zone: 'UTC', subject: 'x' }, { action: 'update_event', event_id: '..', subject: 'x' },
    { action: 'respond_event', event_id: 'e', response: 'maybe' }, { action: 'respond_event', event_id: 'e', response: 'accept', send_response: 'no' },
    { action: 'delete_event' },
  ];
  for (const args of bad) {
    const h = harness(); const r = await h.call(args);
    assert.equal(r.ok, false, JSON.stringify(args)); assert.match(r.message, /not_executed/); assert.equal(h.requests.length, 0); assert.equal(h.confirms.length, 0);
  }
  const h = harness({ reply: () => json(event({ id: 'n' }), 201) });
  assert((await h.call({ action: 'create_event', subject: 'x', start: '2026-11-03T14:00:00Z', end: '2026-11-03T12:30:00-03:00' })).ok);
  assert.deepEqual(JSON.parse(h.requests[0].body).start, { dateTime: '2026-11-03T14:00:00', timeZone: 'UTC' });
  assert.deepEqual(JSON.parse(h.requests[0].body).end, { dateTime: '2026-11-03T15:30:00', timeZone: 'UTC' });
  assert((await h.call({ action: 'create_event', subject: 'Trip', is_all_day: true, start: '2026-12-24', end: '2026-12-26', time_zone: 'Europe/Lisbon' })).ok);
  const allDay = JSON.parse(h.requests[1].body);
  assert.equal(allDay.isAllDay, true); assert.deepEqual(allDay.start, { dateTime: '2026-12-24T00:00:00', timeZone: 'Europe/Lisbon' });
});

test('declined or unavailable confirmation sends no write request', async () => {
  for (const [confirm, code] of [[{ ok: true, confirmed: false }, 'CONFIRM_DECLINED'], [{ ok: false, errorCode: 'BUSY', message: 'x' }, 'CONFIRM_UNAVAILABLE'], [new Error('no window'), 'CONFIRM_UNAVAILABLE']]) {
    for (const args of [create, { action: 'update_event', event_id: 'e', subject: 'New' }, { action: 'delete_event', event_id: 'e' }, { action: 'respond_event', event_id: 'e', response: 'decline' }]) {
      const h = harness({ confirm, reply: () => json(event()) });
      const r = await h.call(args);
      assert.equal(r.ok, false); assert.equal(r.errorCode, code); assert.match(r.message, /not_executed/);
      assert.equal(h.writes().length, 0, JSON.stringify(args)); assert.equal(h.confirms.length, 1);
    }
  }
  const h = harness({ noConfirm: true });
  const r = await h.call(create);
  assert.equal(r.errorCode, 'CONFIRM_UNAVAILABLE'); assert.equal(h.requests.length, 0);
});

test('update_event reads the event, warns attendees get an update, then patches only the given fields', async () => {
  const h = harness({ reply: (req) => json(req.method === 'GET' ? event() : event({ subject: 'New name' })) });
  const r = await h.call({ action: 'update_event', event_id: 'ev/1+=', subject: 'New name', start: '2026-11-03T16:00', end: '2026-11-03T17:00', time_zone: 'America/Sao_Paulo' });
  assert(r.ok, r.message);
  assert.equal(h.requests[0].method, 'GET'); assert.equal(h.requests[1].method, 'PATCH'); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, BASE + '/me/events/ev%2F1%2B%3D');
  assert.deepEqual(Object.keys(JSON.parse(h.requests[1].body)).sort(), ['end', 'start', 'subject']);
  assert.match(h.confirms[0].body, /^Outlook SENDS an update to the 1 attendee\(s\)/);
  assert.equal(h.confirms[0].confirmText, 'Send update');
  const h2 = harness({ reply: (req) => json(event({ attendees: [] })) });
  await h2.call({ action: 'update_event', event_id: 'e', attendees: ['x@example.test'] });
  assert.match(h2.confirms[0].body, /^This REPLACES the attendee list and SENDS invitations\/updates to 1 attendee\(s\): x@example\.test/);
});

test('delete_event and respond_event: warnings, single request, 204/202 handled', async () => {
  const h = harness({ reply: (req) => (req.method === 'GET' ? json(event()) : json(null, 204)) });
  const r = await h.call({ action: 'delete_event', event_id: 'ev/1+=' });
  assert(r.ok, r.message); assert.equal(r.result.deleted, true);
  assert.match(h.confirms[0].body, /SENDS a cancellation to 1 attendee/); assert.equal(h.confirms[0].danger, true);
  assert.equal(h.writes().length, 1); assert.equal(h.writes()[0].method, 'DELETE');
  const a = harness({ reply: (req) => (req.method === 'GET' ? json(event({ isOrganizer: false })) : json(null, 202)) });
  const r2 = await a.call({ action: 'respond_event', event_id: 'ev/1+=', response: 'tentative', comment: 'Maybe', send_response: false });
  assert(r2.ok, r2.message);
  assert.equal(a.writes()[0].url, BASE + '/me/events/ev%2F1%2B%3D/tentativelyAccept');
  assert.deepEqual(JSON.parse(a.writes()[0].body), { comment: 'Maybe', sendResponse: false });
  assert.match(a.confirms[0].body, /No response is sent to the organizer/); assert.equal(a.confirms[0].confirmText, 'Tentative');
  assert.equal(r2.result.response_sent, false);
  const d = harness({ reply: (req) => (req.method === 'GET' ? json(event({ isOrganizer: false })) : json(null, 204)) });
  await d.call({ action: 'delete_event', event_id: 'e' });
  assert.match(d.confirms[0].body, /use respond_event decline instead/);
});

test('writes are never retried after 5xx, 408, timeout or host failure and report unknown', async () => {
  const failures = [() => json({ error: { code: 'ServiceUnavailable', message: 'private' } }, 503), () => json(null, 500), () => json(null, 408),
    () => new Error('timeout ' + TOKEN), () => ({ ok: false, message: 'private host detail' })];
  const writes = [create, { action: 'update_event', event_id: 'e', subject: 'x' }, { action: 'delete_event', event_id: 'e' }, { action: 'respond_event', event_id: 'e', response: 'accept' }];
  for (const fail of failures) for (const args of writes) {
    const h = harness({ reply: (req) => (req.method === 'GET' ? json(event()) : fail()) });
    const r = await h.call(args);
    assert.equal(r.ok, false); assert.match(r.message, /execution_status=unknown/); assert.match(r.message, /check the calendar first/);
    assert.equal(h.writes().length, 1, JSON.stringify(args)); assert.doesNotMatch(r.message, /private|secret-token/);
  }
});

test('reads failing on transport are not executed and not retried', async () => {
  const h = harness({ reply: () => new Error('boom') });
  const r = await h.call({ action: 'list_events', ...range });
  assert.match(r.message, /not_executed/); assert.equal(h.requests.length, 1);
});

test('401/403 map to reconnect guidance and 403 reports the missing scope for the default account only', async () => {
  for (const status of [401, 403]) {
    const h = harness({ reply: () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied ' + TOKEN } }, status) });
    const r = await h.call({ action: 'list_events', ...range });
    assert.equal(r.errorCode, 'RECONNECT_REQUIRED'); assert.match(r.message, /not_executed/);
    assert.match(r.message, /reconnect the account|reconnect this account/i); assert.match(r.message, /calendar access/);
    assert.doesNotMatch(r.message, /secret-token|Access is denied/);
    const reports = h.locals.filter((l) => l.path === '/oauth/outlook_global/insufficient-scopes');
    if (status === 403) {
      assert.equal(reports.length, 1); assert.equal(reports[0].init.method, 'POST'); assert.deepEqual(JSON.parse(reports[0].init.body), { scopes: [SCOPE] });
      assert.match(r.message, /administrator approval/);
    } else assert.equal(reports.length, 0);
  }
  const h = harness({ reply: () => json({ error: { code: 'ErrorAccessDenied' } }, 403) });
  await h.call({ action: 'list_events', ...range, account: 'g2' });
  assert.equal(h.locals.filter((l) => l.path.includes('insufficient-scopes')).length, 0);
});

test('a 403 while reading before a write stops before confirmation', async () => {
  const h = harness({ reply: () => json({ error: { code: 'ErrorAccessDenied' } }, 403) });
  const r = await h.call({ action: 'delete_event', event_id: 'e' });
  assert.equal(r.errorCode, 'RECONNECT_REQUIRED'); assert.equal(h.confirms.length, 0); assert.equal(h.writes().length, 0);
});

test('404, 409, 412 and 429 are not executed with specific guidance; Retry-After is reported, nothing retried', async () => {
  const cases = [[404, 'NOT_FOUND', /not found/], [409, 'CONFLICT', /conflict/], [412, 'CONFLICT', /HTTP 412/], [429, 'THROTTLED', /wait at least 17 seconds/]];
  for (const [status, code, re] of cases) {
    const h = harness({ reply: (req) => (req.method === 'GET' ? json(event()) : json({ error: { code: 'X' } }, status, { 'retry-after': '17' })) });
    const r = await h.call({ action: 'update_event', event_id: 'e', subject: 'x' });
    assert.equal(r.errorCode, code); assert.match(r.message, re); assert.match(r.message, /not_executed/); assert.equal(h.writes().length, 1);
  }
  const g = harness({ reply: () => json({ error: { code: 'ErrorItemNotFound' } }, 404) });
  const r = await g.call({ action: 'get_event', event_id: 'gone' });
  assert.equal(r.errorCode, 'NOT_FOUND'); assert.equal(g.requests.length, 1);
});

test('account selection: no default, unknown account, expired account all fail before Graph', async () => {
  const noDefault = fixture(); noDefault[0].accounts.forEach((a) => { a.isDefault = false; });
  const expired = fixture(); expired[0].accounts[0].status = 'expired';
  const noApp = fixture(); noApp[0].clientConfigured = false;
  for (const [accounts, args, code] of [[noDefault, { action: 'list_calendars' }, 'ACCOUNT_NOT_CONNECTED'], [fixture(), { action: 'list_calendars', account: 'missing' }, 'ACCOUNT_NOT_FOUND'],
    [expired, create, 'ACCOUNT_EXPIRED'], [noApp, create, 'CLIENT_NOT_CONFIGURED']]) {
    const h = harness({ accounts });
    const r = await h.call(args);
    assert.equal(r.errorCode, code); assert.equal(h.requests.length, 0); assert.equal(h.confirms.length, 0);
  }
  const h = harness();
  await h.call({ action: 'list_calendars', account: 'g2' });
  assert.equal(h.requests[0].authAccount, 'g2');
});

test('successful write with malformed response is executed and never claimed undone', async () => {
  for (const reply of [{ ok: true, status: 201, headers: {}, body: 'not json' }, json({}, 201), json(event(), 201, {})]) {
    const r0 = reply.body === JSON.stringify(event()) ? { ...reply, truncated: true } : reply;
    const h = harness({ reply: () => r0 });
    const r = await h.call(create);
    assert.equal(r.ok, false); assert.match(r.message, /execution_status=executed/); assert.match(r.message, /check the calendar first/); assert.equal(h.requests.length, 1);
  }
});

test('tokens never appear in any output', async () => {
  const h = harness({ reply: () => json({ value: [event({ subject: 'ok' })] }) });
  const r = await h.call({ action: 'list_events', ...range });
  assert.doesNotMatch(JSON.stringify(r), /secret-token|Bearer|Authorization/);
  for (const req of h.requests) assert.equal(req.headers.Authorization, undefined);
});
