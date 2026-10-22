import { JSDOM } from 'jsdom';
import { afterEach,expect,it,vi } from 'vitest';
import { createPokerUI } from '../public/poker.js';
let dom:JSDOM;
afterEach(()=>{dom?.window.close();vi.unstubAllGlobals();});
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
function setup(){
  dom=new JSDOM('<body><div id="app"></div></body>',{url:'https://example.test/?poker=table'});
  const document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  vi.stubGlobal('document',document);vi.stubGlobal('window',dom.window);vi.stubGlobal('localStorage',dom.window.localStorage);
  vi.stubGlobal('setInterval',vi.fn());
  dom.window.localStorage.setItem('vegas:bar:session',JSON.stringify({playerId:'alice',sessionSecret:'synthetic-test-only'}));
  let pending=true,fail=false;
  const fetch=vi.fn(async(url:string)=>({ok:!url.endsWith('/ack-exit')||!fail,json:async()=>{
    if(url.endsWith('/me'))return {room:null,invites:[],departure:pending?{id:'notice-1',reason:'bankrupt',roomId:'table',hand:2,result:'Bob +1000'}:null};
    if(fail)return{message:'Temporary failure'};pending=false;return{ok:true};
  }}));
  vi.stubGlobal('fetch',fetch);
  const el=(tag:string,attrs:Record<string,any>={},children:any=[]):HTMLElement=>{
    const node=document.createElement(tag);
    for(const[k,v]of Object.entries(attrs)){
      if(k.startsWith('on'))node.addEventListener(k.slice(2),v);
      else if(v!==false&&v!=null)node.setAttribute(k,String(v));
    }
    for(const c of [].concat(children))node.append(c);return node;
  };
  const navigate=vi.fn(),client=createPokerUI({el,navigate});client.mount();
  const button=()=>document.querySelector('dialog button') as HTMLButtonElement;
  return {navigate,fetch,button,document,setFailure(value:boolean){fail=value;}};
}
it('shows a bankruptcy modal and waits for the player to click Return to the bar before navigating',async()=>{
  const t=setup();await flush();
  expect(t.document.querySelector('dialog[open]')?.textContent).toContain('Out of chips');
  expect(t.document.querySelector('dialog')?.textContent).toContain('Bob +1000');
  expect(t.navigate).not.toHaveBeenCalled();
  t.button().click();await flush();
  expect(t.navigate).toHaveBeenCalledExactlyOnceWith('/');
  expect(t.document.querySelector('dialog')).toBeNull();
  expect(t.fetch.mock.calls.some(([url])=>url.endsWith('/leave'))).toBe(false);
});
it('keeps the popup and restores the button after a failed acknowledgement so it can be retried',async()=>{
  const t=setup();t.setFailure(true);await flush();t.button().click();await flush();
  expect(t.navigate).not.toHaveBeenCalled();expect(t.button().disabled).toBe(false);
  expect(t.document.querySelector('dialog')?.textContent).toContain('Temporary failure');
  t.setFailure(false);t.button().click();await flush();expect(t.navigate).toHaveBeenCalledExactlyOnceWith('/');
});
