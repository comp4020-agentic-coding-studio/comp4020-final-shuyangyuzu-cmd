import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { createVoiceCall } from '../public/voiceCall.js';

const flush = async () => { for (let i=0;i<8;i++) await new Promise(r=>setImmediate(r)); };
function deferred<T>() { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
const cleanups:Array<()=>void> = [];
afterEach(()=>{cleanups.splice(0).forEach(f=>f());vi.unstubAllGlobals();});

function setup() {
  const dom=new JSDOM('<body></body>');
  const tracks:Array<{enabled:boolean;stop:ReturnType<typeof vi.fn>}> = [];
  const events:Array<{onopen?:()=>void;onmessage?:(e:{data:string})=>void;close:()=>void}> = [];
  const requests:Array<{url:string;body:any}> = [];
  let joined=false, invited=false, active=false;
  let others:any[]=[];
  const summary=()=>({active,callId:active?'call-1':null,startedBy:'alice',participants:joined?[{playerId:'alice',nickname:'Alice',color:'red',muted:false},...others]:[]});
  const makeStream=()=>{const track={enabled:true,stop:vi.fn()};tracks.push(track);return {getTracks:()=>[track],getAudioTracks:()=>[track]};};
  const mic=vi.fn(async()=>makeStream());
  const transport=vi.fn(async(url:string,init:any):Promise<{ok:boolean;json:()=>Promise<any>}>=>{
    const body=JSON.parse(init.body);requests.push({url,body});
    if(url.endsWith('/start')||url.endsWith('/respond')&&body.accept){joined=true;active=true;invited=false;}
    if(url.endsWith('/leave'))joined=false;
    return {ok:true,json:async()=>url.endsWith('/state')?{...summary(),own:{status:joined?'joined':invited?'invited':'none',muted:false,invitedBy:'Alice'}}:{voiceCall:summary(),iceServers:[]}};
  });
  vi.stubGlobal('document',dom.window.document);
  vi.stubGlobal('navigator',{mediaDevices:{getUserMedia:mic}});
  vi.stubGlobal('fetch',transport);
  vi.stubGlobal('EventSource',class {constructor(){events.push(this);}close(){} });
  const rtc=vi.fn(function(){return {close:vi.fn(),addTrack:vi.fn(),setRemoteDescription:vi.fn(async()=>{}),createAnswer:vi.fn(async()=>({type:'answer',sdp:'test'})),setLocalDescription:vi.fn(async()=>{}),addIceCandidate:vi.fn(async()=>{})};});vi.stubGlobal('RTCPeerConnection',rtc);
  const el=(tag:string,attrs:Record<string,any>={},children:any=[]):any=>{
    const node=dom.window.document.createElement(tag);
    for(const[k,v]of Object.entries(attrs)){if(k==='onclick')node.onclick=v;else node.setAttribute(k,v);}
    for(const child of [].concat(children))if(child!=null)node.append(child);
    return node;
  };
  const client=createVoiceCall({el});const session={playerId:'alice',sessionSecret:'test-only'};
  const widget=()=>client.widget({solo:false,voiceCall:summary()},{id:'alice',controller:'human'}) as HTMLElement;
  const click=()=>widget().querySelector('button')!.click();
  client.enterRoom('ABCDEF',session,()=>{});
  cleanups.push(()=>{client.leaveRoom();dom.window.close();});
  return {client,widget,click,tracks,events,requests,mic,rtc,transport,summary,makeStream,setOthers(v:any[]){others=v;},setJoined(v:boolean){joined=v;active=v;},invite(){invited=true;active=true;events[0].onmessage?.({data:JSON.stringify({type:'invited',callId:'call-1',inviterNickname:'Bob'})});}};
}

it('keeps Hang up and the active microphone through private-channel reconnection',async()=>{
  const t=setup();await flush();t.click();await flush();t.click();
  expect(t.widget().textContent).toContain('Hang up');
  t.events[0].onopen?.();await flush();
  expect(t.widget().textContent).toContain('Hang up');expect(t.tracks[0].stop).not.toHaveBeenCalled();
  (Array.from(t.widget().querySelectorAll('button')).find(b=>b.textContent==='Hang up')!).click();await flush();
  expect(t.tracks[0].stop).toHaveBeenCalled();
});

it.each(['start','accept'])('stops late microphone permission after leaving during %s',async mode=>{
  const t=setup();await flush();const permission=deferred<any>();t.mic.mockImplementation(()=>permission.promise);
  if(mode==='accept'){t.invite();(t.client.incomingInviteModal() as HTMLElement).querySelector('button')!.click();}else t.click();
  t.client.leaveRoom();permission.resolve(t.makeStream());await flush();
  expect(t.tracks[0].stop).toHaveBeenCalled();
  expect(t.requests.some(r=>r.url.endsWith('/start')||r.url.endsWith('/respond'))).toBe(false);
});

it('cleans up server membership if navigation races an in-flight join response',async()=>{
  const t=setup();await flush();const pending=deferred<any>(),original=t.transport.getMockImplementation()!;
  t.transport.mockImplementation(async(url,init)=>url.endsWith('/start')?pending.promise:original(url,init));
  t.click();await flush();t.client.leaveRoom();t.setJoined(true);
  pending.resolve({ok:true,json:async()=>({voiceCall:t.summary()})});await flush();
  expect(t.tracks[0].stop).toHaveBeenCalled();
  expect(t.requests.some(r=>r.url.endsWith('/leave')&&r.body.callId==='call-1')).toBe(true);
});

it('ignores an old own-state response arriving after a successful join',async()=>{
  const t=setup();await flush();const pending=deferred<any>(),original=t.transport.getMockImplementation()!;
  t.transport.mockImplementation(async(url,init)=>url.endsWith('/state')?pending.promise:original(url,init));
  t.events[0].onopen?.();t.click();await flush();t.click();
  pending.resolve({ok:true,json:async()=>({active:false,callId:null,participants:[],own:{status:'none'}})});await flush();
  expect(t.widget().textContent).toContain('Hang up');expect(t.tracks[0].stop).not.toHaveBeenCalled();
});

it('never negotiates an old call signal after hanging up',async()=>{
  const t=setup();await flush();t.click();await flush();t.click();
  Array.from(t.widget().querySelectorAll('button')).find(b=>b.textContent==='Hang up')!.click();await flush();
  t.events[0].onmessage?.({data:JSON.stringify({type:'signal',callId:'call-1',from:'bob',signalType:'offer',data:{type:'offer',sdp:'fake'}})});await flush();
  expect(t.rtc).not.toHaveBeenCalled();
});

it('immediately stops media when the public state removes its call membership',async()=>{
  const t=setup();await flush();t.click();await flush();
  t.client.onStateUpdate({voiceCall:{active:false,callId:null,participants:[]}});
  expect(t.tracks[0].stop).toHaveBeenCalled();
});

it('releases a stale joined row on a new page without requesting the mic',async()=>{
  const t=setup();await flush();t.setJoined(true);t.events[0].onopen?.();await flush();
  expect(t.mic).not.toHaveBeenCalled();expect(t.requests.some(r=>r.url.endsWith('/leave'))).toBe(true);
});

it('ignores an old public snapshot after the join response has a newer revision',async()=>{
  const t=setup();await flush();const original=t.transport.getMockImplementation()!;
  t.transport.mockImplementation(async(url,init)=>{
    const response=await original(url,init);
    if(url.endsWith('/start'))return {ok:true,json:async()=>({voiceCall:t.summary(),epoch:1,rev:5})};
    return response;
  });
  t.click();await flush();t.click();
  t.client.onStateUpdate({epoch:1,rev:4,voiceCall:{active:false,callId:null,participants:[]}});
  expect(t.widget().textContent).toContain('Hang up');expect(t.tracks[0].stop).not.toHaveBeenCalled();
});

it('ignores a delayed ended event for a previous call',async()=>{
  const t=setup();await flush();t.click();await flush();
  t.events[0].onmessage?.({data:JSON.stringify({type:'call_ended',callId:'previous-call'})});
  expect(t.tracks[0].stop).not.toHaveBeenCalled();
});

it('preserves a new private invitation while the previous public snapshot is redrawn',async()=>{
  const t=setup();await flush();t.invite();
  t.client.onStateUpdate({voiceCall:{active:false,callId:null,participants:[]}});
  expect(t.client.incomingInviteModal()?.textContent).toContain('Bob started a voice call');
});

it('retains an authorized offer that arrives before the join HTTP response',async()=>{
  const t=setup();await flush();const pending=deferred<any>(),original=t.transport.getMockImplementation()!;
  t.transport.mockImplementation(async(url,init)=>url.endsWith('/start')?pending.promise:original(url,init));
  t.click();await flush();
  t.setJoined(true);t.setOthers([{playerId:'000',nickname:'Bob',color:'blue',muted:false}]);
  t.events[0].onmessage?.({data:JSON.stringify({type:'signal',callId:'call-1',from:'000',signalType:'offer',data:{type:'offer',sdp:'fake'}})});
  expect(t.rtc).not.toHaveBeenCalled();
  pending.resolve({ok:true,json:async()=>({voiceCall:t.summary()})});await flush();
  expect(t.rtc).toHaveBeenCalledTimes(1);
  expect(t.requests.some(r=>r.url.endsWith('/signal')&&r.body.signalType==='answer')).toBe(true);
});
