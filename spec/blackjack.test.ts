import { expect, it } from "vitest";
import { blackjackTotal, playBlackjack, beginBlackjack, blackjackAction, blackjackChoices, stepBlackjack, blackjackNpcChoice } from "../public/tavern.js";

it("counts several aces without busting a soft hand", () => {
  expect(blackjackTotal(["A♣","A♥","9♦"])).toBe(21);
  expect(blackjackTotal(["A♣","A♥","9♦","K♠"])).toBe(21);
});

it("stands on soft 17 and preserves a settled push", () => {
  const hand = {player:["10♠","7♦"], dealer:["A♥","6♣"], deck:["9♣"], result:""};
  playBlackjack(hand,false);
  expect(hand.result).toBe("Push");
  playBlackjack(hand,true);
  expect(hand.deck).toEqual(["9♣"]);
});

it("finishes a player bust without drawing for the dealer", () => {
  const hand = {player:["K♠","8♠"], dealer:["5♥","6♣"], deck:["7♣","4♦"], result:""};
  playBlackjack(hand,true);
  expect(hand.result).toBe("You bust · Dealer wins");
  expect(hand.deck).toEqual(["7♣"]);
});

it("automatically plays the dealer after a hit reaches 21", () => {
  const hand = {player:["8♠","9♠"], dealer:["5♥","6♣"], deck:["7♣","4♦"], result:""};
  playBlackjack(hand,true);
  expect(hand.result).toBe("You win");
  expect(hand.dealer).toHaveLength(3);
});

it("pays even money through insurance when both opening hands are blackjack",()=>{
  const cards=["A♣","10♦","10♥","10♣","A♠","K♥","8♦","8♥","8♣","K♠"];
  const r=beginBlackjack(500,10,0,cards.reverse());
  expect(r.phase).toBe("insurance");
  blackjackAction(r,"Insurance");
  expect(r.phase).toBe("settled");
  expect(r.balance).toBe(510);
});

it("settles split hands independently and doubles for exactly one final card",()=>{
  const cards=["8♣","10♦","10♥","10♣","10♠","8♠","8♦","9♥","7♣","7♠","3♥","2♥","K♣"];
  const r=beginBlackjack(500,10,0,cards.reverse());
  blackjackAction(r,"Split");
  expect(blackjackChoices(r)).toContain("Double");
  blackjackAction(r,"Double");
  expect(r.hands[0].cards).toHaveLength(3);
  expect(r.index).toBe(1);
  blackjackAction(r,"Stand");
  for(let ticks=0;r.phase!=='settled'&&ticks<30;ticks++) stepBlackjack(r);
  expect(r.hands.slice(0,2).map(h=>h.result)).toEqual(["Win","Dealer wins"]);
  expect(r.balance).toBe(510);
});

it("paces each NPC hit separately, blocks human actions out of turn and then yields",()=>{
  const cards=['2♣','10♦','10♥','10♣','10♠','3♠','8♦','9♥','7♣','7♠','4♥','8♣'];
  const r=beginBlackjack(500,10,1,cards.reverse());
  expect(r.hands[0].cards).toHaveLength(2);
  expect(blackjackChoices(r)).toEqual([]);
  blackjackAction(r,'Hit');
  expect(r.hands[0].cards).toHaveLength(2);
  stepBlackjack(r);
  expect(r.hands[0].cards).toHaveLength(3);
  expect(r.index).toBe(0);
  stepBlackjack(r);
  expect(r.hands[0].cards).toHaveLength(4);
  stepBlackjack(r);
  expect(r.index).toBe(1);
  expect(blackjackChoices(r)).toContain('Stand');
  const saved=JSON.parse(JSON.stringify(r));
  stepBlackjack(saved);
  expect(saved).toEqual(r);
});

it("uses distinct risk preferences while everyone hits low totals and stands high",()=>{
  expect(blackjackNpcChoice(['10♣','6♥'],'10♦','Cautious')).toBe('Stand');
  expect(blackjackNpcChoice(['10♣','6♥'],'10♦','Bold')).toBe('Hit');
  expect(blackjackNpcChoice(['10♣','3♥'],'6♦','Balanced')).toBe('Stand');
  expect(blackjackNpcChoice(['10♣','3♥'],'10♦','Balanced')).toBe('Hit');
  for(const style of ['Cautious','Balanced','Bold','Patient']) {
    expect(blackjackNpcChoice(['2♣','4♥'],'10♦',style)).toBe('Hit');
    expect(blackjackNpcChoice(['K♣','9♥'],'10♦',style)).toBe('Stand');
  }
});

it("reveals the dealer before drawing one card at a time and settles only once",()=>{
  const cards=['10♣','10♦','10♥','K♣','2♠','8♠','8♦','9♥','7♣','3♠','4♥','8♣'];
  const r=beginBlackjack(500,10,0,cards.reverse());
  blackjackAction(r,'Stand');
  for(let i=0;i<3;i++) stepBlackjack(r);
  expect(r.phase).toBe('dealer');
  expect(r.dealer).toHaveLength(2);
  stepBlackjack(r);
  expect(r.lastMove).toMatchObject({action:'Reveal'});
  expect(r.dealer).toHaveLength(2);
  stepBlackjack(r);
  expect(r.dealer).toHaveLength(3);
  stepBlackjack(r);
  expect(r.dealer).toHaveLength(4);
  stepBlackjack(r);
  expect(r.phase).toBe('settled');
  const balance=r.balance;
  stepBlackjack(r);
  expect(r.balance).toBe(balance);
});
