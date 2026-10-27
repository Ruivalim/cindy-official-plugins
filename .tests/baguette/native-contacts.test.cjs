const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

// Run the actual viewer source: stable finger identity, asymmetric motion,
// immediate reverse, liftoff/cancel and detach. No simulator or timed waits.
function harness(){
  const handlers=new Map(),calls=[],dots=[];
  const target={addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener(){},getBoundingClientRect:()=>({left:30,top:50,width:200,height:400})};
  const window={...target};
  const screen={size:{width:400,height:800}};
  for(const name of ['touchDown','touchMove','touchUp'])screen[name]=points=>calls.push([name,JSON.parse(JSON.stringify(points))]);
  const dir=path.join(__dirname,'../../baguette-simulator/vendor/baguette/Baguette_Baguette.bundle/Web/baguette/gestures');
  for(const name of ['attachable-event-source','touch-gesture-source'])vm.runInNewContext(fs.readFileSync(path.join(dir,name+'.js'),'utf8'),{window});
  const source=new window.Baguette._TouchGestureSource(screen,{overlay:{setFingers:p=>dots.push(JSON.parse(JSON.stringify(p))),clear:()=>dots.push([])}});
  source.attach(target);
  const emit=(type,touches)=>handlers.get(type)({type,touches,preventDefault(){}});
  const native=(phase,touches)=>handlers.get('cindy-trackpad')({detail:{phase,touches}});
  return {emit,native,calls,dots,source};
}
test('raw contacts keep finger identity and reverse on the next input frame',()=>{
  const h=harness(),a={identifier:3,clientX:80,clientY:200},b={identifier:7,clientX:180,clientY:200};
  h.emit('touchstart',[a,b]);
  h.emit('touchmove',[{...b,clientX:220,clientY:220},a]);
  assert.deepEqual(h.calls.at(-1)[1].map(p=>[p.x,p.y]),[[100,300],[380,340]]);
  h.emit('touchmove',[a,{...b,clientX:160}]);
  assert.deepEqual(h.calls.at(-1)[1].map(p=>[p.x,p.y]),[[100,300],[260,300]]);
  assert.deepEqual(h.dots.at(-1),[{x:50,y:150},{x:130,y:150}]);
  h.emit('touchend',[a]);assert.equal(h.calls.at(-2)[0],'touchUp');assert.equal(h.calls.at(-2)[1].length,2);
  assert.equal(h.calls.at(-1)[0],'touchDown');assert.equal(h.calls.at(-1)[1].length,1);
  h.emit('touchend',[]);assert.equal(h.calls.at(-1)[0],'touchUp');assert.deepEqual(h.dots.at(-1),[]);
});
test('raw cancel and detach always release both contacts',()=>{
  const h=harness(),p=[{identifier:1,clientX:80,clientY:200},{identifier:2,clientX:180,clientY:200}];
  h.emit('touchstart',p);h.emit('touchcancel',[]);assert.equal(h.calls.at(-1)[0],'touchUp');
  h.emit('touchstart',p);h.source.detach();assert.equal(h.calls.at(-1)[0],'touchUp');assert.equal(h.calls.at(-1)[1].length,2);
});
test('native sample starts one two-finger stream and reverses without a single-finger prelude',()=>{
  const h=harness(),a={id:0,x:80,y:200},b={id:1,x:180,y:200};
  h.native('begin',[a,b]);assert.deepEqual(h.calls.map(c=>[c[0],c[1].length]),[['touchDown',2]]);
  h.native('change',[a,{...b,x:220}]);h.native('change',[a,{...b,x:160}]);
  assert.deepEqual(h.calls.at(-1)[1].map(p=>[p.x,p.y]),[[100,300],[260,300]]);
  h.native('cancel',[]);assert.equal(h.calls.at(-1)[0],'touchUp');assert.equal(h.calls.at(-1)[1].length,2);
});
