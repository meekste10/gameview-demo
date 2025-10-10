/* gameview.js — Dual-View rAF (XY + Z Follow, Mini-map) — solid for GV-telemetry(-/v1) + Kaggle */
(() => {
  // ---------- Constants / Field ----------
  const DEFAULT_DATA =
     "https://meekste10.github.io/gameview-demo/drive_nfltelemetry.json";
  const FPS = 10;
  const FIELD_LEN_YD = 120;      // full length incl. end zones
  const FIELD_WID_YD = 53.333;   // sideline-to-sideline

  // ---------- DOM ----------
  const cvsXY  = document.getElementById("fieldXY");
  const ctxXY  = cvsXY.getContext("2d");
  const hudXY  = document.getElementById("hudXY");
  const cvs3D  = document.getElementById("field3D");
  const ctx3D  = cvs3D.getContext("2d");
  const hud3D  = document.getElementById("hud3D");
  const mini   = document.getElementById("mini");
  const mctx   = mini.getContext("2d");

  const btnPlay = document.getElementById("play");
  const btnPause= document.getElementById("pause");
  const btnStep = document.getElementById("step");

  const showSpeedEl  = document.getElementById("showSpeed");
  const showPosEl    = document.getElementById("showPos");
  const showTrailsEl = document.getElementById("showTrails");
  const autoCamEl    = document.getElementById("autoCam");
  const losOnEl      = document.getElementById("losOn");
  const fxOnEl       = document.getElementById("effectsOn");
  const focusSel     = document.getElementById("focusPlayer");

  const losYEl    = document.getElementById("losY");
  const togoEl    = document.getElementById("togo");
  const applyDDEl = document.getElementById("applyDD");

  const dsSel     = document.getElementById("datasetSel");
  const reloadBtn = document.getElementById("reload");
  const fileInput = document.getElementById("fileInput");

  // ---------- State ----------
  let DATA_URL = DEFAULT_DATA;
  let plays = [];             // normalized as [{frames:[...]}]
  let playIdx = 0, frame = 0;
  let playing = false;

  let showSpeed = true, showPos = true, showTrails = true, autoCam = true, losOn = true, effectsOn = true;
  let reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let focusTarget = null;
  let trailsXY = new Map(), trails3D = new Map();
  let lastHolder = null, catchFlash = 0, tackleFlash = 0;

  let losY_auto = null, togoY = 10;
  let cam = { x: FIELD_WID_YD/2, y: FIELD_LEN_YD/2, z: 0 };

  // units & axis detection
  let unitScale = 1;        // meters->yards if needed
  let xIsLength = true;     // true if x≈0..120 and y≈0..53.3 (Kaggle style)

  // rAF timing
  let lastT = 0, acc = 0, TICK_MS = 1000 / FPS;

  // buffers (static field paint)
  const useOffscreen = (typeof OffscreenCanvas !== "undefined");
  let bufXY, bctxXY, buf3D, bctx3D;

  // ---------- Utils ----------
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const dist  = (a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
  const ring  = (c,p,r)=>{c.beginPath();c.arc(p.x,p.y,r,0,Math.PI*2);c.stroke();};

  function mph(p){
    const v = Math.hypot(p.vx||0,p.vy||0) * FPS; // yards/s
    return (v*0.9144*2.236936).toFixed(1);
  }

  // ---------- Sizing / Buffers ----------
  function sizeCanvas(c){
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth  || 960;
    const h = c.clientHeight || 540;
    c.width = Math.round(w*dpr);
    c.height= Math.round(h*dpr);
    c.getContext("2d").setTransform(dpr,0,0,dpr,0,0);
  }
  function sizeAll(){
    [cvsXY,cvs3D,mini].forEach(sizeCanvas);
    // allocate buffers
    if (useOffscreen){
      bufXY = new OffscreenCanvas(cvsXY.width, cvsXY.height);
      buf3D = new OffscreenCanvas(cvs3D.width, cvs3D.height);
    }else{
      bufXY = document.createElement("canvas");
      buf3D = document.createElement("canvas");
      bufXY.width = cvsXY.width; bufXY.height = cvsXY.height;
      buf3D.width = cvs3D.width; buf3D.height = cvs3D.height;
    }
    bctxXY = bufXY.getContext("2d");
    bctx3D = buf3D.getContext("2d");
    paintStatic();
    drawPlay(playIdx);
  }
  new ResizeObserver(sizeAll).observe(cvsXY);
  new ResizeObserver(sizeAll).observe(cvs3D);
  new ResizeObserver(sizeAll).observe(mini);
  window.addEventListener("resize", sizeAll);

  function paintStatic(){
    // XY field: full field (no camera)
    const W = cvsXY.width, H = cvsXY.height;
    bctxXY.clearRect(0,0,W,H);
    bctxXY.fillStyle = "#0a4f1a"; bctxXY.fillRect(0,0,W,H);

    // 5-yd lines
    bctxXY.strokeStyle="rgba(255,255,255,.18)";
    bctxXY.beginPath();
    for(let y=0;y<=FIELD_LEN_YD;y+=5){
      const yy = H - (y/FIELD_LEN_YD)*H;
      bctxXY.moveTo(0,yy); bctxXY.lineTo(W,yy);
    }
    bctxXY.stroke();
    // sidelines
    bctxXY.strokeStyle="rgba(255,255,255,.6)";
    bctxXY.strokeRect(1,1,W-2,H-2);

    // 3D grass background
    bctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
    bctx3D.fillStyle="#0c3f16"; bctx3D.fillRect(0,0,cvs3D.width,cvs3D.height);
  }

  // ---------- Axis normalization ----------
  function detectAxes(sampleFrames){
    // look at ranges to decide which axis is length (≈120yd)
    let maxX = -1e9, maxY = -1e9;
    let minX =  1e9, minY =  1e9;
    sampleFrames.forEach(f=>{
      f.players.forEach(p=>{
        const X = (p.x||0)*unitScale, Y=(p.y||0)*unitScale;
        maxX=Math.max(maxX,X); maxY=Math.max(maxY,Y);
        minX=Math.min(minX,X); minY=Math.min(minY,Y);
      });
      if(f.ball){
        const X=(f.ball.x||0)*unitScale, Y=(f.ball.y||0)*unitScale;
        maxX=Math.max(maxX,X); maxY=Math.max(maxY,Y);
        minX=Math.min(minX,X); minY=Math.min(minY,Y);
      }
    });
    const rangeX = maxX-minX, rangeY = maxY-minY;
    // if either dimension exceeds ~70yd it's almost certainly the length axis
    if (rangeX >= 70 && rangeY <= 65) xIsLength = true;
    else if (rangeY >= 70 && rangeX <= 65) xIsLength = false;
    else xIsLength = (maxX >= maxY); // fallback heuristic
  }

  function normalizeCoordinates(){
    plays.forEach(p=>{
      p.frames.forEach((f,fi)=>{
        const fixPoint = pt=>{
          if(pt==null) return;
          // scale units first
          let X = (pt.x||0) * unitScale;
          let Y = (pt.y||0) * unitScale;
          let VX = (pt.vx||0) * unitScale;
          let VY = (pt.vy||0) * unitScale;

          // map to width/length semantics:
          // width ∈ [0..53.333], length ∈ [0..120]
          const width  = xIsLength ? Y : X;
          const length = xIsLength ? X : Y;
          const vWidth = xIsLength ? VY : VX;
          const vLen   = xIsLength ? VX : VY;

          pt.x = clamp(width ,  0, FIELD_WID_YD);
          pt.y = clamp(length, 0, FIELD_LEN_YD);
          pt.vx= vWidth;
          pt.vy= vLen;
          pt.z = pt.z || 0;
        };
        f.players.forEach(fixPoint);
        fixPoint(f.ball);
        if (fi===0 && f.ball) p._autoLosY = f.ball.y; // baseline LOS
        f._autoLosY = p._autoLosY;
      });
    });
  }

  // ---------- Mapping (canvas) ----------
  function mapXY(pt){
    // full-field fit (no camera translate in XY)
    const W = cvsXY.width, H = cvsXY.height;
    const x = (pt.x / FIELD_WID_YD) * W;
    const y = H - (pt.y / FIELD_LEN_YD) * H;
    return {x,y,z:pt.z||0};
  }
  function map3D(pt){
    // simple tilt + follow camera on length/width
    const W=cvs3D.width, H=cvs3D.height;
    const scale = H / FIELD_LEN_YD;
    const baseX = W*0.2 + (pt.y - cam.y) * scale * 4.8; // forward/back pops horizontally
    const baseY = H*0.78 - (pt.x - cam.x) * scale * 4.8; // lateral shifts vertically
    return { x: baseX, y: baseY - (pt.z||0)*12, z: pt.z||0 };
  }
  function mapMini(pt){
    const W=mini.width, H=mini.height;
    return { x:(pt.y/FIELD_LEN_YD)*W, y:H-(pt.x/FIELD_WID_YD)*H };
  }
  function updateCamera(target){
    if (!autoCam || !target) return;
    cam.x += (target.x - cam.x) * 0.15;   // width follow
    cam.y += (target.y - cam.y) * 0.15;   // length follow
  }

  // ---------- Trails ----------
  function pushTrail(mapper, store, id, p){
    if(!showTrails) return;
    const s = store.get(id) || [];
    const m = mapper(p);
    s.push({x:m.x,y:m.y});
    if(s.length>40) s.shift();
    store.set(id,s);
  }
  function drawTrails(ctx, store, color){
    if(!showTrails) return;
    ctx.strokeStyle=color; ctx.globalAlpha=.28;
    store.forEach(pts=>{
      if(pts.length<2) return;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for(let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    });
    ctx.globalAlpha=1;
  }

  // ---------- Draw helpers ----------
  function drawDownDistance(ctx, mapper, f){
    if(!losOn) return;
    const yLos = (losY_auto ?? f._autoLosY);
    if(!(yLos>=0)) return;
    const yFd = clamp(yLos + togoY, 0, FIELD_LEN_YD);
    const a=mapper({x:0, y:yLos, z:0});
    const b=mapper({x:FIELD_WID_YD, y:yLos, z:0});
    const c=mapper({x:0, y:yFd, z:0});
    const d=mapper({x:FIELD_WID_YD, y:yFd, z:0});
    ctx.lineWidth=2;
    ctx.strokeStyle='rgba(114,182,229,.95)'; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    ctx.strokeStyle='rgba(255,217,122,.95)'; ctx.beginPath(); ctx.moveTo(c.x,c.y); ctx.lineTo(d.x,d.y); ctx.stroke();
    ctx.lineWidth=1;
  }

  function drawMini(f,follow){
    mctx.clearRect(0,0,mini.width,mini.height);
    mctx.strokeStyle='rgba(255,255,255,.4)'; mctx.strokeRect(1,1,mini.width-2,mini.height-2);
    if(f.ball){ const mb = mapMini(f.ball); mctx.fillStyle='#ffd97a'; mctx.fillRect(mb.x-2,mb.y-2,4,4); }
    f.players.forEach(p=>{
      const m = mapMini(p);
      mctx.fillStyle = (follow && follow.id===p.id) ? '#ffd97a' : (p.team==='home'?'#72b6e5':'#ff9999');
      mctx.beginPath(); mctx.arc(m.x,m.y,3,0,Math.PI*2); mctx.fill();
    });
  }

  // ---------- Frame/Play ----------
  function currentPlay(){ return plays[playIdx]; }
  function drawFrame(play, k){
    const f = play.frames[k]; if(!f || !f.ball) return;

    // follow target
    let follow = f.ball;
    if (focusTarget){
      const fp = f.players.find(p=>p.id===focusTarget);
      if (fp) follow = fp;
    }
    updateCamera(follow);

    // holder detection (for FX, optional)
    const mBallXY = mapXY(f.ball);
    let holder=null, minD=Infinity;
    f.players.forEach(p=>{
      const mp = mapXY(p); const d = dist(mp,mBallXY);
      if(d<minD){ minD=d; holder=p.id; }
    });
    const hasHolder = (minD < 18);
    if(hasHolder && holder!==lastHolder && lastHolder) catchFlash=6;
    if(!hasHolder && lastHolder && (f.ball.z||0)<0.4) tackleFlash=6;
    if(hasHolder) lastHolder=holder;

    // ----- XY -----
    ctxXY.clearRect(0,0,cvsXY.width,cvsXY.height);
    ctxXY.drawImage(bufXY,0,0);
    drawDownDistance(ctxXY, mapXY, f);
    drawTrails(ctxXY, trailsXY, '#fff');

    f.players.forEach(p=>{
      pushTrail(mapXY, trailsXY, p.id, p);
      const mp = mapXY(p);
      ctxXY.strokeStyle = (focusTarget===p.id) ? '#ffd97a' : (p.team==='home'?'#72b6e5':'#ff9999');
      ctxXY.lineWidth = (focusTarget===p.id)?3:1.6;
      ctxXY.beginPath(); ctxXY.arc(mp.x, mp.y, 4, 0, Math.PI*2); ctxXY.stroke();
      if(showSpeed || showPos){
        let t=''; if(showSpeed) t += `${mph(p)} mph `;
        if(showPos && p.role) t += `(${p.role})`;
        if(t){ ctxXY.font='10px system-ui'; ctxXY.textAlign='center'; ctxXY.fillStyle='#fff'; ctxXY.fillText(t, mp.x, mp.y-10); }
      }
    });
    ctxXY.fillStyle='#ffd97a'; ctxXY.beginPath(); ctxXY.arc(mBallXY.x, mBallXY.y, 4, 0, Math.PI*2); ctxXY.fill();

    // ----- 3D -----
    ctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
    ctx3D.drawImage(buf3D,0,0);
    drawDownDistance(ctx3D, map3D, f);
    drawTrails(ctx3D, trails3D, '#fff');

    // simple painter's algorithm by depth (length)
    [...f.players].sort((a,b)=>a.y-b.y).forEach(p=>{
      pushTrail(map3D, trails3D, p.id, p);
      const mp = map3D(p);
      ctx3D.fillStyle = (p.team==='home') ? '#cfe9fb' : '#ffd0d0';
      // shadow
      ctx3D.fillStyle='rgba(0,0,0,.25)'; ctx3D.beginPath(); ctx3D.ellipse(mp.x, mp.y+6, 8, 2.5, 0, 0, Math.PI*2); ctx3D.fill();
      // body
      ctx3D.fillStyle = (p.team==='home') ? '#cfe9fb' : '#ffd0d0';
      ctx3D.beginPath(); ctx3D.arc(mp.x, mp.y, 4, 0, Math.PI*2); ctx3D.fill();
    });
    const mB3 = map3D(f.ball);
    ctx3D.fillStyle='#ffd97a'; ctx3D.beginPath(); ctx3D.arc(mB3.x, mB3.y, 5, 0, Math.PI*2); ctx3D.fill();
    if(effectsOn){
      if(catchFlash>0){ ctx3D.strokeStyle='rgba(255,255,0,.9)'; ring(ctx3D, mB3, 18); }
      if(tackleFlash>0){ ctx3D.strokeStyle='rgba(255,255,255,.9)'; ring(ctx3D, mB3, 26); }
    }
    if(catchFlash>0) catchFlash--;
    if(tackleFlash>0) tackleFlash--;

    // HUD
    if((k%3)===0){
      hudXY.textContent = `Play ${playIdx+1}/${plays.length} — Frame ${k+1}/${play.frames.length}`;
      hud3D.textContent = focusTarget ? `Follow: ${focusTarget}` : `Follow: Ball`;
    }

    // mini (every other frame)
    if((k%2)===0) drawMini(f, follow);
  }

  function drawPlay(i){ const p = plays[i]; if(!p) return; drawFrame(p, frame); }
  function stepFrames(n){ const p=plays[playIdx]; if(!p) return; frame = clamp(frame+n, 0, p.frames.length-1); drawPlay(playIdx); }

  // ---------- Loop ----------
  function loop(t){
    if(!playing || reduceMotion){ lastT=t; requestAnimationFrame(loop); return; }
    if(!lastT) lastT=t;
    let dt=t-lastT; lastT=t; acc+=dt;
    while(acc>=TICK_MS){
      const p=plays[playIdx];
      if(p){
        frame++;
        if(frame>=p.frames.length){
          frame=0; playIdx=(playIdx+1)%plays.length;
          trailsXY.clear(); trails3D.clear(); lastHolder=null;
        }
        drawPlay(playIdx);
      }
      acc-=TICK_MS;
    }
    requestAnimationFrame(loop);
  }

  // ---------- Dataset handling ----------
  function isSchemaFile(json){
    // Treat JSON Schema (your gv-telemetry-v1.json) as non-playable
    return !!(json && (json.$id || json.$schema || json.properties));
  }

  function normalizeDataset(d){
    // schema string accepted with dash or slash; we don't hard-fail on mismatch
    unitScale = 1;
    const units = (d.field_cs && d.field_cs.units || "yards").toLowerCase();
    if (units.startsWith("m")) unitScale = 1/0.9144;

    // accept frames[] or plays[]; coerce to plays[]
    if (Array.isArray(d.frames) && !Array.isArray(d.plays)){
      plays = [{ frames: d.frames }];
    } else if (Array.isArray(d.plays)){
      plays = d.plays;
    } else {
      throw new Error("Invalid dataset: expected frames[] or plays[]");
    }

    // detect axis orientation on a handful of frames
    const sample = [];
    for (const p of plays){
      for (let i=0;i<Math.min(3, p.frames.length);i++) sample.push(p.frames[i]);
      if (sample.length >= 6) break;
    }
    detectAxes(sample);
    normalizeCoordinates();

    // set initial camera to ball of first frame
    const f0 = plays[0]?.frames?.[0];
    if (f0?.ball){ cam.x = f0.ball.x; cam.y = f0.ball.y; }

    // populate focus menu
    focusSel.innerHTML = '<option value="">Follow: Ball (default)</option>';
    const ids = new Set();
    plays[0]?.frames?.[0]?.players?.forEach(pl=>ids.add(pl.id));
    focusSel.insertAdjacentHTML("beforeend", [...ids].map(id=>`<option value="${id}">${id}</option>`).join(""));

    trailsXY.clear(); trails3D.clear(); lastHolder=null;
    playIdx=0; frame=0; playing=false;
    hudXY.textContent = `Loaded ${plays.length} play(s) — tap ▶`;
    hud3D.textContent = "Follow: Ball";
    sizeAll();
  }

  function initLoad(fromReload=false){
    playing=false; frame=0; playIdx=0; lastHolder=null;
    trailsXY.clear(); trails3D.clear();
    hudXY.textContent="Loading…"; hud3D.textContent="Loading…";

    fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" })
      .then(r=>{
        if(!r.ok) throw new Error(`HTTP ${r.status} (${r.statusText})`);
        return r.text();
      })
      .then(txt=>{
        // guard against accidentally selecting the schema file
        let json;
        try{ json = JSON.parse(txt); } catch(e){ throw new Error("Invalid JSON (parse)"); }
        if (isSchemaFile(json)){
          throw new Error("That file is a schema (gv-telemetry-v1), not a dataset.");
        }
        normalizeDataset(json);
      })
      .catch(e=>{
        const msg = `Load error: ${e.message}`;
        hudXY.textContent = msg; hud3D.textContent = msg;
        console.error(e);
      });
  }

  // ---------- UI wiring ----------
  showSpeedEl.onchange = ()=> showSpeed = showSpeedEl.checked;
  showPosEl.onchange   = ()=> showPos   = showPosEl.checked;
  showTrailsEl.onchange= ()=> showTrails= showTrailsEl.checked;
  autoCamEl.onchange   = ()=> autoCam   = autoCamEl.checked;
  losOnEl.onchange     = ()=> losOn     = losOnEl.checked;
  fxOnEl.onchange      = ()=> effectsOn = fxOnEl.checked;

  focusSel.onchange = ()=>{ focusTarget = focusSel.value || null; drawPlay(playIdx); };

  applyDDEl.onclick = ()=>{
    const vLos = parseFloat(losYEl.value);
    const vTgo = parseFloat(togoEl.value);
    if(!Number.isNaN(vLos)) losY_auto = vLos;
    if(!Number.isNaN(vTgo)) togoY = vTgo;
    drawPlay(playIdx);
  };

  if (dsSel) dsSel.value = DATA_URL;
  reloadBtn.onclick = ()=>{ DATA_URL = dsSel.value || DEFAULT_DATA; initLoad(true); };

  // file loader (mobile-friendly)
  if (fileInput){
    fileInput.addEventListener("change", e=>{
      const file = e.target.files && e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try{
          const json = JSON.parse(reader.result);
          if (isSchemaFile(json)) throw new Error("That file is a schema, not telemetry data.");
          normalizeDataset(json);
        }catch(err){
          hudXY.textContent = "Load error: " + err.message;
          hud3D.textContent = "Load error: " + err.message;
          console.error(err);
        }
      };
      reader.readAsText(file);
    });
  }

  // keyboard scrub (J/K/L)
  window.addEventListener("keydown", e=>{
    if(e.key==='k'||e.key==='K') playing=false;
    if(e.key==='j'||e.key==='J') stepFrames(-FPS);
    if(e.key==='l'||e.key==='L') stepFrames(e.shiftKey?FPS*5:FPS);
  });

  // controls
  btnPlay.onclick  = ()=>{ if(plays.length){ playing=true; requestAnimationFrame(loop);} };
  btnPause.onclick = ()=> playing=false;
  btnStep.onclick  = ()=>{ playing=false; stepFrames(1); };

  // ---------- Kick ----------
  sizeAll();
  initLoad(false);
})();
