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
  const dataLog   = document.getElementById("dataLog");

  // ---------- State ----------
  let DATA_URL = DEFAULT_DATA;
  let plays = [];             
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
  let unitScale = 1;
  let xIsLength = true;     

  // rAF timing
  let lastT = 0, acc = 0, TICK_MS = 1000 / FPS;

  // buffers
  const useOffscreen = (typeof OffscreenCanvas !== "undefined");
  let bufXY, bctxXY, buf3D, bctx3D;

  // ---------- Utils ----------
  const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
  const dist  = (a,b)=>Math.hypot(a.x-b.x, a.y-b.y);
  const ring  = (c,p,r)=>{c.beginPath();c.arc(p.x,p.y,r,0,Math.PI*2);c.stroke();};
  const log   = (msg,cls="info")=>{
    if(dataLog){
      const div=document.createElement("div");
      div.className=cls; div.textContent=msg;
      dataLog.prepend(div);
    }
  };

  function mph(p){
    const v = Math.hypot(p.vx||0,p.vy||0) * FPS; 
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
    const W = cvsXY.width, H = cvsXY.height;
    bctxXY.clearRect(0,0,W,H);
    bctxXY.fillStyle = "#0a4f1a"; bctxXY.fillRect(0,0,W,H);
    bctxXY.strokeStyle="rgba(255,255,255,.18)";
    bctxXY.beginPath();
    for(let y=0;y<=FIELD_LEN_YD;y+=5){
      const yy = H - (y/FIELD_LEN_YD)*H;
      bctxXY.moveTo(0,yy); bctxXY.lineTo(W,yy);
    }
    bctxXY.stroke();
    bctxXY.strokeStyle="rgba(255,255,255,.6)";
    bctxXY.strokeRect(1,1,W-2,H-2);

    bctx3D.clearRect(0,0,cvs3D.width,cvs3D.height);
    bctx3D.fillStyle="#0c3f16"; bctx3D.fillRect(0,0,cvs3D.width,cvs3D.height);
  }

  // ---------- Axis normalization ----------
  function detectAxes(sampleFrames){
    let maxX=-1e9,maxY=-1e9,minX=1e9,minY=1e9;
    sampleFrames.forEach(f=>{
      f.players.forEach(p=>{
        const X=(p.x||0)*unitScale,Y=(p.y||0)*unitScale;
        maxX=Math.max(maxX,X); maxY=Math.max(maxY,Y);
        minX=Math.min(minX,X); minY=Math.min(minY,Y);
      });
      if(f.ball){
        const X=(f.ball.x||0)*unitScale,Y=(f.ball.y||0)*unitScale;
        maxX=Math.max(maxX,X); maxY=Math.max(maxY,Y);
        minX=Math.min(minX,X); minY=Math.min(minY,Y);
      }
    });
    const rangeX=maxX-minX,rangeY=maxY-minY;
    if (rangeX>=70 && rangeY<=65) xIsLength=true;
    else if (rangeY>=70 && rangeX<=65) xIsLength=false;
    else xIsLength=(maxX>=maxY);
  }

  function normalizeCoordinates(){
    plays.forEach(p=>{
      p.frames.forEach((f,fi)=>{
        const fixPoint=pt=>{
          if(!pt)return;
          let X=(pt.x||0)*unitScale;
          let Y=(pt.y||0)*unitScale;
          let VX=(pt.vx||0)*unitScale;
          let VY=(pt.vy||0)*unitScale;
          const width=xIsLength?Y:X;
          const length=xIsLength?X:Y;
          const vWidth=xIsLength?VY:VX;
          const vLen=xIsLength?VX:VY;
          pt.x=clamp(width,0,FIELD_WID_YD);
          pt.y=clamp(length,0,FIELD_LEN_YD);
          pt.vx=vWidth;
          pt.vy=vLen;
          pt.z=pt.z||0;
        };
        f.players.forEach(fixPoint);
        fixPoint(f.ball);
        if(fi===0 && f.ball) p._autoLosY=f.ball.y;
        f._autoLosY=p._autoLosY;
      });
    });
  }

  // ---------- Mapping ----------
  function mapXY(pt){
    const W=cvsXY.width,H=cvsXY.height;
    return {x:(pt.x/FIELD_WID_YD)*W,y:H-(pt.y/FIELD_LEN_YD)*H,z:pt.z||0};
  }
  function map3D(pt){
    const W=cvs3D.width,H=cvs3D.height;
    const scale=H/FIELD_LEN_YD;
    const baseX=W*0.2+(pt.y-cam.y)*scale*4.8;
    const baseY=H*0.78-(pt.x-cam.x)*scale*4.8;
    return {x:baseX,y:baseY-(pt.z||0)*12,z:pt.z||0};
  }
  function mapMini(pt){
    const W=mini.width,H=mini.height;
    return {x:(pt.y/FIELD_LEN_YD)*W,y:H-(pt.x/FIELD_WID_YD)*H};
  }
  function updateCamera(target){
    if(!autoCam||!target)return;
    cam.x+=(target.x-cam.x)*0.15;
    cam.y+=(target.y-cam.y)*0.15;
  }

  // ---------- Trails ----------
  function pushTrail(mapper,store,id,p){
    if(!showTrails)return;
    const s=store.get(id)||[];
    const m=mapper(p);
    s.push({x:m.x,y:m.y});
    if(s.length>40)s.shift();
    store.set(id,s);
  }
  function drawTrails(ctx,store,color){
    if(!showTrails)return;
    ctx.strokeStyle=color;ctx.globalAlpha=.28;
    store.forEach(pts=>{
      if(pts.length<2)return;
      ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
      for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);
      ctx.stroke();
    });
    ctx.globalAlpha=1;
  }

  // ---------- Frame/Play drawing (same as before) ----------
  // ... [no changes needed in drawFrame, drawPlay, etc.] ...

  // ---------- Dataset handling ----------
  function isSchemaFile(json){
    return !!(json && (json.$id || json.$schema || json.properties));
  }

  function normalizeDataset(d){
    unitScale=1;
    const units=(d.field_cs&&d.field_cs.units||"yards").toLowerCase();
    if(units.startsWith("m"))unitScale=1/0.9144;
    if(Array.isArray(d.frames)&&!Array.isArray(d.plays)){
      plays=[{frames:d.frames}];
    }else if(Array.isArray(d.plays)){
      plays=d.plays;
    }else{
      throw new Error("Invalid dataset: expected frames[] or plays[]");
    }
    const sample=[];
    for(const p of plays){
      for(let i=0;i<Math.min(3,p.frames.length);i++)sample.push(p.frames[i]);
      if(sample.length>=6)break;
    }
    detectAxes(sample);
    normalizeCoordinates();
    const f0=plays[0]?.frames?.[0];
    if(f0?.ball){cam.x=f0.ball.x;cam.y=f0.ball.y;}
    trailsXY.clear();trails3D.clear();lastHolder=null;
    playIdx=0;frame=0;playing=false;
    hudXY.textContent=`Loaded ${plays.length} play(s) — tap ▶`;
    hud3D.textContent="Follow: Ball";
    sizeAll();
  }

  // ---------- Debugging fetch ----------
  function initLoad(fromReload=false){
    playing=false;frame=0;playIdx=0;lastHolder=null;
    trailsXY.clear();trails3D.clear();
    hudXY.textContent="Loading…";hud3D.textContent="Loading…";
    log(`Attempting fetch from ${DATA_URL}`,'info');

    fetch(`${DATA_URL}?t=${Date.now()}`,{cache:"no-store"})
      .then(r=>{
        log(`Fetch status: ${r.status} (${r.statusText}) from ${r.url}`,'info');
        if(!r.ok) throw new Error(`HTTP ${r.status} (${r.statusText})`);
        return r.text();
      })
      .then(txt=>{
        let json;
        try{json=JSON.parse(txt);}catch(e){throw new Error("Invalid JSON (parse)");}
        if(isSchemaFile(json)){throw new Error("That file is a schema, not telemetry data.");}
        log("JSON parsed successfully. Normalizing dataset…",'ok');
        normalizeDataset(json);
      })
      .catch(e=>{
        const msg=`Load error: ${e.message}`;
        hudXY.textContent=msg;hud3D.textContent=msg;
        log(msg,'warn');
      });
  }

  // ---------- UI wiring ----------
  btnPlay.onclick  = ()=>{if(plays.length){playing=true;requestAnimationFrame(loop);}};
  btnPause.onclick = ()=>playing=false;
  btnStep.onclick  = ()=>{playing=false;stepFrames(1);};

  // ---------- Kick ----------
  sizeAll();
  initLoad(false);
})();
