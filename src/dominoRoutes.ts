import type { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { RoomError } from './rooms.ts';
import * as domino from './domino.ts';
export function registerDomino(app:Hono,db:Database.Database):void {
  app.post('/api/domino/:action',async c=>{
    const raw=await c.req.text();if(raw.length>4096)throw new RoomError('Request too large','payload_too_large',413);
    let b;try{b=JSON.parse(raw);}catch{throw new RoomError('Invalid JSON','bad_request',400);}
    if(!b||typeof b!=='object'||Array.isArray(b))throw new RoomError('Expected an object','bad_request',400);
    const id=typeof b.playerId==='string'?b.playerId:'',secret=typeof b.sessionSecret==='string'?b.sessionSecret:'';
    switch(c.req.param('action')){
      case 'me':return c.json(domino.dominoMe(db,id,secret,b.active===true));
      case 'open':return c.json(domino.openDomino(db,id,secret,String(b.mode),b.chair));
      case 'act':
        if(b.type==='play'&&(!Array.isArray(b.tile)||b.tile.length!==2||b.tile.some((n:unknown)=>!Number.isInteger(n)||Number(n)<0||Number(n)>6)||typeof b.end!=='string'))throw new RoomError('Invalid tile','bad_request',400);
        domino.actDomino(db,id,secret,String(b.roomId),b.version,String(b.type),b.tile,b.end);break;
      case 'leave':domino.leaveDomino(db,id,secret);break;
      case 'leaveWaitlist':domino.leaveDominoWaitlist(db,id,secret,Number(b.lane));break;
      case 'away':domino.setDominoAway(db,id,secret,b.away===true);break;
      default:throw new RoomError('Unknown domino action','bad_request',400);
    }
    return c.json({ok:true});
  });
  const timer=setInterval(()=>{try{domino.tickDomino(db);}catch(e){console.error('Domino tick failed:',(e as Error).message);}},800);timer.unref();
}
