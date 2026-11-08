import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireBarSession,barHeartbeat } from './bar.ts';
import { getActiveSeat } from './tables.ts';
import { RoomError } from './rooms.ts';
import { transact,logAction } from './actionLog.ts';
import { deal,moves,endTotal,play,drawOrPass,npcMove,type DominoState,type Tile } from './dominoEngine.ts';

type Row={id:string;mode:string;lane:number;host:string;state_json:string|null;version:number;closed:number;result:string};
type Member={room_id:string;bar_id:string;seat:number;seen:number;away:number};
export const DOMINO_GRACE_MS=180000;
const member=(db:Database.Database,id:string)=>db.prepare('SELECT * FROM domino_members WHERE bar_id=? AND active=1').get(id) as Member|undefined;
function room(db:Database.Database,id:string):Row {const r=db.prepare('SELECT * FROM domino_rooms WHERE id=?').get(id) as Row|undefined;if(!r||r.closed)throw new RoomError('This domino match has ended','domino_closed',410);return r;}
function assertFree(db:Database.Database,id:string):void {
  if(db.prepare('SELECT 1 FROM blackjack_members WHERE bar_id=? AND active=1').get(id))throw new RoomError('Leave your blackjack table first','already_seated',409);
  if(member(db,id)||getActiveSeat(db,id)||db.prepare('SELECT 1 FROM poker_members WHERE bar_id=? AND active=1').get(id)||db.prepare('SELECT 1 FROM bar_seats WHERE occupied_by=?').get(id))throw new RoomError('Leave your current seat first','already_seated',409);
  // The eating branch adds its own module. This optional-schema check keeps
  // this independent branch safe both before and after that migration merges.
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bar_eating_actions'").get()&&db.prepare('SELECT 1 FROM bar_eating_actions WHERE player_id=? AND ends_at>?').get(id,new Date().toISOString()))throw new RoomError('Finish eating first','eating_active',409);
}
function log(db:Database.Database,r:Row,id:string|null,action:string):void {logAction(db,{action:`domino_${action}`,outcome:'ok',verified:id!==null,actor:id?{kind:'bar',id}:null,room:{code:r.id},detail:{lane:r.lane,mode:r.mode}});}
function save(db:Database.Database,r:Row,s:DominoState,id:string|null,action:string):void {db.prepare('UPDATE domino_rooms SET state_json=?,version=version+1 WHERE id=?').run(JSON.stringify(s),r.id);log(db,r,id,action);}
function close(db:Database.Database,r:Row,id:string|null,reason:string):void {
  db.prepare('UPDATE domino_rooms SET closed=1,version=version+1,result=? WHERE id=?').run(reason,r.id);
  db.prepare('UPDATE domino_members SET active=0 WHERE room_id=?').run(r.id);
  log(db,r,id,'close');
  // The lane this room occupied just became free — the instant anyone's
  // online match ends (a leave, a disconnect-expiry) is exactly when
  // "notify everyone who was waiting for this lane" (the user's own
  // explicit instruction) actually applies. Offline rooms have no lane
  // contention (every visitor gets their own private room), so this is a
  // no-op for them.
  if(r.mode==='online')notifyDominoWaitlist(db,r.lane);
}
// 2026-11-08 correction (user's own explicit instruction, confirmed via
// AskUserQuestion since it changes already-tested behavior): a departing
// player used to close the WHOLE room, kicking the remaining player out
// too — the exact opposite of the substitute scenario the user described
// ("A、B正在对局，B退出，A仍在座，C坐到A对面后自动配对开新局"). This is now
// the single shared release path for every way a seat can become empty —
// an explicit leaveDomino call and a disconnect-grace expiry alike (both
// previously called close() directly) — mirroring exactly how
// blackjack.ts's own `depart`/host-reassignment-on-leave already works,
// which this module never had an equivalent of before. Offline mode is
// unaffected: its one human seat leaving always leaves zero active
// members (there's no second human, just an NPC with no membership row),
// so it still falls through to a genuine close() exactly as before.
function releaseDominoSeat(db:Database.Database,r:Row,id:string,reason:string):void {
  db.prepare('UPDATE domino_members SET active=0 WHERE room_id=? AND bar_id=?').run(r.id,id);
  const remaining=db.prepare('SELECT bar_id FROM domino_members WHERE room_id=? AND active=1').all(r.id) as {bar_id:string}[];
  if(!remaining.length){
    close(db,r,id,reason);
    return;
  }
  // One human remains, seated, waiting for a new opponent. The CURRENT
  // match (hands/board/scores) correctly ends — it belonged to the pair
  // that just lost a member, not to whatever new pairing eventually
  // fills the empty chair — by resetting state_json to null, the same
  // "no match dealt yet" state a brand-new room starts in. Host transfers
  // to whoever's left if the departing player was host (mirrors
  // blackjack.ts's/poker.ts's own save()-time host-reassignment exactly).
  db.prepare('UPDATE domino_rooms SET state_json=NULL,host=?,version=version+1,result=? WHERE id=?').run(remaining[0].bar_id,reason,r.id);
  log(db,r,id,'seat_released');
  if(r.mode==='online')notifyDominoWaitlist(db,r.lane);
}
export function expireDomino(db:Database.Database):void {
  transact(db,()=>{
    const stale=db.prepare(`SELECT m.bar_id,r.* FROM domino_members m JOIN domino_rooms r ON r.id=m.room_id WHERE r.closed=0 AND m.active=1 AND m.seen<=?`).all(Date.now()-DOMINO_GRACE_MS) as (Row&{bar_id:string})[];
    for(const row of stale){
      const {bar_id,...r}=row;
      // A room this same transaction already released (the other member
      // of the same pair also went stale) may since have closed — skip it
      // rather than operating on an already-closed row.
      const fresh=db.prepare('SELECT * FROM domino_rooms WHERE id=?').get(r.id) as Row;
      if(fresh.closed)continue;
      releaseDominoSeat(db,fresh,bar_id,'A player was away for three minutes.');
    }
  });
}
export function openDomino(db:Database.Database,id:string,secret:string,mode:string,chair:number):{roomId:string} {
  requireBarSession(db,id,secret);
  expireDomino(db);
  if(!['online','offline'].includes(mode)||!Number.isInteger(chair)||chair<0||chair>3)throw new RoomError('Choose one of the four domino chairs','bad_request',400);
  // A refusal that also needs to record a waitlist entry can't just throw
  // from inside transact() below — a throw rolls back EVERYTHING the
  // transaction's callback did, including a waitlist insert made right
  // before the throw (a real bug this round's own regression tests
  // caught directly: the waitlist row never survived when written in the
  // same transaction as the eventual throw). So the callback returns
  // either a successful result OR a RoomError value (never throws it
  // itself), the waitlist write and that return both commit together as
  // one successful transaction, and only once that's actually committed
  // does this function decide whether to return the result or throw the
  // error it was handed back.
  const outcome=transact(db,():{roomId:string}|RoomError=>{
    const own=member(db,id);if(own){const r=room(db,own.room_id);if(r.mode!==mode||r.lane!==Math.floor(chair/2))return new RoomError('Leave your current match first','already_seated',409);return {roomId:r.id};}
    try{assertFree(db,id);}catch(e){return e as RoomError;}
    const lane=Math.floor(chair/2),seat=chair%2;
    const r=mode==='online'?db.prepare("SELECT * FROM domino_rooms WHERE mode='online' AND lane=? AND closed=0").get(lane) as Row|undefined:undefined;
    if(r){
      // 2026-11-07 correction (user's own explicit instruction): sitting
      // at the empty facing seat joins immediately — no host approval
      // step anymore. respondDomino/domino_requests are removed outright
      // (not just unused): the host-approval shape this replaces
      // (CLAUDE.md's prior "first seated player approves their
      // opponent") is now only Vegas's own behavior, not shared by any
      // of the other three online games. A seat already taken, or a
      // match that's already started, is still refused — that's a
      // genuine occupancy conflict, not an approval gate — and joins the
      // waitlist instead of a bare error, so a previously-refused patron
      // is proactively told once this lane frees up.
      if(r.state_json||db.prepare('SELECT 1 FROM domino_members WHERE room_id=? AND seat=? AND active=1').get(r.id,seat)){
        joinDominoWaitlist(db,lane,id);
        return new RoomError('That seat is occupied or the match has started. You will be notified when a seat opens.','seat_taken',409);
      }
      db.prepare('INSERT INTO domino_members(room_id,bar_id,seat,seen,active) VALUES(?,?,?,?,1)').run(r.id,id,seat,Date.now());
      // A real bug caught by this round's own regression tests: this
      // branch (joining a STILL-OPEN room at a seat that's now free
      // again, e.g. after a substitute scenario releases one seat)
      // never cleared this same caller's own stale waitlist entry — only
      // the brand-new-room branch below did. A patron who waited, got
      // notified, and successfully sat back down would otherwise keep
      // seeing a stale `notified:true` row for a lane they're no longer
      // waiting on.
      if(mode==='online')db.prepare('DELETE FROM domino_waitlist WHERE lane=? AND bar_id=?').run(lane,id);
      log(db,r,id,'join');return {roomId:r.id};
    }
    // Seating the first/host player at a brand-new room also clears any
    // stale waitlist entry this SAME identity might have left behind from
    // an earlier refused attempt at this lane — they're seated now, not
    // waiting.
    if(mode==='online')db.prepare('DELETE FROM domino_waitlist WHERE lane=? AND bar_id=?').run(lane,id);
    const fresh:Row={id:randomUUID(),mode,lane,host:id,state_json:null,version:0,closed:0,result:''};
    db.prepare('INSERT INTO domino_rooms(id,mode,lane,host) VALUES(?,?,?,?)').run(fresh.id,mode,lane,id);
    db.prepare('INSERT INTO domino_members(room_id,bar_id,seat,seen,active) VALUES(?,?,?,?,1)').run(fresh.id,id,seat,Date.now());
    if(mode==='offline')save(db,fresh,deal(),id,'start');else log(db,fresh,id,'open');
    return {roomId:fresh.id};
  });
  if(outcome instanceof RoomError)throw outcome;
  return outcome;
}
// ---- Waitlist: "通知先前尝试加入的人现在可以加入了" (the user's own
// explicit instruction). Scoped by (lane, bar_id) — never by a specific
// room id — because leaveDomino/expireDomino both close the WHOLE match
// the instant either seat leaves (dominoes has no partial seat release
// the way blackjack/poker do), so by the time a lane is genuinely free
// again the room that was occupying it is already closed and gone; the
// next occupant of that lane gets a brand-new room row. "This lane is
// free" is therefore a fact about the lane, not about any one room
// instance. notifyDominoWaitlist is called from close() above, the exact
// moment a lane's online match actually ends (a leave or a disconnect
// expiry) — every patron who was refused that lane while it was occupied
// gets `notified:1` in their own dominoMe() read from then on, until they
// either successfully sit (cleared above) or give up and leave the
// waitlist some other way (never — a stale notified:1 row is harmless
// and is simply replaced/cleared the next time this same lane cycles). ----
function joinDominoWaitlist(db:Database.Database,lane:number,id:string):void {
  db.prepare('INSERT INTO domino_waitlist(lane,bar_id,created,notified) VALUES(?,?,?,0) ON CONFLICT(lane,bar_id) DO UPDATE SET created=excluded.created,notified=0').run(lane,id,Date.now());
}
function notifyDominoWaitlist(db:Database.Database,lane:number):void {
  db.prepare('UPDATE domino_waitlist SET notified=1 WHERE lane=?').run(lane);
}
export function actDomino(db:Database.Database,id:string,secret:string,roomId:string,version:number,type:string,tile?:Tile,end?:string):void {
  requireBarSession(db,id,secret);
  expireDomino(db);
  transact(db,()=>{
    const r=room(db,roomId),m=member(db,id);if(m?.room_id!==r.id)throw new RoomError('You are not seated here','not_seated',403);
    if(version!==r.version)throw new RoomError('The match changed. Try again.','stale_state',409);
    let s=r.state_json?JSON.parse(r.state_json) as DominoState:null;
    try {
      if(type==='start'||type==='next'){
        if(r.host!==id)throw Error('Only the host can deal');
        if(type==='start'&&s||type==='next'&&s?.phase!=='round_end')throw Error('Cannot deal now');
        if(r.mode==='online'&&(db.prepare('SELECT count(*) AS n FROM domino_members WHERE room_id=? AND active=1').get(r.id) as {n:number}).n!==2)throw Error('Two players are needed');
        s=deal(s??undefined);
      }else {
        if(!s)throw Error('Start the match first');
        if(type==='play')play(s,m.seat,tile!,end!);
        else if(type==='draw')drawOrPass(s,m.seat);
        else throw Error('Unknown domino action');
      }
    }catch(e){throw new RoomError((e as Error).message,'illegal_domino_action',409);}
    save(db,r,s!,id,type);
  });
}
export function leaveDomino(db:Database.Database,id:string,secret:string):void {requireBarSession(db,id,secret);transact(db,()=>{const m=member(db,id);if(m)releaseDominoSeat(db,room(db,m.room_id),id,'A player left.');});}
/** Sets/clears this caller's own display-visible away flag — mirrors
 * poker.ts's setPokerAway exactly, including the same "never bumps the
 * room's own optimistic-concurrency version" reasoning (a presence
 * display change must never race a real in-flight play action over that
 * counter). Unlike leaveDomino, this never releases the seat or touches
 * the match — a merely-away player's chair cannot be taken by anyone
 * else (CLAUDE.md's "away blocks the seat" requirement, same as Vegas's
 * awayMode and poker's own existing away flag already establish), and
 * their opponent's own actDomino actions are completely unaffected. */
export function setDominoAway(db:Database.Database,id:string,secret:string,away:boolean):void {
  requireBarSession(db,id,secret);
  const m=member(db,id);
  if(!m)throw new RoomError('You are not seated at a domino table','not_seated',403);
  db.prepare('UPDATE domino_members SET away=? WHERE room_id=? AND bar_id=?').run(away?1:0,m.room_id,id);
  logAction(db,{action:'domino_away',outcome:'ok',verified:true,actor:{kind:'bar',id},room:{code:m.room_id},detail:{away}});
}
/** Explicitly gives up a pending wait for a specific lane — the
 * counterpart to joinDominoWaitlist, called when a patron walks away
 * from the table rather than sitting once notified. Scoped to this
 * caller's own row only, same ownership shape as every other per-
 * identity row in this module. */
export function leaveDominoWaitlist(db:Database.Database,id:string,secret:string,lane:number):void {
  requireBarSession(db,id,secret);
  db.prepare('DELETE FROM domino_waitlist WHERE lane=? AND bar_id=?').run(lane,id);
}
function profile(db:Database.Database,id:string){return db.prepare('SELECT nickname FROM bar_players WHERE id=?').get(id) as {nickname:string};}
/** This identity's own pending waitlist entries, across all four lanes —
 * `notified:true` once that specific lane has actually freed up since
 * they joined the waitlist (the user's own "通知先前尝试加入的人现在可以
 * 加入了" requirement), cleared the moment they either successfully sit
 * there (openDomino's own cleanup) or sit anywhere else (assertFree's
 * existing "leave your current seat first" rule means they can only ever
 * be waitlisted while NOT seated anywhere, so no separate cleanup is
 * needed there). */
function dominoWaitlistFor(db:Database.Database,id:string){
  return db.prepare('SELECT lane,notified FROM domino_waitlist WHERE bar_id=?').all(id) as {lane:number;notified:number}[];
}
export function dominoMe(db:Database.Database,id:string,secret:string,active=false){
  requireBarSession(db,id,secret);expireDomino(db);const m=member(db,id);
  if(m&&active){db.prepare('UPDATE domino_members SET seen=? WHERE bar_id=? AND active=1').run(Date.now(),id);barHeartbeat(db,id,secret);}
  const waitlist=dominoWaitlistFor(db,id).map(w=>({lane:w.lane,notified:!!w.notified}));
  if(!m)return {room:null,waitlist};
  const r=room(db,m.room_id),s=r.state_json?JSON.parse(r.state_json) as DominoState:null;
  const humans=db.prepare('SELECT * FROM domino_members WHERE room_id=? AND active=1 ORDER BY seat').all(r.id) as Member[];
  const players=[0,1].map(seat=>{const h=humans.find(p=>p.seat===seat);return {id:h?.bar_id??null,nickname:h?profile(db,h.bar_id).nickname:r.mode==='offline'?'Arthur (NPC)':'Empty seat',seat,npc:!h&&r.mode==='offline',away:!!h?.away,count:s?.hands[seat].length??0,score:s?.scores[seat]??0};});
  return {waitlist,room:{id:r.id,mode:r.mode,lane:r.lane,host:r.host,version:r.version,seat:m.seat,players,
    phase:s?.phase??'waiting',round:s?.round??0,turn:s?.turn??null,board:s?.board??[],ends:s?.ends??[],spinner:s?.spinner??null,total:s?endTotal(s):0,
    hand:s?.hands[m.seat]??[],stockCount:s?.stock.length??14,legal:s&&s.turn===m.seat?moves(s):[],target:150,result:s?.result??'Waiting for both players.',winner:s?.winner??null}};
}
export function tickDomino(db:Database.Database):void {
  transact(db,()=>{
    const rows=db.prepare('SELECT * FROM domino_rooms WHERE closed=0').all() as Row[];
    for(const r of rows){
      const humans=db.prepare('SELECT * FROM domino_members WHERE room_id=? AND active=1').all(r.id) as Member[];
      // 2026-11-08 correction: this used to close() the WHOLE room the
      // instant ANY one stale member was found, which (same bug as
      // leaveDomino's own pre-fix version) kicked out a still-present
      // opponent too. Each stale member now only releases their OWN seat
      // (releaseDominoSeat — genuinely closes the room only once nobody
      // active remains), matching exactly how an explicit leaveDomino
      // already behaves after that fix.
      const stale=humans.filter(m=>Date.now()-m.seen>DOMINO_GRACE_MS);
      if(stale.length){
        for(const m of stale){
          const fresh=db.prepare('SELECT * FROM domino_rooms WHERE id=?').get(r.id) as Row;
          if(fresh.closed)break;
          releaseDominoSeat(db,fresh,m.bar_id,'A player was away for three minutes.');
        }
        continue;
      }
      if(r.mode!=='offline'||!r.state_json||!humans.length||Date.now()-humans[0].seen>10000)continue;
      const s=JSON.parse(r.state_json) as DominoState;
      if(s.phase!=='playing'||s.turn===humans[0].seat)continue;
      const move=npcMove(s);if(move)play(s,s.turn,move.tile,move.end);else drawOrPass(s,s.turn);save(db,r,s,null,'npc_turn');
    }
  });
}
