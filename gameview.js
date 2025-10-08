/* gameview.js — mobile-friendly working version */
(()=>{
const q = new URLSearchParams(location.search);
const DATA_URL = q.get('data') || 'https://meekste10.github.io/gameview-demo/sample_balltrack.json';
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

// --- responsive DPR setup ---
function resize(){
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 360;
  const cssH = canvas.clientHeight || 200;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  drawStaticField();
  if(telem) drawAtIndex(frameIdx);
}
window.addEventListener('resize',resize);
resize();

// --- utilities ---
function lerp(a,b,t){return a+(b-a)*t}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function binSearch(arr,x){let lo=0,hi=arr.length-1;while(lo<hi){const m=(lo+hi)>>1;(arr[m]<x)?lo=m+1:hi=m;}return lo;}
function ema(prev,curr,a){return prev==null?curr:prev*(1-a)+curr*a}
function dist2(a,b){const dx=a.x-b.x,dy=a.y-b.y,dz=(a.z||0)-(b.z||0);return dx*dx+dy*dy+dz*dz}

// --- schema check ---
function validateSchema(d){
  const ok=d&&d.schema==='gv-telemetry/v1'&&typeof d.fps==='number'&&Array.isArray(d.frames);
  if(!ok)return{ok:false,why:'Schema invalid'};
  return{ok:true};
}

// --- draw static field ---
const fieldOS=document.createElement('canvas');
const fctx=fieldOS.getContext('2d');
function drawStaticField(){
  fieldOS.width=canvas.width;fieldOS.height=canvas.height;
  fctx.fillStyle='#0a4f1a';fctx.fillRect(0,0,fieldOS.width,fieldOS.height);
  fctx.strokeStyle='rgba(255,255,255,.25)';
  for(let i=0;i<=10;i++){
    const x=40+i*((fieldOS.width-80)/10);
    fctx.beginPath();fctx.moveTo(x,20);fctx.lineTo(x,fieldOS.height-20);fctx.stroke();
  }
  fctx.strokeStyle='rgba(255,255,255,.6)';
  fctx.strokeRect(40,20,fieldOS.width-80,fieldOS.height-40);
}
drawStaticField();

// --- inference + drawing ---
const actState=new Map();
function hyst(s,v,lo,hi,a,b){if(s===a&&v>hi)return b;if(s===b&&v<lo)return a;return s;}
function inferAction(id,prev,curr,dt,nearBall){
  const speed=Math.hypot(curr.x-prev.x,curr.y-prev.y)/Math.max(dt,1e-3);
  const dz=(curr.z-prev.z)/Math.max(dt,1e-3);
  const s=actState.get(id)||{state:'idle',conf:0.7};
  let st=s.state;
  st=hyst(st,speed,1.2,3.0,'idle','run');
  if(dz>1.5)st='jump';
  if(st==='jump'&&nearBall&&dz<0.2)st='jump_catch';
  const conf=clamp(0.4+0.1*speed+0.2*(st==='jump')-0.1*(dz<0.2),0,1);
  actState.set(id,{state:st,conf});
  return{state:st,conf};
}
function drawStick(p,act,col){
  ctx.strokeStyle=col;ctx.lineWidth=2;
  const x=p.x,y=p.y-p.z;
  ctx.beginPath();ctx.moveTo(x,y-10);ctx.lineTo(x,y-25);ctx.stroke();
  ctx.beginPath();ctx.arc(x,y-30,3,0,Math.PI*2);ctx.stroke();
  if(act==='jump_catch'){ctx.beginPath();ctx.moveTo(x-5,y-20);ctx.lineTo(x+5,y-30);ctx.stroke();}
}
function drawBall(b){ctx.fillStyle='#ffd97a';ctx.beginPath();ctx.arc(b.x,b.y-b.z,2.5,0,Math.PI*2);ctx.fill();}
const SCALE=6,OFFSET={x:80,y:180,zpx:12};
function mapPos(pt){return{x:OFFSET.x+pt.x*SCALE,y:OFFSET.y-pt.y*SCALE,z:clamp(pt.z*OFFSET.zpx,0,30)}}

// --- controls ---
function setPlay(v){playing=v;if(v){tNowStart=performance.now();loop();}}
btnPlay.onclick=()=>setPlay(true);
btnPause.onclick=()=>setPlay(false);
btnStep.onclick=()=>{setPlay(false);drawAtIndex(Math.min(frameIdx+1,telem.frames.length-1));};
chkRM.onchange=()=>reduceMotion=chkRM.checked;

function loop(){
  if(!playing)return;
  const now=performance.now();
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
  const actors=f.players.map(p=>{
    const M=mapPos(p);
    const prev=emaState.get(p.id)||{};
    const a=0.35;
    const sx=ema(prev.x,M.x,a),sy=ema(prev.y,M.y,a),sz=ema(prev.z,M.z,a);
    emaState.set(p.id,{x:sx,y:sy,z:sz});
    return{id:p.id,team:p.team||'home',x:sx,y:sy,z:sz,_prev:prev};
  });
  const Mb=mapPos(f.ball);
  const pb=emaState.get('__ball__')||{};
  const bx=ema(pb.x,Mb.x,0.35),by=ema(pb.y,Mb.y,0.35),bz=ema(pb.z,Mb.z,0.35);
  emaState.set('__ball__',{x:bx,y:by,z:bz});
  let ball={x:bx,y:by,z:bz};
  const colors={home:'#e5f2ff',away:'#ffd9d9'};
  const nearIdx=0;
  actors.forEach((a,idx)=>{
    const prev=a._prev.x!=null?{x:a._prev.x,y:a._prev.y,z:a._prev.z}:{x:a.x,y:a.y,z:a.z};
    const nearBall=(idx===nearIdx&&Math.sqrt(dist2(a,ball))<24);
    const {state,conf}=inferAction(a.id,prev,a,0.05,nearBall);
    drawStick(a,state,colors[a.team]||'#fff');
  });
  drawBall(ball);
  const tPlayback=t0Data+(performance.now()-tNowStart)/1000;
  const latency=Math.abs(tPlayback-f.time_s);
  const led=latency<=2.0?'🟢':latency<=2.5?'🟠':'🔴';
  HUD.innerHTML=`seed=${SEED} · latency ${led} ${latency.toFixed(2)}s`;
}

// --- data load ---
fetch(DATA_URL,{cache:'force-cache'}).then(r=>r.json()).then(d=>{
  const v=validateSchema(d);if(!v.ok){HUD.textContent=v.why;return;}
  telem=d;times=d.frames.map(f=>f.time_s);t0Data=times[0];
  drawAtIndex(0);
  if(!(reduceMotion||chkRM.checked))setPlay(true);
}).catch(e=>{HUD.textContent='Load error: '+e.message;});
})();
