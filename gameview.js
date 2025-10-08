/* gameview.js — Dynamic Broadcast View */
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
let camX=0,camZoom=1.0,trailPoints=[];
let banner=null,bannerTimer=0;
let lineOfScrimmage=50,down=1,yardsToGo=10,gameClock=900;

// --- broadcast projection (adds slight tilt + depth scaling)
function map(p){
  const tilt=0.35; // vertical compression factor
  const SCALE_X=8*camZoom,SCALE_Y=6*camZoom*tilt;
  const ORIGIN_X=(60-camX)*camZoom+(canvas.width*(1-camZoom)/2);
  const ORIGIN_Y=canvas.height/2 + (p.y*tilt*0.5);
  const depth=(1-p.y/60); // depth factor for fade/scale
  return{
    x:ORIGIN_X+p.y*SCALE_X,
    y:ORIGIN_Y+p.x*SCALE_Y,
    z:p.z*10*camZoom,
    depth:depth
  };
}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function drawRing(x,y,r,c,a=1){ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();}
function drawShadow(x,y,d){ctx.save();ctx.globalAlpha=0.2+0.2*d;ctx.fillStyle='#000';ctx.beginPath();ctx.ellipse(x,y,10*d,3*d,0,0,Math.PI*2);ctx.fill();ctx.restore();}

function drawField(){
  ctx.fillStyle='#0a4f1a';ctx.fillRect(0,0,canvas.width,canvas.height);
  const w=canvas.width-120,left=(60-camX)*camZoom;
  ctx.strokeStyle='rgba(255,255,255,.2)';
  ctx.textAlign='center';ctx.textBaseline='top';ctx.font=`${10*camZoom}px system-ui`;
  for(let i=0;i<=10;i++){
    const x=left+i*(w/10)*camZoom;
    ctx.beginPath();ctx.moveTo(x,30);ctx.lineTo(x,canvas.height-30);ctx.stroke();
    if(i>0&&i<10){
      const yard=(i<=5?i*10:100-i*10);
      ctx.fillStyle='rgba(255,255,255,.5)';
      ctx.fillText(yard,x,canvas.height/2-6);
    }
  }
  // LOS + 1st down lines
  const losX=left+(lineOfScrimmage/10)*(w/10)*camZoom;
  const fdX=left+((lineOfScrimmage+yardsToGo)/10)*(w/10)*camZoom;
  ctx.strokeStyle='rgba(0,150,255,.5)';ctx.beginPath();ctx.moveTo(losX,40);ctx.lineTo(losX,canvas.height-40);ctx.stroke();
  ctx.strokeStyle='rgba(255,255,0,.4)';ctx.beginPath();ctx.moveTo(fdX,40);ctx.lineTo(fdX,canvas.height-40);ctx.stroke();
}

function drawBanner(){
  if(!bannerTimer||!banner)return;
  ctx.save();
  const a=Math.min(1,bannerTimer/15);
  ctx.globalAlpha=a;
  ctx.fillStyle='rgba(0,0,0,0.7)';
  ctx.fillRect(canvas.width/2-110,35,220,32);
  ctx.fillStyle='#ffd97a';
  ctx.font='bold 16px system-ui';
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillText(banner,canvas.width/2,51);
  ctx.restore();
  bannerTimer--;
  if(bannerTimer<=0)banner=null;
}

function drawFrame(f){
  if(!f)return;
  const targetCamX=f.ball.y*8-60;camX+=(targetCamX-camX)*0.08;
  const targetZoom=f.ball.z>0.5?1.05:1.0;camZoom+=(targetZoom-camZoom)*0.05;

  drawField();

  // draw trails first
  for(let i=0;i<trailPoints.length;i++){
    const t=trailPoints[i];
    ctx.globalAlpha=t.life/10;
    ctx.strokeStyle=t.color;
    ctx.beginPath();ctx.arc(t.x,t.y,2,0,Math.PI*2);ctx.stroke();
    t.life-=1;
  }
  trailPoints=trailPoints.filter(t=>t.life>0);
  ctx.globalAlpha=1;

  const ball=map(f.ball);
  drawShadow(ball.x,ball.y,1);
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,4,0,Math.PI*2);ctx.fill();

  // possession + events
  let holder=null;
  f.players.forEach(p=>{if(dist(map(p),ball)<8*camZoom)holder=p.id;});
  if(holder&&holder!==lastHolder&&lastHolder){catchFlash=10;}
  if(!holder&&lastHolder&&f.ball.z<0.4){tackleFlash=10;banner='TACKLED!';bannerTimer=80;}
  lastHolder=holder||lastHolder;

  // draw players (sorted by depth for pseudo-3D)
  const sorted=[...f.players].sort((a,b)=>map(b).depth-map(a).depth);
  sorted.forEach(p=>{
    const m=map(p);
    const col=p.team==='home'?'#72b6e5':'#ff9999';
    const scale=0.6+0.5*m.depth;
    drawShadow(m.x,m.y,m.depth);
    ctx.strokeStyle=col;ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(m.x,m.y-10*scale);ctx.lineTo(m.x,m.y-25*scale);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30*scale,3*scale,0,Math.PI*2);ctx.stroke();
    if(holder===p.id)drawRing(m.x,m.y-20*scale,10*scale,'rgba(255,217,122,0.8)',1);
    trailPoints.push({x:m.x,y:m.y,color:col,life:8});
  });

  // label pass — offset labels dynamically to avoid overlap
  const usedSpots=[];
  ctx.save();
  ctx.globalAlpha=0.95;
  ctx.font='bold 11px system-ui';
  ctx.fillStyle='#fff';
  ctx.textAlign='center';
  sorted.forEach(p=>{
    const m=map(p);
    let lx=m.x,ly=m.y-40*m.depth;
    // avoid overlap
    for(let u of usedSpots){if(Math.abs(u.x-lx)<20 && Math.abs(u.y-ly)<12){ly-=14;}}
    usedSpots.push({x:lx,y:ly});
    const spd=Math.hypot(p.vx||0,p.vy||0)*22.37||Math.random()*10+10;
    ctx.fillText(`${spd.toFixed(1)} mph`,lx,ly);
  });
  ctx.restore();

  if(catchFlash>0){drawRing(ball.x,ball.y-ball.z,20,'rgba(255,255,0,0.9)',catchFlash/10);catchFlash--;}
  if(tackleFlash>0){drawRing(ball.x,ball.y,30,'rgba(255,255,255,0.9)',tackleFlash/10);tackleFlash--;}
  drawBanner();

  // scoreboard
  ctx.save();
  ctx.fillStyle='rgba(0,0,0,0.65)';
  ctx.fillRect(10,10,210,32);
  ctx.fillStyle='#ffd97a';
  ctx.font='13px system-ui';
  ctx.textAlign='left';
  ctx.fillText(`Down ${down} • ${yardsToGo} yds • Ball ${lineOfScrimmage}`,20,32);
  ctx.textAlign='right';
  ctx.fillText(`Clock ${(gameClock/60|0)}:${(gameClock%60).toString().padStart(2,'0')}`,210,32);
  ctx.restore();

  HUD.textContent=`Play ${playIndex+1}/${plays.length} — Holder: ${holder||'None'}`;
}

function drawPlay(i){const p=plays[i];if(!p)return;drawFrame(p.frames[frame]);}
function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;playIndex=(playIndex+1)%plays.length;
    lastHolder=null;trailPoints=[];banner=null;
    lineOfScrimmage=Math.min(90,Math.max(10,lineOfScrimmage+Math.round(Math.random()*8-2)));
    down=(down%4)+1;yardsToGo=Math.round(5+Math.random()*5);
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100);
}
playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

fetch(DATA_URL,{cache:'no-cache'})
  .then(r=>r.json())
  .then(d=>{plays=d.plays||[];HUD.textContent=`Loaded ${plays.length} play(s) — tap ▶`;drawField();})
  .catch(e=>HUD.textContent='Load error: '+e.message);
})();
