'use strict';
const http=require('node:http');
const {randomBytes}=require('node:crypto');
// An unguessable capability plus exact viewer Origin: other local pages cannot
// use the bridge. No clipboard contents, tokens, or request bodies are logged.
async function createClipboard(origin,perform,control){
 const token=randomBytes(32).toString('hex'),devices=new Set();let busy=false;const sockets=new Set();
 const authorized=req=>req.headers.cookie?.split(';').some(part=>part.trim()===`cindy_viewer_${server.address().port}=${token}`)===true;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const own=`127.0.0.1:${server.address().port}`;
  if(req.headers.host!==own)return reply(403,{error:'Invalid host'});
  if(control&&req.method==='GET'){
   if(['/control.js','/control.css','/devices.js'].includes(req.url)){
    res.writeHead(200,{'Content-Type':req.url.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8','X-Content-Type-Options':'nosniff'});
    return res.end(require('node:fs').readFileSync(require('node:path').join(__dirname,req.url.slice(1))));
   }
   if(req.url.startsWith('/control?')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});return res.end(require('./viewer-proxy.cjs')[new URL(req.url,'http://localhost').searchParams.get('lang')==='zh-CN'?'chineseHtml':'html']);}
   if(!authorized(req))return reply(403,{error:'Viewer capability required'});
   if(req.url.startsWith('/map/'))return require('./map.cjs').serveMap(req,res,own);
   return require('./viewer-proxy.cjs').proxyRequest(req,res,control.port);
  }
  if(req.headers.origin!==origin&&req.headers.origin!==`http://${own}`)return reply(403,{error:'Invalid origin',execution:'not_executed'});
  res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
  if(req.method==='OPTIONS'){
   res.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type, X-Cindy-Clipboard','Access-Control-Allow-Private-Network':'true'});return res.end();
  }
  if(control&&!['/clipboard','/control-api'].includes(req.url)){
   if(!authorized(req))return reply(403,{error:'Viewer capability required'});
   try{
    const operation=async()=>{
     await control.guard?.();
     await new Promise(resolve=>{res.once('finish',resolve);res.once('close',resolve);require('./viewer-proxy.cjs').proxyRequest(req,res,control.port);});
     control.touch?.();
    };
    return await (control.run?control.run(operation):operation());
   }catch(error){if(!res.headersSent)return reply(409,{errorCode:error.code||'CONTROL_FAILED',error:'Device operation unavailable. Check plugin settings.',execution:'not_executed'});return;}
  }
  if(req.method!=='POST'||!['/clipboard',...(control?['/control-api']:[])].includes(req.url)||req.headers['x-cindy-clipboard']!==token)return reply(403,{error:'Invalid capability',execution:'not_executed'});
  const chunks=[];let bytes=0;
  try{
   for await(const chunk of req){bytes+=chunk.length;if(bytes>40000){reply(413,{error:'Text too long',execution:'not_executed'});req.destroy();return;}chunks.push(chunk);}
   const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!devices.has(p.udid))return reply(400,{error:'Unknown device',execution:'not_executed'});
   if(req.url==='/control-api'){
    res.setHeader('Set-Cookie',`cindy_viewer_${server.address().port}=${token}; HttpOnly; SameSite=Strict; Path=/`);
    if(!['status','restart','release','shutdown','activity','catalog','create','rename','switch'].includes(p.action))return reply(400,{error:'Invalid action'});
    try{const result=await control[p.action](p);return reply(result?.ok===false?409:200,result);}
    catch(error){return reply(503,{errorCode:error.code||'CONTROL_FAILED',error:'Operation not confirmed. Refresh the device status in Baguette settings.',execution:error.execution||'unknown'});}
   }
   if(!['paste','copy','key','release'].includes(p.action)||(p.action==='paste'&&(typeof p.text!=='string'||!p.text.length||p.text.length>8000||p.text.includes('\0'))))return reply(400,{error:'Invalid clipboard request',execution:'not_executed'});
   if(busy)return reply(409,{error:'Clipboard busy; try again',execution:'not_executed'});
   busy=true;
   try{let timing;const operation=async()=>{await control?.guard?.();timing=(await perform(p))?.timing;control?.touch?.();};await(control?.run?control.run(operation):operation());reply(200,{ok:true,execution:'executed',...(timing&&typeof timing==='object'?{timing}:{})});}
   catch(error){reply(500,{error:'Clipboard operation failed; check the device and retry.',execution:error.execution||'unknown'});}
   finally{busy=false;}
  }catch{if(!res.headersSent)reply(400,{error:'Invalid request',execution:'not_executed'});}
 });
 if(control)require('./viewer-proxy.cjs').attachUpgrade(server,control.port,sockets,authorized);
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {devices,base:`http://127.0.0.1:${server.address().port}`,fragment:`cindyClipboard=${server.address().port}.${token}`,close(){for(const socket of sockets)socket.destroy();server.close();server.closeAllConnections();}};
}
module.exports={createClipboard};
