/* gameview.js — Broadcast Overlay Edition */
(()=>{
const DATA_URL='https://meekste10.github.io/gameview-demo/drive_realistic_shotgun.json';

const canvas=document.getElementById('field');
const ctx=canvas.getContext('2d');
const HUD=document.getElementById('hud');
const playBtn=document.getElementById('play');
const pauseBtn=document.getElementById('pause');
const stepBtn=document.getElementById('step');

let plays=[],playIndex=0,frame=0,playing=false;
let lastHolder=null,catchFlash=0,tackleFlash=0;
let camX=0,camZoom=1.0,trailMap=new Map(),prevFrame=null;

// --- map to screen ---
function map(p){
  const SCALE_X=8*camZoom,SCALE_Y=6*camZoom;
  const ORIGIN_X=(60-camX)*camZoom+(canvas.width*(1-camZoom)/2);
  const ORIGIN_Y=canvas.height/2;
  return{x:ORIGIN_X+p.y*SCALE_X,y:ORIGIN_Y+p.x*SCALE_Y,z:p.z*12*camZoom};
}

// --- draw helpers ---
function drawRing(x,y,r,c,a=1){ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();}
function drawShadow(x,y,z){ctx.save();ctx.fillStyle='rgba(0,0,0,0.3)';ctx.filter='blur(6px)';ctx.beginPath();ctx.ellipse(x,y,7,2,0,0,Math.PI*2);ctx.fill();ctx.filter='none';ctx.restore();}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function lerp(a,b,t){return a+(b-a)*t;}

// --- field ---
function drawField(){
  ctx.fillStyle='#0a4f1a';ctx.fillRect(0,0,canvas.width,canvas.height);
  const w=canvas.width-120,left=(60-camX)*camZoom;
  ctx.strokeStyle='rgba(255,255,255,.3)';
  ctx.textAlign='center';ctx.textBaseline='top';ctx.font=`${10*camZoom}px system-ui`;
  for(let i=0;i<=10;i++){
    const x=left+i*(w/10)*camZoom;
    ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,canvas.height-20);ctx.stroke();
    if(i>0&&i<10){
      const yard=(i<=5?i*10:100-i*10);
      ctx.fillStyle='rgba(255,255,255,.6)';
      ctx.fillText(String(yard),x,canvas.height/2-6);
    }
  }
  ctx.strokeStyle='rgba(255,255,255,.7)';
  ctx.strokeRect(left,20,w*camZoom,canvas.height-40);
}

// --- main frame ---
function drawFrame(f){
  if(!f)return;
  // smooth camera
  const targetCamX=f.ball.y*8-60;camX+=0.08*(targetCamX-camX);
  const targetZoom=f.ball.z>0.5?1.1:1.0;camZoom+=0.05*(targetZoom-camZoom);

  drawField();
  const ball=map(f.ball);
  drawShadow(ball.x,ball.y,ball.z);

  // draw ball
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,4*camZoom,0,Math.PI*2);ctx.fill();

  // possession
  let holder=null;
  f.players.forEach(p=>{if(dist(map(p),ball)<8*camZoom)holder=p.id;});
  if(holder&&holder!==lastHolder&&lastHolder)catchFlash=8;
  if(!holder&&lastHolder&&f.ball.z<0.4)tackleFlash=8;
  lastHolder=holder||lastHolder;

  // speed calc + trail fade
  const newTrail=new Map();
  f.players.forEach(p=>{
    const prev=prevFrame?prevFrame.players.find(pp=>pp.id===p.id):null;
    const m=map(p);
    const col=p.team==='home'?'#72b6e5':'#ff9999';
    const dx=prev?(p.x-prev.x):0,dy=prev?(p.y-prev.y):0;
    const spd=Math.hypot(dx,dy)*22.37; // m/frame → mph
    const spdColor=`rgba(255,255,255,${Math.min(0.6,spd/25)})`;
    newTrail.set(p.id,{x:m.x,y:m.y,color:spdColor,life:3});
    // trails
    trailMap.forEach((t,id)=>{
      if(t.life>0){ctx.globalAlpha=t.life/3;ctx.fillStyle=t.color;
        ctx.beginPath();ctx.arc(t.x,t.y,2,0,Math.PI*2);ctx.fill();
        t.life-=1;}
    });
    ctx.globalAlpha=1;

    // draw player
    ctx.strokeStyle=col;ctx.lineWidth=2*camZoom;
    ctx.beginPath();ctx.moveTo(m.x,m.y-10*camZoom);ctx.lineTo(m.x,m.y-25*camZoom);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30*camZoom,3*camZoom,0,Math.PI*2);ctx.stroke();
    // possession glow
    if(holder===p.id){drawRing(m.x,m.y-20*camZoom,10*camZoom,'rgba(255,217,122,0.6)',0.8);}
    // velocity line (longer + brighter)
    if(prev){ctx.strokeStyle='rgba(255,255,255,0.5)';ctx.lineWidth=1.2;
      ctx.beginPath();ctx.moveTo(m.x,m.y-20*camZoom);
      ctx.lineTo(m.x+dx*20,m.y-dy*20);ctx.stroke();}
    // floating overlay
    ctx.font=`${9*camZoom}px system-ui`;ctx.textAlign='center';
    ctx.fillStyle='#fff';
    const label=`${p.team[0].toUpperCase()}${p.role||''}`;
    ctx.fillText(`${label}  ${spd.toFixed(1)} mph`,m.x,m.y-40*camZoom);
  });
  trailMap=newTrail;

  // catch flash
  if(catchFlash>0){drawRing(ball.x,ball.y-ball.z,18*camZoom,'rgba(255,255,0,0.9)',catchFlash/8);catchFlash--;}
  // tackle flash
  if(tackleFlash>0){drawRing(ball.x,ball.y,28*camZoom,'rgba(255,255,255,0.9)',tackleFlash/8);tackleFlash--;}

  HUD.textContent=`Play ${playIndex+1}/${plays.length} — Holder: ${holder||'None'}`;
  prevFrame=f;
}

// --- playback ---
function drawPlay(i){const p=plays[i];if(!p)return;drawFrame(p.frames[frame]);}
function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;playIndex=(playIndex+1)%plays.length;
    lastHolder=null;trailMap.clear();prevFrame=null;
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100);
}
playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

// --- load data ---
fetch(DATA_URL,{cache:'no-cache'}).then(r=>r.json()).then(d=>{
  plays=d.plays||[];
  HUD.textContent=`Loaded ${plays.length} play(s) — tap ▶`;
  drawField();
}).catch(e=>HUD.textContent='Load error: '+e.message);
})();
