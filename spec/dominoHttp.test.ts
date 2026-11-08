import {it,expect,inject} from 'vitest';
const base=inject('baseUrl');
async function post(path:string,body:unknown){const r=await fetch(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
it('four HTTP clients occupy two pairs, cannot cross-act or read others hands, and leave independently',async()=>{
  const ids=[];for(let i=0;i<4;i++){const p=await post('/api/bar/join',{nickname:`Domino HTTP ${i}`,color:'red',skin:'warm'});expect(p.status).toBe(201);ids.push({playerId:p.body.playerId,sessionSecret:p.body.sessionSecret});}
  try {
    const r1=await post('/api/domino/open',{...ids[0],mode:'online',chair:0});const r2=await post('/api/domino/open',{...ids[2],mode:'online',chair:2});expect(r1.status).toBe(200);expect(r2.status).toBe(200);
    // 2026-11-07 correction: sitting at the empty facing seat joins
    // immediately, no approval step — confirmed by each of these landing
    // in the SAME room their opposite already opened, not a pending state.
    for(const i of [1,3]){const r=await post('/api/domino/open',{...ids[i],mode:'online',chair:i});expect(r.status).toBe(200);expect(r.body.roomId).toBe(i===1?r1.body.roomId:r2.body.roomId);}
    let a=(await post('/api/domino/me',{...ids[0],active:true})).body.room;
    expect((await post('/api/domino/act',{...ids[0],roomId:a.id,version:a.version,type:'start'})).status).toBe(200);
    a=(await post('/api/domino/me',{...ids[0],active:true})).body.room;expect(a.hand).toHaveLength(7);expect(a.stockCount).toBe(14);expect(a).not.toHaveProperty('stock');expect(a.players[1]).not.toHaveProperty('hand');
    const b=(await post('/api/domino/me',{...ids[1],active:true})).body.room;expect(b.id).toBe(a.id);expect(b.version).toBe(a.version);
    expect((await post('/api/domino/me',{...ids[2],active:true})).body.room.phase).toBe('waiting');
    expect((await post('/api/domino/act',{...ids[2],roomId:a.id,version:a.version,type:'draw'})).status).toBe(403);
    expect((await post('/api/domino/me',{...ids[0],sessionSecret:'wrong'})).status).toBe(403);
    const current=a.turn===a.seat?a:b,identity=a.turn===a.seat?ids[0]:ids[1];
    const m=current.legal[0];expect((await post('/api/domino/act',{...identity,roomId:current.id,version:current.version,type:'play',tile:m.tile,end:m.end})).status).toBe(200);
    expect((await post('/api/domino/act',{...identity,roomId:current.id,version:current.version,type:'play',tile:m.tile,end:m.end})).status).toBe(409);
    // 2026-11-08 correction: ids[0] leaving now only releases its own
    // seat — ids[1] stays seated at the SAME room, waiting for a
    // substitute — rather than the whole match closing (the previous
    // behavior this test used to pin down).
    await post('/api/domino/leave',ids[0]);
    const remaining=(await post('/api/domino/me',ids[1])).body.room;
    expect(remaining).not.toBeNull();
    expect(remaining.id).toBe(a.id);
    expect((await post('/api/domino/me',ids[2])).body.room).not.toBeNull();
  }finally{for(const id of ids)await post('/api/domino/leave',id);}
},15000);

it('a patron refused a full lane joins a waitlist and is notified over HTTP once that lane frees up',async()=>{
  const ids=[];for(let i=0;i<3;i++){const p=await post('/api/bar/join',{nickname:`Domino Waitlist ${i}`,color:'blue',skin:'warm'});ids.push({playerId:p.body.playerId,sessionSecret:p.body.sessionSecret});}
  try {
    const opened=await post('/api/domino/open',{...ids[0],mode:'online',chair:0});
    await post('/api/domino/open',{...ids[1],mode:'online',chair:1});
    const refused=await post('/api/domino/open',{...ids[2],mode:'online',chair:0});
    expect(refused.status).toBe(409);
    let me=(await post('/api/domino/me',ids[2])).body;
    expect(me.room).toBeNull();
    expect(me.waitlist).toEqual([{lane:0,notified:false}]);
    // ids[0] leaving releases only its own seat — ids[1] stays seated,
    // but the lane now has one genuinely open chair, so the waitlisted
    // patron IS notified even though the room itself never closed.
    await post('/api/domino/leave',ids[0]);
    me=(await post('/api/domino/me',ids[2])).body;
    expect(me.waitlist).toEqual([{lane:0,notified:true}]);
    const joined=await post('/api/domino/open',{...ids[2],mode:'online',chair:0});
    expect(joined.status).toBe(200);
    expect(joined.body.roomId).toBe(opened.body.roomId); // same room — ids[1] is still there, waiting
    expect((await post('/api/domino/me',ids[2])).body.waitlist).toEqual([]);
  }finally{for(const id of ids)await post('/api/domino/leave',id);}
},15000);
