import {it,expect,inject} from 'vitest';
const base=inject('baseUrl');
const post=(action:string,body:unknown)=>fetch(base+'/api/blackjack/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
it('requires credentials, bounds input, and keeps authenticated snapshots out of caches',async()=>{
  const unauth=await post('me',{});expect(unauth.status).toBe(403);
  expect((await post('open',{padding:'x'.repeat(9000)})).status).toBe(413);
  expect((await post('open',null)).status).toBe(400);
  const joined=await fetch(base+'/api/bar/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nickname:'BJ HTTP',color:'blue',skin:'warm'})});
  const identity=await joined.json();
  try{
    const opened=await post('open',{...identity,seat:'red'});expect(opened.status).toBe(200);
    const snapshot=await post('me',{...identity,active:true});expect(snapshot.headers.get('cache-control')).toBe('private, no-store');
    const {room}=await snapshot.json();expect(room.players[0].stack).toBe(500);expect(room).not.toHaveProperty('deck');
    expect((await post('act',{...identity,sessionSecret:'wrong',roomId:room.id,version:room.version,action:'Ready',bet:10})).status).toBe(403);
  }finally{await post('leave',identity);}
});
