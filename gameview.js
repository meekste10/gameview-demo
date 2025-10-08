/* gameview.js — full version with camera follow, trails, and event effects */
(()=>{
const DATA_URL = 'https://meekste10.github.io/gameview-demo/drive_realistic_shotgun.json';

const canvas = document.getElementById('field');
const ctx = canvas.getContext('2d');
const HUD = document.getElementById('hud');
const playBtn = document.getElementById('play');
const pauseBtn = document.getElementById('pause');
const stepBtn = document.getElementById('step');

let plays = [], playIndex = 0, frame = 0, playing = false;
let lastHolder = null, catchFlash = 0, tackleFlash = 0;
let camX = 0;
let trailMap = new Map();

// --- coordinate map (broadcast view) ---
function map(p) {
  const SCALE_X = 8, SCALE_Y = 6;
  const ORIGIN_X = 60 - camX;
  const ORIGIN_Y = canvas.height / 2;
  return { x: ORIGIN_X + p.y * SCALE_X, y: ORIGIN_Y + p.x * SCALE_Y, z: p.z * 12 };
}

// --- field background + yard numbers ---
function drawField() {
  ctx.fillStyle = '#0a4f1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width - 120;
  const left = 60 - camX;
  ctx.strokeStyle = 'rgba(255,255,255,.3)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '10px system-ui';

  for (let i = 0; i <= 10; i++) {
    const x = left + i * (w / 10);
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, canvas.height - 20); ctx.stroke();

    if (i > 0 && i < 10) {
      const yard = (i <= 5 ? i * 10 : 100 - i * 10);
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      ctx.fillText(String(yard), x, canvas.height / 2 - 6);
    }
  }
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.strokeRect(left, 20, w, canvas.height - 40);
}

// --- helpers ---
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.hypot(dx, dy);
}
function drawRing(x, y, r, color, a = 1) {
  ctx.save();
  ctx.globalAlpha = a;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// --- main draw ---
function drawFrame(f) {
  // smooth camera follow on ball's y
  const targetCamX = f.ball.y * 8 - 60;
  camX += (targetCamX - camX) * 0.08;

  drawField();

  const ball = map(f.ball);

  // faint trail for ball
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#ffd97a';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y - ball.z, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // actual ball
  ctx.fillStyle = '#ffd97a';
  ctx.beginPath();
  ctx.arc(ball.x, ball.y - ball.z, 3, 0, Math.PI * 2);
  ctx.fill();

  let holder = null;

  // detect possession
  f.players.forEach(p => {
    const m = map(p);
    if (dist(m, ball) < 8) holder = p.id;
  });

  // detect events
  if (holder && holder !== lastHolder && lastHolder) catchFlash = 6;
  if (!holder && lastHolder && f.ball.z < 0.5) tackleFlash = 6;
  lastHolder = holder || lastHolder;

  // --- player trails ---
  ctx.globalAlpha = 0.25;
  trailMap.forEach((t, id) => {
    ctx.fillStyle = t.color;
    ctx.beginPath();
    ctx.arc(t.x, t.y, 2, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // --- draw players ---
  const newTrail = new Map();
  f.players.forEach(p => {
    const m = map(p);
    const col = p.team === 'home' ? '#72b6e5' : '#ff9999';

    // trail intensity scales with motion
    const prev = trailMap.get(p.id);
    const spd = prev ? Math.hypot(m.x - prev.x, m.y - prev.y) : 0;
    const trailColor = p.team === 'home'
      ? `rgba(114,182,229,${Math.min(0.6, spd / 5)})`
      : `rgba(255,153,153,${Math.min(0.6, spd / 5)})`;
    newTrail.set(p.id, { x: m.x, y: m.y, color: trailColor });

    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(m.x, m.y - 10); ctx.lineTo(m.x, m.y - 25); ctx.stroke();
    ctx.beginPath(); ctx.arc(m.x, m.y - 30, 3, 0, Math.PI * 2); ctx.stroke();

    // possession glow
    if (holder === p.id) {
      drawRing(m.x, m.y - 20, 10, 'rgba(255,217,122,0.6)', 0.7);
    }
  });
  trailMap = newTrail;

  // --- catch flash ---
  if (catchFlash > 0) {
    drawRing(ball.x, ball.y - ball.z, 15, 'rgba(255,255,0,0.8)', catchFlash / 6);
    catchFlash--;
  }

  // --- tackle flash ---
  if (tackleFlash > 0) {
    drawRing(ball.x, ball.y, 22, 'rgba(255,255,255,0.8)', tackleFlash / 6);
    tackleFlash--;
    if (tackleFlash === 5) HUD.textContent = 'TACKLED!';
  }

  // HUD info
  HUD.textContent = `Play ${playIndex + 1}/${plays.length} — Holder: ${holder || 'None'}`;
}

// --- playback ---
function drawPlay(idx) {
  const p = plays[idx];
  if (!p) return;
  const f = p.frames[frame];
  drawFrame(f);
}

function nextFrame() {
  if (!playing) return;
  const p = plays[playIndex];
  if (!p) return;
  frame++;
  if (frame >= p.frames.length) {
    frame = 0;
    playIndex = (playIndex + 1) % plays.length;
    lastHolder = null;
    trailMap.clear();
  }
  drawPlay(playIndex);
  setTimeout(nextFrame, 100);
}

playBtn.onclick = () => { if (plays.length) { playing = true; nextFrame(); } };
pauseBtn.onclick = () => playing = false;
stepBtn.onclick = () => { playing = false; frame++; drawPlay(playIndex); };

// --- load data ---
fetch(DATA_URL, { cache: 'no-cache' })
  .then(r => r.json())
  .then(d => {
    plays = d.plays || [];
    HUD.textContent = `Loaded ${plays.length} play(s) — tap ▶`;
    drawField();
  })
  .catch(e => { HUD.textContent = 'Load error: ' + e.message; });
})();
