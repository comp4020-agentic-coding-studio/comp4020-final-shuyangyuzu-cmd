// Private hand comes only from the authenticated server view. No stock order
// or opponent tiles are ever delivered to this module.
// Replay the public attachment history. Keep hand tiles canonical; orient only
// the pieces on the felt so the matching half faces its actual parent.
export function layoutBones(board) {
  const placements = new Map();
  const directions = {left:[-1,0], right:[1,0], top:[0,-1], bottom:[0,1]};
  for (const bone of board) {
    const parent = placements.get(bone.parent);
    if (!parent) {
      placements.set(bone.id, {x:0,y:0,dx:1,dy:0,face:bone.tile,out:null,width:74,height:40});
      continue;
    }
    const port = bone.port.split(':')[1];
    const [dx,dy] = directions[port] ?? [parent.dx,parent.dy];
    const contact = port === 'out' ? parent.out : port === 'right' ? parent.face[1] : parent.face[0];
    const far = bone.tile[0] === contact ? bone.tile[1] : bone.tile[0];
    const face = dx < 0 || dy < 0 ? [far,contact] : [contact,far];
    const width = dy ? 40 : 74, height = dy ? 74 : 40;
    placements.set(bone.id, {x:parent.x+dx*(parent.width+width)/2,
      y:parent.y+dy*(parent.height+height)/2,dx,dy,face,out:far,width,height});
  }
  return placements;
}

export function createDominoUI({el,navigate}) {
  let mounted=false,busy=false,fetching=false,room=null,selected=null,error='',generation=0,lastSignature='',waitlist=[];
  const saved=()=>{try{return JSON.parse(localStorage.getItem('vegas:bar:session')||'null');}catch{return null;}};
  const resume=el('aside',{class:'domino-resume',hidden:true});document.body.append(resume);
  async function api(action,body={}){
    const identity=saved();if(!identity)throw Error('Enter the tavern first.');
    const response=await fetch(`/api/domino/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,playerId:identity.playerId,sessionSecret:identity.sessionSecret})});
    const data=await response.json();if(!response.ok)throw Error(data.message||'Request failed');return data;
  }
  const tileKey=t=>t.join('-');
  function bone(t,attrs={}){
    return el(attrs.onclick?'button':'span',{class:'domino-bone',...attrs,'aria-label':`${t[0]} — ${t[1]}`},t.map(n=>el('span',{class:'domino-pips','aria-hidden':'true'},Array.from({length:9},(_,i)=>el('i',{class:([[],[4],[0,8],[0,4,8],[0,2,6,8],[0,2,4,6,8],[0,2,3,5,6,8]][n].includes(i)?'pip':'')})))));
  }
  function rules(){
    const d=el('dialog',{class:'rules-dialog domino-rules'},[
      el('h2',{},'All Fives · two players'),
      el('p',{},'A double-six set has 28 tiles. Each player receives seven; fourteen remain face down. First to 150 points wins the match.'),
      el('p',{},'The highest double opens the first round (highest tile if neither player has a double). Later rounds alternate the opening player, who may choose any tile.'),
      el('p',{},'Choose a tile, then choose a matching open end. If the total of exposed ends is a positive multiple of five, you score that total. An exposed double counts both halves.'),
      el('p',{},'The first double is the spinner. Once its two main sides have been played on, its top and bottom become playable. Unused extra arms add no points; later doubles do not branch.'),
      el('p',{},'If you have no legal move, draw one tile at a time until you can play. Pass only when the stock is empty. Two consecutive passes end a blocked round.'),
      el('p',{},'Empty your hand to earn the opponent’s remaining pips, rounded to the nearest five. In a blocked round the lower hand earns the rounded difference; a tie awards nothing. These are our stated house scoring choices. The host deals the next round; totals carry over.'),
      el('p',{},'Online: four chairs form two independent facing pairs — sit at an empty seat to join immediately. If a pair is occupied or already playing, you join a waitlist for that pair and are notified the moment a seat opens. Leaving ends only your pair’s match; returning to the bar keeps your seat for up to three minutes. Offline: your own private game against one NPC.'),
      el('a',{href:'https://mobilityware.helpshift.com/hc/en/58-dominoes/faq/3806-basic-rules/',target:'_blank',rel:'noopener'},'Rule reference · variant choices above'),
      el('button',{onclick:()=>d.close()},'Close rules')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
  }
  async function perform(action,body={}){
    if(busy)return;busy=true;error='';
    try{await api(action,body);selected=null;}catch(e){error=e.message;}
    finally{busy=false;lastSignature='';await poll();if(mounted)draw();}
  }
  function boardView(){
    const area=el('div',{class:'domino-board','aria-label':'Played dominoes — scroll to inspect the full layout'});
    if(!room.board.length){area.append(el('p',{class:'domino-empty'},'Choose your opening tile below.'));return area;}
    const placements=layoutBones(room.board);
    const pieces=[...placements.values()];
    const left=Math.min(...pieces.map(p=>p.x-p.width/2)), right=Math.max(...pieces.map(p=>p.x+p.width/2));
    const top=Math.min(...pieces.map(p=>p.y-p.height/2)), bottom=Math.max(...pieces.map(p=>p.y+p.height/2));
    const canvas=el('div',{class:'domino-layout',style:`width:${right-left+32}px;height:${bottom-top+32}px`});
    for(const b of room.board){
      const p=placements.get(b.id);
      const ends=room.ends.filter(e=>e.bone===b.id);
      const label=[b.id===room.spinner?.id?'Spinner':'',...ends.map(e=>`Open ${e.pip}`)].filter(Boolean).join(' · ');
      const axes=['left','right','top','bottom'];
      const marks=ends.map(e=>{
        const port=e.key.split(':')[1];
        return axes.includes(port)?port:p.dx<0?'left':p.dx>0?'right':p.dy<0?'top':'bottom';
      });
      const wrapper=el('div',{class:`domino-played ${b.id===room.spinner?.id?'spinner':''}`,
        style:`left:${p.x-p.width/2-left+16}px;top:${p.y-p.height/2-top+16}px;--bone-width:${p.width}px;--bone-height:${p.height}px`,title:label},
        [bone(p.face,{style:`transform:translate(-50%,-50%) rotate(${p.dy?90:0}deg)`})]);
      for(const side of marks) wrapper.append(el('span',{class:`domino-edge edge-${side}`, 'aria-hidden':'true'}));
      canvas.append(wrapper);
    }
    area.append(canvas);return area;
  }
  function draw(){
    if(!mounted)return;document.body.classList.add('table-mode');
    const root=document.getElementById('app');
    const myOwnPlayer=room?.players?.find(p=>p.id===saved()?.playerId);
    const header=el('header',{class:'domino-header'},[el('div',{},[el('small',{},'LAS VEGAS · THE DOMINO TABLE'),el('h1',{},'All Fives')]),el('button',{onclick:rules,'aria-label':'Game rules'},'▤ Rules'),
      // Explicit, display-only away toggle (2026-11-08, mirrors
      // poker.js's own identical button) — distinct from "Leave match"
      // below: away keeps the seat reserved (nobody else can take it)
      // and is visible to the opponent, but never ends the match.
      ...(room&&myOwnPlayer?[el('button',{onclick:()=>perform('away',{away:!myOwnPlayer.away})},myOwnPlayer.away?"I'm back":"I'm away")]:[]),
      // 2026-11-08 acceptance fix: this used to just navigate while
      // genuinely seated — the match stayed fully active with no away
      // flag ever set, so the opponent's own screen kept showing a
      // normal in-progress seat rather than "Away". Setting away first
      // (perform() itself already swallows a failed request into `error`
      // rather than throwing, so the player is never trapped here by a
      // network hiccup — same "don't block leaving" choice poker.js/
      // blackjack.js make explicitly) makes Back to the bar an actual,
      // visible departure signal rather than a silent no-op on the
      // match's own state.
      el('button',{onclick:async()=>{if(room&&myOwnPlayer&&!myOwnPlayer.away)await perform('away',{away:true});navigate('/');}},'Back to the bar')]);
    if(!room){
      // 2026-11-07: no more host-approval step, so a session with no room
      // can only mean either a waitlist entry for a currently-occupied
      // lane (shown below, with a live "it's your turn" notice once
      // notifyDominoWaitlist fires) or a genuine error.
      const waiting=waitlist.find(w=>!w.notified), ready=waitlist.find(w=>w.notified);
      const body=ready
        ? [el('p',{role:'status',class:'domino-waitlist-ready'},`A seat at pair ${ready.lane+1} is free now.`),
           el('button',{onclick:()=>{const c=ready.lane*2;open('online',['red','blue','green','yellow'][c]);}},'Sit down now'),
           el('button',{class:'secondary',onclick:()=>perform('leaveWaitlist',{lane:ready.lane})},'Never mind')]
        : waiting
        ? [el('p',{role:'status'},`Waiting for a seat to open at pair ${waiting.lane+1}…`),
           el('button',{class:'secondary',onclick:()=>perform('leaveWaitlist',{lane:waiting.lane})},'Stop waiting')]
        : [el('p',{role:'status'},error||'Choose another seat in the bar.')];
      root.replaceChildren(el('main',{class:'domino-page'},[header,...body,el('button',{onclick:()=>navigate('/')},'Back to the bar')]));return;
    }
    const me=saved()?.playerId,turn=room.turn===room.seat&&room.phase==='playing';
    const opponent=room.players[1-room.seat],own=room.players[room.seat];
    const score=p=>el('div',{class:`domino-player ${p.seat===room.turn?'active':''}`},[el('strong',{},p.nickname+(p.away?' · Away':'')),el('span',{},`${p.score} / ${room.target} points · ${p.count} tiles`)]);
    const action=(type,extra={})=>perform('act',{roomId:room.id,version:room.version,type,...extra});
    const controls=el('div',{class:'domino-controls'});
    if(turn){
      controls.append(el('p',{},selected?'Choose the end to connect to:':'Your turn · select a tile'));
      for(const m of room.legal.filter(m=>selected&&tileKey(m.tile)===tileKey(selected)))controls.append(el('button',{disabled:busy,onclick:()=>action('play',m)},m.end==='start'?'Place opening tile':`Connect to ${room.ends.find(e=>e.key===m.end)?.pip} · ${m.end}`));
      controls.append(el('button',{disabled:busy||room.legal.length>0,onclick:()=>action('draw')},room.stockCount?`Draw a tile (${room.stockCount} left)`:'Pass'));
    }
    if(room.host===me&&['waiting','round_end'].includes(room.phase))controls.append(el('button',{disabled:busy||room.players.some(p=>!p.id&&!p.npc),onclick:()=>action(room.phase==='waiting'?'start':'next')},room.phase==='waiting'?'Start match':'Deal next round'));
    if(room.phase==='finished')controls.append(el('h2',{},`${room.players[room.winner]?.nickname||'Match'} wins!`));
    root.replaceChildren(el('main',{class:'domino-page'},[header,el('p',{class:'domino-meta'},`${room.mode==='online'?'Online':'Offline'} · Pair ${room.lane+1} · Round ${room.round} · Ends total ${room.total}`),score(opponent),el('div',{class:'domino-opponent','aria-label':`${opponent.count} hidden tiles`},Array.from({length:opponent.count},()=>el('span',{class:'domino-back'},'◆'))),boardView(),score(own),el('div',{class:'domino-hand'},room.hand.map(t=>bone(t,{disabled:!turn||busy||!room.legal.some(m=>tileKey(m.tile)===tileKey(t)),class:`domino-bone ${selected&&tileKey(t)===tileKey(selected)?'selected':''}`,onclick:()=>{selected=t;draw();}}))),controls,el('p',{role:'status'},error||room.result),el('button',{class:'secondary',onclick:()=>{
      const d=el('dialog',{class:'rules-dialog'},[el('h2',{},'Leave this match?'),el('p',{},'Leaving ends this match for both players. The other pair at this table is unaffected.'),el('button',{onclick:()=>d.close()},'Cancel'),el('button',{onclick:async()=>{d.close();await perform('leave');if(!error)navigate('/');}},'Leave match')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
    }},'Leave match')]));
  }
  async function poll(){
    const identity=saved();if(fetching||!identity)return;fetching=true;const g=generation,id=identity.playerId;
    try{
      const data=await api('me',{active:mounted});if(g!==generation||saved()?.playerId!==id)return;
      room=data.room;waitlist=data.waitlist;
      const signature=JSON.stringify(data);
      if(mounted&&signature!==lastSignature){lastSignature=signature;draw();}
      resume.hidden=mounted||!room;
      if(room&&!mounted)resume.replaceChildren(el('button',{onclick:()=>navigate(`/?domino=${room.id}`)},'Return to dominoes'),el('button',{onclick:()=>perform('leave')},'Leave match'));
    }catch(e){if(mounted){error=e.message;draw();}}finally{fetching=false;}
  }
  async function open(mode,seat){
    const chair=['red','blue','green','yellow'].indexOf(seat);
    if(chair<0){
      const d=el('dialog',{class:'rules-dialog'},[el('h2',{},'Choose a facing pair'),el('p',{},'Seats 1–2 play each other; seats 3–4 form a separate match.'),...[0,1,2,3].map(i=>el('button',{onclick:()=>{d.close();open(mode,['red','blue','green','yellow'][i]);}},`Pair ${Math.floor(i/2)+1} · seat ${i%2+1}`)),el('button',{onclick:()=>d.close()},'Cancel')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();return;
    }
    try{const r=await api('open',{mode,chair});error='';navigate(`/?domino=${r.roomId}`);}
    catch(e){
      // seat_taken for an online lane also registered this identity on
      // that lane's waitlist server-side (openDomino) — navigate into the
      // dominoes view so draw()'s "no room" branch shows the live
      // waiting/notified UI instead of a one-shot dialog that would lose
      // track of the wait the moment it's dismissed.
      if(e.status===409&&mode==='online'){error='';navigate(`/?domino=waiting`);mount();poll();return;}
      const d=el('dialog',{class:'rules-dialog'},[el('p',{},e.message),el('button',{onclick:()=>d.close()},'Close')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
    }
  }
  setInterval(poll,600);window.addEventListener('domino-open',e=>open(e.detail.mode,e.detail.seat));
  return {mount(){mounted=true;lastSignature='';draw();poll();},routeChanged(){mounted=false;generation++;selected=null;error='';resume.hidden=true;document.body.classList.remove('table-mode');}};
}
