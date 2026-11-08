import {it,expect,beforeEach,afterEach,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type Database from 'better-sqlite3';
import {openDb} from '../src/db.ts';
import {joinBar,moveBar} from '../src/bar.ts';
import {openBlackjack,blackjackMe,actBlackjack,leaveBlackjack,tickBlackjack,BJ_GRACE} from '../src/blackjack.ts';
import {newBlackjack,dealBlackjack,act,stepDealer,choices,depart,total,type BJState} from '../src/blackjackEngine.ts';
import {getTablesStatus} from '../src/tables.ts';
import {openPoker} from '../src/poker.ts';
import {openDomino} from '../src/domino.ts';
let db:Database.Database,dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'bj-online-'));db=openDb(join(dir,'test.db'));});
afterEach(()=>{vi.useRealTimers();db.close();rmSync(dir,{recursive:true,force:true});});
const person=(n:string)=>joinBar(db,n,'red','warm');
type Patron=ReturnType<typeof person>;
const view=(p:Patron)=>blackjackMe(db,p.playerId,p.sessionSecret).room!;
const action=(p:Patron,a:string,bet?:number)=>{const v=view(p);actBlackjack(db,p.playerId,p.sessionSecret,v.id,v.version,a,bet);};
function engine(cards:string[],count=2):BJState {const s=newBlackjack();s.players=Array.from({length:count},(_,seat)=>({id:String(seat),nickname:'P'+seat,seat,stack:500,bet:10,ready:true,leaving:false}));dealBlackjack(s,cards.reverse());return s;}
it('shares a four-seat table, authenticates, and refuses a fifth seat',()=>{
  const people=Array.from({length:5},(_,i)=>person('P'+i));
  const id=openBlackjack(db,people[0].playerId,people[0].sessionSecret,0);
  for(let i=1;i<4;i++)expect(openBlackjack(db,people[i].playerId,people[i].sessionSecret,i,id)).toBe(id);
  expect(view(people[0]).players).toHaveLength(4);
  expect(()=>openBlackjack(db,people[4].playerId,people[4].sessionSecret,0,id)).toThrow(/four/);
  expect(()=>blackjackMe(db,people[0].playerId,'wrong')).toThrow();
  expect(getTablesStatus(db).find(t=>t.id==='blackjack-1')?.playerCount).toBe(4);
});
it('requires all players ready and a host, rejects replay and protects the hidden shoe',()=>{
  const a=person('A'),b=person('B');openBlackjack(db,a.playerId,a.sessionSecret,0);openBlackjack(db,b.playerId,b.sessionSecret,1);
  expect(()=>action(a,'Deal')).toThrow(/ready/);action(a,'Ready',10);action(b,'Ready',10);
  expect(()=>action(b,'Deal')).toThrow(/host/);
  const old=view(a);action(a,'Deal');
  expect(()=>actBlackjack(db,a.playerId,a.sessionSecret,old.id,old.version,'Deal')).toThrow(/changed/);
  const r=view(a);expect(r).not.toHaveProperty('deck');expect(r).not.toHaveProperty('state_json');
  if(!r.revealed)expect(r.dealer).toEqual([expect.any(String),null]);
  expect(r.players.every(p=>p.stack===490||r.phase==='settled')).toBe(true);
});
it('rejects invalid wagers without changing chips or readiness',()=>{
  const a=person('A');openBlackjack(db,a.playerId,a.sessionSecret,0);
  for(const bet of [0,-2,3,502,Infinity,NaN])expect(()=>action(a,'Ready',bet)).toThrow();
  expect(view(a).players[0]).toMatchObject({stack:500,ready:false});
});
it('accepts simultaneous independent readiness but cannot change bets after the deal',()=>{
  const a=person('A'),b=person('B');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);openBlackjack(db,b.playerId,b.sessionSecret,1);
  const version=view(a).version;
  actBlackjack(db,a.playerId,a.sessionSecret,id,version,'Ready',10);
  actBlackjack(db,b.playerId,b.sessionSecret,id,version,'Ready',20);
  expect(view(a).players.every(p=>p.ready)).toBe(true);
  action(a,'Deal');if(!['betting','settled'].includes(view(a).phase))expect(()=>actBlackjack(db,b.playerId,b.sessionSecret,id,version,'Ready',50)).toThrow(/hand/);
});
it('blocks occupying blackjack and other games/dining movement simultaneously',()=>{
  const a=person('A');openBlackjack(db,a.playerId,a.sessionSecret,0);
  expect(()=>openPoker(db,a.playerId,a.sessionSecret,'offline')).toThrow(/blackjack/);
  expect(()=>openDomino(db,a.playerId,a.sessionSecret,'offline',0)).toThrow(/blackjack/);
  expect(()=>moveBar(db,a.playerId,a.sessionSecret,1,1)).toThrow(/blackjack/);
  leaveBlackjack(db,a.playerId,a.sessionSecret);openPoker(db,a.playerId,a.sessionSecret,'offline');
  expect(()=>openBlackjack(db,a.playerId,a.sessionSecret,0)).toThrow(/seat/);
});
it('persists on reopen, transfers host on leave and closes when the last player leaves',()=>{
  const a=person('A'),b=person('B');openBlackjack(db,a.playerId,a.sessionSecret,0);openBlackjack(db,b.playerId,b.sessionSecret,1);action(a,'Ready',20);
  const before=view(a);db.close();db=openDb(join(dir,'test.db'));expect(view(a)).toEqual(before);
  leaveBlackjack(db,a.playerId,a.sessionSecret);expect(view(b).host).toBe(b.playerId);
  leaveBlackjack(db,b.playerId,b.sessionSecret);expect(blackjackMe(db,b.playerId,b.sessionSecret).room).toBeNull();
  expect(getTablesStatus(db).find(t=>t.id==='blackjack-1')?.playerCount).toBe(0);
});
it('keeps seats before three minutes, expires them afterwards and refuses stale links',()=>{
  vi.useFakeTimers();const a=person('A');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);
  vi.advanceTimersByTime(BJ_GRACE-1);expect(view(a)).not.toBeNull();
  vi.advanceTimersByTime(2);tickBlackjack(db);expect(blackjackMe(db,a.playerId,a.sessionSecret).room).toBeNull();
  expect(()=>openBlackjack(db,a.playerId,a.sessionSecret,0,id)).toThrow(/closed/);
});
// 2026-11-07 correction (user's own explicit instruction): a hand in
// progress now refuses ANY new seating attempt outright, including one
// with a genuinely empty chair — replacing the previous "wait silently
// for the next deal" behavior this test used to pin down. The refused
// patron is also registered on a waitlist and notified the instant the
// hand actually ends (save()'s own notified=1 update).
it('refuses a new seat mid-hand even with an empty chair, waitlists the refused patron, and notifies them once the hand ends',()=>{
  const a=person('A'),b=person('B');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);
  const s=engine(['10♣','10♥','6♦','7♠'],1);s.players[0].id=a.playerId;s.hands[0].owner=a.playerId;
  db.prepare('UPDATE blackjack_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),id);
  expect(()=>openBlackjack(db,b.playerId,b.sessionSecret,1,id)).toThrow(/round|hand/i);
  let me=blackjackMe(db,b.playerId,b.sessionSecret);
  expect(me.room).toBeNull();
  expect(me.waitlist).toEqual([{roomId:id,notified:false}]);
  // Still mid-hand — nothing notifies yet.
  expect(blackjackMe(db,b.playerId,b.sessionSecret).waitlist[0].notified).toBe(false);
  // Settle the hand directly (mirrors the engine-level settlement tests
  // elsewhere in this file) and save it through the same save() path
  // actBlackjack/tickBlackjack already use, which is what fires the
  // waitlist notification once the phase is genuinely back to settled.
  act(s,a.playerId,'Stand');stepDealer(s);stepDealer(s);
  expect(['betting','settled']).toContain(s.phase);
  db.prepare('UPDATE blackjack_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),id);
  tickBlackjack(db); // re-saves nothing new, but exercises the normal read path
  // Directly invoke the same notify-on-save logic tickBlackjack's own
  // save() calls would trigger, by performing a real, tiny mutating
  // action (Ready) that goes through actBlackjack -> save().
  action(a,'Ready',10);
  me=blackjackMe(db,b.playerId,b.sessionSecret);
  expect(me.waitlist).toEqual([{roomId:id,notified:true}]);
  // Once notified, the waitlisted patron can now actually sit.
  openBlackjack(db,b.playerId,b.sessionSecret,1,id);
  expect(blackjackMe(db,b.playerId,b.sessionSecret).waitlist).toEqual([]);
});
it('refuses joining a table with four active players, waitlists the refused patron, and notifies them once a seat opens',()=>{
  const people=Array.from({length:5},(_,i)=>person('P'+i));
  const id=openBlackjack(db,people[0].playerId,people[0].sessionSecret,0);
  for(let i=1;i<4;i++)openBlackjack(db,people[i].playerId,people[i].sessionSecret,i,id);
  expect(()=>openBlackjack(db,people[4].playerId,people[4].sessionSecret,0,id)).toThrow(/four|occupied/i);
  expect(blackjackMe(db,people[4].playerId,people[4].sessionSecret).waitlist).toEqual([{roomId:id,notified:false}]);
  leaveBlackjack(db,people[0].playerId,people[0].sessionSecret);
  expect(blackjackMe(db,people[4].playerId,people[4].sessionSecret).waitlist).toEqual([{roomId:id,notified:true}]);
});
it('times out a turn into Stand without drawing and advances the dealer at paced ticks',()=>{
  vi.useFakeTimers();const a=person('A');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);
  const s=engine(['10♣','2♥','6♦','3♠','4♦','8♥'],1);s.players[0].id=a.playerId;s.hands[0].owner=a.playerId;
  db.prepare('UPDATE blackjack_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),id);
  vi.advanceTimersByTime(45001);tickBlackjack(db);expect(view(a).phase).toBe('dealer');expect(view(a).hands[0].cards).toHaveLength(2);
  vi.advanceTimersByTime(1101);tickBlackjack(db);expect(view(a).dealer).toHaveLength(2);expect(view(a).revealed).toBe(true);
  vi.advanceTimersByTime(1101);tickBlackjack(db);expect(view(a).dealer).toHaveLength(3);
});
it('naturals pay 3:2, insurance pays 2:1, and settlement cannot pay twice',()=>{
  const natural=engine(['A♣','9♠','K♦','8♥'],1);expect(natural.phase).toBe('dealer');stepDealer(natural);stepDealer(natural);expect(natural.players[0].stack).toBe(515);stepDealer(natural);expect(natural.players[0].stack).toBe(515);
  const s=engine(['9♣','A♠','8♦','K♥'],1);act(s,'0','Insurance');expect(s.phase).toBe('settled');expect(s.players[0].stack).toBe(500);
});
it('splits and doubles for one final card, and does not expose actions to other players',()=>{
  const s=engine(['8♣','10♠','8♦','7♥','3♣','2♠','K♥'],1);act(s,'0','Split');expect(s.hands).toHaveLength(2);
  act(s,'0','Double');expect(s.hands[0].cards).toHaveLength(3);expect(s.players[0].stack).toBe(470);
  expect(choices(s,'intruder')).toEqual([]);act(s,'0','Stand');stepDealer(s);stepDealer(s);
  expect(s.players[0].stack).toBe(510);
});
it('split aces get one card each, no natural bonus, and dealer stands on soft 17',()=>{
  const s=engine(['A♣','A♠','A♦','6♥','K♣','9♠'],1);act(s,'0','Decline');act(s,'0','Split');
  expect(s.phase).toBe('dealer');stepDealer(s);stepDealer(s);expect(s.dealer).toHaveLength(2);expect(s.players[0].stack).toBe(520);
});
it('departure during insurance declines it and allows the remaining player to finish',()=>{
  const s=engine(['10♣','9♣','A♠','7♦','8♦','6♥']);depart(s,'0');act(s,'1','Decline');expect(s.phase).toBe('playing');expect(s.hands[s.turn].owner).toBe('1');
});
it('settled bankrupt players receive a notice and no longer occupy a seat',()=>{
  const a=person('A');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);
  const s=engine(['10♣','10♥','6♦','7♠'],1);s.players[0].id=a.playerId;s.players[0].stack=0;s.hands[0].owner=a.playerId;
  act(s,a.playerId,'Stand');stepDealer(s);s.changedAt=Date.now()-1200;
  db.prepare('UPDATE blackjack_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),id);tickBlackjack(db);
  expect(blackjackMe(db,a.playerId,a.sessionSecret)).toMatchObject({room:null,notice:expect.stringContaining('Out of chips')});
});
it('does not show the previous occupant’s settled cards under a newcomer’s name',()=>{
  const a=person('A'),b=person('B'),c=person('C');const id=openBlackjack(db,a.playerId,a.sessionSecret,0);openBlackjack(db,b.playerId,b.sessionSecret,1);
  const s=engine(['10♣','9♣','10♠','7♦','8♦','7♥']);
  for(const [i,p] of [a,b].entries()){s.players[i].id=p.playerId;s.hands[i].owner=p.playerId;}
  act(s,a.playerId,'Stand');act(s,b.playerId,'Stand');stepDealer(s);stepDealer(s);
  s.players[0].stack=123;
  db.prepare('UPDATE blackjack_rooms SET state_json=? WHERE id=?').run(JSON.stringify(s),id);
  leaveBlackjack(db,a.playerId,a.sessionSecret);openBlackjack(db,c.playerId,c.sessionSecret,0,id);
  expect(view(c).hands.some(h=>h.owner===a.playerId)).toBe(false);
  expect(view(c).players.find(p=>p.seat===0)?.id).toBe(c.playerId);
  openBlackjack(db,a.playerId,a.sessionSecret,2,id);
  expect(view(a).players.find(p=>p.id===a.playerId)?.stack).toBe(s.players[0].stack);
});
