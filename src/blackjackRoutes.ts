import type { Hono } from 'hono';
import type Database from 'better-sqlite3';
import {RoomError} from './rooms.ts';
import {requireBarSession} from './bar.ts';
import * as bj from './blackjack.ts';
export function registerBlackjack(app:Hono,db:Database.Database):void {
  app.post('/api/blackjack/:action',async c=>{
    const raw=await c.req.text();if(raw.length>8192)throw new RoomError('Request too large','payload_too_large',413);
    let b;try{b=JSON.parse(raw);}catch{throw new RoomError('Invalid JSON','bad_request',400);}
    if(!b||typeof b!=='object'||Array.isArray(b))throw new RoomError('Expected an object','bad_request',400);
    const id=typeof b.playerId==='string'?b.playerId:'',secret=typeof b.sessionSecret==='string'?b.sessionSecret:'';
    switch(c.req.param('action')){
      case 'open':return c.json({roomId:bj.openBlackjack(db,id,secret,['red','blue','green','yellow'].indexOf(b.seat??'red'),typeof b.roomId==='string'?b.roomId:undefined)});
      case 'me':return c.json(bj.blackjackMe(db,id,secret,b.active===true));
      case 'act':bj.actBlackjack(db,id,secret,String(b.roomId),Number(b.version),String(b.action),b.bet);return c.json({ok:true});
      case 'leave':bj.leaveBlackjack(db,id,secret);return c.json({ok:true});
      case 'leaveWaitlist':bj.leaveBlackjackWaitlist(db,id,secret,String(b.roomId));return c.json({ok:true});
      case 'away':bj.setBlackjackAway(db,id,secret,b.away===true);return c.json({ok:true});
      case 'ack':requireBarSession(db,id,secret);db.prepare('DELETE FROM blackjack_notices WHERE bar_id=?').run(id);return c.json({ok:true});
      default:return c.json({message:'Unknown blackjack action'},404);
    }
  });
  setInterval(()=>{try{bj.tickBlackjack(db);}catch(e){console.error('Blackjack tick failed:',(e as Error).message);}},400).unref();
}
