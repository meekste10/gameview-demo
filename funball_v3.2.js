/* FunBall v3.2 — Dual-View + Players
   • Safari-safe buffers
   • Kaggle + GV schema adapter
   • Top-down: pans with ball + bounded auto-zoom
   • Follow Cam (3D): stable projection + visible trail
*/
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'kaggle_play_2017090700_20170907000118.json');

const FPS_DEFAULT = 10;
const FIELD_LEN_YD = 100;       // forward (goal to goal)
const FIELD_WID_YD = 53.333;    // lateral (sideline to sideline)
const PAD = { x: 10, y: 10 };   // small, since we now pan/zoom

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

let axis = { length:'y', lateral:'x' };

// 2D camera (top-down) in world yards
const cam2d = {
  x: 0, y: FIELD_LEN_YD/2,    // world center (lateral, forward)
  zoom: 1                      // yards → screen px scale factor helper (computed each frame)
};
// desired window size (yards) we try to show around ball; clamped to field
const VIEW_W_MIN = 36;   // ~2/3 field width visible at most zoom-in
const VIEW_W_MAX = FIELD_WID_YD; // never zoom out past entire width
const VIEW_L_MIN = 44;   // forward window at max zoom-in
const VIEW_L_MAX = FIELD_LEN_YD;

// 3D camera (follow)
const cam3d = { x:0, y:50, zoom:1.0 };

// trails
const TRAIL_MAX_XY = 48;
const TRAIL_MAX_3D = 64;
let trailXY = [];
let trail3D = [];

// Offscreen buffers (Safari-safe)
let bufXY=null, bxy=null, buf3D=null, b3d=null;

// ---------- Helpers ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const map=(v,in0,in1,out0,out1)=>out0+(out1-out0)*((v-in0)/(in1-in0));

// Time delta per frame (uses time_s if present)
function frameDt(i){
  if(i<=0) return 1/fps;
  const t0 = frames[i-1]?.t ?? ((i-1)/fps);
  const t1 = frames[i]?.t ?? (i/fps);
  return Math.max(1e-6, t1 - t0);
}

function sizeCanvas(c){
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width;
  const cssH = c.clientHeight|| c.height;
  c.width  = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
}

function resizeAll(){
  [cvXY, cv3D].forEach(sizeCanvas);

  // Safari-safe offscreen buffers
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
    rawFrames = raw.plays[0].frames;
  } else if (Array.isArray(raw?.frames)) {
    rawFrames = raw.frames;
  } else {
    throw new Error('No frames found (expected plays[0].frames or frames[])');
  }

  fps = Number(raw?.fps) || FPS_DEFAULT;
  tickMS = 1000 / fps;

  // units: yards default; meters -> yards
  let units = 'yards';
  try {
    if (raw.field_cs && raw.field_cs.units) units = raw.field_cs.units;
    else if (raw.units) units = raw.units;
  } catch(e){ units = 'yards'; }
  unitScale = String(units).toLowerCase().startsWith('m') ? (1/0.9144) : 1;

  // infer major axis from span
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
  axis = (maxs.x-mins.x > maxs.y-mins.y) ? {length:'x',lateral:'y'} : {length:'y',lateral:'x'};

  // normalize → yards, world coords:
  //   forward (y): 0..100, lateral (x): -W/2..+W/2
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

  // init cameras to first ball
  if(nf.length){
    cam2d.x = nf[0].ball.x;
    cam2d.y = nf[0].ball.y;
    cam3d.x = nf[0].ball.x;
    cam3d.y = Math.max(0, nf[0].ball.y - 8);
  }
  return nf;

  function toYd(v){ return (typeof v==='number'? v:0)*unitScale; }
  function toWorldForward(v){ return clamp(toYd(v), 0, FIELD_LEN_YD); }
  function toWorldLateral(v){
    const yd = toYd(v);
    return clamp(yd - FIELD_WID_YD/2, -FIELD_WID_YD/2, FIELD_WID_YD/2);
  }
}

// ---------- Top-down camera mapping ----------
function worldToXY(p){
  // compute dynamic viewport in yards (width/height in world space)
  const t = frames[k];
  const prev = frames[k-1] || t;

  // ball speed in yd/s (for zooming)
  const dt = frameDt(k);
  const spd = Math.hypot(t.ball.x - prev.ball.x, t.ball.y - prev.ball.y) / dt;

  // target window sizes based on speed (faster → slightly wider/longer)
  const wYd = clamp(map(spd, 0, 12, VIEW_W_MIN, VIEW_W_MAX), VIEW_W_MIN, VIEW_W_MAX);
  const lYd = clamp(map(spd, 0, 12, VIEW_L_MIN, VIEW_L_MAX), VIEW_L_MIN, VIEW_L_MAX);

  // desired camera center (follow ball), then clamp so viewport stays within field bounds
  const halfW = wYd/2, halfL = lYd/2;
  const minX = -FIELD_WID_YD/2 + halfW, maxX =  FIELD_WID_YD/2 - halfW;
  const minY = 0 + halfL,              maxY =  FIELD_LEN_YD - halfL;

  const targetX = clamp(t.ball.x, minX, maxX);
  const targetY = clamp(t.ball.y, minY, maxY);

  // smooth follow
  cam2d.x = lerp(cam2d.x, targetX, 0.2);
  cam2d.y = lerp(cam2d.y, targetY, 0.2);

  // compute pixels-per-yard for current viewport so it fits inside canvas minus padding
  const wPix = (cvXY.width / (window.devicePixelRatio||1)) - PAD.x*2;
  const hPix = (cvXY.height/ (window.devicePixelRatio||1)) - PAD.y*2;
  const sx = wPix / wYd;
  const sy = hPix / lYd;
  cam2d.zoom = Math.min(sx, sy);

  // return a mapper closure
  return function(pt){
    // screen (CSS px) with origin top-left
    const x = PAD.x + ( (pt.x - (cam2d.x - halfW)) * cam2d.zoom );
    const y = PAD.y + ( ( (cam2d.y + halfL) - pt.y ) * cam2d.zoom ); // invert forward to screen
    return { x, y };
  };
}

// ---------- 3D Projection ----------
let BASE_D=10, BASE_L=8, Z_PX=14, TILT=0.56;
function refresh3DConstants(){
  const H=cv3D.height/(window.devicePixelRatio||1), W=cv3D.width/(window.devicePixelRatio||1);
  BASE_D = clamp(W/120, 6, 14);
  BASE_L = clamp(H/100, 6, 12);
  Z_PX   = clamp(H/34 , 9, 18);
  TILT   = clamp(H/W , 0.48, 0.64);
}

function map3D_worldToCanvas(p){
  // horizon near middle so things stay on-screen on mobile
  const horizonX = (cv3D.width/(window.devicePixelRatio||1)) * 0.48;
  const horizonY = (cv3D.height/(window.devicePixelRatio||1)) * 0.64;

  const scaleD = BASE_D * cam3d.zoom;
  const scaleL = BASE_L * cam3d.zoom;

  const dy = (p.y - cam3d.y);
  const dx = (p.x - cam3d.x);

  const x = horizonX + dy*scaleD;
  const y = horizonY + dx*scaleL*TILT - p.z*Z_PX;
  return { x, y };
}

// ---------- Field Background ----------
function drawStatic(){
  // XY background (big pitch)
  bxy.clearRect(0,0,bufXY.width,bufXY.height);
  const ctx = bxy;
  const cssW = cvXY.width/(window.devicePixelRatio||1);
  const cssH = cvXY.height/(window.devicePixelRatio||1);

  ctx.save();
  ctx.scale(window.devicePixelRatio||1, window.devicePixelRatio||1);

  ctx.fillStyle='#0b4a18'; ctx.fillRect(0,0,cssW,cssH);

  // yard lines drawn in screen space; they will pan/zoom because we render field in world-to-screen later
  ctx.restore();

  // 3D background
  b3d.clearRect(0,0,buf3D.width,buf3D.height);
  const c3 = b3d;
  const cssW3 = cv3D.width/(window.devicePixelRatio||1);
  const cssH3 = cv3D.height/(window.devicePixelRatio||1);
  c3.save();
  c3.scale(window.devicePixelRatio||1, window.devicePixelRatio||1);
  const g = c3.createLinearGradient(0,0,0,cssH3);
  g.addColorStop(0,'#0c3f16'); g.addColorStop(1,'#0a3513');
  c3.fillStyle=g; c3.fillRect(0,0,cssW3,cssH3);
  c3.restore();
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

  // --- Top-down ---
  cxXY.clearRect(0,0,cvXY.width,cvXY.height);
  cxXY.drawImage(bufXY,0,0);

  // build world→screen mapper for this frame (pans/zooms & clamps to field)
  const mapXY = worldToXY(f.ball);

  // draw field rectangle & yard lines in world space
  const cssScale = (window.devicePixelRatio||1);
  cxXY.save(); cxXY.scale(cssScale, cssScale);

  // border of visible area (debug subtle)
  cxXY.strokeStyle='rgba(255,255,255,.08)';
  cxXY.lineWidth=1; cxXY.strokeRect(0,0,cvXY.width/cssScale,cvXY.height/cssScale);

  // main field outline in world coords (to screen)
  const corners = [
    {x:-FIELD_WID_YD/2, y:0}, {x: FIELD_WID_YD/2, y:0},
    {x: FIELD_WID_YD/2, y:FIELD_LEN_YD}, {x:-FIELD_WID_YD/2, y:FIELD_LEN_YD}
  ].map(mapXY);
  cxXY.strokeStyle='rgba(255,255,255,.6)';
  cxXY.lineWidth=1.5;
  cxXY.beginPath();
  cxXY.moveTo(corners[0].x, corners[0].y);
  for(let j=1;j<corners.length;j++) cxXY.lineTo(corners[j].x, corners[j].y);
  cxXY.closePath(); cxXY.stroke();

  // yard lines (every 10 yards)
  cxXY.strokeStyle='rgba(255,255,255,.25)';
  cxXY.lineWidth=1;
  for(let y=10; y<100; y+=10){
    const a = mapXY({x:-FIELD_WID_YD/2, y});
    const b = mapXY({x: FIELD_WID_YD/2, y});
    cxXY.beginPath(); cxXY.moveTo(a.x,a.y); cxXY.lineTo(b.x,b.y); cxXY.stroke();
  }
  // hash-ish verticals (4 across)
  for(let iV=1;iV<=3;iV++){
    const x = -FIELD_WID_YD/2 + (FIELD_WID_YD/4)*iV;
    const a = mapXY({x, y:0});
    const b = mapXY({x, y:FIELD_LEN_YD});
    cxXY.beginPath(); cxXY.moveTo(a.x,a.y); cxXY.lineTo(b.x,b.y); cxXY.stroke();
  }

  // ball
  const mBall = mapXY(f.ball);
  cxXY.fillStyle='#ffd97a';
  cxXY.beginPath(); cxXY.arc(mBall.x, mBall.y - f.ball.z*cam2d.zoom*0.12, 3.5, 0, Math.PI*2); cxXY.fill();

  // trail
  trailXY.push({x:mBall.x, y:mBall.y});
  if(trailXY.length>TRAIL_MAX_XY) trailXY.shift();
  cxXY.strokeStyle='rgba(255,255,255,.35)';
  cxXY.lineWidth=1.5;
  cxXY.beginPath();
  for(let j=0;j<trailXY.length;j++){
    const p=trailXY[j];
    if(j===0) cxXY.moveTo(p.x,p.y); else cxXY.lineTo(p.x,p.y);
  }
  cxXY.stroke();

  // nearest players (6)
  if(f.players?.length){
    const near = f.players.map(p=>({p,d:Math.hypot(p.x-f.ball.x,p.y-f.ball.y)}))
                          .sort((a,b)=>a.d-b.d).slice(0,6);
    for(const {p} of near){
      const m = mapXY(p);
      cxXY.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
      cxXY.lineWidth=2;
      cxXY.beginPath(); cxXY.moveTo(m.x,m.y-7); cxXY.lineTo(m.x,m.y-18); cxXY.stroke();
      cxXY.beginPath(); cxXY.arc(m.x,m.y-22,3,0,Math.PI*2); cxXY.stroke();
    }
  }
  cxXY.restore();

  // HUD XY
  const dt = frameDt(i);
  const v = (i>0) ? Math.hypot(f.ball.x-frames[i-1].ball.x, f.ball.y-frames[i-1].ball.y)/dt : 0;
  hudXY.textContent = `Frame ${i+1}/${frames.length} • Ball y=${f.ball.y.toFixed(1)} x=${f.ball.x.toFixed(1)} • Zoom=${cam2d.zoom.toFixed(2)} • v≈${v.toFixed(1)}yd/s`;

  // --- Follow Cam 3D ---
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.width,cv3D.height);
  cx3D.drawImage(buf3D,0,0);

  // smooth follow (slightly behind ball forward)
  cam3d.y = lerp(cam3d.y, clamp(f.ball.y-8, 0, FIELD_LEN_YD), 0.15);
  cam3d.x = lerp(cam3d.x, clamp(f.ball.x, -FIELD_WID_YD/2, FIELD_WID_YD/2), 0.15);

  // auto-zoom: faster => zoom out a bit
  const spd = v; // already computed
  const targetZoom = map(clamp(spd,0,14), 0, 14, 1.05, 0.85);
  cam3d.zoom = lerp(cam3d.zoom, targetZoom, 0.08);

  // draw players back-to-front
  const plist=(f.players||[]).slice().sort((a,b)=>a.y-b.y);
  const cssScale3 = (window.devicePixelRatio||1);
  cx3D.save(); cx3D.scale(cssScale3, cssScale3);

  plist.forEach(p=>{
    const m=map3D_worldToCanvas(p);
    // drop shadow
    cx3D.fillStyle='rgba(0,0,0,.28)';
    cx3D.beginPath(); cx3D.ellipse(m.x,m.y+7,8,2.6,0,0,Math.PI*2); cx3D.fill();
    // stick
    cx3D.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
    cx3D.lineWidth=1.8;
    cx3D.beginPath(); cx3D.moveTo(m.x,m.y-10); cx3D.lineTo(m.x,m.y-24); cx3D.stroke();
    cx3D.beginPath(); cx3D.arc(m.x,m.y-28,3,0,Math.PI*2); cx3D.stroke();
  });

  // ball
  const mb=map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';
  cx3D.beginPath(); cx3D.arc(mb.x,mb.y,4,0,Math.PI*2); cx3D.fill();

  // 3D trail
  trail3D.push({ x:f.ball.x, y:f.ball.y, z:f.ball.z });
  if(trail3D.length>TRAIL_MAX_3D) trail3D.shift();
  for(let j=1;j<trail3D.length;j++){
    const a = trail3D[j-1], b = trail3D[j];
    const ma = map3D_worldToCanvas(a);
    const mbp= map3D_worldToCanvas(b);
    const alpha = j / trail3D.length;
    cx3D.strokeStyle = `rgba(255,255,255,${0.10*alpha})`;
    cx3D.lineWidth = 2;
    cx3D.beginPath(); cx3D.moveTo(ma.x,ma.y); cx3D.lineTo(mbp.x,mbp.y); cx3D.stroke();
  }

  // subtle frame border
  cx3D.strokeStyle='rgba(255,255,255,.12)'; cx3D.lineWidth=1;
  cx3D.strokeRect(0,0,cv3D.width/cssScale3,cv3D.height/cssScale3);
  cx3D.restore();

  hud3D.textContent=`Follow: Ball • Cam y≈${cam3d.y.toFixed(1)} x≈${cam3d.x.toFixed(1)} • zoom=${cam3d.zoom.toFixed(2)} • v≈${spd.toFixed(1)}yd/s`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY.textContent='⏳ Loading…';
  hud3D.textContent='⏳ Loading…';
  playing=false; k=0; trailXY.length=0; trail3D.length=0;

  fetch(url,{cache:'no-cache'})
    .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(raw=>{
      frames=normalizeDataset(raw);
      if(!frames.length) throw new Error('No frames after normalization');
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

// keyboard shortcuts
window.addEventListener('keydown', (e)=>{
  if(e.code==='Space'){ e.preventDefault(); playing = !playing; if(playing) requestAnimationFrame(loop); }
  else if(e.code==='ArrowRight'){ e.preventDefault(); playing=false; step(1); }
});

// ---------- Init ----------
resizeAll();
loadJSON(DATA_URL);
})();
