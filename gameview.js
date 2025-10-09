/* gameview.js — Dual-View (XY + Z follow, mini-map, LOS/1D) — NFL Telemetry Edition */
(()=>{
// ---------- Config ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data') || 'drive_realistic_shotgun.json';
const FPS = 10;  // frames per second
const FIELD_WIDTH_YD = 53.333;
const FIELD_LENGTH_YD = 120; // include endzones
const PAD = {x:60,y:30};
let unitScale = 1; // for meters->yards

// ---------- DOM ----------
const cvsXY=document.getElementById('fieldXY'),ctxXY=cvsXY.getContext('2d');
const cvs3D=document.getElementById('field3D'),ctx3D=cvs3D.getContext('2d');
const mini=document.getElementById('mini'),mctx=mini.getContext('2d');
const hudXY=document.getElementById('hudXY'),hud3D=document.getElementById('hud3D');
const btnPlay=document.getElementById('play'),btnPause=document.getElementById('pause'),btnStep=document.getElementById('step');
const showSpeedEl=document.getElementById('showSpeed'),showPosEl=document.getElementById('showPos'),
      showTrailsEl=document.getElementById('showTrails'),autoCamEl=document.getElementById('autoCam'),
      losOnEl=document.getElementById('losOn'),fxOnEl=document.getElementById('effectsOn');
const focusSel=document.getElementById('focusPlayer');
const losYEl=document.getElementById('losY'),togoEl=document.getElementById('togo'),applyDDEl=document.getElementById('applyDD');
const dsSel=document.getElementById('datasetSel'),reloadBtn=document.getElementById('reload');
const fileInput=document.getElementById('fileInput');

// ---------- State ----------
let DATA_URL=DEFAULT_DATA,plays=[],playIdx=0,frame=0,playing=false;
let showSpeed=true,showPos=true,showTrails=true,autoCam=true,losOn=true,effectsOn=true;
let reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let focusTarget=null,trailsXY=new Map(),trails3D=new Map();
let lastHolder=null,catchFlash=0,tackleFlash=0,losY_auto=null,togoY=10;
let cam={x:0,y:50,z:6},scaleXY=1;
let lastT=0,acc=0;

// ---------- UI Bindings ----------
showSpeedEl.onchange=()=>showSpeed=showSpeedEl.checked;
showPosEl.onchange=()=>showPos=showPosEl.checked;
showTrailsEl.onchange=()=>showTrails=showTrailsEl.checked;
autoCamEl.onchange=()=>autoCam=autoCamEl.checked;
losOnEl.onchange=()=>losOn=losOnEl.checked;
fxOnEl.onchange=()=>effectsOn=fxOnEl.checked;
focusSel.onchange=()=>focusTarget=focusSel.value||null;

applyDDEl.onclick=()=>{
 const vLos=parseFloat(losYEl.value),vTgo=parseFloat(togoEl.value);
 if(!Number.isNaN(vLos))losY_auto=vLos;
 if(!Number.isNaN(vTgo))togoY=vTgo;
};

reloadBtn.onclick=()=>{DATA_URL=dsSel.value||DEFAULT_DATA;initLoad(true);};
btnPlay.onclick=()=>{if(plays.length){playing=true;requestAnimationFrame(loop);}};
btnPause.onclick=()=>playing=false;
btnStep.onclick=()=>{playing=false;stepFrames(1);};

// local file load (mobile friendly)
fileInput.onchange=e=>{
 const f=e.target.files[0]; if(!f)return;
 const r=new FileReader();
 r.onload=ev=>{loadFromJSON(ev.target.result,f.name);};
 r.readAsText(f);
};

// ---------- Helpers ----------
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function toYd(v){return v*unitScale;}
function mph(p){const vx=toYd(p.vx||0),vy=toYd(p.vy||0);return (Math.hypot(vx,vy)*FPS*0.9144*2.236936).toFixed(1);}
function ring(ctx,pos,r){ctx.beginPath();ctx.arc(pos.x,pos.y,r,0,Math.PI*2);ctx.stroke();}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}

// ---------- Camera ----------
function updateCamera(target){
 if(!autoCam)return;
 if(!target)return;
 cam.x+=(target.x-cam.x)*0.15;
 cam.y+=(target.y-cam.y)*0.15;
}

// ---------- Mapping ----------
function mapXY(p){
 const wp={x:toYd(p.x-cam.x),y:toYd(p.y-cam.y)};
 const w=cvsXY.width,h=cvsXY.height;
 return {x:w/2+wp.x*scaleXY,y:h/2-wp.y*scaleXY,z:p.z||0};
}
function map3D(p){
 const wp={x:toYd(p.x-cam.x),y:toYd(p.y-cam.y),z:p.z||0};
 const baseX=cvs3D.width/2+wp.x*scaleXY*8;
 const baseY=cvs3D.height*0.7-wp.y*scaleXY*8;
 return {x:baseX,y:baseY-wp.z*15,z:wp.z};
}
function mapMini(p){
 const w=mini.width,h=mini.height;
 return {x:clamp(p.x/FIELD_LENGTH_YD,0,1)*w,y:h-clamp(p.y/FIELD_WIDTH_YD,0,1)*h};
}

// ---------- Trails ----------
function pushTrail(mapper,store,id,p){
 if(!showTrails)return;
 const s=store.get(id)||[];
 const m=mapper(p);
 s.push({x:m.x,y:m.y});
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
 });
 ctx.globalAlpha=1;
}

// ---------- Drawing ----------
function drawDownDistance(ctx,f){
 if(!losOn)return;
 const yLos=(losY_auto??f._autoLosY)||0;
 const yFd=yLos+togoY;
 const a=mapXY({x:-FIELD_WIDTH_YD/2,y:yLos});
 const b=mapXY({x:FIELD_WIDTH_YD/2,y:yLos});
 const c=mapXY({x:-FIELD_WIDTH_YD/2,y:yFd});
 const d=mapXY({x:FIELD_WIDTH_YD/2,y:yFd});
 ctx.strokeStyle='rgba(114,182,229,.9)';ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();
 ctx.strokeStyle='rgba(255,217,122,.9)';ctx.beginPath();ctx.moveTo(c.x,c.y);ctx.lineTo(d.x,d.y);ctx.stroke();
}

function drawMini(f,follow){
 mctx.clearRect(0,0,mini.width,mini.height);
 mctx.strokeStyle='rgba(255,255,255,.3)';
 mctx.strokeRect(0,0,mini.width,mini.height);
 for(const p of f.players){
  const m=mapMini(p);
  mctx.fillStyle=(focusTarget===p.id)?'#ffd97a':(p.team==='home'?'#72b6e5':'#ff9999');
  mctx.beginPath();mctx.arc(m.x,m.y,3,0,Math.PI*2);mctx.fill();
 }
 const b=mapMini(f.ball);mctx.fillStyle='#ffd97a';mctx.fillRect(b.x-2,b.y-2,4,4);
 if(follow){const mf=mapMini(follow);mctx.strokeStyle='#ffd97a';ring(mctx,mf,8);}
}

function drawFrame(play,k){
 const f=play.frames[k]; if(!f)return;
 if(k===0)play._autoLosY=f.ball.y;
 updateCamera(f.ball);

 // XY
 ctxXY.clearRect(0,0,cvsXY.width,cvsXY.height);
 drawDownDistance(ctxXY,f);
 drawTrails(ctxXY,trailsXY,'#fff');
 f.players.forEach(p=>{
  pushTrail(mapXY,trailsXY,p.id,p);
  const mp=mapXY(p);
  ctxXY.strokeStyle=(focusTarget===p.id)?'#ffd97a':(p.team==='home'?'#72b6e5':'#ff9999');
  ctxXY.lineWidth=(focusTarget===p.id)?3:2;
  ctxXY.beginPath();ctxXY.arc(mp.x,mp.y,4,0,Math.PI*2);ctxXY.stroke();
 });
 const mb=mapXY(f.ball);
 ctxXY.fillStyle='#ffd97a';ctxXY.beginPath();ctxXY.arc(mb.x,mb.y-5,4,0,Math.PI*2);ctxXY.fill();

 // 3D
 ctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
 drawDownDistance(ctx3D,f);
 drawTrails(ctx3D,trails3D,'#fff');
 const sorted=[...f.players].sort((a,b)=>a.y-b.y);
 for(const p of sorted){
  pushTrail(map3D,trails3D,p.id,p);
  const mp=map3D(p);
  ctx3D.strokeStyle=(focusTarget===p.id)?'#ffd97a':(p.team==='home'?'#cfe9fb':'#ffd0d0');
  ctx3D.beginPath();ctx3D.moveTo(mp.x,mp.y);ctx3D.lineTo(mp.x,mp.y-15);ctx3D.stroke();
  ctx3D.beginPath();ctx3D.arc(mp.x,mp.y-20,3,0,Math.PI*2);ctx3D.stroke();
 }
 const mb3=map3D(f.ball);
 ctx3D.fillStyle='#ffd97a';ctx3D.beginPath();ctx3D.arc(mb3.x,mb3.y,5,0,Math.PI*2);ctx3D.fill();

 drawMini(f,f.ball);
 if(hudXY&&(k%3===0))hudXY.textContent=`Play ${playIdx+1}/${plays.length} Frame ${k+1}/${play.frames.length}`;
 if(hud3D&&(k%3===0))hud3D.textContent=`Follow: ${focusTarget||'Ball'}`;
}

// ---------- Loop ----------
function stepFrames(n){
 const p=plays[playIdx]; if(!p)return;
 frame=Math.max(0,Math.min(p.frames.length-1,frame+n));
 drawFrame(p,frame);
}
function loop(t){
 if(!playing||reduceMotion){lastT=t;requestAnimationFrame(loop);return;}
 if(!lastT)lastT=t;
 let dt=t-lastT; lastT=t; acc+=dt;
 while(acc>=1000/FPS){
  const p=plays[playIdx];
  if(p){
   frame++;
   if(frame>=p.frames.length){frame=0;playIdx=(playIdx+1)%plays.length;trailsXY.clear();trails3D.clear();}
   drawFrame(p,frame);
  }
  acc-=1000/FPS;
 }
 requestAnimationFrame(loop);
}

// ---------- Load ----------
function loadFromJSON(text,name="inline"){
 try{
  const d=JSON.parse(text);
  normalizeDataset(d);
  sizeAndRedraw();
  hudXY.textContent=`Loaded ${d.plays.length} play(s) from ${name}`;
 }catch(e){hudXY.textContent="Load error "+e.message;}
}

function normalizeDataset(d){
 if(!d||!Array.isArray(d.plays))throw new Error("Invalid dataset");
 plays=d.plays; frame=0; playIdx=0; playing=false;
 unitScale=(d.field_cs?.units?.startsWith('m'))?(1/0.9144):1;
 trailsXY.clear();trails3D.clear();lastHolder=null;
 // auto-scale to field extent
 const allX=plays.flatMap(p=>p.frames.flatMap(f=>f.players.map(pl=>pl.x)));
 const allY=plays.flatMap(p=>p.frames.flatMap(f=>f.players.map(pl=>pl.y)));
 const dx=Math.max(...allX)-Math.min(...allX);
 scaleXY=(cvsXY.width/(dx*10))||0.8;
}

function initLoad(isReload=false){
 playing=false;frame=0;playIdx=0;
 fetch(DATA_URL,{cache:'no-cache'}).then(r=>{
  if(!r.ok)throw new Error("HTTP "+r.status);
  return r.text();
 }).then(txt=>{
  loadFromJSON(txt,DATA_URL);
 }).catch(e=>{
  hudXY.textContent="Load error: "+e.message;
  hud3D.textContent="Load error: "+e.message;
 });
}

// ---------- Setup ----------
function sizeCanvas(c){
 const dpr=window.devicePixelRatio||1;
 const w=c.clientWidth,h=c.clientHeight;
 c.width=w*dpr;c.height=h*dpr;
 c.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}
function sizeAndRedraw(){
 [cvsXY,cvs3D,mini].forEach(sizeCanvas);
 drawFrame(plays[playIdx]||{frames:[]},frame);
}
window.addEventListener('resize',sizeAndRedraw);

// ---------- Kick ----------
sizeAndRedraw();
initLoad(false);
})();
