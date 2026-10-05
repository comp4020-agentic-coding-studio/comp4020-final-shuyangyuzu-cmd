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
export function createTavern({ el, render, navigate, buildClassicPanel, lastActiveRoom, saveSession }) {
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
  function sprite(c,x,y,color,skin,scale=1,step=0) {
    c.save(); c.translate(Math.round(x),Math.round(y)); c.scale(scale,scale);
    const rect=(a,b,w,h,t)=>{c.fillStyle=t;c.fillRect(a,b,w,h);};
    c.fillStyle='#130e1760'; c.beginPath(); c.ellipse(0,1,12,4,0,0,Math.PI*2);c.fill();
    const leg=Math.sin(step)*2;
    rect(-7,-12,6,12+leg,'#393a52'); rect(1,-12,6,12-leg,'#393a52');
    rect(-8,leg-3,7,4,'#251f2d');rect(1,-leg-3,8,4,'#251f2d');
    rect(-10,-28,20,17,color);rect(-10,-13,20,3,'#00000022');
    rect(-14,-26,4,12,skin);rect(10,-26,4,12,skin);
    rect(-9,-45,18,18,skin);rect(-11,-48,22,8,'#43302d');
    rect(-11,-40,4,8,'#43302d');rect(7,-40,4,6,'#43302d');
    rect(-5,-36,2,3,'#302635');rect(4,-36,2,3,'#302635');rect(-2,-30,4,1,'#a56656');
    c.restore();
  }
  async function mount() {
    dispose(); document.body.classList.add('world-mode');
    let active=true, session=null, state={players:[]}, mine=null, camera={x:0,y:0}, path=[], moving=false, frame=0, busyPoll=false;
    let keys=new Set(), lastTime=0, destination=null, cameraInitialized=false, movementEpoch=0, heldDirection=null;
    const holdCleanups=[];
    dispose=()=>{active=false;holdCleanups.forEach(cleanup=>cleanup());document.body.classList.remove('world-mode');};
    const displayPositions=new Map();
    const timers=[];
    const canvas=el('canvas',{'aria-label':'Shared tavern map',tabindex:'0'});
    const toast=el('div',{class:'world-toast','role':'status'},'WASD / arrows to walk · click the floor to explore');
    const online=el('span',{class:'online-count'},'Connecting…');
    const hud=el('header',{class:'world-hud'},[
      el('div',{class:'world-brand'},[el('span',{class:'brand-mark'},'◆'),el('div',{},[el('strong',{},'THE AMBER ROOM'),el('small',{},'A little place to be together')])]),
      el('div',{class:'hud-actions'},[online,el('button',{class:'hud-button',onclick:()=>{path=[];chooseCharacter();}},'Your character'),el('button',{class:'hud-button',onclick:()=>openGames()},'Join by code')]),
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
    const scene=el('div',{class:'tavern-world'},[canvas,hud,toast,directions]); render(scene);
    const overlay=el('div',{class:'world-overlay'});scene.appendChild(overlay);
    let layout;
    try { layout=await read('/layout'); } catch(e) {toast.textContent=e.message;return;}
    if(!active)return;
    const tile=64, worldW=layout.gridCols*tile,worldH=layout.gridRows*tile;
    const fixtures=layout.furniture;
    const ctx=canvas.getContext('2d');
    let vw=window.innerWidth,vh=window.innerHeight;
    const resize=()=>{vw=window.innerWidth;vh=window.innerHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=vw*dpr;canvas.height=vh*dpr;canvas.style.width=vw+'px';canvas.style.height=vh+'px';ctx.setTransform(dpr,0,0,dpr,0,0);};resize();
    window.addEventListener('resize',resize);
    function walkable(x,y) {return x>=0&&x<layout.gridCols&&y>=0&&y<layout.gridRows&&!fixtures.some(f=>x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);}
    // Breadth-first path on a small grid; each submitted step is still checked
    // server-side. No client teleport, no optimistic persistent positions.
    function findPath(tx,ty) {
      if(!mine||!walkable(tx,ty))return [];
      const start=`${mine.x},${mine.y}`,end=`${tx},${ty}`,q=[[mine.x,mine.y]],prev=new Map([[start,null]]);
      for(let i=0;i<q.length;i++){const [x,y]=q[i];if(`${x},${y}`===end)break;
        for(const [dx,dy] of [[0,-1],[1,0],[0,1],[-1,0]]){const nx=x+dx,ny=y+dy,k=`${nx},${ny}`;if(walkable(nx,ny)&&!prev.has(k)){prev.set(k,`${x},${y}`);q.push([nx,ny]);}}
      }
      if(!prev.has(end))return [];const result=[];let key=end;while(key!==start){result.unshift(key.split(',').map(Number));key=prev.get(key);}return result;
    }
    function queueStep(dx,dy){if(!mine||moving||overlay.childElementCount)return;const x=mine.x+dx,y=mine.y+dy;if(walkable(x,y)){path=[[x,y]];destination={x,y};}}
    function reconcile(next){state=next;mine=state.players.find(p=>p.id===session?.playerId)||mine;online.textContent=`${state.players.length} here`;}
    async function poll(){if(!session||busyPoll||moving)return;busyPoll=true;const epoch=movementEpoch;try{const next=await read('/state');if(active&&epoch===movementEpoch&&!moving)reconcile(next);}catch(e){toast.textContent='Connection interrupted — retrying…';}finally{busyPoll=false;}}
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
    async function openTableDialog(f){
      path=[];
      let tableList;
      try{tableList=await read('/tables');}catch(e){toast.textContent='Could not reach the tables — try again.';return;}
      const t=tableList.find(x=>x.id===f.id);
      if(!t){toast.textContent='That table is not available.';return;}

      const taken=new Set(t.takenColors||[]);
      let selected=GAME_COLORS.find(c=>!taken.has(c))||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const canAct=t.status==='empty'||t.status==='waiting';

      const swatches=el('div',{class:'avatar-swatches','aria-label':'Table colour'},GAME_COLORS.map(c=>
        el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,disabled:taken.has(c),
          'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
          onclick:e=>{if(taken.has(c))return;selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
        },'')));

      const statusLine=t.status==='empty'?`${f.label} is empty.`
        :`${f.label} — ${t.playerCount}/4 ${t.status==='waiting'?'waiting to start':t.status==='in_progress'?'mid-game':'round over'}.`;
      const subtitle=canAct
        ? `Joining as ${mine?.nickname??'you'} — just pick a table colour.`
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
            const endpoint=t.status==='empty'?'create':'join';
            const result=await post(`/tables/${f.id}/${endpoint}`,{...session,color:selected});
            try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
            overlay.replaceChildren();
            navigate(`/?room=${result.code}`);
          }catch(err){error.textContent=err.message||'Could not join that table';btn.disabled=false;}
        }},t.status==='empty'?'Start a game here':'Join this table'));
      }
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
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
        try{const appearance={nickname:input.value.trim(),color,skin};if(session){reconcile(await post('/appearance',{...session,...appearance}));session={...session,...appearance};}else{session={...await post('/join',appearance),...appearance};}try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}overlay.replaceChildren();reconcile(await read('/state'));begin();}
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
      post('/heartbeat',session).catch(()=>{});poll();timers.push(setInterval(poll,1500),setInterval(()=>post('/heartbeat',session).catch(()=>{}),5000));
      const last=lastActiveRoom();if(last){hud.querySelector('.hud-actions').appendChild(el('button',{class:'hud-button',onclick:()=>navigate(`/?room=${last}`)},'Return to your game'));}
      toast.textContent='Welcome in. WASD / arrows to walk · click a destination';canvas.focus();
    }
    const keyDown=e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName)||overlay.childElementCount)return;const key=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();keys.add(key);path=[];}if(e.key==='Escape'){path=[];destination=null;}};
    const keyUp=e=>keys.delete(e.key.toLowerCase());const blur=()=>{keys.clear();heldDirection=null;path=[];};
    window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);
    canvas.addEventListener('click',e=>{
      if(!mine||overlay.childElementCount)return;const rect=canvas.getBoundingClientRect(),x=Math.floor((e.clientX-rect.left+camera.x)/tile),y=Math.floor((e.clientY-rect.top+camera.y)/tile);
      const f=fixtures.find(f=>x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);
      if(f){if(f.kind==='game_table'){if(f.available)openTableDialog(f);else toast.textContent=`${f.label}`;}else if(f.kind==='counter')toast.textContent='The kitchen is not open yet. Grab a game while you wait.';return;}
      path=findPath(x,y);destination=path.length?{x,y}:null;
    });
    async function step(x,y){
      moving=true;movementEpoch++;
      try{const next=await post('/move',{playerId:session.playerId,sessionSecret:session.sessionSecret,x,y});if(active)reconcile(next);}
      catch(e){path=[];destination=null;toast.textContent=e.status===403?'Your session could not be restored. Reload to rejoin.':'Could not move — try again.';await poll();}
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
        box(fc,x+18,y+30,8,25,'#352b2d');box(fc,x+40,y+30,8,25,'#352b2d');box(fc,x+10,y+9,45,29,'#9f7153');box(fc,x+14,y+8,37,22,'#b78163');box(fc,x+18,y+9,27,3,'#dbab7c');
      }else{
        box(fc,x-5,y+12,w+10,h,'#382a2d');box(fc,x-6,y,w+12,h,'#b78a59');box(fc,x,y+6,w,h-12,f.kind==='game_table'?(f.available?'#487c69':'#665969'):'#9c6848');
        box(fc,x+6,y+12,w-12,3,'#ffffff19');
        for(const cy of [y+22,y+h-44]){box(fc,x-27,cy,20,32,'#513d36');box(fc,x+w+7,cy,20,32,'#513d36');box(fc,x-26,cy,18,6,'#b68a60');box(fc,x+w+8,cy,18,6,'#b68a60');}
        if(f.kind==='game_table'){
          for(let i=0;i<3;i++){box(fc,x+30+i*23,y+33,17,26,'#eadcc5');box(fc,x+34+i*23,y+41,7,7,i%2?'#c87769':'#4d515d');}
          fc.textAlign='center';fc.font='bold 12px monospace';fc.fillStyle='#f7e6c6';fc.fillText(f.available?f.label:f.gameType.toUpperCase(),x+w/2,y+h-26);
          if(!f.available){fc.fillStyle='#d0c0b1';fc.font='10px monospace';fc.fillText('COMING LATER',x+w/2,y+h-12);}
        }else{box(fc,x+43,y+35,28,24,'#eee0bd');box(fc,x+51,y+40,12,12,'#bd8253');box(fc,x+77,y+29,11,18,'#94b0a5');}
      }
    }
    function animate(now){
      if(!active)return;frame=requestAnimationFrame(animate);
      if(session&&mine&&!moving&&now-lastTime>145&&!overlay.childElementCount){
        let dx=0,dy=0;if(keys.has('w')||keys.has('arrowup'))dy=-1;else if(keys.has('s')||keys.has('arrowdown'))dy=1;
        if(keys.has('a')||keys.has('arrowleft'))dx=-1;else if(keys.has('d')||keys.has('arrowright'))dx=1;
        if(heldDirection){dx=heldDirection.dx;dy=heldDirection.dy;}
        if(dx||dy){path=[];if(walkable(mine.x+dx,mine.y+dy)){lastTime=now;step(mine.x+dx,mine.y+dy);}}
        else if(path.length){lastTime=now;const [x,y]=path.shift();step(x,y);}else destination=null;
      }
      const target=mine||{x:20,y:12};const desiredX=Math.max(0,Math.min(Math.max(0,worldW-vw),(target.x+.5)*tile-vw/2)),desiredY=Math.max(0,Math.min(Math.max(0,worldH-vh),(target.y+.5)*tile-vh/2));
      if(!cameraInitialized){camera={x:desiredX,y:desiredY};cameraInitialized=true;}else{camera.x+=(desiredX-camera.x)*.12;camera.y+=(desiredY-camera.y)*.12;}
      ctx.clearRect(0,0,vw,vh);ctx.imageSmoothingEnabled=false;ctx.drawImage(floor,-Math.round(camera.x),-Math.round(camera.y));
      if(destination){ctx.strokeStyle='#ecd29b';ctx.lineWidth=2;ctx.strokeRect(destination.x*tile-camera.x+8,destination.y*tile-camera.y+8,tile-16,tile-16);}
      for(const p of [...state.players].sort((a,b)=>a.y-b.y)){
        let pos=displayPositions.get(p.id);if(!pos){pos={x:p.x,y:p.y};displayPositions.set(p.id,pos);}
        const walking=Math.abs(pos.x-p.x)+Math.abs(pos.y-p.y)>.02;pos.x+=(p.x-pos.x)*.22;pos.y+=(p.y-pos.y)*.22;
        const x=(pos.x+.5)*tile-camera.x,y=(pos.y+.75)*tile-camera.y;
        sprite(ctx,x,y,colors[p.color]||colors.green,skins[p.skin]||skins.warm,1.15,walking?now/90:0);
        ctx.font='12px monospace';ctx.textAlign='center';const label=p.nickname+(p.id===mine?.id?' · you':'');const width=ctx.measureText(label).width+14;
        box(ctx,x-width/2,y-72,width,20,'#292635dc');ctx.fillStyle='#f5e7d2';ctx.fillText(label,x,y-58);
      }
      if(!session){sprite(ctx,vw/2,vh/2+60,colors.green,skins.warm,1.2);}
      const shade=ctx.createRadialGradient(vw/2,vh/2,100,vw/2,vh/2,Math.max(vw,vh)*.7);shade.addColorStop(0,'#100d1800');shade.addColorStop(1,'#100d1870');ctx.fillStyle=shade;ctx.fillRect(0,0,vw,vh);
    }
    frame=requestAnimationFrame(animate);
    dispose=()=>{active=false;cancelAnimationFrame(frame);timers.forEach(clearInterval);holdCleanups.forEach(cleanup=>cleanup());window.removeEventListener('resize',resize);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);document.body.classList.remove('world-mode');};
    try{session=JSON.parse(localStorage.getItem(sessionKey)||'null');}catch{}
    if(session){try{reconcile(await post('/rejoin',session));if(active){if(enteredThisPage)begin();else chooseCharacter();}}catch(e){if(e.status===403){session=null;localStorage.removeItem(sessionKey);chooseCharacter();}else toast.textContent='Unable to reconnect. Reload to retry.';}}
    else chooseCharacter();
  }
  return {mount,stop:()=>dispose()};
}
