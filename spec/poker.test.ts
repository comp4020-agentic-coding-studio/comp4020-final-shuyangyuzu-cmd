import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { joinBar } from '../src/bar.ts';
import { moveBar } from '../src/bar.ts';
import { createTableRoom } from '../src/tables.ts';
import * as poker from '../src/poker.ts';
import { bestHand,compareRanks,leavePokerHand,newPokerPlayer,newPokerState,pokerAction,rankFive,settlePoker,startPokerHand,type PokerState } from '../src/pokerEngine.ts';
let db:Database.Database;
beforeEach(()=>{db=openDb(':memory:');});afterEach(()=>db.close());
const cards=(s:string)=>s.split(' ');
function table(n=4):PokerState{const s=newPokerState();for(let i=0;i<n;i++)s.players.push(newPokerPlayer(String(i),`P${i}`,i));return s;}
function patron(name:string){return joinBar(db,name,'teal');}
function inviteJoin(a:ReturnType<typeof patron>,b:ReturnType<typeof patron>,roomId:string){
  poker.pokerMe(db,b.playerId,b.sessionSecret);poker.invitePoker(db,a.playerId,a.sessionSecret,roomId,b.playerId);
  const invite=poker.pokerMe(db,b.playerId,b.sessionSecret).invites[0] as {id:string};
  poker.respondPoker(db,b.playerId,b.sessionSecret,invite.id,true);return invite.id;
}

it.each([
 ['As Ks Qs Js Ts',8],['Ah Ad Ac As Kd',7],['Kh Kd Ks 2h 2s',6],['Ah Jh 9h 7h 2h',5],
 ['Ah 2d 3c 4s 5h',4],['Kh Kd Ks Qh Js',3],['Ah Ad Ks Kc 2s',2],['Kh Kd Qs Jh 9h',1],['Ah Kd Qs Jh 9h',0],
])('evaluates %s as category %i',(hand,category)=>expect(rankFive(cards(hand as string))[0]).toBe(category));
it('compares kickers, ace-low straights, suit ties and the best five of seven',()=>{
  expect(compareRanks(bestHand(cards('Ah 2d 3c 4s 5h Kd Qs')),bestHand(cards('2h 3d 4c 5s 6h Kc Qd')))).toBeLessThan(0);
  expect(compareRanks(rankFive(cards('Ah Ad Ks Qc Jh')),rankFive(cards('As Ac Kh Qd Th')))).toBeGreaterThan(0);
  expect(compareRanks(rankFive(cards('Ah Kh Qh Jh Th')),rankFive(cards('As Ks Qs Js Ts')))).toBe(0);
  expect(bestHand(cards('Ah Ad Ac Kh Kd Ks 2c'))).toEqual([6,14,13]);
});
it('settles main/side pots with different all-in sizes and returns uncalled excess',()=>{
  const s=table(3);s.board=cards('2c 3d 7h 8s 9c');
  s.players.forEach((p,i)=>{p.waiting=false;p.stack=0;p.committed=[50,100,150][i];p.hole=cards(['Ah Ad','Kh Kd','Qh Qd'][i]);});
  settlePoker(s);expect(s.players.map(p=>p.stack)).toEqual([150,100,50]);
});
it('splits tied pots and assigns an odd chip clockwise after the dealer',()=>{
  const s=table(3);s.dealer=0;s.board=cards('Ah Kh Qh Jh Th');
  s.players.forEach(p=>{p.waiting=false;p.stack=0;p.committed=1;p.hole=cards('2c 3d');});s.players[2].folded=true;
  settlePoker(s);expect(s.players.map(p=>p.stack)).toEqual([1,2,0]);
});
it('does not reopen raises on a single short all-in',()=>{
  const s=table(3);startPokerHand(s);s.phase='preflop';s.currentBet=10;s.minRaise=10;s.actor='1';s.pending=['1'];
  s.players.forEach(p=>{p.waiting=false;p.bet=10;p.committed=10;p.stack=100;p.actedAt=10;});
  Object.assign(s.players[1],{bet:0,committed:0,stack:15,actedAt:null});
  pokerAction(s,'1','allin');expect(s.actor).toBe('2');expect(s.currentBet).toBe(15);
  expect(()=>pokerAction(s,'2','raise',25)).toThrow('did not reopen');
  pokerAction(s,'2','call');expect(s.actor).toBe('0');
});
it('cumulative short all-ins can reopen a full raise for an earlier actor',()=>{
  const s=table(3);startPokerHand(s);s.phase='preflop';s.currentBet=10;s.minRaise=10;s.actor='1';s.pending=['1','2'];
  s.players.forEach(p=>{p.waiting=false;p.bet=10;p.committed=10;p.stack=100;p.actedAt=10;});
  Object.assign(s.players[1],{bet:0,committed:0,stack:15,actedAt:null});Object.assign(s.players[2],{bet:0,committed:0,stack:20,actedAt:null});
  pokerAction(s,'1','allin');pokerAction(s,'2','allin');expect(s.actor).toBe('0');
  expect(()=>pokerAction(s,'0','raise',30)).not.toThrow();
});
it('heads-up dealer is small blind and acts first preflop, last postflop',()=>{
  const s=table(2);startPokerHand(s,()=>0);
  expect(s.players.find(p=>p.seat===s.dealer)?.bet).toBe(1);expect(s.players.find(p=>p.id===s.actor)?.seat).toBe(s.dealer);
  pokerAction(s,s.actor!,'call');pokerAction(s,s.actor!,'check');
  expect(s.phase).toBe('flop');expect(s.players.find(p=>p.id===s.actor)?.seat).not.toBe(s.dealer);
});
it('rejects out-of-turn, invalid check and undersized raises',()=>{
  const s=table();startPokerHand(s);
  expect(()=>pokerAction(s,s.players.find(p=>p.id!==s.actor)!.id,'fold')).toThrow('not your turn');
  expect(()=>pokerAction(s,s.actor!,'check')).toThrow();expect(()=>pokerAction(s,s.actor!,'raise',3)).toThrow('Minimum');
});
it('preserves chips and uses a unique deck through 160 complete hands',()=>{
  for(let n=2;n<=5;n++)for(let run=0;run<40;run++){
    const s=table(n);startPokerHand(s);
    expect(new Set([...s.deck,...s.players.flatMap(p=>p.hole)]).size).toBe(52);
    let steps=0;
    while(s.actor&&steps++<100){const p=s.players.find(p=>p.id===s.actor)!;pokerAction(s,p.id,steps%11===0?'fold':s.currentBet>p.bet?'call':'check');}
    expect(s.phase).toBe('showdown');expect(s.players.reduce((n,p)=>n+p.stack,0)).toBe(n*500);
  }
});
it('runs out community cards when everyone is all-in and preserves all-in exit eligibility',()=>{
  const s=table(2);startPokerHand(s);pokerAction(s,s.actor!,'allin');
  const p=s.players.find(p=>p.id===s.actor)!;pokerAction(s,p.id,'call');
  expect(s.phase).toBe('showdown');expect(s.board).toHaveLength(5);expect(s.players.reduce((n,p)=>n+p.stack,0)).toBe(1000);
  const q=table(3);startPokerHand(q);pokerAction(q,q.actor!,'allin');const allin=q.players.find(p=>p.stack===0)!;
  leavePokerHand(q,allin.id);expect(allin.folded).toBe(false);
});
it('supports offline NPC tables, private hole cards and authenticated actions',()=>{
  const a=patron('Alice'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'offline');
  const v=poker.pokerView(db,a.playerId,r);expect(v.players).toHaveLength(5);expect(v.players.find(p=>p.id===a.playerId)?.hole).toHaveLength(2);
  expect(v.players.filter(p=>p.npc).every(p=>p.hole.length===0)).toBe(true);expect(v).not.toHaveProperty('deck');
  expect(()=>poker.actPoker(db,a.playerId,'wrong',r,v.version,'fold')).toThrow();
  poker.leavePoker(db,a.playerId,a.sessionSecret);expect(poker.pokerMe(db,a.playerId,a.sessionSecret).room).toBeNull();
});
it('searches online nicknames and delivers recipient-only, expiring invitations',()=>{
  const a=patron('Alice'),b=patron('Bob'),c=patron('Carol');poker.pokerMe(db,b.playerId,b.sessionSecret);
  const r=poker.openPoker(db,a.playerId,a.sessionSecret,'online');
  expect(poker.searchPokerFriends(db,a.playerId,a.sessionSecret,'Bo')).toEqual([{id:b.playerId,nickname:'Bob'}]);
  poker.invitePoker(db,a.playerId,a.sessionSecret,r,b.playerId);
  const invite=poker.pokerMe(db,b.playerId,b.sessionSecret).invites[0] as {id:string};
  expect(poker.pokerMe(db,c.playerId,c.sessionSecret).invites).toEqual([]);
  expect(()=>poker.respondPoker(db,c.playerId,c.sessionSecret,invite.id,true)).toThrow();
  db.prepare('UPDATE poker_invites SET expires=0 WHERE id=?').run(invite.id);
  expect(()=>poker.respondPoker(db,b.playerId,b.sessionSecret,invite.id,true)).toThrow();
});
it('decline does not join and duplicate acceptance cannot create another seat',()=>{
  const a=patron('Alice'),b=patron('Bob'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'online');poker.pokerMe(db,b.playerId,b.sessionSecret);
  poker.invitePoker(db,a.playerId,a.sessionSecret,r,b.playerId);const invite=(poker.pokerMe(db,b.playerId,b.sessionSecret).invites[0] as {id:string}).id;
  poker.respondPoker(db,b.playerId,b.sessionSecret,invite,false);expect(poker.pokerMe(db,b.playerId,b.sessionSecret).room).toBeNull();
  const accepted=inviteJoin(a,b,r);expect(()=>poker.respondPoker(db,b.playerId,b.sessionSecret,accepted,true)).toThrow();
  expect(poker.pokerView(db,a.playerId,r).players).toHaveLength(2);
});
it('joins during a hand without receiving cards until the next deal; stale actions are refused',()=>{
  const a=patron('Alice'),b=patron('Bob'),c=patron('Carol'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'online');inviteJoin(a,b,r);
  let v=poker.pokerView(db,a.playerId,r);poker.actPoker(db,a.playerId,a.sessionSecret,r,v.version,'deal');
  inviteJoin(a,c,r);v=poker.pokerView(db,c.playerId,r);
  expect(v.players.find(p=>p.id===c.playerId)).toMatchObject({stack:500,waiting:true,hole:[]});
  expect(()=>poker.actPoker(db,a.playerId,a.sessionSecret,r,0,'fold')).toThrow('changed');
  expect(()=>poker.pokerView(db,patron('Unseated').playerId,r)).toThrow();
});
it('preserves the bankroll on leave/rejoin and transfers host without resetting the hand',()=>{
  const a=patron('Alice'),b=patron('Bob'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'online');inviteJoin(a,b,r);
  let v=poker.pokerView(db,a.playerId,r);poker.actPoker(db,a.playerId,a.sessionSecret,r,v.version,'deal');
  v=poker.pokerView(db,a.playerId,r);const stack=v.players.find(p=>p.id===a.playerId)!.stack;
  poker.leavePoker(db,a.playerId,a.sessionSecret);expect(poker.pokerView(db,b.playerId,r).host).toBe(b.playerId);
  inviteJoin(b,a,r);expect(poker.pokerView(db,a.playerId,r).players.find(p=>p.id===a.playerId)!.stack).toBe(stack);
});

it('limits the table to five seats and keeps a chosen chair when starting Offline',()=>{
  const solo=patron('Solo');const off=poker.openPoker(db,solo.playerId,solo.sessionSecret,'offline',4);
  expect(poker.pokerView(db,solo.playerId,off).players.find(p=>p.id===solo.playerId)?.seat).toBe(4);
  const a=patron('Host'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'online');
  for(let i=0;i<4;i++)inviteJoin(a,patron(`Guest ${i}`),r);
  const extra=patron('Too many');poker.pokerMe(db,extra.playerId,extra.sessionSecret);
  poker.invitePoker(db,a.playerId,a.sessionSecret,r,extra.playerId);
  const invitation=(poker.pokerMe(db,extra.playerId,extra.sessionSecret).invites[0] as {id:string}).id;
  expect(()=>poker.respondPoker(db,extra.playerId,extra.sessionSecret,invitation,true)).toThrow('occupied');
  expect(poker.pokerView(db,a.playerId,r).players).toHaveLength(5);
});

it('stores poker actions alongside room state and discards both on outer rollback',()=>{
  const a=patron('Host');
  expect(()=>db.transaction(()=>{poker.openPoker(db,a.playerId,a.sessionSecret,'offline');throw Error('abort');})()).toThrow('abort');
  expect((db.prepare('SELECT count(*) AS n FROM poker_rooms').get() as {n:number}).n).toBe(0);
  expect((db.prepare('SELECT count(*) AS n FROM poker_events').get() as {n:number}).n).toBe(0);
});

it('prevents simultaneous Vegas/poker/floor occupancy and rejects legacy Vegas endpoints on Texas tables',()=>{
  const a=patron('Poker');poker.openPoker(db,a.playerId,a.sessionSecret,'offline');
  expect(()=>createTableRoom(db,'vegas-1',a.playerId,a.sessionSecret,'red')).toThrow('Leave your poker');
  expect(()=>moveBar(db,a.playerId,a.sessionSecret,1,1)).toThrow('Leave your poker');
  const b=patron('Vegas');createTableRoom(db,'vegas-2',b.playerId,b.sessionSecret,'red');
  expect(()=>poker.openPoker(db,b.playerId,b.sessionSecret,'offline')).toThrow('Exit your current Vegas');
  const c=patron('Wrong endpoint');expect(()=>createTableRoom(db,'texas-1',c.playerId,c.sessionSecret,'red')).toThrow('not a playable table');
});

it('drives all Offline NPC turns legally, conserves chips and releases a disconnected human',()=>{
  const a=patron('Human'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'offline');
  let steps=0;
  while(steps++<150){
    const v=poker.pokerView(db,a.playerId,r);if(v.phase==='showdown')break;
    if(v.actor===a.playerId){const me=v.players.find(p=>p.id===a.playerId)!;poker.actPoker(db,a.playerId,a.sessionSecret,r,v.version,v.currentBet>me.bet?'call':'check');}
    else {
      const raw=JSON.parse((db.prepare('SELECT state_json FROM poker_rooms WHERE id=?').get(r) as {state_json:string}).state_json);raw.actedAt=0;
      db.prepare('UPDATE poker_rooms SET state_json=? WHERE id=?').run(JSON.stringify(raw),r);poker.tickPoker(db);
    }
  }
  const settled=poker.pokerView(db,a.playerId,r);expect(settled.phase).toBe('showdown');expect(settled.players.reduce((sum,p)=>sum+p.stack,0)).toBe(2500);
  db.prepare('UPDATE poker_presence SET seen=0 WHERE bar_id=?').run(a.playerId);poker.tickPoker(db);
  expect(poker.pokerMe(db,a.playerId,a.sessionSecret).room).toBeNull();
});

it('reopens a database without redealing or exposing future cards',async()=>{
  const a=patron('Host'),r=poker.openPoker(db,a.playerId,a.sessionSecret,'offline');
  const before=poker.pokerView(db,a.playerId,r),raw=(db.prepare('SELECT state_json FROM poker_rooms WHERE id=?').get(r) as {state_json:string}).state_json;
  const path=join(tmpdir(),`poker-reopen-${randomUUID()}.db`);
  await db.backup(path);const restored=openDb(path);
  try {
    expect(poker.pokerView(restored,a.playerId,r)).toEqual(before);
    expect((restored.prepare('SELECT state_json FROM poker_rooms WHERE id=?').get(r) as {state_json:string}).state_json).toBe(raw);
  }finally{restored.close();for(const file of [path,path+'-wal',path+'-shm'])rmSync(file,{force:true});}
});
