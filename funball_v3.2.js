/* FunBall v3.2 — Dual-View + Players • Safari-safe + Kaggle-compatible + 3D fixes + auto-zoom + 3D trail */
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'kaggle_play_2017090700_20170907000118.json');

const FPS_DEFAULT = 10;
const FIELD_LEN_YD = 100;
const FIELD_WID_YD = 53.333;
const PAD = { x: 70, y: 40 };

const TRAIL_MAX_XY = 40;     // top-down trail length
const TRAIL_MAX_3D = 60;     // follow-cam trail length

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
let tickMS = 1000 / FPS_DEFAULT;
let playing = false;
let k = 0, acc = 0, lastT = 0;
let unitScale = 1;

let axis = { length:'y', lateral:'x', forwardSign:+1 };

// camera: (x,y) in world yards, zoom scales the 3D projection
let camera = { x:0, y:FIELD_LEN_YD/2, z:6, zoom:1.0 };
let fieldCenter = { x:0, y:FIELD_LEN_YD/2 };

// trails
let trailXY = [];            // screen-space (for top-down)
let trail3D = [];            // world-space (for follow-cam)

// Offscreen buffers (Safari-safe)
let bufXY=null, bxy=null, buf3D=null, b3d=null;

// ---------- Helpers ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const map=(v,in0,in1,out0,out1)=>out0+(out1-out0)*((v-in0)/(in1-in0));

// safe get time delta between frames
function frameDt(i){
  if(i<=0) return 1/fps;
  const t0 = frames[i-1]?.t ?? ((i-1)/fps);
  const t1 = frames[i]?.t ?? (i/fps);
  const dt = Math.max(1e-6, t1 - t0);
  return dt;
}

function sizeCanvas(c){
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width;
  const cssH = c.clientHeight|| c.height;
  c.width = Math.round(cssW * dpr);
  c.height= Math.round(cssH * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

function resizeAll(){
  [cvXY, cv3D].forEach(sizeCanvas);

  // ✅ Safari-safe offscreen buffer creation
  if (typeof OffscreenCanvas === 'function') {
    bufXY = new OffscreenCanvas(cvXY.width, cvXY.height);
    buf3D = new OffscreenCanvas(cv3D.width, cv3D.height);
  } else {
    bufXY = document.createElement('canvas');
    buf3D = document.createElement('canvas');
    bufXY.width = cvXY.width; bufXY.height = cvXY.height;
    buf3D.width = cv3D.width; buf3D.height = cv3D.height;
  }

  bxy = bufXY.getContext('2d');
  b3d = buf3D.getContext('2d');

  drawStatic();
  drawFrame(k,true);
}

new ResizeObserver(resizeAll).observe(cvXY);
new ResizeObserver(resizeAll).observe(cv3D);

// ---------- Adapter ----------
function normalizeDataset(raw){
  let rawFrames = [];
  if (Array.isArray(raw?.plays) && raw.plays.length && Array.isArray(raw.plays[0].frames)) {
    // Kaggle-ish nested shape: { plays: [{ frames: [...] }] }
    rawFrames = raw.plays[0].frames;
  } else if (Array.isArray(raw?.frames)) {
    // GameView v1 direct: { frames: [...] }
    rawFrames = raw.frames;
  } else {
    throw new Error('No frames found (expected plays[0].frames or frames[])');
  }

  fps = Number(raw?.fps) || FPS_DEFAULT;
  tickMS = 1000 / fps;

  // units: yards (default) or meters -> convert to yards
  let units = 'yards';
  try {
    if (raw.field_cs && raw.field_cs.units) units = raw.field_cs.units;
    else if (raw.units) units = raw.units;
  } catch(e){ units = 'yards'; }
  unitScale = (String(units).toLowerCase().startsWith('m')) ? (1/0.9144) : 1;

  // auto axis inference by comparing spans
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

  // normalize frames -> yards, world coords:
  //   forward: 0..100 (y)
  //   lateral: -26.666..+26.666 centered (x)
  const nf = rawFrames.map((f,i)=>{
    const t = (typeof f.time_s==='number') ? f.time_s : i*(1/fps);
    const bx = toWorldLateral(f.ball?.[axis.lateral] ?? 0);
    const by = toWorldForward (f.ball?.[axis.length ] ?? 0);
    const bz = toYd(f.ball?.z||0);
    const players = Array.isArray(f.players) ? f.players.map(p=>({
      id: String(p.id ?? ''),
      team: String(p.team ?? ''),
      x: toWorldLateral(p?.[axis.lateral] ?? 0),
      y: toWorldForward (p?.[axis.length ] ?? 0),
      z: toYd(p?.z||0)
    })) : [];
    return { t, ball:{x:bx,y:by,z:bz}, players };
  });

  // center the follow-cam around the first ball position
  if(nf.length){
    fieldCenter.x = nf[0].ball.x;
    fieldCenter.y = nf[0].ball.y;
  }

  return nf;

  function toYd(v){ return (typeof v==='number'? v:0)*unitScale; }
  function toWorldForward(vRaw){ return clamp(toYd(vRaw), 0, FIELD_LEN_YD); }
  function toWorldLateral(vRaw){
    const v = toYd(vRaw);
    return clamp(v - FIELD_WID_YD/2, -FIELD_WID_YD/2, FIELD_WID_YD/2);
  }
}

// ---------- Mapping: Top-Down ----------
function mapXY_worldToCanvas(p){
  const w = cvXY.width - PAD.x*2;
  const h = cvXY.height- PAD.y*2;
  const xn = clamp((p.x + FIELD_WID_YD/2) / FIELD_WID_YD, 0, 1);
  const yn = clamp(1 - (p.y / FIELD_LEN_YD), 0, 1);
  return { x: PAD.x + xn*w, y: PAD.y + yn*h };
}

// ---------- 3D Projection (fixed + zoomable) ----------
let BASE_SCALE_D=8, BASE_SCALE_L=6, Z_PX=12, TILT=0.55;

function refresh3DConstants(){
  const H=cv3D.height, W=cv3D.width;
  // Base scales (pre-zoom) chosen to look good on 16:9 but adaptive
  BASE_SCALE_D = clamp(W/150, 5, 14);
  BASE_SCALE_L = clamp(H/100, 5, 12);
  Z_PX        = clamp(H/36 , 9, 18);
  TILT        = clamp(H/W, 0.45, 0.65);
}

// Uses camera.zoom to scale perspective. Higher zoom => closer.
function map3D_worldToCanvas(p){
  const dy = (p.y - camera.y);
  const dx = (p.x - camera.x);

  // Center horizon around mid canvas for stability
  const horizonX = cv3D.width * 0.50;
  const horizonY = cv3D.height * 0.60;

  const scaleD = BASE_SCALE_D * camera.zoom;
  const scaleL = BASE_SCALE_L * camera.zoom;

  const baseX = horizonX + dy * scaleD;
  const baseY = horizonY + dx * scaleL * TILT;
  return { x: baseX, y: baseY - p.z * Z_PX };
}

// ---------- Field Background ----------
function drawStatic(){
  // XY
  bxy.clearRect(0,0,bufXY.width,bufXY.height);
  bxy.fillStyle='#0b4a18'; bxy.fillRect(0,0,bufXY.width,bufXY.height);
  const w=cvXY.width-PAD.x*2, h=cvXY.height-PAD.y*2;
  // yard markers
  bxy.strokeStyle='rgba(255,255,255,.22)';
  bxy.beginPath();
  for(let i=0;i<=20;i++){ const x=PAD.x+(w/20)*i; bxy.moveTo(x,PAD.y); bxy.lineTo(x,PAD.y+h); }
  bxy.stroke();
  // boundary
  bxy.strokeStyle='rgba(255,255,255,.7)'; bxy.strokeRect(PAD.x,PAD.y,w,h);

  // 3D
  b3d.clearRect(0,0,buf3D.width,buf3D.height);
  // subtle vertical gradient
  const g = b3d.createLinearGradient(0,0,0,buf3D.height);
  g.addColorStop(0,'#0c3f16');
  g.addColorStop(1,'#0a3513');
  b3d.fillStyle=g; b3d.fillRect(0,0,buf3D.width,buf3D.height);
}

// ---------- Playback ----------
function step(n=1){
  if(!frames.length) return;
  k = Math.max(0, Math.min(frames.length-1, k+n));
  drawFrame(k);
}

function loop(t){
  if(!playing){ lastT=t; requestAnimationFrame(loop); return; }
  if(!lastT) lastT=t;
  let dt=t-lastT; lastT=t;
  acc+=dt;
  while(acc >= tickMS){ step(1); acc -= tickMS; }
  requestAnimationFrame(loop);
}

// ---------- Draw ----------
function drawFrame(i){
  if(!frames.length) return;
  const f = frames[i];

  // -------- Camera follow (smooth) --------
  // Follow slightly behind the ball forward-wise and centered laterally.
  const targetY = clamp(f.ball.y - 8, 0, FIELD_LEN_YD);
  const targetX = clamp(f.ball.x,       -FIELD_WID_YD/2, FIELD_WID_YD/2);
  camera.y = lerp(camera.y, targetY, 0.15);
  camera.x = lerp(camera.x, targetX, 0.15);

  // Auto-zoom based on ball speed (yards/sec)
  // Fast play => zoom out slightly; slow => zoom in slightly.
  let speedYdPerSec = 0;
  if(i>0){
    const prev = frames[i-1];
    const dt = frameDt(i);
    const d = Math.hypot(f.ball.x - prev.ball.x, f.ball.y - prev.ball.y);
    speedYdPerSec = d / dt;
  }
  const speedClamped = clamp(speedYdPerSec, 0, 14); // 0..~14 yd/s typical
  const targetZoom = map(speedClamped, 0, 14, 1.10, 0.82); // slow->zoom in, fast->zoom out
  camera.zoom = lerp(camera.zoom, targetZoom, 0.08);

  // -------- Top-Down (XY) --------
  cxXY.clearRect(0,0,cvXY.width,cvXY.height);
  cxXY.drawImage(bufXY,0,0);

  // Ball
  const mBallXY = mapXY_worldToCanvas(f.ball);
  cxXY.fillStyle = '#ffd97a';
  cxXY.beginPath(); cxXY.arc(mBallXY.x, mBallXY.y - f.ball.z*6, 3.5, 0, Math.PI*2); cxXY.fill();

  // Trail (2D)
  trailXY.push({x:mBallXY.x, y:mBallXY.y});
  if(trailXY.length>TRAIL_MAX_XY) trailXY.shift();
  cxXY.strokeStyle='rgba(255,255,255,.35)';
  cxXY.beginPath();
  for(let j=0;j<trailXY.length;j++){
    const p=trailXY[j];
    if(j===0) cxXY.moveTo(p.x,p.y); else cxXY.lineTo(p.x,p.y);
  }
  cxXY.stroke();

  // Players (nearest six)
  if(f.players?.length){
    const near = f.players.map(p=>({p,d:Math.hypot(p.x-f.ball.x,p.y-f.ball.y)}))
                          .sort((a,b)=>a.d-b.d).slice(0,6);
    near.forEach(({p})=>{
      const m=mapXY_worldToCanvas(p);
      cxXY.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
      cxXY.lineWidth=2;
      cxXY.beginPath(); cxXY.moveTo(m.x,m.y-7); cxXY.lineTo(m.x,m.y-18); cxXY.stroke();
      cxXY.beginPath(); cxXY.arc(m.x,m.y-22,3,0,Math.PI*2); cxXY.stroke();
    });
  }

  hudXY.textContent=`Frame ${i+1}/${frames.length} • Ball (y=${f.ball.y.toFixed(1)}, x=${f.ball.x.toFixed(1)})`;

  // -------- 3D Follow --------
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.width,cv3D.height);
  cx3D.drawImage(buf3D,0,0);

  // Draw players sorted by forward depth so farther things render first
  const plist=(f.players||[]).slice().sort((a,b)=>a.y-b.y);
  plist.forEach(p=>{
    const m=map3D_worldToCanvas(p);
    // soft shadow
    cx3D.fillStyle='rgba(0,0,0,.28)';
    cx3D.beginPath(); cx3D.ellipse(m.x,m.y+7,8,2.6,0,0,Math.PI*2); cx3D.fill();
    // stick figure
    cx3D.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
    cx3D.lineWidth=1.8;
    cx3D.beginPath(); cx3D.moveTo(m.x,m.y-10); cx3D.lineTo(m.x,m.y-24); cx3D.stroke();
    cx3D.beginPath(); cx3D.arc(m.x,m.y-28,3,0,Math.PI*2); cx3D.stroke();
  });

  // Ball
  const mb3=map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';
  cx3D.beginPath(); cx3D.arc(mb3.x,mb3.y,4,0,Math.PI*2); cx3D.fill();

  // 3D trail (fade)
  trail3D.push({ x:f.ball.x, y:f.ball.y, z:f.ball.z });
  if(trail3D.length>TRAIL_MAX_3D) trail3D.shift();
  for(let j=1;j<trail3D.length;j++){
    const a = trail3D[j-1], b = trail3D[j];
    const ma = map3D_worldToCanvas(a);
    const mb = map3D_worldToCanvas(b);
    const alpha = j / trail3D.length; // tail fades
    cx3D.strokeStyle = `rgba(255,255,255,${0.10*alpha})`;
    cx3D.lineWidth = 2;
    cx3D.beginPath(); cx3D.moveTo(ma.x,ma.y); cx3D.lineTo(mb.x,mb.y); cx3D.stroke();
  }

  // Debug guide (thin border so you can confirm it’s in frame)
  cx3D.strokeStyle = 'rgba(255,255,255,0.15)';
  cx3D.lineWidth = 1;
  cx3D.strokeRect(0, 0, cv3D.width, cv3D.height);

  hud3D.textContent=`Follow: Ball • Cam y≈${camera.y.toFixed(1)} x≈${camera.x.toFixed(1)} • zoom=${camera.zoom.toFixed(2)} • v≈${speedYdPerSec.toFixed(1)}yd/s`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY.textContent='⏳ Loading…';
  hud3D.textContent='⏳ Loading…';
  playing=false; k=0; trailXY.length=0; trail3D.length=0;

  // fetch relative to current page (works on GitHub Pages)
  fetch(url,{cache:'no-cache'})
  .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
  .then(raw=>{
    frames=normalizeDataset(raw);
    if(!frames.length) throw new Error('No frames after normalization');

    // set camera to first ball position
    camera.x=frames[0].ball.x;
    camera.y=Math.max(0,frames[0].ball.y-8);
    camera.zoom=1.0;

    resizeAll();
    hudXY.textContent=`✅ Loaded ${frames.length} frame(s) @ ${fps} fps — tap ▶`;
    hud3D.textContent='Follow: Ball';
    drawFrame(0);
  })
  .catch(err=>{
    console.error(err);
    hudXY.textContent=`❌ ${err.message}`;
    hud3D.textContent=`❌ ${err.message}`;
  });
}

// ---------- UI ----------
btnPlay && (btnPlay.onclick=()=>{ if(frames.length){ playing=true; requestAnimationFrame(loop);} });
btnPause&& (btnPause.onclick=()=>playing=false);
btnStep && (btnStep.onclick =()=>{ playing=false; step(1); });
if(dsSel) dsSel.value=DATA_URL;
reloadBtn && (reloadBtn.onclick=()=>{ DATA_URL=dsSel?.value||DEFAULT_DATA; loadJSON(DATA_URL); });

// Keyboard shortcuts: space=play/pause, right=step
window.addEventListener('keydown', (e)=>{
  if(e.code==='Space'){ e.preventDefault(); playing = !playing; if(playing) requestAnimationFrame(loop); }
  else if(e.code==='ArrowRight'){ e.preventDefault(); playing=false; step(1); }
});

// ---------- Init ----------
resizeAll();
loadJSON(DATA_URL);
})();
