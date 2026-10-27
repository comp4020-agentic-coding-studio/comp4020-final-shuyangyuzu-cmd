import type Database from 'better-sqlite3';
import { randomUUID, randomInt } from 'node:crypto';
import { requireBarSession, barHeartbeat } from './bar.ts';
import { getActiveSeat } from './tables.ts';
import { RoomError } from './rooms.ts';
import { logAction, transact } from './actionLog.ts';
import { bestHand, handNames, leavePokerHand, newPokerPlayer, newPokerState, pokerAction, startPokerHand, type PokerState } from './pokerEngine.ts';

interface Row { id:string; mode:'online'|'offline'; table_id:string; host:string; state_json:string; version:number; closed:number }
const DISCONNECT_GRACE_MS = 180000;
function auth(db:Database.Database,id:string,secret:string){requireBarSession(db,id,secret);}
function getRoom(db:Database.Database,id:string):Row {
  const r=db.prepare('SELECT * FROM poker_rooms WHERE id=?').get(id) as Row|undefined;
  if(!r||r.closed)throw new RoomError('This poker table has closed','poker_closed',410);return r;
}
function state(r:Row):PokerState{return JSON.parse(r.state_json);}
function save(db:Database.Database,r:Row,s:PokerState,actor:string|null,action:string,subject?:string):void {
  // Zero chips while all-in is legitimate. Only a completely settled
  // hand can eliminate a human, after main/side pots and refunds.
  if(s.phase==='showdown'){
    for(const p of s.players){
      if(p.id.startsWith('npc:')||p.stack!==0||membership(db,p.id)?.room_id!==r.id)continue;
      p.leaving=true;
      db.prepare('UPDATE poker_members SET active=0 WHERE room_id=? AND bar_id=?').run(r.id,p.id);
      db.prepare('INSERT OR REPLACE INTO poker_notices VALUES(?,?,?,?,?)').run(p.id,randomUUID(),r.id,s.hand,s.result);
      logAction(db,{action:'poker_bankrupt',outcome:'ok',verified:false,actor:null,room:{code:r.id},detail:{playerId:p.id.slice(0,8),hand:s.hand}});
    }
    const remaining=db.prepare('SELECT bar_id FROM poker_members WHERE room_id=? AND active=1 ORDER BY seat').all(r.id) as {bar_id:string}[];
    if(!remaining.length){
      db.prepare('UPDATE poker_rooms SET closed=1 WHERE id=?').run(r.id);
      db.prepare("UPDATE poker_invites SET status='closed' WHERE room_id=? AND status='pending'").run(r.id);
    }else if(!remaining.some(p=>p.bar_id===r.host))r.host=remaining[0].bar_id;
  }
  db.prepare('UPDATE poker_rooms SET state_json=?,host=?,version=version+1 WHERE id=?').run(JSON.stringify(s),r.host,r.id);
  for(const p of s.players)if(!p.id.startsWith('npc:'))db.prepare('INSERT INTO poker_wallets VALUES(?,?,?) ON CONFLICT(room_id,bar_id) DO UPDATE SET stack=excluded.stack').run(r.id,p.id,p.stack);
  db.prepare('INSERT INTO poker_events(room_id,version,actor,action,at) VALUES(?,?,?,?,?)').run(r.id,r.version+1,actor,action,Date.now());
  logAction(db,{action:`poker_${action}`,outcome:'ok',verified:actor!==null,actor:actor?{kind:'bar',id:actor}:null,room:{code:r.id},detail:{hand:s.hand,phase:s.phase,actingPlayer:subject??actor??'server',result:s.phase==='showdown'?s.result:null}});
}
function membership(db:Database.Database,id:string){return db.prepare('SELECT room_id,seat FROM poker_members WHERE bar_id=? AND active=1').get(id) as {room_id:string;seat:number}|undefined;}
function ensureFree(db:Database.Database,id:string,roomId?:string):void {
  if(db.prepare('SELECT 1 FROM poker_notices WHERE bar_id=?').get(id))throw new RoomError('Acknowledge your out-of-chips message before joining another poker table','bankruptcy_pending',409);
  const seat=membership(db,id);
  if(seat&&seat.room_id!==roomId)throw new RoomError('Leave your current poker table first','already_seated',409);
  if(getActiveSeat(db,id))throw new RoomError('Exit your current Vegas game before joining poker','already_seated',409);
  if(db.prepare('SELECT 1 FROM bar_seats WHERE occupied_by=?').get(id))throw new RoomError('Stand up before joining poker','already_seated',409);
}
function seated(db:Database.Database,r:Row,id:string):void {
  if(membership(db,id)?.room_id!==r.id)throw new RoomError('You are not seated at this poker table','not_seated',403);
}
function addHuman(db:Database.Database,r:Row,s:PokerState,id:string,preferred?:number):void {
  ensureFree(db,id,r.id);
  let existing=s.players.find(p=>p.id===id);
  if(existing?.stack===0&&(s.phase==='waiting'||s.phase==='showdown')){
    s.players=s.players.filter(p=>p.id!==id);existing=undefined;
  }
  if(existing){existing.leaving=false;}
  else {
    const seats=new Set(s.players.filter(p=>!p.leaving||s.phase!=='waiting'&&s.phase!=='showdown').map(p=>p.seat));
    const seat=typeof preferred==='number'&&Number.isInteger(preferred)&&preferred>=0&&preferred<5&&!seats.has(preferred)?preferred:[0,1,2,3,4].find(n=>!seats.has(n));
    if(seat===undefined)throw new RoomError('This table has five occupied seats; try after the current hand','table_full',409);
    const profile=db.prepare('SELECT nickname FROM bar_players WHERE id=?').get(id) as {nickname:string};
    const wallet=db.prepare('SELECT stack FROM poker_wallets WHERE room_id=? AND bar_id=?').get(r.id,id) as {stack:number}|undefined;
    s.players.push(newPokerPlayer(id,profile.nickname,seat,wallet?.stack===0?500:wallet?.stack??500));
  }
  const p=s.players.find(p=>p.id===id)!;
  db.prepare('INSERT INTO poker_members(room_id,bar_id,seat,active) VALUES(?,?,?,1) ON CONFLICT(room_id,bar_id) DO UPDATE SET active=1,seat=excluded.seat').run(r.id,id,p.seat);
  db.prepare('INSERT INTO poker_presence VALUES(?,?) ON CONFLICT(bar_id) DO UPDATE SET seen=excluded.seen').run(id,Date.now());
}
export function openPoker(db:Database.Database,id:string,secret:string,mode:string,preferred?:number):string {
  auth(db,id,secret);if(!['online','offline'].includes(mode))throw new RoomError('Unknown poker mode','bad_request',400);
  return transact(db,()=>{
    const old=membership(db,id);if(old)return old.room_id;
    ensureFree(db,id);
    let r=mode==='online'?db.prepare("SELECT * FROM poker_rooms WHERE mode='online' AND closed=0 AND table_id='texas-1'").get() as Row|undefined:undefined;
    if(r)throw new RoomError('This private table is occupied. Ask a seated friend for an invitation','invite_required',403);
    r={id:randomUUID(),mode:mode as Row['mode'],table_id:mode==='online'?'texas-1':'texas-npc-1',host:id,state_json:JSON.stringify(newPokerState()),version:0,closed:0};
    db.prepare('INSERT INTO poker_rooms(id,mode,table_id,host,state_json) VALUES(?,?,?,?,?)').run(r.id,r.mode,r.table_id,id,r.state_json);
    const s=state(r);addHuman(db,r,s,id,preferred);
    if(mode==='offline'){
      let n=0;for(let seat=0;seat<5;seat++)if(seat!==s.players[0].seat){s.players.push(newPokerPlayer(`npc:${n}`,['Morgan','Charles','Sadie','John'][n],seat));n++;}
      startPokerHand(s);
    }
    save(db,r,s,id,'open');return r.id;
  });
}
export function leavePoker(db:Database.Database,id:string,secret:string):void {
  auth(db,id,secret);
  transact(db,()=>{
    const m=membership(db,id);if(!m)return;const r=getRoom(db,m.room_id),s=state(r);
    leavePokerHand(s,id);db.prepare('UPDATE poker_members SET active=0 WHERE room_id=? AND bar_id=?').run(r.id,id);
    const remaining=db.prepare('SELECT bar_id FROM poker_members WHERE room_id=? AND active=1 ORDER BY seat').all(r.id) as {bar_id:string}[];
    if(!remaining.length){db.prepare('UPDATE poker_rooms SET closed=1 WHERE id=?').run(r.id);db.prepare("UPDATE poker_invites SET status='closed' WHERE room_id=? AND status='pending'").run(r.id);}
    else if(r.host===id)r.host=remaining[0].bar_id;
    save(db,r,s,id,'leave');
  });
}
export function actPoker(db:Database.Database,id:string,secret:string,roomId:string,version:number,type:string,to?:number):void {
  auth(db,id,secret);
  if(membership(db,id)?.room_id===roomId)reconcileBankruptcy(db,roomId);
  transact(db,()=>{
    const r=getRoom(db,roomId);seated(db,r,id);if(version!==r.version)throw new RoomError('The table changed. Try your action again','stale_state',409);
    const s=state(r);
    try {
      if(type==='deal'){
        if(r.host!==id)throw Error('Only the host can deal the next hand');
        for(const p of s.players)if(p.id.startsWith('npc:')&&p.stack===0)p.stack=500;
        startPokerHand(s);
      }else pokerAction(s,id,type,to);
    }catch(e){throw new RoomError((e as Error).message,'illegal_poker_action',409);}
    save(db,r,s,id,type);
  });
}
export function pokerView(db:Database.Database,id:string,roomId:string){
  const r=getRoom(db,roomId);seated(db,r,id);const s=state(r);
  // Display-only (phase 7, CLAUDE.md): away is a pure badge for other
  // seated players, not a real standby concept — tickPoker's own
  // 45-second action timeout and the disconnect-triggered fold/removal
  // at DISCONNECT_GRACE_MS are completely unaffected by it, unlike
  // Vegas's awayMode which actually redirects turn-taking.
  const awaySeats=new Set((db.prepare('SELECT bar_id FROM poker_members WHERE room_id=? AND active=1 AND away=1').all(r.id) as {bar_id:string}[]).map(x=>x.bar_id));
  return {id:r.id,mode:r.mode,host:r.host,version:r.version,hand:s.hand,dealer:s.dealer,actor:s.actor,phase:s.phase,board:s.board,currentBet:s.currentBet,minRaise:s.minRaise,pot:s.players.reduce((n,p)=>n+p.committed,0),result:s.result,payouts:s.payouts,
    players:s.players.map(p=>({id:p.id,nickname:p.nickname,seat:p.seat,stack:p.stack,bet:p.bet,folded:p.folded,waiting:p.waiting,leaving:p.leaving,npc:p.id.startsWith('npc:'),away:awaySeats.has(p.id),
      hole:p.id===id||s.phase==='showdown'&&!p.folded&&!p.waiting&&s.board.length===5?p.hole:[],
      handName:s.phase==='showdown'&&!p.folded&&!p.waiting&&s.board.length===5?handNames[bestHand([...p.hole,...s.board])[0]]:null,
      canRaise:p.actedAt===null||s.currentBet-p.actedAt>=s.minRaise}))};
}
/** Sets/clears this caller's own display-only away flag — ownership
 * checked the same way every other poker action already checks it
 * (membership + seated), never another player's row. A no-op resume (an
 * ordinary return to the table) clears it, mirroring how Vegas's own
 * away-choice is cleared only by an explicit action, never a passive
 * signal — but here there is no reversible standby to undo, just a
 * display flag. */
export function setPokerAway(db:Database.Database,id:string,secret:string,away:boolean):void {
  auth(db,id,secret);
  transact(db,()=>{
    const m=membership(db,id);
    if(!m)throw new RoomError('You are not seated at a poker table','not_seated',403);
    db.prepare('UPDATE poker_members SET away=? WHERE room_id=? AND bar_id=?').run(away?1:0,m.room_id,id);
    // Deliberately does NOT bump poker_rooms.version: that column is also
    // actPoker's own optimistic-concurrency counter (its stale_state
    // check), and a presence/display-only change must never race a real
    // in-flight action over the same counter — CLAUDE.md already
    // documents this exact mistake for Vegas's own rev/seq vs `version`
    // split. The client instead redraws on its own away-flag signature,
    // independent of version (public/poker.js's draw() gate) — the same
    // shape as Vegas keeping a presence-only rev separate from version,
    // just without a dedicated server-side counter since polling (not
    // SSE) means there's no stale-arrival ordering problem to solve here.
    logAction(db,{action:'poker_away',outcome:'ok',verified:true,actor:{kind:'bar',id},room:{code:m.room_id},detail:{away}});
  });
}
export function pokerMe(db:Database.Database,id:string,secret:string){
  auth(db,id,secret);barHeartbeat(db,id,secret);
  db.prepare('INSERT INTO poker_presence VALUES(?,?) ON CONFLICT(bar_id) DO UPDATE SET seen=excluded.seen').run(id,Date.now());
  let m=membership(db,id);
  if(m){reconcileBankruptcy(db,m.room_id);m=membership(db,id);}
  const invites=db.prepare(`SELECT i.id,i.room_id AS roomId,b.nickname AS sender,i.expires FROM poker_invites i JOIN bar_players b ON b.id=i.sender JOIN poker_rooms r ON r.id=i.room_id WHERE i.target=? AND i.status='pending' AND i.expires>? AND r.closed=0 ORDER BY i.expires DESC LIMIT 5`).all(id,Date.now());
  const notice=db.prepare('SELECT notice_id AS id,room_id AS roomId,hand,result FROM poker_notices WHERE bar_id=?').get(id) as {id:string;roomId:string;hand:number;result:string}|undefined;
  return {room:m?pokerView(db,id,m.room_id):null,invites,departure:notice?{...notice,reason:'bankrupt' as const}:null};
}
export function acknowledgePokerExit(db:Database.Database,id:string,secret:string,noticeId:string):void {
  auth(db,id,secret);
  transact(db,()=>{
    const notice=db.prepare('SELECT room_id FROM poker_notices WHERE bar_id=? AND notice_id=?').get(id,noticeId) as {room_id:string}|undefined;
    if(!notice)return;
    db.prepare('DELETE FROM poker_notices WHERE bar_id=? AND notice_id=?').run(id,noticeId);
    logAction(db,{action:'poker_bankruptcy_ack',outcome:'ok',verified:true,actor:{kind:'bar',id},room:{code:notice.room_id}});
  });
}
// Covers old deployments/restarts which already have a settled zero-stack
// player. Reads/ticks converge through the same atomic save as actions.
function reconcileBankruptcy(db:Database.Database,roomId:string):void {
  const r=getRoom(db,roomId),s=state(r);
  if(s.phase==='showdown'&&s.players.some(p=>!p.id.startsWith('npc:')&&p.stack===0&&membership(db,p.id)?.room_id===r.id)){
    transact(db,()=>save(db,r,s,null,'bankruptcy_reconcile'));
  }
}
export function searchPokerFriends(db:Database.Database,id:string,secret:string,query:string){
  auth(db,id,secret);if(query.length<1||query.length>40)return [];
  return db.prepare(`SELECT b.id,b.nickname FROM bar_players b JOIN poker_presence p ON p.bar_id=b.id WHERE b.id!=? AND p.seen>? AND instr(lower(b.nickname),lower(?))>0 ORDER BY b.nickname,b.id LIMIT 12`).all(id,Date.now()-15000,query);
}
export function invitePoker(db:Database.Database,id:string,secret:string,roomId:string,target:string):void {
  auth(db,id,secret);
  transact(db,()=>{
    const r=getRoom(db,roomId);seated(db,r,id);if(r.mode!=='online')throw new RoomError('Offline games do not accept invitations','offline_game',409);
    if(id===target)throw new RoomError('Choose another player','bad_request',400);
    if(membership(db,target)?.room_id===r.id)throw new RoomError('That player is already at your poker table','already_seated',409);
    if(!db.prepare('SELECT 1 FROM poker_presence WHERE bar_id=? AND seen>?').get(target,Date.now()-15000))throw new RoomError('That player is offline','player_offline',409);
    const recent=db.prepare('SELECT count(*) AS n FROM poker_invites WHERE sender=? AND expires>?').get(id,Date.now()+50000) as {n:number};
    if(recent.n>=5)throw new RoomError('Please wait before sending more invitations','rate_limited',429);
    if(db.prepare("SELECT 1 FROM poker_invites WHERE room_id=? AND target=? AND status='pending' AND expires>?").get(r.id,target,Date.now()))return;
    db.prepare('INSERT INTO poker_invites VALUES(?,?,?,?,?,?)').run(randomUUID(),r.id,id,target,Date.now()+60000,'pending');
    save(db,r,state(r),id,'invite');
  });
}
export function respondPoker(db:Database.Database,id:string,secret:string,inviteId:string,join:boolean):string|null {
  auth(db,id,secret);
  return transact(db,()=>{
    const invite=db.prepare('SELECT * FROM poker_invites WHERE id=? AND target=?').get(inviteId,id) as {room_id:string;expires:number;status:string}|undefined;
    if(!invite||invite.expires<Date.now()||invite.status!=='pending')throw new RoomError('This invitation has expired or was already handled','invite_expired',410);
    const r=getRoom(db,invite.room_id),s=state(r);
    if(join)addHuman(db,r,s,id);
    db.prepare('UPDATE poker_invites SET status=? WHERE id=?').run(join?'accepted':'declined',inviteId);
    save(db,r,s,id,join?'join':'decline');return join?r.id:null;
  });
}
export function tickPoker(db:Database.Database):void {
  const now=Date.now();
  const rows=db.prepare('SELECT * FROM poker_rooms WHERE closed=0').all() as Row[];
  for(const row of rows){
    reconcileBankruptcy(db,row.id);
    const members=db.prepare('SELECT m.bar_id,p.seen FROM poker_members m LEFT JOIN poker_presence p ON p.bar_id=m.bar_id WHERE m.room_id=? AND m.active=1').all(row.id) as {bar_id:string;seen:number|null}[];
    for(const m of members)if(!m.seen||now-m.seen>DISCONNECT_GRACE_MS){
      // Stored session is used only for this server-owned expiry action.
      const key=db.prepare('SELECT session_secret FROM bar_sessions WHERE player_id=?').get(m.bar_id) as {session_secret:string}|undefined;
      if(key)leavePoker(db,m.bar_id,key.session_secret);
    }
    const r=db.prepare('SELECT * FROM poker_rooms WHERE id=? AND closed=0').get(row.id) as Row|undefined;if(!r)continue;
    const s=state(r),actor=s.players.find(p=>p.id===s.actor);
    if(!actor||now-s.actedAt<800)continue;
    const npc=actor.id.startsWith('npc:');
    if(!npc&&now-s.actedAt<45000)continue;
    transact(db,()=>{
      const owed=s.currentBet-actor.bet;
      // NPC uses only its own hole cards, public board and public bets.
      const strong=s.board.length>=3?bestHand([...actor.hole,...s.board])[0]>=1:actor.hole[0]?.[0]===actor.hole[1]?.[0]||actor.hole.some(c=>'AKQ'.includes(c[0]));
      const mayRaise=actor.actedAt===null||s.currentBet-actor.actedAt>=s.minRaise;
      const raise=npc&&strong&&mayRaise&&actor.stack>owed+s.minRaise&&randomInt(5)===0;
      const type=raise?'raise':owed===0?'check':npc&&(strong||owed<=Math.max(2,actor.stack/6)||randomInt(5)===0)?'call':'fold';
      pokerAction(s,actor.id,type,raise?s.currentBet+s.minRaise:undefined);save(db,r,s,null,npc?'npc_turn':'turn_timeout',actor.nickname);
    });
  }
}
