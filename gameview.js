/* gameview.js — Minimal Dual-View Prototype */
(() => {
  const FIELD_LEN_YD = 120;
  const FIELD_WID_YD = 53.333;

  const cvs = document.getElementById('fieldXY');
  const ctx = cvs.getContext('2d');
  const hud = document.getElementById('hudXY');

  let plays = [];
  let frame = 0;
  let playing = false;

  // size canvas properly for DPR
  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = cvs.clientWidth;
    const h = cvs.clientHeight;
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);

  function drawField() {
    const w = cvs.width, h = cvs.height;
    ctx.fillStyle = '#0a4f1a';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    for (let i = 0; i <= 12; i++) {
      const y = h - (i / 12) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeRect(0, 0, w, h);
  }

  function mapX(x) { return (x / FIELD_WID_YD) * cvs.width; }
  function mapY(y) { return cvs.height - (y / FIELD_LEN_YD) * cvs.height; }

  async function loadData() {
    try {
      const res = await fetch('drive_nfltelemetry.json');
      const data = await res.json();
      plays = data.plays;
      hud.textContent = `Loaded ${plays.length} play(s)`;
      drawFrame();
    } catch (e) {
      hud.textContent = 'Error loading data';
      console.error(e);
    }
  }

  function drawFrame() {
    if (!plays.length) return;
    drawField();
    const frameData = plays[0].frames[0];
    const players = frameData.players || [];
    const ball = frameData.ball;

    players.forEach(p => {
      ctx.beginPath();
      ctx.arc(mapX(p.x), mapY(p.y), 5, 0, Math.PI * 2);
      ctx.fillStyle = p.team === 'home' ? '#72b6e5' : '#ff9999';
      ctx.fill();
    });

    if (ball) {
      ctx.beginPath();
      ctx.arc(mapX(ball.x), mapY(ball.y), 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd97a';
      ctx.fill();
    }
  }

  // Buttons
  document.getElementById('play').onclick = () => { playing = true; animate(); };
  document.getElementById('pause').onclick = () => { playing = false; };
  document.getElementById('step').onclick = () => { drawFrame(); };

  function animate() {
    if (!playing) return;
    drawFrame();
    requestAnimationFrame(animate);
  }

  loadData();
})();
