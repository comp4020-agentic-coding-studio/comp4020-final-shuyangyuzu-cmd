import { expect, inject, it } from 'vitest';
const base=inject('baseUrl');
async function post(path:string,body:unknown){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),cache:r.headers.get('cache-control')};}
it('plays invitation-only poker over HTTP, hides cards, waits mid-hand arrivals and preserves refresh state',async()=>{
  expect((await post('/api/poker/me',null)).status).toBe(400);
  const a=(await post('/api/bar/join',{nickname:'Poker HTTP Alice',color:'teal'})).body;
  const b=(await post('/api/bar/join',{nickname:'Poker HTTP Bob',color:'orange'})).body;
  const c=(await post('/api/bar/join',{nickname:'Poker HTTP Carol',color:'pink'})).body;
  const sessions=[a,b,c],opened=await post('/api/poker/open',{...a,mode:'online'});expect(opened.status).toBe(200);const roomId=opened.body.roomId;
  const me=async(s:typeof a)=>(await post('/api/poker/me',s)).body;
  const invite=async(s:typeof a)=>{
    await me(s);expect((await post('/api/poker/invite',{...a,roomId,target:s.playerId})).status).toBe(200);
    const invitation=(await me(s)).invites[0];expect(invitation.sender).toBe('Poker HTTP Alice');
    expect((await post('/api/poker/respond',{...s,inviteId:invitation.id,join:true})).status).toBe(200);
  };
  try {
    await invite(b);
    expect((await post('/api/poker/me',a)).cache).toBe('private, no-store');
    let state=(await me(a)).room;
    expect((await post('/api/poker/act',{...b,roomId,version:state.version,type:'deal'})).status).toBe(409);
    expect((await post('/api/poker/act',{...a,roomId,version:state.version,type:'deal'})).status).toBe(200);
    state=(await me(a)).room;
    expect(state.players.find((p:any)=>p.id===a.playerId).hole).toHaveLength(2);
    expect(state.players.find((p:any)=>p.id===b.playerId).hole).toEqual([]);expect(state.deck).toBeUndefined();
    expect((await post('/api/poker/me',{playerId:a.playerId,sessionSecret:b.sessionSecret})).status).toBe(403);
    expect((await me(a)).room).toEqual(state); // reads / refresh do not redeal
    const oldVersion=state.version;await invite(c);state=(await me(a)).room;
    expect(state.players.find((p:any)=>p.id===c.playerId)).toMatchObject({waiting:true,hole:[],stack:500});
    expect((await post('/api/poker/act',{...a,roomId,version:oldVersion,type:'fold'})).status).toBe(409);
    for(let n=0;state.phase!=='showdown'&&n<10;n++){
      const actor=sessions.find(s=>s.playerId===state.actor)!;
      expect((await post('/api/poker/act',{...actor,roomId,version:state.version,type:'allin'})).status).toBe(200);
      state=(await Promise.all(sessions.map(me))).map(s=>s.room).find(Boolean);
    }
    expect(state.phase).toBe('showdown');expect(state.board).toHaveLength(5);expect(state.players.reduce((sum:number,p:any)=>sum+p.stack,0)).toBe(1500);
    expect((await post('/api/poker/leave',a)).status).toBe(200);
    const seated=(await Promise.all(sessions.map(me))).map(s=>s.room).filter(Boolean);
    expect(seated.length).toBeGreaterThan(0);
    const host=seated[0].host;
    expect(seated.every(s=>s.host===host)).toBe(true);
    expect(host).not.toBe(a.playerId);
    const eliminated=(await Promise.all(sessions.map(me))).filter(s=>s.departure);
    expect(eliminated.every(s=>s.room===null&&s.departure.reason==='bankrupt')).toBe(true);
  } finally {for(const s of sessions)await post('/api/poker/leave',s);}
},15000);
