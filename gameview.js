/* gameview.js — Live Broadcast HUD Edition */
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
let lineOfScrimmage=50,down=1,yardsToGo=10,gameClock=900;
let banner=null,bannerTimer=0;

function map(p){
  const SCALE_X=8*camZoom,SCALE_Y=6*camZoom;
  const ORIGIN_X=(60-camX)*camZoom+(canvas.width*(1-camZoom)/2);
  const ORIGIN_Y=canvas.height/2;
  return{x:ORIGIN_X+p.y*SCALE_X,y:ORIGIN_Y+p.x*SCALE_Y,z:p.z*12*camZoom};
}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function drawRing(x,y,r,c,a=1){ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();}
function drawShadow(x,y){ctx.save();ctx.fillStyle='rgba(0,0,0,0.3)';ctx.filter='blur(6px)';ctx.beginPath();ctx.ellipse(x,y,8,2,0,0,Math.PI*2);ctx.fill();ctx.filter='none';ctx.restore();}

function drawField(){
  ctx.fillStyle='#0a4f1a';ctx.fillRect(0,0,canvas.width,canvas.height);
  const w=canvas.width-120,left=(60-camX)*camZoom;
  ctx.strokeStyle='rgba(255,255,255,.25)';
  ctx.textAlign='center';ctx.textBaseline='top';ctx.font=`${10*camZoom}px system-ui`;
  for(let i=0;i<=10;i++){
    const x=left+i*(w/10)*camZoom;
    ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,canvas.height-20);ctx.stroke();
    if(i>0&&i<10){const yard=(i<=5?i*10:100-i*10);ctx.fillStyle='rgba(255,255,255,.6)';ctx.fillText(yard,x,canvas.height/2-6);}
  }
  ctx.strokeStyle='rgba(255,255,255,.7)';ctx.strokeRect(left,20,w*camZoom,canvas.height-40);

  // LOS + 1st down line
  const losX=left+(lineOfScrimmage/10)*(w/10)*camZoom;
  const fdX=left+((lineOfScrimmage+yardsToGo)/10)*(w/10)*camZoom;
  ctx.strokeStyle='rgba(0,150,255,.6)';ctx.beginPath();ctx.moveTo(losX,25);ctx.lineTo(losX,canvas.height-25);ctx.stroke();
  ctx.strokeStyle='rgba(255,255,0,.5)';ctx.beginPath();ctx.moveTo(fdX,25);ctx.lineTo(fdX,canvas.height-25);ctx.stroke();
}

function drawBanner(){
  if(!bannerTimer||!banner)return;
  ctx.save();
  ctx.globalAlpha=Math.min(1,bannerTimer/10);
  ctx.fillStyle='rgba(0,0,0,0.7)';
  ctx.fillRect(canvas.width/2-100,30,200,28);
  ctx.fillStyle='#ffd97a';
  ctx.font='bold 14px system-ui';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(banner,canvas.width/2,44);
  ctx.restore();
  if(bannerTimer>0)bannerTimer--;
  if(bannerTimer===0)banner=null;
}

function drawFrame(f){
  if(!f)return;
  const targetCamX=f.ball.y*8-60;camX+=0.08*(targetCamX-camX);
  const targetZoom=f.ball.z>0.5?1.05:1.0;camZoom+=0.05*(targetZoom-camZoom);

  drawField();
  const ball=map(f.ball);
  drawShadow(ball.x,ball.y);

  // ball glow
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,4*camZoom,0,Math.PI*2);ctx.fill();

  // possession
  let holder=null;
  f.players.forEach(p=>{if(dist(map(p),ball)<8*camZoom)holder=p.id;});
  if(holder&&holder!==lastHolder&&lastHolder){catchFlash=8;}
  if(!holder&&lastHolder&&f.ball.z<0.4){tackleFlash=8;banner='TACKLED!';bannerTimer=60;}
  lastHolder=holder||lastHolder;

  // player render
  const newTrail=new Map();
  f.players.forEach(p=>{
    const prev=prevFrame?prevFrame.players.find(pp=>pp.id===p.id):null;
    const m=map(p);
    const col=p.team==='home'?'#72b6e5':'#ff9999';
    const dx=prev?(p.x-prev.x):0,dy=prev?(p.y-prev.y):0;
    const spd=Math.hypot(dx,dy)*22.37; // mph
    // bright trail
    const key=p.id;
    const old=trailMap.get(key);
    newTrail.set(key,{x:m.x,y:m.y,color:col,life:5});
    trailMap.forEach((t,id)=>{
      if(t.life>0){ctx.globalAlpha=t.life/5;ctx.strokeStyle=t.color;ctx.lineWidth=2;
        ctx.beginPath();ctx.arc(t.x,t.y,2,0,Math.PI*2);ctx.stroke();t.life-=1;}
    });
    ctx.globalAlpha=1;
    // player
    ctx.strokeStyle=col;ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(m.x,m.y-10);ctx.lineTo(m.x,m.y-25);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30,3,0,Math.PI*2);ctx.stroke();
    if(holder===p.id)drawRing(m.x,m.y-20,10,'rgba(255,217,122,0.6)',0.8);
    // speed tag
    ctx.font='10px system-ui';ctx.textAlign='center';ctx.fillStyle='#fff';
    ctx.fillText(`${spd.toFixed(1)} mph`,m.x,m.y-40);
  });
  trailMap=newTrail;

  // events
  if(catchFlash>0){drawRing(ball.x,ball.y-ball.z,18,'rgba(255,255,0,0.9)',catchFlash/8);catchFlash--;}
  if(tackleFlash>0){drawRing(ball.x,ball.y,28,'rgba(255,255,255,0.9)',tackleFlash/8);tackleFlash--;}

  drawBanner();
  // scoreboard HUD
  ctx.save();
  ctx.fillStyle='rgba(0,0,0,0.6)';
  ctx.fillRect(10,10,180,30);
  ctx.fillStyle='#ffd97a';
  ctx.font='12px system-ui';
  ctx.fillText(`Down ${down} • ${yardsToGo} yds • Ball on ${lineOfScrimmage}`,20,30);
  ctx.textAlign='right';
  ctx.fillText(`Clock: ${(gameClock/60|0)}:${(gameClock%60).toString().padStart(2,'0')}`,180,30);
  ctx.restore();

  HUD.textContent=`Play ${playIndex+1}/${plays.length} — Holder: ${holder||'None'}`;
  prevFrame=f;
}

function drawPlay(i){const p=plays[i];if(!p)return;drawFrame(p.frames[frame]);}
function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;playIndex=(playIndex+1)%plays.length;
    lastHolder=null;trailMap.clear();prevFrame=null;
    // simple randomize for next play
    lineOfScrimmage=Math.min(90,Math.max(10,lineOfScrimmage+Math.round(Math.random()*8-2)));
    down=(down%4)+1;
    yardsToGo=Math.round(5+Math.random()*5);
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100);
}
playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

fetch(DATA_URL,{cache:'no-cache'}).then(r=>r.json()).then(d=>{
  plays=d.plays||[];
  HUD.textContent=`Loaded ${plays.length} play(s) — tap ▶`;
  drawField();
}).catch(e=>HUD.textContent='Load error: '+e.message);
})();
