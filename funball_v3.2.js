/* FunBall v3.2 — Dual-View + Auto-Rotate Follow Cam
   • Kaggle + GV schema adapter
   • Top-down: pans & zooms with ball
   • Follow Cam 3D: stable perspective + auto-rotate
   • Safari-safe + GitHub Pages ready
*/
(()=>{
// ---------- Constants ----------
const DEFAULT_DATA = new URLSearchParams(location.search).get('data')
  || (document.getElementById('datasetSel')?.value || 'drive_nfltelemetry.json');

const FPS_DEFAULT = 10;
const FIELD_LEN_YD = 100;
const FIELD_WID_YD = 53.333;
const PAD = { x: 10, y: 10 };

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

// cameras
const cam2d = { x:0, y:FIELD_LEN_YD/2, zoom:1 };
const cam3d = { x:0, y:FIELD_LEN_YD/2, zoom:1, rot:0 };

// trails
let trailXY=[], trail3D=[];
const TRAIL_MAX_XY=48, TRAIL_MAX_3D=64;

// Offscreen buffers
let bufXY=null, bxy=null, buf3D=null, b3d=null;

// ---------- Helpers ----------
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const map=(v,in0,in1,out0,out1)=>out0+(out1-out0)*((v-in0)/(in1-in0));
function frameDt(i){if(i<=0)return 1/fps;const t0=frames[i-1]?.t??((i-1)/fps),t1=frames[i]?.t??(i/fps);return Math.max(1e-6,t1-t0);}
function sizeCanvas(c){const dpr=window.devicePixelRatio||1;const cssW=c.clientWidth||c.width;const cssH=c.clientHeight||c.height;c.width=Math.round(cssW*dpr);c.height=Math.round(cssH*dpr);const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);}
function resizeAll(){[cvXY,cv3D].forEach(sizeCanvas);
  if(typeof OffscreenCanvas==='function'){bufXY=new OffscreenCanvas(cvXY.width,cvXY.height);buf3D=new OffscreenCanvas(cv3D.width,cv3D.height);}
  else{bufXY=document.createElement('canvas');buf3D=document.createElement('canvas');bufXY.width=cvXY.width;bufXY.height=cvXY.height;buf3D.width=cv3D.width;buf3D.height=cv3D.height;}
  bxy=bufXY.getContext('2d');b3d=buf3D.getContext('2d');
  drawStatic();drawFrame(k,true);}
new ResizeObserver(resizeAll).observe(cvXY);
new ResizeObserver(resizeAll).observe(cv3D);

// ---------- Adapter ----------
function normalizeDataset(raw){
  let rawFrames=[];
  if(Array.isArray(raw?.plays)&&raw.plays.length&&Array.isArray(raw.plays[0].frames)) rawFrames=raw.plays[0].frames;
  else if(Array.isArray(raw?.frames)) rawFrames=raw.frames;
  else throw new Error('No frames found (expected plays[0].frames or frames[])');

  fps=Number(raw?.fps)||FPS_DEFAULT;tickMS=1000/fps;
  let units='yards';try{
    if(raw.field_cs&&raw.field_cs.units)units=raw.field_cs.units;
    else if(raw.units)units=raw.units;
  }catch(e){units='yards';}
  unitScale=String(units).toLowerCase().startsWith('m')?(1/0.9144):1;

  // detect axis
  const samp=rawFrames.slice(0,Math.min(20,rawFrames.length));
  const mins={x:+Infinity,y:+Infinity},maxs={x:-Infinity,y:-Infinity};
  for(const f of samp){const pts=[];if(f.ball)pts.push(f.ball);if(Array.isArray(f.players))pts.push(...f.players);
    for(const p of pts){if(typeof p.x==='number'){mins.x=Math.min(mins.x,p.x);maxs.x=Math.max(maxs.x,p.x);}
                        if(typeof p.y==='number'){mins.y=Math.min(mins.y,p.y);maxs.y=Math.max(maxs.y,p.y);}}}
  axis=(maxs.x-mins.x>maxs.y-mins.y)?{length:'x',lateral:'y'}:{length:'y',lateral:'x'};

  const nf=rawFrames.map((f,i)=>{
    const t=(typeof f.time_s==='number')?f.time_s:i*(1/fps);
    const bx=toWorldLateral(f.ball?.[axis.lateral]??0);
    const by=toWorldForward(f.ball?.[axis.length]??0);
    const bz=toYd(f.ball?.z||0);
    const players=Array.isArray(f.players)?f.players.map(p=>({
      id:String(p.id??''),team:String(p.team??''),x:toWorldLateral(p?.[axis.lateral]??0),
      y:toWorldForward(p?.[axis.length]??0),z:toYd(p?.z||0)})):[];
    return{t,ball:{x:bx,y:by,z:bz},players};
  });
  if(nf.length){cam2d.x=nf[0].ball.x;cam2d.y=nf[0].ball.y;cam3d.x=nf[0].ball.x;cam3d.y=nf[0].ball.y;}
  return nf;
  function toYd(v){return(typeof v==='number'?v:0)*unitScale;}
  function toWorldForward(v){return clamp(toYd(v),0,FIELD_LEN_YD);}
  function toWorldLateral(v){const yd=toYd(v);return clamp(yd-FIELD_WID_YD/2,-FIELD_WID_YD/2,FIELD_WID_YD/2);}
}

// ---------- Top-down mapping ----------
function worldToXY(pt){
  const halfW=FIELD_WID_YD/2,halfL=FIELD_LEN_YD/2;
  const w=cvXY.width/(window.devicePixelRatio||1),h=cvXY.height/(window.devicePixelRatio||1);
  const scale=Math.min(w/FIELD_WID_YD,h/FIELD_LEN_YD)*cam2d.zoom;
  const dx=(pt.x-cam2d.x)*scale,dy=(pt.y-cam2d.y)*scale;
  return{x:w/2+dx,y:h/2-dy};
}

// ---------- 3D Projection (fixed + auto-rotate) ----------
let BASE_D=1.8,BASE_L=1.4,Z_PX=20,TILT=0.6;
function refresh3DConstants(){
  const H=cv3D.height/(window.devicePixelRatio||1),W=cv3D.width/(window.devicePixelRatio||1);
  BASE_D=clamp(W/40,1.5,3.0);
  BASE_L=clamp(H/50,1.2,2.4);
  Z_PX=clamp(H/20,12,28);
  TILT=clamp(H/W,0.50,0.70);
}

function map3D_worldToCanvas(p){
  const horizonX=(cv3D.width/(window.devicePixelRatio||1))*0.5;
  const horizonY=(cv3D.height/(window.devicePixelRatio||1))*0.5;
  const scaleD=BASE_D*cam3d.zoom;
  const scaleL=BASE_L*cam3d.zoom;

  // rotation about vertical axis based on cam3d.rot
  const cosR=Math.cos(cam3d.rot),sinR=Math.sin(cam3d.rot);
  const relX=p.x-cam3d.x, relY=p.y-cam3d.y;
  const rx=relX*cosR - relY*sinR;
  const ry=relX*sinR + relY*cosR;

  const x=horizonX + ry*scaleD;
  const y=horizonY + rx*scaleL*TILT - p.z*Z_PX;
  return{x,y};
}

// ---------- Field Background ----------
function drawStatic(){
  bxy.clearRect(0,0,bufXY.width,bufXY.height);
  const ctx=bxy;const cssW=cvXY.width/(window.devicePixelRatio||1),cssH=cvXY.height/(window.devicePixelRatio||1);
  ctx.save();ctx.scale(window.devicePixelRatio||1,window.devicePixelRatio||1);
  ctx.fillStyle='#0b4a18';ctx.fillRect(0,0,cssW,cssH);
  ctx.strokeStyle='rgba(255,255,255,.25)';
  for(let y=0;y<=FIELD_LEN_YD;y+=10){const yy=(y/FIELD_LEN_YD)*cssH;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(cssW,yy);ctx.stroke();}
  ctx.restore();
  b3d.clearRect(0,0,buf3D.width,buf3D.height);
  const g=b3d.createLinearGradient(0,0,0,buf3D.height);
  g.addColorStop(0,'#0c3f16');g.addColorStop(1,'#0a3513');
  b3d.fillStyle=g;b3d.fillRect(0,0,buf3D.width,buf3D.height);
}

// ---------- Playback ----------
function step(n=1){if(!frames.length)return;k=Math.max(0,Math.min(frames.length-1,k+n));drawFrame(k);}
function loop(t){if(!playing){lastT=t;requestAnimationFrame(loop);return;}if(!lastT)lastT=t;let dt=t-lastT;lastT=t;acc+=dt;while(acc>=tickMS){step(1);acc-=tickMS;}requestAnimationFrame(loop);}

// ---------- Draw ----------
function drawFrame(i){
  if(!frames.length)return;
  const f=frames[i];
  const dt=frameDt(i);
  const v=(i>0)?Math.hypot(f.ball.x-frames[i-1].ball.x,f.ball.y-frames[i-1].ball.y)/dt:0;

  // --- 2D camera follow ---
  cam2d.x=lerp(cam2d.x,f.ball.x,0.2);
  cam2d.y=lerp(cam2d.y,f.ball.y,0.2);
  cam2d.zoom=lerp(cam2d.zoom,map(clamp(v,0,12),0,12,1.1,0.85),0.1);

  // --- draw XY ---
  cxXY.clearRect(0,0,cvXY.width,cvXY.height);
  cxXY.drawImage(bufXY,0,0);
  const mBallXY=worldToXY(f.ball);
  cxXY.fillStyle='#ffd97a';
  cxXY.beginPath();cxXY.arc(mBallXY.x,mBallXY.y- f.ball.z*cam2d.zoom*0.12,4,0,Math.PI*2);cxXY.fill();
  trailXY.push({x:mBallXY.x,y:mBallXY.y});if(trailXY.length>TRAIL_MAX_XY)trailXY.shift();
  cxXY.strokeStyle='rgba(255,255,255,.3)';cxXY.beginPath();for(let j=0;j<trailXY.length;j++){const p=trailXY[j];if(j===0)cxXY.moveTo(p.x,p.y);else cxXY.lineTo(p.x,p.y);}cxXY.stroke();
  if(f.players?.length){const near=f.players.map(p=>({p,d:Math.hypot(p.x-f.ball.x,p.y-f.ball.y)})).sort((a,b)=>a.d-b.d).slice(0,6);
    for(const {p} of near){const m=worldToXY(p);cxXY.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';cxXY.lineWidth=2;cxXY.beginPath();cxXY.moveTo(m.x,m.y-7);cxXY.lineTo(m.x,m.y-18);cxXY.stroke();cxXY.beginPath();cxXY.arc(m.x,m.y-22,3,0,Math.PI*2);cxXY.stroke();}}
  hudXY.textContent=`Frame ${i+1}/${frames.length} • Ball y=${f.ball.y.toFixed(1)} x=${f.ball.x.toFixed(1)} • Zoom=${cam2d.zoom.toFixed(2)} • v≈${v.toFixed(1)}yd/s`;

  // --- 3D follow cam ---
  refresh3DConstants();
  cx3D.clearRect(0,0,cv3D.width,cv3D.height);
  cx3D.drawImage(buf3D,0,0);
  cam3d.y=lerp(cam3d.y,clamp(f.ball.y-8,0,FIELD_LEN_YD),0.15);
  cam3d.x=lerp(cam3d.x,clamp(f.ball.x,-FIELD_WID_YD/2,FIELD_WID_YD/2),0.15);
  cam3d.zoom=lerp(cam3d.zoom,map(clamp(v,0,14),0,14,1.05,0.85),0.08);
  cam3d.rot=lerp(cam3d.rot,clamp(f.ball.x/30,-0.3,0.3),0.1); // auto-rotate by lateral motion

  const plist=(f.players||[]).slice().sort((a,b)=>a.y-b.y);
  const cssScale3=(window.devicePixelRatio||1);
  cx3D.save();cx3D.scale(cssScale3,cssScale3);
  plist.forEach(p=>{
    const m=map3D_worldToCanvas(p);
    cx3D.fillStyle='rgba(0,0,0,.25)';
    cx3D.beginPath();cx3D.ellipse(m.x,m.y+7,8,2.6,0,0,Math.PI*2);cx3D.fill();
    cx3D.strokeStyle=(p.team==='home')?'#cfe9fb':'#ffd0d0';
    cx3D.lineWidth=1.8;
    cx3D.beginPath();cx3D.moveTo(m.x,m.y-10);cx3D.lineTo(m.x,m.y-24);cx3D.stroke();
    cx3D.beginPath();cx3D.arc(m.x,m.y-28,3,0,Math.PI*2);cx3D.stroke();
  });
  const mb=map3D_worldToCanvas(f.ball);
  cx3D.fillStyle='#ffd97a';cx3D.beginPath();cx3D.arc(mb.x,mb.y,5,0,Math.PI*2);cx3D.fill();
  trail3D.push({x:f.ball.x,y:f.ball.y,z:f.ball.z});if(trail3D.length>TRAIL_MAX_3D)trail3D.shift();
  for(let j=1;j<trail3D.length;j++){const a=trail3D[j-1],b=trail3D[j];const ma=map3D_worldToCanvas(a),mbp=map3D_worldToCanvas(b);
    const alpha=j/trail3D.length;cx3D.strokeStyle=`rgba(255,255,255,${0.1*alpha})`;cx3D.lineWidth=2;cx3D.beginPath();cx3D.moveTo(ma.x,ma.y);cx3D.lineTo(mbp.x,mbp.y);cx3D.stroke();}
  cx3D.restore();
  hud3D.textContent=`Follow: Ball • Cam y≈${cam3d.y.toFixed(1)} x≈${cam3d.x.toFixed(1)} • zoom=${cam3d.zoom.toFixed(2)} rot=${cam3d.rot.toFixed(2)} • v≈${v.toFixed(1)}yd/s`;
}

// ---------- Load ----------
function loadJSON(url){
  hudXY.textContent='⏳ Loading…';hud3D.textContent='⏳ Loading…';playing=false;k=0;trailXY.length=0;trail3D.length=0;
  fetch(url,{cache:'no-cache'}).then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();})
  .then(raw=>{frames=normalizeDataset(raw);if(!frames.length)throw new Error('No frames after normalization');resizeAll();
    hudXY.textContent=`✅ Loaded ${frames.length} frames @ ${fps}fps — tap ▶`;hud3D.textContent='Follow: Ball';drawFrame(0);})
  .catch(err=>{console.error(err);hudXY.textContent=`❌ ${err.message}`;hud3D.textContent=`❌ ${err.message}`;});
}

// ---------- UI ----------
btnPlay&&(btnPlay.onclick=()=>{if(frames.length){playing=true;requestAnimationFrame(loop);}});
btnPause&&(btnPause.onclick=()=>playing=false);
btnStep&&(btnStep.onclick=()=>{playing=false;step(1);});
if(dsSel)dsSel.value=DATA_URL;
reloadBtn&&(reloadBtn.onclick=()=>{DATA_URL=dsSel?.value||DEFAULT_DATA;loadJSON(DATA_URL);});
window.addEventListener('keydown',e=>{
  if(e.code==='Space'){e.preventDefault();playing=!playing;if(playing)requestAnimationFrame(loop);}
  else if(e.code==='ArrowRight'){e.preventDefault();playing=false;step(1);}
});

// ---------- Init ----------
resizeAll();loadJSON(DATA_URL);
})();
