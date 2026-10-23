const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const node=path.join(__dirname,'../../baguette-simulator/node');
const udid='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const IDS='screen stage frame overlay dock chip-dot chip-name status btn-home btn-rotl btn-rotr btn-shot btn-shot-menu btn-more scroll title title-dot title-name title-sub zoom zoom-out zoom-label zoom-in tools posture device-chip confirm-title confirm-body confirm-cancel confirm-ok confirm-dialog device-dialog device-form dialog-title dialog-hint f-name-text f-model-text f-runtime-text dialog-cancel dialog-save f-model-label f-runtime-label dialog-error f-name f-model f-runtime'.split(' ');

// A deliberately small DOM: enough for control.js to render and for the test to read back.
function fakeDocument(){
 const byId={};
 function el(tag){
  const n={tag,children:[],style:{},dataset:{},attrs:{},listeners:{},textContent:'',innerHTML:'',className:'',hidden:false,disabled:false,value:'',parent:null,
   append(...kids){for(const k of kids){if(k==null)continue;if(typeof k==='string'){n.textContent+=k;continue;}k.parent=n;n.children.push(k);}},
   appendChild(k){n.append(k);return k;},replaceChildren(...kids){n.children=[];n.append(...kids);},
   remove(){if(n.parent){n.parent.children=n.parent.children.filter(c=>c!==n);n.parent=null;}},
   setAttribute(k,v){n.attrs[k]=String(v);if(k==='disabled'||k==='hidden')n[k]=true;},getAttribute(k){return n.attrs[k]??null;},removeAttribute(k){delete n.attrs[k];if(k==='disabled'||k==='hidden')n[k]=false;},
   addEventListener(name,fn){(n.listeners[name]=n.listeners[name]||[]).push(fn);},
   dispatch(name,event={}){for(const fn of n.listeners[name]||[])fn(event);},
   getBoundingClientRect(){return {width:400,height:700,left:0,right:120,top:0,bottom:44};},
   showModal(){n.open=true;},close(){n.open=false;},focus(){},
   querySelector(sel){return all(n).find(c=>matches(c,sel))||null;},querySelectorAll(sel){return all(n).filter(c=>matches(c,sel));},
  };
  Object.defineProperty(n,'classList',{value:{contains:c=>n.className.split(' ').includes(c)}});
  return n;
 }
 function all(n){return n.children.flatMap(c=>[c,...all(c)]);}
 function matches(c,sel){if(sel.startsWith('.'))return c.className.split(' ').includes(sel.slice(1));if(sel==='strong')return c.tag==='strong';if(sel==='button:not(:disabled)')return c.tag==='button'&&!c.disabled;if(sel==='button')return c.tag==='button';return false;}
 for(const id of IDS){byId[id]=el(id.startsWith('btn')||id.includes('cancel')||id.includes('ok')||id.includes('save')||id==='device-chip'?'button':'div');byId[id].id=id;}
 const screen=byId.screen;let src='about:blank';screen.loads=[];
 Object.defineProperty(screen,'src',{get:()=>src,set:v=>{src=v;screen.loads.push(v);}});
 screen.contentDocument={querySelector:()=>null,addEventListener(){},documentElement:null};screen.contentWindow={};
 const body=el('body');
 const document={documentElement:{lang:'zh-CN',clientWidth:400,style:{}},body,hidden:false,getElementById:id=>byId[id]||null,createElement:el,addEventListener(){},listeners:{}};
 return {document,byId,body,text:n=>[n.textContent,...all(n).map(c=>c.textContent)].join(' ')};
}

async function boot({respond,abortSignal=AbortSignal,query=''}){
 const dom=fakeDocument();const calls=[];let intervals=[];
 const context={
  document:dom.document,URLSearchParams,URL,AbortSignal:abortSignal,Error,Object,JSON,Math,Date,String,Array,Number,Promise,console,parseFloat,clearTimeout,setTimeout,
  location:{search:'?udid='+udid+query,hash:'#cindyClipboard=123.token',href:'http://127.0.0.1:1/control?udid='+udid+'&lang=zh-CN'+query+'#cindyClipboard=123.token',origin:'http://127.0.0.1:1'},
  history:{replaceState(_s,_t,url){context.location.href=String(url);}},
  ResizeObserver:class{observe(){}},setInterval:fn=>{intervals.push(fn);return intervals.length;},
  fetch:async(_url,opts)=>{const body=JSON.parse(opts.body);calls.push(body);const r=await respond(body,opts);if(r instanceof Error)throw r;if(r?.httpStatus)return {ok:false,status:r.httpStatus,json:async()=>({error:'denied'})};return {ok:true,status:200,json:async()=>r};},
 };
 context.globalThis=context;context.window=context;
 vm.createContext(context);
 vm.runInContext(fs.readFileSync(path.join(node,'control-model.js'),'utf8'),context);
 vm.runInContext(fs.readFileSync(path.join(node,'control.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));
 return {dom,calls,context,poll:()=>intervals[0](),tick:()=>intervals[1](),sim:context.cindySim};
}
const status=(over={})=>({ready:true,parked:false,generation:1,device:{udid,name:'iPhone 17 Pro',state:'Booted',runtime:'com.apple.CoreSimulator.SimRuntime.iOS-27-1',deviceType:'x.iPhone-17-Pro'},devices:[{udid,name:'iPhone 17 Pro',state:'Booted',runtime:'iOS 27.1',deviceType:'x.iPhone-17-Pro'},{udid:other,name:'iPad',state:'Shutdown',runtime:'iOS 27.0',deviceType:'x.iPad'}],settings:{enabled:true,idleMinutes:15},idleDeadline:Date.now()+15*60000,...over});

test('slow desktop and clipboard screenshots finish before the viewer HTTP budget expires',async()=>{
 for(const to of ['desktop','clipboard']){
  let shots=0;
  const {dom,context}=await boot({abortSignal:{timeout:ms=>({budget:ms})},respond:({action},opts)=>{
   if(action!=='screenshot')return status();
   // A 30s screenshot plus clipboard conversion must not be cut off at 20s.
   assert.ok(opts.signal.budget>=(to==='clipboard'?45000:30000));shots++;
   return {ok:true,path:'/fixture/shot.png',copied:to==='clipboard'};
  }});
  context.localStorage={getItem:key=>key==='cindy.shotTo'?JSON.stringify(to):null};
  await dom.byId['btn-shot'].listeners.click[0]();
  assert.equal(shots,1);assert.equal(dom.byId['btn-shot'].dataset.busy,undefined);
  assert.doesNotMatch(dom.text(dom.byId.dock),/截图失败/);
 }
});

test('live device loads the handheld screen once; a service generation change alone does not reload it',async()=>{
 let generation=1;
 const {dom,poll,calls}=await boot({respond:({action})=>action==='status'?status({generation}):{ok:true}});
 assert.deepEqual(dom.byId.screen.loads,[`/simulators/${udid}?handheld=0&cindyViewer=token#cindyClipboard=123.token`]);
 assert.equal(dom.byId['chip-name'].textContent,'iPhone 17 Pro');assert.equal(dom.byId['chip-dot'].dataset.tone,'on');
 assert.equal(dom.byId.overlay.hidden,true);assert.equal(dom.byId['btn-home'].disabled,false);
 generation++;await poll();assert.equal(dom.byId.screen.loads.length,1);
 assert.equal(calls.filter(c=>c.action==='status').length,2);
});

test('unreadable App records do not block device selection or live controls',async()=>{
 let damaged=true;
 const {dom,poll,calls}=await boot({respond:()=>status(damaged?{currentApp:null,currentAppError:{code:'APP_CONTEXT_UNREADABLE',message:'unreadable'}}:{currentApp:'test.example.app'})});
 assert.equal(dom.byId.overlay.hidden,true);assert.equal(dom.byId.tools.hidden,false);assert.equal(dom.byId['btn-home'].disabled,false);
 assert.equal(dom.byId.status.textContent,'运行中');assert.equal(dom.byId.screen.loads.length,1);
 dom.byId['device-chip'].dispatch('click');
 assert.doesNotMatch(dom.text(dom.body),/无法读取 App 记录/);
 let rows=dom.body.querySelectorAll('button').filter(b=>b.attrs.role==='menuitemradio');assert.equal(rows[1].disabled,false);
 damaged=false;await poll();dom.byId['device-chip'].dispatch('click');
 rows=dom.body.querySelectorAll('button').filter(b=>b.attrs.role==='menuitemradio');assert.equal(rows[1].disabled,false);
 assert.equal(dom.byId.screen.loads.length,1,'record repair never restarts or reloads the view');
 assert.ok(calls.every(c=>c.action==='status'));
});

test('a service that answers but cannot reach the view shows the recovery card; recover restarts once and reloads',async()=>{
 let fail=false,generation=1;
 const {dom,poll,calls}=await boot({respond:({action})=>{if(fail&&action==='status')return {ok:false,errorCode:'CONTROL_FAILED'};if(action==='restart'){generation++;return {ready:true,generation};}return status({generation});}});
 fail=true;await poll();
 assert.equal(dom.byId.overlay.hidden,false);assert.match(dom.text(dom.byId.overlay),/画面已断开/);assert.equal(dom.byId['chip-dot'].dataset.tone,'off');
 const recover=dom.byId.overlay.querySelector('button');assert.equal(recover.textContent,'恢复画面');
 fail=false;await recover.listeners.click[0]();
 assert.equal(calls.filter(c=>c.action==='restart').length,1);assert.equal(dom.byId.screen.loads.at(-1),`/simulators/${udid}?handheld=0&cindyViewer=token#cindyClipboard=123.token`);
 assert.equal(dom.byId.overlay.hidden,true);
});

test('a shut-down device shows a start button in place of the screen; starting boots through the control API',async()=>{
 let state='Shutdown';
 const {dom,calls}=await boot({respond:({action})=>{if(action==='boot'){state='Booted';return {ok:true};}return status({device:{udid,name:'iPhone 17 Pro',state}});}});
 assert.deepEqual(dom.byId.screen.loads,[],'no stream is loaded for a shut-down device');
 assert.match(dom.text(dom.byId.overlay),/iPhone 17 Pro 已关闭/);assert.equal(dom.byId['btn-home'].disabled,true);
 const start=dom.byId.overlay.querySelector('button');assert.equal(start.textContent,'打开');
 await start.listeners.click[0]();
 assert.equal(calls.filter(c=>c.action==='boot').length,1);assert.equal(dom.byId.overlay.hidden,true);assert.equal(dom.byId.screen.loads.length,1);
});

test('idle countdown card appears only in the last minute and keeps the device alive on request',async()=>{
 let deadline=Date.now()+5*60000;
 const {dom,poll,tick,calls}=await boot({respond:({action})=>action==='status'?status({idleDeadline:deadline}):{ok:true}});
 tick();assert.equal(dom.byId.dock.querySelector('.idle'),null);
 deadline=Date.now()+42_000;await poll();tick();
 const card=dom.byId.dock.querySelector('.idle');assert.ok(card);assert.match(card.querySelector('strong').textContent,/0:4\d 后自动关闭/);
 await card.querySelector('button').listeners.click[0]();
 assert.equal(calls.filter(c=>c.action==='activity').length,1);assert.equal(dom.byId.dock.querySelector('.idle'),null);
});

test('switching follows the device job, then adopts the new device without exposing a UDID in the chip',async()=>{
 let job=null,current=udid;
 const {dom,poll,calls,context}=await boot({respond:({action,targetUdid})=>{
  if(action==='switch'){job={id:'j1',sourceUdid:udid,targetUdid,state:'running',phase:'preparing'};return {ok:true,job};}
  if(action==='status')return status({device:{udid:current,name:current===udid?'iPhone 17 Pro':'iPad',state:'Booted'},deviceJob:job});
  return {ok:true};}});
 dom.byId['device-chip'].dispatch('click');
 const rows=dom.body.querySelectorAll('button').filter(b=>b.attrs.role==='menuitemradio');
 assert.equal(rows.length,2);assert.equal(rows[0].disabled,true,'current running device is not switchable');assert.ok(!dom.text(rows[1]).includes(other.slice(-4)));
 rows[1].listeners.click[0]();await new Promise(r=>setImmediate(r));await poll();
 assert.equal(calls.filter(c=>c.action==='switch')[0].targetUdid,other);
 assert.match(dom.text(dom.byId.overlay),/正在切换/);
 job={...job,state:'done',phase:'done',activeUdid:other};current=other;await poll();
 assert.match(context.location.href,new RegExp('udid='+other));assert.equal(dom.byId['chip-name'].textContent,'iPad');
 assert.equal(dom.byId.screen.loads.at(-1),`/simulators/${other}?handheld=0&cindyViewer=token#cindyClipboard=123.token`);
 assert.match(dom.text(dom.byId.dock),/已切换/);
});

// A shared status job is not a request to change every controller on its source.
test('only the initiating controller adopts a switch; other tasks, hub and reopened views keep their device',async()=>{
 let job=null;
 const respond=({action,targetUdid,udid:id})=>{
  if(action==='switch'){job={id:'owned-switch',sourceUdid:id,targetUdid,state:'running',phase:'preparing'};return {ok:true,job};}
  const s=status();s.devices[1].state='Booted';
  return {...s,device:s.devices.find(d=>d.udid===id),deviceJob:job};
 };
 const owner=await boot({respond,query:'&task=task-1'});
 const observers=await Promise.all(['&task=task-2','&embed=hub'].map(query=>boot({respond,query})));
 const unchanged=()=>{
  for(const view of observers){
   assert.equal(view.dom.byId['chip-name'].textContent,'iPhone 17 Pro');
   assert.equal(view.dom.byId.screen.loads.length,1,'foreign jobs must not blank or replace this screen');
   assert.equal(view.dom.byId.overlay.hidden,true);
   assert.equal(new URL(view.context.location.href).searchParams.get('udid'),udid);
  }
 };
 owner.dom.byId['device-chip'].dispatch('click');
 const row=owner.dom.body.querySelectorAll('button').find(b=>b.attrs.role==='menuitemradio'&&!b.disabled);
 row.listeners.click[0]();await new Promise(r=>setImmediate(r));
 assert.equal(owner.calls.find(c=>c.action==='switch').task,'task-1');
 for(const view of observers)await view.poll();unchanged();
 job={...job,state:'done',phase:'done',activeUdid:other};
 await owner.poll();for(const view of observers)await view.poll();unchanged();
 assert.equal(new URL(owner.context.location.href).searchParams.get('udid'),other);
 const reopened=await boot({respond,query:'&task=task-2'});
 assert.equal(new URL(reopened.context.location.href).searchParams.get('udid'),udid,'a retained completed job never redirects a newly opened controller');
 // A later job involving the owner's selected device belongs to another page too.
 job={id:'foreign-switch',sourceUdid:other,targetUdid:udid,state:'done',activeUdid:udid};
 await owner.poll();
 assert.equal(new URL(owner.context.location.href).searchParams.get('udid'),other);
});

test('a replaced switch result stops waiting without adopting another page selection',async()=>{
 let job=null,delay=false,release;
 const {dom,poll,context}=await boot({respond:({action,targetUdid})=>{
  if(action==='switch'){job={id:'own',sourceUdid:udid,targetUdid,state:'running',phase:'preparing'};return {ok:true,job};}
  const snapshot=status({deviceJob:job});
  if(delay){delay=false;return new Promise(resolve=>release=()=>resolve(snapshot));}
  return snapshot;
 }});
 delay=true;const earlier=poll();
 dom.byId['device-chip'].dispatch('click');
 dom.body.querySelectorAll('button').find(b=>b.attrs.role==='menuitemradio'&&!b.disabled).listeners.click[0]();
 await new Promise(r=>setImmediate(r));
 release();await earlier;
 assert.match(dom.text(dom.byId.overlay),/正在切换/,'late status from before the request must not discard its job');
 job={id:'other-page',sourceUdid:udid,targetUdid:other,state:'done',activeUdid:other};
 await poll();
 assert.equal(new URL(context.location.href).searchParams.get('udid'),udid);
 assert.equal(dom.byId.overlay.hidden,true);
 assert.match(dom.text(dom.byId.dock),/切换没有完成/);
});

test('selecting a stopped device never loads its stream or boots until Open is clicked',async()=>{
 let job=null,targetState='Shutdown';
 const {dom,poll,calls}=await boot({respond:({action,targetUdid,udid:id})=>{
  if(action==='switch'){job={id:'select-off',sourceUdid:udid,targetUdid,state:'done',phase:'done',activeUdid:targetUdid};return {ok:true,job};}
  if(action==='boot'){assert.equal(id,other);targetState='Booted';return {ok:true};}
  const s=status();s.devices[1].state=targetState;
  return {...s,device:s.devices.find(d=>d.udid===id),deviceJob:job};
 }});
 dom.byId['device-chip'].dispatch('click');
 const row=dom.body.querySelectorAll('button').find(b=>b.attrs.role==='menuitemradio'&&!b.disabled);
 row.listeners.click[0]();await new Promise(r=>setImmediate(r));
 assert.equal(dom.byId['chip-name'].textContent,'iPad');
 assert.match(dom.text(dom.byId.overlay),/iPad 已关闭/);
 assert.ok(!dom.byId.screen.loads.some(src=>src.includes(other)),'source status must not load a stopped target');
 await poll();assert.ok(!calls.some(c=>c.action==='boot'),'polling never starts the target');
 const open=dom.byId.overlay.querySelector('button');assert.equal(open.textContent,'打开');
 await open.listeners.click[0]();
 assert.equal(calls.filter(c=>c.action==='boot').length,1);
 assert.equal(dom.byId.screen.loads.at(-1),`/simulators/${other}?handheld=0&cindyViewer=token#cindyClipboard=123.token`);
});

test('a page that outlives its service says how to reopen, then reconnects on its own when the service is back',async()=>{
 let mode='up';
 const {dom,poll}=await boot({respond:({action})=>action!=='status'?{ok:true}:mode==='down'?new TypeError('fetch failed'):mode==='expired'?{httpStatus:403}:status()});
 assert.equal(dom.byId.screen.loads.length,1);
 mode='down';await poll();
 const text=dom.text(dom.byId.overlay);
 assert.match(text,/模拟器服务已停止/);assert.match(text,/打开画面/);assert.doesNotMatch(text,/恢复画面/,'recovery cannot help when nothing answers');
 assert.equal(dom.byId.screen.src,'about:blank','the dead frame is cleared, not left blank-white');
 assert.equal(dom.byId.status.textContent,'服务已停止');
 mode='up';await poll();
 assert.equal(dom.byId.overlay.hidden,true);
 assert.equal(dom.byId.screen.loads.at(-1),`/simulators/${udid}?handheld=0&cindyViewer=token#cindyClipboard=123.token`,'reloaded without opening a new tab');
 mode='expired';await poll();
 assert.match(dom.text(dom.byId.overlay),/这个画面已过期/);assert.equal(dom.byId.status.textContent,'画面已过期');
});
