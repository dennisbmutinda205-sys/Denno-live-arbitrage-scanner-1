import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||8787);
const POLL_MS=Number(process.env.POLL_MS||5000);
const TRADE_USDT=Number(process.env.TRADE_USDT||50);
const MOCK=String(process.env.MOCK_MODE||'false').toLowerCase()==='true';

const EXCHANGES=[
 ['binance','Binance'],['btse','BTSE'],['bybit','Bybit'],['bitget','Bitget'],['okx','OKX'],['bingx','BingX'],['xt','XT'],['mexc','MEXC'],['gateio','Gate.io'],['htx','HTX'],['weex','WEEX'],['bitrue','Bitrue'],['coinex','CoinEx'],['kraken','Kraken'],['kucoin','KuCoin'],['cryptocom','Crypto.com'],['levelx','LevelX'],['blofin','BloFin'],['bitfinex','Bitfinex']
];
const IDS={gateio:'gate',cryptocom:'cryptocom'};
const COMMON=['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT','DOGE/USDT','ADA/USDT','AVAX/USDT','LINK/USDT','TRX/USDT'];
const exMap=new Map(); const networkCache=new Map(); const lifecycle=new Map(); const sse=new Set();
let lastScan={}; let scanning=false;

function sendJSON(res,code,obj){res.writeHead(code,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','cache-control':'no-store'});res.end(JSON.stringify(obj));}
function fmtSymbol(s){return String(s||'').replace('-','/').replace('_','/').toUpperCase();}
function now(){return Date.now();}
function fee(ex,market){const x=Number(market?.taker ?? ex?.fees?.trading?.taker);return Number.isFinite(x)&&x>=0?x:0.001;}
function vwap(book,quote,side){const lv=side==='buy'?book.asks:book.bids;let rem=quote,base=0,spent=0;for(const [p0,a0] of lv||[]){const p=Number(p0),a=Number(a0);if(!(p>0&&a>0))continue;const q=Math.min(rem,p*a);base+=q/p;spent+=q;rem-=q;if(rem<=1e-8)break;}if(spent<quote*0.9995)return null;return {base,quote:spent,vwap:spent/base};}
function depth(book,side){const levels=side==='buy'?(book?.asks||[]):(book?.bids||[]);return levels.slice(0,20).reduce((x,[p,a])=>x+Number(p)*Number(a),0);}
function baseOf(s){return s.split('/')[0];}

async function loadCCXT(){if(MOCK)return;let ccxt;try{ccxt=await import('ccxt');}catch(e){throw new Error('CCXT is not installed. Run npm install before live mode.');}
 for(const [id] of EXCHANGES){const ccid=IDS[id]||id;if(!ccxt.default[ccid]){exMap.set(id,{id,name:EXCHANGES.find(x=>x[0]===id)?.[1],unsupported:true,error:'Exchange is not available in this CCXT build'});continue;}try{const ex=new ccxt.default[ccid]({enableRateLimit:true,timeout:12000});await ex.loadMarkets();exMap.set(id,ex);}catch(e){exMap.set(id,{id,error:e.message});}}
}
function eligible(ex,kind,sym){const markets=ex.markets||{};if(kind==='spot')return markets[sym]?.spot===true?markets[sym]:null;const direct=markets[sym+':USDT'];if(direct&&(direct.swap||direct.future)&&direct.linear)return direct;for(const m of Object.values(markets)){if(fmtSymbol(m.base+'/'+m.quote)===sym&&m.linear&& (m.swap||m.future))return m;}return null;}
async function getBook(ex,kind,sym){if(MOCK){const base={"BTC/USDT":62000,"ETH/USDT":2450,"SOL/USDT":145,"XRP/USDT":2.5,"BNB/USDT":650,"DOGE/USDT":.14,"ADA/USDT":.45,"AVAX/USDT":22,"LINK/USDT":18,"TRX/USDT":.3}[sym]||100;const shift=((ex.id.charCodeAt(0)%7)-3)*0.0009;const p=base*(1+shift+(kind==='futures'?0.002:0));return {symbol:sym,market:{taker:.001},book:{asks:[[p*1.0005,10_000_000/p],[p*1.001,10_000_000/p]],bids:[[p*.9995,10_000_000/p],[p*.999,10_000_000/p]]},ts:now()};}
 const market=eligible(ex,kind,sym);if(!market)return null;const book=await ex.fetchOrderBook(market.symbol,20);return {symbol:sym,market,book,ts:book.timestamp||now()};}

function chooseNetwork(buyEx,sellEx,asset){const a=networkCache.get(buyEx.id)?.currencies?.[asset];const b=networkCache.get(sellEx.id)?.currencies?.[asset];if(!a||!b)return null;const an=a.networks||a;const bn=b.networks||b;const candidates=[];for(const [n,x] of Object.entries(an)){const y=bn[n];if(!y)continue;if(x.withdraw===false||y.deposit===false)continue;const f=Number(x.fee);if(Number.isFinite(f)&&f>=0)candidates.push({network:n,feeAsset:f,withdrawFeeUSD:null});}return candidates.sort((x,y)=>x.feeAsset-y.feeAsset)[0]||null;}
async function updateNetworks(){if(MOCK)return;for(const [id,ex] of exMap){if(!ex.fetchCurrencies)continue;try{const c=await ex.fetchCurrencies();networkCache.set(id,{updatedAt:now(),currencies:c});}catch(e){networkCache.set(id,{updatedAt:now(),error:e.message});}}}

function opportunity(mode,buy,sell,bb,sb){const q=TRADE_USDT;const bf=vwap(bb.book,q,'buy'),sf=vwap(sb.book,q,'sell');if(!bf||!sf)return null;const br=fee(buy,bb.market),sr=fee(sell,sb.market);const base=Math.min(bf.base*(1-br),sf.base);const cost=base*bf.vwap;const proceeds=base*sf.vwap*(1-sr);const tradingNet=proceeds-cost;const netSpread=cost>0?tradingNet/cost*100:0;if(netSpread<=0)return null;const asset=baseOf(bb.symbol);const net=chooseNetwork(buy,sell,asset);let transferUSD=null,transferStatus='UNKNOWN';if(net&&Number.isFinite(net.feeAsset)){const reference=bf.vwap;transferUSD=net.feeAsset*reference;transferStatus='VERIFIED NETWORK FEE';}
 const fullNet=transferUSD===null?tradingNet:tradingNet-transferUSD;const fullPct=cost>0?fullNet/cost*100:0;const id=`${mode}|${buy.id}|${sell.id}|${bb.symbol}`;const old=lifecycle.get(id);const firstSeen=old?.firstSeen||now();const row={id,mode,symbol:bb.symbol,buyExchange:buy.id,sellExchange:sell.id,buyPrice:bf.vwap,sellPrice:sf.vwap,grossSpreadPct:(sf.vwap/bf.vwap-1)*100,buyTradingFeePct:br*100,sellTradingFeePct:sr*100,tradeUSDT:cost,tradingNetProfitUSD:tradingNet,transferFeeUSD,netProfitUSD:fullNet,netSpreadPct:fullPct,liquidityUSD:Math.min(depth(bb.book,'buy'),depth(sb.book,'buy')),buyDepthUSD:depth(bb.book,'buy'),sellDepthUSD:depth(sb.book,'buy'),transferStatus,transferTime:'UNKNOWN',network:net?.network||null,networkStatus:net?'COMPATIBLE':'UNKNOWN',firstSeen,lifetimeSec:(now()-firstSeen)/1000,status:'ACTIVE',confidence:'LIVE ORDER BOOK'};lifecycle.set(id,{firstSeen,lastSeen:now(),active:true});return row;}

async function scan(mode){const rows=[];const kindA=mode==='spot-spot'||mode==='spot-futures'?'spot':'futures';const kindB=mode==='futures-futures'||mode==='spot-futures'?'futures':'spot';const active=[];const exchanges=[...exMap.values()].filter(x=>!x.unsupported&&!x.error);
 for(const sym of COMMON){
  const A=[];const B=[];for(const ex of exchanges){try{const a=await getBook(ex,kindA,sym);if(a)A.push({ex,a});}catch{} try{const b=await getBook(ex,kindB,sym);if(b)B.push({ex,b});}catch{}}
  for(const x of A)for(const y of B)if(x.ex.id!==y.ex.id){const r=opportunity(mode,x.ex,y.ex,x.a,y.b);if(r)rows.push(r);}
 }
 const dedup=new Map(rows.map(r=>[r.id,r]));const out=[...dedup.values()].sort((a,b)=>b.netProfitUSD-a.netProfitUSD).slice(0,250);const present=new Set(out.map(x=>x.id));for(const [id,v] of lifecycle){if(id.startsWith(mode+'|')&&!present.has(id)&&v.active){v.active=false;v.lastSeen=now();v.disappearedAt=now();}}lastScan[mode]={timestamp:now(),opportunities:out};return out;}

async function runLoop(){if(scanning)return;scanning=true;try{await loadCCXT();await updateNetworks();}catch(e){console.error(e)}while(scanning){for(const mode of ['spot-spot','spot-futures','futures-futures']){try{const opportunities=await scan(mode);const payload=JSON.stringify({type:'opportunities',mode,opportunities,timestamp:now()});for(const res of sse){res.write(`data: ${payload}\\n\\n`);}}catch(e){for(const res of sse)res.write(`data: ${JSON.stringify({type:'error',mode,error:e.message,timestamp:now()})}\\n\\n`);}}await new Promise(r=>setTimeout(r,POLL_MS));}}

function serve(req,res){const url=new URL(req.url,`http://${req.headers.host}`);if(url.pathname==='/api/health')return sendJSON(res,200,{ok:true,mock:MOCK,exchanges:EXCHANGES.map(([id,name])=>({id,name,loaded:!!exMap.get(id)&&!exMap.get(id)?.error&&!exMap.get(id)?.unsupported})),time:now()});
 if(url.pathname==='/api/exchanges')return sendJSON(res,200,EXCHANGES.map(([id,name])=>({id,name,loaded:!!exMap.get(id)&&!exMap.get(id)?.error&&!exMap.get(id)?.unsupported,error:exMap.get(id)?.error||null})));
 if(url.pathname==='/api/scan'){const mode=['spot-spot','spot-futures','futures-futures'].includes(url.searchParams.get('mode'))?url.searchParams.get('mode'):'spot-spot';return sendJSON(res,200,lastScan[mode]||{timestamp:0,opportunities:[]});}
 if(url.pathname==='/api/networks')return sendJSON(res,200,Object.fromEntries(networkCache));
 if(url.pathname==='/events'){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive','access-control-allow-origin':'*'});res.write(`data: ${JSON.stringify({type:'hello',timestamp:now()})}\\n\\n`);sse.add(res);req.on('close',()=>sse.delete(res));return;}
 let p=url.pathname==='/'?'/index.html':url.pathname;const file=path.join(ROOT,'public',path.normalize(p).replace(/^[/\\]+/,''));if(!file.startsWith(path.join(ROOT,'public')))return sendJSON(res,403,{error:'forbidden'});try{const ext=path.extname(file);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};res.writeHead(200,{'content-type':types[ext]||'application/octet-stream','cache-control':'no-cache'});res.end(fs.readFileSync(file));}catch{sendJSON(res,404,{error:'not found'});}}

const server=http.createServer(serve);server.listen(PORT,()=>{console.log(`Arbitrage Radar listening on http://localhost:${PORT}`);runLoop();});
