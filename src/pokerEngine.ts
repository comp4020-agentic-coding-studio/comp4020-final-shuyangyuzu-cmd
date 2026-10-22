// Cash-table no-limit Hold'em. No UI, sessions or persistence here.
import { randomInt } from 'node:crypto';
export const POKER_SEATS = 5;
export type Card = string;
export interface PokerPlayer {
  id:string; nickname:string; seat:number; stack:number; hole:Card[];
  committed:number; bet:number; folded:boolean; waiting:boolean; leaving:boolean;
  actedAt:number|null;
}
export interface PokerState {
  players:PokerPlayer[]; hand:number; dealer:number; actor:string|null;
  phase:'waiting'|'preflop'|'flop'|'turn'|'river'|'showdown';
  deck:Card[]; board:Card[]; currentBet:number; minRaise:number;
  pending:string[]; payouts:Record<string,number>; result:string; actedAt:number;
}
export const newPokerState=():PokerState=>({players:[],hand:0,dealer:-1,actor:null,phase:'waiting',deck:[],board:[],currentBet:0,minRaise:2,pending:[],payouts:{},result:'',actedAt:Date.now()});
export function newPokerPlayer(id:string,nickname:string,seat:number,stack=500):PokerPlayer {
  return {id,nickname,seat,stack,hole:[],committed:0,bet:0,folded:false,waiting:true,leaving:false,actedAt:null};
}
const live=(p:PokerPlayer)=>!p.waiting&&!p.folded;
const able=(p:PokerPlayer)=>live(p)&&p.stack>0;
function clockwise(s:PokerState,seat:number,filter:(p:PokerPlayer)=>boolean):PokerPlayer[]{
  return s.players.filter(filter).sort((a,b)=>((a.seat-seat+POKER_SEATS)%POKER_SEATS||POKER_SEATS)-((b.seat-seat+POKER_SEATS)%POKER_SEATS||POKER_SEATS));
}
function pay(p:PokerPlayer,amount:number){const n=Math.min(p.stack,amount);p.stack-=n;p.bet+=n;p.committed+=n;}
function deal(s:PokerState,n:number){return Array.from({length:n},()=>s.deck.pop()!);}

/** Comparable category + kickers. Suits never break a tie. */
export function rankFive(cards:Card[]):number[]{
  const ranks=cards.map(c=>'23456789TJQKA'.indexOf(c[0])+2).sort((a,b)=>b-a);
  const counts=new Map<number,number>();for(const r of ranks)counts.set(r,(counts.get(r)||0)+1);
  const groups=[...counts].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const flush=cards.every(c=>c[1]===cards[0][1]);
  const unique=[...new Set(ranks)];if(unique[0]===14)unique.push(1);
  let straight=0;for(let i=0;i<=unique.length-5;i++)if(unique[i]-unique[i+4]===4){straight=unique[i];break;}
  if(flush&&straight)return [8,straight];
  if(groups[0][1]===4)return [7,groups[0][0],groups[1][0]];
  if(groups[0][1]===3&&groups[1][1]===2)return [6,groups[0][0],groups[1][0]];
  if(flush)return [5,...ranks];
  if(straight)return [4,straight];
  if(groups[0][1]===3)return [3,groups[0][0],...groups.slice(1).map(g=>g[0])];
  if(groups[0][1]===2&&groups[1][1]===2)return [2,...groups.slice(0,2).map(g=>g[0]).sort((a,b)=>b-a),groups[2][0]];
  if(groups[0][1]===2)return [1,groups[0][0],...groups.slice(1).map(g=>g[0])];
  return [0,...ranks];
}
export function compareRanks(a:number[],b:number[]):number {for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0);if(d)return d;}return 0;}
export function bestHand(cards:Card[]):number[]{
  let best:number[]=[];
  for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++){
    const rank=rankFive([cards[a],cards[b],cards[c],cards[d],cards[e]]);if(compareRanks(rank,best)>0)best=rank;
  }
  return best;
}
export const handNames=['High card','One pair','Two pair','Three of a kind','Straight','Flush','Full house','Four of a kind','Straight flush'];

export function settlePoker(s:PokerState):void {
  s.actor=null;s.pending=[];s.phase='showdown';s.payouts={};
  const levels=[...new Set(s.players.map(p=>p.committed).filter(n=>n>0))].sort((a,b)=>a-b);
  let previous=0;
  for(const level of levels){
    const contributors=s.players.filter(p=>p.committed>=level);
    const amount=(level-previous)*contributors.length;previous=level;
    let eligible=contributors.filter(live);
    // Uncalled excess is returned, including when someone left/folded.
    if(contributors.length===1)eligible=contributors;
    if(!eligible.length){for(const p of contributors){const refund=amount/contributors.length;p.stack+=refund;s.payouts[p.id]=(s.payouts[p.id]||0)+refund;}continue;}
    let winners=eligible;
    if(eligible.length>1){
      const ranked=eligible.map(p=>({p,rank:bestHand([...p.hole,...s.board])}));
      const best=ranked.reduce((a,b)=>compareRanks(a.rank,b.rank)>=0?a:b).rank;
      winners=ranked.filter(r=>compareRanks(r.rank,best)===0).map(r=>r.p);
    }
    // Odd chips go clockwise from the button, never by suit or join time.
    const ordered=clockwise(s,s.dealer,p=>winners.includes(p));
    const share=Math.floor(amount/winners.length);let odd=amount%winners.length;
    for(const p of ordered){const won=share+(odd-->0?1:0);p.stack+=won;s.payouts[p.id]=(s.payouts[p.id]||0)+won;}
  }
  s.result=Object.entries(s.payouts).filter(([,n])=>n>0).map(([id,n])=>`${s.players.find(p=>p.id===id)!.nickname} +${n}`).join(' · ');
}

function advance(s:PokerState,after:number):void {
  s.pending=s.pending.filter(id=>s.players.some(p=>p.id===id&&able(p)));
  if(s.players.filter(live).length<=1){settlePoker(s);return;}
  const actors=s.players.filter(able);
  if(actors.length<=1&&actors.every(p=>p.bet>=s.currentBet))s.pending=[];
  if(s.pending.length){s.actor=clockwise(s,after,p=>s.pending.includes(p.id))[0].id;s.actedAt=Date.now();return;}
  if(s.phase==='river'){settlePoker(s);return;}
  s.deck.pop(); // burn before each community street
  if(s.phase==='preflop'){s.board.push(...deal(s,3));s.phase='flop';}
  else if(s.phase==='flop'){s.board.push(...deal(s,1));s.phase='turn';}
  else {s.board.push(...deal(s,1));s.phase='river';}
  s.currentBet=0;s.minRaise=2;
  for(const p of s.players){p.bet=0;p.actedAt=null;}
  s.pending=s.players.filter(able).map(p=>p.id);
  if(s.players.filter(able).length<=1)s.pending=[];
  advance(s,s.dealer);
}

export function startPokerHand(s:PokerState,rng=(max:number)=>randomInt(max)):void {
  if(s.phase!=='waiting'&&s.phase!=='showdown')throw Error('Finish this hand first');
  s.players=s.players.filter(p=>!p.leaving);
  const funded=s.players.filter(p=>p.stack>0);
  if(funded.length<2)throw Error('At least two funded players are needed');
  const next=clockwise(s,s.dealer,p=>p.stack>0);
  s.dealer=s.hand===0?funded[rng(funded.length)].seat:next[0].seat;
  s.hand++;s.phase='preflop';s.board=[];s.payouts={};s.result='';s.currentBet=2;s.minRaise=2;
  s.deck=[...'cdhs'].flatMap(suit=>[...'23456789TJQKA'].map(r=>r+suit));
  for(let i=s.deck.length-1;i>0;i--){const j=rng(i+1);[s.deck[i],s.deck[j]]=[s.deck[j],s.deck[i]];}
  for(const p of s.players){p.hole=[];p.committed=0;p.bet=0;p.folded=false;p.waiting=p.stack===0;p.actedAt=null;}
  const order=clockwise(s,s.dealer,p=>!p.waiting);
  for(let i=0;i<2;i++)for(const p of order)p.hole.push(...deal(s,1));
  const small=funded.length===2?s.players.find(p=>p.seat===s.dealer)!:order[0];
  const big=funded.length===2?order[0]:order[1];
  pay(small,1);pay(big,2);
  s.pending=s.players.filter(able).map(p=>p.id);
  advance(s,big.seat);
}

export function pokerAction(s:PokerState,id:string,type:string,to?:number):void {
  if(s.actor!==id||s.phase==='showdown'||s.phase==='waiting')throw Error('It is not your turn');
  const p=s.players.find(p=>p.id===id)!;
  if(!able(p))throw Error('This seat cannot act');
  const owed=s.currentBet-p.bet;
  if(type==='fold')p.folded=true;
  else if(type==='check'){if(owed>0)throw Error('Call or fold: there is a bet to match');}
  else if(type==='call')pay(p,Math.max(0,owed));
  else if(type==='raise'||type==='allin'){
    const target=type==='allin'?p.bet+p.stack:to!;
    if(!Number.isSafeInteger(target)||target<=p.bet||target>p.bet+p.stack)throw Error('Invalid raise amount');
    if(target<=s.currentBet){if(target!==p.bet+p.stack)throw Error('Use Call to match the bet');pay(p,target-p.bet);}
    else {
      if(p.actedAt!==null&&s.currentBet-p.actedAt<s.minRaise)throw Error('A short all-in did not reopen your raising rights');
      const increase=target-s.currentBet;
      if(increase<s.minRaise&&target!==p.bet+p.stack)throw Error(`Minimum raise-to is ${s.currentBet+s.minRaise}`);
      pay(p,target-p.bet);
      if(increase>=s.minRaise){s.minRaise=increase;s.pending=s.players.filter(q=>q.id!==id&&able(q)).map(q=>q.id);}
      else for(const q of s.players)if(q.id!==id&&able(q)&&q.bet<target&&!s.pending.includes(q.id))s.pending.push(q.id);
      s.currentBet=target;
    }
  } else throw Error('Unknown poker action');
  p.actedAt=s.currentBet;s.pending=s.pending.filter(other=>other!==id);advance(s,p.seat);
}

export function leavePokerHand(s:PokerState,id:string):void {
  const p=s.players.find(p=>p.id===id);if(!p)return;
  p.leaving=true;
  if(s.phase==='waiting'||s.phase==='showdown'||p.waiting)return;
  // An all-in keeps its earned eligibility; departure cannot withdraw a bet.
  if(p.stack>0)p.folded=true;
  s.pending=s.pending.filter(other=>other!==id);
  advance(s,s.actor===id?p.seat:(s.players.find(q=>q.id===s.actor)?.seat??p.seat)-1);
}
