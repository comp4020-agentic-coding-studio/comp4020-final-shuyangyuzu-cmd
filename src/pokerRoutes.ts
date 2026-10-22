import type { Hono } from 'hono';
import type Database from 'better-sqlite3';
import * as poker from './poker.ts';
import { RoomError } from './rooms.ts';
export function registerPoker(app:Hono,db:Database.Database):void {
  app.post('/api/poker/:action',async c=>{
    const raw=await c.req.text();
    if(raw.length>8192)throw new RoomError('Poker request is too large','payload_too_large',413);
    let b;try{b=JSON.parse(raw||'{}');}catch{throw new RoomError('Invalid JSON','bad_request',400);}
    if(!b||typeof b!=='object'||Array.isArray(b))throw new RoomError('Expected an object','bad_request',400);
    const id=typeof b.playerId==='string'?b.playerId:'',secret=typeof b.sessionSecret==='string'?b.sessionSecret:'';
    switch(c.req.param('action')){
      case 'me':return c.json(poker.pokerMe(db,id,secret));
      case 'open':return c.json({roomId:poker.openPoker(db,id,secret,String(b.mode),['red','blue','green','yellow','purple'].indexOf(b.seat))});
      case 'leave':poker.leavePoker(db,id,secret);return c.json({ok:true});
      case 'act':poker.actPoker(db,id,secret,String(b.roomId),Number(b.version),String(b.type),Number(b.to));return c.json({ok:true});
      case 'search':return c.json({players:poker.searchPokerFriends(db,id,secret,String(b.query??''))});
      case 'invite':poker.invitePoker(db,id,secret,String(b.roomId),String(b.target));return c.json({ok:true});
      case 'respond':return c.json({roomId:poker.respondPoker(db,id,secret,String(b.inviteId),b.join===true)});
      default:return c.json({message:'Unknown poker action'},404);
    }
  });
  const timer=setInterval(()=>{try{poker.tickPoker(db);}catch(e){console.error('Poker tick failed:',(e as Error).message);}},800);
  timer.unref();
}
