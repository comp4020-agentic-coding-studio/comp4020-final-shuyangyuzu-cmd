import { JSDOM } from 'jsdom';
import { expect,it } from 'vitest';
import { renderPokerTable } from '../public/poker.js';

function table(phase='flop') {
  const document=new JSDOM('').window.document;
  const el=(tag:string,attrs:Record<string,unknown>={},children:any=[]):HTMLElement=>{
    const node=document.createElement(tag);
    for(const[k,v]of Object.entries(attrs))node.setAttribute(k,String(v));
    for(const c of [].concat(children))node.append(c);
    return node;
  };
  const room={phase,hand:1,dealer:2,actor:'me',pot:24,board:['2c','7d','Ah'],players:[
    {id:'me',nickname:'Me',seat:3,stack:490,bet:10,hole:['Ks','Kd'],npc:false},
    {id:'opponent',nickname:'Friend',seat:4,stack:486,bet:14,hole:[],npc:false},
  ]};
  return {room,render:()=>renderPokerTable(el,room,'me')};
}

it('puts the viewer at the near edge without changing authoritative seats; vacant chairs remain visible',()=>{
  const t=table(),view=t.render();
  expect(view.querySelectorAll('.poker-seat')).toHaveLength(5);
  expect(view.querySelectorAll('.poker-seat.vacant')).toHaveLength(3);
  expect(view.querySelector('.poker-seat')?.getAttribute('aria-label')).toBe('Me · You, seat 4');
  expect(t.room.players.map(p=>p.seat)).toEqual([3,4]);
  expect(view.querySelector('.poker-hand-zone')?.textContent).toContain('10');
});

it('renders own cards on the table, never invents an opponent reveal, and uses authorized showdown cards',()=>{
  const t=table(),view=t.render();
  expect(view.querySelector('[aria-label="Me\'s cards and bet"]')?.textContent).toContain('K♠K♦');
  expect(view.querySelector('[aria-label="Friend\'s cards and bet"]')?.querySelectorAll('.card-back')).toHaveLength(2);
  t.room.phase='showdown';t.room.players[1].hole=['Ac','As'];
  expect(t.render().querySelector('[aria-label="Friend\'s cards and bet"]')?.textContent).toContain('A♣A♠');
});

it('does not draw dealt cards for a player waiting for the next hand',()=>{
  const t=table();Object.assign(t.room.players[1],{waiting:true});
  expect(t.render().querySelector('[aria-label="Friend\'s cards and bet"]')).toBeNull();
});
