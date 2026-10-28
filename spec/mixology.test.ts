import { JSDOM } from 'jsdom';
import { afterEach,expect,it,vi } from 'vitest';
import { INGREDIENTS,RECIPES,createMixology,missingIngredients,quantity,restoreMixology,scaleRecipe,shoppingList } from '../public/mixology.js';
const recipe=(id:string)=>RECIPES.find(r=>r.id===id)!;
let dom:JSDOM|undefined;
afterEach(()=>{dom?.window.close();dom=undefined;vi.unstubAllGlobals();});
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));};
it('ships sourced recipes with valid ingredient references and positive quantities',()=>{
  expect(new Set(RECIPES.map(r=>r.id)).size).toBe(12);expect(RECIPES.filter(r=>r.alcoholFree)).toHaveLength(3);
  for(const r of RECIPES){expect(r.source.url).toMatch(/^https:\/\//);expect(r.steps.length).toBeGreaterThan(0);for(const i of r.ingredients){expect(Object.hasOwn(INGREDIENTS,i.id)).toBe(true);expect(i.amount).toBeGreaterThan(0);}}
});
it('scales a two-glass source recipe correctly and rejects invalid batch sizes',()=>{
  const scaled=scaleRecipe(recipe('cornhusker'),3);
  expect(scaled.find(i=>i.id==='mint')?.amount).toBe(18);expect(scaled.find(i=>i.id==='strawberries')?.amount).toBe(1.5);
  expect(scaled.find(i=>i.id==='honey')?.amount).toBe(22.5);
  for(const n of [0,21,1.5,NaN])expect(()=>scaleRecipe(recipe('mojito'),n)).toThrow();
  expect(quantity(22.5,'ml')).toBe('22.5 ml');expect(quantity(60,'ml',true)).toBe('≈ 60 ml');
});
it('matches required ingredients without requiring optional garnishes or ice',()=>{
  expect(missingIngredients(recipe('mojito'),new Set(['rum','lime','sugar','soda'])).map(i=>i.id)).toEqual(['mint']);
  expect(missingIngredients(recipe('margarita'),new Set(['tequila','tripleSec','lime']))).toEqual([]);
});
it('combines shopping quantities but never adds incompatible units or hides an estimated top-up',()=>{
  const list=shoppingList({'cuba-libre':2,mojito:1,daiquiri:1,americano:1});
  expect(list.find(i=>i.id==='rum')?.amount).toBe(205);
  expect(list.filter(i=>i.id==='sugar').map(i=>[i.unit,i.amount])).toEqual([['bar spoon',2],['tsp',2]]);
  expect(list.find(i=>i.id==='soda')).toMatchObject({amount:90,estimated:true});
  expect(shoppingList({mojito:1},new Set(['rum']),true).some(i=>i.id==='rum')).toBe(false);
});
it('restores only known ingredients, valid servings and relevant shopping ticks',()=>{
  expect(restoreMixology('{broken').plan).toEqual({});
  const s=restoreMixology(JSON.stringify({pantry:['rum','constructor','unknown'],plan:{mojito:4,daiquiri:0,negroni:100,'cuba-libre':'2'},purchased:['rum:ml','unknown:ml']}));
  expect([...s.pantry]).toEqual(['rum']);expect(s.plan).toEqual({mojito:4});expect([...s.purchased]).toEqual(['rum:ml']);
});
function setup(){
  dom=new JSDOM('<body><div id="overlay"></div></body>',{url:'https://example.test/'});const document=dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');const node=this;queueMicrotask(()=>node.dispatchEvent(new dom!.window.Event('close')));};
  vi.stubGlobal('document',document);vi.stubGlobal('localStorage',dom.window.localStorage);
  vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn(async()=>{throw Error('Permission denied');})}});
  const el=(tag:string,attrs:Record<string,any>={},children:any=[]):HTMLElement=>{
    const node=document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k.startsWith('on'))node.addEventListener(k.slice(2),v);else if(v!==false&&v!=null)node.setAttribute(k,String(v));}
    for(const child of [].concat(children))node.append(child);return node;
  };
  const container=document.getElementById('overlay')!,book=createMixology({el});book.open(container);
  const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes(text))!;
  const input=(label:string)=>document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  const change=(input:HTMLInputElement,value:string,event='input')=>{input.value=value;input.dispatchEvent(new dom!.window.Event(event,{bubbles:true}));};
  return {book,container,document,button,input,change,el};
}
it('supports pantry selection, scaled party planning and persistence without navigating or losing search focus',async()=>{
  const t=setup();t.button('My pantry').click();
  const search=t.input('Find an ingredient');search.focus();t.change(search,'white rum');
  expect(t.document.activeElement).toBe(search);
  (Array.from(t.document.querySelectorAll('label')).find(l=>l.textContent==='White rum')!.querySelector('input') as HTMLInputElement).click();
  t.button('Discover').click();t.document.querySelector<HTMLButtonElement>('[aria-label="View Mojito recipe"]')!.click();
  t.change(t.input('Number of glasses'),'4');t.button('Add to party list').click();t.button('Party list').click();
  expect(t.document.querySelector('.mix-shopping')?.textContent).toContain('180 ml');
  t.input('Bought White rum (ml)').click();
  t.book.close();await flush();const reopened=createMixology({el:t.el});reopened.open(t.container);t.button('Party list').click();
  expect(t.input('Mojito glasses').value).toBe('4');expect(t.input('Bought White rum (ml)').checked).toBe(true);
  t.change(t.input('Mojito glasses'),'5','change');expect(t.input('Bought White rum (ml)').checked).toBe(false);
  reopened.close();
});
it('offers selectable copy text after a real clipboard rejection instead of claiming success',async()=>{
  const t=setup();t.document.querySelector<HTMLButtonElement>('[aria-label="View Cuba Libre recipe"]')!.click();t.button('Add to party list').click();t.button('Party list').click();t.button('Copy shopping list').click();await flush();
  const fallback=t.input('Shopping list to copy') as unknown as HTMLTextAreaElement;
  expect(fallback.hidden).toBe(false);expect(fallback.value).toContain('White rum — 50 ml');
  expect(t.document.querySelector('.mix-feedback')?.textContent).toBe('Select and copy the list below.');
});
it('keeps an immediately reopened book open when the previous dialog’s close event arrives late',async()=>{
  const t=setup();t.book.close();t.book.open(t.container);await flush();expect(t.document.querySelector('dialog[open]')).not.toBeNull();t.book.close();
});
