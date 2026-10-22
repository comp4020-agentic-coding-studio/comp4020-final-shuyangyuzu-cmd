// Seat rotation is presentation only: preserve the server's seat order,
// always put the viewer at the near edge, and render only dealt cards
// supplied by the authenticated snapshot (opponents remain face down).
export function renderPokerTable(el,room,viewerId) {
  const suits={c:'♣',d:'♦',h:'♥',s:'♠'};
  const card=c=>el('span',{class:`poker-card ${c?'dh'.includes(c[1])?'red':'':'card-back'}`,'aria-label':c?`${c[0]}${suits[c[1]]}`:'Hidden card'},c?`${c[0]}${suits[c[1]]}`:'◆');
  const me=room.players.find(p=>p.id===viewerId),anchor=me?.seat??0;
  const between=['waiting','showdown'].includes(room.phase);
  const colors=['#bc655c','#658ab5','#70a88b','#d4ad60','#9d7bb5'];
  const seats=[];
  for(let i=0;i<5;i++){
    const seat=(anchor+i)%5,p=room.players.find(p=>p.seat===seat&&(!p.leaving||!between));
    const angle=(90+i*72)*Math.PI/180;
    const at=r=>`left:${50+r*Math.cos(angle)}%;top:${50+r*Math.sin(angle)}%;`;
    const north=i===2||i===3;
    seats.push(el('article',{class:`poker-seat${north?' poker-seat-north':''}${p?.id===room.actor?' current-turn':''}${p?'':' vacant'}`,style:at(39)+`--shirt:${colors[seat]}`,'aria-label':p?`${p.nickname}${p.id===viewerId?' · You':''}, seat ${seat+1}`:`Empty seat ${seat+1}`},[
      el('div',{class:'poker-chair','aria-hidden':'true'},p?[el('div',{class:'poker-avatar'},[el('i',{class:'avatar-head'}),el('i',{class:'avatar-shirt'}),el('i',{class:'avatar-legs'})])]:[]),
      el('div',{class:'poker-seat-label'},[
        el('strong',{title:p?.nickname??'Empty seat'},p?`${p.nickname}${p.id===viewerId?' · You':p.npc?' · NPC':''}`:'Empty seat'),
        ...(p?[el('span',{class:'poker-stack'},`${p.stack} chips`),el('small',{},[p.seat===room.dealer?'D · Dealer':'',p.waiting?'Next hand':'',p.leaving?'Left':'',p.folded?'Folded':'',!p.stack&&!p.waiting?(between?'Out of chips':'All in'):'',p.handName??''].filter(Boolean).join(' · '))]:[]),
      ]),
    ]));
    if(p&&!p.waiting&&room.hand>0)seats.push(el('div',{class:`poker-hand-zone${north?' poker-hand-north':''}${p.folded?' folded':''}`,style:at(north?18:24),'aria-label':`${p.nickname}'s cards and bet`},[
      el('div',{class:'poker-cards'},p.hole.length?p.hole.map(card):[card(null),card(null)]),
      ...(p.bet>0?[el('span',{class:'poker-wager'},[el('i',{'aria-hidden':'true'},'●'),` ${p.bet}`])]:[]),
    ]));
  }
  return el('section',{class:'poker-table-scene','aria-label':'Five seats around the poker table'},[
    el('div',{class:'poker-round-felt','aria-hidden':'true'}),
    el('div',{class:'poker-table-center'},[
      el('span',{class:'poker-table-brand'},'LAS VEGAS'),
      el('p',{class:'poker-pot'},`${between?'Last pot':'Pot'} · ${room.pot}`),
      el('div',{class:'poker-community','aria-label':'Community cards'},[...room.board.map(card),...Array.from({length:5-room.board.length},()=>el('span',{class:'poker-card empty','aria-label':'Undealt community card'},'·'))]),
      el('span',{class:'poker-street'},room.phase.toUpperCase()),
    ]),...seats,
  ]);
}

export function createPokerUI({el,navigate}) {
  let session=null,room=null,lastVersion=null,mounted=false,polling=false,error='',query='',results=[],raiseTo='',lastInvite='',generation=0;
  const banner=el('aside',{class:'poker-invite',hidden:true});document.body.append(banner);
  const resume=el('aside',{class:'poker-resume',hidden:true});document.body.append(resume);
  let bankruptcyDialog=null,bankruptcyId='',bankruptcyOwner='';
  function dismissBankruptcy(){bankruptcyDialog?.close();bankruptcyDialog?.remove();bankruptcyDialog=null;bankruptcyId='';bankruptcyOwner='';}
  function showBankruptcy(notice,owner){
    if(bankruptcyId===notice.id&&bankruptcyOwner===owner)return;
    dismissBankruptcy();bankruptcyId=notice.id;bankruptcyOwner=owner;
    const errorLine=el('p',{class:'error',role:'status'});
    const dialog=el('dialog',{class:'rules-dialog poker-bankruptcy','aria-labelledby':'poker-bankruptcy-title'},[
      el('h2',{id:'poker-bankruptcy-title'},'Out of chips'),
      el('p',{},'Your chips have run out. This hand has been settled and you have automatically left the table.'),
      el('p',{},`Hand ${notice.hand} · ${notice.result||'Settlement complete'}`),
      el('p',{class:'note'},'Click below to return to the bar. You can choose another table when you are ready.'),errorLine,
      el('button',{onclick:async e=>{
        const button=e.currentTarget;button.disabled=true;
        if(saved()?.playerId!==owner){dismissBankruptcy();return;}
        try{
          await api('ack-exit',{noticeId:notice.id});
          if(saved()?.playerId!==owner){dismissBankruptcy();return;}
          generation++;mounted=false;room=null;lastVersion=null;error='';
          document.body.classList.remove('table-mode');dismissBankruptcy();navigate('/');
        }catch(err){errorLine.textContent=err.message;button.disabled=false;}
      }},'Return to the bar'),
    ]);
    dialog.addEventListener('cancel',e=>e.preventDefault());
    document.body.append(dialog);bankruptcyDialog=dialog;dialog.showModal();
  }
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
    if(polling)return;session=saved();
    if(bankruptcyDialog&&session?.playerId!==bankruptcyOwner)dismissBankruptcy();
    if(!session)return;
    const id=session.playerId,current=generation;polling=true;
    try{
      const data=await api('me');if(saved()?.playerId!==id||current!==generation)return;
      room=data.room;
      if(data.departure){
        banner.hidden=true;resume.hidden=true;lastInvite='';
        if(mounted&&!room){
          const root=document.getElementById('app');
          root?.replaceChildren(el('main',{class:'poker-page'},[el('h1',{},'Texas Hold’em'),el('p',{},'Your hand is complete. You have left the table with 0 chips.')]));
        }
        showBankruptcy(data.departure,id);return;
      }
      if(bankruptcyDialog)dismissBankruptcy();
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
    const controls=el('section',{class:'poker-controls'},[el('p',{},turn?'Your turn':between?(room.hand?'Review the result. The host deals the next hand.':'Invite a friend. At least two funded players are needed to start.'):`Waiting for ${room.players.find(p=>p.id===room.actor)?.nickname||'the table'}`),...buttons]);
    const invitePanel=[];
    if(room.mode==='online'){
      const input=el('input',{'aria-label':'Search online players',placeholder:'Search online player nickname',value:query,oninput:e=>{query=e.target.value;}});
      invitePanel.push(el('section',{class:'poker-search'},[
        el('h2',{},'Invite friends'),input,
        el('button',{onclick:async()=>{try{results=(await api('search',{query})).players;draw();}catch(e){notify(e);}}},'Search'),
        el('ul',{},results.map(p=>el('li',{},[`${p.nickname} · ${p.id.slice(0,6)} `,el('button',{onclick:async()=>{try{await api('invite',{roomId:room.id,target:p.id});error=`Invitation sent to ${p.nickname}`;draw();}catch(e){notify(e);}}},'Invite')]))),
      ]));
    }
    const rules=el('details',{class:'poker-rules'},[el('summary',{},'📜 How to play'),el('p',{},'No-limit Texas Hold’em · 2–5 players · 500 play chips · blinds 1/2. Two private cards, five community cards; make the best five-card hand. Fold, check, call, bet or raise. All-in players can win only pots they contributed to; equal hands split the pot. Dealer and blinds rotate each hand. New arrivals wait for the next deal. Leaving folds your hand, except an all-in remains eligible. 45-second turn limit: check if free, otherwise fold on timeout. Disconnects reserve your seat for three minutes; Leave table exits immediately. If you have zero chips after settlement, you automatically leave the table. A popup explains the result; click Return to the bar to continue. An all-in is never removed before payouts. There is no in-place rebuy. No real-money stakes.'),el('a',{href:'https://www.pokerstars.com/poker/games/texas-holdem/',target:'_blank',rel:'noopener'},'Hold’em rules reference')]);
    root.replaceChildren(el('main',{class:'poker-page'},[
      el('header',{class:'poker-header'},[el('h1',{},'Texas Hold’em'),el('span',{},`${room.mode==='offline'?'Offline · NPC opponents':'Online · invitation table'} · Hand ${room.hand}`),el('button',{onclick:async()=>{try{await api('leave');generation++;room=null;navigate('/');}catch(e){notify(e);}}},'Leave table')]),
      rules,el('p',{class:'error',role:'status'},error),
      renderPokerTable(el,room,session.playerId),
      el('p',{class:'poker-result',role:'status'},room.result),controls,...invitePanel,
    ]));
  }
  function mount(){document.body.classList.add('table-mode');mounted=true;error='';lastVersion=null;draw();poll();}
  function routeChanged(){if(mounted&&!new URLSearchParams(location.search).has('poker')){generation++;document.body.classList.remove('table-mode');mounted=false;room=null;api('leave').catch(()=>{});}}
  async function open(mode,seat){try{const data=await api('open',{mode,seat});navigate(`/?poker=${data.roomId}`);}catch(e){notify(e);}}
  setInterval(poll,1000);poll();
  window.addEventListener('poker-open',e=>open(e.detail.mode,e.detail.seat));
  return {mount,routeChanged};
}
