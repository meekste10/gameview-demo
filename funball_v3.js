/* FunBall v3 — Split-screen ball + few players, Kaggle adapter, smooth follow cam */
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'kaggle_play_2017090700_20170907000118.json');

const FPS_DEFAULT = 10;
const TICK_MS_DEFAULT = 100;
const FIELD_LEN_YD = 100;         // goal-to-goal
const FIELD_WID_YD = 53.333;      // sideline-to-sideline
const PAD = { x: 70, y: 40 };     // canvas padding

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
let frames = [];             // normalized frames
let fps = FPS_DEFAULT;
let tickMS = TICK_MS_DEFAULT;
let playing = false;
let k = 0;                   // frame index
let acc = 0, lastT = 0;

let unitScale = 1;           // meters->yards if needed
let axis = {                 // adapter decides these
  length: 'y',               // raw axis name used for forward (0..100)
  lateral:'x',               // raw axis for width (centered later)
  forwardSign: +1,           // +1 means increasing is toward opponent GL
};
let camera = { x:0, y:50, z:6 };
let lastBall = null;

let trail = [];              // ball trail (canvas coords for quick draw)
const TRAIL_MAX = 40;

// offscreen buffers to reduce overdraw
let bufXY=null, bxy=null, buf3D=null, b3d=null;

// ---------- Utilities ----------
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
  // match buffers
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

// clamp
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// simple lerp
const lerp=(a,b,t)=>a+(b-a)*t;

// ---------- Adapter: raw JSON -> normalized world frames ----------
// world frame shape we render:
// { t:seconds, ball:{x:yd_lateral_centered, y:yd_forward(0..100), z:yd }, players:[{id,team,x,y,z}] }
function normalizeDataset(raw){
  // accept either plays[0].frames or frames at root
  let rawFrames = [];
  if (Array.isArray(raw?.plays) && raw.plays.length && Array.isArray(raw.plays[0].frames)) {
    rawFrames = raw.plays[0].frames;
  } else if (Array.isArray(raw?.frames)) {
    rawFrames = raw.frames;
  } else {
    throw new Error('No frames found (expected plays[0].frames or frames)');
  }

  // fps
  fps = Number(raw?.fps)||FPS_DEFAULT;
  tickMS = 1000/ fps;

  // units
  const units = (raw?.field_cs?.units || 'yards').toLowerCase();
  unitScale = units.startsWith('m') ? (1/0.9144) : 1;

  // Axis auto-detect: decide which raw axis is field length (~100) vs width (~53)
  // Sample ranges
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
  // choose longer axis as "length"
  if (rangeX > rangeY){ axis.length='x'; axis.lateral='y'; }
  else { axis.length='y'; axis.lateral='x'; }

  // forwardSign: try to make offense go upward (increasing forward -> up on screen)
  axis.forwardSign = +1; // default; will map upward anyway

  // Build normalized frames
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

  // helpers scoped to adapter
  function toYd(v){ return (typeof v==='number'? v:0)*unitScale; }
  function toWorldForward(vRaw){
    const v = toYd(vRaw);
    // forward axis should be in 0..100 range; clamp just in case
    return clamp(v, 0, FIELD_LEN_YD);
  }
  function toWorldLateral(vRaw){
    const v = toYd(vRaw);
    // center width -> [-W/2, +W/2]
    return clamp(v - FIELD_WID_YD/2, -FIELD_WID_YD/2, FIELD_WID_YD/2);
  }
}

// ---------- Mapping: world -> canvases ----------
function mapXY_worldToCanvas(p){ // world: x in [-W/2..W/2], y in [0..100]
  const w = cvXY.width - PAD.x*2;
  const h = cvXY.height- PAD.y*2;
  const xn = clamp((p.x + FIELD_WID_YD/2) / FIELD_WID_YD, 0, 1);
  const yn = clamp(1 - (p.y / FIELD_LEN_YD), 0, 1);
  return { x: PAD.x + xn*w, y: PAD.y + yn*h };
}

let SCALE_D=8, SCALE_L=6, Z_PX=12, TILT=0.55;
function refresh3DConstants(){
  const H=cv3D.height, W=cv3D.width;
  SCALE_D = Math.max(6, Math.min(10, W/120)); // forward depth scale
  SCALE_L = Math.max(5, Math.min( 9, H/120)); // lateral scale
  Z_PX    = Math.max(9, Math.min(16, H/40));  // vertical exaggeration
  TILT    = clamp(H/W, .48, .62);
}
function map3D_worldToCanvas(p){
  // camera follows along forward axis (y) and lateral axis (x)
  const dy = (p.y - camera.y);
  const dx = (p.x - camera.x);
  const horizonX = cv3D.width * 0.18;
  const baseX = horizonX + dy*SCALE_D;
  const baseY = cv3D.height*0.74 + (dx*SCALE_L)*TILT;
  return { x: baseX, y: baseY - p.z*Z_PX };
}

// ---------- Static field paint (offscreen) ----------
function drawStatic(){
  // XY grid + border
  bxy.clearRect(0,0,bufXY.width,bufXY.height);
  bxy.fillStyle='#0b4a18'; bxy.fillRect(0,0,bufXY.width,bufXY.height);
  const w=cvXY.width-PAD.x*2, h=cvXY.height-PAD.y*2;
  bxy.strokeStyle='rgba(255,255,255,.22)'; bxy.beginPath();
  for(let i=0;i<=20;i++){ const x=PAD.x+(w/20)*i; bxy.moveTo(x,PAD.y); bxy.lineTo(x,PAD.y+h); }
  bxy.stroke();
  bxy.strokeStyle='rgba(255,255,255,.7)'; bxy.strokeRect(PAD.x,PAD.y,w,h);

  // 3D grass
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

// ---------- Drawing one frame ----------
function drawFrame(i, refreshStatics=false){
  if(!frames.length) return;

  const f = frames[i];
  // camera follow ball (smooth)
  camera.y = lerp(camera.y, clamp(f.ball.y-8, 0, FIELD_LEN_YD), 0.15);
  camera.x = lerp(camera.x, clamp(f.ball.x, -FIELD_WID_YD/2, FIELD_WID_YD/2), 0.15);

  // -------- XY --------
  cxXY.clearRect(0,0,cvXY.width,cvXY.height);
  cxXY.drawImage(bufXY,0,0);

  // ball
  const mBallXY = mapXY_worldToCanvas(f.ball);
  cxXY.fillStyle = '#ffd97a';
  cxXY.beginPath(); cxXY.arc(mBallXY.x, mBallXY.y - f.ball.z*6, 3.5, 0, Math.PI*2); cxXY.fill();

  // trail
  trail.push({x:mBallXY.x, y:mBallXY.y});
  if(trail.length>TRAIL_MAX) trail.shift();
  cxXY.strokeStyle='rgba(255,255,255,.35)';
  cxXY.beginPath();
  for(let j=0;j<trail.length;j++){
    const p=trail[j];
    if(j===0) cxXY.moveTo(p.x,p.y); else cxXY.lineTo(p.x,p.y);
  }
  cxXY.stroke();

  // a few nearest players (max 6)
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

  // HUD
  if(hudXY) hudXY.textContent = `Frame ${i+1}/${frames.length} • Ball (y=${f.ball.y.toFixed(1)} yd, x=${f.ball.x.toFixed(1)} yd)`;


  // -------- 3D --------
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.width,cv3D.height);
  cx3D.drawImage(buf3D,0,0);

  // players (depth-sort by forward y)
  const plist = (f.players||[]).slice();
  plist.sort((a,b)=>a.y-b.y);
  plist.forEach(p=>{
    const m=map3D_worldToCanvas(p);
    // shadow
    cx3D.fillStyle='rgba(0,0,0,.28)';
    cx3D.beginPath(); cx3D.ellipse(m.x, m.y+7, 8, 2.6, 0, 0, Math.PI*2); cx3D.fill();
    // stick
    cx3D.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
    cx3D.lineWidth=1.8;
    cx3D.beginPath(); cx3D.moveTo(m.x, m.y-10); cx3D.lineTo(m.x, m.y-24); cx3D.stroke();
    cx3D.beginPath(); cx3D.arc(m.x, m.y-28, 3, 0, Math.PI*2); cx3D.stroke();
  });

  // ball 3D
  const mb3 = map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';
  cx3D.beginPath(); cx3D.arc(mb3.x, mb3.y, 4, 0, Math.PI*2); cx3D.fill();

  if(hud3D) hud3D.textContent = `Follow: Ball • Cam y≈${camera.y.toFixed(1)} x≈${camera.x.toFixed(1)}`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY && (hudXY.textContent='Loading…');
  hud3D && (hud3D.textContent='Loading…');
  playing=false; k=0; trail.length=0;

  fetch(url, {cache:'no-cache'})
    .then(r=>{
      if(!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(raw=>{
      frames = normalizeDataset(raw);
      if(!frames.length) throw new Error('No frames after normalization');
      // reset camera near first ball
      camera.x = frames[0].ball.x;
      camera.y = Math.max(0, frames[0].ball.y - 8);
      resizeAll();
      hudXY && (hudXY.textContent = `Loaded ${frames.length} frame(s) @ ${fps} fps — tap ▶`);
      hud3D && (hud3D.textContent = 'Follow: Ball');
      drawFrame(0,true);
    })
    .catch(err=>{
      hudXY && (hudXY.textContent = `Load error: ${err.message}`);
      hud3D && (hud3D.textContent = `Load error: ${err.message}`);
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

// ---------- Kick ----------
resizeAll();
loadJSON(DATA_URL);
})();
