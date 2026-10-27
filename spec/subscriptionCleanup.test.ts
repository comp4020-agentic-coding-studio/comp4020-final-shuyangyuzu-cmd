import {expect,it,vi} from 'vitest';
import {subscribeRoomVoice,publishToRoomVoice,subscribeRoom,publishRoom,subscribeChatInbox,publishToPlayer} from '../src/live.ts';

it('a late second voice unsubscribe cannot delete a replacement subscription',()=>{
  const old=subscribeRoomVoice('cleanup-voice','alice',vi.fn());old();
  const receive=vi.fn(),fresh=subscribeRoomVoice('cleanup-voice','alice',receive);
  old();publishToRoomVoice('cleanup-voice','alice',{type:'signal'});
  try{expect(receive).toHaveBeenCalledOnce();}finally{fresh();}
});
it('a late second room unsubscribe preserves the replacement room stream',()=>{
  const old=subscribeRoom('cleanup-room',vi.fn());old();
  const receive=vi.fn(),fresh=subscribeRoom('cleanup-room',receive);
  old();publishRoom('cleanup-room',{version:2});
  try{expect(receive).toHaveBeenCalledOnce();}finally{fresh();}
});
it('a late second inbox unsubscribe preserves the replacement private inbox',()=>{
  const old=subscribeChatInbox('cleanup-inbox',vi.fn());old();
  const receive=vi.fn(),fresh=subscribeChatInbox('cleanup-inbox',receive);
  old();publishToPlayer('cleanup-inbox',{type:'message'});
  try{expect(receive).toHaveBeenCalledOnce();}finally{fresh();}
});
it('unsubscribing one voice tab twice does not remove another live tab',()=>{
  const old=subscribeRoomVoice('cleanup-tabs','alice',vi.fn());
  const receive=vi.fn(),other=subscribeRoomVoice('cleanup-tabs','alice',receive);
  old();old();publishToRoomVoice('cleanup-tabs','alice',{type:'signal'});
  try{expect(receive).toHaveBeenCalledOnce();}finally{other();}
});
