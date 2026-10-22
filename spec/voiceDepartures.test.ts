import { expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import * as bar from '../src/bar.ts';
import * as rooms from '../src/rooms.ts';
import * as tables from '../src/tables.ts';
import * as voice from '../src/voice.ts';
import { subscribeRoomVoice } from '../src/live.ts';

it.each(['bar departure','dining seat'])('ends voice eligibility on %s without releasing the game seat',kind=>{
  const db=openDb(':memory:');let unsubscribe=()=>{};
  try {
    const patron=bar.joinBar(db,'Patron','teal');
    const a=tables.createTableRoom(db,'vegas-1',patron.playerId,patron.sessionSecret,'red');
    const b=rooms.joinRoom(db,a.code,'Guest','blue');
    const call=voice.startOrJoinCall(db,a.code,a.playerId,a.sessionSecret);
    voice.respondToInvite(db,a.code,b.playerId,b.sessionSecret,call.callId!,true);
    const messages:string[]=[];unsubscribe=subscribeRoomVoice(a.code,a.playerId,message=>messages.push(message));
    if(kind==='bar departure')tables.departActiveTable(db,patron.playerId,patron.sessionSecret);
    else {
      const seat=bar.getSeatLayout()[0];
      db.prepare('UPDATE bar_players SET x=?, y=? WHERE id=?').run(seat.x+1,seat.y,patron.playerId);
      bar.sitAtSeat(db,patron.playerId,patron.sessionSecret,seat.id);
    }
    expect(()=>voice.startOrJoinCall(db,a.code,a.playerId,a.sessionSecret)).toThrow('return to your game');
    expect(()=>voice.relaySignal(db,a.code,b.playerId,b.sessionSecret,call.callId!,a.playerId,'offer',{})).toThrow('both sides');
    expect(voice.getPublicCallSummary(db,a.code).participants.map(p=>p.playerId)).toEqual([b.playerId]);
    expect(messages.some(m=>JSON.parse(m).type==='removed_from_call')).toBe(true);
    expect(rooms.getPublicState(db,a.code).players.some(p=>p.id===a.playerId)).toBe(true);
    tables.resumeActiveTable(db,patron.playerId,patron.sessionSecret);
    expect(voice.startOrJoinCall(db,a.code,a.playerId,a.sessionSecret).participants).toHaveLength(2);
  } finally {unsubscribe();db.close();}
});
