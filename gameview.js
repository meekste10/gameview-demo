/* gameview.js — Minimal working viewer */
(() => {
  const FIELD_LEN_YD = 120, FIELD_WID_YD = 53.333;
  const cvs = document.getElementById("fieldXY");
  const ctx = cvs.getContext("2d");
  const hud = document.getElementById("hudXY");

  let plays = [];

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth, h = cvs.clientHeight;
    cvs.width = w * dpr; cvs.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas(); window.addEventListener("resize", sizeCanvas);

  function drawField() {
    ctx.fillStyle = "#0a4f1a"; ctx.fillRect(0, 0, cvs.width, cvs.height);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    for (let i = 0; i <= 12; i++) {
      const y = cvs.height - (i / 12) * cvs.height;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cvs.width, y); ctx.stroke();
    }
  }

  function mapX(x){ return (x/FIELD_WID_YD)*cvs.width; }
  function mapY(y){ return cvs.height - (y/FIELD_LEN_YD)*cvs.height; }

  async function loadData(){
    try {
      const r = await fetch("drive_nfltelemetry.json");
      const data = await r.json();
      plays = data.plays;
      hud.textContent = `Loaded ${plays.length} play(s)`;
      drawFrame();
    } catch(err){
      hud.textContent = "Failed to load dataset";
      console.error(err);
    }
  }

  function drawFrame(){
    if(!plays.length) return;
    drawField();
    const f = plays[0].frames[0];
    (f.players||[]).forEach(p=>{
      ctx.beginPath();
      ctx.arc(mapX(p.x), mapY(p.y), 6, 0, Math.PI*2);
      ctx.fillStyle = p.team==="home" ? "#72b6e5" : "#ff8888";
      ctx.fill();
    });
    if(f.ball){
      ctx.beginPath();
      ctx.arc(mapX(f.ball.x), mapY(f.ball.y), 8, 0, Math.PI*2);
      ctx.fillStyle="#ffd97a"; ctx.fill();
    }
  }

  document.getElementById("play").onclick = ()=>{ drawFrame(); };
  document.getElementById("pause").onclick = ()=>{};
  document.getElementById("step").onclick = ()=>{ drawFrame(); };

  loadData();
})();
