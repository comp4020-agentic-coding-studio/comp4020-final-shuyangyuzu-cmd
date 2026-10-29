import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach,afterEach,it,expect} from 'vitest';
import {openDb} from '../src/db.ts';
import {joinBar} from '../src/bar.ts';
import * as rooms from '../src/rooms.ts';
import * as tables from '../src/tables.ts';
let db:Database.Database,dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'disconnected-seats-'));db=openDb(join(dir,'app.db'));});
afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
function online(){
 const a=joinBar(db,'Host','red','warm'),b=joinBar(db,'Guest','blue','warm');
 const host=tables.createTableRoom(db,'vegas-1',a.playerId,a.sessionSecret,'red');
 const guest=tables.joinTableRoom(db,'vegas-1',b.playerId,b.sessionSecret,'blue');
 rooms.approveJoin(db,host.code,host.playerId,host.sessionSecret,guest.playerId);
 for(const p of [host,guest])rooms.setReady(db,host.code,p.playerId,p.sessionSecret,true);
 rooms.startGame(db,host.code,host.playerId,host.sessionSecret);
 return {a,b,host,guest};
}
function stale(id:string,ms=181000){db.prepare('UPDATE presence SET last_seen_at = ? WHERE player_id = ?').run(new Date(Date.now()-ms).toISOString(),id);}
it('releases a started online table after all humans disconnect without sending depart',()=>{
 const {a,b,host,guest}=online();stale(host.playerId);stale(guest.playerId);
 expect(db.prepare('SELECT count(*) AS n FROM room_departures').get()).toEqual({n:0});
 expect(rooms.expireGameDepartures(db,180000)).toEqual([host.code]);
 expect(rooms.getPublicState(db,host.code).closed).toBe(true);
 expect(tables.getTablesStatus(db).find(t=>t.id==='vegas-1')).toMatchObject({status:'empty',playerCount:0,roomCode:null});
 expect(tables.getActiveSeat(db,a.playerId)).toBeNull();expect(tables.getActiveSeat(db,b.playerId)).toBeNull();
 expect(rooms.expireGameDepartures(db,180000)).toEqual([]);
});
it('keeps a live opponent and hands only the expired seat to an NPC without changing turn data',()=>{
 const {a,host,guest}=online();const before=rooms.getPublicState(db,host.code);stale(host.playerId);
 rooms.expireGameDepartures(db,180000);const after=rooms.getPublicState(db,host.code);
 expect(after.closed).toBe(false);expect(after.hostPlayerId).toBe(guest.playerId);expect(after.turnOrder).toEqual(before.turnOrder);
 expect(after.players.find(p=>p.id===host.playerId)).toMatchObject({controller:'npc',diceInHand:8});
 expect(after.players.find(p=>p.id===guest.playerId)?.controller).toBe('human');expect(tables.getActiveSeat(db,a.playerId)).toBeNull();
});
it('preserves a short disconnect and a real resumed heartbeat; does not renew an explicit departure',()=>{
 const {host,guest}=online();stale(host.playerId,179000);expect(rooms.expireGameDepartures(db,180000)).toEqual([]);
 rooms.heartbeat(db,host.code,host.playerId,host.sessionSecret);expect(rooms.expireGameDepartures(db,180000)).toEqual([]);
 rooms.departGame(db,host.code,guest.playerId,guest.sessionSecret);
 db.prepare('UPDATE room_departures SET left_at = ?').run(new Date(Date.now()-181000).toISOString());
 rooms.heartbeat(db,host.code,guest.playerId,guest.sessionSecret);
 expect(rooms.expireGameDepartures(db,180000)).toEqual([host.code]);
 expect(rooms.getPublicState(db,host.code).players.find(p=>p.id===host.playerId)?.controller).toBe('human');
});
it('closes an abandoned offline room while leaving another active offline room alone',()=>{
 const a=joinBar(db,'Solo A','red','warm'),b=joinBar(db,'Solo B','blue','warm');
 const ga=tables.startNpcGame(db,'vegas-npc-1',a.playerId,a.sessionSecret,'red',3);
 const gb=tables.startNpcGame(db,'vegas-npc-1',b.playerId,b.sessionSecret,'blue',3);
 stale(ga.playerId);expect(rooms.expireGameDepartures(db,180000)).toEqual([ga.code]);
 expect(rooms.getPublicState(db,ga.code).closed).toBe(true);expect(rooms.getPublicState(db,gb.code).closed).toBe(false);
});
