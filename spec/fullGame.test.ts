import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,expect,it,inject} from 'vitest';
import {openDb} from '../src/db.ts';
import * as rooms from '../src/rooms.ts';
import {finalStandings,startGame as startLogic} from '../src/game.ts';
import {freshDeck} from '../src/deck.ts';
import type {RoomState} from '../src/types.ts';
import {createRoom,joinRoom,readyUpAndStart,playFullRound} from './helpers.ts';

let dir:string,db:Database.Database,path:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'vegas-full-'));path=join(dir,'app.db');db=openDb(path);});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
const raw=(code:string):RoomState=>JSON.parse((db.prepare('SELECT state_json FROM rooms WHERE code = ?').get(code) as {state_json:string}).state_json);
function online(count=3){
  const host=rooms.createRoom(db,'Host','red');
  const sessions=[host,...(['blue','green','yellow','purple'] as const).slice(0,count-1).map((color,i)=>rooms.joinRoom(db,host.code,`Guest ${i}`,color))];
  for(const s of sessions)rooms.setReady(db,host.code,s.playerId,s.sessionSecret,true);
  return {host,sessions};
}
function finishRound(code:string,sessions:Array<{playerId:string;sessionSecret:string}>){
  for(let guard=0;guard<200;guard++){
    const state=rooms.getPublicState(db,code);
    if(state.phase==='round_end'||state.phase==='game_end')return state;
    const current=state.players.find(p=>p.id===state.currentPlayerId)!;
    if(current.controller==='npc'){
      if(state.phase==='awaiting_roll')rooms.npcRoll(db,code);else rooms.npcPlace(db,code);
    }else{
      const actor=sessions.find(p=>p.playerId===current.id)!;
      if(state.phase==='awaiting_roll')rooms.roll(db,code,actor.playerId,actor.sessionSecret);
      else rooms.place(db,code,actor.playerId,actor.sessionSecret,state.lastRoll!.values[0]);
    }
  }
  throw Error('round did not finish');
}

it('uses the server RNG to select the first starter, preserving seat order',()=>{
  const {host,sessions}=online();const state=raw(host.code),ids=sessions.map(p=>p.playerId);
  for(const selected of [0,1,2]){
    let calls=0;
    const started=startLogic(state,{randomInt(max){return calls++===0?selected:max-1;}},new Set(ids));
    expect(started.currentPlayerId).toBe(ids[selected]);expect(started.turnOrder).toEqual(ids);
  }
  expect(state.phase).toBe('lobby');
});

for(const count of [2,3,4,5])it(`completes four rounds for ${count} players without losing dice, banknotes or winnings`,()=>{
  const {host,sessions}=online(count);rooms.startGame(db,host.code,host.playerId,host.sessionSecret);
  const first=rooms.getPublicState(db,host.code),order=first.turnOrder,start=order.indexOf(first.startingPlayerId!);
  for(let round=1;round<=4;round++){
    const active=rooms.getPublicState(db,host.code);
    expect(active.round).toBe(round);expect(active.startingPlayerId).toBe(order[(start+round-1)%count]);
    expect(active.currentPlayerId).toBe(active.startingPlayerId);
    expect(active.players.every(p=>p.diceInHand===8)).toBe(true);
    expect(active.casinos.every(c=>c.bills.reduce((a,b)=>a+b,0)>=50000)).toBe(true);
    const result=finishRound(host.code,sessions),saved=raw(host.code);
    const notes=[...saved.deck,...saved.casinos.flatMap(c=>c.bills),...Object.values(saved.players).flatMap(p=>p.wonBills)];
    expect(notes.sort((a,b)=>a-b)).toEqual(freshDeck().sort((a,b)=>a-b));
    expect(result.phase).toBe(round===4?'game_end':'round_end');
    if(round<4){
      expect(result.players.every(p=>p.moneyTotal===null&&p.wonBills===null)).toBe(true);
      const prior=Object.fromEntries(Object.values(saved.players).map(p=>[p.id,[...p.wonBills]]));
      rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,round);
      for(const p of Object.values(raw(host.code).players))expect(p.wonBills).toEqual(prior[p.id]);
    }else{
      expect(result.standings).toHaveLength(count);expect(result.winnerIds.length).toBeGreaterThan(0);
      expect(result.winnerIds).toEqual(result.standings.filter(p=>p.rank===1).map(p=>p.playerId));
      expect(result.players.every(p=>typeof p.moneyTotal==='number')).toBe(true);
      expect(()=>rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,4)).toThrow();
    }
  }
});

it('compares final money first, banknote count second, and permits joint winners',()=>{
  const {host,sessions}=online();const state=raw(host.code),[a,b,c]=sessions.map(s=>s.playerId);
  state.players[a].wonBills=[90000];state.players[b].wonBills=[50000,40000];state.players[c].wonBills=[80000];
  expect(finalStandings(state).map(p=>[p.playerId,p.rank])).toEqual([[b,1],[a,2],[c,3]]);
  state.players[c].wonBills=[60000,30000];
  expect(finalStandings(state).filter(p=>p.rank===1).map(p=>p.playerId)).toEqual([b,c]);
});

it('guards next-round authority and rejects old retries even after another settlement',()=>{
  const {host,sessions}=online();rooms.startGame(db,host.code,host.playerId,host.sessionSecret);finishRound(host.code,sessions);
  expect(()=>rooms.nextRound(db,host.code,host.playerId,'wrong',1)).toThrow();
  expect(()=>rooms.nextRound(db,host.code,sessions[1].playerId,sessions[1].sessionSecret,1)).toThrow();
  rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,1);
  expect(()=>rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,1)).toThrow();
  finishRound(host.code,sessions);
  expect(()=>rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,1)).toThrow();
  expect(rooms.getPublicState(db,host.code).round).toBe(2);
});

it('allows only the matching player session to read their private bank',()=>{
  const {host,sessions}=online();rooms.startGame(db,host.code,host.playerId,host.sessionSecret);finishRound(host.code,sessions);
  const owner=rooms.ownWinnings(db,host.code,host.playerId,host.sessionSecret);
  expect(owner.wonBills).toEqual(raw(host.code).players[host.playerId].wonBills);
  expect(()=>rooms.ownWinnings(db,host.code,host.playerId,sessions[1].sessionSecret)).toThrow();
  const publicState=rooms.getPublicState(db,host.code);expect(publicState.standings).toEqual([]);
  expect(publicState.players.every(p=>p.moneyTotal===null&&p.wonBills===null)).toBe(true);
});

it('migrates a real legacy single-round settlement without discarding money or deck order',()=>{
  const {host,sessions}=online();rooms.startGame(db,host.code,host.playerId,host.sessionSecret);finishRound(host.code,sessions);
  const legacy=raw(host.code);delete (legacy as Partial<RoomState>).round;delete (legacy as Partial<RoomState>).startingPlayerId;delete (legacy as Partial<RoomState>).winnerIds;
  db.prepare('UPDATE rooms SET state_json = ? WHERE code = ?').run(JSON.stringify(legacy),host.code);
  db.close();db=openDb(path);
  const migrated=raw(host.code);expect(migrated.round).toBe(1);expect(migrated.deck).toEqual(legacy.deck);
  expect(migrated.players).toEqual(legacy.players);
  rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,1);expect(raw(host.code).round).toBe(2);
});

it('runs Offline NPC opponents through all four rounds including after a database reopen',()=>{
  const host=rooms.createSoloNpcGame(db,'Solo','green',4);
  for(let round=1;round<=4;round++){
    const state=finishRound(host.code,[host]);expect(state.round).toBe(round);
    if(round<4){db.close();db=openDb(path);rooms.nextRound(db,host.code,host.playerId,host.sessionSecret,round);}
    else expect(state.phase).toBe('game_end');
  }
});

it('HTTP and SSE hide banks until the fourth round and concurrent next-round clicks advance only once',async()=>{
  const base=inject('baseUrl'),host=await createRoom(base,'HTTP Host','red');
  const guest=(await joinRoom(base,host.code,'HTTP Guest','blue')).body;
  const sessions={[host.playerId]:host,[guest.playerId]:guest};
  const post=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  await readyUpAndStart(base,host.code,host,[host,guest]);
  for(let round=1;round<=4;round++){
    const state=await playFullRound(base,host.code,sessions);
    expect(state.round).toBe(round);
    if(round===4){expect(state.phase).toBe('game_end');expect(state.standings).toHaveLength(2);break;}
    expect(state.players.every(p=>p.wonBills===null&&p.moneyTotal===null)).toBe(true);
    const own=await post(`/api/rooms/${host.code}/winnings`,host);
    expect(own.status).toBe(200);expect(own.body.moneyTotal).toBe(own.body.wonBills.reduce((a:number,b:number)=>a+b,0));
    expect((await post(`/api/rooms/${host.code}/winnings`,{playerId:host.playerId,sessionSecret:guest.sessionSecret})).status).toBe(403);
    if(round===1){
      const controller=new AbortController();
      const stream=await fetch(`${base}/api/rooms/${host.code}/events`,{signal:controller.signal});
      const reader=stream.body!.getReader();let text='';
      try{while(!text.includes('\n\n')){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}}finally{controller.abort();}
      const publicSnapshot=JSON.parse(text.split('\n').find(line=>line.startsWith('data:'))!.slice(5));
      expect(publicSnapshot.players.every((p:{wonBills:unknown;moneyTotal:unknown})=>p.wonBills===null&&p.moneyTotal===null)).toBe(true);
      const attempts=await Promise.all([1,2].map(()=>post(`/api/rooms/${host.code}/next-round`,{...host,expectedRound:round})));
      expect(attempts.map(r=>r.status).sort()).toEqual([200,409]);
    }else expect((await post(`/api/rooms/${host.code}/next-round`,{...host,expectedRound:round})).status).toBe(200);
  }
},15000);
