const {test}=require('node:test'),assert=require('node:assert/strict');
const {plan,sample,perform}=require('../../baguette-simulator/node/spatial.cjs');
const screen={width:1920,height:1080};
class Failure extends Error{constructor(code,message){super(message);this.code=code;}}
test('spatial planning validates the entire gesture before input and converts screenshot points',()=>{
 const drag=plan({action:'drag',from:[960,540],to:[1440,810],depth:.3,hold:.2,duration:.1},screen,Failure);
 assert.deepEqual([drag[0].x,drag[0].y,drag[0].z],[.5,.5,0]);
 assert.deepEqual([drag.at(-1).x,drag.at(-1).y,drag.at(-1).z],[.75,.75,.3]);
 assert.equal(drag.at(-1).phase,'ended');assert.equal(drag[1].x,.5);
 assert.equal(plan({action:'pinch',scale:2},screen).at(-1).spread,.2);
 assert.equal(plan({action:'move',by:[1,2,3]},screen).at(-1).z,3);
 assert.equal(plan({action:'pan',by:[1,-1]},screen).at(-1).x,-.5);
 for(const p of [{action:'drag',to:[1921,0]},{action:'pinch',scale:0},{action:'rotate',angle:NaN},{action:'move',by:[0,0,6]},{action:'pan',by:[0,0,1]},{action:'tilt',by:[0,0,1]},{action:'orbit',by:[0,0,1]},{action:'reset',duration:Infinity},{action:'unknown'}])assert.throws(()=>plan(p,screen,Failure),e=>e.code==='INVALID_ARGUMENT');
 const start=drag[0];for(const invalid of [{mode:'unknown'},{aspect:NaN},{x:11},{mode:'pointer',z:1.5}])assert.throws(()=>sample({...start,...invalid},Failure),e=>e.code==='INVALID_ARGUMENT');
});
test('insufficient time sends nothing; uncertain delivery releases without replaying',async()=>{
 const samples=plan({action:'drag',duration:.05},screen),sent=[];let cancelled=0;
 const manager={send:async(_id,p)=>{sent.push(p);if(p.phase==='changed')throw Error('lost ack');},cancel:async()=>cancelled++};
 await assert.rejects(perform(manager,'device',samples,'/Xcode',Date.now()+10),e=>e.execution==='not_executed');assert.equal(sent.length,0);
 await assert.rejects(perform(manager,'device',samples,'/Xcode'),e=>e.execution==='unknown');assert.equal(cancelled,1);assert.deepEqual(sent.map(p=>p.phase),['began','changed']);
});

const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../../baguette-simulator/node/vision-stage.js'),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
function stage(respond=async()=>{}){
 const events={},windowEvents={},docEvents={},calls=[],timers=new Map();let timer=0,focused=true,pads=[];
 const canvas={width:1920,height:1080,style:{},focus(){},setPointerCapture(){},getBoundingClientRect:()=>({left:0,top:0,width:1920,height:1080}),addEventListener:(name,fn)=>events[name]=fn};
 const context={crypto:require('node:crypto'),Date,Math,Promise,navigator:{getGamepads:()=>pads},parent:{document:{getElementById:()=>null}},document:{activeElement:canvas,hasFocus:()=>focused,hidden:false,addEventListener:(name,fn)=>docEvents[name]=fn},addEventListener:(name,fn)=>windowEvents[name]=fn,setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source,context);let errors=0;
 const control=context.createVisionStage({canvas,api:async(action,p)=>{calls.push({action,...p});await respond(p);},message(){},onError(){errors++;},zh:false});
 const emit=(name,p={})=>events[name]({type:name,button:0,buttons:name==='pointerup'?0:1,pointerId:1,clientX:960,clientY:540,preventDefault(){},...p});
 return {calls,control,emit,errors:()=>errors,pad:p=>{pads=p?[p]:[];windowEvents.gamepadconnected();},blur:()=>{focused=false;windowEvents.blur();},hide:()=>{context.document.hidden=true;docEvents.visibilitychange();},exit:()=>windowEvents.pagehide(),pulse:()=>{const fs=[...timers.values()];timers.clear();fs.forEach(f=>f());}};
}
test('fast click waits for native begin then releases exactly once',async()=>{
 let ack;const s=stage(p=>p.phase==='began'?new Promise(r=>ack=r):Promise.resolve());
 s.emit('pointerdown');s.emit('pointerup');await tick();assert.equal(s.calls.length,1);
 ack();await tick();assert.deepEqual(s.calls.map(p=>p.phase),['began','ended']);assert.equal(s.calls[0].mode,'interact');assert.equal(s.calls[0].gesture,s.calls[1].gesture);
});
test('mode and depth stay fixed during drag; pending motion coalesces without losing release',async()=>{
 let ack;const s=stage(p=>p.phase==='changed'?new Promise(r=>ack=r):Promise.resolve());
 s.emit('pointerdown',{shiftKey:true});await tick();s.emit('pointermove',{clientY:600});await tick();
 for(let i=1;i<=20;i++)s.emit('pointermove',{clientY:600+i*5,altKey:true});s.emit('pointerup');
 assert.equal(s.calls.length,2);ack();await tick();assert.equal(s.calls.length,3);assert.ok(s.calls[2].z>.2);assert.equal(s.calls[2].x,.5);assert.equal(s.calls[2].mode,'interact');
 ack();await tick();assert.equal(s.calls.at(-1).phase,'ended');assert.equal(s.calls.at(-1).z,s.calls.at(-2).z);
});
test('blur, hidden page, stream reset and page exit discard unsent gestures',async()=>{
 for(const stop of [s=>s.blur(),s=>s.hide(),s=>s.control.cancel(),s=>s.exit()]){
  const s=stage();s.emit('pointerdown');stop(s);await tick();assert.equal(s.calls.length,0);
  const active=stage();active.emit('pointerdown');await tick();stop(active);await tick();assert.deepEqual(active.calls.map(p=>p.phase),['began','ended']);
 }
});
test('two hands and camera controls use spatial modes; failed begin is never retried',async()=>{
 const s=stage();s.control.choose('two-hands');s.emit('pointerdown');await tick();s.emit('pointermove',{clientX:1152,clientY:432});s.emit('pointerup');await tick();
 assert.equal(s.calls[0].mode,'two-hands');assert.ok(Math.abs(s.calls.at(-1).spread-.2)<1e-9);assert.ok(s.calls.at(-1).angle>0);
 s.control.choose('orbit');s.emit('pointerdown');await tick();s.emit('pointerup');await tick();assert.equal(s.calls.at(-1).mode,'orbit');
 const failed=stage(async()=>{throw Error('offline');});failed.emit('pointerdown');await tick();failed.emit('pointermove');failed.emit('pointerup');await tick();assert.equal(failed.calls.length,1);assert.equal(failed.errors(),1);
});
test('gamepad combines translation and rotation, ends at neutral and never moves an unfocused view',async()=>{
 const s=stage(),p={connected:true,mapping:'standard',axes:[.5,-1,.5,.25],buttons:Array.from({length:8},()=>({value:0}))};p.buttons[7].value=1;
 s.pad(p);await tick();s.pulse();await tick();const v=s.calls.at(-1);
 assert.equal(v.mode,'move');assert.ok(v.x>0&&v.y>0&&v.z<0&&v.yaw<0&&v.pitch<0);
 p.axes.fill(0);p.buttons[7].value=0;s.pulse();await tick();assert.equal(s.calls.at(-1).phase,'ended');
 const count=s.calls.length;s.blur();p.axes[0]=1;s.pulse();await tick();assert.equal(s.calls.length,count);
 const failed=stage(async()=>{throw Error('lost ack');});failed.pad(p);await tick();for(let i=0;i<3;i++){failed.pulse();await tick();}assert.equal(failed.calls.length,1);
});
test('temporary toolbar camera drags preserve canvas mode and stale handles cannot end a newer gesture',async()=>{
 for(const selected of ['interact','orbit'])for(const temporary of ['tilt','pan','orbit','dolly']){
  const s=stage();s.control.choose(selected);
  const drag=s.control.cameraDrag(temporary);drag.move(192,-108);drag.end();await tick();
  assert.deepEqual(s.calls.map(v=>v.phase),['began','changed','ended']);
  assert.equal(s.calls.at(-1).mode,temporary);assert.equal(s.calls.at(-1).x,.1);assert.equal(s.calls.at(-1).y,-.1);
  s.emit('pointerdown');await tick();assert.equal(s.calls.at(-1).mode,selected);
  const n=s.calls.length;drag.move(500,500);drag.end();await tick();assert.equal(s.calls.length,n);
  s.emit('pointerup');await tick();assert.equal(s.calls.at(-1).phase,'ended');
 }
 const s=stage(),drag=s.control.cameraDrag('pan');await tick();s.blur();await tick();
 const n=s.calls.length;drag.move(100,100);drag.end();await tick();assert.equal(s.calls.length,n);assert.equal(s.calls.at(-1).phase,'ended');
});
