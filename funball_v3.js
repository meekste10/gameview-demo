/* FunBall v3.1 — Split-screen ball + few players, Kaggle-compatible, smooth follow cam */
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'kaggle_play_2017090700_20170907000118.json');

const FPS_DEFAULT = 10;
const TICK_MS_DEFAULT = 100;
const FIELD_LEN_YD = 100;
const FIELD_WID_YD = 53.333;
const PAD = { x: 70, y: 40 };

// ---------- DOM ----------
const cvXY = document.getElementById('topDown');
const cxXY = cvXY.getContext('2d');
const hudXY = document.getElementById('hudXY');

const cv3D = document.getElementById('follow3D');
const cx3D = cv3D.getContext('2d');
const hud3D = document.getElementById('hud3D');

const btnPlay  = document.getElementById('play');
const btnPause = document.getElementById('pause');
const btnStep  = document.getElementById('step');
const dsSel    = document.getElementById('datasetSel');
const reloadBtn= document.getElementById('reload');

// ---------- State ----------
let DATA_URL = DEFAULT_DATA;
let frames = [];
let fps = FPS_DEFAULT;
let tickMS = TICK_MS_DEFAULT;
let playing = false;
let k = 0;
let acc = 0, lastT = 0;

let unitScale = 1;
let axis = { length:'y', lateral:'x', forwardSign:+1 };
let camera = { x:0, y:50, z:6 };
let trail = [];
const TRAIL_MAX = 40;

// Offscreen buffers
let bufXY=null, bxy=null, buf3D=null, b3d=null;

// ---------- Utils ----------
function sizeCanvas(c){
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width;
  const cssH = c.clientHeight|| c.height;
  c.width = Math.round(cssW * dpr);
  c.height= Math.round(cssH * dpr);
  c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}
function resizeAll(){
  [cvXY, cv3D].forEach(sizeCanvas);
  bufXY = new OffscreenCanvas ? new OffscreenCanvas(cvXY.width, cvXY.height) : document.createElement('canvas');
  if(!(bufXY instanceof OffscreenCanvas)) { bufXY.width=cvXY.width; bufXY.height=cvXY.height; }
  bxy = bufXY.getContext('2d');

  buf3D = new OffscreenCanvas ? new OffscreenCanvas(cv3D.width, cv3D.height) : document.createElement('canvas');
  if(!(buf3D instanceof OffscreenCanvas)) { buf3D.width=cv3D.width; buf3D.height=cv3D.height; }
  b3d = buf3D.getContext('2d');

  drawStatic();
  drawFrame(k,true);
}
new ResizeObserver(resizeAll).observe(cvXY);
new ResizeObserver(resizeAll).observe(cv3D);

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;

// ---------- Adapter ----------
function normalizeDataset(raw){
  let rawFrames = [];
  if (Array.isArray(raw?.plays) && raw.plays.length && Array.isArray(raw.plays[0].frames)) {
    rawFrames = raw.plays[0].frames;
  } else if (Array.isArray(raw?.frames)) {
    rawFrames = raw.frames;
  } else {
    throw new Error('No frames found (expected plays[0].frames or frames)');
  }

  // ✅ Safe FPS + units handling
  fps = Number(raw?.fps) || FPS_DEFAULT;
  tickMS = 1000 / fps;

  let units = 'yards';
  try {
    if (raw.field_cs && raw.field_cs.units) units = raw.field_cs.units;
    else if (raw.units) units = raw.units;
  } catch(e){ units = 'yards'; }
  unitScale = units.toLowerCase().startsWith('m') ? (1/0.9144) : 1;

  // Axis auto-detect
  const samp = rawFrames.slice(0, Math.min(20, rawFrames.length));
  const mins = {x:+Infinity,y:+Infinity}, maxs={x:-Infinity,y:-Infinity};
  for(const f of samp){
    const pts = [];
    if (f.ball) pts.push(f.ball);
    if (Array.isArray(f.players)) pts.push(...f.players);
    for(const p of pts){
      if(typeof p.x==='number'){ mins.x=Math.min(mins.x,p.x); maxs.x=Math.max(maxs.x,p.x); }
      if(typeof p.y==='number'){ mins.y=Math.min(mins.y,p.y); maxs.y=Math.max(maxs.y,p.y); }
    }
  }
  const rangeX = maxs.x-mins.x, rangeY = maxs.y-mins.y;
  if (rangeX > rangeY){ axis.length='x'; axis.lateral='y'; }
  else { axis.length='y'; axis.lateral='x'; }

  const nf = rawFrames.map((f,i)=>{
    const t = typeof f.time_s==='number' ? f.time_s : i*(1/fps);
    const bx = toWorldLateral(f.ball?.[axis.lateral] ?? 0);
    const by = toWorldForward (f.ball?.[axis.length ] ?? 0);
    const bz = toYd(f.ball?.z||0);

    const players = Array.isArray(f.players) ? f.players.map(p=>({
      id: String(p.id ?? ''),
      team: String(p.team ?? ''),
      x: toWorldLateral(p[axis.lateral] ?? 0),
      y: toWorldForward (p[axis.length ] ?? 0),
      z: toYd(p.z||0)
    })) : [];

    return { t, ball:{x:bx,y:by,z:bz}, players };
  });

  return nf;

  function toYd(v){ return (typeof v==='number'? v:0)*unitScale; }
  function toWorldForward(vRaw){ return clamp(toYd(vRaw), 0, FIELD_LEN_YD); }
  function toWorldLateral(vRaw){
    const v = toYd(vRaw);
    return clamp(v - FIELD_WID_YD/2, -FIELD_WID_YD/2, FIELD_WID_YD/2);
  }
}

// ---------- Mapping ----------
function mapXY_worldToCanvas(p){
  const w = cvXY.width - PAD.x*2;
  const h = cvXY.height- PAD.y*2;
  const xn = clamp((p.x + FIELD_WID_YD/2) / FIELD_WID_YD, 0, 1);
  const yn = clamp(1 - (p.y / FIELD_LEN_YD), 0, 1);
  return { x: PAD.x + xn*w, y: PAD.y + yn*h };
}

let SCALE_D=8, SCALE_L=6, Z_PX=12, TILT=0.55;
function refresh3DConstants(){
  const H=cv3D.height, W=cv3D.width;
  SCALE_D = Math.max(6, Math.min(10, W/120));
  SCALE_L = Math.max(5, Math.min( 9, H/120));
  Z_PX    = Math.max(9, Math.min(16, H/40));
  TILT    = clamp(H/W, .48, .62);
}
function map3D_worldToCanvas(p){
  const dy = (p.y - camera.y);
  const dx = (p.x - camera.x);
  const horizonX = cv3D.width * 0.18;
  const baseX = horizonX + dy*SCALE_D;
  const baseY = cv3D.height*0.74 + (dx*SCALE_L)*TILT;
  return { x: baseX, y: baseY - p.z*Z_PX };
}

// ---------- Static Field ----------
function drawStatic(){
  bxy.clearRect(0,0,bufXY.width,bufXY.height);
  bxy.fillStyle='#0b4a18'; bxy.fillRect(0,0,bufXY.width,bufXY.height);
  const w=cvXY.width-PAD.x*2, h=cvXY.height-PAD.y*2;
  bxy.strokeStyle='rgba(255,255,255,.22)';
  bxy.beginPath();
  for(let i=0;i<=20;i++){ const x=PAD.x+(w/20)*i; bxy.moveTo(x,PAD.y); bxy.lineTo(x,PAD.y+h); }
  bxy.stroke();
  bxy.strokeStyle='rgba(255,255,255,.7)'; bxy.strokeRect(PAD.x,PAD.y,w,h);

  b3d.clearRect(0,0,buf3D.width,buf3D.height);
  b3d.fillStyle='#0c3f16'; b3d.fillRect(0,0,buf3D.width,buf3D.height);
}

// ---------- Playback ----------
function step(n=1){
  if(!frames.length) return;
  k = Math.max(0, Math.min(frames.length-1, k+n));
  drawFrame(k, true);
}
function loop(t){
  if(!playing){ lastT=t; requestAnimationFrame(loop); return; }
  if(!lastT) lastT=t;
  let dt=t-lastT; lastT=t;
  acc+=dt;
  while(acc >= tickMS){
    step(1);
    acc -= tickMS;
  }
  requestAnimationFrame(loop);
}

// ---------- Draw ----------
function drawFrame(i){
  if(!frames.length) return;
  const f = frames[i];
  camera.y = lerp(camera.y, clamp(f.ball.y-8, 0, FIELD_LEN_YD), 0.15);
  camera.x = lerp(camera.x, clamp(f.ball.x, -FIELD_WID_YD/2, FIELD_WID_YD/2), 0.15);

  // XY
  cxXY.clearRect(0,0,cvXY.width,cvXY.height);
  cxXY.drawImage(bufXY,0,0);
  const mBallXY = mapXY_worldToCanvas(f.ball);
  cxXY.fillStyle = '#ffd97a';
  cxXY.beginPath(); cxXY.arc(mBallXY.x, mBallXY.y - f.ball.z*6, 3.5, 0, Math.PI*2); cxXY.fill();

  trail.push({x:mBallXY.x, y:mBallXY.y});
  if(trail.length>TRAIL_MAX) trail.shift();
  cxXY.strokeStyle='rgba(255,255,255,.35)';
  cxXY.beginPath();
  for(let j=0;j<trail.length;j++){
    const p=trail[j];
    if(j===0) cxXY.moveTo(p.x,p.y); else cxXY.lineTo(p.x,p.y);
  }
  cxXY.stroke();

  if(f.players?.length){
    const withDist = f.players.map(p=>({p, d: Math.hypot(p.x-f.ball.x, p.y-f.ball.y)}))
                              .sort((a,b)=>a.d-b.d).slice(0,6);
    withDist.forEach(({p})=>{
      const m=mapXY_worldToCanvas(p);
      cxXY.strokeStyle = (p.team==='home')?'#cfe9fb':'#ffd0d0';
      cxXY.lineWidth=2;
      cxXY.beginPath(); cxXY.moveTo(m.x, m.y-7); cxXY.lineTo(m.x, m.y-18); cxXY.stroke();
      cxXY.beginPath(); cxXY.arc(m.x, m.y-22, 3, 0, Math.PI*2); cxXY.stroke();
    });
  }

  hudXY.textContent = `Frame ${i+1}/${frames.length} • Ball (y=${f.ball.y.toFixed(1)} x=${f.ball.x.toFixed(1)})`;

  // 3D
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.width,cv3D.height);
  cx3D.drawImage(buf3D,0,0);
  const plist = (f.players||[]).slice().sort((a,b)=>a.y-b.y);
  plist.forEach(p=>{
    const m=map3D_worldToCanvas(p);
    cx3D.fillStyle='rgba(0,0,0,.28)';
    cx3D.beginPath(); cx3D.ellipse(m.x, m.y+7, 8, 2.6, 0, 0, Math.PI*2); cx3D.fill();
    cx3D.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
    cx3D.lineWidth=1.8;
    cx3D.beginPath(); cx3D.moveTo(m.x, m.y-10); cx3D.lineTo(m.x, m.y-24); cx3D.stroke();
    cx3D.beginPath(); cx3D.arc(m.x, m.y-28, 3, 0, Math.PI*2); cx3D.stroke();
  });
  const mb3 = map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';
  cx3D.beginPath(); cx3D.arc(mb3.x, mb3.y, 4, 0, Math.PI*2); cx3D.fill();
  hud3D.textContent = `Follow: Ball • Cam y≈${camera.y.toFixed(1)} x≈${camera.x.toFixed(1)}`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY.textContent='⏳ Loading…';
  hud3D.textContent='⏳ Loading…';
  playing=false; k=0; trail.length=0;

  fetch(url, {cache:'no-cache'})
    .then(r=>{
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(raw=>{
      frames = normalizeDataset(raw);
      if(!frames.length) throw new Error('No frames after normalization');
      camera.x = frames[0].ball.x;
      camera.y = Math.max(0, frames[0].ball.y - 8);
      resizeAll();
      hudXY.textContent = `✅ Loaded ${frames.length} frame(s) @ ${fps} fps — tap ▶`;
      hud3D.textContent = 'Follow: Ball';
      drawFrame(0,true);
    })
    .catch(err=>{
      hudXY.textContent = `❌ ${err.message}`;
      hud3D.textContent = `❌ ${err.message}`;
      console.error(err);
    });
}

// ---------- UI ----------
btnPlay && (btnPlay.onclick = ()=>{ if(frames.length){ playing=true; requestAnimationFrame(loop);} });
btnPause&& (btnPause.onclick= ()=> playing=false);
btnStep && (btnStep.onclick = ()=>{ playing=false; step(1); });
if(dsSel) dsSel.value = DATA_URL;
reloadBtn && (reloadBtn.onclick = ()=>{
  DATA_URL = dsSel?.value || DEFAULT_DATA;
  loadJSON(DATA_URL);
});

// ---------- Start ----------
resizeAll();
loadJSON(DATA_URL);
})();
