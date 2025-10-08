/* gameview.js — fixed layout + playback */
(()=>{
const q = new URLSearchParams(location.search);
const DATA_URL = q.get('data') || './telemetry_converted.json';
const SEED = (q.get('seed')|0) || 1;
function mulberry32(a){return function(){let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);
t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
const rnd = mulberry32(SEED);

const canvas=document.getElementById('field');
const ctx=canvas.getContext('2d');
const HUD=document.getElementById('hud');
const scrub=document.getElementById('scrub');
const btnPlay=document.getElementById('play');
const btnPause=document.getElementById('pause');
const btnStep=document.getElementById('step');
const chkRM=document.getElementById('rm');

let telem=null,times=[],t0Data=0,tNowStart=0,playing=false,frameIdx=0;
let emaState=new Map(),lastDraw=performance.now(),fpsActual=0;
let reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- resize hook ---
function resize(){
  const dpr=window.devicePixelRatio||1;
  const cssW=canvas.clientWidth||900;
  const cssH=canvas.clientHeight||500;
  canvas.width=cssW*dpr;
  canvas.height=cssH*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  drawStaticField();
  if(telem) drawAtIndex(frameIdx);
}
window.addEventListener('resize',resize);
resize();

function lerp(a,b,t){return a+(b-a)*t}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function binSearch(arr,x){let lo=0,hi=arr.length-1;while(lo<hi){const m=(lo+hi)>>1;(arr[m]<x)?lo=m+1:hi=m;}return lo;}
function ema(prev,curr,a){return prev==null?curr:prev*(1-a)+curr*a}
function dist2(a,b){const dx=a.x-b.x,dy=a.y-b.y,dz=(a.z||0)-(b.z||0);return dx*dx+dy*dy+dz*dz}

function validateSchema(d){
  const ok=d&&d.schema==='gv-telemetry/v1'&&typeof d.fps==='number'&&d.field_cs&&Array.isArray(d.frames)&&d.frames.length>1;
  if(!ok)return{ok:false,why:'Schema header missing/invalid'};
  for(let i=1;i<d.frames.length;i++){
    if(!(d.frames[i].time_s>=d.frames[i-1].time_s)){return{ok:false,why:`time_s not non-decreasing @${i}`}}
    const f=d.frames[i];
    if(!Array.isArray(f.players)||!f.ball)return{ok:false,why:`missing players/ball @${i}`};
  }return{ok:true};
}

// --- draw static field ---
const fieldOS=document.createElement('canvas');
const fctx=fieldOS.getContext('2d');
function drawStaticField(){
  fieldOS.width=canvas.width;fieldOS.height=canvas.height;
  fctx.fillStyle='#0a4f1a';fctx.fillRect(0,0,fieldOS.width,fieldOS.height);
  fctx.strokeStyle='rgba(255,255,255,.25)';fctx.lineWidth=1;
  for(let i=0;i<=10;i++){
    const x=50+i*((fieldOS.width-100)/10);
    fctx.beginPath();fctx.moveTo(x,30);fctx.lineTo(x,fieldOS.height-30);fctx.stroke();
  }
  fctx.strokeStyle='rgba(255,255,255,.6)';
  fctx.strokeRect(50,30,fieldOS.width-100,fieldOS.height-60);
}
drawStaticField();

// --- infer actions ---
const actState=new Map();
function hyst(s,v,lo,hi,a,b){if(s===a&&v>hi)return b;if(s===b&&v<lo)return a;return s;}
function inferAction(id,prev,curr,dt,nearBall){
  const speed=Math.hypot(curr.x-prev.x,curr.y-prev.y)/Math.max(dt,1e-3);
  const dz=(curr.z-prev.z)/Math.max(dt,1e-3);
  const hPrev=Math.atan2(prev.y-(prev._py??prev.y),prev.x-(prev._px??prev.x));
  const hCurr=Math.atan2(curr.y-prev.y,curr.x-prev.x);
  let yaw=Math.abs(hCurr-hPrev)/Math.max(dt,1e-3);if(yaw>Math.PI)yaw=2*Math.PI-yaw;
  const s=actState.get(id)||{state:'idle',conf:0.7};
  let st=s.state;
  st=hyst(st,speed,1.2,3.0,'idle','run');
  st=hyst(st,speed,3.0,6.5,'run','sprint');
  if(dz>1.5)st='jump';
  if(st!=='jump'&&yaw>2.0&&speed>3.0)st='spin';
  if(st==='jump'&&nearBall&&dz<0.2)st='jump_catch';
  const conf=clamp(0.4+0.1*speed+0.15*(st==='jump')+0.15*(st==='spin')-0.1*(yaw<0.5),0,1);
  actState.set(id,{state:st,conf});
  return{state:st,conf};
}

function drawStick(p,act,col){
  ctx.strokeStyle=col;ctx.lineWidth=2;
  const x=p.x,y=p.y-p.z;
  ctx.beginPath();ctx.moveTo(x,y-20);ctx.lineTo(x,y-40);ctx.stroke();
  ctx.beginPath();ctx.arc(x,y-48,6,0,Math.PI*2);ctx.stroke();
  ctx.beginPath();
  if(act==='jump_catch'){ctx.moveTo(x-10,y-34);ctx.lineTo(x+10,y-52);}
  else if(act==='spin'){ctx.moveTo(x-12,y-34);ctx.lineTo(x+12,y-34);}
  else{ctx.moveTo(x-12,y-34);ctx.lineTo(x+12,y-34);}
  ctx.stroke();
  ctx.beginPath();ctx.moveTo(x,y-20);ctx.lineTo(x-8,y);ctx.moveTo(x,y-20);ctx.lineTo(x+8,y);ctx.stroke();
}
function drawBall(b){ctx.fillStyle='#ffd97a';ctx.beginPath();ctx.arc(b.x,b.y-b.z,4,0,Math.PI*2);ctx.fill();}

const SCALE=8,OFFSET={x:100,y:400,zpx:20};
function mapPos(pt){return{x:OFFSET.x+pt.x*SCALE,y:OFFSET.y-pt.y*SCALE,z:clamp(pt.z*OFFSET.zpx,0,60)}}
function snapBallIfCatch(ball,p,s){if(s==='jump'||s==='jump_catch'){const h={x:p.x,y:p.y-52,z:p.z+8};if(Math.sqrt(dist2(ball,h))<12){ball.x=h.x;ball.y=h.y;ball.z=h.z;}}}

function setPlay(v){playing=v;if(v){tNowStart=performance.now();loop();}}
btnPlay.onclick=()=>setPlay(true);
btnPause.onclick=()=>setPlay(false);
btnStep.onclick=()=>{setPlay(false);drawAtIndex(Math.min(frameIdx+1,telem.frames.length-1));};
scrub.oninput=e=>{
  const lastTime=times[times.length-1];
  const t=t0Data+(lastTime-t0Data)*(e.target.value/1000);
  const i=binSearch(times,t);
  drawAtIndex(i);
};
chkRM.onchange=()=>reduceMotion=chkRM.checked;

function loop(){
  if(!playing)return;
  const now=performance.now();
  const dt=now-lastDraw;
  lastDraw=now;fpsActual=lerp(fpsActual,1000/dt,0.1);
  const tElapsed=(now-tNowStart)/1000;
  const tData=t0Data+tElapsed;
  const i=clamp(binSearch(times,tData),0,times.length-1);
  drawAtIndex(i);
  requestAnimationFrame(loop);
}

function drawAtIndex(i){
  frameIdx=i;
  const lastTime=times[times.length-1];
  scrub.value=Math.floor(1000*(times[i]-t0Data)/(lastTime-t0Data));
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(fieldOS,0,0);
  const f=telem.frames[i];
  const dt=i>0?(times[i]-times[i-1]):(1/telem.fps);
  const actors=f.players.map(p=>{
    const M=mapPos(p);
    const prev=emaState.get(p.id)||{};
    const a=0.35;
    const sx=ema(prev.x,M.x,a),sy=ema(prev.y,M.y,a),sz=ema(prev.z,M.z,a);
    emaState.set(p.id,{x:sx,y:sy,z:sz,_px:prev.x,_py:prev.y});
    return{id:p.id,team:p.team||'home',x:sx,y:sy,z:sz,_prev:prev};
  });
  const Mb=mapPos(f.ball);
  const pb=emaState.get('__ball__')||{};
  const bx=ema(pb.x,Mb.x,0.35),by=ema(pb.y,Mb.y,0.35),bz=ema(pb.z,Mb.z,0.35);
  emaState.set('__ball__',{x:bx,y:by,z:bz});
  let ball={x:bx,y:by,z:bz};
  const colors={home:'#e5f2ff',away:'#ffd9d9'};
  const nearIdx=actors.reduce((b,k,idx)=>{const d2=dist2(k,ball);return(d2<b.d2)?{idx,d2}:b;},{idx:0,d2:1e9}).idx;
  const drawList=actors.map((a,idx)=>{
    const prev=a._prev.x!=null?{x:a._prev.x,y:a._prev.y,z:a._prev.z,_px:a._prev._px,_py:a._prev._py}:{x:a.x,y:a.y,z:a.z};
    const nearBall=(idx===nearIdx&&Math.sqrt(dist2(a,ball))<24);
    const {state,conf}=inferAction(a.id,prev,a,Math.max(dt,1e-3),nearBall);
    if(nearBall)snapBallIfCatch(ball,a,state);
    return{...a,act:state,conf};
  });
  drawList.sort((A,B)=>(A.y-A.z)-(B.y-B.z));
  drawList.forEach(p=>drawStick(p,p.act,colors[p.team]||'#fff'));
  drawBall(ball);
  const tPlayback=t0Data+(performance.now()-tNowStart)/1000;
  const latency=Math.abs(tPlayback-f.time_s);
  const led=latency<=2.0?'🟢':latency<=2.5?'🟠':'🔴';
  const avgConf=(drawList.reduce((s,a)=>s+a.conf,0)/Math.max(drawList.length,1)).toFixed(2);
  HUD.innerHTML=`seed=${SEED} · target ${telem.fps} fps · actual ${fpsActual.toFixed(0)} · latency ${led} ${latency.toFixed(2)}s · model_conf ${avgConf}`;
  drawList.forEach(p=>{if(p.conf<0.5){ctx.globalAlpha=0.8;ctx.fillStyle='#72b6e5';ctx.font='10px system-ui';ctx.fillText('projected',p.x+8,p.y-56);ctx.globalAlpha=1;}});
  if(reduceMotion||chkRM.checked)playing=false;
}

fetch(DATA_URL).then(r=>r.json()).then(d=>{
  const v=validateSchema(d);
  if(!v.ok){HUD.textContent=`Schema Error: ${v.why}`;return;}
  telem=d;times=d.frames.map(f=>f.time_s);t0Data=times[0];
  drawAtIndex(0);
  if(!(reduceMotion||chkRM.checked))setPlay(true);
}).catch(e=>{HUD.textContent='Load error: '+e.message;});
})();
