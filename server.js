const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const UPBIT = 'https://api.upbit.com/v1';
const REFRESH_MS = 5000;
const CANDLE_REFRESH_MS = 15000;
const WATCH_COUNT = 20;
const START_CASH = 1_000_000;
const FEE_RATE = 0.0005; // configurable estimate: 0.05% per side
const MAX_POSITIONS_PER_STRATEGY = 3;
const ORDER_KRW = 100_000;

let state = {
  running: false,
  mode: 'paper',
  updatedAt: null,
  connection: '시작 대기',
  error: null,
  markets: [],
  coins: [],
  strategies: {
    A: { name: '상승 초기 포착', cash: START_CASH, positions: {}, trades: [], signals: [], realizedPnl: 0 },
    B: { name: '눌림목 진입', cash: START_CASH, positions: {}, trades: [], signals: [], realizedPnl: 0 }
  },
  logs: []
};
let tickerCache = [];
let candleCache = new Map();
let lastCandlesAt = 0;
let busy = false;
let timer = null;

function log(message, type='info') {
  state.logs.unshift({ time: new Date().toISOString(), message, type });
  state.logs = state.logs.slice(0, 100);
}
async function getJson(url, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'FlowWatch2/1.0' }, signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
      const err = new Error(`Upbit API ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw err;
      lastError = err;
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
    }
    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw lastError || new Error('Upbit API 요청 실패');
}
async function refreshMarketList() {
  const all = await getJson(`${UPBIT}/market/all?isDetails=false`);
  state.markets = all.filter(m => m.market.startsWith('KRW-') && !/^(KRW-USDT|KRW-DAI)$/.test(m.market));
}
async function refreshTickers() {
  if (!state.markets.length) await refreshMarketList();
  const codes = state.markets.map(m => m.market);
  const all = [];
  for (let i=0; i<codes.length; i+=100) {
    const part = await getJson(`${UPBIT}/ticker?markets=${codes.slice(i,i+100).join(',')}`);
    all.push(...part);
  }
  tickerCache = all.sort((a,b) => b.acc_trade_price_24h - a.acc_trade_price_24h).slice(0, WATCH_COUNT);
  const names = new Map(state.markets.map(m => [m.market, m.korean_name]));
  state.coins = tickerCache.map(t => ({
    market: t.market, name: names.get(t.market) || t.market,
    price: t.trade_price, changeRate: t.signed_change_rate * 100,
    tradeValue24h: t.acc_trade_price_24h, high: t.high_price, low: t.low_price,
    signedChange: t.change, candle1m: candleCache.get(t.market)?.m1 || [],
    candle5m: candleCache.get(t.market)?.m5 || []
  }));
}
async function refreshCandles() {
  const now = Date.now();
  if (now - lastCandlesAt < CANDLE_REFRESH_MS) return;
  // Upbit 캔들 API의 순간 요청량을 낮추기 위해 동시 요청을 2개로 제한한다.
  const targets = tickerCache.slice(0, 10);
  let nextIndex = 0, success = 0, failures = [];
  async function worker() {
    while (nextIndex < targets.length) {
      const t = targets[nextIndex++];
      try {
        const m1 = await getJson(`${UPBIT}/candles/minutes/1?market=${t.market}&count=30`);
        await new Promise(resolve => setTimeout(resolve, 180));
        const m5 = await getJson(`${UPBIT}/candles/minutes/5?market=${t.market}&count=30`);
        candleCache.set(t.market, { m1: m1.reverse(), m5: m5.reverse(), at: Date.now() });
        success++;
      } catch (err) {
        failures.push(`${t.market}: ${err.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
  }
  await Promise.all(Array.from({length: 2}, () => worker()));
  state.coins = state.coins.map(coin => ({
    ...coin,
    candle1m: candleCache.get(coin.market)?.m1 || [],
    candle5m: candleCache.get(coin.market)?.m5 || []
  }));
  if (failures.length) {
    log(`캔들 조회 실패 ${failures.length}/${targets.length}개 · ${failures.slice(0,2).join(' / ')}`, 'warn');
    state.candleStatus = `캔들 일부 조회 실패 (${success}/${targets.length})`;
  } else {
    state.candleStatus = `캔들 연결 정상 (${success}개)`;
  }
  // 완전 실패 시 다음 주기에 바로 재시도하고, 부분 성공이면 요청량 보호를 위해 일반 주기를 유지한다.
  lastCandlesAt = success ? Date.now() : 0;
}

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }
function calcSignal(coin, kind) {
  const m1 = coin.candle1m || [], m5 = coin.candle5m || [];
  if (m1.length < 12 || m5.length < 6) return { ok:false, reason:'캔들 데이터 부족' };
  const closes = m1.map(c => c.trade_price), vols = m1.map(c => c.candle_acc_trade_price);
  const last = closes[closes.length-1], prev = closes[closes.length-2];
  const shortAvg = avg(closes.slice(-3)), priorAvg = avg(closes.slice(-8,-3));
  const volNow = avg(vols.slice(-3)), volBase = avg(vols.slice(-10,-3)) || 1;
  const volRatio = volNow / volBase;
  const c5 = m5.map(c => c.trade_price);
  const trend5 = avg(c5.slice(-3)) >= avg(c5.slice(-6,-3));
  const change1m = prev ? (last-prev)/prev*100 : 0;
  const notOverextended = coin.changeRate < 12 && (last / Math.min(...closes.slice(-10)) - 1) < 0.045;
  if (kind === 'A') {
    const ok = shortAvg > priorAvg && last >= prev && volRatio >= 1.15 && trend5 && notOverextended;
    return { ok, reason: ok ? '단기 상승 전환·거래량 증가·5분 추세 확인' : '초기 상승 조건 미충족', volRatio, change1m };
  }
  const recentHigh = Math.max(...closes.slice(-8,-2));
  const pullback = last < recentHigh && last > recentHigh * 0.985;
  const rebound = last >= prev && shortAvg >= priorAvg * 0.997;
  const ok = trend5 && pullback && rebound && volRatio >= 0.7 && notOverextended;
  return { ok, reason: ok ? '상승 추세 중 조정 후 반등 확인' : '눌림목·반등 조건 미충족', volRatio, change1m };
}
function strategyCycle(key) {
  const strat = state.strategies[key];
  for (const coin of state.coins) {
    const pos = strat.positions[coin.market];
    if (pos) {
      const gross = (coin.price - pos.entryPrice) / pos.entryPrice;
      const net = gross - FEE_RATE*2;
      const peak = Math.max(pos.peakPrice || pos.entryPrice, coin.price);
      pos.peakPrice = peak;
      const drawdownFromPeak = (coin.price - peak) / peak;
      const m1 = coin.candle1m || [];
      const weakening = m1.length >= 4 && avg(m1.slice(-3).map(c=>c.trade_price)) < avg(m1.slice(-6,-3).map(c=>c.trade_price));
      let reason = null;
      if (net >= 0.012) reason = '목표 수익 도달(검증용 +1.2%)';
      else if (net <= -0.008) reason = '비상 손절(검증용 -0.8%)';
      else if (gross > 0.004 && drawdownFromPeak <= -0.006) reason = '고점 대비 수익 보호';
      else if (weakening && gross > 0.001) reason = '추세 약화';
      if (reason) {
        const proceeds = pos.units * coin.price;
        const feeBuy = pos.cost * FEE_RATE;
        const feeSell = proceeds * FEE_RATE;
        const pnl = proceeds - pos.cost - feeBuy - feeSell;
        strat.cash += proceeds - feeSell;
        strat.realizedPnl += pnl;
        strat.trades.unshift({ time:new Date().toISOString(), market:coin.market, name:coin.name, side:'매도', entryPrice:pos.entryPrice, price:coin.price, pnl, pnlPct:pnl/(pos.cost+feeBuy)*100, reason });
        strat.trades = strat.trades.slice(0,200);
        delete strat.positions[coin.market];
        log(`${strat.name}: ${coin.name} 매도 · ${pnl>=0?'+':''}${Math.round(pnl).toLocaleString()}원 · ${reason}`, pnl>=0?'success':'warn');
      }
      continue;
    }
    if (Object.keys(strat.positions).length >= MAX_POSITIONS_PER_STRATEGY) continue;
    const signal = calcSignal(coin, key);
    if (signal.ok && strat.cash >= ORDER_KRW * (1+FEE_RATE)) {
      const cost = ORDER_KRW, fee = cost*FEE_RATE;
      const units = cost / coin.price;
      strat.cash -= cost + fee;
      strat.positions[coin.market] = { market:coin.market, name:coin.name, entryPrice:coin.price, units, cost, peakPrice:coin.price, entryAt:new Date().toISOString(), reason:signal.reason };
      strat.signals.unshift({time:new Date().toISOString(), market:coin.market, name:coin.name, reason:signal.reason, volRatio:signal.volRatio});
      strat.signals = strat.signals.slice(0,100);
      strat.trades.unshift({time:new Date().toISOString(), market:coin.market, name:coin.name, side:'매수', entryPrice:coin.price, price:coin.price, amount:cost, pnl:null, reason:signal.reason});
      strat.trades = strat.trades.slice(0,200);
      log(`${strat.name}: ${coin.name} 모의 매수 · ${ORDER_KRW.toLocaleString()}원`, 'success');
    }
  }
}
function snapshot() {
  const strategies = {};
  for (const [key,s] of Object.entries(state.strategies)) {
    let unrealized = 0, marketValue = 0;
    for (const [market,p] of Object.entries(s.positions)) {
      const coin = state.coins.find(c=>c.market===market);
      if (!coin) continue;
      const value = p.units * coin.price;
      marketValue += value;
      unrealized += value - p.cost - p.cost*FEE_RATE - value*FEE_RATE;
    }
    strategies[key] = {...s, marketValue, unrealizedPnl:unrealized, equity:s.cash+marketValue, totalPnl:s.realizedPnl+unrealized};
  }
  return {...state, strategies, feeRate:FEE_RATE, orderKrw:ORDER_KRW, watchCount:WATCH_COUNT, candleStatus:state.candleStatus || '캔들 대기 중'};
}
async function cycle() {
  if (busy) return;
  busy = true;
  try {
    await refreshTickers();
    await refreshCandles();
    state.updatedAt = new Date().toISOString();
    state.connection = '연결 정상';
    state.error = null;
    if (state.running) { strategyCycle('A'); strategyCycle('B'); }
  } catch (e) {
    state.connection = '조회 실패';
    state.error = String(e.message || e);
    log(`실시간 조회 실패: ${state.error}`, 'error');
  } finally { busy = false; }
}
function json(res, code, data) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'}); return res.end(); }
  if (url.pathname === '/api/state') return json(res,200,snapshot());
  if (url.pathname === '/api/start' && req.method === 'POST') { state.running=true; log('두 전략 모의매매 시작'); return json(res,200,snapshot()); }
  if (url.pathname === '/api/stop' && req.method === 'POST') { state.running=false; log('모의매매 정지'); return json(res,200,snapshot()); }
  if (url.pathname === '/api/reset' && req.method === 'POST') {
    state.running=false;
    state.strategies = {
      A:{name:'상승 초기 포착',cash:START_CASH,positions:{},trades:[],signals:[],realizedPnl:0},
      B:{name:'눌림목 진입',cash:START_CASH,positions:{},trades:[],signals:[],realizedPnl:0}
    };
    log('모의매매 초기화'); return json(res,200,snapshot());
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') { await cycle(); return json(res,200,snapshot()); }
  if (url.pathname.startsWith('/api/')) return json(res,404,{error:'API not found'});
  let file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const full = path.join(ROOT,file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(full);
  const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
  res.writeHead(200, {'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-cache'});
  fs.createReadStream(full).pipe(res);
});
server.listen(PORT, () => {
  console.log(`FlowWatch 2.0: http://localhost:${PORT}`);
  cycle();
  timer = setInterval(cycle, REFRESH_MS);
});
process.on('SIGINT',()=>{clearInterval(timer);server.close(()=>process.exit(0));});
