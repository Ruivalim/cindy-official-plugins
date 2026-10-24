'use strict';
(() => {
  const udid=location.pathname.split('/')[2],token=new URLSearchParams(location.search).get('cindyViewer');
  const canvas=document.getElementById('display'),ctx=canvas.getContext('2d'),frame=document.getElementById('nativeDeviceFrame'),message=document.getElementById('message');
  const zh=parent.document.documentElement.lang==='zh-CN';let closed=false,rotation=0,deviceRotation=0,busy=false;const pointers=new Map();
  let paintedRotation=null,lastRotationStep=1;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  let queue=Promise.resolve(),queued=0,epoch=0;
  function input(action,extra={}){
    if(queued>=128&&action!=='release')return Promise.reject(Error('Input queue full'));
    const current=epoch;queued++;
    const next=queue.then(()=>{if(current===epoch)return send(action,extra);}).finally(()=>{queued--;});queue=next.catch(()=>{});return next;
  }
  async function send(action,extra={}){
    const r=await fetch('/android-input',{method:'POST',headers:{'Content-Type':'application/json','X-Cindy-Clipboard':token},body:JSON.stringify({udid,action,...extra}),signal:AbortSignal.timeout(20000)});
    const result=await r.json();if(!r.ok||result.ok===false)throw Error(result.message||'Input failed');return result;
  }
  function error(){message.hidden=false;message.textContent=zh?'操作未确认，请查看设备状态。':'Action not confirmed. Check the device state.';}
  function fit(){
    if(!canvas.width)return;
    const width=innerWidth-24,height=innerHeight-24,landscape=canvas.width>canvas.height;
    const ratio=Math.min(canvas.width,canvas.height)/Math.max(canvas.width,canvas.height);
    // Like the iPhone bezel, size the portrait body first. Turning it must
    // not enlarge it to fill extra horizontal space; only cap an overflow.
    const length=Math.min(height,width/ratio,landscape?width:Infinity);
    frame.style.width=(landscape?length:length*ratio)+'px';
    frame.style.height=(landscape?length*ratio:length)+'px';
  }
  async function stream(){
    while(!closed){
      try{
        const r=await fetch(`/android-stream?udid=${encodeURIComponent(udid)}`,{headers:{'X-Cindy-Clipboard':token}});if(!r.ok)throw Error('Disconnected');const reader=r.body.getReader();let buffer=new Uint8Array();
        for(;;){const {done,value}=await reader.read();if(done)break;const next=new Uint8Array(buffer.length+value.length);next.set(buffer);next.set(value,buffer.length);buffer=next;
          while(buffer.length>=6){const length=new DataView(buffer.buffer,buffer.byteOffset,4).getUint32(0);if(length>32e6)throw Error('Invalid frame');if(buffer.length<length+6)break;
            const nextRotation=buffer[4],nextDeviceRotation=buffer[5];const blob=new Blob([buffer.slice(6,6+length)],{type:'image/png'});buffer=buffer.slice(6+length);const bitmap=await createImageBitmap(blob);
            const turned=paintedRotation!==null&&nextDeviceRotation!==paintedRotation;
            const currentTransform=turned?getComputedStyle(frame).transform:null;
            if((nextRotation!==rotation||turned)&&pointers.size){extras?.release();epoch++;pointers.clear();dirty=false;input('release').catch(error);}
            rotation=nextRotation;deviceRotation=nextDeviceRotation;
            // The stream already follows the physical device. A portrait-locked
            // activity must not force the whole device frame back to portrait.
            canvas.width=bitmap.width;canvas.height=bitmap.height;ctx.drawImage(bitmap,0,0);bitmap.close();fit();message.hidden=true;
            if(turned){
              let turns=(nextDeviceRotation-paintedRotation+4)%4;
              if(turns===3)turns=-1;else if(turns===2)turns=-2*Math.sign(lastRotationStep);
              // Preserve the visible pose across the stream's pixel rotation,
              // then turn frame and screen together with the iPhone's easing.
              const from=new DOMMatrix(currentTransform==='none'?undefined:currentTransform).rotate(turns*90);
              for(const animation of frame.getAnimations())animation.cancel();
              if(!reducedMotion.matches)frame.animate([{transform:from.toString()},{transform:'none'}],{duration:320,easing:'cubic-bezier(0.32, 0.72, 0, 1)'});
            }
            paintedRotation=nextDeviceRotation;
          }
        }
      }catch{message.hidden=false;message.textContent=zh?'正在连接设备画面…':'Connecting to device…';}
      if(!closed)await new Promise(r=>setTimeout(r,500));
    }
  }
  const position=e=>{const r=canvas.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
  // Coalesce pointer moves, but always flush releases. A slow screen cannot
  // build an unbounded queue of stale input behind the user's finger.
  let dirty=false,flushing=null;
  function flush(start=false){if(busy){dirty=true;return flushing;}busy=true;flushing=(async()=>{try{do{dirty=false;const touches=[...pointers.values()].map(t=>({...t}));if(touches.length)await input('touch',{touches,rotation,deviceRotation,start});start=false;for(const [id,t]of pointers)if(t.pressure===0&&touches.some(sent=>sent.identifier===t.identifier&&sent.pressure===0))pointers.delete(id);}while(dirty);}catch{pointers.clear();await input('release').catch(()=>{});error();}finally{busy=false;flushing=null;}})();return flushing;}
  canvas.addEventListener('pointerdown',e=>{e.preventDefault();canvas.focus();if(pointers.size>=10||frame.getAnimations().some(a=>a.playState==='running'))return;const used=new Set([...pointers.values()].map(t=>t.identifier));let identifier=0;while(used.has(identifier))identifier++;const pos=position(e);pointers.set(e.pointerId,{identifier,pressure:1024,...pos});if(e.altKey&&pointers.size===1)pointers.set('mirror',{identifier:identifier===0?1:0,pressure:1024,x:1-pos.x,y:1-pos.y});canvas.setPointerCapture(e.pointerId);flush(true);});
  canvas.addEventListener('pointermove',e=>{const t=pointers.get(e.pointerId);if(!t)return;Object.assign(t,position(e));const mirror=pointers.get('mirror');if(mirror)Object.assign(mirror,{x:1-t.x,y:1-t.y});flush();});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,e=>{const t=pointers.get(e.pointerId);if(t){t.pressure=0;if(pointers.has('mirror'))pointers.get('mirror').pressure=0;flush();}});
  canvas.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v')return;
    if(e.key.length===1||['Enter','Tab','Backspace','Delete','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){
      e.preventDefault();const modifiers=[e.ctrlKey||e.metaKey?'ctrl':null,e.altKey?'alt':null,e.shiftKey&&e.key.length>1?'shift':null].filter(Boolean);input('type',{keys:[...modifiers,e.key].join('+')}).catch(error);
    }
  });
  canvas.addEventListener('paste',e=>{const text=e.clipboardData?.getData('text/plain');if(text){e.preventDefault();input('type',{text}).catch(error);}});
  window.__nativeHome=()=>input('press',{button:'home'}).catch(error);
  window.__nativeAppSwitcher=()=>input('press',{button:'app-switcher'}).catch(error);
  window.__nativeBack=()=>input('press',{button:'back'}).catch(error);
  window.__nativeShake=()=>input('press',{button:'shake'}).catch(error);
  window.__nativeRotateBy=step=>{lastRotationStep=step;deviceRotation=(deviceRotation-step+4)%4;input('rotate',{orientation:['portrait','landscape-left','portrait-upside-down','landscape-right'][deviceRotation]}).catch(error);};
  window.__nativeOrientation=()=>['portrait','landscape-left','portrait-upside-down','landscape-right'][deviceRotation];
  const extras=window.androidScreenActions?.({canvas,frame,input,pointers,flush,zh});
  addEventListener('resize',fit);addEventListener('blur',()=>{extras?.release();epoch++;pointers.clear();dirty=false;input('release').catch(()=>{});});
  addEventListener('pagehide',()=>{closed=true;epoch++;pointers.clear();fetch('/android-input',{method:'POST',headers:{'Content-Type':'application/json','X-Cindy-Clipboard':token},body:JSON.stringify({udid,action:'release'}),keepalive:true}).catch(()=>{});});
  stream();
})();
