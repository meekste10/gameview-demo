/* gameview.js — Dual-View rAF (XY + Z follow, mini-map, LOS/1D) — audit-patched */
(()=>{
// ---------- Config / Units ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data') || 'drive_realistic_shotgun.json';
const FPS = 10;                                    // telemetry frame rate
const TICK_MS = 1000 / FPS;
const FIELD_WIDTH_YD  = 53.333;                    // sideline-to-sideline (yd)
const FIELD_LENGTH_YD = 100;                       // goal line to goal line (yd)
const PAD = { x: 80, y: 40 };

// Unit scaling (⚠️ #14). If dataset says meters, we scale to yards.
let unitScale = 1; // world->yards; default=1(yd). If meters: 1/0.9144.

function toYd(v){ return v * unitScale; }

// ---------- DOM ----------
const cvsXY  = document.getElementById('fieldXY');
const ctxXY  = cvsXY?.getContext('2d');
const hudXY  = document.getElementById('hudXY');

const cvs3D  = document.getElementById('field3D');
const ctx3D  = cvs3D?.getContext('2d');
const hud3D  = document.getElementById('hud3D');

const mini   = document.getElementById('mini');
const mctx   = mini?.getContext('2d');

const btnPlay   = document.getElementById('play');
const btnPause  = document.getElementById('pause');
const btnStep   = document.getElementById('step');

const showSpeedEl  = document.getElementById('showSpeed');
const showPosEl    = document.getElementById('showPos');
const showTrailsEl = document.getElementById('showTrails');
const autoCamEl    = document.getElementById('autoCam');
const losOnEl      = document.getElementById('losOn');
const fxOnEl       = document.getElementById('effectsOn');
const focusSel     = document.getElementById('focusPlayer');

const losYEl = document.getElementById('losY');
const togoEl = document.getElementById('togo');
const applyDDEl = document.getElementById('applyDD');

const dsSel    = document.getElementById('datasetSel');
const reloadBtn= document.getElementById('reload');

// ---------- State ----------
let DATA_URL = DEFAULT_DATA;
let plays = [], playIdx = 0, frame = 0;
let playing = false;

let showSpeed = true, showPos = true, showTrails = true, autoCam = true, losOn = true, effectsOn = true;
let reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; // (#11)

let focusTarget = null;
let trailsXY = new Map(), trails3D = new Map();

let lastHolder = null, catchFlash = 0, tackleFlash = 0;

let losY_auto = null, togoY = 10;
let cam = { y: 50, x: 0, z: 6 };

// rAF timing (⚠️ #1)
let lastT = 0, acc = 0; // ms

// DPR/Resize hardening (⚠️ #2 #3 #6)
let dprCached = window.devicePixelRatio || 1;
const ro = new ResizeObserver(()=> sizeAndRedraw());
if (cvsXY) ro.observe(cvsXY);
if (cvs3D) ro.observe(cvs3D);
if (mini)  ro.observe(mini);

// Offscreen static buffers to kill overdraw (⚠️ #10)
let bufXY = null, bctxXY = null;
let buf3D = null, bctx3D = null;

// ---------- UI Events ----------
showSpeedEl && (showSpeedEl.onchange = ()=> showSpeed = showSpeedEl.checked);
showPosEl   && (showPosEl.onchange   = ()=> showPos   = showPosEl.checked);
showTrailsEl&& (showTrailsEl.onchange= ()=> showTrails= showTrailsEl.checked);
autoCamEl   && (autoCamEl.onchange   = ()=> autoCam   = autoCamEl.checked);
losOnEl     && (losOnEl.onchange     = ()=> losOn     = losOnEl.checked);
fxOnEl      && (fxOnEl.onchange      = ()=> effectsOn = fxOnEl.checked);

focusSel && (focusSel.onchange = ()=> { focusTarget = focusSel.value || null; });

applyDDEl && (applyDDEl.onclick = ()=>{
  const vLos = parseFloat(losYEl?.value);
  const vTgo = parseFloat(togoEl?.value);
  if(!Number.isNaN(vLos)) losY_auto = vLos;
  if(!Number.isNaN(vTgo)) togoY = vTgo;
});

if (dsSel) dsSel.value = DATA_URL;
reloadBtn && (reloadBtn.onclick = ()=> { DATA_URL = dsSel?.value || DEFAULT_DATA; initLoad(true); });

// click-to-focus (XY/3D/Mini) (⚠️ #6 DPR-corrected)
[cvsXY, cvs3D, mini].filter(Boolean).forEach(cv=>{
  cv.addEventListener('click', ev=>{
    const id = hitTest(ev, cv);
    focusTarget = id || null;
    if (focusSel) focusSel.value = id || "";
    drawPlay(playIdx);
  });
});

// keyboard scrub
window.addEventListener('keydown', e=>{
  if(e.key==='k'||e.key==='K'){ playing=false; }
  if(e.key==='j'||e.key==='J'){ stepFrames(-FPS); }
  if(e.key==='l'||e.key==='L'){ stepFrames(e.shiftKey?FPS*5:FPS); }
});

// listen for DPR changes (best-effort) (⚠️ #3)
window.addEventListener('resize', ()=>{
  const dprNow = window.devicePixelRatio || 1;
  if (Math.abs(dprNow - dprCached) > 0.01) {
    dprCached = dprNow;
    sizeAndRedraw();
  }
});

// ---------- Sizing / Buffers ----------
function sizeCanvas(c){
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || c.width || 960;
  const cssH = c.clientHeight|| c.height|| 540;
  c.width = Math.round(cssW * dpr);
  c.height= Math.round(cssH * dpr);
  c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}

function sizeAndRedraw(){
  if (!cvsXY || !cvs3D || !mini) return;

  [cvsXY, cvs3D, mini].forEach(sizeCanvas);

  // buffers match canvases
  bufXY  = new OffscreenCanvas ? new OffscreenCanvas(cvsXY.width, cvsXY.height) : document.createElement('canvas');
  buf3D  = new OffscreenCanvas ? new OffscreenCanvas(cvs3D.width, cvs3D.height) : document.createElement('canvas');
  if (!(bufXY instanceof OffscreenCanvas)) { bufXY.width = cvsXY.width; bufXY.height = cvsXY.height; }
  if (!(buf3D instanceof OffscreenCanvas)) { buf3D.width = cvs3D.width; buf3D.height = cvs3D.height; }
  bctxXY = bufXY.getContext('2d');
  bctx3D = buf3D.getContext('2d');

  drawStaticToBuffers();
  drawPlay(playIdx);
}

function drawStaticToBuffers(){
  // XY field
  const w=cvsXY.width-PAD.x*2, h=cvsXY.height-PAD.y*2;
  bctxXY.clearRect(0,0,bufXY.width,bufXY.height);
  bctxXY.fillStyle='#0a4f1a'; bctxXY.fillRect(0,0,bufXY.width,bufXY.height);
  bctxXY.strokeStyle='rgba(255,255,255,.22)'; bctxXY.beginPath();
  for(let y=0;y<=20;y++){const x=PAD.x+(w/20)*y; bctxXY.moveTo(x,PAD.y); bctxXY.lineTo(x,PAD.y+h);}
  bctxXY.stroke();
  bctxXY.strokeStyle='rgba(255,255,255,.7)'; bctxXY.strokeRect(PAD.x,PAD.y,w,h);

  // 3D grass
  bctx3D.clearRect(0,0,buf3D.width,buf3D.height);
  bctx3D.fillStyle='#0c3f16'; bctx3D.fillRect(0,0,buf3D.width,buf3D.height);
}

// ---------- Mapping / Camera ----------
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

// Map dataset point → world yards (apply unitScale), then canvas
function mapXYraw(p){
  return {
    x: toYd(p.x),
    y: toYd(p.y),
    z: toYd(p.z || 0)
  };
}

function mapXY(p){
  const wp = mapXYraw(p);
  const w=cvsXY.width-PAD.x*2, h=cvsXY.height-PAD.y*2;
  const xNorm=clamp((wp.x + FIELD_WIDTH_YD/2)/FIELD_WIDTH_YD,0,1);
  const yNorm=clamp(1 - (wp.y / FIELD_LENGTH_YD),0,1);
  return { x: PAD.x + xNorm*w, y: PAD.y + yNorm*h, z: wp.z };
}

// Camera/projection (⚠️ #2: scale-safe)
let CAM_BACK=10, SCALE_D=8, SCALE_L=6, Z_PX=12, TILT=0.55;

function updateProjectionConstants(){
  // re-derive constants to keep proportions consistent across sizes
  const H = cvs3D.height;
  const W = cvs3D.width;
  SCALE_D = Math.max(6, Math.min(10, W / 120)); // px per yd along field
  SCALE_L = Math.max(5, Math.min(9,  H / 120)); // lateral
  Z_PX    = Math.max(10, Math.min(16, H / 40)); // height exaggeration
  TILT    = clamp(H / W, 0.45, 0.65);
}

function updateCamera(target){
  if(!autoCam) return;
  const ty = toYd(target?.y ?? 50);
  const tx = toYd(target?.x ?? 0);
  cam.y += (ty - CAM_BACK - cam.y) * 0.12;
  cam.x += (tx - cam.x) * 0.12;
}

function map3D(p){
  const wp = mapXYraw(p);
  const dy = (wp.y - cam.y);
  const dx = (wp.x - cam.x);

  // horizon derived from height to avoid skew when aspect flips
  const horizonX = cvs3D.width  * 0.15;
  const baseX = horizonX + dy * SCALE_D;
  const baseY = cvs3D.height * 0.70 + (dx * SCALE_L) * TILT;
  return { x: baseX, y: baseY - wp.z * Z_PX, z: wp.z };
}

// ---------- Trails ----------
function pushTrail(mapper, store, id, wp){
  if(!showTrails) return;
  const s = store.get(id) || [];
  const m = mapper(wp);
  s.push({x:m.x, y:m.y});
  if(s.length>40) s.shift();
  store.set(id, s);
}
function drawTrails(ctx, store, color){
  if(!showTrails) return;
  ctx.strokeStyle = color; ctx.globalAlpha = 0.28;
  store.forEach(pts=>{
    if(pts.length<2) return;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

// ---------- Helpers ----------
function mph(p){
  // p.vx/vy use dataset units per frame; convert to yd/s then mph
  const vx = toYd(p.vx || 0);
  const vy = toYd(p.vy || 0);
  const v = Math.hypot(vx, vy);         // yd/frame
  const ydsPerSec = v * FPS;            // yd/s
  const mps  = ydsPerSec * 0.9144;      // m/s
  const mph  = mps * 2.236936;          // mph
  return mph.toFixed(1);
}
function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function ring(ctx,pos,r){ ctx.beginPath(); ctx.arc(pos.x,pos.y,r,0,Math.PI*2); ctx.stroke(); }
function speedBelow(f,id){
  const pl=f.players.find(p=>p.id===id);
  const vx = toYd(pl?.vx||0), vy = toYd(pl?.vy||0);
  return !pl || Math.hypot(vx,vy) < 0.4; // ~idle threshold
}

// ---------- Hit-test (DPR-correct) (⚠️ #6) ----------
function hitTest(ev, canvas){
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (ev.clientX - rect.left) * scaleX;
  const y = (ev.clientY - rect.top ) * scaleY;

  const f = currentFrame(); if(!f) return null;
  const map = (canvas===cvs3D) ? map3D : (canvas===mini ? mapMini : mapXY);
  for(const pl of f.players){
    const m = map(pl);
    if(Math.hypot(x-m.x, y-(m.y-26)) < 10) return pl.id;
  }
  return null;
}

// ---------- Mini-map (throttled) (⚠️ #15) ----------
let miniEvery = 2; // draw mini every N frames
function mapMini(p){
  const wp = mapXYraw(p);
  const w=mini.width, h=mini.height;
  const xNorm=clamp((wp.x + FIELD_WIDTH_YD/2)/FIELD_WIDTH_YD,0,1);
  const yNorm=clamp(wp.y / FIELD_LENGTH_YD,0,1);
  return { x: xNorm*w, y: (1-yNorm)*h, z: wp.z };
}
function drawMini(f,follow){
  mctx.clearRect(0,0,mini.width,mini.height);
  mctx.strokeStyle='rgba(255,255,255,.6)';
  mctx.strokeRect(1,1,mini.width-2,mini.height-2);
  mctx.strokeStyle='rgba(255,255,255,.2)'; mctx.beginPath();
  for(let i=1;i<10;i++){ const x=(mini.width/10)*i; mctx.moveTo(x,1); mctx.lineTo(x,mini.height-1); }
  mctx.stroke();

  for(const p of f.players){
    const m=mapMini(p);
    mctx.fillStyle=(focusTarget===p.id)?'#ffd97a':(p.team==='home'?'#cfe9fb':'#ffd0d0');
    mctx.beginPath(); mctx.arc(m.x,m.y,3,0,Math.PI*2); mctx.fill();
  }
  const mb=mapMini(f.ball); mctx.fillStyle='#ffd97a'; mctx.fillRect(mb.x-2, mb.y-2, 4, 4);
  if(follow){ const mf=mapMini(follow); mctx.strokeStyle='#ffd97a'; ring(mctx,mf,8); }
}

// ---------- LOS / First-Down ----------
function drawDownDistance(ctx, mapper, f){
  if(!losOn) return;
  const yLos = (losY_auto ?? f._autoLosY);
  if(!(yLos>=0)) return;
  const yFd  = clamp(yLos + togoY, 0, FIELD_LENGTH_YD);
  const a=mapper({x:-FIELD_WIDTH_YD/2, y:yLos, z:0});
  const b=mapper({x: FIELD_WIDTH_YD/2, y:yLos, z:0});
  const c=mapper({x:-FIELD_WIDTH_YD/2, y:yFd , z:0});
  const d=mapper({x: FIELD_WIDTH_YD/2, y:yFd , z:0});
  ctx.strokeStyle='rgba(114,182,229,.95)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  ctx.strokeStyle='rgba(255,217,122,.95)'; ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(d.x,d.y); ctx.stroke();
  ctx.lineWidth=1;
}

// ---------- Frame Access ----------
function currentPlay(){ return plays[playIdx]; }
function currentFrame(){ const p=currentPlay(); return p ? p.frames[frame] : null; }

// ---------- Draw Frame ----------
function drawFrame(play, k){
  const f = play.frames[k];
  if(!f || !f.ball){ console.warn('Missing frame or ball'); return; } // (⚠️ #13)

  // Per-play LOS baseline (reset at frame 0) (⚠️ #5)
  if (k===0) play._autoLosY = toYd(f.ball.y);
  f._autoLosY = play._autoLosY;

  // follow target
  let follow = f.ball;
  if (focusTarget){
    const fp = f.players.find(p=>p.id===focusTarget);
    if(fp) follow = fp;
  }
  updateCamera(follow);

  // holder / events
  const mBallXY = mapXY(f.ball);
  let holder = null, minD = Infinity;
  f.players.forEach(p=>{
    const mp = mapXY(p);
    const d  = dist(mp, mBallXY);
    if (d < minD){ minD = d; holder = p.id; }
  });
  const thresh = 12 + Math.max(0, toYd(f.ball.z||0)*4);
  const hasHolder = (minD < thresh);
  if(hasHolder && holder!==lastHolder && lastHolder) catchFlash = 6;
  if(!hasHolder && lastHolder && toYd(f.ball.z||0)<0.4 && speedBelow(f,lastHolder)) tackleFlash = 6;
  if(hasHolder) lastHolder = holder;

  // -------- XY (blit static buffer then dynamic) --------
  ctxXY.clearRect(0,0,cvsXY.width,cvsXY.height);
  ctxXY.drawImage(bufXY,0,0);            // cached field
  drawDownDistance(ctxXY, mapXY, f);
  drawTrails(ctxXY, trailsXY, 'rgba(255,255,255,0.9)');

  f.players.forEach(p=>{
    pushTrail(mapXY, trailsXY, p.id, p);
    const mp = mapXY(p);
    const col = p.team==='home' ? '#72b6e5' : '#ff9999';
    ctxXY.strokeStyle = (focusTarget===p.id) ? '#ffd97a' : col;
    ctxXY.lineWidth   = (focusTarget===p.id) ? 3 : 2;
    ctxXY.beginPath(); ctxXY.moveTo(mp.x, mp.y-8); ctxXY.lineTo(mp.x, mp.y-22); ctxXY.stroke();
    ctxXY.beginPath(); ctxXY.arc(mp.x, mp.y-26, 3, 0, Math.PI*2); ctxXY.stroke();
    if(hasHolder && holder===p.id){
      ctxXY.strokeStyle='rgba(255,217,122,0.85)'; ring(ctxXY,{x:mp.x,y:mp.y-20},10);
    }
  });

  ctxXY.fillStyle='#ffd97a';
  ctxXY.beginPath(); ctxXY.arc(mBallXY.x, mBallXY.y - toYd(f.ball.z||0)*8, 3, 0, Math.PI*2); ctxXY.fill();

  if(showSpeed || showPos){
    ctxXY.font='bold 10px system-ui'; ctxXY.textAlign='center'; ctxXY.fillStyle='#fff';
    f.players.forEach(p=>{
      const mp=mapXY(p);
      let text='';
      if(showSpeed) text += `${mph(p)} mph `;
      if(showPos && p.role) text += `(${p.role})`;
      if(text) ctxXY.fillText(text, mp.x, mp.y - 30);
    });
  }

  // -------- 3D (blit static buffer then dynamic) --------
  ctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
  ctx3D.drawImage(buf3D,0,0);            // cached grass
  drawDownDistance(ctx3D, map3D, f);
  drawTrails(ctx3D, trails3D, 'rgba(255,255,255,0.9)');

  // depth sort
  const ps = [...f.players].sort((a,b)=> toYd(a.y)-toYd(b.y));
  ps.forEach(p=>{
    pushTrail(map3D, trails3D, p.id, p);
    const mp = map3D(p);
    const col = p.team==='home' ? '#cfe9fb' : '#ffd0d0';
    // shadow
    ctx3D.fillStyle='rgba(0,0,0,0.28)'; ctx3D.beginPath();
    ctx3D.ellipse(mp.x, mp.y+6, 8, 2.5, 0, 0, Math.PI*2); ctx3D.fill();
    // stick figure
    ctx3D.strokeStyle=(focusTarget===p.id)?'#ffd97a':col;
    ctx3D.lineWidth=(focusTarget===p.id)?2.5:1.8;
    ctx3D.beginPath(); ctx3D.moveTo(mp.x, mp.y-10); ctx3D.lineTo(mp.x, mp.y-25); ctx3D.stroke();
    ctx3D.beginPath(); ctx3D.arc(mp.x, mp.y-30, 3, 0, Math.PI*2); ctx3D.stroke();
    if(hasHolder && holder===p.id){
      ctx3D.strokeStyle='rgba(255,217,122,0.9)'; ring(ctx3D,{x:mp.x,y:mp.y-20},10);
    }
  });

  const mBall3D = map3D(f.ball);
  ctx3D.fillStyle='#ffd97a';
  ctx3D.beginPath(); ctx3D.arc(mBall3D.x, mBall3D.y, 4, 0, Math.PI*2); ctx3D.fill();

  // FX decrement once per frame (⚠️ #12)
  if(effectsOn){
    if(catchFlash>0){ ctx3D.strokeStyle='rgba(255,255,0,0.9)'; ring(ctx3D, mBall3D, 20); }
    if(tackleFlash>0){ ctx3D.strokeStyle='rgba(255,255,255,0.9)'; ring(ctx3D, mBall3D, 28); }
  }
  if(catchFlash>0)  catchFlash--;
  if(tackleFlash>0) tackleFlash--;

  if(focusTarget){
    const fp = f.players.find(p=>p.id===focusTarget);
    if(fp){
      const mp = map3D(fp);
      ctx3D.font='bold 12px system-ui'; ctx3D.textAlign='center'; ctx3D.fillStyle='#fff';
      ctx3D.fillText(`${focusTarget}  ${mph(fp)} mph`, mp.x, mp.y-36);
    }
  }

  // HUD throttling (⚠️ #9)
  if ((k % 3) === 0) {
    if (hudXY) hudXY.textContent = `Play ${playIdx+1}/${plays.length} — Holder: ${hasHolder?holder:'None'} — Frame ${k+1}/${play.frames.length}`;
    if (hud3D) hud3D.textContent = focusTarget ? `Follow: ${focusTarget}` : 'Follow: Ball';
  }

  // Mini-map throttled
  if (mini && (k % miniEvery) === 0) drawMini(f, follow);
}

// ---------- Draw / Playback ----------
function populateFocusMenu(p){
  if(!focusSel) return;
  focusSel.innerHTML = ''; // (⚠️ #8)
  const ids = new Set();
  p.frames?.[0]?.players?.forEach(pl=> ids.add(pl.id));
  focusSel.innerHTML = '<option value="">Follow: Ball (default)</option>' +
    [...ids].map(id=>`<option value="${id}">${id}</option>`).join('');
}

function drawPlay(i){
  const p = plays[i]; if(!p) return;
  // ensure projection constants are fresh
  updateProjectionConstants();
  // per-play reset of LOS baseline handled in drawFrame when k==0
  drawFrame(p, frame);
}

function stepFrames(n){
  const p = plays[playIdx]; if(!p) return;
  frame = Math.max(0, Math.min(p.frames.length-1, frame + n));
  drawPlay(playIdx);
}

// rAF loop (⚠️ #1)
function loop(t){
  if (!playing || reduceMotion) { lastT = t; requestAnimationFrame(loop); return; }
  if (!lastT) lastT = t;
  let dt = t - lastT; lastT = t;
  acc += dt;
  while (acc >= TICK_MS) {
    const p = plays[playIdx];
    if (p){
      frame++;
      if (frame >= p.frames.length){
        frame = 0;
        playIdx = (playIdx + 1) % plays.length;
        // Reset trails + holder when rolling to next play (⚠️ #4)
        trailsXY.clear(); trails3D.clear(); lastHolder = null;
        // Reset LOS auto for new play (⚠️ #5)
        if (plays[playIdx]) plays[playIdx]._autoLosY = null;
      }
      drawPlay(playIdx);
    }
    acc -= TICK_MS;
  }
  requestAnimationFrame(loop);
}

// ---------- Init Load ----------
function initLoad(isReload=false){
  playing=false; frame=0; playIdx=0; lastHolder=null;
  trailsXY.clear(); trails3D.clear();        // (⚠️ #4 on dataset switch)
  if (hudXY) hudXY.textContent='Loading…';
  if (hud3D) hud3D.textContent='Loading…';

  fetch(DATA_URL, {cache:'no-cache'})
    .then(r=>r.json())
    .then(d=>{
      // Validate schema (⚠️ #7)
      if (!d || !Array.isArray(d.plays)) throw new Error('Invalid dataset: plays[] missing');

      // Units flag (meters/yds) (⚠️ #14)
      // Expect d.units in {'yards','meters'} or d.field_cs?.units
      const units = (d.units || d.field_cs?.units || 'yards').toLowerCase();
      unitScale = (units.startsWith('meter')) ? (1/0.9144) : 1;

      plays = d.plays;
      populateFocusMenu(plays[0] || {});
      if (hudXY) hudXY.textContent = `Loaded ${plays.length} play(s) — tap ▶`;
      if (hud3D) hud3D.textContent = 'Follow: Ball';

      sizeAndRedraw();
    })
    .catch(e=>{
      if (hudXY) hudXY.textContent = 'Load error: ' + e.message;
      if (hud3D) hud3D.textContent = 'Load error: ' + e.message;
      console.error(e);
    });
}

btnPlay  && (btnPlay.onclick  = ()=>{ if(plays.length){ playing = true; requestAnimationFrame(loop); }});
btnPause && (btnPause.onclick = ()=> playing = false);
btnStep  && (btnStep.onclick  = ()=>{ playing=false; stepFrames(1); });

// Kick
sizeAndRedraw();
initLoad(false);
})();
