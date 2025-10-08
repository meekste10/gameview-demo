/* gameview.js — Analyst Mode (stable camera + layer toggles) */
(()=>{
const DATA_URL='https://meekste10.github.io/gameview-demo/drive_realistic_shotgun.json';

const canvas=document.getElementById('field');
const ctx=canvas.getContext('2d');
const HUD=document.getElementById('hud');
const playBtn=document.getElementById('play');
const pauseBtn=document.getElementById('pause');
const stepBtn=document.getElementById('step');
const showSpeedEl=document.getElementById('showSpeed');
const showPosEl=document.getElementById('showPos');
const showTrailsEl=document.getElementById('showTrails');
const focusSel=document.getElementById('focusPlayer');

let plays=[],playIndex=0,frame=0,playing=false;
let lastHolder=null,catchFlash=0,tackleFlash=0;
let trails=[],trailMap={};
let showSpeed=true,showPos=true,showTrails=true,focusPlayer=null;
let camLock=true;

// toggles
showSpeedEl.onchange=()=>showSpeed=showSpeedEl.checked;
showPosEl.onchange=()=>showPos=showPosEl.checked;
showTrailsEl.onchange=()=>showTrails=showTrailsEl.checked;
focusSel.onchange=()=>focusPlayer=focusSel.value||null;

function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function drawRing(x,y,r,c,a=1){ctx.save();ctx.globalAlpha=a;ctx.strokeStyle=c;ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.stroke();ctx.restore();}

function map(p){
  // top-down perspective (no tilt)
  const SCALE=8;
  const OFFSET_X=80,OFFSET_Y=canvas.height-80;
  return{x:OFFSET_X+p.y*SCALE,y:OFFSET_Y-p.x*SCALE,z:p.z*12};
}

function drawField(){
  ctx.fillStyle='#0a4f1a';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='rgba(255,255,255,0.25)';
  for(let i=0;i<=10;i++){
    const x=80+i*((canvas.width-160)/10);
    ctx.beginPath();ctx.moveTo(x,40);ctx.lineTo(x,canvas.height-40);ctx.stroke();
    if(i>0&&i<10){
      ctx.fillStyle='rgba(255,255,255,0.5)';
      ctx.font='10px system-ui';
      ctx.textAlign='center';
      ctx.fillText(`${i*10}`,x,canvas.height-50);
    }
  }
  ctx.strokeStyle='rgba(255,255,255,.7)';
  ctx.strokeRect(80,40,canvas.width-160,canvas.height-80);
}

function drawTrails(){
  if(!showTrails)return;
  for(const id in trailMap){
    const pts=trailMap[id];
    if(pts.length<2)continue;
    ctx.strokeStyle='rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(pts[0].x,pts[0].y);
    for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
    ctx.stroke();
    if(pts.length>30)pts.shift();
  }
}

function drawFrame(f){
  drawField();

  // build trail cache
  f.players.forEach(p=>{
    const mp=map(p);
    if(!trailMap[p.id])trailMap[p.id]=[];
    trailMap[p.id].push({x:mp.x,y:mp.y});
  });

  drawTrails();

  const ball=map(f.ball);
  ctx.fillStyle='#ffd97a';
  ctx.beginPath();ctx.arc(ball.x,ball.y-ball.z,3,0,Math.PI*2);ctx.fill();

  // detect possession
  let holder=null;
  f.players.forEach(p=>{if(dist(map(p),ball)<8)holder=p.id;});
  if(holder&&holder!==lastHolder&&lastHolder){catchFlash=8;}
  if(!holder&&lastHolder&&f.ball.z<0.5){tackleFlash=10;}
  lastHolder=holder||lastHolder;

  // draw players
  const sorted=[...f.players].sort((a,b)=>a.team.localeCompare(b.team));
  sorted.forEach(p=>{
    const m=map(p);
    const col=p.team==='home'?'#72b6e5':'#ff9999';
    ctx.strokeStyle=focusPlayer===p.id?'#ffd97a':col;
    ctx.lineWidth=focusPlayer===p.id?3:2;
    ctx.beginPath();ctx.moveTo(m.x,m.y-8);ctx.lineTo(m.x,m.y-22);ctx.stroke();
    ctx.beginPath();ctx.arc(m.x,m.y-26,3,0,Math.PI*2);ctx.stroke();
    if(holder===p.id)
      drawRing(m.x,m.y-20,10,'rgba(255,217,122,0.8)',0.8);
  });

  // overlays
  if(showSpeed||showPos){
    ctx.font='bold 10px system-ui';
    ctx.textAlign='center';
    ctx.textBaseline='bottom';
    sorted.forEach(p=>{
      const m=map(p);
      let text='';
      if(showSpeed){
        const spd=Math.hypot(p.vx||0,p.vy||0)*22.37;
        text+=`${spd.toFixed(1)} mph `;
      }
      if(showPos&&p.role)text+=`(${p.role})`;
      ctx.fillStyle='#fff';
      ctx.fillText(text,m.x,m.y-30);
    });
  }

  if(catchFlash>0){drawRing(ball.x,ball.y,18,'rgba(255,255,0,0.8)',catchFlash/8);catchFlash--;}
  if(tackleFlash>0){drawRing(ball.x,ball.y,25,'rgba(255,255,255,0.9)',tackleFlash/10);tackleFlash--;}

  HUD.textContent=`Play ${playIndex+1}/${plays.length} — Holder: ${holder||'None'}`;
}

function drawPlay(i){
  const p=plays[i];
  if(!p)return;
  const f=p.frames[frame];
  drawFrame(f);
}

function nextFrame(){
  if(!playing)return;
  const p=plays[playIndex];if(!p)return;
  frame++;
  if(frame>=p.frames.length){
    frame=0;
    playIndex=(playIndex+1)%plays.length;
    lastHolder=null;
    for(const id in trailMap)trailMap[id]=[];
  }
  drawPlay(playIndex);
  setTimeout(nextFrame,100);
}

playBtn.onclick=()=>{if(plays.length){playing=true;nextFrame();}};
pauseBtn.onclick=()=>playing=false;
stepBtn.onclick=()=>{playing=false;frame++;drawPlay(playIndex);};

fetch(DATA_URL,{cache:'no-cache'})
  .then(r=>r.json())
  .then(d=>{
    plays=d.plays||[];
    HUD.textContent=`Loaded ${plays.length} play(s) — tap ▶`;

    // populate dropdown
    const allPlayers=new Set();
    plays.forEach(p=>p.frames[0]?.players?.forEach(pl=>allPlayers.add(pl.id)));
    focusSel.innerHTML='<option value="">Highlight Player</option>'+
      [...allPlayers].map(id=>`<option value="${id}">${id}</option>`).join('');

    drawField();
  })
  .catch(e=>HUD.textContent='Load error: '+e.message);
})();
