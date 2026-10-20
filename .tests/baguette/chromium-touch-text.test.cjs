const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const WEB='../../baguette-simulator/vendor/baguette/Baguette_Baguette.bundle/Web/baguette/';
const load=(context,file)=>vm.runInNewContext(fs.readFileSync(require.resolve(WEB+file),'utf8'),context);

function emitter(){
 const handlers={};
 return {handlers,addEventListener(t,f){(handlers[t]||(handlers[t]=[])).push(f);},removeEventListener(t,f){handlers[t]=(handlers[t]||[]).filter(x=>x!==f);},
  fire(t,ev={}){const e={type:t,preventDefault(){e.defaultPrevented=true;},...ev};for(const f of [...(handlers[t]||[])])f(e);return e;}};
}
const touch=(x,y)=>({clientX:x,clientY:y});

// 200x400 CSS px element at the origin showing a 400x800 pt screen (2x).
function gestureHarness({safari}){
 const clock={t:1000},calls=[];
 const window={};
 if(safari)window.GestureEvent=function(){};
 const context={window,performance:{now:()=>clock.t}};
 for(const f of ['gestures/attachable-event-source.js','gestures/edge-bands.js','gestures/touch-gesture-source.js','gestures/safari-gesture-event-source.js'])load(context,f);
 const el=Object.assign(emitter(),{getBoundingClientRect:()=>({left:0,top:0,width:200,height:400})});
 const record=(name)=>(fingers,opts)=>calls.push({name,n:fingers.length,fingers:Array.from(fingers,f=>[f.x,f.y]),edge:opts&&opts.edge});
 const screen={size:{width:400,height:800},touchDown:record('down'),touchMove:record('move'),touchUp:record('up')};
 const B=window.Baguette;
 const touchSource=new B._TouchGestureSource(screen,{getOrientation:()=>'portrait'});touchSource.attach(el);
 const safariSource=new B._SafariGestureEventSource(screen,{});safariSource.attach(el);
 return {el,calls,clock};
}

test('Chromium: second finger streams touch2 down/move/up and leaves no stray single touch',()=>{
 const {el,calls,clock}=gestureHarness({safari:false});
 el.fire('touchstart',{touches:[touch(80,150)]});
 assert.deepEqual(calls.map(c=>[c.name,c.n]),[['down',1]]);
 el.fire('touchstart',{touches:[touch(80,150),touch(120,150)]});
 // single touch lifted cleanly, then both real fingers go down together
 assert.deepEqual(calls.slice(1).map(c=>[c.name,c.n]),[['up',1],['down',2]]);
 assert.deepEqual(calls[2].fingers,[[160,300],[240,300]]);
 clock.t+=20;el.fire('touchmove',{touches:[touch(40,150),touch(160,150)]});
 assert.deepEqual(calls[3],{name:'move',n:2,fingers:[[80,300],[320,300]],edge:undefined});
 // a move inside the flush window is coalesced, but the next up carries the freshest positions
 el.fire('touchmove',{touches:[touch(20,150),touch(180,150)]});assert.equal(calls.length,4);
 el.fire('touchend',{touches:[touch(180,150)],changedTouches:[touch(20,150)]});
 assert.deepEqual(calls[4],{name:'up',n:2,fingers:[[40,300],[360,300]],edge:undefined});
 // remaining finger moving / lifting must not become touch1
 clock.t+=20;el.fire('touchmove',{touches:[touch(100,100)]});
 el.fire('touchend',{touches:[],changedTouches:[touch(100,100)]});
 assert.equal(calls.length,5);
 // state is reset: a new single touch works again
 el.fire('touchstart',{touches:[touch(50,50)]});assert.deepEqual([calls[5].name,calls[5].n],['down',1]);
});

test('Chromium: both fingers landing together, cancel, and a pinch that starts from an edge touch',()=>{
 const {el,calls,clock}=gestureHarness({safari:false});
 el.fire('touchstart',{touches:[touch(60,200),touch(140,200)]});
 assert.deepEqual(calls.map(c=>[c.name,c.n]),[['down',2]]);
 el.fire('touchcancel',{touches:[],changedTouches:[touch(60,200),touch(140,200)]});
 assert.deepEqual(calls.map(c=>[c.name,c.n]),[['down',2],['up',2]]);
 el.fire('touchstart',{touches:[touch(100,395)]}); // bottom edge band
 assert.equal(calls[2].edge,'bottom');
 el.fire('touchstart',{touches:[touch(100,395),touch(140,395)]});
 assert.deepEqual(calls.slice(3).map(c=>[c.name,c.n,c.edge]),[['up',1,'bottom'],['down',2,undefined]]);
});

test('Safari: second finger is still left to gesture* — exactly one touch2 sequence, no touch path duplicate',()=>{
 const {el,calls,clock}=gestureHarness({safari:true});
 el.fire('touchstart',{touches:[touch(80,150)]});
 el.fire('touchstart',{touches:[touch(80,150),touch(120,150)]});
 assert.deepEqual(calls.map(c=>[c.name,c.n]),[['down',1],['up',1]]);
 el.fire('gesturestart',{clientX:100,clientY:150});
 clock.t+=20;el.fire('touchmove',{touches:[touch(60,150),touch(140,150)]});
 el.fire('gesturechange',{clientX:100,clientY:150,scale:1.5,rotation:0});
 el.fire('touchend',{touches:[],changedTouches:[touch(60,150)]});
 el.fire('gestureend',{clientX:100,clientY:150,scale:1.5,rotation:0});
 assert.deepEqual(calls.slice(2).map(c=>[c.name,c.n]),[['down',2],['move',2],['up',2]]);
});

function keyboardHarness({safari}){
 const calls=[],pending=[];
 const sinkEmitter=()=>Object.assign(emitter(),{attrs:{},style:{},value:'',tabIndex:0,removed:false,focused:0,setAttribute(k,v){this.attrs[k]=v;},focus(){this.focused++;context.document.activeElement=this;},remove(){this.removed=true;}});
 const window=Object.assign(emitter(),{alert(m){throw Error('Unexpected alert: '+m);}});
 if(safari)window.GestureEvent=function(){};
 const document=Object.assign(emitter(),{activeElement:null,createElement:()=>sinkEmitter()});
 const context={window,document,URLSearchParams,AbortSignal,location:{pathname:'/simulators/00000000-0000-4000-8000-000000000001',hash:'#cindyClipboard=1234.'+'a'.repeat(64)},fetch:(_u,opts)=>{calls.push(JSON.parse(opts.body));return new Promise(r=>pending.push(()=>r({ok:true,json:async()=>({ok:true})})));}};
 load(context,'parts/keyboard.js');
 const el=Object.assign(emitter(),{tabIndex:-1,children:[],appendChild(c){this.children.push(c);},focus(){document.activeElement=el;el.fire('focus');}});
 const keyboard=new window.Baguette._Keyboard({},{});keyboard.attach(el);
 const flush=async()=>{while(pending.length){pending.shift()();await new Promise(r=>setImmediate(r));}};
 return {keyboard,el,document,calls,flush,sink:el.children[0]};
}

test('Chromium: committed insertText goes through paste once; keydown path is unchanged',async()=>{
 const {keyboard,el,document,calls,flush,sink}=keyboardHarness({safari:false});
 assert.ok(sink);assert.equal(sink.attrs['aria-hidden'],'true');
 el.focus();assert.equal(document.activeElement,sink);
 const ev=sink.fire('beforeinput',{inputType:'insertText',data:'中文ABC',isComposing:false});
 assert.equal(ev.defaultPrevented,true);
 sink.fire('input',{inputType:'insertText'});
 // forwarded key: sent as key, never as text
 const key=sink.fire('beforeinput',{inputType:'insertText',data:'',isComposing:false});assert.equal(key.defaultPrevented,undefined);
 el.fire('keydown',{code:'KeyA',keyCode:65,metaKey:false,ctrlKey:false,shiftKey:false,altKey:false,repeat:false});
 await flush();
 assert.deepEqual(calls.map(c=>[c.action,c.text,c.code]),[['paste','中文ABC',undefined],['key',undefined,'KeyA']]);
 // document-level Cmd+V paste still works while the sink owns focus, and is not doubled
 document.fire('paste',{clipboardData:{getData:()=>'Google'}});await flush();
 assert.deepEqual(calls.slice(2).map(c=>[c.action,c.text]),[['paste','Google']]);
});

test('Chromium: IME composition sends only the committed text; composing keys are not forwarded',async()=>{
 const {el,calls,flush,sink}=keyboardHarness({safari:false});
 el.focus();
 sink.fire('compositionstart',{});
 el.fire('keydown',{code:'KeyN',keyCode:229,isComposing:true,repeat:false});
 sink.fire('beforeinput',{inputType:'insertCompositionText',data:'ni',isComposing:true});
 sink.fire('beforeinput',{inputType:'insertText',data:'n',isComposing:true});
 sink.value='ni';sink.fire('input',{});assert.equal(sink.value,'ni');
 sink.fire('compositionend',{data:'你'});
 assert.equal(sink.value,'');
 // some engines also report the commit as beforeinput right after compositionend: ignored via isComposing=false + same data is a distinct commit
 await flush();
 assert.deepEqual(calls.map(c=>[c.action,c.text,c.code]),[['paste','你',undefined]]);
});

test('Chromium: focus moving between screen and sink keeps queued keys; real blur clears them',async()=>{
 const {keyboard,el,sink,calls,flush}=keyboardHarness({safari:false});
 el.focus();
 keyboard.key('KeyA',[]);keyboard.key('KeyB',[]);assert.equal(keyboard._inputQueue.length,1);
 sink.fire('blur',{relatedTarget:el});el.fire('blur',{relatedTarget:sink});assert.equal(keyboard._inputQueue.length,1);
 sink.fire('blur',{relatedTarget:null});assert.equal(keyboard._inputQueue.length,0);
 await flush();assert.deepEqual(calls.map(c=>c.code),['KeyA']);
});

test('Chromium: detach removes the sink; Safari never creates one and keeps focus on the screen',()=>{
 const c=keyboardHarness({safari:false});const sink=c.sink;c.keyboard.detach();
 assert.equal(sink.removed,true);assert.equal(c.keyboard._sink,null);
 const s=keyboardHarness({safari:true});
 assert.equal(s.sink,undefined);s.el.focus();assert.equal(s.document.activeElement,s.el);
 assert.equal(s.el.handlers.focus,undefined);
});
