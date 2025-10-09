/* gameview.js — Dual-View rAF (XY + Z Follow, Mini-map, LOS/1D) — NFL Telemetry Compatible */
(()=>{
// ---------- Config ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data') || 'drive_nfltelemetry.json';
const FPS = 10;
const FIELD_WIDTH_YD  = 53.333;  // sideline-to-sideline
const FIELD_LENGTH_YD = 120;     // full length with end zones
const PAD = {x:60,y:40};

// ---------- DOM ----------
const cvsXY  = document.getElementById('fieldXY');
const ctxXY  = cvsXY.getContext('2d');
const hudXY  = document.getElementById('hudXY');
const cvs3D  = document.getElementById('field3D');
const ctx3D  = cvs3D.getContext('2d');
const hud3D  = document.getElementById('hud3D');
const mini   = document.getElementById('mini');
const mctx   = mini.getContext('2d');

const btnPlay=document.getElementById('play');
const btnPause=document.getElementById('pause');
const btnStep=document.getElementById('step');
const showSpeedEl=document.getElementById('showSpeed');
const showPosEl=document.getElementById('showPos');
const showTrailsEl=document.getElementById('showTrails');
const autoCamEl=document.getElementById('autoCam');
const losOnEl=document.getElementById('losOn');
const fxOnEl=document.getElementById('effectsOn');
const focusSel=document.getElementById('focusPlayer');
const losYEl=document.getElementById('losY');
const togoEl=document.getElementById('togo');
const applyDDEl=document.getElementById('applyDD');
const dsSel=document.getElementById('datasetSel');
const reloadBtn=document.getElementById('reload');
const fileInput=document.getElementById('fileInput');

// ---------- State ----------
let plays=[], playIdx=0, frame=0;
let playing=false, lastT=0, acc=0;
let showSpeed=true, showPos=true, showTrails=true, autoCam=true, losOn=true, effectsOn=true;
let reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let trailsXY=new Map(), trails3D=new Map(), lastHolder=null, catchFlash=0, tackleFlash=0;
let losY_auto=null, togoY=10;
let cam={x:0,y:0,z:0};
let unitScale=1;
let DATA_URL=DEFAULT_DATA;

// ---------- UI Events ----------
showSpeedEl.onchange=()=>showSpeed=showSpeedEl.checked;
showPosEl.onchange=()=>showPos=showPosEl.checked;
showTrailsEl.onchange=()=>showTrails=showTrailsEl.checked;
autoCamEl.onchange=()=>autoCam=autoCamEl.checked;
losOnEl.onchange=()=>losOn=losOnEl.checked;
fxOnEl.onchange=()=>effectsOn=fxOnEl.checked;
focusSel.onchange=()=>focusTarget=focusSel.value||null;
applyDDEl.onclick=()=>{
  const vLos=parseFloat(losYEl.value),vTgo=parseFloat(togoEl.value);
  if(!Number.isNaN(vLos)) losY_auto=vLos;
  if(!Number.isNaN(vTgo)) togoY=vTgo;
};
reloadBtn.onclick=()=>{DATA_URL=dsSel.value||DEFAULT_DATA;initLoad(true);};
btnPlay.onclick=()=>{if(plays.length){playing=true;requestAnimationFrame(loop);}};
btnPause.onclick=()=>playing=false;
btnStep.onclick=()=>{playing=false;stepFrames(1);};
fileInput.onchange=e=>{
  const file=e.target.files[0];
  if(file){
    const reader=new FileReader();
    reader.onload=ev=>{
      try{normalizeDataset(JSON.parse(ev.target.result));drawPlay(0);}
      catch(err){hudXY.textContent='Bad file';console.error(err);}
    };
    reader.readAsText(file);
  }
};

// ---------- Canvas sizing ----------
function sizeCanvas(c){
  const dpr=window.devicePixelRatio||1;
  const w=c.clientWidth||960,h=c.clientHeight||540;
  c.width=w*dpr;c.height=h*dpr;
  c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}
function sizeAll(){[cvsXY,cvs3D,mini].forEach(sizeCanvas);}

// ---------- Helpers ----------
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function ring(ctx,pos,r){ctx.beginPath();ctx.arc(pos.x,pos.y,r,0,Math.PI*2);ctx.stroke();}
function mph(p){const v=Math.hypot(p.vx||0,p.vy||0)*FPS*0.9144*2.23694;return v.toFixed(1);}
function speedBelow(f,id){const pl=f.players.find(p=>p.id===id);return !pl||Math.hypot(pl.vx||0,pl.vy||0)<0.4;}

// ---------- Mapping / Camera ----------
function mapXY(p){
  const w=cvsXY.width,h=cvsXY.height;
  const scaleX=w/FIELD_WIDTH_YD,scaleY=h/FIELD_LENGTH_YD;
  const x=(p.x-cam.x+FIELD_WIDTH_YD/2)*scaleX;
  const y=h-(p.y-cam.y)*scaleY;
  return{x,y,z:p.z||0};
}
function map3D(p){
  const w=cvs3D.width,h=cvs3D.height;
  const scale=h/FIELD_LENGTH_YD;
  const baseX=w/2+(p.x-cam.x)*scale*5;
  const baseY=h*0.8-(p.y-cam.y)*scale*5;
  return{x:baseX,y:baseY-(p.z||0)*20,z:p.z||0};
}
function mapMini(p){
  const w=mini.width,h=mini.height;
  return{x:clamp(p.x/FIELD_LENGTH_YD,0,1)*w,y:h-clamp(p.y/FIELD_WIDTH_YD,0,1)*h};
}
function updateCamera(target){
  if(!autoCam||!target) return;
  cam.x+=(target.x-cam.x)*0.15;
  cam.y+=(target.y-cam.y)*0.15;
}

// ---------- Trails ----------
function pushTrail(mapper,store,id,p){
  if(!showTrails)return;
  const s=store.get(id)||[];
  const m=mapper(p);s.push({x:m.x,y:m.y});
  if(s.length>40)s.shift();
  store.set(id,s);
}
function drawTrails(ctx,store,color){
  if(!showTrails)return;
  ctx.strokeStyle=color;ctx.globalAlpha=0.3;
  store.forEach(pts=>{
    if(pts.length<2)return;
    ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();
  });ctx.globalAlpha=1;
}

// ---------- Draw ----------
function drawDownDistance(ctx,mapper,f){
  if(!losOn)return;
  const yLos=losY_auto??f._autoLosY;
  if(!(yLos>=0))return;
  const yFd=clamp(yLos+togoY,0,FIELD_LENGTH_YD);
  const a=mapper({x:-FIELD_WIDTH_YD/2,y:yLos,z:0});
  const b=mapper({x:FIELD_WIDTH_YD/2,y:yLos,z:0});
  const c=mapper({x:-FIELD_WIDTH_YD/2,y:yFd ,z:0});
  const d=mapper({x:FIELD_WIDTH_YD/2,y:yFd ,z:0});
  ctx.strokeStyle='rgba(114,182,229,.95)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
  ctx.strokeStyle='rgba(255,217,122,.95)';ctx.beginPath();ctx.moveTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.stroke();ctx.lineWidth=1;
}
function drawMini(f,follow){
  mctx.clearRect(0,0,mini.width,mini.height);
  mctx.strokeStyle='rgba(255,255,255,.4)';mctx.strokeRect(1,1,mini.width-2,mini.height-2);
  for(const p of f.players){const m=mapMini(p);
    mctx.fillStyle=(follow&&follow.id===p.id)?'#ffd97a':(p.team==='home'?'#72b6e5':'#ff9999');
    mctx.beginPath();mctx.arc(m.x,m.y,3,0,Math.PI*2);mctx.fill();}
  if(f.ball){const mb=mapMini(f.ball);mctx.fillStyle='#ffd97a';mctx.fillRect(mb.x-2,mb.y-2,4,4);}
}
function drawFrame(play,k){
  const f=play.frames[k];if(!f||!f.ball)return;
  if(k===0)play._autoLosY=f.ball.y;
  f._autoLosY=play._autoLosY;
  let follow=f.ball;
  if(focusTarget){const fp=f.players.find(p=>p.id===focusTarget);if(fp)follow=fp;}
  updateCamera(follow);

  // XY
  ctxXY.clearRect(0,0,cvsXY.width,cvsXY.height);
  ctxXY.fillStyle='#0a4f1a';ctxXY.fillRect(0,0,cvsXY.width,cvsXY.height);
  drawDownDistance(ctxXY,mapXY,f);drawTrails(ctxXY,trailsXY,'#fff');
  f.players.forEach(p=>{
    pushTrail(mapXY,trailsXY,p.id,p);
    const mp=mapXY(p);const col=p.team==='home'?'#72b6e5':'#ff9999';
    ctxXY.strokeStyle=(focusTarget===p.id)?'#ffd97a':col;
    ctxXY.lineWidth=(focusTarget===p.id)?3:1.5;
    ctxXY.beginPath();ctxXY.arc(mp.x,mp.y,4,0,Math.PI*2);ctxXY.stroke();
  });
  const mb=mapXY(f.ball);ctxXY.fillStyle='#ffd97a';ctxXY.beginPath();ctxXY.arc(mb.x,mb.y,4,0,Math.PI*2);ctxXY.fill();

  // 3D
  ctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
  ctx3D.fillStyle='#0c3f16';ctx3D.fillRect(0,0,cvs3D.width,cvs3D.height);
  drawDownDistance(ctx3D,map3D,f);drawTrails(ctx3D,trails3D,'#fff');
  f.players.forEach(p=>{
    pushTrail(map3D,trails3D,p.id,p);
    const mp=map3D(p);ctx3D.fillStyle=p.team==='home'?'#cfe9fb':'#ffd0d0';
    ctx3D.beginPath();ctx3D.arc(mp.x,mp.y,4,0,Math.PI*2);ctx3D.fill();
  });
  const mb3=map3D(f.ball);ctx3D.fillStyle='#ffd97a';ctx3D.beginPath();ctx3D.arc(mb3.x,mb3.y,5,0,Math.PI*2);ctx3D.fill();

  if((k%3)===0){hudXY.textContent=`Play ${playIdx+1}/${plays.length} — Frame ${k+1}/${play.frames.length}`;
                 hud3D.textContent=focusTarget?`Follow: ${focusTarget}`:`Follow: Ball`; }
  if((k%2)===0)drawMini(f,follow);
}
function drawPlay(i){const p=plays[i];if(!p)return;drawFrame(p,frame);}
function stepFrames(n){const p=plays[playIdx];if(!p)return;frame=Math.max(0,Math.min(p.frames.length-1,frame+n));drawPlay(playIdx);}

// ---------- Loop ----------
function loop(t){
  if(!playing||reduceMotion){lastT=t;requestAnimationFrame(loop);return;}
  if(!lastT)lastT=t;let dt=t-lastT;lastT=t;acc+=dt;
  const TICK_MS=1000/FPS;
  while(acc>=TICK_MS){
    const p=plays[playIdx];
    if(p){frame++;if(frame>=p.frames.length){frame=0;playIdx=(playIdx+1)%plays.length;}
      drawPlay(playIdx);}
    acc-=TICK_MS;
  }
  requestAnimationFrame(loop);
}

// ---------- Normalize ----------
function normalizeDataset(d){
  if(!d||!Array.isArray(d.plays))throw new Error('Invalid dataset');
  plays=d.plays;frame=0;playIdx=0;playing=false;
  unitScale=(d.field_cs?.units?.startsWith('m'))?(1/0.9144):1;
  trailsXY.clear();trails3D.clear();lastHolder=null;
  const f0=plays[0]?.frames[0];if(f0?.ball){cam.x=f0.ball.x;cam.y=f0.ball.y;}
  plays.forEach(p=>{
    const allX=p.frames.flatMap(f=>f.players.map(pl=>pl.x));
    const allY=p.frames.flatMap(f=>f.players.map(pl=>pl.y));
    const minX=Math.min(...allX),minY=Math.min(...allY);
    p.frames.forEach(f=>{
      f.players.forEach(pl=>{pl.x-=minX;pl.y-=minY;});
      if(f.ball){f.ball.x-=minX;f.ball.y-=minY;}
    });
  });
  if(hudXY)hudXY.textContent=`Loaded ${plays.length} play(s) — tap ▶`;
  if(hud3D)hud3D.textContent='Follow: Ball';
  sizeAll();drawPlay(0);
}

// ---------- Init ----------
function initLoad(){
  fetch(DATA_URL,{cache:'no-cache'})
  .then(r=>r.json())
  .then(d=>normalizeDataset(d))
  .catch(e=>{hudXY.textContent='Load error: '+e.message;hud3D.textContent='Load error';console.error(e);});
}
sizeAll();
initLoad();
})();
