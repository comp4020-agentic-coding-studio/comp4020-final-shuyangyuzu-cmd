// Online Blackjack: the server owns the shoe, turn order, chips and settlement.
export function createBlackjackUI({el,navigate,render}) {
  let mounted=false,generation=0,polling=false,busy=false,room=null,owner='',error='',bet=10,lastVersion=null,lastMove='',animate=false,waitlist=[],lastAwaySignature='';
  // 2026-11-08 correction — the exact same gap CLAUDE.md already
  // documents for poker's own away flag: setBlackjackAway deliberately
  // never bumps blackjack_rooms.version (version is also actBlackjack's
  // own optimistic-concurrency counter, and a presence/display-only
  // change must never race a real in-flight action over it). Without an
  // independent redraw trigger, another seated player's own browser
  // never noticed someone else's away toggle at all — found by a real
  // two-browser click-through (B's own page kept showing "Choosing
  // wager" after A clicked "I'm away", even though the server's own
  // state was already correct) — mirrors poker.js's identical
  // awaySignature fix exactly.
  const awaySignature=r=>r?r.players.map(p=>`${p.id}:${p.away?1:0}`).join(','):'';
  const resume=el('aside',{class:'domino-resume',hidden:true});document.body.append(resume);
  const identity=()=>{try{return JSON.parse(localStorage.getItem('vegas:bar:session')||'null')}catch{return null}};
  let noticeDialog=null,noticeOwner='';
  function closeNotice(){noticeDialog?.close();noticeDialog?.remove();noticeDialog=null;noticeOwner='';}
  function showNotice(message,id){
    if(noticeDialog&&noticeOwner===id)return;
    closeNotice();noticeOwner=id;
    const feedback=el('p',{role:'alert'});
    noticeDialog=el('dialog',{class:'rules-dialog','aria-label':'Out of chips'},[
      el('h2',{},'Out of chips'),el('p',{},message),feedback,
      button('Return to the bar',async()=>{try{await api('ack');closeNotice();navigate('/')}catch(e){feedback.textContent=e.message}})
    ]);
    noticeDialog.addEventListener('cancel',e=>e.preventDefault());document.body.append(noticeDialog);noticeDialog.showModal();
  }
  async function api(action,body={}){
    const session=identity();if(!session)throw Error('Enter the tavern first');
    const res=await fetch('/api/blackjack/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,playerId:session.playerId,sessionSecret:session.sessionSecret})});
    const data=await res.json();if(!res.ok)throw Error(data.message||'Request failed');return data;
  }
  async function command(action,body={}){
    if(busy)return;busy=true;const gen=generation;error='';
    try {await api(action,body);}catch(e){if(gen===generation)error=e.message;}
    finally{busy=false;if(gen===generation){lastVersion=null;await poll();}}
  }
  function button(label,fn,disabled=false){return el('button',{disabled:disabled||busy,onclick:fn},label);}
  async function poll(){
    if(polling)return;const who=identity();if(noticeOwner&&noticeOwner!==who?.playerId)closeNotice();if(!who){resume.hidden=true;if(mounted){room=null;error='Enter the tavern to log in or choose a character first.';draw();}return;}
    const gen=generation;polling=true;
    try {
      const data=await api('me',{active:mounted});if(gen!==generation||who.playerId!==identity()?.playerId)return;
      if(owner!==who.playerId){owner=who.playerId;lastVersion=null;lastMove='';room=null;}
      room=data.room;waitlist=data.waitlist||[];
      if(data.notice){showNotice(data.notice,who.playerId);if(mounted){room=null;error=data.notice;}}
      resume.hidden=mounted||!room||location.search!=='';
      if(!resume.hidden)resume.replaceChildren(button('Return to Blackjack',()=>navigate('/?blackjackOnline='+room.id)),button('Leave table',()=>command('leave')));
      const nextAwaySignature=awaySignature(room);
      if(mounted&&(lastVersion!==room?.version||nextAwaySignature!==lastAwaySignature||!room||error)){
        const key=room?JSON.stringify([room.hand,room.lastMove]):'';animate=!!lastMove&&lastMove!==key;lastMove=key;
        lastVersion=room?.version;lastAwaySignature=nextAwaySignature;draw();animate=false;
      }
    }catch(e){if(gen===generation&&mounted){error=e.message;draw();}}
    finally{polling=false;}
  }
  async function join(seat='red',target){
    if(busy)return;busy=true;const gen=generation;
    try {const result=await api('open',{seat,roomId:target});if(gen===generation)navigate('/?blackjackOnline='+result.roomId);}
    catch(e){
      error=e.message;
      // 2026-11-07: a refused mid-hand/full-table join also registered
      // this identity on the server's own waitlist (openBlackjack) — poll
      // right away so draw()'s "no room" branch picks up the fresh
      // waitlist entry instead of just showing the one-shot error text.
      if(mounted){lastVersion=null;await poll();}
      else{resume.hidden=false;resume.replaceChildren(el('p',{role:'alert'},error),button('Close',()=>{resume.hidden=true;}));}
    }
    finally{busy=false;}
  }
  function draw(){
    if(!mounted)return;
    if(!room){
      const target=new URLSearchParams(location.search).get('blackjackOnline');
      const ready=waitlist.find(w=>w.notified),waiting=waitlist.find(w=>!w.notified);
      const body=ready
        ? [el('p',{role:'status',class:'bj-waitlist-ready'},'A seat is free now.'),
           button('Sit down now',()=>join('red',ready.roomId)),
           button('Never mind',()=>command('leaveWaitlist',{roomId:ready.roomId}))]
        : waiting
        ? [el('p',{role:'status'},'Waiting for a seat to open…'),
           button('Stop waiting',()=>command('leaveWaitlist',{roomId:waiting.roomId}))]
        : [el('p',{role:'status'},error||'Join this table and play against the dealer with your friends.'),
           ...(identity()?[button('Join table',()=>join('red',target||undefined))]:[])];
      render(el('main',{class:'poker-page bj-room'},[el('h1',{},'Blackjack Online'),...body,
        button('Back to the bar',()=>navigate('/'))]));return;
    }
    const r=room,me=r.players.find(p=>p.id===owner),between=['betting','settled'].includes(r.phase);
    const color=['#bc655c','#658ab5','#70a88b','#d4ad60'];
    const nameplate=(label,seat)=>el('strong',{class:'bj-nameplate'},[el('span',{class:'poker-avatar',style:'--shirt:'+(color[seat]||'#d8c6a3'),'aria-hidden':'true'},['head','shirt','legs'].map(x=>el('i',{class:'avatar-'+x}))),label]);
    const cards=(values,seat)=>el('div',{class:'bj-card-row'},values.map((c,i)=>el('span',{class:'poker-card '+(c==null?'card-back':/[♥♦]/.test(c)?'red':'')+(animate&&r.lastMove?.seat===seat&&r.lastMove?.card===i?' bj-new-card':''),'aria-label':c??'Dealer hole card'},c??'◆')));
    const points=values=>{let n=0,a=0;for(const c of values){const k=c.slice(0,-1);a+=k==='A'?1:0;n+=k==='A'?1:['K','Q','J'].includes(k)?10:Number(k)}return a&&n<=11?n+10:n};
    const felt=el('section',{class:'bj-felt','aria-label':'Semicircle blackjack table'},[
      el('div',{class:'bj-dealer'},[nameplate('Dealer',-1),cards(r.dealer,'dealer'),el('small',{},String(r.dealerTotal||''))]),
      ...[0,1,2,3].map(seat=>{const p=r.players.find(p=>p.seat===seat);return el('div',{class:'bj-seat bj-seat-'+seat+(p?.id===owner?' own':'')},[
        nameplate(p?p.nickname+(p.id===owner?' · You':''):'Empty seat',seat),
        ...r.hands.filter(h=>h.seat===seat).map(h=>el('div',{class:r.turn===h.owner&&!h.done?'bj-active':''},[cards(h.cards,seat),el('small',{},points(h.cards)+(h.result?' · '+h.result:''))])),
        ...(p?[el('small',{class:'bj-personality'},p.stack+' chips · '+(p.leaving?'Left':p.away?'Away':between?(p.ready?'Ready · '+p.bet:'Choosing wager'):!r.hands.some(h=>h.owner===p.id)?'Next hand':'Bet '+p.bet))]:[])
      ])})]);
    const controls=[];
    if(between&&me){
      for(const amount of [2,10,20,50])controls.push(button(String(amount),()=>{bet=amount;draw()},me.ready||amount>me.stack||bet===amount));
      controls.push(button(me.ready?'Unready':'Ready · '+bet,()=>command('act',{roomId:r.id,version:r.version,action:me.ready?'Unready':'Ready',bet}),!me.ready&&bet>me.stack));
      if(r.host===owner)controls.push(button('Deal',()=>command('act',{roomId:r.id,version:r.version,action:'Deal'}),!r.players.filter(p=>!p.leaving).every(p=>p.ready)));
    }
    for(const action of r.choices)controls.push(button(action,()=>command('act',{roomId:r.id,version:r.version,action})));
    const actor=r.players.find(p=>p.id===r.turn);
    const status=between?'Choose your wager and ready up. The host deals when everyone is ready.':r.phase==='insurance'?'Dealer shows an ace. Choose insurance or decline.':r.phase==='dealer'?'Dealer’s turn':actor?.id===owner?'Your turn':(actor?.nickname??'Player')+'’s turn';
    const move=r.lastMove;const moveName=move?.seat==='dealer'?'Dealer':r.players.find(p=>p.seat===move?.seat)?.nickname;
    const link=location.origin+'/?blackjackOnline='+r.id;
    render(el('main',{class:'poker-page bj-room','aria-label':'Blackjack Online'},[
      el('header',{class:'poker-header bj-header'},[el('h1',{},'Blackjack'),el('strong',{},'Online · Hand '+r.hand),
        // Explicit, display-only away toggle (2026-11-08, mirrors
        // poker.js's own identical button exactly) — distinct from
        // "Leave table" below: away keeps the seat reserved (no one else
        // can take it) and is visible to every other seated player, but
        // never releases the seat or affects turn-taking/timeouts.
        ...(me?[button(me.away?"I'm back":"I'm away",()=>command('away',{away:!me.away}))]:[]),
        button('Back to the bar',()=>navigate('/'))]),
      el('div',{class:'bj-actions'},[el('input',{readonly:true,value:link,'aria-label':'Invite link'}),button('Copy invite',async()=>{try{await navigator.clipboard.writeText(link)}catch{error='Copy the link from the field above.';draw()}})]),felt,
      el('section',{class:'poker-controls','aria-label':'Blackjack actions'},[el('p',{role:'status'},status),el('p',{},moveName&&move?moveName+' · '+move.action:''),el('p',{role:'alert',class:'error'},error),el('div',{class:'bj-actions'},controls),
        button('Leave table',async()=>{if(busy)return;busy=true;try{await api('leave');room=null;navigate('/')}catch(e){error=e.message;draw()}finally{busy=false}}),
        el('p',{class:'note'},'Back to the bar keeps your seat for 3 minutes. Leave table releases it immediately. A 45-second turn timeout stands automatically.')]),
      el('details',{},[el('summary',{},'Table rules'),el('p',{},'Beat the dealer without exceeding 21. Dealer stands on all 17s. Natural blackjack pays 3:2; other wins pay 1:1. Double draws exactly one card. Split equal-value cards once; split aces receive one card each. Insurance costs half your wager and pays 2:1. Everyone starts with 500 play chips. A hand in progress refuses new arrivals until it ends — you are notified the moment a seat opens.')])
    ]));
  }
  window.addEventListener('blackjack-open',e=>join(e.detail?.seat||'red'));
  setInterval(poll,750);
  return {routeChanged(){generation++;mounted=false;lastVersion=null;room=null;error='';resume.hidden=true;},mount(){mounted=true;owner=identity()?.playerId??'';poll();}};
}
