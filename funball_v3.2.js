/* FunBall v3.2 — Dual-View (Top-Down + Follow 3D)
   Fixed DPR handling • Real panning/zooming top view • Working 3D follow cam
   Kaggle + GameView schema adapter • Safari / iOS safe
*/
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'drive_nfltelemetry_long.json');

const FPS_DEFAULT = 10;
const FIELD_LEN_YD = 100;
const FIELD_WID_YD = 53.333;       // ~160 ft
const HALF_WID = FIELD_WID_YD/2;

const TRAIL_MAX_XY = 48;
const TRAIL_MAX_3D = 64;

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
let cameraMode = 'follow'; // options: 'follow', 'stands50', 'stands20'

let axis = { length:'y', lateral:'x' };

// Cameras (world yards; top-down also has zoom)
const cam2d = { x:0, y:FIELD_LEN_YD/2, zoom:1.0 };
const cam3d = { x:0, y:FIELD_LEN_YD/2, zoom:1.0, rot:0.0 };

// Trails
let trailXY = [];
let trail3D = [];

// ---------- Helpers ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const map =(v,in0,in1,out0,out1)=>out0+(out1-out0)*((v-in0)/(in1-in0));

function applyCameraPreset(mode) {
  if (mode === 'stands50') {
    cam3d.x = 0;  cam3d.y = 50; cam3d.z = 18;
    cam3d.zoom = 1.0; cam3d.rot = 0;
  } else if (mode === 'stands20') {
    cam3d.x = 18; cam3d.y = 20; cam3d.z = 15;
    cam3d.zoom = 1.0; cam3d.rot = -0.52; // about 30 degrees
  } else { // follow (default)
    cam3d.z = 6;
  }
}
   
function frameDt(i){
  if(i<=0) return 1/fps;
  const t0 = frames[i-1]?.t ?? ((i-1)/fps);
  const t1 = frames[i]?.t ?? (i/fps);
  return Math.max(1e-6, t1 - t0);
}

function sizeCanvas(canvas){
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width  = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  // From now on, all drawing coordinates should be in *CSS* pixels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizeAll(){
  sizeCanvas(cvXY);
  sizeCanvas(cv3D);
  drawFrame(k, true);
}

new ResizeObserver(resizeAll).observe(cvXY);
new ResizeObserver(resizeAll).observe(cv3D);

// ---------- Adapter ----------
function normalizeDataset(raw){
  let rawFrames = [];
  if (Array.isArray(raw?.plays) && raw.plays.length && Array.isArray(raw.plays[0].frames)) {
    rawFrames = raw.plays[0].frames;        // Kaggle-like
  } else if (Array.isArray(raw?.frames)) {
    rawFrames = raw.frames;                 // GameView v1
  } else {
    throw new Error('No frames found (expected plays[0].frames or frames[])');
  }

  fps = Number(raw?.fps) || FPS_DEFAULT;
  tickMS = 1000 / fps;

  // Units
  let units = 'yards';
  try {
    if (raw.field_cs?.units) units = raw.field_cs.units;
    else if (raw.units) units = raw.units;
  } catch(e){/* ignore */ }
  unitScale = String(units).toLowerCase().startsWith('m') ? (1/0.9144) : 1;

  // Axis inference
  const samp = rawFrames.slice(0, Math.min(20, rawFrames.length));
  const mins = {x:+Infinity, y:+Infinity}, maxs={x:-Infinity, y:-Infinity};
  for(const f of samp){
    const pts = [];
    if (f.ball) pts.push(f.ball);
    if (Array.isArray(f.players)) pts.push(...f.players);
    for(const p of pts){
      if(typeof p.x==='number'){ mins.x=Math.min(mins.x,p.x); maxs.x=Math.max(maxs.x,p.x); }
      if(typeof p.y==='number'){ mins.y=Math.min(mins.y,p.y); maxs.y=Math.max(maxs.y,p.y); }
    }
  }
  axis = (maxs.x-mins.x > maxs.y-mins.y) ? {length:'x', lateral:'y'} : {length:'y', lateral:'x'};

  // Normalize to world coords (yards)
  const nf = rawFrames.map((f,i)=>{
    const t = (typeof f.time_s==='number') ? f.time_s : i*(1/fps);
    const bx = toWorldLateral(f.ball?.[axis.lateral] ?? 0);
    const by = toWorldForward (f.ball?.[axis.length ] ?? 0);
    const bz = toYd(f.ball?.z || 0);
    const players = Array.isArray(f.players) ? f.players.map(p=>({
      id:String(p.id??''), team:String(p.team??''),
      x: toWorldLateral(p?.[axis.lateral] ?? 0),
      y: toWorldForward (p?.[axis.length ] ?? 0),
      z: toYd(p?.z||0)
    })) : [];
    return { t, ball:{x:bx,y:by,z:bz}, players };
  });

  if(nf.length){
    cam2d.x = nf[0].ball.x; cam2d.y = nf[0].ball.y;
    cam3d.x = nf[0].ball.x; cam3d.y = nf[0].ball.y;
  }
  return nf;

  function toYd(v){ return (typeof v==='number'? v:0)*unitScale; }
  function toWorldForward(v){ return clamp(toYd(v), 0, FIELD_LEN_YD); }
  function toWorldLateral(v){ const yd = toYd(v); return clamp(yd - HALF_WID, -HALF_WID, HALF_WID); }
}

// ---------- Top-Down camera mapping ----------
function worldToXY(pt){
  // we draw in CSS pixels (thanks to ctx.setTransform)
  const W = cvXY.clientWidth  || cvXY.width;
  const H = cvXY.clientHeight || cvXY.height;

  // scale to fit full field at zoom=1, then apply zoom
  const baseScale = Math.min(W/FIELD_WID_YD, H/FIELD_LEN_YD);
  const s = baseScale * cam2d.zoom;

  const dx = (pt.x - cam2d.x) * s;
  const dy = (pt.y - cam2d.y) * s;

  return { x: W/2 + dx, y: H/2 - dy };
}

function drawFieldXY(){
  const W = cvXY.clientWidth  || cvXY.width;
  const H = cvXY.clientHeight || cvXY.height;

  // background
  cxXY.fillStyle = '#0b4a18';
  cxXY.fillRect(0,0,W,H);

  // yard lines in world y every 10 yards, centered by camera
  cxXY.strokeStyle = 'rgba(255,255,255,.28)';
  cxXY.lineWidth = 1.2;

  // Horizontal (every 10y)
  for(let y=0; y<=FIELD_LEN_YD; y+=10){
    const a = worldToXY({x:-HALF_WID, y});
    const b = worldToXY({x:+HALF_WID, y});
    cxXY.beginPath(); cxXY.moveTo(a.x, a.y); cxXY.lineTo(b.x, b.y); cxXY.stroke();
  }

  // Sidelines (lateral -/+ HALF_WID)
  cxXY.strokeStyle = 'rgba(255,255,255,.6)';
  const s0a = worldToXY({x:-HALF_WID, y:0});
  const s0b = worldToXY({x:-HALF_WID, y:FIELD_LEN_YD});
  const s1a = worldToXY({x:+HALF_WID, y:0});
  const s1b = worldToXY({x:+HALF_WID, y:FIELD_LEN_YD});
  cxXY.beginPath(); cxXY.moveTo(s0a.x,s0a.y); cxXY.lineTo(s0b.x,s0b.y); cxXY.stroke();
  cxXY.beginPath(); cxXY.moveTo(s1a.x,s1a.y); cxXY.lineTo(s1b.x,s1b.y); cxXY.stroke();
}

// ---------- 3D Projection ----------
let BASE_D=2.0, BASE_L=1.6, Z_PX=22, TILT=0.6;
function refresh3DConstants(){
  const H = cv3D.clientHeight || cv3D.height;
  const W = cv3D.clientWidth  || cv3D.width;
  BASE_D = clamp(W/40, 1.6, 3.2);
  BASE_L = clamp(H/52, 1.3, 2.6);
  Z_PX   = clamp(H/18, 12, 28);
  TILT   = clamp(H/W, 0.50, 0.70);
}

function map3D_worldToCanvas(p){
  const W = cv3D.clientWidth  || cv3D.width;
  const H = cv3D.clientHeight || cv3D.height;

  const horizonX = W*0.52;
  const horizonY = H*0.60;

  const cosR = Math.cos(cam3d.rot), sinR = Math.sin(cam3d.rot);
  const relX = p.x - cam3d.x, relY = p.y - cam3d.y;

  // rotate camera about vertical axis
  const rx =  relX*cosR - relY*sinR;  // lateral
  const ry =  relX*sinR + relY*cosR;  // forward

  const x = horizonX + ry * (BASE_D * cam3d.zoom);
  const y = horizonY + rx * (BASE_L * cam3d.zoom) * TILT - p.z*Z_PX;
  return { x, y };
}

function drawField3D(){
  const W = cv3D.clientWidth  || cv3D.width;
  const H = cv3D.clientHeight || cv3D.height;
  // gradient background
  const g = cx3D.createLinearGradient(0,0,0,H);
  g.addColorStop(0,'#0c3f16'); g.addColorStop(1,'#0a3513');
  cx3D.fillStyle = g;
  cx3D.fillRect(0,0,W,H);
}

// ---------- Playback ----------
function step(n=1){ if(!frames.length) return; k = Math.max(0, Math.min(frames.length-1, k+n)); drawFrame(k); }
function loop(t){
  if(!playing){ lastT=t; requestAnimationFrame(loop); return; }
  if(!lastT) lastT=t;
  let dt=t-lastT; lastT=t;
  acc += dt;
  while(acc >= tickMS){ step(1); acc -= tickMS; }
  requestAnimationFrame(loop);
}

// ---------- Draw ----------
function drawFrame(i){
  if(!frames.length) return;
  const f = frames[i];
  const dt = frameDt(i);
  const v  = (i>0) ? Math.hypot(f.ball.x-frames[i-1].ball.x, f.ball.y-frames[i-1].ball.y)/dt : 0;

  // --- Camera updates ---
  // Top-down follows tightly; zoom out a bit when speed rises
  cam2d.x = lerp(cam2d.x, f.ball.x, 0.25);
  cam2d.y = lerp(cam2d.y, f.ball.y, 0.25);
  cam2d.zoom = lerp(cam2d.zoom, map(clamp(v,0,14), 0,14, 1.15,0.85), 0.12);

  // 3D follows a tad behind, light auto-rotate by lateral
  cam3d.y   = lerp(cam3d.y, clamp(f.ball.y - 8, 0, FIELD_LEN_YD), 0.18);
  cam3d.x   = lerp(cam3d.x, clamp(f.ball.x, -HALF_WID, HALF_WID), 0.18);
  cam3d.zoom= lerp(cam3d.zoom, map(clamp(v,0,16), 0,16, 1.05,0.86), 0.10);
  cam3d.rot = lerp(cam3d.rot, clamp(f.ball.x/26, -0.28, 0.28), 0.12);

  // --- Top-down draw (full world every frame) ---
  cxXY.clearRect(0,0,cvXY.clientWidth||cvXY.width, cvXY.clientHeight||cvXY.height);
  drawFieldXY();

  // Ball
  const mBall = worldToXY(f.ball);
  cxXY.fillStyle = '#ffd97a';
  cxXY.beginPath(); cxXY.arc(mBall.x, mBall.y - f.ball.z*2, 4, 0, Math.PI*2); cxXY.fill();

  // Trail
  trailXY.push({x:mBall.x, y:mBall.y});
  if(trailXY.length>TRAIL_MAX_XY) trailXY.shift();
  cxXY.strokeStyle='rgba(255,255,255,.35)';
  cxXY.lineWidth=2;
  cxXY.beginPath();
  for(let j=0;j<trailXY.length;j++){ const p=trailXY[j]; if(j===0) cxXY.moveTo(p.x,p.y); else cxXY.lineTo(p.x,p.y); }
  cxXY.stroke();

  // Players (nearest 6)
  if(f.players?.length){
    const near = f.players.map(p=>({p,d:Math.hypot(p.x-f.ball.x,p.y-f.ball.y)}))
                          .sort((a,b)=>a.d-b.d).slice(0,6);
    for(const {p} of near){
      const m = worldToXY(p);
      cxXY.strokeStyle = (p.team==='home') ? '#a9d5ff' : '#ffc2c2';
      cxXY.lineWidth = 3;
      cxXY.beginPath(); cxXY.moveTo(m.x, m.y-8); cxXY.lineTo(m.x, m.y-22); cxXY.stroke();
      cxXY.beginPath(); cxXY.arc(m.x, m.y-26, 4, 0, Math.PI*2); cxXY.stroke();
    }
  }

  hudXY.textContent = `Frame ${i+1}/${frames.length} • Ball y=${f.ball.y.toFixed(1)} x=${f.ball.x.toFixed(1)} • Zoom=${cam2d.zoom.toFixed(2)} • v≈${v.toFixed(1)}yd/s`;

  // --- 3D draw ---
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.clientWidth||cv3D.width, cv3D.clientHeight||cv3D.height);
  drawField3D();
  if (cameraMode !== 'follow') applyCameraPreset(cameraMode);

  // Players (sort by forward depth so back renders first)
  const plist = (f.players||[]).slice().sort((a,b)=>a.y-b.y);
  for(const p of plist){
    const mp = map3D_worldToCanvas(p);
    // shadow
    cx3D.fillStyle='rgba(0,0,0,.28)';
    cx3D.beginPath(); cx3D.ellipse(mp.x, mp.y+7, 8, 2.6, 0, 0, Math.PI*2); cx3D.fill();
    // stick figure
    cx3D.strokeStyle=(p.team==='home')?'#a9d5ff':'#ffc2c2';
    cx3D.lineWidth=2;
    cx3D.beginPath(); cx3D.moveTo(mp.x, mp.y-10); cx3D.lineTo(mp.x, mp.y-24); cx3D.stroke();
    cx3D.beginPath(); cx3D.arc(mp.x, mp.y-28, 3.5, 0, Math.PI*2); cx3D.stroke();
  }

  // Ball
  const mb3 = map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';
  cx3D.beginPath(); cx3D.arc(mb3.x, mb3.y, 5, 0, Math.PI*2); cx3D.fill();

  // 3D trail
  trail3D.push({x:f.ball.x,y:f.ball.y,z:f.ball.z});
  if(trail3D.length>TRAIL_MAX_3D) trail3D.shift();
  for(let j=1;j<trail3D.length;j++){
    const a=trail3D[j-1], b=trail3D[j];
    const ma=map3D_worldToCanvas(a), mb=map3D_worldToCanvas(b);
    const alpha=j/trail3D.length;
    cx3D.strokeStyle=`rgba(255,255,255,${0.10*alpha})`;
    cx3D.lineWidth=2;
    cx3D.beginPath(); cx3D.moveTo(ma.x, ma.y); cx3D.lineTo(mb.x, mb.y); cx3D.stroke();
  }

  hud3D.textContent = `Follow: Ball • Cam y≈${cam3d.y.toFixed(1)} x≈${cam3d.x.toFixed(1)} • zoom=${cam3d.zoom.toFixed(2)} rot=${cam3d.rot.toFixed(2)} • v≈${v.toFixed(1)}yd/s`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY.textContent='⏳ Loading…'; hud3D.textContent='⏳ Loading…';
  playing=false; k=0; trailXY.length=0; trail3D.length=0;

  fetch(url,{cache:'no-cache'})
    .then(r=>{ if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(raw=>{
      frames = normalizeDataset(raw);
      if(!frames.length) throw new Error('No frames after normalization');
      resizeAll();
      hudXY.textContent=`✅ Loaded ${frames.length} frames @ ${fps}fps — tap ▶`;
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
btnPlay  && (btnPlay.onclick = ()=>{ if(frames.length){ playing=true; requestAnimationFrame(loop); }});
btnPause && (btnPause.onclick= ()=> playing=false);
btnStep  && (btnStep.onclick = ()=>{ playing=false; step(1); });
if(dsSel) dsSel.value = DATA_URL;
reloadBtn && (reloadBtn.onclick=()=>{ DATA_URL=dsSel?.value||DEFAULT_DATA; loadJSON(DATA_URL); });
const camSel = document.createElement('select');
camSel.innerHTML = `
  <option value="follow">Follow Cam</option>
  <option value="stands50">50-Yard Stands</option>
  <option value="stands20">20-Yard Stands</option>`;
camSel.onchange = e => { cameraMode = e.target.value; drawFrame(k); };
document.querySelector('.controls').appendChild(camSel);
// keyboard
window.addEventListener('keydown', (e)=>{
  if(e.code==='Space'){ e.preventDefault(); playing = !playing; if(playing) requestAnimationFrame(loop); }
  else if(e.code==='ArrowRight'){ e.preventDefault(); playing=false; step(1); }
});

// ---------- Init ----------
resizeAll();
loadJSON(DATA_URL);
})();
