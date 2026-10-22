import { afterEach,beforeEach,expect,it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { joinBar } from '../src/bar.ts';
import * as poker from '../src/poker.ts';
import type { PokerState } from '../src/pokerEngine.ts';
import { migratePoker } from '../src/pokerSchema.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

let db:Database.Database;
beforeEach(()=>{db=openDb(':memory:');});afterEach(()=>db.close());
function setup(offline=false,wins=false){
  const a=joinBar(db,'Busted host','teal'),b=joinBar(db,'Survivor','orange');
  const roomId=poker.openPoker(db,a.playerId,a.sessionSecret,offline?'offline':'online');
  if(!offline){
    poker.pokerMe(db,b.playerId,b.sessionSecret);poker.invitePoker(db,a.playerId,a.sessionSecret,roomId,b.playerId);
    const invitation=poker.pokerMe(db,b.playerId,b.sessionSecret).invites[0] as {id:string};
    poker.respondPoker(db,b.playerId,b.sessionSecret,invitation.id,true);
  }
  const s=JSON.parse((db.prepare('SELECT state_json FROM poker_rooms WHERE id=?').get(roomId) as {state_json:string}).state_json) as PokerState;
  const opponent=s.players.find(p=>p.id!==a.playerId)!;
  Object.assign(s,{phase:'river',hand:1,board:['2c','3d','7h','8s','9c'],actor:a.playerId,currentBet:0,minRaise:2,pending:[a.playerId,opponent.id],actedAt:Date.now()});
  for(const p of s.players)Object.assign(p,{stack:0,waiting:true,folded:true,hole:[],committed:0,bet:0,actedAt:null});
  Object.assign(s.players.find(p=>p.id===a.playerId)!,{stack:10,waiting:false,folded:false,hole:wins?['Ah','Ad']:['Kh','Kd']});
  Object.assign(opponent,{stack:offline?2490:990,waiting:false,folded:false,hole:wins?['Kh','Kd']:['Ah','Ad']});
  db.prepare('UPDATE poker_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),roomId);
  const act=(who:typeof a,type:string)=>poker.actPoker(db,who.playerId,who.sessionSecret,roomId,poker.pokerView(db,who.playerId,roomId).version,type);
  return {a,b,roomId,opponent,act};
}

it('keeps an all-in human seated until settlement, then releases a bankrupt host and preserves the other human',()=>{
  const t=setup();t.act(t.a,'allin');
  expect(poker.pokerMe(db,t.a.playerId,t.a.sessionSecret)).toMatchObject({departure:null,room:{phase:'river'}});
  expect(poker.pokerView(db,t.a.playerId,t.roomId).players.find(p=>p.id===t.a.playerId)?.stack).toBe(0);
  t.act(t.b,'call');
  const departed=poker.pokerMe(db,t.a.playerId,t.a.sessionSecret);
  expect(departed).toMatchObject({room:null,departure:{reason:'bankrupt',hand:1,roomId:t.roomId}});
  const survivor=poker.pokerView(db,t.b.playerId,t.roomId);
  expect(survivor.host).toBe(t.b.playerId);expect(survivor.phase).toBe('showdown');
  expect(survivor.players.reduce((n,p)=>n+p.stack,0)).toBe(1000);
  expect(()=>t.act(t.a,'rebuy')).toThrow();
  expect(poker.pokerMe(db,t.b.playerId,t.b.sessionSecret).departure).toBeNull();
});

it('does not eliminate an all-in player who wins chips back',()=>{
  const t=setup(false,true);t.act(t.a,'allin');t.act(t.b,'call');
  expect(poker.pokerMe(db,t.a.playerId,t.a.sessionSecret)).toMatchObject({departure:null,room:{phase:'showdown'}});
  expect(poker.pokerView(db,t.a.playerId,t.roomId).players.find(p=>p.id===t.a.playerId)?.stack).toBe(20);
});

it('closes an Offline table on bankruptcy and keeps the notice until its owner acknowledges it',()=>{
  const t=setup(true);t.act(t.a,'allin');
  const raw=JSON.parse((db.prepare('SELECT state_json FROM poker_rooms WHERE id=?').get(t.roomId) as {state_json:string}).state_json);
  raw.actedAt=0;db.prepare('UPDATE poker_rooms SET state_json=? WHERE id=?').run(JSON.stringify(raw),t.roomId);
  poker.tickPoker(db);
  const notice=poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).departure!;
  expect(notice.reason).toBe('bankrupt');expect((db.prepare('SELECT closed FROM poker_rooms WHERE id=?').get(t.roomId) as {closed:number}).closed).toBe(1);
  expect(()=>poker.acknowledgePokerExit(db,t.a.playerId,'wrong',notice.id)).toThrow();
  poker.acknowledgePokerExit(db,t.b.playerId,t.b.sessionSecret,notice.id);
  poker.acknowledgePokerExit(db,t.a.playerId,t.a.sessionSecret,'old-notice');
  expect(poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).departure?.id).toBe(notice.id);
  expect(()=>poker.openPoker(db,t.a.playerId,t.a.sessionSecret,'offline')).toThrow('Acknowledge');
  poker.acknowledgePokerExit(db,t.a.playerId,t.a.sessionSecret,notice.id);
  expect(poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).departure).toBeNull();
  const newRoom=poker.openPoker(db,t.a.playerId,t.a.sessionSecret,'offline');
  expect(newRoom).not.toBe(t.roomId);
});

it('rolls back elimination, notice and host transfer together with a failed settlement transaction',()=>{
  const t=setup();t.act(t.a,'allin');
  expect(()=>db.transaction(()=>{t.act(t.b,'call');throw Error('abort');})()).toThrow('abort');
  expect(poker.pokerMe(db,t.a.playerId,t.a.sessionSecret)).toMatchObject({departure:null,room:{host:t.a.playerId,phase:'river'}});
});

it('migrates an existing poker database and preserves an unacknowledged notice across reopen',async()=>{
  db.exec('DROP TABLE poker_notices');migratePoker(db);
  const t=setup();t.act(t.a,'allin');t.act(t.b,'call');
  const before=poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).departure;
  const path=join(tmpdir(),`bankruptcy-${randomUUID()}.db`);await db.backup(path);const restored=openDb(path);
  try{expect(poker.pokerMe(restored,t.a.playerId,t.a.sessionSecret).departure).toEqual(before);}
  finally{restored.close();for(const f of [path,path+'-wal',path+'-shm'])rmSync(f,{force:true});}
});

it('an explicit acknowledged re-entry starts a fresh free buy-in, rather than rejoining with zero chips',()=>{
  const t=setup();t.act(t.a,'allin');t.act(t.b,'call');
  const notice=poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).departure!;
  poker.acknowledgePokerExit(db,t.a.playerId,t.a.sessionSecret,notice.id);
  poker.invitePoker(db,t.b.playerId,t.b.sessionSecret,t.roomId,t.a.playerId);
  const invite=poker.pokerMe(db,t.a.playerId,t.a.sessionSecret).invites[0] as {id:string};
  poker.respondPoker(db,t.a.playerId,t.a.sessionSecret,invite.id,true);
  expect(poker.pokerView(db,t.a.playerId,t.roomId).players.find(p=>p.id===t.a.playerId)?.stack).toBe(500);
});
