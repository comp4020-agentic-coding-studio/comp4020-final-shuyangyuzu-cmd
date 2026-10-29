import {JSDOM} from 'jsdom';
import {afterEach,expect,it,vi} from 'vitest';
import {createMenuBook} from '../public/menuBook.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).forEach(f=>f());vi.unstubAllGlobals();});
function setup(reduced=false){
 const dom=new JSDOM('<body></body>');const doc=dom.window.document;
 vi.stubGlobal('document',doc);vi.stubGlobal('window',dom.window);
 vi.stubGlobal('matchMedia',(q:string)=>({matches:q.includes('reduced')?reduced:true,addEventListener(){}}));
 (dom.window.HTMLDialogElement.prototype as any).showModal=function(){this.setAttribute('open','');};
 (dom.window.HTMLDialogElement.prototype as any).close=function(){this.removeAttribute('open');};
 vi.spyOn(dom.window.HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  const slot=this.classList.contains('book-slot');return {left:slot?624:100,top:slot?114:100,width:slot?500:1042,height:slot?700:728,right:1124,bottom:814,x:100,y:100,toJSON(){}};
 });
 const el=(tag:string,attrs:any={},children:any=[]):any=>{const n=doc.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))(n as any)[k]=v;else n.setAttribute(k,String(v));}for(const c of [].concat(children))if(c!=null)n.append(c);return n;};
 const menu=Array.from({length:4},(_,i)=>({id:String(i),kind:'meal',name:`Meal ${i}`,image:'/test.jpg',imageAlt:'Meal',description:'Test',kcalEstimate:100}));
 const client=createMenuBook({el,mixologyModule:{createMixology:()=>({embed:()=>({root:doc.createElement('div')})}),RECIPES:[],INGREDIENTS:{},scaleRecipe(){},quantity(){}},ordersApi:{fetchMenu:async()=>menu,fetchHeld:async()=>[]}});
 const endOpening=()=>doc.querySelector('.book')!.dispatchEvent(new dom.window.Event('animationend',{bubbles:true}));
 const finishTurn=()=>doc.querySelector('.book-leaf')?.dispatchEvent(new dom.window.Event('animationend',{bubbles:true}));
 cleanup.push(()=>{client.close();dom.window.close();});
 return {client,doc,dom,endOpening,finishTurn};
}
it('only opening scales the frame; chapter navigation turns one unframed leaf',async()=>{
 const t=setup();await t.client.open(t.doc.body,null,{left:20,top:40,width:50,height:30});
 expect(t.doc.querySelector('.menu-book-opening')).not.toBeNull();
 expect(t.doc.querySelectorAll('.book-leaf')).toHaveLength(0);
 t.endOpening();(t.doc.querySelector('[data-bookmark="meal"]') as HTMLElement).click();
 const leaf=t.doc.querySelector('.book-leaf') as HTMLElement;
 expect(leaf).not.toBeNull();expect(leaf.style.width).toBe('500px');
 expect(leaf.querySelector('.book-pages')).toBeNull();expect(leaf.classList.contains('book-leaf--full')).toBe(false);
 expect(t.doc.querySelector('.menu-book-opening')).toBeNull();
 t.finishTurn();expect(t.doc.querySelector('.book-leaf')).toBeNull();
});
it('subtracts the cover border when positioning a turning paper',async()=>{
 const t=setup();await t.client.open(t.doc.body,null);t.endOpening();
 Object.defineProperties(t.doc.querySelector('.book-pages'),{clientLeft:{value:14},clientTop:{value:14}});
 (t.doc.querySelector('[data-bookmark="meal"]') as HTMLElement).click();
 const leaf=t.doc.querySelector('.book-leaf') as HTMLElement;expect(leaf.style.left).toBe('510px');expect(leaf.style.top).toBe('0px');
});
it('reduced motion skips both opening and paper animation without blocking navigation',async()=>{
 const t=setup(true);await t.client.open(t.doc.body,null);(t.doc.querySelector('[data-bookmark="meal"]') as HTMLElement).click();
 expect(t.doc.querySelector('.menu-book-opening,.book-leaf')).toBeNull();expect(t.doc.body.textContent).toContain('Meal 0');
});
it('closing during data loading prevents a late dialog from appearing',async()=>{
 const t=setup();const loading=t.client.open(t.doc.body,null);t.client.close();await loading;expect(t.doc.querySelector('dialog')).toBeNull();
});
