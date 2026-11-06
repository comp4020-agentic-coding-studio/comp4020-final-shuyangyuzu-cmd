import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { requireBarSession,barHeartbeat } from './bar.ts';
import { getActiveSeat } from './tables.ts';
import { RoomError } from './rooms.ts';
import { transact,logAction } from './actionLog.ts';
import { deal,moves,endTotal,play,drawOrPass,npcMove,type DominoState,type Tile } from './dominoEngine.ts';

type Row={id:string;mode:string;lane:number;host:string;state_json:string|null;version:number;closed:number;result:string};
type Member={room_id:string;bar_id:string;seat:number;seen:number};
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
  db.prepare("UPDATE domino_requests SET status='closed' WHERE room_id=? AND status='pending'").run(r.id);log(db,r,id,'close');
}
export function expireDomino(db:Database.Database):void {
  transact(db,()=>{const expired=db.prepare(`SELECT DISTINCT r.* FROM domino_rooms r JOIN domino_members m ON m.room_id=r.id WHERE r.closed=0 AND m.active=1 AND m.seen<=?`).all(Date.now()-DOMINO_GRACE_MS) as Row[];for(const r of expired)close(db,r,null,'A player was away for three minutes.');});
}
export function openDomino(db:Database.Database,id:string,secret:string,mode:string,chair:number):{roomId:string;pending:boolean} {
  requireBarSession(db,id,secret);
  expireDomino(db);
  if(!['online','offline'].includes(mode)||!Number.isInteger(chair)||chair<0||chair>3)throw new RoomError('Choose one of the four domino chairs','bad_request',400);
  return transact(db,()=>{
    const own=member(db,id);if(own){const r=room(db,own.room_id);if(r.mode!==mode||r.lane!==Math.floor(chair/2))throw new RoomError('Leave your current match first','already_seated',409);return {roomId:r.id,pending:false};}
    assertFree(db,id);
    const lane=Math.floor(chair/2),seat=chair%2;
    let r=mode==='online'?db.prepare("SELECT * FROM domino_rooms WHERE mode='online' AND lane=? AND closed=0").get(lane) as Row|undefined:undefined;
    if(r){
      if(r.state_json||db.prepare('SELECT 1 FROM domino_members WHERE room_id=? AND seat=? AND active=1').get(r.id,seat))throw new RoomError('That seat is occupied or the match has started','seat_taken',409);
      const existing=db.prepare('SELECT status FROM domino_requests WHERE room_id=? AND bar_id=?').get(r.id,id) as {status:string}|undefined;
      if(existing?.status==='declined')throw new RoomError('The host declined this request','declined',403);
      db.prepare("INSERT INTO domino_requests VALUES(?,?,'pending',?) ON CONFLICT(room_id,bar_id) DO UPDATE SET created=excluded.created,status='pending'").run(r.id,id,Date.now());
      log(db,r,id,'request_join');return {roomId:r.id,pending:true};
    }
    r={id:randomUUID(),mode,lane,host:id,state_json:null,version:0,closed:0,result:''};
    db.prepare('INSERT INTO domino_rooms(id,mode,lane,host) VALUES(?,?,?,?)').run(r.id,mode,lane,id);
    db.prepare('INSERT INTO domino_members VALUES(?,?,?,?,1)').run(r.id,id,seat,Date.now());
    if(mode==='offline')save(db,r,deal(),id,'start');else log(db,r,id,'open');
    return {roomId:r.id,pending:false};
  });
}
export function respondDomino(db:Database.Database,id:string,secret:string,roomId:string,target:string,accept:boolean):void {
  requireBarSession(db,id,secret);
  expireDomino(db);
  transact(db,()=>{
    const r=room(db,roomId);if(r.host!==id||member(db,id)?.room_id!==roomId)throw new RoomError('Only the host can approve requests','not_host',403);
    const request=db.prepare("SELECT created FROM domino_requests WHERE room_id=? AND bar_id=? AND status='pending'").get(roomId,target) as {created:number}|undefined;
    if(!request||Date.now()-request.created>120000)throw new RoomError('Request expired','request_expired',409);
    if(accept){
      assertFree(db,target);if(r.state_json)throw new RoomError('Match already started','already_started',409);
      const host=member(db,id)!;
      db.prepare('INSERT INTO domino_members VALUES(?,?,?,?,1)').run(roomId,target,1-host.seat,Date.now());
      db.prepare("UPDATE domino_requests SET status='declined' WHERE room_id=? AND status='pending'").run(roomId);
    }
    db.prepare('UPDATE domino_requests SET status=? WHERE room_id=? AND bar_id=?').run(accept?'accepted':'declined',roomId,target);
    db.prepare('UPDATE domino_rooms SET version=version+1 WHERE id=?').run(roomId);log(db,r,id,accept?'approve':'decline');
  });
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
export function leaveDomino(db:Database.Database,id:string,secret:string):void {requireBarSession(db,id,secret);transact(db,()=>{const m=member(db,id);if(m)close(db,room(db,m.room_id),id,'A player left. This match has ended.');db.prepare("UPDATE domino_requests SET status='cancelled' WHERE bar_id=? AND status='pending'").run(id);});}
function profile(db:Database.Database,id:string){return db.prepare('SELECT nickname FROM bar_players WHERE id=?').get(id) as {nickname:string};}
export function dominoMe(db:Database.Database,id:string,secret:string,active=false){
  requireBarSession(db,id,secret);expireDomino(db);const m=member(db,id);
  if(m&&active){db.prepare('UPDATE domino_members SET seen=? WHERE bar_id=? AND active=1').run(Date.now(),id);barHeartbeat(db,id,secret);}
  const requests=db.prepare("SELECT q.room_id,q.status FROM domino_requests q JOIN domino_rooms r ON r.id=q.room_id WHERE q.bar_id=? AND q.created>? AND r.closed=0 ORDER BY q.created DESC").all(id,Date.now()-120000);
  if(!m)return {room:null,requests};
  const r=room(db,m.room_id),s=r.state_json?JSON.parse(r.state_json) as DominoState:null;
  const humans=db.prepare('SELECT * FROM domino_members WHERE room_id=? AND active=1 ORDER BY seat').all(r.id) as Member[];
  const players=[0,1].map(seat=>{const h=humans.find(p=>p.seat===seat);return {id:h?.bar_id??null,nickname:h?profile(db,h.bar_id).nickname:r.mode==='offline'?'Arthur (NPC)':'Empty seat',seat,npc:!h&&r.mode==='offline',count:s?.hands[seat].length??0,score:s?.scores[seat]??0};});
  const pending=r.host===id?db.prepare("SELECT q.bar_id AS id,p.nickname FROM domino_requests q JOIN bar_players p ON p.id=q.bar_id WHERE q.room_id=? AND q.status='pending' AND q.created>?").all(r.id,Date.now()-120000):[];
  return {requests,room:{id:r.id,mode:r.mode,lane:r.lane,host:r.host,version:r.version,seat:m.seat,players,pending,
    phase:s?.phase??'waiting',round:s?.round??0,turn:s?.turn??null,board:s?.board??[],ends:s?.ends??[],spinner:s?.spinner??null,total:s?endTotal(s):0,
    hand:s?.hands[m.seat]??[],stockCount:s?.stock.length??14,legal:s&&s.turn===m.seat?moves(s):[],target:150,result:s?.result??'Waiting for both players.',winner:s?.winner??null}};
}
export function tickDomino(db:Database.Database):void {
  transact(db,()=>{
    const rows=db.prepare('SELECT * FROM domino_rooms WHERE closed=0').all() as Row[];
    for(const r of rows){
      const humans=db.prepare('SELECT * FROM domino_members WHERE room_id=? AND active=1').all(r.id) as Member[];
      if(!humans.length||humans.some(m=>Date.now()-m.seen>DOMINO_GRACE_MS)){close(db,r,null,'A player was away for three minutes.');continue;}
      if(r.mode!=='offline'||!r.state_json||Date.now()-humans[0].seen>10000)continue;
      const s=JSON.parse(r.state_json) as DominoState;
      if(s.phase!=='playing'||s.turn===humans[0].seat)continue;
      const move=npcMove(s);if(move)play(s,s.turn,move.tile,move.end);else drawOrPass(s,s.turn);save(db,r,s,null,'npc_turn');
    }
  });
}
