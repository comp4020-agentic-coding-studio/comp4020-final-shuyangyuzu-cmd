// Private hand comes only from the authenticated server view. No stock order
// or opponent tiles are ever delivered to this module.
export function createDominoUI({el,navigate}) {
  let mounted=false,busy=false,fetching=false,room=null,selected=null,error='',generation=0,lastSignature='';
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
      el('p',{},'Online: four chairs form two independent facing pairs. The first seated player approves their opponent. Leaving ends only your pair’s match; returning to the bar keeps your seat for up to three minutes. Offline: your own private game against one NPC.'),
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
    const root=room.board.find(b=>b.id===room.spinner?.id)||room.board[0];
    const neighbors=new Map(room.board.map(b=>[b.id,[]]));
    for(const b of room.board)if(b.parent){neighbors.get(b.id).push(b.parent);neighbors.get(b.parent).push(b.id);}
    const coords=new Map([[root.id,{x:0,y:0}]]),directions=[[-1,0],[1,0],[0,-1],[0,1]];
    const rootNeighbors=neighbors.get(root.id);
    const used=new Set();
    for(const [i,id] of rootNeighbors.entries()){
      const b=room.board.find(b=>b.id===id);let d=b.parent===root.id&&b.port.endsWith(':top')?2:b.parent===root.id&&b.port.endsWith(':bottom')?3:i;
      while(used.has(d))d++;used.add(d);const [dx,dy]=directions[d]||directions[1];
      let current=id,previous=root.id,n=1;
      while(current){coords.set(current,{x:dx*n,y:dy*n});const next=neighbors.get(current).find(x=>x!==previous);previous=current;current=next;n++;}
    }
    const positions=[...coords.values()],minX=Math.min(...positions.map(p=>p.x)),maxX=Math.max(...positions.map(p=>p.x)),minY=Math.min(...positions.map(p=>p.y)),maxY=Math.max(...positions.map(p=>p.y));
    const canvas=el('div',{class:'domino-layout',style:`width:${(maxX-minX+1)*86+80}px;height:${Math.max(220,(maxY-minY+1)*78+80)}px`});
    for(const b of room.board){const p=coords.get(b.id)||{x:0,y:0};const ends=room.ends.filter(e=>e.bone===b.id);canvas.append(el('div',{class:`domino-played ${b.id===room.spinner?.id?'spinner':''}`,style:`left:${(p.x-minX)*86+40}px;top:${(p.y-minY)*78+40}px`},[bone(b.tile),el('small',{},b.id===room.spinner?.id?'Spinner':ends.length?'Open end':'')]));}
    area.append(canvas);return area;
  }
  function draw(){
    if(!mounted)return;document.body.classList.add('table-mode');
    const root=document.getElementById('app');
    const header=el('header',{class:'domino-header'},[el('div',{},[el('small',{},'LAS VEGAS · THE DOMINO TABLE'),el('h1',{},'All Fives')]),el('button',{onclick:rules,'aria-label':'Game rules'},'▤ Rules'),el('button',{onclick:()=>navigate('/')},'Back to the bar')]);
    if(!room){root.replaceChildren(el('main',{class:'domino-page'},[header,el('p',{role:'status'},error||'Waiting for the host to approve your seat. If the match has ended, choose another seat in the bar.'),el('button',{onclick:async()=>{await perform('leave');navigate('/');}},'Cancel / return to bar')]));return;}
    const me=saved()?.playerId,turn=room.turn===room.seat&&room.phase==='playing';
    const opponent=room.players[1-room.seat],own=room.players[room.seat];
    const score=p=>el('div',{class:`domino-player ${p.seat===room.turn?'active':''}`},[el('strong',{},p.nickname),el('span',{},`${p.score} / ${room.target} points · ${p.count} tiles`)]);
    const action=(type,extra={})=>perform('act',{roomId:room.id,version:room.version,type,...extra});
    const controls=el('div',{class:'domino-controls'});
    if(turn){
      controls.append(el('p',{},selected?'Choose the end to connect to:':'Your turn · select a tile'));
      for(const m of room.legal.filter(m=>selected&&tileKey(m.tile)===tileKey(selected)))controls.append(el('button',{disabled:busy,onclick:()=>action('play',m)},m.end==='start'?'Place opening tile':`Connect to ${room.ends.find(e=>e.key===m.end)?.pip} · ${m.end}`));
      controls.append(el('button',{disabled:busy||room.legal.length>0,onclick:()=>action('draw')},room.stockCount?`Draw a tile (${room.stockCount} left)`:'Pass'));
    }
    if(room.host===me&&['waiting','round_end'].includes(room.phase))controls.append(el('button',{disabled:busy||room.players.some(p=>!p.id&&!p.npc),onclick:()=>action(room.phase==='waiting'?'start':'next')},room.phase==='waiting'?'Start match':'Deal next round'));
    if(room.phase==='finished')controls.append(el('h2',{},`${room.players[room.winner]?.nickname||'Match'} wins!`));
    const requests=el('section',{},room.pending.map(p=>el('div',{class:'domino-request'},[el('span',{},`${p.nickname} wants to sit opposite you.`),el('button',{disabled:busy,onclick:()=>perform('respond',{roomId:room.id,target:p.id,accept:true})},'Accept'),el('button',{disabled:busy,onclick:()=>perform('respond',{roomId:room.id,target:p.id,accept:false})},'Decline')])));
    root.replaceChildren(el('main',{class:'domino-page'},[header,el('p',{class:'domino-meta'},`${room.mode==='online'?'Online':'Offline'} · Pair ${room.lane+1} · Round ${room.round} · Ends total ${room.total}`),requests,score(opponent),el('div',{class:'domino-opponent','aria-label':`${opponent.count} hidden tiles`},Array.from({length:opponent.count},()=>el('span',{class:'domino-back'},'◆'))),boardView(),score(own),el('div',{class:'domino-hand'},room.hand.map(t=>bone(t,{disabled:!turn||busy||!room.legal.some(m=>tileKey(m.tile)===tileKey(t)),class:`domino-bone ${selected&&tileKey(t)===tileKey(selected)?'selected':''}`,onclick:()=>{selected=t;draw();}}))),controls,el('p',{role:'status'},error||room.result),el('button',{class:'secondary',onclick:()=>{
      const d=el('dialog',{class:'rules-dialog'},[el('h2',{},'Leave this match?'),el('p',{},'Leaving ends this match for both players. The other pair at this table is unaffected.'),el('button',{onclick:()=>d.close()},'Cancel'),el('button',{onclick:async()=>{d.close();await perform('leave');if(!error)navigate('/');}},'Leave match')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
    }},'Leave match')]));
  }
  async function poll(){
    const identity=saved();if(fetching||!identity)return;fetching=true;const g=generation,id=identity.playerId;
    try{
      const data=await api('me',{active:mounted});if(g!==generation||saved()?.playerId!==id)return;
      room=data.room;
      const latest=data.requests[0];if(!room&&latest?.status==='declined')error='The host declined your request. Choose another pair.';
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
    try{const r=await api('open',{mode,chair});error='';navigate(`/?domino=${r.roomId}`);}catch(e){const d=el('dialog',{class:'rules-dialog'},[el('p',{},e.message),el('button',{onclick:()=>d.close()},'Close')]);d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();}
  }
  setInterval(poll,600);window.addEventListener('domino-open',e=>open(e.detail.mode,e.detail.seat));
  return {mount(){mounted=true;lastSignature='';draw();poll();},routeChanged(){mounted=false;generation++;selected=null;error='';resume.hidden=true;document.body.classList.remove('table-mode');}};
}
