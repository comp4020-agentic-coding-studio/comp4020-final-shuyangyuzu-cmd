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

// Phase 7: away is a pure display flag (CLAUDE.md) — never a real
// standby concept, unlike Vegas's awayMode. Checked here at the HTTP
// level since pokerView's own away lookup only runs inside a real room.
it('poker away is a display-only badge, visible to every seated player, with no effect on turn-taking',async()=>{
  const a=(await post('/api/bar/join',{nickname:'Poker Away Alice',color:'teal'})).body;
  const b=(await post('/api/bar/join',{nickname:'Poker Away Bob',color:'orange'})).body;
  const opened=await post('/api/poker/open',{...a,mode:'online'});expect(opened.status).toBe(200);const roomId=opened.body.roomId;
  const me=async(s:typeof a)=>(await post('/api/poker/me',s)).body;
  try{
    await me(b);
    expect((await post('/api/poker/invite',{...a,roomId,target:b.playerId})).status).toBe(200);
    const invitation=(await me(b)).invites[0];
    expect((await post('/api/poker/respond',{...b,inviteId:invitation.id,join:true})).status).toBe(200);

    let state=(await me(a)).room;
    expect(state.players.find((p:any)=>p.id===a.playerId).away).toBe(false);

    expect((await post('/api/poker/away',{...a,away:true})).status).toBe(200);
    state=(await me(a)).room;
    expect(state.players.find((p:any)=>p.id===a.playerId).away).toBe(true);
    // Visible to every seated player, not just the one who set it.
    const bView=(await me(b)).room;
    expect(bView.players.find((p:any)=>p.id===a.playerId).away).toBe(true);
    // Never affects who may actually act — the marked-away player still
    // deals/acts normally through the ordinary endpoints.
    expect((await post('/api/poker/act',{...a,roomId,version:state.version,type:'deal'})).status).toBe(200);

    expect((await post('/api/poker/away',{...a,away:false})).status).toBe(200);
    state=(await me(a)).room;
    expect(state.players.find((p:any)=>p.id===a.playerId).away).toBe(false);
  } finally {await post('/api/poker/leave',a);await post('/api/poker/leave',b);}
});

// A display-only change must never race a real in-flight action over
// the same optimistic-concurrency counter (CLAUDE.md's existing rule
// for Vegas's own rev/version split, applied identically here). Uses an
// online, two-player room specifically because it stays in 'waiting'
// until the host deals — unlike offline mode, nothing else is ticking
// in the background to independently advance version, so this isolates
// the one thing under test: does the toggle itself bump it.
it("toggling the away flag never bumps poker_rooms.version, so it can't race a concurrent real action",async()=>{
  const a=(await post('/api/bar/join',{nickname:'Poker Away Version A',color:'teal'})).body;
  const b=(await post('/api/bar/join',{nickname:'Poker Away Version B',color:'orange'})).body;
  const opened=await post('/api/poker/open',{...a,mode:'online'});expect(opened.status).toBe(200);const roomId=opened.body.roomId;
  const me=async(s:typeof a)=>(await post('/api/poker/me',s)).body;
  try{
    await me(b);
    expect((await post('/api/poker/invite',{...a,roomId,target:b.playerId})).status).toBe(200);
    const invitation=(await me(b)).invites[0];
    expect((await post('/api/poker/respond',{...b,inviteId:invitation.id,join:true})).status).toBe(200);

    const before=(await me(a)).room;
    expect(before.phase).toBe('waiting'); // nothing else advances version while waiting
    expect((await post('/api/poker/away',{...a,away:true})).status).toBe(200);
    const after=(await me(a)).room;
    expect(after.version).toBe(before.version);
    expect(after.players.find((p:any)=>p.id===a.playerId).away).toBe(true);
    // The version an in-flight action already captured is still valid —
    // a real action against the pre-toggle version must still succeed,
    // not be rejected as stale by the toggle that happened in between.
    expect((await post('/api/poker/act',{...a,roomId,version:before.version,type:'deal'})).status).toBe(200);
  } finally {await post('/api/poker/leave',a);await post('/api/poker/leave',b);}
});

it('refuses setting the away flag for an identity not seated at any poker table',async()=>{
  const nobody=(await post('/api/bar/join',{nickname:'Poker Away Nobody',color:'pink'})).body;
  const res=await post('/api/poker/away',{...nobody,away:true});
  expect(res.status).toBe(403);
});
