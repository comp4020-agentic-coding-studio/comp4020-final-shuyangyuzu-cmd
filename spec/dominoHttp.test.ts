import {it,expect,inject} from 'vitest';
const base=inject('baseUrl');
async function post(path:string,body:unknown){const r=await fetch(new URL(path,base),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
it('four HTTP clients occupy two pairs, cannot cross-act or read others hands, and leave independently',async()=>{
  const ids=[];for(let i=0;i<4;i++){const p=await post('/api/bar/join',{nickname:`Domino HTTP ${i}`,color:'red',skin:'warm'});expect(p.status).toBe(201);ids.push({playerId:p.body.playerId,sessionSecret:p.body.sessionSecret});}
  try {
    const r1=await post('/api/domino/open',{...ids[0],mode:'online',chair:0});const r2=await post('/api/domino/open',{...ids[2],mode:'online',chair:2});expect(r1.status).toBe(200);expect(r2.status).toBe(200);
    for(const i of [1,3]){const r=await post('/api/domino/open',{...ids[i],mode:'online',chair:i});expect(r.body.pending).toBe(true);}
    const forbidden=await post('/api/domino/respond',{...ids[1],roomId:r1.body.roomId,target:ids[1].playerId,accept:true});expect(forbidden.status).toBe(403);
    for(const i of [0,2]){const r=await post('/api/domino/respond',{...ids[i],roomId:i?r2.body.roomId:r1.body.roomId,target:ids[i+1].playerId,accept:true});expect(r.status).toBe(200);}
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
    await post('/api/domino/leave',ids[0]);expect((await post('/api/domino/me',ids[1])).body.room).toBeNull();expect((await post('/api/domino/me',ids[2])).body.room).not.toBeNull();
  }finally{for(const id of ids)await post('/api/domino/leave',id);}
},15000);
