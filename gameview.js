/* gameview.js — debug enforced absolute fetch */
(()=>{
const DATA_URL = 'https://meekste10.github.io/gameview-demo/sample_balltrack.json';
console.log('Fetching telemetry from', DATA_URL);

const canvas=document.getElementById('field');
const ctx=canvas.getContext('2d');
const HUD=document.getElementById('hud');
const btnPlay=document.getElementById('play');
const btnPause=document.getElementById('pause');

let telem=null,times=[],t0=0,frame=0,playing=false;

function drawStaticField(){
  ctx.fillStyle='#0a4f1a';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='rgba(255,255,255,.4)';
  for(let i=0;i<=10;i++){
    const x=40+i*((canvas.width-80)/10);
    ctx.beginPath();ctx.moveTo(x,20);ctx.lineTo(x,canvas.height-20);ctx.stroke();
  }
  ctx.strokeRect(40,20,canvas.width-80,canvas.height-40);
}

function map(p){return{x:100+p.x*6,y:180-p.y*6,z:p.z*10}}
function drawFrame(i){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  drawStaticField();
  if(!telem) return;
  const f=telem.frames[i];
  if(!f) return;
  const ball=map(f.ball);
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,3,0,Math.PI*2);ctx.fill();
  f.players.forEach(p=>{
    const m=map(p);
    ctx.strokeStyle=p.team==='home'?'#72b6e5':'#ff9999';
    ctx.beginPath();
    ctx.moveTo(m.x,m.y-10);ctx.lineTo(m.x,m.y-25);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-30,3,0,Math.PI*2);ctx.stroke();
  });
}

function loop(){
  if(!playing) return;
  frame=(frame+1)%times.length;
  drawFrame(frame);
  requestAnimationFrame(loop);
}
btnPlay.onclick=()=>{playing=true;loop();}
btnPause.onclick=()=>{playing=false;}

fetch(DATA_URL,{cache:'no-cache'})
  .then(r=>{
    console.log('Response',r.status);
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
  })
  .then(d=>{
    console.log('Telemetry loaded',d);
    telem=d;
    times=d.frames.map(f=>f.time_s);
    t0=times[0];
    drawFrame(0);
  })
  .catch(e=>{
    HUD.textContent='Error loading telemetry: '+e.message;
    console.error(e);
  });
})();
