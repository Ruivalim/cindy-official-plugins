'use strict';
const zh=document.documentElement.lang==='zh-CN';
const T=zh?{connected:'设备运行中 · 画面已连接',off:'设备已关闭',service:'画面服务已停止',recovering:'正在恢复连接…',offline:'画面连接已断开，设备状态未知',retry:'请点击“恢复画面”。',disconnected:'请到「插件 → Baguette」查看设备状态或关闭设备。画面断开不代表设备已关闭。',failed:'未能确认操作结果，请到插件设置页核对设备状态。',released:'按键已释放。',stopping:'正在关闭设备…',stopped:'设备已关闭，App 和连接已停止；数据保留。',idle:'闲置后自动关闭：',minute:' 分钟。',manual:'自动关闭未开启，请用“关闭设备”结束使用。',soon:'设备即将因闲置关闭；操作画面可继续使用。',enterFull:'全屏设备',exitFull:'退出全屏',settings:'显示设置'}:{connected:'Device running · Viewer connected',off:'Device shut down',service:'Viewer stopped',recovering:'Reconnecting…',offline:'Viewer disconnected · Device state unknown',retry:'Click Recover view to retry.',disconnected:'Open Plugins → Baguette to check or shut down the device. Losing the picture does not mean the device is off.',failed:'Operation not confirmed. Check device status in plugin settings.',released:'Keys released.',stopping:'Shutting down device…',stopped:'Device shut down. Apps and connections stopped; data kept.',idle:'Automatic idle shutdown: ',minute:' minutes.',manual:'Automatic shutdown is off. Use Shut down device when finished.',soon:'Idle shutdown is approaching. Interact with the screen to continue.',enterFull:'Full-screen device',exitFull:'Exit full screen',settings:'Display settings'};
let udid=new URLSearchParams(location.search).get('udid');
const cap=new URLSearchParams(location.hash.slice(1)).get('cindyClipboard');
const token=cap?.split('.')[1];
const screen=document.getElementById('screen'),status=document.getElementById('status'),button=document.getElementById('recover'),notice=document.getElementById('notice'),shutdown=document.getElementById('shutdown'),release=document.getElementById('release'),zoom=document.getElementById('zoom');
let generation=null,checking=false,recovering=false,stopping=false,stopped=false,lastTouch=0,switching=false;
function message(value){notice.textContent=value;notice.style.display=value?'block':'none';}
function load(){screen.src='/simulators/'+encodeURIComponent(udid)+location.hash;}
function applyZoom(){
  const viewport=document.getElementById('viewport'),stage=document.getElementById('stage');
  const {width,height}=viewport.getBoundingClientRect(),scale=Number(zoom.value);
  screen.style.width=width+'px';screen.style.height=height+'px';
  screen.style.transform='scale('+scale+')';
  stage.style.width=width*scale+'px';stage.style.height=height*scale+'px';
}
async function api(action,params={}){const r=await fetch('/control-api',{method:'POST',headers:{'Content-Type':'application/json','X-Cindy-Clipboard':token},body:JSON.stringify({...params,action,udid,locale:zh?'zh-CN':'en'}),signal:AbortSignal.timeout(['shutdown','create'].includes(action)?120000:20000)});const p=await r.json();if(!r.ok||p.ok===false)throw Error(p.errorCode||'CONTROL_FAILED');return p;}
function closed(){stopped=true;generation=null;screen.src='about:blank';status.textContent=T.off;button.disabled=release.disabled=shutdown.disabled=true;message(T.stopped);}
async function check(){
  if(checking||recovering||stopping)return;checking=true;
  try{
    const s=await api('status');if(recovering||stopping)return;
    if(globalThis.baguetteDevices?.update(s))return;
    if(s.device?.state==='Shutdown'){if(!stopped)closed();return;}
    stopped=false;button.disabled=release.disabled=shutdown.disabled=false;
    status.textContent=s.ready?T.connected:s.parked?T.service:T.recovering;
    const soon=s.idleDeadline&&s.idleDeadline-Date.now()<60000;
    message(soon?T.soon:s.parked?T.retry:'');
    document.getElementById('idle').textContent=s.settings?.idleMinutes?T.idle+s.settings.idleMinutes+T.minute:T.manual;
    if(s.ready&&(generation===null||screen.contentDocument?.querySelector('[data-viewer-unavailable]'))){generation=s.generation;load();}
  }catch{if(!stopped){status.textContent=T.offline;message(T.disconnected);}}
  finally{checking=false;}
}
button.onclick=async()=>{
  if(recovering||stopping||stopped||switching)return;recovering=true;button.disabled=true;status.textContent=T.recovering;message('');screen.src='about:blank';
  try{const s=await api('restart');generation=s.generation;load();status.textContent=T.connected;}
  catch{message(T.retry);status.textContent=T.offline;}
  finally{button.disabled=false;recovering=false;}
};
release.onclick=async()=>{release.disabled=true;screen.contentWindow?.postMessage({type:'cindy-release-input'},location.origin);try{await api('release');message(T.released);}catch{message(T.failed);}finally{release.disabled=stopped;}};
shutdown.onclick=async()=>{
  if(stopping||stopped||switching)return;stopping=true;shutdown.disabled=button.disabled=release.disabled=true;
  status.textContent=T.stopping;screen.src='about:blank';
  try{const result=await api('shutdown');if(!result.devices?.some(d=>d.udid===udid&&d.state==='Shutdown'))throw Error('UNCONFIRMED');closed();}
  catch{message(T.failed);status.textContent=T.offline;generation=null;}
  finally{stopping=false;if(!stopped)shutdown.disabled=button.disabled=release.disabled=false;}
};
function activity(event){if(!event.isTrusted||stopped||stopping||switching||Date.now()-lastTouch<10000)return;lastTouch=Date.now();api('activity').catch(()=>{});}
screen.addEventListener('load',()=>{applyZoom();try{const doc=screen.contentDocument;for(const name of ['pointerdown','keydown','wheel'])doc?.addEventListener(name,activity,{passive:true,capture:true});}catch{}});
zoom.onchange=()=>{applyZoom();};
// Full-screen device: collapse the settings so the viewer fills the page. Automatic while the primary pointer
// is coarse (a phone viewing this page); a manual choice always wins and is remembered (best effort).
const fullscreenButton=document.getElementById('fullscreen'),settingsFab=document.getElementById('settings-fab');
const LAYOUT_KEY='baguette.fullscreenDevice',coarse=globalThis.matchMedia?.('(pointer: coarse)');
let layoutChoice=null,sheetOpen=false;
try{const saved=globalThis.localStorage?.getItem(LAYOUT_KEY);layoutChoice=saved==='on'?true:saved==='off'?false:null;}catch{}
const fullscreenOn=()=>layoutChoice!==null?layoutChoice:!!coarse?.matches;
function renderLayout(){
  const on=fullscreenOn();if(!on)sheetOpen=false;
  const classes=document.body?.classList;
  classes?.toggle('immersive',on);classes?.toggle('sheet',on&&sheetOpen);
  if(settingsFab){settingsFab.setAttribute('aria-expanded',String(on&&sheetOpen));settingsFab.setAttribute('aria-label',T.settings);settingsFab.title=T.settings;}
  if(fullscreenButton){fullscreenButton.textContent=on?T.exitFull:T.enterFull;fullscreenButton.setAttribute('aria-pressed',String(on));}
  applyZoom();
}
if(fullscreenButton)fullscreenButton.onclick=()=>{layoutChoice=!fullscreenOn();sheetOpen=false;try{globalThis.localStorage?.setItem(LAYOUT_KEY,layoutChoice?'on':'off');}catch{}renderLayout();};
if(settingsFab)settingsFab.onclick=()=>{sheetOpen=!sheetOpen;renderLayout();};
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&sheetOpen){sheetOpen=false;renderLayout();}});
coarse?.addEventListener?.('change',()=>{if(layoutChoice===null)renderLayout();});
renderLayout();
new ResizeObserver(applyZoom).observe(document.getElementById('viewport'));applyZoom();
globalThis.baguetteController={api,check,message,get udid(){return udid;},get busy(){return recovering||stopping;},
 switching(value,label){switching=value;if(value){screen.src='about:blank';generation=null;status.textContent=label;button.disabled=release.disabled=shutdown.disabled=true;}},
 adopt(id){udid=id;generation=null;stopped=false;const url=new URL(location.href);url.searchParams.set('udid',id);history.replaceState(null,'',url);screen.src='about:blank';},
};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)check();});check();setInterval(check,3000);
