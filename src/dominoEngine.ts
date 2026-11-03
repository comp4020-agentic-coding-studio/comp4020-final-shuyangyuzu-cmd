import { randomInt } from 'node:crypto';

export type Tile = [number, number];
export interface Bone { id:string; tile:Tile; parent:string|null; port:string }
export interface End { key:string; pip:number; score:number; bone:string; spinnerPrimary?:boolean }
export interface DominoState {
  hands:Tile[][]; stock:Tile[]; board:Bone[]; ends:End[];
  spinner:{id:string;value:number;unlocked:boolean}|null;
  scores:number[]; turn:number; starter:number; required:Tile|null;
  round:number; phase:'playing'|'round_end'|'finished'; passes:number;
  winner:number|null; result:string; target:number;
}
const key=(t:Tile)=>`${t[0]}-${t[1]}`;
export function deck():Tile[]{const tiles:Tile[]=[];for(let a=0;a<=6;a++)for(let b=a;b<=6;b++)tiles.push([a,b]);return tiles;}
export function shuffled():Tile[]{const a=deck();for(let i=a.length-1;i>0;i--){const j=randomInt(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
export function deal(previous?:DominoState,tiles=shuffled()):DominoState {
  if(tiles.length!==28||new Set(tiles.map(key)).size!==28||tiles.some(t=>!deck().some(d=>key(d)===key(t))))throw Error('Invalid double-six deck');
  const hands=[tiles.slice(0,7),tiles.slice(7,14)];
  let starter=previous?1-previous.starter:0,required:Tile|null=null;
  if(!previous){
    const ranked=hands.flatMap((h,p)=>h.map(t=>({p,t,rank:t[0]===t[1]?100+t[0]:t[0]+t[1]}))).sort((a,b)=>b.rank-a.rank||b.t[1]-a.t[1]);
    starter=ranked[0].p;required=ranked[0].t;
  }
  return {hands,stock:tiles.slice(14),board:[],ends:[],spinner:null,scores:previous?[...previous.scores]:[0,0],turn:starter,starter,required,round:(previous?.round??0)+1,phase:'playing',passes:0,winner:null,result:'Match the open ends. First to 150.',target:150};
}
export function moves(s:DominoState,player=s.turn):{tile:Tile;end:string}[]{
  if(s.phase!=='playing')return [];
  return s.hands[player].flatMap(tile=>!s.board.length
    ?(!s.required||key(s.required)===key(tile)?[{tile,end:'start'}]:[])
    :s.ends.filter(e=>tile.includes(e.pip)).map(e=>({tile,end:e.key})));
}
export function endTotal(s:DominoState):number {
  let spinnerCounted=false;
  return s.ends.reduce((sum,e)=>{if(e.spinnerPrimary){if(spinnerCounted)return sum;spinnerCounted=true;}return sum+e.score;},0);
}
const pips=(h:Tile[])=>h.reduce((n,t)=>n+t[0]+t[1],0);
function finishRound(s:DominoState,winner:number|null,bonus:number,reason:string):void {
  if(winner!==null)s.scores[winner]+=bonus;
  s.winner=winner;s.result=reason+(winner===null?' — tied, no bonus.':` — player ${winner+1} gains ${bonus}.`);
  s.phase=s.scores.some(n=>n>=s.target)?'finished':'round_end';
}
export function play(s:DominoState,player:number,tile:Tile,end:string):void {
  if(player!==s.turn||s.phase!=='playing')throw Error('Not your turn');
  if(!moves(s,player).some(m=>key(m.tile)===key(tile)&&m.end===end))throw Error('That tile cannot be played there');
  const id=key(tile),double=tile[0]===tile[1];
  let parent:string|null=null,port=end;
  if(!s.board.length){
    s.ends=[{key:`${id}:left`,pip:tile[0],score:double?tile[0]*2:tile[0],bone:id,spinnerPrimary:double},
      {key:`${id}:right`,pip:tile[1],score:double?tile[1]*2:tile[1],bone:id,spinnerPrimary:double}];
    if(double)s.spinner={id,value:tile[0],unlocked:false};
  }else {
    const e=s.ends.find(e=>e.key===end)!;parent=e.bone;
    const pip=tile[0]===e.pip?tile[1]:tile[0];
    s.ends=s.ends.filter(x=>x.key!==end);
    const firstDouble=double&&!s.spinner;
    s.ends.push({key:`${id}:out`,pip,score:double?pip*2:pip,bone:id,spinnerPrimary:firstDouble});
    if(firstDouble)s.spinner={id,value:pip,unlocked:false};
  }
  s.board.push({id,tile,parent,port});
  if(s.spinner&&!s.spinner.unlocked&&!s.ends.some(e=>e.spinnerPrimary)){
    s.spinner.unlocked=true;
    for(const side of ['top','bottom'])s.ends.push({key:`${s.spinner.id}:${side}`,pip:s.spinner.value,score:0,bone:s.spinner.id});
  }
  s.hands[player].splice(s.hands[player].findIndex(t=>key(t)===id),1);s.required=null;s.passes=0;
  const total=endTotal(s),points=total>0&&total%5===0?total:0;s.scores[player]+=points;
  s.result=`Player ${player+1} played ${id}. Open ends ${total}${points?` · +${points} points`:''}.`;
  if(s.scores[player]>=s.target){s.phase='finished';s.winner=player;return;}
  if(!s.hands[player].length){finishRound(s,player,Math.round(pips(s.hands[1-player])/5)*5,'Domino!');return;}
  s.turn=1-player;
}
export function drawOrPass(s:DominoState,player:number):void {
  if(player!==s.turn||s.phase!=='playing')throw Error('Not your turn');
  if(moves(s,player).length)throw Error('Play a matching tile before drawing');
  if(s.stock.length){s.hands[player].push(s.stock.shift()!);s.result=`Player ${player+1} drew one tile.`;return;}
  s.passes++;s.result=`Player ${player+1} passed.`;
  if(s.passes===2){const totals=s.hands.map(pips),winner=totals[0]===totals[1]?null:totals[0]<totals[1]?0:1;finishRound(s,winner,Math.round(Math.abs(totals[0]-totals[1])/5)*5,'Blocked round');}
  else s.turn=1-player;
}
/** NPC sees only its hand and public board; it never inspects the human's tiles or stock order. */
export function npcMove(s:DominoState):{tile:Tile;end:string}|null {
  const choices=moves(s);if(!choices.length)return null;
  return choices.map(m=>{const copy=structuredClone(s);copy.hands[1-s.turn]=[];copy.stock=[];play(copy,s.turn,m.tile,m.end);const total=endTotal(copy);return {m,value:(total>0&&total%5===0?total:0)*100+m.tile[0]+m.tile[1]};}).sort((a,b)=>b.value-a.value)[0].m;
}
