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
export function createTavern({ el, render, navigate, buildClassicPanel, saveSession, shouldApplyLiveUpdate }) {
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
    let active=true, session=null, state={players:[],tables:[]}, mine=null, camera={x:0,y:0}, path=[], moving=false, frame=0;
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
    // Proximity-triggered 1:1 chat (product-direction-update, part 3).
    // `chatChase` is the walk-toward-a-player-to-chat gesture in flight —
    // {playerId, autoOpen, approach:{x,y}, targetX, targetY, attempts} or
    // null — mirroring pendingSitSeat's own shape/lifecycle (set by a
    // click, consumed once step() confirms arrival, aborted by the
    // animate() loop if the target moves away too many times or goes
    // offline). `openChatThreadId`/`openChatOtherId` track whichever
    // thread's dialog is currently on screen, if any, so an inbox push
    // for that exact thread can append live instead of surfacing a
    // notification for a conversation the player is already looking at.
    let chatChase=null, openChatThreadId=null, openChatOtherId=null, lastSeenChatMsgId=0, chatEventSource=null, pendingChatNotify=null;
    const holdCleanups=[];
    dispose=()=>{
      active=false;holdCleanups.forEach(cleanup=>cleanup());document.body.classList.remove('world-mode');
      if(eventSource){eventSource.close();eventSource=null;}
      if(chatEventSource){chatEventSource.close();chatEventSource=null;}
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
    const hud=el('header',{class:'world-hud'},[
      el('div',{class:'world-brand'},[el('span',{class:'brand-mark'},'◆'),el('div',{},[el('strong',{},'THE AMBER ROOM'),el('small',{},'A little place to be together')])]),
      el('div',{class:'hud-actions'},[online,standBtn,el('button',{class:'hud-button',onclick:()=>{path=[];chooseCharacter();}},'Your character'),el('button',{class:'hud-button',onclick:()=>openGames()},'Join by code')]),
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
    let layout;
    try { layout=await read('/layout'); } catch(e) {toast.textContent=e.message;return;}
    if(!active)return;
    const tile=64, worldW=layout.gridCols*tile,worldH=layout.gridRows*tile;
    const fixtures=layout.furniture;
    const seatTargets=[];
    for(const s of layout.seats||[]){
      const f=fixtures.find(f=>f.id===s.furnitureId);
      const label=`Sit — ${f?.kind==='stool'?'bar stool':'dining chair'} ${s.id}`;
      const button=el('button',{class:'seat-target','aria-label':label,'data-hint':'Sit down',title:'Sit down',onclick:()=>{
        if(!mine||overlay.childElementCount)return;
        // A seat-target button is a separate DOM element layered over the
        // canvas — it never goes through the canvas's own click handler,
        // so the same player-click-takes-priority rule (part 2) has to be
        // repeated here: someone actually seated there is always the
        // occupant to chat-approach, never just a "taken" refusal.
        const occupant=playerAt(s.x,s.y);
        if(occupant){beginApproachAndChat(occupant);return;}
        beginSit(s);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    for(const s of layout.gameChairs||[]){
      const f=fixtures.find(f=>f.id===s.tableId);
      const button=el('button',{class:'seat-target','aria-label':`Choose ${s.color} seat — ${f.label}`,'data-hint':f.available?`Choose ${s.color} seat`:'Not yet open',title:f.available?`Choose ${s.color} seat`:'Not yet open',onclick:()=>{
        if(!mine||overlay.childElementCount)return;
        // A present game occupant's effective position is this exact
        // chair tile (src/position.ts) — clicking it chats with them
        // (part 2's "real chair position, not a hidden lobby coordinate"
        // rule), same priority as any other player click, ahead of the
        // table dialog this chair would otherwise open.
        const occupant=playerAt(s.x,s.y);
        if(occupant){beginApproachAndChat(occupant);return;}
        if(!f.available)toast.textContent=f.label;
        else if(f.tableMode==='npc')openNpcTableDialog(f,s.color);
        else openTableDialog(f,s.color);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    const ctx=canvas.getContext('2d');
    let vw=window.innerWidth,vh=window.innerHeight;
    const resize=()=>{vw=window.innerWidth;vh=window.innerHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=vw*dpr;canvas.height=vh*dpr;canvas.style.width=vw+'px';canvas.style.height=vh+'px';ctx.setTransform(dpr,0,0,dpr,0,0);};resize();
    window.addEventListener('resize',resize);
    // Mirrors src/barLayout.ts's isWalkable exactly, from the same
    // FURNITURE list (fetched via GET /api/bar/layout) — a fixture with
    // blocksMovement:false (the restroom) is a walkable zone marker, not
    // an obstacle, same rule server-side, so the two can't disagree.
    function walkable(x,y) {return x>=0&&x<layout.gridCols&&y>=0&&y<layout.gridRows&&!fixtures.some(f=>f.blocksMovement!==false&&x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);}
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
    function queueStep(dx,dy){if(!mine||moving||overlay.childElementCount)return;const x=mine.x+dx,y=mine.y+dy;if(walkable(x,y)&&!occupiedByOther(x,y)){pendingSitSeat=null;chatChase=null;path=[[x,y]];destination={x,y};}}
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
      return candidates[0];
    }
    function manhattan(ax,ay,bx,by){return Math.abs(ax-bx)+Math.abs(ay-by);}
    // Phase 2 (product-direction-update): "click an empty chair, walk
    // there, sit down" is one gesture — if already standing exactly on
    // the seat's own tile, sit immediately; otherwise path there first
    // (ordinary, server-validated step by step) and let step() below
    // finish the gesture once it confirms arrival.
    function beginSit(seat){
      if(!mine||overlay.childElementCount)return;
      if(mine.x===seat.x&&mine.y===seat.y){
        post(`/seats/${seat.id}/sit`,session).then(resp=>{applyIncoming(resp);toast.textContent='Seated — use Stand up to leave the chair.';}).catch(e=>{toast.textContent=e.message||'Could not sit down';});
        return;
      }
      pendingSitSeat=seat;path=findPath(seat.x,seat.y);destination=path.length?{x:seat.x,y:seat.y}:null;
      if(!path.length)pendingSitSeat=null;
    }
    // Product-direction-update, part 3: click a player within 3 tiles
    // (Manhattan) and this patron auto-walks to a free adjacent tile and
    // opens a chat; beyond 3 tiles, the same walk-closer happens but the
    // dialog doesn't auto-open (clicking again once nearby does) — never
    // walking into their tile (findApproachTile), never chasing forever
    // (the animate() loop's own re-path cap below).
    const CHAT_AUTO_OPEN_RADIUS=3;
    function beginApproachAndChat(player){
      if(!mine||overlay.childElementCount||player.id===mine.id)return;
      if(manhattan(mine.x,mine.y,player.x,player.y)<=1){openChatWith(player);return;}
      const autoOpen=manhattan(mine.x,mine.y,player.x,player.y)<=CHAT_AUTO_OPEN_RADIUS;
      const approach=findApproachTile(player.x,player.y);
      if(!approach){toast.textContent="Can't reach them right now.";return;}
      pendingSitSeat=null;
      chatChase={playerId:player.id,autoOpen,approach,targetX:player.x,targetY:player.y,attempts:0};
      path=findPath(approach.x,approach.y);destination=path.length?approach:null;
      if(!path.length){chatChase=null;toast.textContent="Can't reach them right now.";}
    }
    function reconcile(next){
      state=next;
      mine=state.players.find(p=>p.id===session?.playerId)||mine;
      if(pendingMoveTarget&&mine)mine={...mine,x:pendingMoveTarget.x,y:pendingMoveTarget.y};
      online.textContent=`${state.players.length} here`;
      standBtn.style.display=mine?.seatId?'':'none';
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
    const GAME_COLORS=['red','blue','green','yellow'];
    async function openTableDialog(f,preferredColor){
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
      const roomFull=t.playerCount>=4;
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
        :`${f.label} — ${t.playerCount}/4 ${isWaiting?'waiting to start':t.status==='in_progress'?'mid-game':'round over'}.`;
      const pendingNote=t.pendingCount>0?` (${t.pendingCount} waiting for the host's approval)`:'';
      const subtitle=isEmpty
        ? `Starting as ${mine?.nickname??'you'} — just pick a table colour, and you're the host.`
        : isWaiting
          ? (roomFull
              ? `This table already has its 4 players.${pendingNote}`
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
            post('/resume',session).catch(()=>{});
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
      path=[];
      let selected=preferredColor||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const swatches=el('div',{class:'avatar-swatches','aria-label':'Table colour (seat preview)'},GAME_COLORS.map(c=>
        el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,
          'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
          onclick:e=>{selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
        },'')));
      const body=[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'VEGAS DICE · SOLO'),el('h1',{},f.label),
        el('p',{class:'dialog-subtitle'},"Just you against three computer-controlled opponents — starts right away, nobody else can join."),
        swatches,error,
        el('button',{class:'enter-world',onclick:async e=>{
          const btn=e.currentTarget;btn.disabled=true;error.textContent='';
          try{
            const result=await post(`/tables/${f.id}/start-npc`,{...session,color:selected});
            try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
            post('/resume',session).catch(()=>{});
            overlay.replaceChildren();
            navigate(`/?room=${result.code}`);
          }catch(err){error.textContent=err.message||'Could not start that table';btn.disabled=false;}
        }},'Play vs. 3 NPCs'),
      ];
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
    }
    // ---- Proximity-triggered 1:1 chat (product-direction-update, part 3) ----
    //
    // A client-generated id per outgoing message (crypto.randomUUID when
    // available, a timestamp+random fallback otherwise — this only needs
    // to be unique per sender, never verified client-side) is what makes
    // a retried /send after a dropped response idempotent server-side
    // (src/chat.ts): the same id resent twice is the same logical
    // message, applied once.
    function newClientMsgId(){
      try{if(crypto.randomUUID)return crypto.randomUUID();}catch{}
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const renderedChatMsgIds=new Set();
    let chatMessagesEl=null, chatErrorEl=null;
    function appendChatMessageIfNew(msg){
      if(renderedChatMsgIds.has(msg.id))return;
      renderedChatMsgIds.add(msg.id);
      if(msg.id>lastSeenChatMsgId)lastSeenChatMsgId=msg.id;
      if(!chatMessagesEl)return; // dialog isn't open right now — nothing to append to
      const mineMsg=msg.senderId===mine?.id;
      chatMessagesEl.appendChild(el('p',{class:`chat-bubble ${mineMsg?'chat-mine':'chat-theirs'}`},msg.body));
      chatMessagesEl.scrollTop=chatMessagesEl.scrollHeight;
    }
    async function openChatWith(player){
      if(!mine||overlay.childElementCount)return;
      try{
        const resp=await post('/chat/open',{...session,otherPlayerId:player.id});
        renderChatDialog(resp.threadId,resp.otherPlayerId,resp.otherNickname,resp.messages);
      }catch(e){toast.textContent=e.message||'Could not start a chat';}
    }
    // Opening from an inbox notification (part 3: "接收方看到带发送者昵称
    // 的对话提示,可打开该对话") re-fetches fresh history by id rather than
    // trusting the notification payload alone — a notification can be
    // stale by the time it's actually clicked.
    async function openChatByThread(threadId,otherId,otherNickname){
      if(!mine||overlay.childElementCount)return;
      try{
        const resp=await read(`/chat/${threadId}/messages?playerId=${encodeURIComponent(session.playerId)}&sessionSecret=${encodeURIComponent(session.sessionSecret)}&afterId=0`);
        renderChatDialog(threadId,otherId,otherNickname,resp.messages);
      }catch(e){toast.textContent=e.message||'Could not open that conversation';}
    }
    function renderChatDialog(threadId,otherId,otherNickname,messages){
      path=[];
      openChatThreadId=threadId;openChatOtherId=otherId;
      renderedChatMsgIds.clear();lastSeenChatMsgId=0;
      if(pendingChatNotify&&pendingChatNotify.threadId===threadId){pendingChatNotify=null;chatBanner.style.display='none';}
      const messagesBox=el('div',{class:'chat-messages','aria-live':'polite'});
      chatMessagesEl=messagesBox;
      chatErrorEl=el('p',{class:'error',role:'alert'});
      const input=el('input',{class:'chat-input',placeholder:'Message…',maxlength:'500','aria-label':`Message to ${otherNickname}`});
      const sendBtn=el('button',{class:'enter-world chat-send'},'Send');
      const doSend=async()=>{
        const text=input.value.trim();
        if(!text)return;
        sendBtn.disabled=true;chatErrorEl.textContent='';
        const clientMsgId=newClientMsgId();
        try{
          const msg=await post(`/chat/${threadId}/send`,{...session,clientMsgId,body:text});
          appendChatMessageIfNew(msg);
          input.value='';
        }catch(e){
          chatErrorEl.textContent=e.status===409&&e.message?`${e.message} Your message is still here — try again once you're close.`:(e.message||'Could not send that message');
        }
        sendBtn.disabled=false;input.focus();
      };
      sendBtn.onclick=doSend;
      input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doSend();}});
      for(const m of messages)appendChatMessageIfNew(m);
      overlay.replaceChildren(el('section',{class:'world-dialog chat-dialog',role:'dialog','aria-label':`Chat with ${otherNickname}`},[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>{overlay.replaceChildren();closeChatDialog();}},'×'),
        el('p',{class:'eyebrow'},'PRIVATE MESSAGE'),el('h1',{},otherNickname),
        messagesBox,chatErrorEl,
        el('div',{class:'chat-compose'},[input,sendBtn]),
      ]));
      input.focus();
    }
    function closeChatDialog(){openChatThreadId=null;openChatOtherId=null;chatMessagesEl=null;chatErrorEl=null;}
    const chatBanner=el('button',{class:'hud-button chat-banner',style:'display:none',onclick:()=>{
      if(!pendingChatNotify)return;
      const {threadId,otherId,otherNickname}=pendingChatNotify;
      openChatByThread(threadId,otherId,otherNickname);
    }},'');
    function showChatNotify(threadId,otherId,otherNickname){
      // Never while that exact thread is already open on screen — the
      // live push already appended it there directly.
      if(openChatThreadId===threadId)return;
      pendingChatNotify={threadId,otherId,otherNickname};
      chatBanner.textContent=`💬 ${otherNickname} — new message`;
      chatBanner.style.display='';
    }
    scene.appendChild(chatBanner);
    function connectChatInbox(){
      if(chatEventSource)chatEventSource.close();
      const url=`/api/bar/chat/events?playerId=${encodeURIComponent(session.playerId)}&sessionSecret=${encodeURIComponent(session.sessionSecret)}`;
      const es=new EventSource(url);
      es.onmessage=ev=>{
        let msg;try{msg=JSON.parse(ev.data);}catch{return;}
        if(!msg||typeof msg.threadId!=='string')return;
        if(msg.threadId===openChatThreadId){
          appendChatMessageIfNew(msg);
        }else if(msg.senderId!==mine?.id){
          showChatNotify(msg.threadId,msg.senderId,msg.senderNickname||'Someone');
        }
      };
      // A reconnect (initial connect or automatic retry) can't be trusted
      // to have delivered everything sent while the connection was down
      // (CLAUDE.md's real-time-push section) — if a thread is currently
      // open, re-fetch anything past the last message actually rendered.
      es.onopen=()=>{
        if(openChatThreadId&&session){
          read(`/chat/${openChatThreadId}/messages?playerId=${encodeURIComponent(session.playerId)}&sessionSecret=${encodeURIComponent(session.sessionSecret)}&afterId=${lastSeenChatMsgId}`)
            .then(resp=>{for(const m of resp.messages)appendChatMessageIfNew(m);}).catch(()=>{});
        }
      };
      chatEventSource=es;
    }
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
        el('p',{class:'eyebrow'},'THE AMBER ROOM · OPEN ALL EVENING'),el('h1',{},'Come as you are.'),el('p',{class:'dialog-subtitle'},'Make yourself a little character. Your friends are inside.'),
        el('div',{class:'avatar-editor'},[el('div',{class:'avatar-preview'},[preview,el('span',{},'YOUR LITTLE SELF')]),el('div',{class:'avatar-options'},[
          el('label',{for:'patron-nickname'},'What should we call you?'),input,
          el('span',{class:'option-label'},'Clothes'),makeChoices(colors,'Clothes',v=>color=v),
          el('span',{class:'option-label'},'Skin tone'),makeChoices(skins,'Skin',v=>skin=v),
        ])]),error,enter,el('p',{class:'dialog-footnote'},'No account needed. Your character stays in this browser.'),
      ]);overlay.replaceChildren(form);update();input.focus();
    }
    function begin(){
      enteredThisPage=true;
      if(timers.length||!active)return;
      if(mine){session={...session,nickname:mine.nickname,color:mine.color,skin:mine.skin};try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}}
      post('/heartbeat',session).catch(()=>{});
      connectEvents();connectChatInbox();fetchAndApply();
      // 10s fallback poll — cheap insurance if the stream silently
      // stalls without EventSource noticing; gated through the same
      // seq check above, so it's a no-op whenever the stream is doing
      // its job.
      timers.push(setInterval(()=>post('/heartbeat',session).catch(()=>{}),5000),setInterval(fetchAndApply,10000));
      visibilityHandler=()=>{
        if(document.visibilityState!=='visible')return;
        // A backgrounded tab can have its EventSource suspended by the
        // browser; coming back is exactly when a stale view would
        // otherwise sit unnoticed.
        if(!eventSource||eventSource.readyState===EventSource.CLOSED)connectEvents();
        if(!chatEventSource||chatEventSource.readyState===EventSource.CLOSED)connectChatInbox();
        fetchAndApply();
      };
      document.addEventListener('visibilitychange',visibilityHandler);
      window.addEventListener('focus',visibilityHandler);
      // Driven by the server's own re-validated activeSeat, never a
      // locally-cached room code — a closed, left, or expired room, or a
      // different character's game entirely, is never offered here.
      if(activeSeat){hud.querySelector('.hud-actions').appendChild(el('button',{class:'hud-button',onclick:()=>{
        // Clicking this is exactly "I'm deliberately going back to my
        // table" — clears any pending away-from-table departure (see
        // src/tables.ts's resumeActiveTable: only an explicit action like
        // this one may do so, never a passive heartbeat).
        post('/resume',session).catch(()=>{});
        navigate(`/?room=${activeSeat.roomCode}`);
      }},'Return to your game'));}
      toast.textContent='Welcome in. WASD / arrows to walk · click a destination';canvas.focus();
    }
    const keyDown=e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName)||overlay.childElementCount)return;const key=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();keys.add(key);path=[];pendingSitSeat=null;}if(e.key==='Escape'){path=[];destination=null;pendingSitSeat=null;}};
    const keyUp=e=>keys.delete(e.key.toLowerCase());const blur=()=>{keys.clear();heldDirection=null;path=[];pendingSitSeat=null;};
    window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);
    canvas.addEventListener('click',e=>{
      if(!mine||overlay.childElementCount)return;const rect=canvas.getBoundingClientRect(),x=Math.floor((e.clientX-rect.left+camera.x)/tile),y=Math.floor((e.clientY-rect.top+camera.y)/tile);
      // A player's own tile takes priority over whatever floor, seat, or
      // table is underneath them (product-direction-update, part 2) —
      // clicking yourself is a deliberate no-op, never a chat with
      // yourself. Checked first, before any furniture/seat logic below.
      if(x===mine.x&&y===mine.y)return;
      const other=playerAt(x,y);
      if(other){beginApproachAndChat(other);return;}
      const f=fixtures.find(f=>x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);
      // A walkable-zone fixture (blocksMovement:false — the restroom)
      // falls through to the normal walk/pathfinding below, same as any
      // other floor tile; only a genuinely non-walkable, interactive
      // fixture (a table, the counter) intercepts the click for its own
      // dialog/message instead.
      if(f&&f.blocksMovement!==false){
        if(f.kind==='game_table'){if(!f.available)toast.textContent=`${f.label}`;else if(f.tableMode==='npc')openNpcTableDialog(f);else openTableDialog(f);}
        else if(f.kind==='counter')toast.textContent='The kitchen is not open yet. Grab a game while you wait.';
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
      pendingSitSeat=null;path=findPath(x,y);destination=path.length?{x,y}:null;
    });
    async function step(x,y){
      moving=true;movementEpoch++;pendingMoveTarget={x,y};
      try{
        const next=await post('/move',{playerId:session.playerId,sessionSecret:session.sessionSecret,x,y});
        pendingMoveTarget=null;if(active)applyIncoming(next);
        // Arrived at the tile a click-to-sit gesture was walking toward —
        // finish it with the real, separately-validated sit call (beginSit).
        if(pendingSitSeat&&pendingSitSeat.x===x&&pendingSitSeat.y===y){
          const seat=pendingSitSeat;pendingSitSeat=null;
          try{applyIncoming(await post(`/seats/${seat.id}/sit`,session));toast.textContent='Seated — use Stand up to leave the chair.';}
          catch(err){toast.textContent=err.message||'Could not sit down';}
        }
        // Arrived at the approach tile a chat-chase gesture was walking
        // toward — open the dialog only if the original click was within
        // the auto-open radius (otherwise this was just "walk closer",
        // per the spec's own split) and the target is still actually
        // there to chat with.
        if(chatChase&&chatChase.approach.x===x&&chatChase.approach.y===y){
          const target=state.players.find(p=>p.id===chatChase.playerId);
          const autoOpen=chatChase.autoOpen;
          chatChase=null;
          if(target&&autoOpen)openChatWith(target);
        }
      }
      catch(e){pendingMoveTarget=null;path=[];destination=null;pendingSitSeat=null;chatChase=null;toast.textContent=e.status===403?'Your session could not be restored. Reload to rejoin.':'Could not move — try again.';await fetchAndApply();}
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
    // Brick back wall, beams, windows and bottles.
    box(fc,0,0,worldW,128,'#473943');
    for(let y=0;y<4;y++)for(let x=0;x<40;x++){box(fc,x*64+(y%2)*32,y*24,60,21,['#67504a','#5e4848','#71564a'][(x+y)%3]);}
    box(fc,0,96,worldW,32,'#332a31');box(fc,0,98,worldW,5,'#a07a4d');
    for(const x of [256,768,1536,2112]){
      box(fc,x,24,130,74,'#cda35f');box(fc,x+7,30,116,62,'#29394c');box(fc,x+63,30,7,62,'#cda35f');box(fc,x+7,59,116,5,'#cda35f');
      box(fc,x+12,34,42,4,'#6b8593');
    }
    const rug=(x,y,w,h)=>{box(fc,x,y,w,h,'#8d4545');box(fc,x+6,y+6,w-12,h-12,'#ad7054');box(fc,x+12,y+12,w-24,h-24,'#864347');for(let a=x+24;a<x+w-12;a+=24)box(fc,a,y+20,8,8,'#c39968');};
    rug(17*tile,18*tile,6*tile,3*tile);rug(5*tile,6*tile,3*tile,5*tile);
    function plant(x,y){box(fc,x-13,y-19,26,22,'#b67b58');box(fc,x-15,y-23,30,8,'#d29a6e');for(const [dx,dy] of [[-12,-42],[2,-49],[-4,-61],[14,-38]]){box(fc,x+dx-7,y+dy,14,25,'#527c5a');box(fc,x+dx-3,y+dy,4,19,'#7ca472');}}
    for(const [x,y] of [[100,170],[worldW-100,170],[120,worldH-110],[worldW-120,worldH-110]])plant(x,y);
    // The original room is dressed as a room, rather than bare shapes on
    // endless floor. Empty surrounding world space can host later extensions.
    const wallX=8*tile,wallY=5*tile,wallW=24*tile;
    box(fc,wallX,wallY,wallW,88,'#4b363d');
    for(let row=0;row<3;row++)for(let col=0;col<24;col++)box(fc,wallX+col*tile+(row%2)*24,wallY+row*24,60,20,['#705147','#634844','#78584a'][(row+col)%3]);
    box(fc,wallX,wallY+72,wallW,16,'#322b32');box(fc,wallX,wallY+73,wallW,4,'#ba8a57');
    for(const wx of [11,17,24,29]){box(fc,wx*tile,wallY+10,90,53,'#b88b55');box(fc,wx*tile+6,wallY+16,78,40,'#303d51');box(fc,wx*tile+42,wallY+16,6,40,'#b88b55');box(fc,wx*tile+6,wallY+35,78,4,'#b88b55');}
    for(const px of [9,31]){plant(px*tile,10*tile);plant(px*tile,17*tile);}
    for(const f of fixtures){const x=f.x*tile,y=f.y*tile,w=f.w*tile,h=f.h*tile;
      if(f.kind==='counter'){
        box(fc,x-3,y+9,w+6,h,'#37282b');box(fc,x,y+5,w,h-10,'#b58153');box(fc,x,y+13,w,5,'#dfb979');box(fc,x,y+h-8,w,8,'#6b4635');
        for(let i=12;i<w;i+=64){box(fc,x+i,y+29,46,25,'#815636');box(fc,x+i+2,y+30,42,2,'#cf9c5e');}
        for(let i=32;i<w;i+=80){box(fc,x+i,y-24,9,22,'#729f80');box(fc,x+i+2,y-29,5,6,'#d8b873');box(fc,x+i+14,y-15,7,13,'#ddc6a0');}
        fc.font='bold 17px monospace';fc.textAlign='center';fc.fillStyle='#e4bf7e';fc.fillText('THE AMBER ROOM',x+w/2,y-43);
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
      }else{
        box(fc,x-5,y+12,w+10,h,'#382a2d');box(fc,x-6,y,w+12,h,'#b78a59');box(fc,x,y+6,w,h-12,f.kind==='game_table'?(f.available?'#487c69':'#665969'):'#9c6848');
        box(fc,x+6,y+12,w-12,3,'#ffffff19');
        if(f.kind==='game_table'){
          for(let i=0;i<3;i++){box(fc,x+30+i*23,y+33,17,26,'#eadcc5');box(fc,x+34+i*23,y+41,7,7,i%2?'#c87769':'#4d515d');}
          fc.textAlign='center';fc.font='bold 12px monospace';fc.fillStyle='#f7e6c6';fc.fillText(f.available?f.label:f.gameType.toUpperCase(),x+w/2,y+h-26);
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
    for(const s of layout.gameChairs||[])chair(fc,s.x*tile,s.y*tile,colors[s.color]);
    // Clear per-row mode labels (PLAN.md phase 5's two-row layout: a
    // player glancing at the room must be able to tell "shared, host-
    // approved" from "solo, instant" apart without opening a dialog).
    // Computed from the fixtures the server actually sent rather than a
    // hardcoded row position, so a future layout revision can't silently
    // leave the banner pointing at the wrong row.
    function rowBanner(tables,text,color){
      if(!tables.length)return;
      const minX=Math.min(...tables.map(f=>f.x))*tile,maxX=Math.max(...tables.map(f=>f.x+f.w))*tile;
      const topY=Math.min(...tables.map(f=>f.y))*tile;
      fc.textAlign='center';fc.font='bold 14px monospace';fc.fillStyle=color;
      fc.fillText(text,(minX+maxX)/2,topY-56);
    }
    rowBanner(fixtures.filter(f=>f.kind==='game_table'&&f.tableMode==='online'),'◆ ONLINE — REQUEST TO JOIN','#8fd1ff');
    rowBanner(fixtures.filter(f=>f.kind==='game_table'&&f.tableMode==='npc'),'◆ SOLO VS. 3 NPCS','#ffce7a');
    function animate(now){
      if(!active)return;frame=requestAnimationFrame(animate);
      if(session&&mine&&!moving&&now-lastTime>145&&!overlay.childElementCount){
        let dx=0,dy=0;if(keys.has('w')||keys.has('arrowup'))dy=-1;else if(keys.has('s')||keys.has('arrowdown'))dy=1;
        if(keys.has('a')||keys.has('arrowleft'))dx=-1;else if(keys.has('d')||keys.has('arrowright'))dx=1;
        if(heldDirection){dx=heldDirection.dx;dy=heldDirection.dy;}
        if(dx||dy){path=[];pendingSitSeat=null;chatChase=null;if(walkable(mine.x+dx,mine.y+dy)&&!occupiedByOther(mine.x+dx,mine.y+dy)){lastTime=now;step(mine.x+dx,mine.y+dy);}}
        else if(path.length){
          // A seat this patron is walking toward can be taken by someone
          // else mid-journey — stop the attempt and say so rather than
          // walking the rest of the way for nothing (the server would
          // refuse the final sit anyway, but catching it here is a
          // clearer, earlier signal than an error only at arrival).
          if(pendingSitSeat&&state.players.some(p=>p.seatId===pendingSitSeat.id&&p.id!==mine.id)){
            path=[];destination=null;pendingSitSeat=null;toast.textContent='Someone sat down there first.';
          }else if(chatChase){
            // The person being approached can walk, log off, or (rarely)
            // have their old approach tile taken by someone else while
            // this patron is still en route — re-pathed a bounded number
            // of times (never an infinite chase, per the spec's own
            // "不能无限追赶"), and abandoned outright if they're simply
            // gone.
            const target=state.players.find(p=>p.id===chatChase.playerId);
            if(!target){
              path=[];destination=null;chatChase=null;toast.textContent='They left the bar.';
            }else if(target.x!==chatChase.targetX||target.y!==chatChase.targetY){
              if(chatChase.attempts>=3){
                path=[];destination=null;chatChase=null;toast.textContent="They're moving around too much — try again.";
              }else{
                chatChase.attempts++;chatChase.targetX=target.x;chatChase.targetY=target.y;
                const approach=findApproachTile(target.x,target.y);
                if(!approach){path=[];destination=null;chatChase=null;toast.textContent="Can't reach them right now.";}
                else{
                  chatChase.approach=approach;path=findPath(approach.x,approach.y);destination=path.length?approach:null;
                  if(!path.length){chatChase=null;toast.textContent="Can't reach them right now.";}
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
      for(const s of seatTargets){
        const x=s.x*tile-camera.x,y=s.y*tile-camera.y;
        s.button.style.display=mine&&x+tile>0&&y+tile>0&&x<vw&&y<vh?'block':'none';
        s.button.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;
      }
      const seatedPatrons=new Set();
      for(const s of layout.gameChairs||[]){
        const t=state.tables.find(t=>t.id===s.tableId);
        const occupant=t?.seats?.find(p=>p?.color===s.color);
        if(!occupant)continue;
        const x=(s.x+.5)*tile-camera.x,y=(s.y+.65)*tile-camera.y;
        if(occupant.present){
          sprite(ctx,x,y,colors[occupant.color],skins[occupant.skin]||skins.warm,1,0,true);
          if(occupant.barPlayerId)seatedPatrons.add(occupant.barPlayerId);
        }
        ctx.font='10px monospace';ctx.textAlign='center';ctx.fillStyle='#f5e7d2';
        ctx.fillText(occupant.nickname+(occupant.controller==='npc'?' · NPC':occupant.present?'':' · away'),x,y-52);
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
  return {mount,stop:()=>dispose()};
}
