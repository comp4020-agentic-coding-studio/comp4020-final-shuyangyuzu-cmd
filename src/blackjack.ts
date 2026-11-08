import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireBarSession,barHeartbeat } from './bar.ts';
import { getActiveSeat } from './tables.ts';
import { isEating } from './eating.ts';
import { RoomError } from './rooms.ts';
import { transact,logAction } from './actionLog.ts';
import {newBlackjack,dealBlackjack,act,choices,stepDealer,depart,total,type BJState} from './blackjackEngine.ts';
type Row={id:string;host:string;state_json:string;version:number;closed:number};
type Member={room_id:string;bar_id:string;seat:number;seen:number;away:number};
export const BJ_GRACE=180000;
const member=(db:Database.Database,id:string)=>db.prepare('SELECT * FROM blackjack_members WHERE bar_id=? AND active=1').get(id) as Member|undefined;
const fail=(message:string,code='illegal_blackjack_action',status=409):never=>{throw new RoomError(message,code,status);};
function row(db:Database.Database,id:string):Row{const r=db.prepare('SELECT * FROM blackjack_rooms WHERE id=? AND closed=0').get(id) as Row|undefined;if(!r)fail('This blackjack table has closed','blackjack_closed',410);return r!;}
function save(db:Database.Database,r:Row,s:BJState,id:string|null,action:string):void {
  for(const p of s.players)db.prepare('INSERT INTO blackjack_wallets VALUES(?,?,?) ON CONFLICT(room_id,bar_id) DO UPDATE SET stack=excluded.stack').run(r.id,p.id,p.stack);
  if(s.phase==='settled')for(const p of s.players)if(!p.leaving&&p.stack<2){
    p.leaving=true;db.prepare('UPDATE blackjack_members SET active=0 WHERE room_id=? AND bar_id=?').run(r.id,p.id);
    db.prepare('INSERT OR REPLACE INTO blackjack_notices VALUES(?,?)').run(p.id,'Out of chips. Your hand has settled and you have left the table.');
  }
  const remaining=db.prepare('SELECT bar_id FROM blackjack_members WHERE room_id=? AND active=1 ORDER BY seat').all(r.id) as {bar_id:string}[];
  if(!remaining.some(p=>p.bar_id===r.host))r.host=remaining[0]?.bar_id??r.host;
  db.prepare('UPDATE blackjack_rooms SET state_json=?,host=?,version=version+1,closed=? WHERE id=?').run(JSON.stringify(s),r.host,remaining.length?0:1,r.id);
  logAction(db,{action:'blackjack_'+action,outcome:'ok',verified:id!==null,actor:id?{kind:'bar',id}:null,room:{code:r.id},detail:{hand:s.hand,phase:s.phase}});
  // 2026-11-07 correction (user's own explicit instruction: "局中即使有
  // 空位也要提示'请等待本轮结束'...通知先前尝试加入的人现在可以加入了").
  // The instant this save lands the table back in betting/settled — the
  // only phases openBlackjack will now actually seat someone in — notify
  // everyone waiting for THIS room specifically. A mid-hand save (still
  // playing/dealer/insurance) never reaches this, so nobody is told
  // prematurely.
  if(['betting','settled'].includes(s.phase))db.prepare('UPDATE blackjack_waitlist SET notified=1 WHERE room_id=?').run(r.id);
}
function free(db:Database.Database,id:string):void {
  if(isEating(db,id))fail('Finish eating first','eating_active');
  if(getActiveSeat(db,id)||db.prepare('SELECT 1 FROM poker_members WHERE bar_id=? AND active=1').get(id)||db.prepare('SELECT 1 FROM domino_members WHERE bar_id=? AND active=1').get(id)||db.prepare('SELECT 1 FROM bar_seats WHERE occupied_by=?').get(id))fail('Leave your current seat first','already_seated');
}
export function openBlackjack(db:Database.Database,id:string,secret:string,seat:number,target?:string):string {
  requireBarSession(db,id,secret);tickBlackjack(db);
  if(!Number.isInteger(seat)||seat<0||seat>3)fail('Choose one of the four chairs','bad_request',400);
  // Mirrors dominoes' own two-phase shape (src/domino.ts's openDomino,
  // same comment there has the full reasoning): a refusal that ALSO
  // needs to record a waitlist entry can't throw from inside the
  // transaction that writes it — the throw would roll the write back
  // too. The callback returns a RoomError value instead of throwing it;
  // only once that return has actually committed does this function
  // decide whether to hand back the room id or throw the error.
  const outcome=transact(db,():string|RoomError=>{
    const m=member(db,id);if(m){if(target&&m.room_id!==target)return new RoomError('Leave your current table first','already_seated',409);return m.room_id;}
    try{free(db,id);}catch(e){return e as RoomError;}
    let r=target?row(db,target):db.prepare('SELECT * FROM blackjack_rooms WHERE closed=0').get() as Row|undefined;
    if(!r){r={id:randomUUID(),host:id,state_json:JSON.stringify(newBlackjack()),version:0,closed:0};db.prepare('INSERT INTO blackjack_rooms(id,host,state_json) VALUES(?,?,?)').run(r.id,id,r.state_json);}
    const s=JSON.parse(r.state_json) as BJState;
    // 2026-11-07 correction (user's own explicit instruction): a hand in
    // progress now refuses ANY new seating attempt outright — including
    // one with a genuinely empty chair — rather than silently seating the
    // newcomer to wait for the next deal as before (the previous
    // behavior spec/blackjackOnline.test.ts used to pin down). Only
    // betting/settled (the two moments between hands) ever seat anyone.
    if(!['betting','settled'].includes(s.phase)){
      joinBlackjackWaitlist(db,r.id,id);
      return new RoomError('Wait for this round to end before joining','hand_in_progress',409);
    }
    const busy=new Set(s.players.filter(p=>!p.leaving).map(p=>p.seat));
    if(busy.has(seat)){const empty=[0,1,2,3].find(n=>!busy.has(n));if(empty===undefined){joinBlackjackWaitlist(db,r.id,id);return new RoomError('All four seats are occupied. You will be notified when a seat opens.','table_full',409);}seat=empty!;}
    const existing=s.players.find(p=>p.id===id);
    // Departed players stay until settlement so their committed bets still resolve.
    const wallet=db.prepare('SELECT stack FROM blackjack_wallets WHERE room_id=? AND bar_id=?').get(r.id,id) as {stack:number}|undefined;
    const stack=existing?.stack??wallet?.stack??500;
    if(stack<2)return new RoomError('No chips left at this table. Wait for a new table','out_of_chips',409);
    s.players=s.players.filter(p=>p.id!==id&&!p.leaving);
    s.hands=s.hands.filter(h=>s.players.some(p=>p.id===h.owner));
    const p=db.prepare('SELECT nickname FROM bar_players WHERE id=?').get(id) as {nickname:string};
    s.players.push({id,nickname:p.nickname,seat,stack,bet:Math.min(10,Math.floor(stack/2)*2),ready:false,leaving:false});
    db.prepare('INSERT INTO blackjack_members(room_id,bar_id,seat,seen,active) VALUES(?,?,?,?,1) ON CONFLICT(room_id,bar_id) DO UPDATE SET seat=excluded.seat,seen=excluded.seen,active=1').run(r.id,id,seat,Date.now());
    db.prepare('DELETE FROM blackjack_notices WHERE bar_id=?').run(id);
    db.prepare('DELETE FROM blackjack_waitlist WHERE room_id=? AND bar_id=?').run(r.id,id);
    save(db,r,s,id,'join');return r.id;
  });
  if(outcome instanceof RoomError)throw outcome;
  return outcome;
}
// ---- Waitlist — see src/domino.ts's own joinDominoWaitlist comment for
// the shared reasoning. Unlike dominoes (which closes its whole room on
// any departure, so a lane rather than a room id is the stable thing to
// wait for), blackjack has exactly one persistent shared online room at
// a time (the blackjack_one_online unique index) — waiting for "this
// room id" is therefore already stable here, with no lane-style
// indirection needed. ----
function joinBlackjackWaitlist(db:Database.Database,roomId:string,id:string):void {
  db.prepare('INSERT INTO blackjack_waitlist(room_id,bar_id,created,notified) VALUES(?,?,?,0) ON CONFLICT(room_id,bar_id) DO UPDATE SET created=excluded.created,notified=0').run(roomId,id,Date.now());
}
export function leaveBlackjack(db:Database.Database,id:string,secret:string):void {
  requireBarSession(db,id,secret);transact(db,()=>{const m=member(db,id);if(!m)return;const r=row(db,m.room_id),s=JSON.parse(r.state_json) as BJState;
    depart(s,id);db.prepare('UPDATE blackjack_members SET active=0 WHERE bar_id=? AND room_id=?').run(id,r.id);save(db,r,s,id,'leave');});
}
export function actBlackjack(db:Database.Database,id:string,secret:string,roomId:string,version:number,action:string,bet?:number):void {
  requireBarSession(db,id,secret);tickBlackjack(db);
  transact(db,()=>{
    const r=row(db,roomId);if(member(db,id)?.room_id!==roomId)fail('You are not seated here','not_seated',403);
    if(isEating(db,id))fail('Finish eating first','eating_active');
    // Wager readiness is independent per person and never spends chips.
    // Let simultaneous Ready clicks succeed; the phase guard below still
    // rejects a request arriving after the host has dealt.
    if(version!==r.version&&!['Ready','Unready'].includes(action))fail('The table changed. Try again.','stale_state');
    const s=JSON.parse(r.state_json) as BJState,p=s.players.find(p=>p.id===id)!;
    try {
      if(action==='Ready'||action==='Unready'){
        if(!['betting','settled'].includes(s.phase))throw Error('Wait until this hand ends');
        if(action==='Ready'){if(!Number.isInteger(bet)||bet!<2||bet!>p.stack||bet!%2!==0)throw Error('Choose an even wager from 2 up to your chips');p.bet=bet!;}
        p.ready=action==='Ready';
      }else if(action==='Deal'){
        if(r.host!==id)fail('Only the host can deal','not_host',403);dealBlackjack(s);
      }else act(s,id,action);
    }catch(e){if(e instanceof RoomError)throw e;fail((e as Error).message);}
    db.prepare('UPDATE blackjack_members SET seen=? WHERE bar_id=? AND active=1').run(Date.now(),id);save(db,r,s,id,action.toLowerCase());
  });
}
/** This identity's own pending waitlist entries — `notified:true` once
 * that specific room has actually returned to betting/settled since they
 * joined the waitlist (save() above), cleared the moment they
 * successfully sit there (openBlackjack's own cleanup). Mirrors
 * dominoes' own dominoWaitlistFor exactly. */
function blackjackWaitlistFor(db:Database.Database,id:string){
  return db.prepare('SELECT room_id AS roomId,notified FROM blackjack_waitlist WHERE bar_id=?').all(id) as {roomId:string;notified:number}[];
}
/** Explicitly gives up a pending wait for a specific room — the
 * counterpart to joinBlackjackWaitlist. */
export function leaveBlackjackWaitlist(db:Database.Database,id:string,secret:string,roomId:string):void {
  requireBarSession(db,id,secret);
  db.prepare('DELETE FROM blackjack_waitlist WHERE room_id=? AND bar_id=?').run(roomId,id);
}
/** Sets/clears this caller's own explicit, display-only away flag —
 * mirrors poker.ts's setPokerAway exactly (same reasoning: a presence
 * display change must never bump the room's own optimistic-concurrency
 * version, and must be an explicit action, never inferred from a passive
 * heartbeat staleness window the way this flag used to be computed
 * in-line below — 2026-11-08 correction, the user's own explicit
 * instruction to make exit vs. away distinct and explicit for every
 * game). Unlike leaveBlackjack, this never releases the seat or touches
 * the hand — an away player's chair cannot be taken by anyone else; the
 * existing 45-second action timeout and 3-minute disconnect-grace sweep
 * (tickBlackjack below) are both completely unaffected by it, exactly
 * like poker's own away flag. */
export function setBlackjackAway(db:Database.Database,id:string,secret:string,away:boolean):void {
  requireBarSession(db,id,secret);
  const m=member(db,id);
  if(!m)fail('You are not seated at a blackjack table','not_seated',403);
  db.prepare('UPDATE blackjack_members SET away=? WHERE room_id=? AND bar_id=?').run(away?1:0,m!.room_id,id);
  logAction(db,{action:'blackjack_away',outcome:'ok',verified:true,actor:{kind:'bar',id},room:{code:m!.room_id},detail:{away}});
}
export function blackjackMe(db:Database.Database,id:string,secret:string,active=false){
  requireBarSession(db,id,secret);tickBlackjack(db);const m=member(db,id);
  const notice=db.prepare('SELECT message FROM blackjack_notices WHERE bar_id=?').get(id) as {message:string}|undefined;
  const waitlist=blackjackWaitlistFor(db,id).map(w=>({roomId:w.roomId,notified:!!w.notified}));
  if(!m)return {room:null,notice:notice?.message??null,waitlist};
  if(active){db.prepare('UPDATE blackjack_members SET seen=? WHERE bar_id=? AND active=1').run(Date.now(),id);barHeartbeat(db,id,secret);}
  const r=row(db,m.room_id),s=JSON.parse(r.state_json) as BJState;
  const presence=db.prepare('SELECT bar_id,away FROM blackjack_members WHERE room_id=? AND active=1').all(r.id) as {bar_id:string;away:number}[];
  return {notice:null,waitlist,room:{id:r.id,host:r.host,version:r.version,seat:m.seat,hand:s.hand,phase:s.phase,
    players:s.players.filter(p=>!p.leaving||s.hands.some(h=>h.owner===p.id)&&!['betting','settled'].includes(s.phase)).map(p=>({...p,away:!!presence.find(m=>m.bar_id===p.id)?.away})),
    hands:s.hands,dealer:s.revealed?s.dealer:s.dealer.length?[s.dealer[0],null]:[],revealed:s.revealed,turn:s.phase==='playing'?s.hands[s.turn]?.owner:null,
    choices:choices(s,id),lastMove:s.lastMove,deadline:s.changedAt+45000,dealerTotal:s.revealed?total(s.dealer):s.dealer.length?total([s.dealer[0]]):0}};
}
export function tickBlackjack(db:Database.Database):void {
  transact(db,()=>{for(const r of db.prepare('SELECT * FROM blackjack_rooms WHERE closed=0').all() as Row[]){
    const s=JSON.parse(r.state_json) as BJState;let dirty=false;
    for(const m of db.prepare('SELECT * FROM blackjack_members WHERE room_id=? AND active=1 AND seen<=?').all(r.id,Date.now()-BJ_GRACE) as Member[]){
      depart(s,m.bar_id);db.prepare('UPDATE blackjack_members SET active=0 WHERE bar_id=? AND room_id=?').run(m.bar_id,r.id);dirty=true;
    }
    if(s.phase==='dealer'&&Date.now()-s.changedAt>=1100){stepDealer(s);dirty=true;}
    else if(Date.now()-s.changedAt>=45000){
      if(s.phase==='playing'){const h=s.hands[s.turn];act(s,h.owner,'Stand');dirty=true;}
      else if(s.phase==='insurance'){for(const id of Object.keys(s.insurance))if(s.insurance[id]===null)act(s,id,'Decline');dirty=true;}
    }
    if(dirty)save(db,r,s,null,'tick');
  }});
}
