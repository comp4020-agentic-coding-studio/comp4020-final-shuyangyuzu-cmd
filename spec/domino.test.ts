import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type Database from 'better-sqlite3';
import {openDb} from '../src/db.ts';
import {joinBar,moveBar,sitAtSeat,standFromSeat} from '../src/bar.ts';
import {GAME_CHAIRS,BAR_SEATS} from '../src/barLayout.ts';
import {deal,deck,moves,play,drawOrPass,endTotal,npcMove,type DominoState,type Tile} from '../src/dominoEngine.ts';
import {openDomino,actDomino,dominoMe,leaveDomino,leaveDominoWaitlist,setDominoAway,tickDomino} from '../src/domino.ts';
import {layoutBones} from '../public/domino.js';
import {getTablesStatus} from '../src/tables.ts';
import {placeOrder,startEating} from '../src/orders.ts';
import {isEating} from '../src/eating.ts';

describe('All Fives rules',()=>{
  it('deals seven each, fourteen hidden, with the highest double opening',()=>{const s=deal(undefined,deck());expect(s.hands.map(h=>h.length)).toEqual([7,7]);expect(s.stock).toHaveLength(14);expect(s.turn).toBe(1);expect(s.required).toEqual([2,2]);expect(moves(s)).toEqual([{tile:[2,2],end:'start'}]);});
  function position():DominoState {const s=deal();s.board=[];s.ends=[];s.spinner=null;s.required=null;s.turn=0;s.hands=[[[5,5],[1,2],[0,0]],[[0,5],[2,5],[3,5]]];s.stock=[];s.scores=[0,0];return s;}
  it('counts an opening double once, then unlocks two spinner arms only after both primary sides',()=>{
    const s=position();play(s,0,[5,5],'start');expect(endTotal(s)).toBe(10);expect(s.scores[0]).toBe(10);
    play(s,1,[0,5],'5-5:left');expect(endTotal(s)).toBe(10);expect(s.ends).toHaveLength(2);
    s.hands[0].push([2,5]);play(s,0,[2,5],'5-5:right');expect(s.spinner?.unlocked).toBe(true);expect(s.ends).toHaveLength(4);expect(endTotal(s)).toBe(2);
    play(s,1,[3,5],'5-5:top');expect(endTotal(s)).toBe(5);expect(s.scores[1]).toBe(15);
  });
  it('renders the reported chain with matching halves and rejects a spent interior port',()=>{
    const s=position();
    s.hands=[[[4,4],[1,6],[3,4],[0,0]],[[1,4],[2,4],[3,6]]];
    play(s,0,[4,4],'start');play(s,1,[1,4],'4-4:left');play(s,0,[1,6],'1-4:out');
    const positions=layoutBones(s.board);
    expect([...positions.values()].sort((a,b)=>a.x-b.x).map(p=>p.face)).toEqual([[6,1],[1,4],[4,4]]);
    expect(()=>play(s,1,[2,4],'1-4:out')).toThrow();
    play(s,1,[2,4],'4-4:right');
    play(s,0,[3,4],'4-4:top');
    const top=layoutBones(s.board).get('3-4');
    expect(top.dy).toBe(-1);
    expect(top.face).toEqual([3,4]);
  });
  it('refuses illegal turn, tile, and drawing when a move exists',()=>{const s=position();expect(()=>play(s,1,[0,5],'start')).toThrow();expect(()=>play(s,0,[6,6],'start')).toThrow();expect(()=>drawOrPass(s,0)).toThrow();});
  it('scores a round and carries the score into the next alternating deal',()=>{const s=position();s.hands[0]=[[1,2]];s.hands[1]=[[2,3]];play(s,0,[1,2],'start');expect(s.phase).toBe('round_end');expect(s.scores[0]).toBe(5);const n=deal(s);expect(n.scores).toEqual(s.scores);expect(n.starter).toBe(1-s.starter);expect(n.required).toBeNull();});
  it('finishes immediately at 150 without revealing or playing the opponent hand',()=>{const s=position();s.scores[0]=140;play(s,0,[5,5],'start');expect(s.phase).toBe('finished');expect(s.winner).toBe(0);});
  it('blocks on two passes, awards rounded difference, and handles a tied block',()=>{const s=position();s.board=[{id:'6-6',tile:[6,6],parent:null,port:'start'}];s.ends=[{key:'end',pip:6,score:12,bone:'6-6'}];s.hands=[[[0,0]],[[2,3]]];drawOrPass(s,0);drawOrPass(s,1);expect(s.phase).toBe('round_end');expect(s.scores).toEqual([5,0]);const t=position();t.board=s.board;t.ends=s.ends;t.hands=[[[0,1]],[[0,1]]];drawOrPass(t,0);drawOrPass(t,1);expect(t.winner).toBeNull();});
  it('NPC choice does not change when unseen tiles change',()=>{const a=position(),b=structuredClone(a);b.hands[1]=[[6,6]];b.stock=[[4,4],[2,2]];expect(npcMove(a)).toEqual(npcMove(b));});
  it('twenty complete simulated matches conserve tiles and terminate at the target',()=>{
    for(let n=0;n<20;n++){let s=deal(),actions=0;while(s.phase!=='finished'&&actions++<5000){
      if(s.phase==='round_end'){s=deal(s);continue;}const move=npcMove(s);if(move)play(s,s.turn,move.tile,move.end);else drawOrPass(s,s.turn);
      const all=[...s.hands.flat(),...s.stock,...s.board.map(b=>b.tile)];expect(all).toHaveLength(28);expect(new Set(all.map(t=>t.join('-'))).size).toBe(28);
    }expect(s.phase).toBe('finished');expect(Math.max(...s.scores)).toBeGreaterThanOrEqual(150);}
  });
});

describe('two isolated facing pairs',()=>{
  let db:Database.Database,dir:string;
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'domino-test-'));db=openDb(join(dir,'test.db'));});
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const patron=(name:string)=>joinBar(db,name,'red','warm');
  it('has exactly four chairs per domino table, two opposing pairs',()=>{for(const id of ['dominoes-1','dominoes-npc-1']){const c=GAME_CHAIRS.filter(c=>c.tableId===id);expect(c).toHaveLength(4);expect(c[0].y).toBe(c[1].y);expect(c[2].y).toBe(c[3].y);expect(c[0].x).not.toBe(c[1].x);}});
  it('runs two online matches on one fixture with no approval step, seating opposite immediately',()=>{
    const a=patron('A'),b=patron('B'),c=patron('C'),d=patron('D');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0),r2=openDomino(db,c.playerId,c.sessionSecret,'online',2);
    expect(r1.roomId).not.toBe(r2.roomId);
    // 2026-11-07 correction (user's own explicit instruction): sitting at
    // the empty facing seat joins and seats immediately — no approval
    // step, no pending state.
    expect(openDomino(db,b.playerId,b.sessionSecret,'online',1).roomId).toBe(r1.roomId);
    expect(openDomino(db,d.playerId,d.sessionSecret,'online',3).roomId).toBe(r2.roomId);
    const view=dominoMe(db,a.playerId,a.sessionSecret).room!;
    actDomino(db,a.playerId,a.sessionSecret,r1.roomId,view.version,'start');
    expect(dominoMe(db,c.playerId,c.sessionSecret).room!.phase).toBe('waiting');
    expect(()=>actDomino(db,c.playerId,c.sessionSecret,r1.roomId,view.version,'start')).toThrow(/not seated/);
    expect(getTablesStatus(db).find(t=>t.id==='dominoes-1')!.playerCount).toBe(4);
    // 2026-11-08 correction (user's own explicit instruction, confirmed
    // via AskUserQuestion): A explicitly leaving now only releases A's
    // OWN seat and ends the current match's state — B stays SEATED,
    // waiting for a new opponent — rather than closing the whole room
    // and kicking B out too (the previous behavior this test used to
    // pin down). Confirmed directly: B's own room view survives.
    leaveDomino(db,a.playerId,a.sessionSecret);
    const bMe=dominoMe(db,b.playerId,b.sessionSecret);
    expect(bMe.room).not.toBeNull();
    expect(bMe.room!.id).toBe(r1.roomId);
    expect(bMe.room!.phase).toBe('waiting'); // the old match's state is cleared, not carried over to whoever sits next
    expect(dominoMe(db,c.playerId,c.sessionSecret).room).not.toBeNull();
  });
  it('a departing player releases only their own seat; a substitute pairs with the remaining player and the OLD match correctly ends, leaving the other pair untouched',()=>{
    // The user's own explicit substitute scenario: A vs B playing, B
    // leaves, A stays seated, C sits opposite A and a brand-new match is
    // dealt for A+C once the host (A) deals — the OLD A-vs-B match must
    // be genuinely over (no stale board/hand carried forward), and a
    // completely separate pair (D vs E) at the other lane must be
    // entirely unaffected throughout.
    const a=patron('A'),b=patron('B'),c=patron('C'),d=patron('D'),e=patron('E');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0);
    openDomino(db,b.playerId,b.sessionSecret,'online',1);
    const r2=openDomino(db,d.playerId,d.sessionSecret,'online',2);
    openDomino(db,e.playerId,e.sessionSecret,'online',3);
    let view=dominoMe(db,a.playerId,a.sessionSecret).room!;
    actDomino(db,a.playerId,a.sessionSecret,r1.roomId,view.version,'start'); // the OLD A-vs-B match is actually dealt
    expect(dominoMe(db,a.playerId,a.sessionSecret).room!.phase).toBe('playing');

    leaveDomino(db,b.playerId,b.sessionSecret); // B exits
    let aMe=dominoMe(db,a.playerId,a.sessionSecret);
    expect(aMe.room).not.toBeNull(); // A remains seated, not kicked out
    expect(aMe.room!.phase).toBe('waiting'); // the OLD match genuinely ended (no stale board/hand)
    expect(aMe.room!.board).toEqual([]);

    const r3=openDomino(db,c.playerId,c.sessionSecret,'online',1); // C sits opposite A
    expect(r3.roomId).toBe(r1.roomId); // same physical lane/room, a fresh pairing
    let cMe=dominoMe(db,c.playerId,c.sessionSecret);
    expect(cMe.room!.players.map(p=>p.id).sort()).toEqual([a.playerId,c.playerId].sort());

    view=dominoMe(db,a.playerId,a.sessionSecret).room!;
    actDomino(db,a.playerId,a.sessionSecret,r1.roomId,view.version,'start'); // host deals the NEW A-vs-C match
    expect(dominoMe(db,c.playerId,c.sessionSecret).room!.phase).toBe('playing');

    // The entirely separate D-vs-E pair at the other lane was never
    // touched by any of this churn.
    const dMe=dominoMe(db,d.playerId,d.sessionSecret);
    expect(dMe.room!.id).toBe(r2.roomId);
    expect(dMe.room!.players.map(p=>p.id).sort()).toEqual([d.playerId,e.playerId].sort());
  });
  it('a merely-away (not exited) player keeps their seat; nobody else can take it, and they return to the same match',()=>{
    const a=patron('A'),b=patron('B'),c=patron('C');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0);
    openDomino(db,b.playerId,b.sessionSecret,'online',1);
    setDominoAway(db,b.playerId,b.sessionSecret,true);
    expect(dominoMe(db,a.playerId,a.sessionSecret).room!.players.find(p=>p.id===b.playerId)?.away).toBe(true);
    // C cannot take B's seat while B is merely away, not exited.
    expect(()=>openDomino(db,c.playerId,c.sessionSecret,'online',1)).toThrow(/occupied|started/);
    // B returns — flag clears, same match/seat resumed.
    setDominoAway(db,b.playerId,b.sessionSecret,false);
    const bMe=dominoMe(db,b.playerId,b.sessionSecret);
    expect(bMe.room!.id).toBe(r1.roomId);
    expect(bMe.room!.players.find(p=>p.id===b.playerId)?.away).toBe(false);
  });
  it('waitlists a patron refused a taken/started seat and notifies them the moment that lane frees up',()=>{
    const a=patron('A'),b=patron('B'),e=patron('E');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0);
    openDomino(db,b.playerId,b.sessionSecret,'online',1);
    // The pair is now full and already playing (both seated) — a third
    // patron targeting either chair of this same lane is refused, not
    // silently queued without their knowledge, and lands on the waitlist.
    expect(()=>openDomino(db,e.playerId,e.sessionSecret,'online',0)).toThrow(/occupied|started/);
    let me=dominoMe(db,e.playerId,e.sessionSecret);
    expect(me.room).toBeNull();
    expect(me.waitlist).toEqual([{lane:0,notified:false}]);
    // The lane is still occupied — nothing notifies yet.
    leaveDomino(db,a.playerId,a.sessionSecret); // 2026-11-08: releases only A's own seat — B stays seated at r1
    leaveDomino(db,b.playerId,b.sessionSecret); // B also leaves — both seats now empty, so the room genuinely closes
    me=dominoMe(db,e.playerId,e.sessionSecret);
    expect(me.waitlist).toEqual([{lane:0,notified:true}]);
    // Once notified, the waitlisted patron can now actually sit — in a
    // brand-NEW room, since both original occupants are genuinely gone
    // and r1 itself closed (a fresh room is created the same way the
    // very first seating at an empty lane always creates one).
    const r=openDomino(db,e.playerId,e.sessionSecret,'online',0);
    expect(r.roomId).not.toBe(r1.roomId);
    expect(dominoMe(db,e.playerId,e.sessionSecret).waitlist).toEqual([]);
  });
  it('lets a waitlisted patron explicitly give up waiting',()=>{
    const a=patron('A'),b=patron('B'),e=patron('E');
    openDomino(db,a.playerId,a.sessionSecret,'online',0);
    openDomino(db,b.playerId,b.sessionSecret,'online',1);
    expect(()=>openDomino(db,e.playerId,e.sessionSecret,'online',0)).toThrow();
    expect(dominoMe(db,e.playerId,e.sessionSecret).waitlist).toHaveLength(1);
    leaveDominoWaitlist(db,e.playerId,e.sessionSecret,0);
    expect(dominoMe(db,e.playerId,e.sessionSecret).waitlist).toEqual([]);
  });
  it('isolates private NPC games, redacts hidden hands, rejects stale mutations, and advances NPC turns',()=>{
    const a=patron('A'),b=patron('B');openDomino(db,a.playerId,a.sessionSecret,'offline',0);openDomino(db,b.playerId,b.sessionSecret,'offline',0);
    let v=dominoMe(db,a.playerId,a.sessionSecret,true).room!;expect(v.id).not.toBe(dominoMe(db,b.playerId,b.sessionSecret).room!.id);
    expect(v.hand).toHaveLength(7);expect(v).not.toHaveProperty('stock');expect(v.players[1]).not.toHaveProperty('hand');
    expect(getTablesStatus(db).find(t=>t.id==='dominoes-npc-1')!.playerCount).toBe(0);
    expect(()=>actDomino(db,a.playerId,a.sessionSecret,v.id,-1,'draw')).toThrow(/changed/);
    for(let i=0;i<50&&v.phase==='playing';i++){
      if(v.turn===v.seat){const move=v.legal[0];actDomino(db,a.playerId,a.sessionSecret,v.id,v.version,move?'play':'draw',move?.tile,move?.end);}else tickDomino(db);
      v=dominoMe(db,a.playerId,a.sessionSecret,true).room!;
    }expect(v.board.length).toBeGreaterThan(2);
  });
  it('persists on database reopen and releases expired seats without closing the other pair',()=>{
    const a=patron('A'),b=patron('B');const r=openDomino(db,a.playerId,a.sessionSecret,'offline',0);openDomino(db,b.playerId,b.sessionSecret,'online',2);
    const before=dominoMe(db,a.playerId,a.sessionSecret).room;db.close();db=openDb(join(dir,'test.db'));expect(dominoMe(db,a.playerId,a.sessionSecret).room).toEqual(before);
    db.prepare('UPDATE domino_members SET seen=? WHERE room_id=?').run(Date.now()-180001,r.roomId);tickDomino(db);
    expect(dominoMe(db,a.playerId,a.sessionSecret).room).toBeNull();expect(dominoMe(db,b.playerId,b.sessionSecret).room).not.toBeNull();
  });
  it('requires identity and blocks leaving the table by walking',()=>{const a=patron('A');expect(()=>openDomino(db,a.playerId,'wrong','offline',0)).toThrow();openDomino(db,a.playerId,a.sessionSecret,'offline',0);expect(()=>moveBar(db,a.playerId,a.sessionSecret,1,1)).toThrow(/domino/);});
});

// ---- Integration verification: dominoes merged alongside seated eating
// (2026-11-04 integration round). Both features were built on separate
// branches without seeing each other's code; this confirms the two
// actually-merged guards (domino.ts's assertFree optional-schema check
// against bar_eating_actions, and bar.ts's domino_members check in
// sitAtSeat) behave correctly together, not just that the merge was
// textually clean. ----
describe('dominoes and seated eating, merged on one identity layer',()=>{
  let db:Database.Database,dir:string;
  beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'domino-eating-test-'));db=openDb(join(dir,'test.db'));});
  afterEach(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const patron=(name:string)=>joinBar(db,name,'red','warm');
  function seatAndStartEating(id:string,secret:string):void {
    const seat=BAR_SEATS[0];
    db.prepare('UPDATE bar_players SET x = ?, y = ? WHERE id = ?').run(seat.x,seat.y+1,id);
    sitAtSeat(db,id,secret,seat.id);
    placeOrder(db,id,secret,'soda',null,'eat-vs-domino-key');
    startEating(db,id,secret,'eat-vs-domino-key');
  }

  it('cannot open a domino seat while an eating/drinking lock is active, and can once it ends',()=>{
    const a=patron('EatingPatron');
    seatAndStartEating(a.playerId,a.sessionSecret);
    expect(isEating(db,a.playerId)).toBe(true);
    // Eating requires physically occupying a bar_seats row for its whole
    // duration — standFromSeat itself refuses while isEating, so that row
    // can never be vacated mid-lock. assertFree's generic "already in a
    // bar seat" check therefore refuses this before its own, more specific
    // eating_active check is ever reached — still a correct refusal,
    // confirmed by the actual thrown error code below.
    expect(()=>openDomino(db,a.playerId,a.sessionSecret,'offline',0)).toThrow(/current seat/);
    // Lock naturally expires (the same lazy-evaluation shape every other
    // grace period in this codebase uses), then standing up and opening a
    // domino seat both succeed.
    db.prepare('UPDATE bar_eating_actions SET ends_at = ? WHERE player_id = ?').run(new Date(Date.now()-1000).toISOString(),a.playerId);
    expect(isEating(db,a.playerId)).toBe(false);
    standFromSeat(db,a.playerId,a.sessionSecret);
    const r=openDomino(db,a.playerId,a.sessionSecret,'offline',0);
    expect(r.roomId).toBeTruthy();
  });

  it('a seated domino player cannot also occupy a dining/stool seat or start eating',()=>{
    const a=patron('DominoPatron');
    openDomino(db,a.playerId,a.sessionSecret,'offline',0);
    const seat=BAR_SEATS[0];
    db.prepare('UPDATE bar_players SET x = ?, y = ? WHERE id = ?').run(seat.x,seat.y+1,a.playerId);
    expect(()=>sitAtSeat(db,a.playerId,a.sessionSecret,seat.id)).toThrow(/domino/);
  });

  it('one pair leaving its domino match does not disturb the other pair, which keeps playing independently of any eating activity elsewhere in the bar',()=>{
    const a=patron('A'),b=patron('B'),c=patron('C'),d=patron('D');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0);
    openDomino(db,b.playerId,b.sessionSecret,'online',1);
    const r2=openDomino(db,c.playerId,c.sessionSecret,'online',2);
    openDomino(db,d.playerId,d.sessionSecret,'online',3);

    // A completely separate bar identity eating/drinking at the same time
    // must have zero effect on either pair's own match.
    const bystander=patron('Bystander');
    seatAndStartEating(bystander.playerId,bystander.sessionSecret);
    expect(isEating(db,bystander.playerId)).toBe(true);

    // 2026-11-08 correction: A leaving now only releases A's own seat —
    // B stays seated at the SAME room, waiting for a substitute — rather
    // than the whole match closing out from under B (the previous
    // behavior this test used to pin down).
    leaveDomino(db,a.playerId,a.sessionSecret);
    const bMe=dominoMe(db,b.playerId,b.sessionSecret);
    expect(bMe.room).not.toBeNull();
    expect(bMe.room!.id).toBe(r1.roomId);
    const pairTwoView=dominoMe(db,c.playerId,c.sessionSecret).room;
    expect(pairTwoView).not.toBeNull();
    expect(pairTwoView!.id).toBe(r2.roomId);
    actDomino(db,c.playerId,c.sessionSecret,r2.roomId,pairTwoView!.version,'start');
    expect(dominoMe(db,d.playerId,d.sessionSecret).room!.phase).toBe('playing');
  });
});
