/* gameview.js — GameView Dual-View Minimal Working Telemetry */
(()=>{
  console.log("GameView Loaded");

  // ---------- Constants ----------
  const DATA_URL = "drive_nfltelemetry.json";
  const FIELD_LENGTH_YD = 120;
  const FIELD_WIDTH_YD  = 53.333;
  const FPS = 10;
  const TICK_MS = 1000 / FPS;

  // ---------- DOM ----------
  const cvsXY = document.getElementById("fieldXY");
  const ctxXY = cvsXY.getContext("2d");
  const cvs3D = document.getElementById("field3D");
  const ctx3D = cvs3D.getContext("2d");
  const hudXY = document.getElementById("hudXY");
  const hud3D = document.getElementById("hud3D");
  const mini  = document.getElementById("mini");
  const mctx  = mini.getContext("2d");
  const btnPlay = document.getElementById("play");
  const btnPause = document.getElementById("pause");
  const btnStep = document.getElementById("step");

  // ---------- State ----------
  let plays = [];
  let playIdx = 0;
  let frame = 0;
  let playing = false;
  let lastT = 0;
  let acc = 0;

  // ---------- Helpers ----------
  function sizeCanvas(c) {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 960;
    const h = c.clientHeight || 540;
    c.width = w * dpr;
    c.height = h * dpr;
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function mapXY(x, y, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const px = (x / FIELD_WIDTH_YD) * w;
    const py = h - (y / FIELD_LENGTH_YD) * h;
    return { x: px, y: py };
  }

  function drawField(ctx, canvas) {
    ctx.fillStyle = "#0a4f1a";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    for (let y = 0; y <= 120; y += 10) {
      const yy = canvas.height - (y / FIELD_LENGTH_YD) * canvas.height;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(canvas.width, yy);
      ctx.stroke();
    }
  }

  // ---------- Draw ----------
  function drawFrame(play, k) {
    const f = play.frames[k];
    const ball = f.ball;
    const players = f.players;

    drawField(ctxXY, cvsXY);
    drawField(ctx3D, cvs3D);

    // XY (top-down)
    for (const p of players) {
      const m = mapXY(p.x, p.y, cvsXY);
      ctxXY.fillStyle = p.team === "home" ? "#72b6e5" : "#ff9999";
      ctxXY.beginPath();
      ctxXY.arc(m.x, m.y, 6, 0, Math.PI * 2);
      ctxXY.fill();
    }
    const mb = mapXY(ball.x, ball.y, cvsXY);
    ctxXY.fillStyle = "#ffd97a";
    ctxXY.beginPath();
    ctxXY.arc(mb.x, mb.y, 5, 0, Math.PI * 2);
    ctxXY.fill();

    // 3D (simple side projection)
    for (const p of players) {
      const mx = (p.y / FIELD_LENGTH_YD) * cvs3D.width;
      const my = cvs3D.height - (p.x / FIELD_WIDTH_YD) * cvs3D.height;
      ctx3D.fillStyle = p.team === "home" ? "#72b6e5" : "#ff9999";
      ctx3D.beginPath();
      ctx3D.arc(mx, my, 6, 0, Math.PI * 2);
      ctx3D.fill();
    }
    const mb3 = { x: (ball.y / FIELD_LENGTH_YD) * cvs3D.width, y: cvs3D.height - (ball.x / FIELD_WIDTH_YD) * cvs3D.height };
    ctx3D.fillStyle = "#ffd97a";
    ctx3D.beginPath();
    ctx3D.arc(mb3.x, mb3.y, 5, 0, Math.PI * 2);
    ctx3D.fill();

    // Mini-map
    mctx.clearRect(0, 0, mini.width, mini.height);
    for (const p of players) {
      const mmx = (p.y / FIELD_LENGTH_YD) * mini.width;
      const mmy = mini.height - (p.x / FIELD_WIDTH_YD) * mini.height;
      mctx.fillStyle = p.team === "home" ? "#72b6e5" : "#ff9999";
      mctx.fillRect(mmx - 2, mmy - 2, 4, 4);
    }

    hudXY.textContent = `Frame ${k + 1}/${play.frames.length}`;
    hud3D.textContent = `Players: ${players.length}`;
  }

  // ---------- Loop ----------
  function loop(t) {
    if (!playing) { lastT = t; requestAnimationFrame(loop); return; }
    if (!lastT) lastT = t;
    let dt = t - lastT; lastT = t;
    acc += dt;
    while (acc >= TICK_MS) {
      const p = plays[playIdx];
      if (p) {
        frame = (frame + 1) % p.frames.length;
        drawFrame(p, frame);
      }
      acc -= TICK_MS;
    }
    requestAnimationFrame(loop);
  }

  // ---------- Load ----------
  function initLoad() {
    fetch(DATA_URL)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d.frames)) plays = [{ frames: d.frames }];
        else if (Array.isArray(d.plays)) plays = d.plays;
        else throw new Error("Invalid data file");
        sizeCanvas(cvsXY); sizeCanvas(cvs3D); sizeCanvas(mini);
        drawFrame(plays[0], 0);
      })
      .catch(e => {
        hudXY.textContent = "Error: " + e.message;
        hud3D.textContent = "Error loading data";
        console.error(e);
      });
  }

  btnPlay.onclick  = () => { playing = true; requestAnimationFrame(loop); };
  btnPause.onclick = () => { playing = false; };
  btnStep.onclick  = () => { frame++; drawFrame(plays[0], frame % plays[0].frames.length); };

  initLoad();
})();
