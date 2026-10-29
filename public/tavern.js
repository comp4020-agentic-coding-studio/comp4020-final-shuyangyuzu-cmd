// Original canvas art. World-space fixtures and camera-space input are
// separate; movement remains adjacent steps validated by the server.
export function bindDirectionHold(button, { onPress, onRelease, onTap }) {
  let pointer = null;
  const release = e => { if (pointer !== null) { pointer = null; onRelease({ cancelled: e?.type !== 'pointerup' }); } };
  const down = e => {
    if (e.isPrimary === false || e.button !== 0) return;
    e.preventDefault(); pointer = e.pointerId; onPress();
  };
  const up = e => { if (e.pointerId === pointer) release(e); };
  const click = e => { if (e.detail === 0) onTap(); }; // keyboard/assistive activation only
  const hidden = () => { if (button.ownerDocument.hidden) release(); };
  const win = button.ownerDocument.defaultView;
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerleave', release);
  button.addEventListener('click', click);
  win.addEventListener('pointerup', up);
  win.addEventListener('pointercancel', up);
  win.addEventListener('blur', release);
  button.ownerDocument.addEventListener('visibilitychange', hidden);
  return () => {
    release(); button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointerleave', release); button.removeEventListener('click', click);
    win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up);
    win.removeEventListener('blur', release); button.ownerDocument.removeEventListener('visibilitychange', hidden);
  };
}
export function createTavern({ el, render, navigate, buildClassicPanel, saveSession, shouldApplyLiveUpdate, createMenuBook, mixologyModule, ordersApi }) {
  const menuBook=createMenuBook({el,mixologyModule,ordersApi});
  const colors = { red:'#c85e59', blue:'#6485bc', green:'#629e86', yellow:'#ddba65', purple:'#997cb5', teal:'#66b5b0', orange:'#cf8858', pink:'#cd88a3' };
  const skins = { fair:'#f3d7b6', warm:'#dcb58a', tan:'#ba875f', brown:'#906044', deep:'#614437' };
  let dispose = () => {};
  let enteredThisPage = false;
  const sessionKey = 'vegas:bar:session';
  const post = async (path, body) => {
    const r = await fetch('/api/bar'+path,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body) });
    const data = await r.json(); if(!r.ok) throw Object.assign(new Error(data.message),{status:r.status}); return data;
  };
  const read = async path => { const r=await fetch('/api/bar'+path); if(!r.ok) throw new Error('Unable to connect to the tavern'); return r.json(); };
  function sprite(c,x,y,color,skin,scale=1,step=0,seated=false) {
    c.save(); c.translate(Math.round(x),Math.round(y)); c.scale(scale,scale);
    const rect=(a,b,w,h,t)=>{c.fillStyle=t;c.fillRect(a,b,w,h);};
    c.fillStyle='#130e1760'; c.beginPath(); c.ellipse(0,1,12,4,0,0,Math.PI*2);c.fill();
    const leg=Math.sin(step)*2;
    if(seated){
      rect(-11,-12,22,7,'#393a52');rect(-11,-5,6,7,'#393a52');rect(5,-5,6,7,'#393a52');
      rect(-13,1,9,4,'#251f2d');rect(4,1,9,4,'#251f2d');
    }else{
      rect(-7,-12,6,12+leg,'#393a52'); rect(1,-12,6,12-leg,'#393a52');
      rect(-8,leg-3,7,4,'#251f2d');rect(1,-leg-3,8,4,'#251f2d');
    }
    rect(-10,-28,20,17,color);rect(-10,-13,20,3,'#00000022');
    rect(-14,-26,4,12,skin);rect(10,-26,4,12,skin);
    rect(-9,-45,18,18,skin);rect(-11,-48,22,8,'#43302d');
    rect(-11,-40,4,8,'#43302d');rect(7,-40,4,6,'#43302d');
    rect(-5,-36,2,3,'#302635');rect(4,-36,2,3,'#302635');rect(-2,-30,4,1,'#a56656');
    c.restore();
  }
  async function mount() {
    dispose(); document.body.classList.add('world-mode');
    let active=true, session=null, state={players:[],tables:[]}, mine=null, camera={x:0,y:0}, path=[], moving=false, frame=0, lowStaminaNotified=false;
    // This identity's own currently-bound table seat, if any —
    // {tableId, roomCode} or null, re-validated server-side on every
    // join/rejoin/appearance response (src/tables.ts's getActiveSeat),
    // never a client-trusted cache. Deliberately NOT part of `session`
    // (which is persisted to localStorage): a new character's first join
    // response always carries activeSeat:null, so "Return to your game"
    // can never leak a *different* character's game the way the old
    // single global vegas:lastRoom key did (PLAN.md's
    // product-direction-update entry — the actual reported bug).
    let activeSeat=null;
    let returnGameButton=null;
    let keys=new Set(), lastTime=0, destination=null, cameraInitialized=false, movementEpoch=0, heldDirection=null;
    // Crit 9: live updates arrive over SSE, not a fixed poll interval —
    // see CLAUDE.md. `liveCursor` is this channel's staleness-gate
    // baseline (`{epoch, seq}`, or `null` before the first payload is
    // ever applied); every incoming payload — a push, a fallback fetch, a
    // mutation's own response — goes through applyIncoming, which defers
    // the actual accept/reject decision to the shared
    // `shouldApplyLiveUpdate` (public/liveSync.js, passed in from
    // app.js — the same function tavern.js's room-view sibling uses, not
    // a separately hand-written copy; a Crit 9 phase 7 review pointed out
    // two copies passing the same manual trace isn't the guarantee one
    // shared function actually is). `pendingMoveTarget` is the narrow
    // exception: while this patron's own step is in flight, an update
    // that predates it must not visually snap the local avatar back to
    // its pre-move tile — every *other* player's position and the live
    // table list still apply immediately regardless (continuous walking
    // must not block receiving others' updates).
    let liveCursor=null, eventSource=null, pendingMoveTarget=null, visibilityHandler=null;
    // Phase 2 (product-direction-update): the seat a click/tap is walking
    // this patron toward, if any — set by beginSit, consumed once step()
    // confirms arrival at that exact tile (see step() below). Click-a-
    // chair-then-walk-then-sit is one gesture from the player's point of
    // view, but still two real, separately-validated server calls: a
    // normal adjacent-step /move for each tile of the walk, then one
    // /seats/:id/sit once actually standing there — never a shortcut
    // around either check.
    let pendingSitSeat=null;
    // Product-direction-update, part 2: the walk-toward-a-player gesture
    // in flight — {playerId, approach:{x,y}, targetX, targetY, attempts}
    // or null — mirroring pendingSitSeat's own shape/lifecycle (set by a
    // click, consumed once step() confirms arrival, aborted by the
    // animate() loop if the target moves away too many times or goes
    // offline). Previously also triggered an auto-opened private chat
    // dialog on arrival; after the student's own acceptance testing, chat
    // became public speech bubbles (see the "say" section below) with no
    // per-player targeting at all, so this is now purely "walk up next to
    // someone instead of into them" — the original, chat-independent part
    // 2 rule.
    let approachTarget=null;
    const holdCleanups=[];
    dispose=()=>{
      active=false;holdCleanups.forEach(cleanup=>cleanup());document.body.classList.remove('world-mode');
      if(eventSource){eventSource.close();eventSource=null;}
      if(visibilityHandler){document.removeEventListener('visibilitychange',visibilityHandler);window.removeEventListener('focus',visibilityHandler);visibilityHandler=null;}
    };
    const displayPositions=new Map();
    const timers=[];
    const canvas=el('canvas',{'aria-label':'Shared tavern map',tabindex:'0'});
    const toast=el('div',{class:'world-toast','role':'status'},'WASD / arrows to walk · click the floor to explore');
    const online=el('span',{class:'online-count'},'Connecting…');
    // Phase 2: visible only while mine.seatId is set (toggled in
    // reconcile below) — standing up is always available from the HUD,
    // not just by walking away (which also stands you up, via the
    // server's own moveBar — src/bar.ts).
    const standBtn=el('button',{class:'hud-button',onclick:async()=>{
      try{const resp=await post('/stand',session);applyIncoming(resp);toast.textContent='Standing — click a chair to sit down.';}catch(e){toast.textContent=e.message||'Could not stand up';}
    }},'Stand up');
    standBtn.style.display='none';
    // Compact, read-only stamina readout beside "Your character" — a
    // server-computed status display, never a form field: there is no
    // input here, only a bar fill and a percentage rendered straight
    // from mine.stamina (reconcile() below), the same public field
    // every other per-player HUD element already reads. Clicking it
    // opens the same character panel "Your character" does (CLAUDE.md:
    // one combined entry point, not a second place to look), where the
    // full bar plus a short restore-amount note lives.
    const staminaFill=el('span',{class:'stamina-fill'});
    const staminaLabel=el('span',{class:'stamina-pct'},'—');
    const staminaButton=el('button',{class:'hud-button stamina-chip','aria-label':'View your stamina',onclick:()=>{path=[];chooseCharacter();}},[
      el('span',{class:'stamina-track'},[staminaFill]),staminaLabel,
    ]);
    const hud=el('header',{class:'world-hud'},[
      el('div',{class:'world-brand'},[el('span',{class:'brand-mark'},'◆'),el('div',{},[el('strong',{},'Las Vegas'),el('small',{},'A little place to be together')])]),
      el('div',{class:'hud-actions'},[online,standBtn,staminaButton,el('button',{class:'hud-button',onclick:()=>{path=[];chooseCharacter();}},'Your character'),el('button',{class:'hud-button',onclick:()=>openGames()},'Join by code')]),
    ]);
    const directions=el('div',{class:'world-dpad','aria-label':'Movement controls'});
    for(const [label,dx,dy] of [['↑',0,-1],['←',-1,0],['↓',0,1],['→',1,0]]) {
      const b=el('button',{'aria-label':`Walk ${label}`},label);directions.appendChild(b);
      holdCleanups.push(bindDirectionHold(b, {
        onPress:()=>{ if(!mine||overlay.childElementCount)return;path=[];heldDirection={dx,dy};queueStep(dx,dy); },
        onRelease:({cancelled})=>{ if(heldDirection?.dx===dx&&heldDirection?.dy===dy){heldDirection=null;if(cancelled)path=[];} },
        onTap:()=>queueStep(dx,dy),
      }));
    }
    const seatLayer=el('div',{class:'seat-layer'});
    const scene=el('div',{class:'tavern-world'},[canvas,seatLayer,hud,toast,directions]); render(scene);
    const overlay=el('div',{class:'world-overlay'});scene.appendChild(overlay);
    // The counter's own physical menu book (public/menuBook.js) — one
    // in-scene entry point replacing the old "Mixology book"/"Meals/
    // Drinks" HUD buttons entirely (CLAUDE.md). Its cover offers all
    // three destinations (the Mixology book, Meals, Drinks); opening it
    // stops held movement the same way every other overlay dialog here
    // already does.
    function openMenuBook(){
      if(!mine||overlay.childElementCount)return;
      path=[];destination=null;keys.clear();heldDirection=null;pendingSitSeat=null;approachTarget=null;
      menuBook.open(overlay,session,menuBookButton.getBoundingClientRect());
    }
    let layout;
    try { layout=await read('/layout'); } catch(e) {toast.textContent=e.message;return;}
    if(!active)return;
    const tile=64, worldW=layout.gridCols*tile,worldH=layout.gridRows*tile;
    const fixtures=layout.furniture;
    // A real-time Canberra/Sydney clock, mounted above the counter. Must
    // be drawn per-frame in animate() below, in screen space, never baked
    // into the static `floor` canvas further down — that canvas is
    // painted once at load and never updates, so a clock face baked into
    // it would freeze at load time. Intl.DateTimeFormat with an explicit
    // IANA zone resolves AEST/AEDT and the actual transition dates
    // correctly using the runtime's own tzdata — no hand-coded UTC
    // offset or DST rule of this app's own, which would silently go
    // wrong on the next transition.
    const counterFixture=fixtures.find(f=>f.kind==='counter');
    // The menu book sits on the counter's own top surface (CLAUDE.md:
    // "draw a clearly recognisable menu book on the front counter"),
    // placed 3 tiles in from the counter's right edge — clear of the
    // clock (mounted on the wall strip above, not the counter surface
    // itself: see drawClock's own placement reasoning just below) and
    // of the evenly-spaced bottle-shelf decoration drawn above the
    // counter in the fixtures loop further down, which only occupies
    // y-24..y-2 (above the counter's own tile row), never the surface
    // band (y+5..y+h-10) this book is drawn on.
    const bookWorldX=counterFixture?((counterFixture.x+counterFixture.w-3)*tile+tile/2):0;
    const bookWorldY=counterFixture?(counterFixture.y*tile+34):0;
    const clockTimeFmt=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false});
    const clockAngleFmt=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Sydney',hour:'numeric',minute:'numeric',second:'numeric',hour12:false});
    function drawClock(now){
      if(!counterFixture)return;
      // Mounted on the near wall strip directly above the counter (the
      // `wallX/wallY/wallW` band drawn in the static floor layer below,
      // which is itself derived from the real `back-bar` cabinet_wall
      // fixture — NOT the far brick wall at the top of the map, which an
      // earlier version of this placement mistakenly targeted after
      // misreading CORE_FURNITURE's pre-offset coordinates in the source
      // file instead of the actual, `+10,+6`-shifted values FURNITURE
      // exports and the server actually serves via GET /api/bar/layout.
      // That mistake put the clock nowhere near the counter at all (world
      // y=56, inside the distant top wall) — found only by querying the
      // live layout directly and comparing real numbers, not by trusting
      // a source-file read or a screenshot. Placed just past the
      // counter's own right edge, clear of its last candle sconce
      // (ends ~x+872) and the "Las Vegas" sign (centred, well to the
      // left) on one side, and the nearest hanging shelf unit on the
      // wall strip itself on the other — every one of those checked by
      // real coordinate arithmetic against the fixtures this function
      // already has in scope, the same way the plant/rug placements
      // elsewhere in this file were verified.
      const worldX=(counterFixture.x+counterFixture.w)*tile+40, worldY=counterFixture.y*tile-68;
      const x=worldX-camera.x, y=worldY-camera.y;
      if(x<-60||x>vw+60||y<-60||y>vh+60)return; // off-screen — skip the work
      const parts=Object.fromEntries(clockAngleFmt.formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
      const hour=parts.hour%12, minute=parts.minute, second=parts.second;
      const r=22;
      ctx.save();
      ctx.translate(x,y);
      ctx.fillStyle='#2e211d';ctx.beginPath();ctx.arc(0,0,r+6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#e4bf7e';ctx.beginPath();ctx.arc(0,0,r+3,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#f5ecd9';ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#352b2d';ctx.lineWidth=1;
      for(let i=0;i<12;i++){
        const a=i*Math.PI/6;
        ctx.beginPath();ctx.moveTo(Math.sin(a)*(r-3),-Math.cos(a)*(r-3));ctx.lineTo(Math.sin(a)*(r-6),-Math.cos(a)*(r-6));ctx.stroke();
      }
      const hourAngle=(hour+minute/60)*Math.PI/6, minuteAngle=(minute+second/60)*Math.PI/30;
      ctx.lineCap='round';
      ctx.strokeStyle='#352b2d';ctx.lineWidth=2.5;
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.sin(hourAngle)*(r*0.5),-Math.cos(hourAngle)*(r*0.5));ctx.stroke();
      ctx.strokeStyle='#5a4a3f';ctx.lineWidth=1.6;
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.sin(minuteAngle)*(r*0.78),-Math.cos(minuteAngle)*(r*0.78));ctx.stroke();
      ctx.fillStyle='#352b2d';ctx.beginPath();ctx.arc(0,0,2,0,Math.PI*2);ctx.fill();
      ctx.restore();
      // A small digital readout below the analog face, specifically for
      // legibility at the 390px mobile breakpoint where the analog hands
      // alone would be too small to read at a glance.
      const label=clockTimeFmt.format(now);
      ctx.font='bold 11px monospace';ctx.textAlign='center';
      const width=ctx.measureText(label).width+14;
      ctx.fillStyle='#292635dc';ctx.fillRect(x-width/2,y+r+9,width,15);
      ctx.fillStyle='#f5e7d2';ctx.fillText(label,x,y+r+20);
    }
    const seatTargets=[];
    for(const s of layout.seats||[]){
      const f=fixtures.find(f=>f.id===s.furnitureId);
      const label=`Sit — ${f?.kind==='stool'?'bar stool':'dining chair'} ${s.id}`;
      const button=el('button',{class:'seat-target','aria-label':label,'data-hint':'Sit down',title:'Sit down',onclick:()=>{
        if(!mine||overlay.childElementCount)return;
        // A seat-target button is a separate DOM element layered over the
        // canvas — it never goes through the canvas's own click handler,
        // so the same player-click-takes-priority rule (part 2) has to be
        // repeated here: someone actually seated there is walked up to,
        // never just refused as "taken".
        const occupant=playerAt(s.x,s.y);
        if(occupant){approachPlayer(occupant);return;}
        beginSit(s);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    for(const s of layout.gameChairs||[]){
      const f=fixtures.find(f=>f.id===s.tableId);
      const button=el('button',{class:'seat-target','aria-label':`Choose ${s.color} seat — ${f.label}`,'data-hint':f.available?`Choose ${s.color} seat`:'Not yet open',title:f.available?`Choose ${s.color} seat`:'Not yet open',onclick:()=>{
        if(!mine||overlay.childElementCount)return;
        // A present game occupant's effective position is this exact
        // chair tile (src/position.ts) — clicking it walks up to them
        // (part 2's "real chair position, not a hidden lobby coordinate"
        // rule), same priority as any other player click, ahead of the
        // table dialog this chair would otherwise open.
        const occupant=playerAt(s.x,s.y);
        if(occupant){approachPlayer(occupant);return;}
        if(!f.available)toast.textContent=f.label;
        else if(f.tableMode==='npc')openNpcTableDialog(f,s.color);
        else openTableDialog(f,s.color);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    // The menu book's own clickable hotspot — a real DOM button layered
    // over the canvas, following the exact same "separate hitbox tracks
    // drawn art every frame, never routed through the canvas's own
    // click-to-tile handler" pattern every seat-target button above
    // already uses (CLAUDE.md: "the hit area must track the map's own
    // pan/zoom and never be a floating control independent of it"). No
    // hover-only text label sits over the book at rest — `data-hint`
    // only renders on `:hover`/`:focus-visible` (seat-target's own CSS,
    // reused here unmodified), and `title` gives the same text to a
    // touch/keyboard user who can't hover. Reachable by Tab (a real
    // `<button>`) and by a plain tap on mobile (CLAUDE.md: "must not
    // require hover to be discoverable").
    const menuBookButton=el('button',{class:'seat-target menu-book-target','aria-label':'Open the counter’s book','data-hint':'Open the book','title':'Open the book',onclick:()=>{
      if(!mine||overlay.childElementCount)return;
      openMenuBook();
    }});
    seatLayer.appendChild(menuBookButton);
    const ctx=canvas.getContext('2d');
    let vw=window.innerWidth,vh=window.innerHeight;
    const resize=()=>{vw=window.innerWidth;vh=window.innerHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=vw*dpr;canvas.height=vh*dpr;canvas.style.width=vw+'px';canvas.style.height=vh+'px';ctx.setTransform(dpr,0,0,dpr,0,0);};resize();
    window.addEventListener('resize',resize);
    // Mirrors src/barLayout.ts's isWalkingFloor, from the same
    // FURNITURE list (fetched via GET /api/bar/layout) — a fixture with
    // blocksMovement:false (the restroom) is a walkable zone marker, not
    // an obstacle, same rule server-side, so the two can't disagree.
    function walkable(x,y) {return x>=0&&x<layout.gridCols&&y>=0&&y<layout.gridRows&&!fixtures.some(f=>f.blocksMovement!==false&&x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h)&&![...(layout.seats||[]),...(layout.gameChairs||[])].some(s=>s.x===x&&s.y===y);}
    function canStep(x,y){return walkable(x,y)&&!occupiedByOther(x,y)&&(!(x!==mine.x&&y!==mine.y)||(walkable(mine.x,y)&&walkable(x,mine.y)));}
    // Product-direction-update, part 2: no two patrons may occupy the
    // same tile. `state.players` already reports each online patron's
    // *effective* position (src/position.ts — a present game-table
    // occupant's real chair tile, never a frozen pre-game coordinate),
    // so this single check is correct for a standing bar patron and a
    // seated game occupant alike, with no special-casing between them.
    function occupiedByOther(x,y){return state.players.some(p=>mine&&p.id!==mine.id&&p.x===x&&p.y===y);}
    // Which other online patron (if any) is standing at this exact tile —
    // used to give a player-click priority over the floor/furniture/seat
    // beneath them, the same lookup reused by every click surface below
    // (the canvas itself, a seat-target button, a game-chair button) so
    // the three can't drift into disagreeing about who's clickable where.
    function playerAt(x,y){return state.players.find(p=>mine&&p.id!==mine.id&&p.x===x&&p.y===y);}
    // Breadth-first path on a small grid; each submitted step is still checked
    // server-side. No client teleport, no optimistic persistent positions.
    // Avoids every other patron's current tile, not just furniture — a
    // path is never planned straight through someone else's body.
    function findPath(tx,ty) {
      if(!mine||!walkable(tx,ty)||occupiedByOther(tx,ty))return [];
      const start=`${mine.x},${mine.y}`,end=`${tx},${ty}`,q=[[mine.x,mine.y]],prev=new Map([[start,null]]);
      for(let i=0;i<q.length;i++){const [x,y]=q[i];if(`${x},${y}`===end)break;
        for(const [dx,dy] of [[0,-1],[1,0],[0,1],[-1,0]]){const nx=x+dx,ny=y+dy,k=`${nx},${ny}`;if(walkable(nx,ny)&&!occupiedByOther(nx,ny)&&!prev.has(k)){prev.set(k,`${x},${y}`);q.push([nx,ny]);}}
      }
      if(!prev.has(end))return [];const result=[];let key=end;while(key!==start){result.unshift(key.split(',').map(Number));key=prev.get(key);}return result;
    }
    function queueStep(dx,dy){if(!mine||moving||overlay.childElementCount)return;const x=mine.x+dx,y=mine.y+dy;if(canStep(x,y)){pendingSitSeat=null;approachTarget=null;path=[[x,y]];destination={x,y};}}
    // The one free-adjacent-tile picker behind both "click an occupied
    // floor tile" (part 2) and "click a nearby player to chat" (part 3):
    // among the up to 4 cardinal neighbours of (tx,ty) that are actually
    // walkable, unoccupied, and in bounds, picks whichever is closest
    // (Manhattan) to the mover's own current position — the side nearest
    // the clicker when one exists, and simply the nearest reachable
    // fallback otherwise. Never the target's own tile: a click never
    // walks *into* someone, only up next to them. Returns null if every
    // neighbour is blocked.
    function findApproachTile(tx,ty){
      if(!mine)return null;
      const candidates=[[0,-1],[0,1],[-1,0],[1,0]].map(([dx,dy])=>({x:tx+dx,y:ty+dy}))
        .filter(c=>walkable(c.x,c.y)&&!occupiedByOther(c.x,c.y));
      if(!candidates.length)return null;
      candidates.sort((a,b)=>(Math.abs(a.x-mine.x)+Math.abs(a.y-mine.y))-(Math.abs(b.x-mine.x)+Math.abs(b.y-mine.y)));
      return candidates.find(c=>(c.x===mine.x&&c.y===mine.y)||findPath(c.x,c.y).length)||null;
    }
    function manhattan(ax,ay,bx,by){return Math.abs(ax-bx)+Math.abs(ay-by);}
    // Phase 2 (product-direction-update): "click an empty chair, walk
    // there, sit down" is one gesture — if already beside the chair,
    // sit immediately; otherwise path to adjacent clear floor first
    // (ordinary, server-validated step by step) and let step() below
    // finish the gesture once it confirms arrival.
    function beginSit(seat){
      if(!mine||overlay.childElementCount)return;
      if(manhattan(mine.x,mine.y,seat.x,seat.y)<=1){
        path=[];destination=null;pendingSitSeat=null;
        post(`/seats/${seat.id}/sit`,session).then(resp=>{applyIncoming(resp);toast.textContent='Seated — use Stand up to leave the chair.';}).catch(e=>{toast.textContent=e.message||'Could not sit down';});
        return;
      }
      const approach=findApproachTile(seat.x,seat.y);
      if(!approach){toast.textContent='No clear space beside this chair.';return;}
      pendingSitSeat=seat;path=findPath(approach.x,approach.y);destination=path.length?approach:null;
      if(!path.length)pendingSitSeat=null;
    }
    // Product-direction-update, part 2: clicking a player walks up to a
    // free adjacent tile rather than into them — never a chat trigger
    // (that was part 3's own, now superseded by public speech bubbles;
    // see CLAUDE.md's "Public tavern speech" section for the history).
    function approachPlayer(player){
      if(!mine||overlay.childElementCount||player.id===mine.id)return;
      if(manhattan(mine.x,mine.y,player.x,player.y)<=1)return; // already adjacent — nothing more to do
      const approach=findApproachTile(player.x,player.y);
      if(!approach){toast.textContent="Can't reach them right now.";return;}
      pendingSitSeat=null;
      approachTarget={playerId:player.id,approach,targetX:player.x,targetY:player.y,attempts:0};
      path=findPath(approach.x,approach.y);destination=path.length?approach:null;
      if(!path.length){approachTarget=null;toast.textContent="Can't reach them right now.";}
    }
    function reconcile(next){
      state=next;
      mine=state.players.find(p=>p.id===session?.playerId)||mine;
      if(pendingMoveTarget&&mine)mine={...mine,x:pendingMoveTarget.x,y:pendingMoveTarget.y};
      online.textContent=`${state.players.length} here`;
      standBtn.style.display=mine?.seatId?'':'none';
      // Server-computed, read-only — rendered straight from the public
      // snapshot's own stamina field, never written back anywhere.
      if(typeof mine?.stamina==='number'){
        const pct=Math.round(mine.stamina);
        staminaFill.style.width=`${Math.max(0,Math.min(100,pct))}%`;
        staminaLabel.textContent=`${pct}%`;
        staminaButton.classList.toggle('stamina-low',pct<20);
        // A gentle, one-time nudge per low-stamina stretch — never a
        // forced action (CLAUDE.md: stamina never blocks a roll, a bet,
        // or walking to the counter). Resets once stamina rises back
        // above the threshold (eating/drinking, or simply time passing
        // differently), so a second genuine dip is nudged again rather
        // than only ever once per whole session.
        if(pct<20&&!lowStaminaNotified){lowStaminaNotified=true;toast.textContent='Getting low on energy — the counter has meals and drinks.';}
        else if(pct>=20)lowStaminaNotified=false;
      }
    }
    // The staleness rule for this channel: public/liveSync.js's
    // shouldApplyLiveUpdate, shared with app.js (see this file's own doc
    // comment for the full contract). A late-arriving stale response and
    // two near-simultaneous updates racing each other are handled by the
    // plain seq comparison, same as before; the epoch check is what
    // additionally survives a real server restart mid-session (seq alone
    // can't — a restarted process's seq legitimately restarts at 0,
    // which a bare "incoming<=lastSeq" rule would reject forever).
    function applyIncoming(next){
      if(typeof next.epoch==='number'&&typeof next.seq==='number'){
        const incoming={epoch:next.epoch,seq:next.seq};
        if(!shouldApplyLiveUpdate(liveCursor,incoming))return;
        liveCursor=incoming;
      }
      reconcile(next);
    }
    async function fetchAndApply(){if(!session)return;try{applyIncoming(await read('/state'));}catch(e){toast.textContent='Connection interrupted — retrying…';}}
    function connectEvents(){
      if(eventSource)eventSource.close();
      const es=new EventSource('/api/bar/events');
      es.onmessage=ev=>{try{applyIncoming(JSON.parse(ev.data));}catch{}};
      // Fires on first connect *and* every automatic reconnect — either
      // way, one unconditional fresh fetch rather than trusting nothing
      // was missed while the connection was down.
      es.onopen=()=>{fetchAndApply();};
      eventSource=es;
    }
    function openGames(){
      path=[];
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':'Game rooms'},[
        el('button',{class:'dialog-close','aria-label':'Close game rooms',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'PULL UP A CHAIR'),buildClassicPanel(),
      ]));
    }
    // Phase 2: each Vegas fixture is bound to its own independent room
    // (src/tables.ts), not a generic "create a room" form — this reads
    // that table's *current* status fresh on every click (not a cached
    // guess) and offers exactly the one legal action for it. The bar
    // nickname is reused automatically (never re-asked); only a game
    // colour — a different, smaller palette from the bar's own — is
    // chosen here, and taken colours at a waiting table are disabled
    // rather than left to fail server-side.
    // 5, not 4 — the official rulebook ships 5 player colours' worth of
    // dice (see src/rooms.ts's MAX_PLAYERS comment); this mirrors that
    // server-side constant, with no shared module linking the two (a
    // pre-existing risk, not new — spec/tables.test.ts exercises the
    // real server-side limit regardless of what this list says).
    const GAME_COLORS=['red','blue','green','yellow','purple'];
    const MAX_SEATS=GAME_COLORS.length;
    async function openTableDialog(f,preferredColor){
      if(f.gameType==='texas'){window.dispatchEvent(new CustomEvent('poker-open',{detail:{mode:'online',seat:preferredColor}}));return;}
      path=[];
      let tableList;
      try{tableList=await read('/tables');}catch(e){toast.textContent='Could not reach the tables — try again.';return;}
      const t=tableList.find(x=>x.id===f.id);
      if(!t){toast.textContent='That table is not available.';return;}

      const taken=new Set(t.takenColors||[]);
      if(preferredColor&&taken.has(preferredColor)){toast.textContent='That chair is occupied. Choose another chair.';return;}
      let selected=preferredColor&&!taken.has(preferredColor)?preferredColor:GAME_COLORS.find(c=>!taken.has(c))||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const isEmpty=t.status==='empty';
      const isWaiting=t.status==='waiting';
      const roomFull=t.playerCount>=MAX_SEATS;
      // Phase 3 (product-direction-update): the first person to open an
      // empty table is seated immediately as host; everyone after that
      // submits a request the host approves or declines — never an
      // immediate seat (CLAUDE.md's leave/exit states section references
      // this same split). A waiting table that's already full can't even
      // accept a new request.
      const canAct=isEmpty||(isWaiting&&!roomFull);

      const swatches=el('div',{class:'avatar-swatches','aria-label':'Table colour (seat preview)'},GAME_COLORS.map(c=>
        el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,disabled:taken.has(c),
          'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
          onclick:e=>{if(taken.has(c))return;selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
        },'')));

      const statusLine=isEmpty?`${f.label} is empty.`
        :`${f.label} — ${t.playerCount}/${MAX_SEATS} ${isWaiting?'waiting to start':t.status==='in_progress'?'mid-game':'round over'}.`;
      const pendingNote=t.pendingCount>0?` (${t.pendingCount} waiting for the host's approval)`:'';
      const subtitle=isEmpty
        ? `Starting as ${mine?.nickname??'you'} — just pick a table colour, and you're the host.`
        : isWaiting
          ? (roomFull
              ? `This table already has its ${MAX_SEATS} players.${pendingNote}`
              : `Pick a colour to request a seat — the host approves or declines it.${pendingNote}`)
          : t.status==='in_progress'
            ? "This table is already playing — ask to be invited, or wait for it to finish."
            : "This round is over. Whoever's hosting can disband it to free the table.";

      const body=[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'VEGAS DICE'),el('h1',{},statusLine),
        el('p',{class:'dialog-subtitle'},subtitle),
      ];
      if(canAct){
        body.push(swatches,error,el('button',{class:'enter-world',onclick:async e=>{
          const btn=e.currentTarget;btn.disabled=true;error.textContent='';
          try{
            const endpoint=isEmpty?'create':'join';
            const result=await post(`/tables/${f.id}/${endpoint}`,{...session,color:selected});
            try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
            // A deliberate, explicit "heading back to this table" action —
            // clears any pending away-from-table departure (see
            // src/tables.ts's resumeActiveTable for why only an explicit
            // action like this one, never a passive heartbeat, may do so).
            await post('/resume',session);
            overlay.replaceChildren();
            navigate(`/?room=${result.code}`);
          }catch(err){error.textContent=err.message||'Could not join that table';btn.disabled=false;}
        }},isEmpty?'Start a game here':'Request to join'));
      }
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
    }
    // A solo NPC table (src/tables.ts's startNpcGame) is never a dialog
    // about a shared table's live status — there's no host, no waiting
    // list, no approval, and nobody else can ever show up here, so this
    // is a separate, simpler flow from openTableDialog above: pick a
    // colour, start immediately against 3 computer-controlled opponents.
    async function openNpcTableDialog(f,preferredColor){
      if(f.gameType==='texas'){window.dispatchEvent(new CustomEvent('poker-open',{detail:{mode:'offline',seat:preferredColor}}));return;}
      path=[];
      // Total players including the human (2-MAX_SEATS), defaulting to
      // the full table ("默认五人" — the product default, not a cap this
      // dialog invents: src/tables.ts's startNpcGame validates the real
      // range regardless of what this sends). Choosing a count narrows
      // the colour swatches below to the first `count` of them, so the
      // human's own colour choice and "how many NPCs" can never produce a
      // contradiction (e.g. picking a colour that a lower count would
      // have had to assign to an NPC seat instead).
      let count=MAX_SEATS;
      let selected=preferredColor||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const countRow=el('div',{class:'avatar-swatches','aria-label':'Total players, including you'});
      const swatchRow=el('div',{class:'avatar-swatches','aria-label':'Table colour (seat preview)'});
      const startBtn=el('button',{class:'enter-world',onclick:async e=>{
        const btn=e.currentTarget;btn.disabled=true;error.textContent='';
        try{
          const result=await post(`/tables/${f.id}/start-npc`,{...session,color:selected,playerCount:count});
          try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
          await post('/resume',session);
          overlay.replaceChildren();
          navigate(`/?room=${result.code}`);
        }catch(err){error.textContent=err.message||'Could not start that table';btn.disabled=false;}
      }},'');
      function renderCountRow(){
        countRow.replaceChildren(...Array.from({length:MAX_SEATS-1},(_,i)=>i+2).map(n=>
          el('button',{type:'button',class:'avatar-swatch count-swatch','aria-label':`${n} players`,
            'aria-pressed':n===count?'true':'false',
            onclick:()=>{
              count=n;
              if(!GAME_COLORS.slice(0,count).includes(selected))selected=GAME_COLORS[0];
              renderCountRow();renderSwatches();renderStart();
            },
          },String(n))));
      }
      function renderSwatches(){
        swatchRow.replaceChildren(...GAME_COLORS.slice(0,count).map(c=>
          el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,
            'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
            onclick:e=>{selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
          },'')));
      }
      function renderStart(){
        const npcCount=count-1;
        startBtn.textContent=`Play vs. ${npcCount} NPC${npcCount===1?'':'s'}`;
      }
      renderCountRow();renderSwatches();renderStart();
      const body=[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'VEGAS DICE · OFFLINE MODE'),el('h1',{},f.label),
        el('p',{class:'dialog-subtitle'},"Just you against computer-controlled opponents — starts right away, nobody else can join."),
        el('p',{class:'option-label'},'Players (including you)'),countRow,
        swatchRow,error,startBtn,
      ];
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
    }
    // ---- Public tavern speech (product-direction-update, part 3's
    // replacement for private 1:1 chat, after the student's own
    // acceptance testing — see CLAUDE.md's "Public tavern speech"
    // section) — a compact always-visible input, never a dialog, never
    // targeted at anyone: everyone watching the bar sees the bubble. ----
    //
    // A client-generated id per outgoing message (crypto.randomUUID when
    // available, a timestamp+random fallback otherwise — this only needs
    // to be unique per sender, never verified client-side) is what makes
    // a retried /say after a dropped response idempotent server-side
    // (src/bar.ts's say): the same id resent twice is the same logical
    // utterance, applied once, and must not restart the display clock.
    function newClientMsgId(){
      try{if(crypto.randomUUID)return crypto.randomUUID();}catch{}
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const speechInput=el('input',{class:'speech-input',placeholder:'Say something…',maxlength:'500','aria-label':'Say something to the tavern'});
    const speechSend=el('button',{class:'hud-button speech-send'},'Send');
    const speechBar=el('div',{class:'speech-bar'},[speechInput,speechSend]);
    speechBar.id='tavern-speech-input';speechBar.hidden=true;
    const speechToggle=el('button',{class:'speech-toggle','aria-label':'Open chat','aria-expanded':'false','aria-controls':speechBar.id,title:'Chat'},[el('span',{'aria-hidden':'true'},'•••')]);
    function toggleSpeech(open){
      speechBar.hidden=!open;speechToggle.setAttribute('aria-expanded',String(open));
      speechToggle.setAttribute('aria-label',open?'Close chat':'Open chat');
      keys.clear();heldDirection=null;path=[];
      if(open)speechInput.focus();else canvas.focus();
    }
    speechToggle.onclick=()=>toggleSpeech(speechBar.hidden);
    speechInput.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();toggleSpeech(false);}});
    async function doSay(){
      if(!mine)return;
      const text=speechInput.value.trim();
      if(!text)return;
      speechSend.disabled=true;
      try{
        applyIncoming(await post('/say',{...session,clientMsgId:newClientMsgId(),text}));
        speechInput.value='';
      }catch(e){toast.textContent=e.message||'Could not send that message';}
      speechSend.disabled=false;
    }
    speechSend.onclick=doSay;
    speechInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doSay();}});
    scene.append(speechBar,speechToggle);
    function chooseCharacter(){
      let color=mine?.color||'green',skin=mine?.skin||'warm';
      const preview=el('canvas',{width:'180',height:'180','aria-label':'Character preview'});
      function update(){const c=preview.getContext('2d');c.clearRect(0,0,180,180);c.imageSmoothingEnabled=false;sprite(c,90,148,colors[color],skins[skin],2.6);}
      const error=el('p',{class:'error',role:'alert'});
      const input=el('input',{placeholder:'Your nickname',id:'patron-nickname',maxlength:'20',required:true,autocomplete:'nickname',value:mine?.nickname||''});
      const makeChoices=(values,label,select)=>el('div',{class:'avatar-swatches','aria-label':label},Object.entries(values).map(([key,hex],i)=>el('button',{type:'button',class:'avatar-swatch','aria-label':`${label} ${key}`,'aria-pressed':(label==='Clothes'?key===color:key===skin)?'true':'false',style:`--swatch:${hex}`,onclick:e=>{select(key);for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');update();}},'')));
      const enter=el('button',{type:'submit',class:'enter-world'},'Step inside  →');
      const form=el('form',{class:'world-dialog avatar-dialog',role:'dialog','aria-label':'Create your character',onsubmit:async e=>{
        e.preventDefault();enter.disabled=true;error.textContent='';
        try{const appearance={nickname:input.value.trim(),color,skin};let resp;if(session){resp=await post('/appearance',{...session,...appearance});applyIncoming(resp);session={...session,...appearance};}else{resp=await post('/join',appearance);session={...resp,...appearance};}activeSeat=resp.activeSeat??null;try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}overlay.replaceChildren();applyIncoming(await read('/state'));begin();}
        catch(err){error.textContent=err.message||'Could not enter';enter.disabled=false;}
      }},[
        el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Come as you are.'),el('p',{class:'dialog-subtitle'},'Make yourself a little character. Your friends are inside.'),
        el('div',{class:'avatar-editor'},[el('div',{class:'avatar-preview'},[preview,el('span',{},'YOUR LITTLE SELF')]),el('div',{class:'avatar-options'},[
          el('label',{for:'patron-nickname'},'What should we call you?'),input,
          el('span',{class:'option-label'},'Clothes'),makeChoices(colors,'Clothes',v=>color=v),
          el('span',{class:'option-label'},'Skin tone'),makeChoices(skins,'Skin',v=>skin=v),
          // Server-computed, read-only (CLAUDE.md's "Stamina" section) —
          // no input element at all, so there is no path through this
          // form's own submit handler (which only ever sends nickname/
          // color/skin) that could set it. Only shown for a returning
          // identity that already has a stamina value to report; a
          // brand-new join hasn't been created yet at the point this
          // dialog first renders, so there's nothing real to show.
          ...(typeof mine?.stamina==='number'?[
            el('span',{class:'option-label'},'Stamina'),
            el('div',{class:'stamina-panel'},[
              el('div',{class:'stamina-track stamina-track-large'},[el('span',{class:'stamina-fill',style:`width:${Math.max(0,Math.min(100,Math.round(mine.stamina)))}%`})]),
              el('span',{class:'stamina-panel-pct'},`${Math.round(mine.stamina)}%`),
              el('p',{class:'stamina-note'},'Eating a meal restores +70%, a drink +30% — both cap at 100%, with nothing stored for later.'),
            ]),
          ]:[]),
        ])]),error,enter,el('p',{class:'dialog-footnote'},'No account needed. Your character stays in this browser.'),
      ]);overlay.replaceChildren(form);update();input.focus();
    }
    function begin(){
      enteredThisPage=true;
      if(timers.length||!active)return;
      if(mine){session={...session,nickname:mine.nickname,color:mine.color,skin:mine.skin};try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}}
      post('/heartbeat',session).catch(()=>{});
      connectEvents();fetchAndApply();
      // 10s fallback poll — cheap insurance if the stream silently
      // stalls without EventSource noticing; gated through the same
      // seq check above, so it's a no-op whenever the stream is doing
      // its job.
      timers.push(setInterval(()=>post('/heartbeat',session).then(resp=>{
        activeSeat=resp.activeSeat??null;
        if(!activeSeat&&returnGameButton){returnGameButton.remove();returnGameButton=null;}
      }).catch(()=>{}),5000),setInterval(fetchAndApply,10000));
      visibilityHandler=()=>{
        if(document.visibilityState!=='visible')return;
        // A backgrounded tab can have its EventSource suspended by the
        // browser; coming back is exactly when a stale view would
        // otherwise sit unnoticed.
        if(!eventSource||eventSource.readyState===EventSource.CLOSED)connectEvents();
        fetchAndApply();
      };
      document.addEventListener('visibilitychange',visibilityHandler);
      window.addEventListener('focus',visibilityHandler);
      // Driven by the server's own re-validated activeSeat, never a
      // locally-cached room code — a closed, left, or expired room, or a
      // different character's game entirely, is never offered here.
      if(activeSeat){returnGameButton=el('button',{class:'hud-button',onclick:async()=>{
        // Clicking this is exactly "I'm deliberately going back to my
        // table" — clears any pending away-from-table departure (see
        // src/tables.ts's resumeActiveTable: only an explicit action like
        // this one may do so, never a passive heartbeat).
        try{
          const response=await post('/resume',session);activeSeat=response.activeSeat??null;
          if(!activeSeat){returnGameButton?.remove();returnGameButton=null;toast.textContent='Your previous game has ended.';return;}
          navigate(`/?room=${activeSeat.roomCode}`);
        }catch(error){toast.textContent=error.message||'Could not return to the game';}
      }},'Return to your game');hud.querySelector('.hud-actions').appendChild(returnGameButton);}
      toast.textContent='Welcome in. WASD / arrows to walk · click a destination';canvas.focus();
    }
    const keyDown=e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName)||overlay.childElementCount)return;const key=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();keys.add(key);path=[];pendingSitSeat=null;approachTarget=null;}if(e.key==='Escape'){path=[];destination=null;pendingSitSeat=null;approachTarget=null;}};
    const keyUp=e=>keys.delete(e.key.toLowerCase());const blur=()=>{keys.clear();heldDirection=null;path=[];pendingSitSeat=null;approachTarget=null;};
    window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);
    canvas.addEventListener('click',e=>{
      if(!mine||overlay.childElementCount)return;const rect=canvas.getBoundingClientRect(),x=Math.floor((e.clientX-rect.left+camera.x)/tile),y=Math.floor((e.clientY-rect.top+camera.y)/tile);
      // A player's own tile takes priority over whatever floor, seat, or
      // table is underneath them (product-direction-update, part 2) —
      // clicking yourself is a deliberate no-op. Checked first, before
      // any furniture/seat logic below.
      if(x===mine.x&&y===mine.y)return;
      const other=playerAt(x,y);
      if(other){approachPlayer(other);return;}
      const f=fixtures.find(f=>x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);
      // A walkable-zone fixture (blocksMovement:false — the restroom)
      // falls through to the normal walk/pathfinding below, same as any
      // other floor tile; only a genuinely non-walkable, interactive
      // fixture (a table, the counter) intercepts the click for its own
      // dialog/message instead.
      if(f&&f.blocksMovement!==false){
        if(f.kind==='game_table'){if(!f.available)toast.textContent=`${f.label}`;else if(f.tableMode==='npc')openNpcTableDialog(f);else openTableDialog(f);}
        else if(f.kind==='counter'){
          // The book itself is the one click target for the menu
          // (CLAUDE.md: "the book is the click target, not a separate
          // floating button") — clicking the rest of the counter's long
          // surface is just a gentle pointer toward it, never a second
          // way to open the menu.
          toast.textContent='The book on the counter opens the menu.';
        }
        else if(f.kind==='stool'||f.kind==='dining_table'){
          // Phase 2: a real seat — pick the nearest free one belonging to
          // this fixture (its own x/y distance to where this patron is
          // standing right now, not path length, which is a reasonable,
          // cheap approximation for "nearest" on this small a grid).
          const seats=(layout.seats||[]).filter(s=>s.furnitureId===f.id);
          const free=seats.filter(s=>!state.players.some(p=>p.seatId===s.id));
          if(!free.length){toast.textContent='No free seat there.';return;}
          free.sort((a,b)=>(Math.abs(a.x-mine.x)+Math.abs(a.y-mine.y))-(Math.abs(b.x-mine.x)+Math.abs(b.y-mine.y)));
          beginSit(free[0]);
        }
        return;
      }
      // A bare seat tile, clicked directly rather than via its furniture —
      // still sittable (the same tile beginSit would compute), as long as
      // it's actually free.
      const seat=(layout.seats||[]).find(s=>s.x===x&&s.y===y);
      if(seat){
        if(state.players.some(p=>p.seatId===seat.id&&p.id!==mine.id)){toast.textContent='Someone is already sitting there.';return;}
        beginSit(seat);
        return;
      }
      pendingSitSeat=null;approachTarget=null;path=findPath(x,y);destination=path.length?{x,y}:null;
    });
    async function step(x,y){
      moving=true;movementEpoch++;pendingMoveTarget={x,y};
      try{
        const next=await post('/move',{playerId:session.playerId,sessionSecret:session.sessionSecret,x,y});
        pendingMoveTarget=null;if(active)applyIncoming(next);
        // Arrived at the tile a click-to-sit gesture was walking toward —
        // finish it with the real, separately-validated sit call (beginSit).
        if(pendingSitSeat&&manhattan(pendingSitSeat.x,pendingSitSeat.y,x,y)===1){
          path=[];destination=null;
          const seat=pendingSitSeat;pendingSitSeat=null;
          try{applyIncoming(await post(`/seats/${seat.id}/sit`,session));toast.textContent='Seated — use Stand up to leave the chair.';}
          catch(err){toast.textContent=err.message||'Could not sit down';}
        }
        // Arrived at the approach tile a "walk up to this player" gesture
        // was heading toward — nothing further happens on arrival (no
        // chat to open; that side effect was removed along with the
        // private chat dialog), just clear the in-flight marker.
        if(approachTarget&&approachTarget.approach.x===x&&approachTarget.approach.y===y){
          approachTarget=null;
        }
      }
      catch(e){pendingMoveTarget=null;path=[];destination=null;pendingSitSeat=null;approachTarget=null;toast.textContent=e.status===403?'Your session could not be restored. Reload to rejoin.':'Could not move — try again.';await fetchAndApply();}
      finally{moving=false;}
    }
    // A static world layer is painted once, not rebuilt on every animation frame.
    const floor=document.createElement('canvas');floor.width=worldW;floor.height=worldH;const fc=floor.getContext('2d');
    const box=(c,x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
    box(fc,0,0,worldW,worldH,'#533c34');
    for(let y=0;y<layout.gridRows;y++)for(let x=0;x<layout.gridCols;x++){
      const px=x*tile,py=y*tile;box(fc,px,py,tile,tile,['#76513e','#7d5742','#825b45'][(x*7+y*3)%3]);
      box(fc,px,py,tile,2,'#482f28');box(fc,px+2,py+31,tile-4,1,'#956c4e');
      box(fc,px+((y%2)*21),py,2,tile,'#573c30');
      box(fc,px+12,py+13,23,1,'#ffffff09');box(fc,px+31,py+47,20,1,'#38281b20');
    }
    // Brick back wall, beams, and a back-bar liquor cabinet.
    box(fc,0,0,worldW,128,'#473943');
    for(let y=0;y<4;y++)for(let x=0;x<40;x++){box(fc,x*64+(y%2)*32,y*24,60,21,['#67504a','#5e4848','#71564a'][(x+y)%3]);}
    box(fc,0,96,worldW,32,'#332a31');box(fc,0,98,worldW,5,'#a07a4d');
    // Behind the serving counter is a back-bar cabinet/kitchen, not a
    // window to the outside — a window there made no architectural sense
    // (the counter already fills this wall). Dark wood frame around two
    // interior shelves lined with bottles, matching the counter's own
    // bottle silhouettes just below it.
    const cabinetBottle=(c,x,bottomY,i)=>{
      const body=['#729f80','#9c6848','#b78a59','#5e7d9e','#8a594c'][i%5];
      box(c,x,bottomY-16,9,16,body);box(c,x+2,bottomY-22,5,7,'#d8b873');box(c,x+1,bottomY-24,7,3,'#3b2f29');
    };
    for(const x of [256,768,1536,2112]){
      box(fc,x,24,130,74,'#6b4635');box(fc,x+6,30,118,62,'#2e211d');
      box(fc,x+6,50,118,3,'#8a5f3f');box(fc,x+6,72,118,3,'#8a5f3f');
      let i=0;
      for(const bottomY of [50,72,92])for(let bx=x+14;bx<x+118;bx+=20)cabinetBottle(fc,bx,bottomY,i++);
    }
    // One window in each gap between the far-back cabinet units.
    for(const x of [256,768,1536].map((x,i)=>(x+130+[768,1536,2112][i])/2-42)){
      box(fc,x,18,84,78,'#302c32');box(fc,x+5,23,74,68,'#b98b60');
      box(fc,x+10,28,64,58,'#405d70');box(fc,x+14,32,24,50,'#7393a0');
      box(fc,x+40,28,4,58,'#bc9165');box(fc,x+10,54,64,4,'#bc9165');
      box(fc,x-5,91,94,7,'#d0a171');
    }
    const rug=(x,y,w,h)=>{box(fc,x,y,w,h,'#8d4545');box(fc,x+6,y+6,w-12,h-12,'#ad7054');box(fc,x+12,y+12,w-24,h-24,'#864347');for(let a=x+24;a<x+w-12;a+=24)box(fc,a,y+20,8,8,'#c39968');};
    // One dining-room rug, sized and centred from the four dining tables'
    // own real bounding box (tables + their seats) rather than hand-typed
    // literals — the two rugs this replaces were positioned by guesswork
    // (one sat stranded between the game-table rows, the other only
    // partly under one dining table) and the student's own screenshot
    // flagged the stray one directly. A fixed margin on every side keeps
    // it clear of the tables' own seat-approach tiles. Drawn in this
    // static floor layer, under every fixture, so it never affects
    // movement (a rug has never been checked by isWalkable).
    {
      const diningFixtures=fixtures.filter(f=>f.kind==='dining_table');
      const diningSeats=(layout.seats||[]).filter(s=>diningFixtures.some(f=>f.id===s.furnitureId));
      const minX=Math.min(...diningFixtures.map(f=>f.x),...diningSeats.map(s=>s.x));
      const maxX=Math.max(...diningFixtures.map(f=>f.x+f.w),...diningSeats.map(s=>s.x+1));
      const minY=Math.min(...diningFixtures.map(f=>f.y),...diningSeats.map(s=>s.y));
      const maxY=Math.max(...diningFixtures.map(f=>f.y+f.h),...diningSeats.map(s=>s.y+1));
      const margin=0.6*tile;
      rug(minX*tile-margin,minY*tile-margin,(maxX-minX)*tile+margin*2,(maxY-minY)*tile+margin*2);
    }
    function plant(x,y){box(fc,x-13,y-19,26,22,'#b67b58');box(fc,x-15,y-23,30,8,'#d29a6e');for(const [dx,dy] of [[-12,-42],[2,-49],[-4,-61],[14,-38]]){box(fc,x+dx-7,y+dy,14,25,'#527c5a');box(fc,x+dx-3,y+dy,4,19,'#7ca472');}}
    // A closed book lying flat on the counter — the menu's own in-scene
    // entry point (CLAUDE.md: a recognisable book on the counter, not a
    // floating HUD button). Drawn here, in the static floor layer
    // (baked once, same as the counter itself), with warm-brown leather
    // covers and visible cream page edges so it reads clearly against
    // the counter's own wood tones without needing a label to explain
    // itself. (x,y) is the book's own centre; the interactive hotspot
    // that makes it clickable is a separate DOM button positioned over
    // this same art every frame, exactly like every seat-target button
    // in this file already is — never re-registered on the canvas's own
    // click handler, which only resolves grid tiles, not book-shaped art.
    function drawMenuBookArt(c,x,y){
      // An open book lying flat, viewed top-down: two cream pages split by
      // a dark gutter, a thin leather cover border, faint text-line rules,
      // and a hanging ribbon bookmark for a colour accent that reads at a
      // glance — the earlier closed-book-on-an-easel silhouette tested as
      // a picture frame, not a book, once zoomed (caught by direct
      // screenshot review, not just "the art exists").
      const w=40,h=30;
      c.save();c.translate(Math.round(x),Math.round(y));
      c.fillStyle='#00000035';c.beginPath();c.ellipse(1,h/2+2,w/2+3,6,0,0,Math.PI*2);c.fill();
      // Leather cover border, visible all around the pages.
      box(c,-w/2,-h/2,w,h,'#5a3824');
      // Two open pages, cream, inset from the cover with a dark centre gutter.
      const pagePad=3,gutter=2.5;
      const pageW=(w-pagePad*2-gutter)/2;
      box(c,-w/2+pagePad,-h/2+pagePad,pageW,h-pagePad*2,'#f6ecd4');
      box(c,gutter/2,-h/2+pagePad,pageW,h-pagePad*2,'#f6ecd4');
      box(c,-gutter/2,-h/2+pagePad,gutter,h-pagePad*2,'#8a6a4a');
      // Faint text-line rules on each page.
      c.fillStyle='#cbb98f';
      for(let i=0;i<4;i++){
        const ly=-h/2+pagePad+6+i*5;
        box(c,-w/2+pagePad+3,ly,pageW-6,1.4,'#cbb98f');
        box(c,gutter/2+3,ly,pageW-6,1.4,'#cbb98f');
      }
      // A small warm-gold ribbon bookmark hanging over the top edge — the
      // one spot of saturated colour that makes the shape pop against the
      // counter's own browns at a glance, on the page side (not the
      // gutter) so it doesn't read as a spine decoration instead.
      box(c,pageW*0.35,-h/2-3,4,h*0.55,'#c23b3b');
      box(c,pageW*0.35,h*0.05,4,5,'#8a2525');
      c.restore();
    }
    const bookHotspotHalfW=26,bookHotspotHalfH=20;
    // The original room is dressed as a room, rather than bare shapes on
    // endless floor. Empty surrounding world space can host later extensions.
    const wallX=8*tile,wallY=5*tile,wallW=24*tile;
    box(fc,wallX,wallY,wallW,88,'#4b363d');
    for(let row=0;row<3;row++)for(let col=0;col<24;col++)box(fc,wallX+col*tile+(row%2)*24,wallY+row*24,60,20,['#705147','#634844','#78584a'][(row+col)%3]);
    box(fc,wallX,wallY+72,wallW,16,'#322b32');box(fc,wallX,wallY+73,wallW,4,'#ba8a57');
    // This inner wall strip sits directly above the serving counter —
    // originally four more windows, which made no architectural sense
    // right behind a bar counter (the student's own screenshot flagged
    // this). Replaced with small hanging shelf/cabinet units, matching
    // the back-bar cabinet motif used on the outer brick wall above.
    for(const wx of [11,17,24,29]){
      box(fc,wx*tile,wallY+10,90,53,'#6b4635');box(fc,wx*tile+6,wallY+16,78,40,'#2e211d');
      box(fc,wx*tile+6,wallY+30,78,3,'#8a5f3f');
      for(let i=0,bx=wx*tile+14;bx<wx*tile+84;bx+=20,i++){
        const body=['#729f80','#9c6848','#b78a59','#5e7d9e'][i%4];
        box(fc,bx,wallY+40,8,13,body);box(fc,bx+1,wallY+34,5,6,'#d8b873');
      }
    }
    // Corner plants are pure decoration, far from any furniture — left as
    // hand-placed art, never implicated in the chair-overlap bug. The
    // four plants near the game-table rows are now real FURNITURE
    // fixtures (src/barLayout.ts's "plant" kind) drawn from the fixtures
    // loop below instead of hand-typed pixel literals here, so their
    // drawn position always matches their actual shared collision tile.
    for(const [x,y] of [[100,170],[worldW-100,170],[120,worldH-110],[worldW-120,worldH-110]])plant(x,y);
    for(const f of fixtures){const x=f.x*tile,y=f.y*tile,w=f.w*tile,h=f.h*tile;
      if(f.kind==='cabinet_wall'){
        // Painted above; this shared fixture supplies its collision footprint.
      }else if(f.kind==='plant'){
        plant(x+tile/2,y+tile*0.82);
      }else if(f.kind==='counter'){
        box(fc,x-3,y+9,w+6,h,'#37282b');box(fc,x,y+5,w,h-10,'#b58153');box(fc,x,y+13,w,5,'#dfb979');box(fc,x,y+h-8,w,8,'#6b4635');
        for(let i=12;i<w;i+=64){box(fc,x+i,y+29,46,25,'#815636');box(fc,x+i+2,y+30,42,2,'#cf9c5e');}
        for(let i=32;i<w;i+=80){box(fc,x+i,y-24,9,22,'#729f80');box(fc,x+i+2,y-29,5,6,'#d8b873');box(fc,x+i+14,y-15,7,13,'#ddc6a0');}
        fc.font='bold 17px monospace';fc.textAlign='center';fc.fillStyle='#e4bf7e';fc.fillText('Las Vegas',x+w/2,y-43);
        drawMenuBookArt(fc,bookWorldX,bookWorldY);
      }else if(f.kind==='stool'){
        // Drawn below from the same seat tile the player can click.
      }else if(f.kind==='restroom'){
        // A walkable alcove, not an obstacle — a floor-level marker only
        // (no raised/blocking shape like a table): a faint floor patch,
        // a door frame on the south edge patrons actually approach from,
        // and a hanging sign. Same box()-primitive pixel style as every
        // other fixture here, nothing imported (CLAUDE.md).
        box(fc,x-4,y-4,w+8,h+8,'#352b2d2e');
        const doorX=x+w/2-14;
        box(fc,doorX,y+h-6,28,10,'#43302d');box(fc,doorX+4,y+h-4,20,6,'#1c1620');
        box(fc,x+w/2-34,y-18,68,16,'#37282b');box(fc,x+w/2-30,y-15,60,10,'#e4bf7e');
        fc.font='bold 10px monospace';fc.textAlign='center';fc.fillStyle='#352b2d';fc.fillText('RESTROOM',x+w/2,y-7);
      }else if(f.kind==='game_table'&&f.gameType==='vegas'){
        const cx=x+w/2,cy=y+h/2,r=w/2;
        fc.beginPath();fc.ellipse(cx,cy+10,r+5,r*.86,0,0,Math.PI*2);fc.fillStyle='#392822';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r,0,Math.PI*2);fc.fillStyle='#b78a59';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r-9,0,Math.PI*2);fc.fillStyle='#396c58';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r-14,0,Math.PI*2);fc.strokeStyle='#bcad7770';fc.lineWidth=2;fc.stroke();
        fc.fillStyle='#eadcc5';for(let i=0;i<3;i++){box(fc,cx-28+i*21,cy-21,15,21,'#eadcc5');box(fc,cx-23+i*21,cy-14,5,5,'#8a594c');}
        fc.font='bold 10px monospace';fc.textAlign='center';fc.fillStyle='#f7e6c6';fc.fillText(f.label,cx,cy+28);
      }else{
        box(fc,x-5,y+12,w+10,h,'#382a2d');box(fc,x-6,y,w+12,h,'#b78a59');box(fc,x,y+6,w,h-12,f.kind==='game_table'?(f.available?'#487c69':'#665969'):'#9c6848');
        box(fc,x+6,y+12,w-12,3,'#ffffff19');
        if(f.kind==='game_table'){
          for(let i=0;i<3;i++){box(fc,x+30+i*23,y+33,17,26,'#eadcc5');box(fc,x+34+i*23,y+41,7,7,i%2?'#c87769':'#4d515d');}
          fc.textAlign='center';fc.font='bold 12px monospace';fc.fillStyle='#f7e6c6';fc.fillText(f.gameType==='texas'?(f.tableMode==='npc'?'Hold’em Offline':'Hold’em Online'):f.available?f.label:f.gameType.toUpperCase(),x+w/2,y+h-26);
          if(!f.available){fc.fillStyle='#d0c0b1';fc.font='10px monospace';fc.fillText('COMING LATER',x+w/2,y+h-12);}
        }else{box(fc,x+43,y+35,28,24,'#eee0bd');box(fc,x+51,y+40,12,12,'#bd8253');box(fc,x+77,y+29,11,18,'#94b0a5');}
      }
    }
    function chair(c,x,y,accent){
      box(c,x+13,y+44,7,13,'#352b2d');box(c,x+44,y+44,7,13,'#352b2d');
      box(c,x+10,y+12,44,16,'#6a4938');box(c,x+13,y+14,38,8,'#d0a171');
      box(c,x+9,y+28,46,20,'#684638');box(c,x+12,y+29,40,14,accent||'#b78163');
      box(c,x+14,y+29,36,3,'#e1b985');
    }
    for(const s of layout.seats||[])chair(fc,s.x*tile,s.y*tile);
    for(const s of layout.gameChairs||[])chair(fc,((s.displayX??s.x+.5)-.5)*tile,((s.displayY??s.y+.5)-.5)*tile,colors[s.color]);
    // ---- Public speech bubbles (product-direction-update, part 3's
    // replacement for private chat) ----
    //
    // Canvas text has no built-in word-wrap, and this has to handle both
    // space-delimited English (wrap on word boundaries) and CJK/emoji/
    // long no-space tokens (wrap mid-word, by actual measured width, once
    // a single "word" alone already exceeds the max width) — a plain
    // split(' ') alone only handles the first case. Iterating a string
    // with for...of (not index/split('')) walks by Unicode code point,
    // so a surrogate-pair emoji is never cut in half mid-character.
    function wrapBubbleText(text,maxWidth){
      const lines=[];
      for(const para of text.split('\n')){
        if(para===''){lines.push('');continue;}
        let line='';
        for(const word of para.split(/(\s+)/)){
          if(word==='')continue;
          const candidate=line+word;
          if(ctx.measureText(candidate).width<=maxWidth||line===''){
            if(ctx.measureText(word).width>maxWidth){
              // The word itself is wider than the whole bubble (a long
              // CJK run, a long no-space token) — flush what's queued,
              // then break this one by character instead of by word.
              if(line){lines.push(line.trimEnd());line='';}
              let chunk='';
              for(const ch of word){
                if(chunk&&ctx.measureText(chunk+ch).width>maxWidth){lines.push(chunk);chunk=ch;}
                else chunk+=ch;
              }
              line=chunk;
            }else{
              line=candidate;
            }
          }else{
            lines.push(line.trimEnd());line=word;
          }
        }
        if(line)lines.push(line.trimEnd());
      }
      return lines;
    }
    function roundedRect(x,y,w,h,r){
      ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
    }
    const BUBBLE_MAX_WIDTH=240, BUBBLE_PAD=10, BUBBLE_LINE_H=16;
    // Drawn directly on the canvas, not a DOM element — it can never
    // intercept a click on the floor/a character/a chair underneath it,
    // since every click is resolved from grid coordinates alone,
    // independent of anything drawn (product-direction-update, part 3).
    // `anchorX,anchorBottomY` is the screen point the bubble's tail
    // points at (just above a nickname tag); clamped to stay on screen
    // (minus a small margin) so it's never cut off at an edge, with the
    // tail itself re-clamped to stay within the (possibly shifted) box.
    function drawSpeechBubble(anchorX,anchorBottomY,text){
      ctx.font='12px "Segoe UI Emoji",monospace';ctx.textAlign='left';
      const lines=wrapBubbleText(text,BUBBLE_MAX_WIDTH-BUBBLE_PAD*2);
      const contentWidth=Math.max(20,...lines.map(l=>ctx.measureText(l).width));
      const boxW=Math.min(BUBBLE_MAX_WIDTH,contentWidth+BUBBLE_PAD*2);
      const boxH=lines.length*BUBBLE_LINE_H+BUBBLE_PAD*2;
      const margin=8;
      const boxX=Math.max(margin,Math.min(vw-boxW-margin,anchorX-boxW/2));
      const boxY=Math.max(margin,anchorBottomY-boxH-9);
      ctx.fillStyle='rgba(32,30,38,0.82)';
      roundedRect(boxX,boxY,boxW,boxH,10);ctx.fill();
      const tailX=Math.max(boxX+12,Math.min(boxX+boxW-12,anchorX));
      ctx.beginPath();ctx.moveTo(tailX-7,boxY+boxH);ctx.lineTo(tailX+7,boxY+boxH);ctx.lineTo(tailX,boxY+boxH+8);ctx.closePath();ctx.fill();
      ctx.fillStyle='#ffffff';
      lines.forEach((line,i)=>ctx.fillText(line,boxX+BUBBLE_PAD,boxY+BUBBLE_PAD+(i+0.8)*BUBBLE_LINE_H));
      ctx.textAlign='center';
    }
    function animate(now){
      if(!active)return;frame=requestAnimationFrame(animate);
      if(session&&mine&&!moving&&now-lastTime>145&&!overlay.childElementCount){
        let dx=0,dy=0;if(keys.has('w')||keys.has('arrowup'))dy=-1;else if(keys.has('s')||keys.has('arrowdown'))dy=1;
        if(keys.has('a')||keys.has('arrowleft'))dx=-1;else if(keys.has('d')||keys.has('arrowright'))dx=1;
        if(heldDirection){dx=heldDirection.dx;dy=heldDirection.dy;}
        if(dx||dy){path=[];pendingSitSeat=null;approachTarget=null;if(canStep(mine.x+dx,mine.y+dy)){lastTime=now;step(mine.x+dx,mine.y+dy);}}
        else if(path.length){
          // A seat this patron is walking toward can be taken by someone
          // else mid-journey — stop the attempt and say so rather than
          // walking the rest of the way for nothing (the server would
          // refuse the final sit anyway, but catching it here is a
          // clearer, earlier signal than an error only at arrival).
          if(pendingSitSeat&&state.players.some(p=>p.seatId===pendingSitSeat.id&&p.id!==mine.id)){
            path=[];destination=null;pendingSitSeat=null;toast.textContent='Someone sat down there first.';
          }else if(approachTarget){
            // The person being approached can walk, log off, or (rarely)
            // have their old approach tile taken by someone else while
            // this patron is still en route — re-pathed a bounded number
            // of times (never an infinite chase), and abandoned outright
            // if they're simply gone.
            const target=state.players.find(p=>p.id===approachTarget.playerId);
            if(!target){
              path=[];destination=null;approachTarget=null;toast.textContent='They left the bar.';
            }else if(target.x!==approachTarget.targetX||target.y!==approachTarget.targetY){
              if(approachTarget.attempts>=3){
                path=[];destination=null;approachTarget=null;toast.textContent="They're moving around too much — try again.";
              }else{
                approachTarget.attempts++;approachTarget.targetX=target.x;approachTarget.targetY=target.y;
                const approach=findApproachTile(target.x,target.y);
                if(!approach){path=[];destination=null;approachTarget=null;toast.textContent="Can't reach them right now.";}
                else{
                  approachTarget.approach=approach;path=findPath(approach.x,approach.y);destination=path.length?approach:null;
                  if(!path.length){approachTarget=null;toast.textContent="Can't reach them right now.";}
                  else{lastTime=now;const [x,y]=path.shift();step(x,y);}
                }
              }
            }else{
              lastTime=now;const [x,y]=path.shift();step(x,y);
            }
          }else{
            lastTime=now;const [x,y]=path.shift();step(x,y);
          }
        }
        else destination=null;
      }
      const target=mine||{x:20,y:12};const desiredX=Math.max(0,Math.min(Math.max(0,worldW-vw),(target.x+.5)*tile-vw/2)),desiredY=Math.max(0,Math.min(Math.max(0,worldH-vh),(target.y+.5)*tile-vh/2));
      if(!cameraInitialized){camera={x:desiredX,y:desiredY};cameraInitialized=true;}else{camera.x+=(desiredX-camera.x)*.12;camera.y+=(desiredY-camera.y)*.12;}
      ctx.clearRect(0,0,vw,vh);ctx.imageSmoothingEnabled=false;ctx.drawImage(floor,-Math.round(camera.x),-Math.round(camera.y));
      drawClock(new Date());
      for(const s of seatTargets){
        const x=((s.displayX??s.x+.5)-.5)*tile-camera.x,y=((s.displayY??s.y+.5)-.5)*tile-camera.y;
        s.button.style.display=mine&&x+tile>0&&y+tile>0&&x<vw&&y<vh?'block':'none';
        s.button.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;
      }
      if(counterFixture){
        const bx=bookWorldX-bookHotspotHalfW-camera.x, by=bookWorldY-bookHotspotHalfH-camera.y;
        menuBookButton.style.width=`${bookHotspotHalfW*2}px`;menuBookButton.style.height=`${bookHotspotHalfH*2}px`;
        menuBookButton.style.display=mine&&bx+bookHotspotHalfW*2>0&&by+bookHotspotHalfH*2>0&&bx<vw&&by<vh?'block':'none';
        menuBookButton.style.transform=`translate(${Math.round(bx)}px,${Math.round(by)}px)`;
      }
      const seatedPatrons=new Set();
      for(const s of layout.gameChairs||[]){
        const t=state.tables.find(t=>t.id===s.tableId);
        const occupant=t?.seats?.find(p=>p?.color===s.color);
        if(!occupant)continue;
        const x=(s.displayX??s.x+.5)*tile-camera.x,y=((s.displayY??s.y+.5)+.15)*tile-camera.y;
        if(occupant.present){
          sprite(ctx,x,y,colors[occupant.color],skins[occupant.skin]||skins.warm,1,0,true);
          if(occupant.barPlayerId)seatedPatrons.add(occupant.barPlayerId);
        }
        ctx.font='10px monospace';ctx.textAlign='center';ctx.fillStyle='#f5e7d2';
        ctx.fillText(occupant.nickname+(occupant.controller==='npc'?' · NPC':occupant.present?'':' · away'),x,y-52);
        // A game-seated patron's speech still appears at their real,
        // actual on-screen position (part 2's "real chair position" rule,
        // carried over for part 3's own bubble) — cross-referenced from
        // the bar's own player list, since table seat data has no speech
        // field of its own.
        if(occupant.barPlayerId){
          const barP=state.players.find(bp=>bp.id===occupant.barPlayerId);
          if(barP?.speech)drawSpeechBubble(x,y-60,barP.speech);
        }
      }
      if(destination){ctx.strokeStyle='#ecd29b';ctx.lineWidth=2;ctx.strokeRect(destination.x*tile-camera.x+8,destination.y*tile-camera.y+8,tile-16,tile-16);}
      for(const p of [...state.players].sort((a,b)=>a.y-b.y)){
        if(seatedPatrons.has(p.id))continue;
        let pos=displayPositions.get(p.id);if(!pos){pos={x:p.x,y:p.y};displayPositions.set(p.id,pos);}
        const walking=!p.seatId&&Math.abs(pos.x-p.x)+Math.abs(pos.y-p.y)>.02;pos.x+=(p.x-pos.x)*.22;pos.y+=(p.y-pos.y)*.22;
        const x=(pos.x+.5)*tile-camera.x,y=(pos.y+.75)*tile-camera.y;
        // A seated patron (p.seatId set) gets the same sprite at rest —
        // no walk animation, and a touch smaller/lower to read as sitting
        // at the chair rather than standing over it. Still the one
        // sprite() primitive, not a distinct seated illustration.
        sprite(ctx,x,p.seatId?y-7:y,colors[p.color]||colors.green,skins[p.skin]||skins.warm,p.seatId?1.0:1.15,walking?now/90:0,!!p.seatId);
        ctx.font='12px monospace';ctx.textAlign='center';const label=p.nickname+(p.id===mine?.id?' · you':'');const width=ctx.measureText(label).width+14;
        box(ctx,x-width/2,y-72,width,20,'#292635dc');ctx.fillStyle='#f5e7d2';ctx.fillText(label,x,y-58);
        // Follows the same interpolated, camera-adjusted (x,y) the
        // nickname tag and sprite themselves use — walking, sitting at a
        // dining/stool chair, and the camera panning all move the bubble
        // with them for free, no separate position tracking needed.
        if(p.speech)drawSpeechBubble(x,y-80,p.speech);
      }
      if(!session){sprite(ctx,vw/2,vh/2+60,colors.green,skins.warm,1.2);}
      const shade=ctx.createRadialGradient(vw/2,vh/2,100,vw/2,vh/2,Math.max(vw,vh)*.7);shade.addColorStop(0,'#100d1800');shade.addColorStop(1,'#100d1870');ctx.fillStyle=shade;ctx.fillRect(0,0,vw,vh);
    }
    frame=requestAnimationFrame(animate);
    dispose=()=>{active=false;cancelAnimationFrame(frame);timers.forEach(clearInterval);holdCleanups.forEach(cleanup=>cleanup());window.removeEventListener('resize',resize);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);document.body.classList.remove('world-mode');};
    try{session=JSON.parse(localStorage.getItem(sessionKey)||'null');}catch{}
    if(session){try{const resp=await post('/rejoin',session);applyIncoming(resp);activeSeat=resp.activeSeat??null;if(active){if(enteredThisPage)begin();else chooseCharacter();}}catch(e){if(e.status===403){session=null;localStorage.removeItem(sessionKey);chooseCharacter();}else toast.textContent='Unable to reconnect. Reload to retry.';}}
    else chooseCharacter();
  }
  return {mount,stop:()=>{menuBook.close();dispose();}};
}
