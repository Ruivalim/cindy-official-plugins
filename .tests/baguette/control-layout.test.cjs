const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const NODE='../../baguette-simulator/node/';
const read=f=>fs.readFileSync(require.resolve(NODE+f),'utf8');

function page({lang='en',coarse=false,stored=null,storageThrows=false}={}){
 const handlers={},store=new Map(stored?[['baguette.fullscreenDevice',stored]]:[]);
 const classes=new Set(),mediaListeners=[];
 const media={matches:coarse,addEventListener:(t,f)=>{if(t==='change')mediaListeners.push(f);}};
 const queries=[];
 const els={};
 const make=id=>({id,style:{},attrs:{},title:'',textContent:'',value:'1',addEventListener(){},setAttribute(k,v){this.attrs[k]=v;},getBoundingClientRect:()=>({width:402,height:844}),querySelector:()=>null,contentDocument:{querySelector:()=>null}});
 const document={documentElement:{lang},body:{classList:{toggle:(c,on)=>{on?classes.add(c):classes.delete(c);},contains:c=>classes.has(c)}},
  getElementById:id=>els[id]||(els[id]=make(id)),addEventListener:(t,f)=>{(handlers[t]||(handlers[t]=[])).push(f);}};
 const context={ResizeObserver:class{observe(){}},URLSearchParams,AbortSignal,location:{search:'?udid=test',hash:'#cindyClipboard=123.token'},document,
  setInterval(){},fetch:async()=>({ok:true,json:async()=>({ok:true,device:{state:'Booted'},ready:true,generation:1})}),
  matchMedia:q=>{queries.push(q);return media;},
  localStorage:storageThrows?{getItem(){throw Error('denied');},setItem(){throw Error('denied');}}:{getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v))}};
 vm.runInNewContext(read('control.js'),context);
 return {els,classes,store,queries,media,
  setCoarse(v){media.matches=v;for(const f of mediaListeners)f({matches:v});},
  key(key){for(const f of handlers.keydown||[])f({key});},
  get immersive(){return classes.has('immersive');},get sheet(){return classes.has('sheet');}};
}

test('desktop default is unchanged; a coarse primary pointer turns full-screen on by itself',()=>{
 const d=page({coarse:false});
 assert.equal(d.immersive,false);assert.equal(d.sheet,false);
 assert.equal(d.els.fullscreen.textContent,'Full-screen device');assert.equal(d.els['settings-fab'].attrs['aria-expanded'],'false');
 const t=page({coarse:true});
 assert.equal(t.immersive,true);assert.equal(t.els.fullscreen.textContent,'Exit full screen');assert.equal(t.els.fullscreen.attrs['aria-pressed'],'true');
 assert.deepEqual(t.queries,['(pointer: coarse)'],'only the primary pointer decides (never any-pointer)');
 assert.ok(!/any-pointer/.test(read('control.js')+read('control.css')));
});

test('the settings sheet opens from the floating button and closes with Escape; leaving full screen closes it',()=>{
 const t=page({coarse:true});
 t.els['settings-fab'].onclick();assert.equal(t.sheet,true);assert.equal(t.els['settings-fab'].attrs['aria-expanded'],'true');
 t.key('x');assert.equal(t.sheet,true);t.key('Escape');assert.equal(t.sheet,false);assert.equal(t.immersive,true);
 t.els['settings-fab'].onclick();t.els.fullscreen.onclick();
 assert.equal(t.immersive,false);assert.equal(t.sheet,false);
});

test('a manual choice beats the automatic one, is remembered, and survives media changes',()=>{
 const t=page({coarse:true});
 t.els.fullscreen.onclick(); // leave full screen on a touch device
 assert.equal(t.immersive,false);assert.equal(t.store.get('baguette.fullscreenDevice'),'off');
 t.setCoarse(false);t.setCoarse(true);assert.equal(t.immersive,false,'auto must not override a manual choice');
 assert.equal(page({coarse:true,stored:'off'}).immersive,false,'remembered off wins over coarse');
 const d=page({coarse:false});d.els.fullscreen.onclick();
 assert.equal(d.immersive,true);assert.equal(d.store.get('baguette.fullscreenDevice'),'on');
 assert.equal(page({coarse:false,stored:'on'}).immersive,true,'remembered on wins over fine pointer');
 assert.equal(page({coarse:false,stored:'garbage'}).immersive,false);
});

test('without a manual choice the layout follows the pointer; unavailable storage is harmless',()=>{
 const a=page({coarse:false});a.setCoarse(true);assert.equal(a.immersive,true);a.setCoarse(false);assert.equal(a.immersive,false);
 const s=page({coarse:true,storageThrows:true});
 assert.equal(s.immersive,true);s.els.fullscreen.onclick();assert.equal(s.immersive,false);
});

test('labels are Chinese on the Chinese page and both pages carry the same structure',()=>{
 const z=page({lang:'zh-CN',coarse:true});
 assert.equal(z.els.fullscreen.textContent,'退出全屏');assert.equal(z.els['settings-fab'].attrs['aria-label'],'显示设置');assert.equal(z.els['settings-fab'].title,'显示设置');
 const e=page({coarse:true});assert.equal(e.els['settings-fab'].attrs['aria-label'],'Display settings');
 for(const [file,full,fab] of [['control.html','Full-screen device','Display settings'],['control.zh-CN.html','全屏设备','显示设置']]){
  const html=read(file);
  const order=['<div id="settings">','<header>','class="hint"','class="devices"','</div><button id="settings-fab"','id="notice"','id="viewport"'].map(x=>html.indexOf(x));
  assert.ok(order.every((x,i)=>x>=0&&(i===0||x>order[i-1])),file+' structure/order '+order);
  assert.match(html,new RegExp(`<button id="fullscreen" aria-pressed="false">${full}</button>`));
  assert.match(html,new RegExp(`<button id="settings-fab" type="button" aria-label="${fab}" title="${fab}" aria-controls="settings" aria-expanded="false">`));
  for(const id of ['release','recover','shutdown','zoom','device-select'])assert.ok(html.includes(`id="${id}"`),id);
 }
});

test('the stylesheet only changes the layout under body.immersive; the default layout rules are untouched',()=>{
 const css=read('control.css');
 const added=css.slice(css.indexOf('/* Full-screen device'));
 for(const rule of added.split('}').map(x=>x.trim()).filter(x=>x&&!x.startsWith('@media')&&!x.startsWith('/*')&&!x.startsWith('body.immersive')&&!x.startsWith('#settings-fab')&&!x.startsWith('body.immersive')))assert.fail('unexpected unscoped rule: '+rule);
 assert.match(css,/body\.immersive #settings\{display:none\}/);
 assert.match(css,/body\.immersive\.sheet #settings\{display:block;position:fixed/);
 assert.match(css,/#settings-fab\{display:none/);
 assert.match(css,/height:100vh;height:100dvh/);
 // the original header/devices rules still exist
 for(const needle of ['header{display:flex;align-items:center','#viewport{flex:1;min-height:0;overflow:auto}','.devices{padding:10px 16px'])assert.ok(css.includes(needle),needle);
});
