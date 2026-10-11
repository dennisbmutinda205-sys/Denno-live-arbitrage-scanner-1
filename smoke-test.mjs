import {spawn} from 'node:child_process';
import http from 'node:http';
const port=18878;const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url).pathname,env:{...process.env,PORT:String(port),MOCK_MODE:'true',POLL_MS:'100000'},stdio:['ignore','pipe','pipe']});
let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
const get=p=>new Promise((resolve,reject)=>{const req=http.get(`http://127.0.0.1:${port}${p}`,r=>{let b='';r.on('data',x=>b+=x);r.on('end',()=>resolve({status:r.statusCode,body:b,headers:r.headers}));});req.on('error',reject);});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{await wait(700);const h=await get('/api/health');if(h.status!==200)throw Error('health failed');const idx=await get('/');if(idx.status!==200||!idx.body.includes('Arbitrage Radar'))throw Error('frontend failed');const s=await get('/api/scan?mode=spot-spot');if(s.status!==200)throw Error('scan endpoint failed');const j=JSON.parse(s.body);if(!Array.isArray(j.opportunities))throw Error('scan payload invalid');console.log('SMOKE PASS');console.log(`health=${h.status}, frontend=${idx.status}, scan=${s.status}, opportunities=${j.opportunities.length}`);}catch(e){console.error('SMOKE FAIL',e);console.error(output);process.exitCode=1}finally{child.kill('SIGTERM');}
