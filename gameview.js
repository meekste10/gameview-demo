/* gameview.js — multi-play sequence viewer */
(()=>{
const DATA_URL = 'https://meekste10.github.io/gameview-demo/drive_realistic_shotgun.json';

const canvas=document.getElementById('field');
const ctx=canvas.getContext('2d');
const HUD=document.getElementById('hud');
const playBtn=document.getElementById('play');
const pauseBtn=document.getElementById('pause');
const stepBtn=document.getElementById('step');

let plays=[],playIndex=0,frame=0,playing=false;

function drawField(){
  ctx.fillStyle='#0a4f1a';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='rgba(255,255,255,.4)';
  for(let i=0;i<=10;i++){
    const x=40+i*((canvas.width-80)/10);
    ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,canvas.height-20);ctx.stroke();
  }
  ctx.strokeRect(40,20,canvas.width-80,canvas.height-40);
}

function map(p){
  // true broadcast view — left→right is upfield, y offset is lateral spread
  const SCALE_X = 8;   // horizontal stretch
  const SCALE_Y = 6;   // vertical compression
  const ORIGIN_X = 60; // left padding
  const ORIGIN_Y = canvas.height/2; // center field vertically
  return {
    x: ORIGIN_X + p.y * SCALE_X,
    y: ORIGIN_Y + p.x * SCALE_Y,  // flip x/y axes for horizontal drive
    z: p.z * 12
  };
}
function drawFrame(f){
  drawField();
  const ball=map(f.ball);
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,3,0,Math.PI*2);ctx.fill();
  f.players.forEach(p=>{
    const m=map(p);
    ctx.strokeStyle=p.team==='home'?'#72b6e5':'#ff9999';
    ctx.beginPath();ctx.moveTo(m.x,m.y-10);ctx.lineTo(m.x,m.y-25);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30,3,0,Math.PI*2);ctx.stroke();
  });
}

function drawPlay(idx){
  const p=plays[idx];
  if(!p)return;
  const f=p.frames[frame];
  drawFrame(f);
  HUD.textContent=`Play ${idx+1}/${plays.length}: ${p.label}`;
}

function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];
  if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;
    playIndex=(playIndex+1)%plays.length; // next play
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100); // 10 fps
}

playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

fetch(DATA_URL,{cache:'no-cache'})
  .then(r=>r.json())
  .then(d=>{
    plays=d.plays||[];
    HUD.textContent=`Loaded ${plays.length} plays — tap ▶`;
    drawField();
  })
  .catch(e=>{HUD.textContent='Load error: '+e.message;});
})();
