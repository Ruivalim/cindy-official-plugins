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
 const context={window,document,URLSearchParams,AbortSignal,location:{pathname:'/simulators/00000000-0000-4000-8000-000000000001',hash:'#cindyClipboard=1234.'+'a'.repeat(64)},fetch:(_u,opts)=>{calls.push(JSON.parse(opts.body));return new Promise(r=>pending.push(()=>r({ok:true,json:async()=>({ok:true,timing:{total:5}})})));}};
 load(context,'parts/keyboard.js');
 const el=Object.assign(emitter(),{tabIndex:-1,children:[],appendChild(c){this.children.push(c);},focus(){document.activeElement=el;el.fire('focus');}});
 const keyboard=new window.Baguette._Keyboard({},{});keyboard.attach(el);
 const flush=async()=>{while(pending.length){pending.shift()();await new Promise(r=>setImmediate(r));}};
 return {keyboard,el,document,calls,flush,window,sink:el.children[0]};
}

test('Chromium: committed insertText goes through paste once; keydown path is unchanged',async()=>{
 const {keyboard,el,document,calls,flush,sink}=keyboardHarness({safari:false});
 assert.ok(sink);assert.equal(sink.attrs['aria-hidden'],'true');assert.equal(sink.attrs.inputmode,'none');
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

test('Chromium: touch/pointer down hands focus to the sink (touchstart is cancelled, so no mousedown); Safari does not',()=>{
 for(const type of ['pointerdown','touchstart']){
  const c=keyboardHarness({safari:false});
  assert.notEqual(c.document.activeElement,c.sink);
  c.el.fire(type,{});
  assert.equal(c.document.activeElement,c.sink);
  assert.equal(c.sink.focused,1);
  c.el.fire(type,{});assert.equal(c.sink.focused,1); // already focused: no churn
  c.keyboard.detach();c.el.fire(type,{});assert.equal(c.sink.focused,1);
 }
 const s=keyboardHarness({safari:true});
 s.el.fire('pointerdown',{});s.el.fire('touchstart',{});assert.notEqual(s.document.activeElement,s.el);
 assert.equal(s.el.handlers.pointerdown,undefined);
});

const WORDCH=/[A-Za-z0-9]/;
// Observed on the device: a multi-character paste that starts with a word character right after a word
// character got a separating space in front ("h" + "ello world" -> "h ello world").
function assertNoWordJoinPaste(calls,label){
 let tail=null;
 for(const c of calls){
  if(c.action==='paste'){
   const chars=[...c.text];
   assert.ok(!(chars.length>1&&WORDCH.test(chars[0])&&tail&&WORDCH.test(tail)),`${label}: ${JSON.stringify(c.text)} pasted after ${JSON.stringify(tail)}`);
   assert.ok(!/^\s/.test(c.text),`${label}: paste must not start with whitespace: ${JSON.stringify(c.text)}`);
   tail=chars[chars.length-1];
  }else tail=c.code==='Space'?' ':null;
 }
}
// What the simulator receives: pastes append text, Space keys append ' '.
const received=(calls)=>calls.map(c=>c.action==='paste'?c.text:(c.action==='key'&&c.code==='Space'?' ':`<${c.code}>`)).join('');
async function typeChars(text,{gapFlushes=false}={}){
 const h=keyboardHarness({safari:false});h.el.focus();
 // the sink receives one insertText commit per character while earlier requests are still in flight
 for(const ch of [...text])h.sink.fire('beforeinput',{inputType:'insertText',data:ch,isComposing:false});
 await h.flush();
 return h;
}

test('per-character commits never lose repeated letters or spaces (hello world / aa  bb / mixed)',async()=>{
 for(const text of ['hello world','aa  bb','hi 中文 ok','l l  l','a'.repeat(5)]){
  const h=await typeChars(text);
  assert.equal(received(h.calls),text,text);
  assertNoWordJoinPaste(h.calls,text);
 }
});

test('commits are not subject to paste duplicate suppression; a held Cmd+V paste still is',async()=>{
 const h=keyboardHarness({safari:false});h.el.focus();
 h.sink.fire('beforeinput',{inputType:'insertText',data:'l',isComposing:false});
 h.sink.fire('beforeinput',{inputType:'insertText',data:'l',isComposing:false});
 await h.flush();assert.equal(received(h.calls),'ll');
 const d=keyboardHarness({safari:false});d.el.focus();
 d.keyboard.paste('Google');d.keyboard.paste('Google');await d.flush();
 assert.deepEqual(d.calls.map(c=>c.text),['Google']);
});

test('whitespace-only commits use Space keys; spaces inside a burst stay in the paste; order with keys is kept',async()=>{
 const h=keyboardHarness({safari:false});h.el.focus();
 h.sink.fire('beforeinput',{inputType:'insertText',data:' ',isComposing:false});
 await h.flush();
 assert.deepEqual(h.calls.map(c=>[c.action,c.code,c.text]),[['key','Space',undefined]]);
 h.calls.length=0;
 h.sink.fire('beforeinput',{inputType:'insertText',data:'a',isComposing:false});
 h.sink.fire('beforeinput',{inputType:'insertText',data:' ',isComposing:false});
 h.sink.fire('beforeinput',{inputType:'insertText',data:'b',isComposing:false});
 h.keyboard.key('Enter',[]);
 h.sink.fire('beforeinput',{inputType:'insertText',data:'c',isComposing:false});
 await h.flush();
 assert.equal(received(h.calls),'a b<Enter>c');
 assert.deepEqual(h.calls.map(c=>c.action),['paste','key','paste','key','paste']); // a, Space, b, Enter, c (nothing queued to merge the space into)
});

test('IME composition end is also coalesced without loss',async()=>{
 const h=keyboardHarness({safari:false});h.el.focus();
 for(const w of ['你','好','你','好']){h.sink.fire('compositionstart',{});h.sink.fire('compositionend',{data:w});}
 await h.flush();assert.equal(received(h.calls),'你好你好');
});

test('word-adjacent multi-character pastes are split; free-standing text stays one paste',async()=>{
 // controller E2E: "h" is pasted alone, the rest arrives while it is in flight
 const h=await typeChars('hello world');
 assert.deepEqual(h.calls.map(c=>c.action==='key'?`<${c.code}>`:c.text),['h','e','l','l','o','<Space>','world']);
 const g=await typeChars('abc 123');
 assert.equal(received(g.calls),'abc 123');assertNoWordJoinPaste(g.calls,'abc 123');
 // a fresh field accepts a whole word / sentence in one paste, and so does text after a tap
 const w=keyboardHarness({safari:false});w.el.focus();
 w.sink.fire('beforeinput',{inputType:'insertText',data:'hello world',isComposing:false});await w.flush();
 assert.deepEqual(w.calls.map(c=>c.text),['hello world']);
 w.el.fire('pointerdown',{});
 w.sink.fire('beforeinput',{inputType:'insertText',data:'again here',isComposing:false});await w.flush();
 assert.deepEqual(w.calls.map(c=>c.text),['hello world','again here']);
 // after a non-word tail the whole next chunk is one paste
 const p=keyboardHarness({safari:false});p.el.focus();
 p.sink.fire('beforeinput',{inputType:'insertText',data:'hi,',isComposing:false});await p.flush();
 p.sink.fire('beforeinput',{inputType:'insertText',data:'there',isComposing:false});await p.flush();
 assert.deepEqual(p.calls.map(c=>c.text),['hi,','there']);
 // CJK carries no inter-word spacing: no splitting
 const z=keyboardHarness({safari:false});z.el.focus();
 for(const w2 of ['你','好吗','你好']){z.sink.fire('compositionstart',{});z.sink.fire('compositionend',{data:w2});}
 await z.flush();assert.equal(received(z.calls),'你好吗你好');assert.ok(z.calls.length<5);
});

test('bridge reports server-side durations (no contents) and the viewer keeps the last round trips',async()=>{
 const {createClipboard}=require('../../baguette-simulator/node/clipboard.cjs');
 const origin='http://127.0.0.1:49113',udid='00000000-0000-4000-8000-000000000001';
 const bridge=await createClipboard(origin,async p=>({timing:{release:3,clipboard:5,paste:7,total:15}}));bridge.devices.add(udid);
 try{
  const [port,token]=bridge.fragment.split('=')[1].split('.');
  const reply=await fetch(`http://127.0.0.1:${port}/clipboard`,{method:'POST',headers:{Origin:origin,'X-Cindy-Clipboard':token},body:JSON.stringify({action:'paste',text:'secret words',udid})});
  const body=await reply.json();
  assert.deepEqual(body,{ok:true,execution:'executed',timing:{release:3,clipboard:5,paste:7,total:15}});
  assert.ok(!JSON.stringify(body).includes('secret'));
  // a bridge whose perform returns nothing keeps the original reply shape
  const plain=await createClipboard(origin,async()=>{});plain.devices.add(udid);
  try{const [p2,t2]=plain.fragment.split('=')[1].split('.');
   const b2=await (await fetch(`http://127.0.0.1:${p2}/clipboard`,{method:'POST',headers:{Origin:origin,'X-Cindy-Clipboard':t2},body:JSON.stringify({action:'copy',udid})})).json();
   assert.deepEqual(b2,{ok:true,execution:'executed'});
  }finally{plain.close();}
 }finally{bridge.close();}
 const h=keyboardHarness({safari:false});
 h.keyboard.key('KeyA',[]);h.keyboard.paste('abc');await h.flush();
 const log=Array.from(h.window.__baguetteInputTimings);
 assert.deepEqual(log.map(x=>[x.action,x.chars,x.server.total]),[['key',undefined,5],['paste',3,5]]);
 assert.ok(log.every(x=>typeof x.roundTripMs==='number'));assert.ok(!JSON.stringify(log).includes('abc'));
});
