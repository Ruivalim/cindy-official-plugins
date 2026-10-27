const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const android=path.resolve(__dirname,'../../baguette-simulator/node/android');
const gestures=path.resolve(android,'../../vendor/baguette/Baguette_Baguette.bundle/Web/baguette/gestures');
const read=(dir,name)=>fs.readFileSync(path.join(dir,name),'utf8');
const copy=value=>JSON.parse(JSON.stringify(value));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const event=overrides=>({clientX:140,clientY:220,deltaX:0,deltaY:0,deltaMode:0,ctrlKey:false,preventDefault(){},stopPropagation(){},...overrides});

function wheelHarness(delay=0){
  const handlers={},pointers=new Map(),sent=[];
  const node=()=>({hidden:true,addEventListener(){},getBoundingClientRect:()=>({left:0,top:0,width:400,height:800}),getAnimations:()=>[],focus(){}});
  const canvas=node();canvas.addEventListener=(name,fn)=>handlers[name]=fn;
  const context={window:{},document:{getElementById:node,addEventListener(){}},location:{pathname:'/simulators/test',search:''},URLSearchParams,setTimeout,clearTimeout,addEventListener(){}};
  vm.runInNewContext(read(android,'screen-actions.js'),context);
  const actions=context.window.androidScreenActions({canvas,frame:node(),pointers,screenSize:()=>({width:400,height:800}),input:async()=>{},flush:async()=>{
    sent.push(copy([...pointers.values()]));await pause(delay);
    for(const [key,p] of pointers)if(!p.pressure)pointers.delete(key);
  }});
  return {sent,pointers,stop:actions.release,native:(phase,touches)=>handlers['cindy-trackpad']({detail:{phase,touches}}),pinch:(deltaY,x=200)=>handlers.wheel(event({ctrlKey:true,clientX:x,clientY:400,deltaY}))};
}

test('Android native pair is atomic and keeps a stationary finger through reverse and liftoff',()=>{
  const h=wheelHarness(),a={id:0,x:100,y:400},b={id:1,x:300,y:400};
  h.native('begin',[a,b]);assert.equal(h.sent.length,1);assert.equal(h.sent[0].length,2);
  h.native('change',[a,{...b,x:340}]);h.native('change',[a,{...b,x:260}]);
  assert.deepEqual(h.sent.at(-1).map(t=>t.x),[.25,.65]);
  h.native('change',[a]);assert.deepEqual(h.sent.at(-1).map(t=>t.pressure),[1024,0]);
  h.native('cancel',[]);assert.equal(h.sent.at(-1)[0].pressure,0);
});

test('Android pinch reverses immediately after repeated expansion beyond the screen edges',async t=>{
  for(const x of [100,200,300]){
    const h=wheelHarness();t.after(h.stop);
    h.pinch(-600,x);await pause(65);
    h.pinch(-100,x);await pause(35);
    const edge=h.sent.at(-1);assert.equal(edge[0].x,1);assert.equal(edge[1].x,0);
    h.pinch(20,x);await pause(45);
    const reverse=h.sent.at(-1);
    assert.ok(reverse[0].x-reverse[1].x<.95,'small reverse input must shrink the actual span, without repaying invisible scale');
    assert.ok(reverse.every(p=>p.pressure===1024));
    await pause(140);assert.equal(h.pointers.size,0);
  }
});

test('Android rapid pinch reaches the latest span after recognition without a long catch-up',async t=>{
  const h=wheelHarness(45);t.after(h.stop);
  h.pinch(-150);
  for(let i=0;i<80&&h.pointers.size;i++)await pause(10);
  assert.equal(h.pointers.size,0);
  const moves=h.sent.filter(t=>t[0].pressure>0),expected=.5+.2*Math.exp(.75);
  assert.equal(moves.length,4,'down, interception and recognition moves, latest position; no distance-based replay');
  assert.ok(moves[1][0].x>moves[0][0].x&&moves[1][0].x<expected);
  assert.ok(Math.abs(moves.at(-1)[0].x-expected)<1e-9);
  assert.ok(h.sent.at(-1).every(p=>p.pressure===0));
});

test('Android wheel gestures match iPhone contacts at the same cursor, scale and deltas',async()=>{
  for(const pinch of [false,true])for(const scale of [.5,1,2]){
    const size={width:400,height:800},bounds={left:20,top:40,width:400*scale,height:800*scale};
    const node=()=>({hidden:true,addEventListener(){},getBoundingClientRect:()=>bounds,getAnimations:()=>[],focus(){}});
    const handlers={},canvas=node(),pointers=new Map(),sent=[];
    canvas.addEventListener=(name,fn)=>handlers[name]=fn;
    const context={window:{},document:{getElementById:node,addEventListener(){}},location:{pathname:'/simulators/test',search:''},URLSearchParams,setTimeout,clearTimeout,addEventListener(){}};
    vm.runInNewContext(read(android,'screen-actions.js'),context);
    context.window.androidScreenActions({canvas,frame:node(),pointers,screenSize:()=>size,input:async()=>{},flush:async()=>{sent.push(copy([...pointers.values()]));for(const [key,p] of pointers)if(!p.pressure)pointers.delete(key);}});
    let iosWheel,expected;
    const ios={window:{},setTimeout:()=>1,clearTimeout(){}};
    for(const name of ['attachable-event-source.js','wheel-gesture-source.js'])vm.runInNewContext(read(gestures,name),ios);
    new ios.window.Baguette._WheelGestureSource({size,touchDown(){},touchUp(){},touchMove:p=>expected=copy(p)}).attach({getBoundingClientRect:()=>bounds,addEventListener:(name,fn)=>{iosWheel=fn;}});
    for(const delta of [{deltaY:10},{deltaX:-8,deltaY:-15}]){
      const e=event({clientX:20+180*scale,clientY:40+300*scale,ctrlKey:pinch,...delta});
      handlers.wheel(e);iosWheel(e);
      await pause(30);
    }
    // Move the cursor during the same pinch/pan stream.
    const e=event({clientX:20+200*scale,clientY:40+320*scale,ctrlKey:pinch,deltaX:5,deltaY:5});
    handlers.wheel(e);iosWheel(e);
    for(let i=0;i<100&&pointers.size;i++)await pause(10);
    assert.equal(pointers.size,0,'both contacts released after the last wheel event');
    const last=sent.at(-1);assert.equal(last.length,2);
    for(let i=0;i<2;i++){
      assert.equal(last[i].pressure,0);
      assert.ok(Math.abs(last[i].x-expected[i].x/size.width)<.00002);
      assert.ok(Math.abs(last[i].y-expected[i].y/size.height)<.00002);
    }
  }
});

function pointerHarness(){
  const handlers={},globalHandlers={},sent=[];let dots=[];
  const frame={style:{},getAnimations:()=>[]};
  const canvas={width:800,height:1600,getContext:()=>({}),focus(){},setPointerCapture(){},
    getBoundingClientRect:()=>({left:20,top:40,width:200,height:400}),addEventListener:(name,fn)=>handlers[name]=fn};
  const context={URLSearchParams,AbortController,AbortSignal,location:{pathname:'/simulators/test',search:''},
    window:{Baguette:{_PinchOverlay:class{clear(){dots=[];}setFingers(p){dots=copy(p);}}}},
    parent:{document:{documentElement:{lang:'en'}},cindySim:{state:{viewport:{width:400,height:800}}}},
    document:{getElementById:name=>name==='display'?canvas:name==='nativeDeviceFrame'?frame:{}},
    matchMedia:()=>({matches:false}),addEventListener:(name,fn)=>globalHandlers[name]=fn,
    fetch:(url,options)=>{if(url!=='/android-input')return new Promise(()=>{});sent.push(JSON.parse(options.body));return Promise.resolve({ok:true,json:async()=>({ok:true})});}};
  vm.runInNewContext(read(android,'screen.js'),context);
  return {handlers,globalHandlers,sent,dots:()=>dots};
}

test('Android Option-drag pinches and Option-Shift-drag pans with matching touch dots',async()=>{
  for(const shiftKey of [false,true]){
    const h=pointerHarness();
    h.handlers.pointerdown(event({pointerId:1,altKey:true,shiftKey,clientX:150,clientY:240}));
    await pause(0);
    h.handlers.pointermove(event({pointerId:1,clientX:160,clientY:260}));
    await pause(0);
    const touches=h.sent.at(-1).touches,dots=h.dots();assert.equal(touches.length,2);assert.equal(dots.length,2);
    if(shiftKey){assert.equal(touches[0].y,touches[1].y);assert.ok(Math.abs(touches[0].x-touches[1].x-.4)<1e-9);}
    else{assert.equal(touches[0].x+touches[1].x,1);assert.equal(touches[0].y+touches[1].y,1);}
    touches.forEach((p,i)=>{assert.equal(dots[i].x,p.x*200);assert.equal(dots[i].y,p.y*400);});
    h.handlers.pointerup(event({pointerId:1}));await pause(0);
    assert.deepEqual(h.dots(),[]);assert.ok(h.sent.at(-1).touches.every(t=>t.pressure===0));
  }
});

test('Android clears multi-touch indicators on blur and page exit',async()=>{
  for(const name of ['blur','pagehide']){
    const h=pointerHarness();h.handlers.pointerdown(event({pointerId:1,altKey:true}));await pause(0);
    assert.equal(h.dots().length,2);h.globalHandlers[name]();await pause(0);
    assert.deepEqual(h.dots(),[]);assert.equal(h.sent.at(-1).action,'release');
  }
});
