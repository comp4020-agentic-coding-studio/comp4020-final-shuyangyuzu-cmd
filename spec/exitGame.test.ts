import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { joinBar } from '../src/bar.ts';
import * as rooms from '../src/rooms.ts';
import * as tables from '../src/tables.ts';

let dir:string, db:Database.Database;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'vegas-exit-'));db=openDb(join(dir,'app.db'));});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
function solo(name='Solo'){
  const bar=joinBar(db,name,'green','warm');
  return {bar,game:tables.startNpcGame(db,'vegas-npc-1',bar.playerId,bar.sessionSecret,'green',3)};
}
function backdate(id:string,ms:number){db.prepare('UPDATE table_departures SET left_at = ? WHERE bar_player_id = ?').run(new Date(Date.now()-ms).toISOString(),id);}

it('offline exit authenticates, closes the game, clears its binding, and permits a fresh game',()=>{
  const {bar,game}=solo();
  expect(()=>rooms.exitGame(db,game.code,game.playerId,'wrong')).toThrow();
  expect(rooms.getPublicState(db,game.code).closed).toBe(false);
  rooms.exitGame(db,game.code,game.playerId,game.sessionSecret);
  expect(rooms.getPublicState(db,game.code).closed).toBe(true);
  expect(tables.getActiveSeat(db,bar.playerId)).toBeNull();
  expect(()=>rooms.exitGame(db,game.code,game.playerId,game.sessionSecret)).not.toThrow();
  expect(tables.startNpcGame(db,'vegas-npc-1',bar.playerId,bar.sessionSecret,'green',3).code).not.toBe(game.code);
});

it('online exit preserves other humans and turn data, transfers host, then closes after the last human exits',()=>{
  const a=joinBar(db,'Host','red','warm'), b=joinBar(db,'Guest','blue','warm');
  const host=tables.createTableRoom(db,'vegas-1',a.playerId,a.sessionSecret,'red');
  const guest=tables.joinTableRoom(db,'vegas-1',b.playerId,b.sessionSecret,'blue');
  rooms.approveJoin(db,host.code,host.playerId,host.sessionSecret,guest.playerId);
  rooms.setReady(db,host.code,host.playerId,host.sessionSecret,true);
  rooms.setReady(db,host.code,guest.playerId,guest.sessionSecret,true);
  rooms.startGame(db,host.code,host.playerId,host.sessionSecret);
  const before=rooms.getPublicState(db,host.code);
  rooms.exitGame(db,host.code,host.playerId,host.sessionSecret);
  const after=rooms.getPublicState(db,host.code);
  expect(after.closed).toBe(false);expect(after.hostPlayerId).toBe(guest.playerId);
  expect(after.turnOrder).toEqual(before.turnOrder);
  expect(after.players.find(p=>p.id===host.playerId)).toMatchObject({controller:'npc',diceInHand:8});
  expect(tables.getActiveSeat(db,a.playerId)).toBeNull();
  expect(()=>rooms.roll(db,host.code,host.playerId,host.sessionSecret)).toThrow();
  rooms.exitGame(db,host.code,guest.playerId,guest.sessionSecret);
  expect(rooms.getPublicState(db,host.code).closed).toBe(true);
});

it('offline departures resolve the personal room, expire after three minutes, and leave other kiosk games alone',()=>{
  const a=solo('A'), b=solo('B');
  tables.departActiveTable(db,a.bar.playerId,a.bar.sessionSecret);
  backdate(a.bar.playerId,179000);
  expect(tables.enforceExpiredDepartures(db,tables.DEFAULT_AWAY_FROM_TABLE_MS)).toEqual([]);
  backdate(a.bar.playerId,181000);
  expect(tables.enforceExpiredDepartures(db,tables.DEFAULT_AWAY_FROM_TABLE_MS)).toEqual([a.game.code]);
  expect(rooms.getPublicState(db,a.game.code).closed).toBe(true);
  expect(rooms.getPublicState(db,b.game.code).closed).toBe(false);
  expect(tables.getActiveSeat(db,a.bar.playerId)).toBeNull();
});

it('repeat departures never extend the deadline; deliberate return within grace cancels it',()=>{
  const {bar,game}=solo();
  tables.departActiveTable(db,bar.playerId,bar.sessionSecret);backdate(bar.playerId,100000);
  const first=db.prepare('SELECT left_at FROM table_departures WHERE bar_player_id = ?').get(bar.playerId);
  tables.departActiveTable(db,bar.playerId,bar.sessionSecret);
  expect(db.prepare('SELECT left_at FROM table_departures WHERE bar_player_id = ?').get(bar.playerId)).toEqual(first);
  tables.resumeActiveTable(db,bar.playerId,bar.sessionSecret);
  expect(tables.enforceExpiredDepartures(db,0)).toEqual([]);
  expect(rooms.getPublicState(db,game.code).closed).toBe(false);
});

it('invited players without a bar binding have the same departure clock and lobby grace',()=>{
  const game=rooms.createRoom(db,'Direct room','red');
  rooms.departGame(db,game.code,game.playerId,game.sessionSecret);
  rooms.heartbeat(db,game.code,game.playerId,game.sessionSecret);
  db.prepare('UPDATE presence SET last_seen_at = ? WHERE player_id = ?').run(new Date(Date.now()-90000).toISOString(),game.playerId);
  db.prepare('UPDATE room_departures SET left_at = ? WHERE player_id = ?').run(new Date(Date.now()-179000).toISOString(),game.playerId);
  expect(rooms.getPublicState(db,game.code).closed).toBe(false);
  expect(rooms.expireGameDepartures(db,tables.DEFAULT_AWAY_FROM_TABLE_MS)).toEqual([]);
  rooms.resumeGame(db,game.code,game.playerId,game.sessionSecret);
  expect(rooms.getPublicState(db,game.code).players.some(p=>p.id===game.playerId)).toBe(true);
  rooms.departGame(db,game.code,game.playerId,game.sessionSecret);
  db.prepare('UPDATE room_departures SET left_at = ? WHERE player_id = ?').run(new Date(Date.now()-181000).toISOString(),game.playerId);
  expect(rooms.expireGameDepartures(db,tables.DEFAULT_AWAY_FROM_TABLE_MS)).toEqual([game.code]);
  expect(rooms.getPublicState(db,game.code).closed).toBe(true);
});

it('the public exit endpoint rejects forged sessions and accepts a lobby exit',async()=>{
  const base=process.env.APP_URL??'http://localhost:8080';
  const post=async(path:string,body:unknown)=>{const res=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
  const created=await post('/api/rooms',{nickname:'Exit API',color:'red'});
  const session={playerId:created.body.playerId,sessionSecret:created.body.sessionSecret};
  expect((await post(`/api/rooms/${created.body.code}/exit`,{...session,sessionSecret:'wrong'})).status).toBe(403);
  expect((await post(`/api/rooms/${created.body.code}/exit`,session)).status).toBe(200);
  const state=await fetch(`${base}/api/rooms/${created.body.code}/state`).then(r=>r.json());expect(state.closed).toBe(true);
});
