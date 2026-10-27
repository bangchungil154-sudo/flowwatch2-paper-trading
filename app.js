const $ = id => document.getElementById(id);
const won = n => '₩' + Math.round(Number(n)||0).toLocaleString('ko-KR');
const pct = n => `${Number(n)>=0?'+':''}${Number(n||0).toFixed(2)}%`;
const time = s => { if(!s) return '—'; const d=new Date(s); return d.toLocaleTimeString('ko-KR',{hour12:false}); };
async function api(path, method='GET') {
  const r = await fetch(path,{method,headers:{'Content-Type':'application/json'}});
  if(!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return r.json();
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function signalFor(coin,key){
  const m1=coin.candle1m||[],m5=coin.candle5m||[];
  if(m1.length<12||m5.length<6)return {ok:false,reason:'캔들 부족'};
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
  const closes=m1.map(c=>c.trade_price),vols=m1.map(c=>c.candle_acc_trade_price),last=closes.at(-1),prev=closes.at(-2);
  const short=avg(closes.slice(-3)),prior=avg(closes.slice(-8,-3)),vr=avg(vols.slice(-3))/(avg(vols.slice(-10,-3))||1);
  const c5=m5.map(c=>c.trade_price),trend=avg(c5.slice(-3))>=avg(c5.slice(-6,-3));
  const safe=coin.changeRate<12&&(last/Math.min(...closes.slice(-10))-1)<.045;
  if(key==='A'){const ok=short>prior&&last>=prev&&vr>=1.15&&trend&&safe;return {ok,reason:ok?'초기 상승 신호':'대기'};}
  const high=Math.max(...closes.slice(-8,-2)),pull=last<high&&last>high*.985,rebound=last>=prev&&short>=prior*.997;
  const ok=trend&&pull&&rebound&&vr>=.7&&safe;return {ok,reason:ok?'눌림목 반등 신호':'대기'};
}
function renderStrategy(key,s){
  $(`cash${key}`).textContent=won(s.cash);
  $(`value${key}`).textContent=won(s.marketValue);
  $(`real${key}`).textContent=won(s.realizedPnl);
  const positions=Object.values(s.positions||{});
  $(`positions${key}`).className='positions'+(positions.length?'':' empty');
  $(`positions${key}`).innerHTML=positions.length?positions.map(p=>{
    const c=window.currentCoins.find(x=>x.market===p.market);const price=c?.price||p.entryPrice;
    const pnl=(price-p.entryPrice)/p.entryPrice*100;
    return `<div class="item"><div><b>${esc(p.name)}</b><span class="sub">${esc(p.market)} · 진입 ${won(p.entryPrice)}</span></div><div class="right"><b class="${pnl>=0?'positive':'negative'}">${pct(pnl)}</b><span class="sub">현재 ${won(price)}</span></div></div>`;
  }).join(''):'보유 코인 없음';
  const trades=(s.trades||[]).slice(0,8);
  $(`trades${key}`).className='trades'+(trades.length?'':' empty');
  $(`trades${key}`).innerHTML=trades.length?trades.map(t=>`<div class="item"><div><b>${esc(t.side)} · ${esc(t.name)}</b><span class="sub">${time(t.time)} · ${esc(t.reason||'')}</span></div><div class="right">${t.pnl==null?`<b>${won(t.amount||0)}</b>`:`<b class="${t.pnl>=0?'positive':'negative'}">${t.pnl>=0?'+':''}${won(t.pnl)}</b><span class="sub">${pct(t.pnlPct)}</span>`}</div></div>`).join(''):'거래 기록 없음';
}
function render(s){
  window.currentCoins=s.coins||[];
  $('connection').textContent=s.connection||'상태 확인 중';
  $('dot').className=s.connection==='연결 정상'?'good':s.connection==='조회 실패'?'bad':'';
  $('updated').textContent=s.updatedAt?`갱신 ${time(s.updatedAt)}`:'데이터 대기 중';
  $('coinCount').textContent=(s.coins||[]).length;
  $('runState').textContent=s.running?'실행 중':'정지';
  $('dataWarning').textContent=s.error?`오류: ${s.error}`:'';
  for(const k of ['A','B']){
    const x=s.strategies[k];$('equity'+k).textContent=won(x.equity);$('pnl'+k).textContent=`총 손익 ${x.totalPnl>=0?'+':''}${won(x.totalPnl)}`;$('pnl'+k).className=x.totalPnl>=0?'positive':'negative';renderStrategy(k,x);
  }
  $('coins').innerHTML=(s.coins||[]).map(c=>{
    const a=signalFor(c,'A'),b=signalFor(c,'B');
    return `<tr><td><span class="coin-name">${esc(c.name)}</span><span class="coin-market">${esc(c.market)}</span></td><td>${won(c.price)}</td><td class="${c.changeRate>=0?'positive':'negative'}">${pct(c.changeRate)}</td><td>${won(c.tradeValue24h)}</td><td><span class="signal ${a.ok?'yes':''}">${a.ok?'매수 후보':esc(a.reason)}</span></td><td><span class="signal ${b.ok?'yes':''}">${b.ok?'매수 후보':esc(b.reason)}</span></td></tr>`;
  }).join('')||'<tr><td colspan="6">데이터 없음</td></tr>';
  $('logs').innerHTML=(s.logs||[]).slice(0,30).map(l=>`<div class="item"><span class="time">${time(l.time)}</span><span>${esc(l.message)}</span><b class="${l.type==='error'||l.type==='warn'?'negative':l.type==='success'?'positive':''}">${l.type==='error'?'오류':l.type==='warn'?'주의':l.type==='success'?'완료':''}</b></div>`).join('')||'<div class="empty">기록 대기 중</div>';
}
async function poll(){try{render(await api('/api/state'));}catch(e){$('connection').textContent='서버 연결 실패';$('dot').className='bad';$('dataWarning').textContent='server.js가 실행 중인지 확인하세요.';}}
$('start').onclick=async()=>{try{render(await api('/api/start','POST'));}catch(e){alert(e.message)}};
$('stop').onclick=async()=>{try{render(await api('/api/stop','POST'));}catch(e){alert(e.message)}};
$('reset').onclick=async()=>{if(confirm('모의매매 기록과 잔고를 초기화할까요?'))try{render(await api('/api/reset','POST'));}catch(e){alert(e.message)}};
$('refresh').onclick=async()=>{ $('refresh').disabled=true;try{render(await api('/api/refresh','POST'));}catch(e){alert(e.message)}finally{$('refresh').disabled=false;}};
poll();setInterval(poll,2500);