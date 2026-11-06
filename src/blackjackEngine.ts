import { randomInt } from 'node:crypto';

export type BJPlayer={id:string;nickname:string;seat:number;stack:number;bet:number;ready:boolean;leaving:boolean};
export type BJHand={owner:string;seat:number;cards:string[];bet:number;split:boolean;done:boolean;result:string};
export type BJState={players:BJPlayer[];hands:BJHand[];dealer:string[];deck:string[];phase:'betting'|'insurance'|'playing'|'dealer'|'settled';turn:number;hand:number;insurance:Record<string,number|null>;revealed:boolean;changedAt:number;lastMove:{seat:number|'dealer';action:string;card?:number}|null};
export function total(cards:string[]):number {let n=0,aces=0;for(const c of cards){const r=c.slice(0,-1);if(r==='A')aces++;n+=r==='A'?1:['J','Q','K'].includes(r)?10:Number(r);}return aces&&n<=11?n+10:n;}
const natural=(h:BJHand)=>!h.split&&h.cards.length===2&&total(h.cards)===21;
export function shoe():string[]{const d=[...'♠♥♦♣'].flatMap(s=>['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map(r=>r+s));for(let i=d.length-1;i>0;i--){const j=randomInt(i+1);[d[i],d[j]]=[d[j],d[i]];}return d;}
export function newBlackjack():BJState{return {players:[],hands:[],dealer:[],deck:[],phase:'betting',turn:0,hand:0,insurance:{},revealed:false,changedAt:Date.now(),lastMove:null};}
const take=(s:BJState)=>{const c=s.deck.pop();if(!c)throw Error('Shoe exhausted');return c;};
const touch=(s:BJState)=>{s.changedAt=Date.now();};
function settle(s:BJState):void {
  if(s.phase==='settled')return;
  s.revealed=true;const house=total(s.dealer),bj=house===21&&s.dealer.length===2;
  for(const h of s.hands){
    const n=total(h.cards);let rate=0;
    if(n>21)h.result='Bust';
    else if(natural(h)){rate=bj?1:2.5;h.result=bj?'Push':'Blackjack';}
    else if(bj)h.result='Dealer blackjack';
    else if(house>21||n>house){rate=2;h.result='Win';}
    else if(n===house){rate=1;h.result='Push';}else h.result='Dealer wins';
    s.players.find(p=>p.id===h.owner)!.stack+=h.bet*rate;
  }
  if(bj)for(const p of s.players)p.stack+=3*(s.insurance[p.id]??0);
  s.phase='settled';touch(s);
}
function advance(s:BJState):void {
  if(total(s.dealer)===21&&s.dealer.length===2){settle(s);return;}
  while(s.turn<s.hands.length){const h=s.hands[s.turn];if(!h.done&&total(h.cards)<21)break;h.done=true;s.turn++;}
  if(s.turn===s.hands.length)s.phase='dealer';
  touch(s);
}
export function dealBlackjack(s:BJState,deck=shoe()):void {
  if(!['betting','settled'].includes(s.phase))throw Error('Finish this hand first');
  const players=s.players.filter(p=>!p.leaving);
  if(!players.length||players.some(p=>!p.ready||p.bet<2||p.bet>p.stack))throw Error('Every seated player must choose a wager and ready up');
  s.hands=players.sort((a,b)=>a.seat-b.seat).map(p=>{p.stack-=p.bet;p.ready=false;return {owner:p.id,seat:p.seat,cards:[],bet:p.bet,split:false,done:false,result:''};});
  s.dealer=[];s.deck=deck;s.turn=0;s.hand++;s.revealed=false;s.insurance={};s.lastMove=null;
  for(let pass=0;pass<2;pass++){for(const h of s.hands)h.cards.push(take(s));s.dealer.push(take(s));}
  if(s.dealer[0].startsWith('A')){s.phase='insurance';for(const p of players)s.insurance[p.id]=null;}
  else {s.phase='playing';advance(s);}touch(s);
}
export function choices(s:BJState,id:string):string[]{
  const p=s.players.find(p=>p.id===id&&!p.leaving);if(!p)return [];
  if(s.phase==='insurance'&&s.insurance[id]===null)return p.stack>=p.bet/2?['Insurance','Decline']:['Decline'];
  const h=s.hands[s.turn];if(s.phase!=='playing'||h?.owner!==id)return [];
  const out=['Hit','Stand'];
  if(h.cards.length===2&&p.stack>=h.bet){out.push('Double');if(!h.split&&total([h.cards[0]])===total([h.cards[1]]))out.push('Split');}
  return out;
}
export function act(s:BJState,id:string,action:string):void {
  if(!choices(s,id).includes(action))throw Error('That action is not available on your turn');
  const p=s.players.find(p=>p.id===id)!;
  if(s.phase==='insurance'){
    const amount=action==='Insurance'?p.bet/2:0;p.stack-=amount;s.insurance[id]=amount;
    if(Object.values(s.insurance).every(v=>v!==null)){s.phase='playing';advance(s);}
    touch(s);return;
  }
  const h=s.hands[s.turn];s.lastMove={seat:h.seat,action};
  if(action==='Split'){
    p.stack-=h.bet;const other={...h,cards:[h.cards.pop()!],split:true};h.split=true;
    h.cards.push(take(s));other.cards.push(take(s));s.hands.splice(s.turn+1,0,other);
    if(h.cards[0].startsWith('A'))h.done=other.done=true;
  }else{
    if(action==='Double'){p.stack-=h.bet;h.bet*=2;}
    if(action!=='Stand'){h.cards.push(take(s));s.lastMove.card=h.cards.length-1;}
    if(action!=='Hit'||total(h.cards)>=21)h.done=true;
  }
  advance(s);
}
export function stepDealer(s:BJState):void {
  if(s.phase!=='dealer')return;
  if(!s.revealed){s.revealed=true;s.lastMove={seat:'dealer',action:'Reveal',card:1};}
  else if(total(s.dealer)<17&&s.hands.some(h=>total(h.cards)<=21&&!natural(h))){s.dealer.push(take(s));s.lastMove={seat:'dealer',action:'Hit',card:s.dealer.length-1};}
  else {s.lastMove={seat:'dealer',action:'Stand'};settle(s);}touch(s);
}
export function depart(s:BJState,id:string):void {
  const p=s.players.find(p=>p.id===id);if(!p)return;p.leaving=true;p.ready=false;
  for(const h of s.hands)if(h.owner===id)h.done=true;
  if(s.phase==='insurance'&&s.insurance[id]===null){s.insurance[id]=0;if(Object.values(s.insurance).every(v=>v!==null)){s.phase='playing';advance(s);}}
  if(s.phase==='playing')advance(s);
}
