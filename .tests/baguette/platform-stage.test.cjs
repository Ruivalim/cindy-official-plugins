const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../baguette-simulator/node/platform-stage.js'),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function stage(platform='tvOS',respond=async()=>({ok:true}),withVision=false){
 const events={},windowEvents={},docEvents={},calls=[],status={},timers=new Map();let now=1000,nextTimer=0,stream;
 const listen=(target,name,fn)=>(target[name]??=[]).push(fn),fire=(target,name,event)=>{for(const fn of target[name]||[])fn(event);};
 const canvas={width:1920,height:1080,style:{},focus(){},setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080}),addEventListener:(name,fn)=>listen(events,name,fn)};
 class Clock extends Date{static now(){return now;}}
 const context={URL,URLSearchParams,Date:Clock,location:{search:`?platform=${platform}&udid=test&cindyViewer=token`},
  document:{hidden:false,activeElement:canvas,hasFocus:()=>true,getElementById:id=>id==='display'?canvas:status,addEventListener:(name,fn)=>listen(docEvents,name,fn)},
  fetch:async(_url,options)=>{const args=JSON.parse(options.body);calls.push(args);await respond(args.action,args);return {ok:true};},
  crypto:require('node:crypto'),setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{at:now+ms,fn});return id;},clearTimeout:id=>timers.delete(id),
  parent:{document:{getElementById:()=>null},cindySim:{api:async(action,args)=>{calls.push({action,...args});return respond(action,args);}}},
  addEventListener:(name,fn)=>listen(windowEvents,name,fn),
  StreamSession:class{constructor(options){stream=options;}static buildWSUrl(){return 'ws://127.0.0.1/stream';}start(){}stop(){}},
 };
 if(withVision)vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../baguette-simulator/node/vision-stage.js'),'utf8'),context);
 vm.runInNewContext(source,context);
 function emit(name,props={}){const e={button:0,pointerId:1,isPrimary:true,clientX:960,clientY:540,deltaX:0,deltaY:0,deltaMode:0,preventDefault(){this.prevented=true;},...props};fire(events,name,e);return e;}
 return {emit,calls,status,choose:value=>context.cindyVision.choose(value),advance:ms=>{now+=ms;},elapse:ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}},windowEvent:name=>fire(windowEvents,name),hide:()=>{context.document.hidden=true;fire(docEvents,'visibilitychange');},show:()=>{context.document.hidden=false;},disconnect:()=>stream.onClose()};
}
test('Vision keyboard switch gates keys and paste while preserving camera navigation',async()=>{
 const s=stage('visionOS',undefined,true),paste={clipboardData:{getData:()=> 'example'}};
 for(const code of ['KeyB','Digit1','Enter'])assert.equal(s.emit('keydown',{code}).prevented,true);
 s.emit('keydown',{code:'KeyV',metaKey:true});s.emit('paste',paste);await tick();assert.equal(s.calls.length,0);
 s.emit('keydown',{code:'KeyW'});await tick();s.emit('keyup',{code:'KeyW'});await tick();
 assert.ok(s.calls.length>0);assert.ok(s.calls.every(p=>p.action==='spatial'&&p.mode==='move'));
 s.calls.length=0;s.choose('keyboard');
 for(const code of ['KeyB','Digit1','Enter','KeyW','ArrowUp'])s.emit('keydown',{code});
 s.emit('keydown',{code:'KeyV',metaKey:true});s.emit('paste',paste);await tick();
 assert.deepEqual(s.calls.map(p=>p.action),['key','key','key','key','key','paste']);
 s.emit('keydown',{code:'Escape'});s.emit('keydown',{code:'Enter'});s.emit('paste',paste);await tick();assert.equal(s.calls.length,6);
});
test('Vision drops queued keyboard and paste input if the switch is disabled before dispatch',async()=>{
 let release;const held=new Promise(resolve=>release=resolve),s=stage('visionOS',async()=>held,true);
 s.choose('keyboard');s.emit('keydown',{code:'KeyB'});await tick();assert.equal(s.calls.length,1);
 s.emit('keydown',{code:'Enter'});s.emit('paste',{clipboardData:{getData:()=> 'queued'}});
 s.choose('keyboard');release();await tick();assert.equal(s.calls.length,1);
});
test('TV screen click confirms focus anywhere; right-click returns once without selecting',async()=>{
 const s=stage();s.emit('pointerdown');s.emit('pointerup');await tick();
 s.emit('pointerdown',{button:2});s.emit('pointerup',{button:2});const menu=s.emit('contextmenu');await tick();
 assert.equal(menu.prevented,true);assert.deepEqual(s.calls,[{action:'press',button:'select'},{action:'press',button:'back'}]);
 s.emit('pointerdown',{ctrlKey:true});s.emit('pointerup');s.emit('contextmenu');await tick();
 assert.deepEqual(s.calls.at(-1),{action:'press',button:'back'});assert.equal(s.calls.length,3);
});
test('TV dragged, canceled, secondary-touch and outside releases cannot select',async()=>{
 const s=stage();
 s.emit('pointerdown');s.emit('pointermove',{clientX:990});s.emit('pointermove');s.emit('pointerup');
 for(const name of ['pointercancel','lostpointercapture']){s.emit('pointerdown');s.emit(name);s.emit('pointerup');}
 s.emit('pointerdown');s.emit('pointerdown',{isPrimary:false,pointerId:2});s.emit('pointerup');
 s.emit('pointerdown');s.emit('pointerup',{clientX:2000});
 s.emit('pointerdown');s.windowEvent('blur');s.emit('pointerup');
 await tick();assert.deepEqual(s.calls,[]);
});
test('TV sends continuous native contact positions following finger motion on both axes',async()=>{
 const s=stage();
 assert.equal(s.emit('wheel',{deltaX:50,deltaY:-100}).prevented,true);await tick();
 s.emit('wheel',{deltaY:-5,deltaMode:1});await tick();
 s.emit('wheel',{deltaY:.1,deltaMode:2});await tick();
 s.elapse(101);await tick();
 assert.deepEqual(s.calls.map(c=>c.phase),['began','changed','changed','changed','ended']);
 assert.ok(s.calls.every(c=>c.action==='trackpad'&&c.gesture===s.calls[0].gesture));
 assert.equal(s.calls[0].x,.85);assert.equal(s.calls[0].y,.15);
 assert.ok(s.calls[1].x<s.calls[0].x);assert.ok(s.calls[1].y>s.calls[0].y);
 assert.ok(Math.abs(s.calls[2].y-.75)<1e-9);assert.ok(Math.abs(s.calls[3].y-.39)<1e-9);
 assert.equal(s.calls.at(-1).y,s.calls.at(-2).y);
});
test('TV coalesces in-flight positions without losing displacement or queueing stale samples',async()=>{
 let release;const s=stage('tvOS',async(action,p)=>{if(p.phase==='changed')await new Promise(r=>{release=r;});});
 s.emit('wheel',{deltaY:-10});await tick();
 for(let i=0;i<100;i++)s.emit('wheel',{deltaY:-10});
 assert.equal(s.calls.length,2);s.elapse(101);release();await tick();
 assert.equal(s.calls.length,3);assert.equal(s.calls[2].y,1);assert.equal(s.calls[2].phase,'changed');
 release();await tick();assert.equal(s.calls.length,4);assert.equal(s.calls[3].phase,'ended');
});
test('TV lifts the contact before select/back and on blur, hidden page, stream loss or page exit',async()=>{
 for(const finish of [s=>{s.emit('pointerdown');s.emit('pointerup');},s=>s.emit('contextmenu'),s=>s.windowEvent('blur'),s=>s.hide(),s=>s.disconnect(),s=>s.windowEvent('pagehide')]){
  const s=stage();s.emit('wheel',{deltaY:-100});await tick();finish(s);await tick();
  assert.equal(s.calls[2].phase,'ended');
  if(s.calls[3])assert.equal(s.calls[3].action,'press');
 }
 const s=stage();s.emit('pointerdown');s.emit('wheel',{deltaY:-100});s.emit('pointerup');await tick();
 assert.ok(s.calls.every(c=>c.action==='trackpad'));
 s.windowEvent('pagehide');await tick();const count=s.calls.length;s.emit('wheel',{deltaY:-100});s.emit('contextmenu');await tick();assert.equal(s.calls.length,count);
});
test('TV ignores pinch/invalid motion; failed gestures do not retry until a new gesture',async()=>{
 let fail=true;const s=stage('tvOS',async()=>{if(fail)throw Error('failed');});
 assert.equal(s.emit('wheel',{ctrlKey:true,deltaY:100}).prevented,undefined);
 s.emit('wheel',{deltaY:NaN});await tick();assert.equal(s.calls.length,0);
 s.emit('wheel',{deltaY:-100});await tick();assert.match(s.status.textContent,/Input not confirmed/);assert.equal(s.calls.length,1);
 fail=false;s.emit('wheel',{deltaY:-100});await tick();assert.equal(s.calls.length,1);
 s.elapse(200);s.emit('wheel',{deltaY:-100});await tick();assert.equal(s.calls.length,3);
 s.elapse(101);await tick();assert.equal(s.calls.at(-1).phase,'ended');
});
test('Vision keeps spatial tap/hold and does not acquire TV wheel or context-menu actions',async()=>{
 const s=stage('visionOS');s.emit('pointerdown');s.advance(800);s.emit('pointerup');await tick();
 assert.deepEqual(s.calls,[{action:'tap',x:0.5,y:0.5,duration:0.8}]);
 assert.equal(s.emit('wheel',{deltaY:100}).prevented,undefined);
 assert.equal(s.emit('contextmenu').prevented,undefined);await tick();assert.equal(s.calls.length,1);
});

test('queued keys, clicks and paste are discarded on blur, hidden, stream loss and exit',async()=>{
 for(const finish of [s=>s.windowEvent('blur'),s=>s.hide(),s=>s.disconnect(),s=>s.windowEvent('pagehide')]){
  let release;const held=new Promise(r=>release=r);
  const s=stage('visionOS',async()=>held);
  s.emit('keydown',{code:'KeyA'});await tick();assert.equal(s.calls.length,1);
  s.emit('keydown',{code:'KeyB'});
  s.emit('pointerdown');s.emit('pointerup');
  s.emit('paste',{clipboardData:{getData:()=> 'pending'}});
  finish(s);s.show();release();await tick();
  assert.equal(s.calls.length,1,'nothing queued before leaving can execute after returning');
 }
});
test('input failure and queue saturation discard pending operations without replay',async()=>{
 for(const mode of ['failure','saturated']){
  let resolve,reject;const held=new Promise((a,b)=>{resolve=a;reject=b;});
  const s=stage('tvOS',async()=>held);s.emit('keydown',{code:'KeyA'});await tick();
  for(let i=0;i<(mode==='saturated'?40:3);i++)s.emit('keydown',{code:'KeyB'});
  if(mode==='failure')reject(Error('unknown'));else resolve();
  await tick();assert.equal(s.calls.length,1);assert.match(s.status.textContent,/Input not confirmed/);
 }
});
