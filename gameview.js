/* gameview.js — Dual-View rAF (XY + Z follow, mini-map, LOS/1D) — robust loader */
(()=>{
// ---------- Config / Units ----------
let DATA_URL = new URLSearchParams(location.search).get('data') || 'drive_realistic_shotgun.json';
const FPS_DEFAULT = 10;
let FPS = FPS_DEFAULT;
const TICK_MS_BASE = 1000;

// Path normalizer: if option has no folder and the root 404s, try converted_json/
async function resolvePath(url){
  if (/^https?:/i.test(url)) return url;
  // test as given
  try { const r = await fetch(url, {method:'HEAD', cache:'no-cache'}); if (r.ok) return url; } catch {}
  // try in converted_json/
  const alt = (url.startsWith('/')?url.slice(1):url);
  const inConv = 'converted_json/' + alt;
  try { const r2 = await fetch(inConv, {method:'HEAD', cache:'no-cache'}); if (r2.ok) return inConv; } catch {}
  return url; // fall back; fetch will report error
}

// ---------- Field constants (yards) ----------
const FIELD_WIDTH_YD  = 53.333;
const FIELD_LENGTH_YD = 100;
const PAD = { x: 80, y: 40 };

// Units
let unitScale = 1; // world->yards; 1 if already yards; meters→yards = 1/0.9144
const toYd = v => v * unitScale;

// ---------- DOM ----------
const cvsXY = document.getElementById('fieldXY');  const ctxXY = cvsXY.getContext('2d');  const hudXY = document.getElementById('hudXY');
const cvs3D = document.getElementById('field3D');  const ctx3D = cvs3D.getContext('2d');  const hud3D = document.getElementById('hud3D');
const mini  = document.getElementById('mini');     const mctx  = mini.getContext('2d');

const btnPlay = document.getElementById('play'); const btnPause = document.getElementById('pause'); const btnStep = document.getElementById('step');
const showSpeedEl = document.getElementById('showSpeed'); const showPosEl = document.getElementById('showPos'); const showTrailsEl = document.getElementById('showTrails');
const autoCamEl = document.getElementById('autoCam'); const losOnEl = document.getElementById('losOn'); const fxOnEl = document.getElementById('effectsOn');
const focusSel = document.getElementById('focusPlayer');
const losYEl = document.getElementById('losY'); const togoEl = document.getElementById('togo'); const applyDDEl = document.getElementById('applyDD');
const dsSel = document.getElementById('datasetSel'); const reloadBtn = document.getElementById('reload'); const fileInput = document.getElementById('fileInput');

// ---------- State ----------
let plays=[], playIdx=0, frame=0, playing=false;
let showSpeed=true, showPos=true, showTrails=true, autoCam=true, losOn=true, effectsOn=true;
let reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let focusTarget=null;
let trailsXY=new Map(), trails3D=new Map();
let lastHolder=null, catchFlash=0, tackleFlash=0;
let losY_auto=null, togoY=10;
let cam={y:50,x:0,z:6};

// rAF timing
let lastT=0, acc=0;
const tickMs = ()=> (TICK_MS_BASE / Math.max(1, FPS));

// DPR/resize
let dprCached = window.devicePixelRatio || 1;
const ro = new ResizeObserver(()=> sizeAndRedraw());
[cvsXY,cvs3D,mini].forEach(c=>ro.observe(c));

// Offscreen buffers
let bufXY=null,bctxXY=null,buf3D=null,bctx3D=null;

// ---------- UI ----------
showSpeedEl.onchange=()=>showSpeed=showSpeedEl.checked;
showPosEl.onchange=()=>showPos=showPosEl.checked;
showTrailsEl.onchange=()=>showTrails=showTrailsEl.checked;
autoCamEl.onchange=()=>autoCam=autoCamEl.checked;
losOnEl.onchange=()=>losOn=losOnEl.checked;
fxOnEl.onchange=()=>effectsOn=fxOnEl.checked;
focusSel.onchange=()=>{focusTarget=focusSel.value||null;};

applyDDEl.onclick=()=>{
  const vLos=parseFloat(losYEl.value), vTgo=parseFloat(togoEl.value);
  if(!Number.isNaN(vLos)) losY_auto=vLos;
  if(!Number.isNaN(vTgo)) togoY=vTgo;
};

dsSel.value=DATA_URL;
reloadBtn.onclick=async()=>{ DATA_URL = await resolvePath(dsSel.value||'drive_realistic_shotgun.json'); initLoad(true); };

// Mobile file picker
fileInput.onchange = async (e)=>{
  const file = e.target.files?.[0]; if(!file) return;
  const text = await file.text();
  try{
    const raw = JSON.parse(text);
    const norm = normalizeDataset(raw);
    plays = norm.plays; FPS = norm.fps;
    populateFocusMenu(plays[0]||{});
    trailsXY.clear(); trails3D.clear(); lastHolder=null; frame=0; playIdx=0;
    hudXY.textContent=`Loaded ${plays.length} play(s) from ${file.name} — tap ▶`;
    hud3D.textContent='Follow: Ball';
    sizeAndRedraw();
  }catch(err){ hudXY.textContent='Load error: '+err.message; hud3D.textContent=hudXY.textContent; }
};

// click-to-focus
;[cvsXY,cvs3D,mini].forEach(cv=>{
  cv.addEventListener('click',ev=>{
    const id=hitTest(ev,cv);
    focusTarget=id||null; focusSel.value=id||"";
    drawPlay(playIdx);
  });
});

// keyboard scrub
window.addEventListener('keydown', e=>{
  if(e.key==='k'||e.key==='K'){ playing=false; }
  if(e.key==='j'||e.key==='J'){ stepFrames(-FPS); }
  if(e.key==='l'||e.key==='L'){ stepFrames(e.shiftKey?FPS*5:FPS); }
});

// ---------- Sizing / buffers ----------
function sizeCanvas(c){
  const dpr=window.devicePixelRatio||1;
  const cssW=c.clientWidth||c.width||960, cssH=c.clientHeight||c.height||540;
  c.width=Math.round(cssW*dpr); c.height=Math.round(cssH*dpr);
  c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}
function sizeAndRedraw(){
  [cvsXY,cvs3D,mini].forEach(sizeCanvas);
  bufXY=document.createElement('canvas'); buf3D=document.createElement('canvas');
  bufXY.width=cvsXY.width; bufXY.height=cvsXY.height; bctxXY=bufXY.getContext('2d');
  buf3D.width=cvs3D.width; buf3D.height=cvs3D.height; bctx3D=buf3D.getContext('2d');
  drawStaticToBuffers(); drawPlay(playIdx);
}
function drawStaticToBuffers(){
  const w=cvsXY.width-PAD.x*2,h=cvsXY.height-PAD.y*2;
  bctxXY.fillStyle='#0a4f1a'; bctxXY.fillRect(0,0,bufXY.width,bufXY.height);
  bctxXY.strokeStyle='rgba(255,255,255,.22)'; bctxXY.beginPath();
  for(let y=0;y<=20;y++){const x=PAD.x+(w/20)*y; bctxXY.moveTo(x,PAD.y); bctxXY.lineTo(x,PAD.y+h);}
  bctxXY.stroke();
  bctxXY.strokeStyle='rgba(255,255,255,.7)'; bctxXY.strokeRect(PAD.x,PAD.y,w,h);
  bctx3D.fillStyle='#0c3f16'; bctx3D.fillRect(0,0,buf3D.width,buf3D.height);
}

// ---------- Mapping / camera ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function mapXYraw(p){ return {x:toYd(p.x),y:toYd(p.y),z:toYd(p.z||0)}; }
function mapXY(p){
  const wp=mapXYraw(p); const w=cvsXY.width-PAD.x*2,h=cvsXY.height-PAD.y*2;
  const xNorm=clamp((wp.x+FIELD_WIDTH_YD/2)/FIELD_WIDTH_YD,0,1);
  const yNorm=clamp(1-(wp.y/FIELD_LENGTH_YD),0,1);
  return {x:PAD.x+xNorm*w, y:PAD.y+yNorm*h, z:wp.z};
}
let CAM_BACK=10,SCALE_D=8,SCALE_L=6,Z_PX=12,TILT=0.55;
function updateProjectionConstants(){
  const H=cvs3D.height,W=cvs3D.width;
  SCALE_D=Math.max(6,Math.min(10,W/120));
  SCALE_L=Math.max(5,Math.min(9,H/120));
  Z_PX=Math.max(10,Math.min(16,H/40));
  TILT=clamp(H/W,0.45,0.65);
}
function updateCamera(target){ if(!autoCam) return; const ty=toYd(target?.y??50),tx=toYd(target?.x??0); cam.y+=(ty-CAM_BACK-cam.y)*0.12; cam.x+=(tx-cam.x)*0.12; }
function map3D(p){
  const wp=mapXYraw(p), dy=(wp.y-cam.y), dx=(wp.x-cam.x);
  const baseX=cvs3D.width*0.15 + dy*SCALE_D;
  const baseY=cvs3D.height*0.70 + (dx*SCALE_L)*TILT;
  return {x:baseX, y:baseY - wp.z*Z_PX, z:wp.z};
}

// ---------- Trails / helpers ----------
function pushTrail(mapper,store,id,wp){ if(!showTrails)return; const s=store.get(id)||[]; const m=mapper(wp); s.push({x:m.x,y:m.y}); if(s.length>40)s.shift(); store.set(id,s); }
function drawTrails(ctx,store,color){ if(!showTrails)return; ctx.strokeStyle=color; ctx.globalAlpha=.28; store.forEach(pts=>{if(pts.length<2)return; ctx.beginPath(); ctx.moveTo(pts[0].x,pts[0].y); for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y); ctx.stroke();}); ctx.globalAlpha=1; }
const mph=p=>{const vx=toYd(p.vx||0),vy=toYd(p.vy||0); const v=Math.hypot(vx,vy); const mps=v*FPS*0.9144; return (mps*2.236936).toFixed(1);};
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const ring=(ctx,pos,r)=>{ctx.beginPath();ctx.arc(pos.x,pos.y,r,0,Math.PI*2);ctx.stroke();};
function speedBelow(f,id){const pl=f.players.find(p=>p.id===id); const vx=toYd(pl?.vx||0), vy=toYd(pl?.vy||0); return !pl || Math.hypot(vx,vy)<0.4;}

// ---------- Hit test ----------
function hitTest(ev,canvas){
  const rect=canvas.getBoundingClientRect();
  const scaleX=canvas.width/rect.width, scaleY=canvas.height/rect.height;
  const x=(ev.clientX-rect.left)*scaleX, y=(ev.clientY-rect.top)*scaleY;
  const f=currentFrame(); if(!f) return null;
  const map = (canvas===cvs3D)?map3D:(canvas===mini?mapMini:mapXY);
  for(const pl of f.players){const m=map(pl); if(Math.hypot(x-m.x,y-(m.y-26))<10) return pl.id;}
  return null;
}

// ---------- Mini-map ----------
let miniEvery=2;
function mapMini(p){const wp=mapXYraw(p), w=mini.width,h=mini.height; const xN=clamp((wp.x+FIELD_WIDTH_YD/2)/FIELD_WIDTH_YD,0,1); const yN=clamp(wp.y/FIELD_LENGTH_YD,0,1); return {x:xN*w, y:(1-yN)*h, z:wp.z};}
function drawMini(f,follow){
  mctx.clearRect(0,0,mini.width,mini.height);
  mctx.strokeStyle='rgba(255,255,255,.6)'; mctx.strokeRect(1,1,mini.width-2,mini.height-2);
  mctx.strokeStyle='rgba(255,255,255,.2)'; mctx.beginPath(); for(let i=1;i<10;i++){const x=(mini.width/10)*i; mctx.moveTo(x,1); mctx.lineTo(x,mini.height-1);} mctx.stroke();
  for(const p of f.players){const m=mapMini(p); mctx.fillStyle=(focusTarget===p.id)?'#ffd97a':(p.team==='home'?'#cfe9fb':'#ffd0d0'); mctx.beginPath(); mctx.arc(m.x,m.y,3,0,Math.PI*2); mctx.fill();}
  const mb=mapMini(f.ball); mctx.fillStyle='#ffd97a'; mctx.fillRect(mb.x-2,mb.y-2,4,4);
  if(follow){const mf=mapMini(follow); mctx.strokeStyle='#ffd97a'; ring(mctx,mf,8);}
}

// ---------- LOS / first down ----------
function drawDownDistance(ctx,mapper,f){
  if(!losOn) return;
  const yLos=(losY_auto ?? f._autoLosY); if(!(yLos>=0)) return;
  const yFd=clamp(yLos+togoY,0,FIELD_LENGTH_YD);
  const a=mapper({x:-FIELD_WIDTH_YD/2,y:yLos,z:0}), b=mapper({x:FIELD_WIDTH_YD/2,y:yLos,z:0});
  const c=mapper({x:-FIELD_WIDTH_YD/2,y:yFd ,z:0}), d=mapper({x:FIELD_WIDTH_YD/2,y:yFd ,z:0});
  ctx.strokeStyle='rgba(114,182,229,.95)'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
  ctx.strokeStyle='rgba(255,217,122,.95)'; ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(d.x,d.y); ctx.stroke(); ctx.lineWidth=1;
}

// ---------- Frame access ----------
const currentPlay=()=>plays[playIdx];
const currentFrame=()=>{const p=currentPlay(); return p ? p.frames[frame] : null;};

// ---------- Draw one frame ----------
function drawFrame(play,k){
  const f=play.frames[k]; if(!f||!f.ball){hudXY.textContent='(no frame/ball)'; return;}
  if(k===0) play._autoLosY = toYd(f.ball.y); f._autoLosY = play._autoLosY;

  let follow=f.ball; if(focusTarget){const fp=f.players.find(p=>p.id===focusTarget); if(fp) follow=fp;}
  updateCamera(follow);

  const mBallXY=mapXY(f.ball); let holder=null, minD=Infinity;
  f.players.forEach(p=>{const mp=mapXY(p); const d=dist(mp,mBallXY); if(d<minD){minD=d; holder=p.id;}});
  const thresh=12+Math.max(0,toYd(f.ball.z||0)*4); const hasHolder=(minD<thresh);
  if(hasHolder && holder!==lastHolder && lastHolder) catchFlash=6;
  if(!hasHolder && lastHolder && toYd(f.ball.z||0)<0.4 && speedBelow(f,lastHolder)) tackleFlash=6;
  if(hasHolder) lastHolder=holder;

  // XY
  ctxXY.clearRect(0,0,cvsXY.width,cvsXY.height); ctxXY.drawImage(bufXY,0,0);
  drawDownDistance(ctxXY,mapXY,f); drawTrails(ctxXY,trailsXY,'rgba(255,255,255,0.9)');
  f.players.forEach(p=>{
    pushTrail(mapXY,trailsXY,p.id,p);
    const mp=mapXY(p), col=p.team==='home'?'#72b6e5':'#ff9999';
    ctxXY.strokeStyle=(focusTarget===p.id)?'#ffd97a':col; ctxXY.lineWidth=(focusTarget===p.id)?3:2;
    ctxXY.beginPath(); ctxXY.moveTo(mp.x,mp.y-8); ctxXY.lineTo(mp.x,mp.y-22); ctxXY.stroke();
    ctxXY.beginPath(); ctxXY.arc(mp.x,mp.y-26,3,0,Math.PI*2); ctxXY.stroke();
    if(hasHolder&&holder===p.id){ctxXY.strokeStyle='rgba(255,217,122,.85)'; ring(ctxXY,{x:mp.x,y:mp.y-20},10);}
  });
  ctxXY.fillStyle='#ffd97a'; ctxXY.beginPath(); ctxXY.arc(mBallXY.x,mBallXY.y-toYd(f.ball.z||0)*8,3,0,Math.PI*2); ctxXY.fill();
  if(showSpeed||showPos){ctxXY.font='bold 10px system-ui'; ctxXY.textAlign='center'; ctxXY.fillStyle='#fff';
    f.players.forEach(p=>{const mp=mapXY(p); let t=''; if(showSpeed) t+=`${mph(p)} mph `; if(showPos&&p.role) t+=`(${p.role})`; if(t) ctxXY.fillText(t,mp.x,mp.y-30);});}

  // 3D
  ctx3D.clearRect(0,0,cvs3D.width,cvs3D.height); ctx3D.drawImage(buf3D,0,0);
  drawDownDistance(ctx3D,map3D,f); drawTrails(ctx3D,trails3D,'rgba(255,255,255,0.9)');
  const ps=[...f.players].sort((a,b)=>toYd(a.y)-toYd(b.y));
  ps.forEach(p=>{
    pushTrail(map3D,trails3D,p.id,p);
    const mp=map3D(p), col=p.team==='home'?'#cfe9fb':'#ffd0d0';
    ctx3D.fillStyle='rgba(0,0,0,.28)'; ctx3D.beginPath(); ctx3D.ellipse(mp.x,mp.y+6,8,2.5,0,0,Math.PI*2); ctx3D.fill();
    ctx3D.strokeStyle=(focusTarget===p.id)?'#ffd97a':col; ctx3D.lineWidth=(focusTarget===p.id)?2.5:1.8;
    ctx3D.beginPath(); ctx3D.moveTo(mp.x,mp.y-10); ctx3D.lineTo(mp.x,mp.y-25); ctx3D.stroke();
    ctx3D.beginPath(); ctx3D.arc(mp.x,mp.y-30,3,0,Math.PI*2); ctx3D.stroke();
    if(hasHolder&&holder===p.id){ctx3D.strokeStyle='rgba(255,217,122,.9)'; ring(ctx3D,{x:mp.x,y:mp.y-20},10);}
  });
  const mBall3D=map3D(f.ball); ctx3D.fillStyle='#ffd97a'; ctx3D.beginPath(); ctx3D.arc(mBall3D.x,mBall3D.y,4,0,Math.PI*2); ctx3D.fill();
  if(effectsOn){ if(catchFlash>0){ctx3D.strokeStyle='rgba(255,255,0,.9)'; ring(ctx3D,mBall3D,20);} if(tackleFlash>0){ctx3D.strokeStyle='rgba(255,255,255,.9)'; ring(ctx3D,mBall3D,28);} }
  if(catchFlash>0)catchFlash--; if(tackleFlash>0)tackleFlash--;
  if(focusTarget){const fp=f.players.find(p=>p.id===focusTarget); if(fp){const mp=map3D(fp); ctx3D.font='bold 12px system-ui'; ctx3D.textAlign='center'; ctx3D.fillStyle='#fff'; ctx3D.fillText(`${focusTarget}  ${mph(fp)} mph`, mp.x, mp.y-36);}}
  if((k%3)===0){hudXY.textContent=`Play ${playIdx+1}/${plays.length} — Holder: ${hasHolder?holder:'None'} — Frame ${k+1}/${play.frames.length}`; hud3D.textContent=focusTarget?`Follow: ${focusTarget}`:'Follow: Ball';}
  if((k%miniEvery)===0) drawMini(f,follow);
}

// ---------- Playback ----------
function populateFocusMenu(p){
  focusSel.innerHTML='<option value="">Follow: Ball (default)</option>';
  const ids=new Set(); p.frames?.[0]?.players?.forEach(pl=>ids.add(pl.id));
  ids.forEach(id=>{const o=document.createElement('option'); o.value=id; o.textContent=id; focusSel.appendChild(o);});
}
function drawPlay(i){const p=plays[i]; if(!p) return; updateProjectionConstants(); drawFrame(p,frame);}
function stepFrames(n){const p=plays[playIdx]; if(!p) return; frame=Math.max(0,Math.min(p.frames.length-1,frame+n)); drawPlay(playIdx);}
function loop(t){
  if(!playing||reduceMotion){lastT=t; requestAnimationFrame(loop); return;}
  if(!lastT) lastT=t; let dt=t-lastT; lastT=t; acc+=dt;
  while(acc>=tickMs()){
    const p=plays[playIdx];
    if(p){
      frame++;
      if(frame>=p.frames.length){ frame=0; playIdx=(playIdx+1)%plays.length; trailsXY.clear(); trails3D.clear(); lastHolder=null; if(plays[playIdx]) plays[playIdx]._autoLosY=null; }
      drawPlay(playIdx);
    }
    acc-=tickMs();
  }
  requestAnimationFrame(loop);
}

// ---------- Dataset normalization ----------
// Accepts: (A) {plays:[{frames:…}]}
//          (B) gv-telemetry/v1 {schema,fps,field_cs:{units},frames:[…]}
//          (C) Kaggle rows array or {rows:[…]}
/** return {plays:[{frames:…}] , fps:number} */
function normalizeDataset(d){
  // (B) gv-telemetry/v1
  if (d && d.schema === 'gv-telemetry/v1' && Array.isArray(d.frames)) {
    unitScale = (d.field_cs?.units === 'm') ? (1/0.9144) : 1;
    FPS = Number(d.fps)||FPS_DEFAULT;
    return { fps: FPS, plays: [{ frames: d.frames }] };
  }
  // (A) original GameView format
  if (d && Array.isArray(d.plays)) {
    // try to read units if present
    const units = (d.units || d.field_cs?.units || 'yards').toLowerCase();
    unitScale = units.startsWith('m') ? (1/0.9144) : 1;
    FPS = Number(d.fps)||FPS_DEFAULT;
    return { fps: FPS, plays: d.plays };
  }
  // (C) Kaggle rows
  const rows = Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : null);
  if (!rows) throw new Error('Unknown JSON format');
  // Build a single-frame play from rows (works for 2018-style single timestamp)
  // Kaggle: X in 0..120 (includes endzones), Y in 0..53.3, Team 'home'|'away', NflId, Position, S(speed yds/s), Dir (deg)
  // Map to our field: x_lateral = Y - 26.6665; y_downfield = (PlayDirection=="right"? X-10 : 110-X)
  const first = rows[0]||{};
  const playDir = (first.PlayDirection || first.playDirection || 'right').toLowerCase();
  const players = rows.map(r=>{
    const Y = Number(r.Y ?? r.y ?? 26.6665);
    const X = Number(r.X ?? r.x ?? 60);
    const lateral = Y - 26.6665;
    const downfield = playDir==='right' ? (X-10) : (110 - X);
    const speedYdsS = Number(r.S ?? r.s ?? 0);
    const dirDeg = Number(r.Dir ?? r.dir ?? 0);
    const rad = (dirDeg*Math.PI)/180;
    const vx = speedYdsS * Math.cos(rad) / (FPS||FPS_DEFAULT); // yd per frame (approx)
    const vy = speedYdsS * Math.sin(rad) / (FPS||FPS_DEFAULT);
    return {
      id: String(r.NflId ?? r.nflId ?? r.DisplayName ?? r.displayName ?? Math.random().toString(36).slice(2)),
      team: (r.Team ?? r.team ?? '').toLowerCase()==='home' ? 'home' : 'away',
      role: r.Position ?? r.position ?? '',
      x: lateral, y: clamp(downfield,0,100), z: 0,
      vx, vy
    };
  });
  // ball: approximate at LOS (mean of players’ y) and centered laterally
  const meanY = players.reduce((a,p)=>a+p.y,0)/(players.length||1);
  const ball = { x:0, y: clamp(meanY,0,100), z:0 };
  unitScale = 1; FPS = FPS_DEFAULT;
  return { fps: FPS, plays: [{ frames: [{ time_s:0, players, ball }] }] };
}

// ---------- Init load ----------
async function initLoad(){
  playing=false; frame=0; playIdx=0; lastHolder=null; trailsXY.clear(); trails3D.clear();
  hudXY.textContent='Loading…'; hud3D.textContent='Loading…';
  const url = await resolvePath(DATA_URL);
  try{
    const raw = await fetch(url,{cache:'no-cache'}).then(r=>r.json());
    const norm = normalizeDataset(raw);
    plays = norm.plays; FPS = norm.fps;
    populateFocusMenu(plays[0]||{});
    hudXY.textContent=`Loaded ${plays.length} play(s) — tap ▶`; hud3D.textContent='Follow: Ball';
    sizeAndRedraw();
  }catch(e){
    hudXY.textContent='Load error: '+e.message; hud3D.textContent=hudXY.textContent; console.error(e);
  }
}

// ---------- Wire playback ----------
btnPlay.onclick=()=>{ if(plays.length){ playing=true; requestAnimationFrame(loop); } };
btnPause.onclick=()=> playing=false;
btnStep.onclick =()=>{ playing=false; stepFrames(1); };

// ---------- Kick ----------
sizeAndRedraw();
initLoad();
})();
