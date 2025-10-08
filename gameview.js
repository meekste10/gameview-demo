/* gameview.js — Cinematic AR Sandbox edition */
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
let camX=0,camZoom=1.0,trailMap=new Map(),prevFrame=null,fadeAlpha=0;
let shakeMag=0;

// helpers
function map(p){
  const SCALE_X=8*camZoom,SCALE_Y=6*camZoom;
  const ORIGIN_X=(60-camX)*camZoom+(canvas.width*(1-camZoom)/2);
  const ORIGIN_Y=canvas.height/2;
  return{x:ORIGIN_X+p.y*SCALE_X,y:ORIGIN_Y+p.x*SCALE_Y,z:p.z*12*camZoom};
}
function dist(a,b){const dx=a.x-b.x,dy=a.y-b.y;return Math.hypot(dx,dy);}
function drawRing(x,y,r,c,a=1){
  ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=c;ctx.lineWidth=2;
  ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();
}
function drawShadow(x,y,z){
  const blur=Math.max(3,12-z*3);
  ctx.save();
  ctx.fillStyle='rgba(0,0,0,0.25)';
  ctx.filter=`blur(${blur}px)`;
  ctx.beginPath();ctx.ellipse(x,y,6,2,0,0,Math.PI*2);ctx.fill();
  ctx.filter='none';
  ctx.restore();
}
function drawArrow(x,y,dx,dy,color,alpha){
  ctx.save();ctx.globalAlpha=alpha;
  ctx.strokeStyle=color;ctx.lineWidth=1.2;
  ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+dx,y+dy);ctx.stroke();
  ctx.restore();
}

// field
function drawField(){
  ctx.fillStyle='#0a4f1a';ctx.fillRect(0,0,canvas.width,canvas.height);
  const w=canvas.width-120,left=(60-camX)*camZoom;
  ctx.strokeStyle='rgba(255,255,255,.25)';
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
  ctx.strokeStyle='rgba(255,255,255,.5)';
  ctx.strokeRect(left,20,w*camZoom,canvas.height-40);
}

// main draw
function drawFrame(f){
  if(!f)return;
  // camera pan + zoom control
  const targetCamX=f.ball.y*8-60;
  camX+=(targetCamX-camX)*0.08;
  const targetZoom=f.ball.z>0.5?1.12:1.0;
  camZoom+=(targetZoom-camZoom)*0.05;

  // fade in/out
  fadeAlpha=Math.min(1,fadeAlpha+0.03);
  if(frame>f.framesLen-5) fadeAlpha=Math.max(0,fadeAlpha-0.05);

  drawField();

  const ball=map(f.ball);
  drawShadow(ball.x,ball.y,ball.z);

  // trails fade
  ctx.globalAlpha=0.2;
  trailMap.forEach((t)=>{ctx.fillStyle=t.color;ctx.beginPath();ctx.arc(t.x,t.y,2,0,Math.PI*2);ctx.fill();});
  ctx.globalAlpha=1;

  // draw ball
  const grad=ctx.createRadialGradient(ball.x,ball.y-ball.z,0,ball.x,ball.y-ball.z,8);
  grad.addColorStop(0,'#fff6d0');grad.addColorStop(1,'#ffd97a');
  ctx.fillStyle=grad;
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,3*camZoom,0,Math.PI*2);ctx.fill();

  // possession detection
  let holder=null;
  f.players.forEach(p=>{const m=map(p);if(dist(m,ball)<8*camZoom)holder=p.id;});
  if(holder&&holder!==lastHolder&&lastHolder)catchFlash=6;
  if(!holder&&lastHolder&&f.ball.z<0.4)tackleFlash=6;
  lastHolder=holder||lastHolder;

  // determine speed extremes
  let maxSpd=0,fastest=null;
  f.players.forEach(p=>{
    const prev=prevFrame?prevFrame.players.find(pp=>pp.id===p.id):null;
    if(prev){const v=Math.hypot(p.x-prev.x,p.y-prev.y);if(v>maxSpd){maxSpd=v;fastest=p.id;}}
  });

  // draw players
  const newTrail=new Map();
  f.players.forEach(p=>{
    const m=map(p);
    const col=p.team==='home'?'#72b6e5':'#ff9999';
    const prev=prevFrame?prevFrame.players.find(pp=>pp.id===p.id):null;
    const dx=prev?(m.x-map(prev).x):0,dy=prev?(m.y-map(prev).y):0;
    const speed=Math.hypot(dx,dy);
    const aura=fastest===p.id?'rgba(114,182,229,0.4)':'transparent';
    if(aura!=='transparent'){drawRing(m.x,m.y-20,8*camZoom,aura,0.6);}
    drawArrow(m.x,m.y-20,dx*2,dy*2,col,Math.min(1,speed/4));
    ctx.strokeStyle=col;ctx.lineWidth=2*camZoom;
    ctx.beginPath();ctx.moveTo(m.x,m.y-10*camZoom);ctx.lineTo(m.x,m.y-25*camZoom);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30*camZoom,3*camZoom,0,Math.PI*2);ctx.stroke();
    if(holder===p.id){drawRing(m.x,m.y-20*camZoom,10*camZoom,'rgba(255,217,122,0.6)',0.8);}
    newTrail.set(p.id,{x:m.x,y:m.y,color:`rgba(255,255,255,${0.15+speed/6})`});
  });
  trailMap=newTrail;

  // catch flash
  if(catchFlash>0){drawRing(ball.x,ball.y-ball.z,15*camZoom,'rgba(255,255,0,0.8)',catchFlash/6);catchFlash--;}

  // tackle flash + shake
  if(tackleFlash>0){
    const amp=(tackleFlash/6)*5;
    shakeMag=amp;
    drawRing(ball.x,ball.y,25*camZoom,'rgba(255,255,255,0.9)',tackleFlash/6);
    tackleFlash--;
    if(tackleFlash===5)HUD.textContent='TACKLED!';
  }

  // camera shake
  if(shakeMag>0){
    const dx=(Math.random()-0.5)*shakeMag;
    const dy=(Math.random()-0.5)*shakeMag;
    ctx.translate(dx,dy);
    shakeMag*=0.7;
  }

  // fade overlay for cinematic start
  if(fadeAlpha<1){
    ctx.save();ctx.globalAlpha=1-fadeAlpha;ctx.fillStyle='#000';
    ctx.fillRect(0,0,canvas.width,canvas.height);ctx.restore();
  }

  HUD.textContent=`Play ${playIndex+1}/${plays.length} — Holder: ${holder||'None'}`;
  prevFrame=f;
}

// playback
function drawPlay(idx){const p=plays[idx];if(!p)return;drawFrame(p.frames[frame]);}
function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;playIndex=(playIndex+1)%plays.length;
    lastHolder=null;trailMap.clear();fadeAlpha=0;shakeMag=0;
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100);
}
playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

// load
fetch(DATA_URL,{cache:'no-cache'}).then(r=>r.json()).then(d=>{
  plays=d.plays||[];
  HUD.textContent=`Loaded ${plays.length} play(s) — tap ▶`;
  drawField();
}).catch(e=>HUD.textContent='Load error: '+e.message);
})();
