import {describe,it,expect,beforeEach,afterEach} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type Database from 'better-sqlite3';
import {openDb} from '../src/db.ts';
import {joinBar,moveBar} from '../src/bar.ts';
import {GAME_CHAIRS} from '../src/barLayout.ts';
import {deal,deck,moves,play,drawOrPass,endTotal,npcMove,type DominoState,type Tile} from '../src/dominoEngine.ts';
import {openDomino,respondDomino,actDomino,dominoMe,leaveDomino,tickDomino} from '../src/domino.ts';
import {getTablesStatus} from '../src/tables.ts';

describe('All Fives rules',()=>{
  it('deals seven each, fourteen hidden, with the highest double opening',()=>{const s=deal(undefined,deck());expect(s.hands.map(h=>h.length)).toEqual([7,7]);expect(s.stock).toHaveLength(14);expect(s.turn).toBe(1);expect(s.required).toEqual([2,2]);expect(moves(s)).toEqual([{tile:[2,2],end:'start'}]);});
  function position():DominoState {const s=deal();s.board=[];s.ends=[];s.spinner=null;s.required=null;s.turn=0;s.hands=[[[5,5],[1,2],[0,0]],[[0,5],[2,5],[3,5]]];s.stock=[];s.scores=[0,0];return s;}
  it('counts an opening double once, then unlocks two spinner arms only after both primary sides',()=>{
    const s=position();play(s,0,[5,5],'start');expect(endTotal(s)).toBe(10);expect(s.scores[0]).toBe(10);
    play(s,1,[0,5],'5-5:left');expect(endTotal(s)).toBe(10);expect(s.ends).toHaveLength(2);
    s.hands[0].push([2,5]);play(s,0,[2,5],'5-5:right');expect(s.spinner?.unlocked).toBe(true);expect(s.ends).toHaveLength(4);expect(endTotal(s)).toBe(2);
    play(s,1,[3,5],'5-5:top');expect(endTotal(s)).toBe(5);expect(s.scores[1]).toBe(15);
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
  it('runs two online matches on one fixture with host approval and independent actions',()=>{
    const a=patron('A'),b=patron('B'),c=patron('C'),d=patron('D');
    const r1=openDomino(db,a.playerId,a.sessionSecret,'online',0),r2=openDomino(db,c.playerId,c.sessionSecret,'online',2);
    expect(r1.roomId).not.toBe(r2.roomId);
    expect(openDomino(db,b.playerId,b.sessionSecret,'online',1).pending).toBe(true);
    expect(openDomino(db,d.playerId,d.sessionSecret,'online',3).pending).toBe(true);
    expect(()=>respondDomino(db,b.playerId,b.sessionSecret,r1.roomId,b.playerId,true)).toThrow(/host/);
    respondDomino(db,a.playerId,a.sessionSecret,r1.roomId,b.playerId,true);respondDomino(db,c.playerId,c.sessionSecret,r2.roomId,d.playerId,true);
    const view=dominoMe(db,a.playerId,a.sessionSecret).room!;
    actDomino(db,a.playerId,a.sessionSecret,r1.roomId,view.version,'start');
    expect(dominoMe(db,c.playerId,c.sessionSecret).room!.phase).toBe('waiting');
    expect(()=>actDomino(db,c.playerId,c.sessionSecret,r1.roomId,view.version,'start')).toThrow(/not seated/);
    expect(getTablesStatus(db).find(t=>t.id==='dominoes-1')!.playerCount).toBe(4);
    leaveDomino(db,a.playerId,a.sessionSecret);expect(dominoMe(db,b.playerId,b.sessionSecret).room).toBeNull();expect(dominoMe(db,c.playerId,c.sessionSecret).room).not.toBeNull();
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
