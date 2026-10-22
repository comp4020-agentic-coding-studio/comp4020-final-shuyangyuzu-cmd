export function createPokerUI({el,navigate}) {
  let session=null,room=null,lastVersion=null,mounted=false,polling=false,error='',query='',results=[],raiseTo='',lastInvite='',generation=0;
  const banner=el('aside',{class:'poker-invite',hidden:true});document.body.append(banner);
  const resume=el('aside',{class:'poker-resume',hidden:true});document.body.append(resume);
  function saved(){try{return JSON.parse(localStorage.getItem('vegas:bar:session')||'null');}catch{return null;}}
  async function api(action,body={}){
    const identity=saved();if(!identity)throw Error('Enter the tavern and choose a character first');
    const res=await fetch(`/api/poker/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...identity,...body})});
    const data=await res.json();if(!res.ok)throw Error(data.message||'Request failed');return data;
  }
  function notify(e){error=e.message||String(e);if(mounted)draw();else {
    banner.hidden=false;
    if(lastInvite){banner.querySelector('[role="status"]')?.remove();banner.appendChild(el('p',{role:'status'},error));}
    else banner.replaceChildren(el('p',{role:'status'},error),el('button',{onclick:()=>{error='';banner.hidden=true;}},'Close'));
  }}
  async function poll(){
    if(polling)return;session=saved();if(!session)return;
    const id=session.playerId,current=generation;polling=true;
    try{
      const data=await api('me');if(saved()?.playerId!==id||current!==generation)return;
      room=data.room;
      if(mounted&&!room)error='You are no longer seated. Return to the bar to join a table.';
      if(mounted&&(room?.version!==lastVersion||!room)){lastVersion=room?.version;draw();}
      const invite=data.invites[0];
      if(invite&&invite.id!==lastInvite){
        lastInvite=invite.id;banner.hidden=false;
        banner.replaceChildren(el('strong',{},`${invite.sender} invited you to Texas Hold’em`),el('p',{},'500 starting chips · join next hand if play has begun'),el('div',{},[
          el('button',{onclick:async()=>{try{const r=await api('respond',{inviteId:invite.id,join:true});banner.hidden=true;lastInvite='';navigate(`/?poker=${r.roomId}`);await poll();}catch(e){notify(e);}}},'Join'),
          el('button',{class:'secondary',onclick:async()=>{try{await api('respond',{inviteId:invite.id,join:false});banner.hidden=true;lastInvite='';}catch(e){notify(e);}}},'Decline'),
        ]));
      }else if(!invite&&lastInvite){banner.hidden=true;lastInvite='';}
      resume.hidden=mounted||!room;
      if(room&&!mounted)resume.replaceChildren(el('button',{onclick:()=>navigate(`/?poker=${room.id}`)},'Return to poker'),el('button',{onclick:async()=>{try{await api('leave');resume.hidden=true;}catch(e){notify(e);}}},'Leave table'));
    }catch(e){if(mounted)notify(e);}finally{polling=false;}
  }
  const suits={c:'♣',d:'♦',h:'♥',s:'♠'};
  function card(c){return el('span',{class:`poker-card ${c&&'dh'.includes(c[1])?'red':''}`,'aria-label':c?`${c[0]}${suits[c[1]]}`:'Hidden card'},c?`${c[0]}${suits[c[1]]}`:'◆');}
  function draw(){
    const root=document.getElementById('app');if(!mounted||!root)return;
    if(!room){root.replaceChildren(el('main',{class:'poker-page'},[el('h1',{},'Texas Hold’em'),el('p',{},error||'Loading your table…'),el('button',{onclick:()=>navigate('/')},'Back to the bar')]));return;}
    const me=room.players.find(p=>p.id===session.playerId),turn=room.actor===session.playerId;
    const between=['waiting','showdown'].includes(room.phase),buttons=[];
    const perform=async(type,to)=>{try{await api('act',{roomId:room.id,version:room.version,type,to});error='';raiseTo='';await poll();}catch(e){notify(e);}};
    if(turn){
      const call=Math.min(me.stack,Math.max(0,room.currentBet-me.bet));
      buttons.push(el('button',{onclick:()=>perform('fold')},'Fold'),el('button',{onclick:()=>perform(call?'call':'check')},call?`Call ${call}`:'Check'));
      if(me.stack>0)buttons.push(el('button',{disabled:!me.canRaise&&me.bet+me.stack>room.currentBet,onclick:()=>perform('allin')},`All in ${me.stack}`));
      if(me.canRaise&&me.bet+me.stack>room.currentBet){
        const min=room.currentBet+room.minRaise;
        const amount=el('input',{type:'number',min,max:me.stack+me.bet,value:raiseTo||String(min),'aria-label':'Raise to',oninput:e=>{raiseTo=e.target.value;}});
        buttons.push(el('label',{},['Raise to ',amount]),el('button',{onclick:()=>perform('raise',Number(amount.value))},'Bet / Raise'));
      }
    }
    if(between&&room.host===session.playerId)buttons.push(el('button',{disabled:room.players.filter(p=>!p.leaving&&(p.stack>0||p.npc)).length<2,onclick:()=>perform('deal')},room.hand?'Deal next hand':'Start game'));
    if(between&&me?.stack===0)buttons.push(el('button',{onclick:()=>perform('rebuy')},'Rebuy 500 play chips'));
    const controls=el('section',{class:'poker-controls'},[el('p',{},turn?'Your turn':between?(room.hand?'Review the result. The host deals the next hand.':'Invite a friend. At least two funded players are needed to start.'):`Waiting for ${room.players.find(p=>p.id===room.actor)?.nickname||'the table'}`),...buttons]);
    const players=room.players.filter(p=>!p.leaving||!between).map(p=>el('article',{class:`poker-player ${p.id===room.actor?'current-turn':''}`},[
      el('strong',{},`${p.nickname}${p.npc?' · NPC':''}${p.id===session.playerId?' · You':''}`),
      el('small',{},`${p.seat===room.dealer?'Dealer · ':''}${p.waiting?'Next hand · ':''}${p.leaving?'Left · ':''}${p.folded?'Folded · ':''}${!p.stack&&!p.waiting?(between?'Out of chips · ':'All in · '):''}Stack ${p.stack} · Bet ${p.bet}`),
      el('div',{class:'poker-cards'},p.hole.length?p.hole.map(card):[card(null),card(null)]),
      ...(p.handName?[el('small',{},p.handName)]:[]),
    ]));
    const invitePanel=[];
    if(room.mode==='online'){
      const input=el('input',{'aria-label':'Search online players',placeholder:'Search online player nickname',value:query,oninput:e=>{query=e.target.value;}});
      invitePanel.push(el('section',{class:'poker-search'},[
        el('h2',{},'Invite friends'),input,
        el('button',{onclick:async()=>{try{results=(await api('search',{query})).players;draw();}catch(e){notify(e);}}},'Search'),
        el('ul',{},results.map(p=>el('li',{},[`${p.nickname} · ${p.id.slice(0,6)} `,el('button',{onclick:async()=>{try{await api('invite',{roomId:room.id,target:p.id});error=`Invitation sent to ${p.nickname}`;draw();}catch(e){notify(e);}}},'Invite')]))),
      ]));
    }
    const rules=el('details',{class:'poker-rules'},[el('summary',{},'📜 How to play'),el('p',{},'No-limit Texas Hold’em · 2–5 players · 500 play chips · blinds 1/2. Two private cards, five community cards; make the best five-card hand. Fold, check, call, bet or raise. All-in players can win only pots they contributed to; equal hands split the pot. Dealer and blinds rotate each hand. New arrivals wait for the next deal. Leaving folds your hand, except an all-in remains eligible. 45-second turn limit: check if free, otherwise fold on timeout. Disconnects reserve your seat for three minutes; Leave table exits immediately. No real-money stakes.'),el('a',{href:'https://www.pokerstars.com/poker/games/texas-holdem/',target:'_blank',rel:'noopener'},'Hold’em rules reference')]);
    root.replaceChildren(el('main',{class:'poker-page'},[
      el('header',{class:'poker-header'},[el('h1',{},'Texas Hold’em'),el('span',{},`${room.mode==='offline'?'Offline · NPC opponents':'Online · invitation table'} · Hand ${room.hand}`),el('button',{onclick:async()=>{try{await api('leave');generation++;room=null;navigate('/');}catch(e){notify(e);}}},'Leave table')]),
      rules,el('p',{class:'error',role:'status'},error),
      el('section',{class:'poker-felt'},[el('p',{class:'eyebrow'},`${room.phase.toUpperCase()} · ${between?'Last pot':'Pot'} ${room.pot}`),el('div',{class:'poker-community','aria-label':'Community cards'},[...room.board.map(card),...Array.from({length:5-room.board.length},()=>el('span',{class:'poker-card empty'},'·'))]),el('p',{class:'poker-result'},room.result)]),
      el('section',{class:'poker-players'},players),controls,...invitePanel,
    ]));
  }
  function mount(){document.body.classList.add('table-mode');mounted=true;error='';lastVersion=null;draw();poll();}
  function routeChanged(){if(mounted&&!new URLSearchParams(location.search).has('poker')){generation++;document.body.classList.remove('table-mode');mounted=false;room=null;api('leave').catch(()=>{});}}
  async function open(mode,seat){try{const data=await api('open',{mode,seat});navigate(`/?poker=${data.roomId}`);}catch(e){notify(e);}}
  setInterval(poll,1000);poll();
  window.addEventListener('poker-open',e=>open(e.detail.mode,e.detail.seat));
  return {mount,routeChanged};
}
