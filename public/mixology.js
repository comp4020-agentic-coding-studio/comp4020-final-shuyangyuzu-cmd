// Original interface and rewritten methods. Proportions are factual recipe
// data, linked individually to their sources. No remote recipe API is used.
export const INGREDIENTS = {
  rum:['White rum','Spirits & aperitifs'],tequila:['Tequila','Spirits & aperitifs'],gin:['Gin','Spirits & aperitifs'],vodka:['Vodka','Spirits & aperitifs'],
  tripleSec:['Triple sec','Spirits & aperitifs'],campari:['Campari','Spirits & aperitifs'],vermouth:['Sweet red vermouth','Spirits & aperitifs'],aperol:['Aperol','Spirits & aperitifs'],prosecco:['Prosecco','Spirits & aperitifs'],
  lime:['Fresh lime juice','Fruit & mixers'],soda:['Soda water','Fruit & mixers'],cola:['Cola','Fruit & mixers'],gingerBeer:['Alcohol-free ginger beer','Fruit & mixers'],coconut:['Coconut water','Fruit & mixers'],cranberry:['Cranberry juice','Fruit & mixers'],strawberries:['Sliced strawberries','Fruit & mixers'],
  sugar:['White sugar','Bar basics'],syrup:['Simple syrup','Bar basics'],mint:['Fresh mint','Bar basics'],honey:['Honey','Bar basics'],
};
/** @typedef {{id:string,amount:number,unit:string,estimated:boolean}} IngredientMeasure */
/** @param {string} id @param {number} amount */
const item=(id,amount,unit='ml',estimated=false)=>({id,amount,unit,estimated});
const iba=id=>({name:'International Bartenders Association',url:`https://iba-world.com/iba-cocktail/${id}/`,note:'IBA proportions; preparation rewritten for this book.'});
const unl=note=>({name:'University of Nebraska–Lincoln',url:'https://crec.unl.edu/alcohol-and-other-drug-education/mocktail-mixology-drinks-and-recipes/',note});
export const RECIPES = [
  {id:'mojito',name:'Mojito',alcoholFree:false,flavour:'Fresh · citrus · mint',glass:'highball',tone:'#bbd68e',equipment:'Tall glass, spoon',serves:1,source:iba('mojito'),garnish:'Mint and a lime slice',
    ingredients:[item('rum',45),item('lime',20),item('mint',6,'sprig'),item('sugar',2,'tsp'),item('soda',60,'ml',true)],
    steps:['Gently press the mint with sugar and lime juice in a tall glass.','Add a little soda, ice and the rum.','Top with soda and stir lightly. Adjust the top-up to your glass.']},
  {id:'daiquiri',name:'Daiquiri',alcoholFree:false,flavour:'Bright · citrus · crisp',glass:'coupe',tone:'#e5dfa7',equipment:'Shaker, strainer, chilled cocktail glass',serves:1,source:iba('daiquiri'),garnish:'None needed',
    ingredients:[item('rum',60),item('lime',20),item('sugar',2,'bar spoon')],steps:['Stir the rum, lime and sugar in a shaker until the sugar dissolves.','Add ice, shake, then strain into a chilled glass.']},
  {id:'margarita',name:'Margarita',alcoholFree:false,flavour:'Citrus · tangy · orange',glass:'coupe',tone:'#c9d59a',equipment:'Shaker, strainer, chilled cocktail glass',serves:1,source:iba('margarita'),garnish:'Optional salt on half the rim',
    ingredients:[item('tequila',50),item('tripleSec',20),item('lime',15)],steps:['Shake the measured ingredients with ice.','Strain into a chilled glass; salt half the rim if desired.']},
  {id:'negroni',name:'Negroni',alcoholFree:false,flavour:'Bitter · herbal · orange',glass:'rocks',tone:'#c96442',equipment:'Rocks glass, spoon',serves:1,source:iba('negroni'),garnish:'Half an orange slice',
    ingredients:[item('gin',30),item('campari',30),item('vermouth',30)],steps:['Fill a chilled rocks glass with ice.','Add the three equal measures and stir gently.']},
  {id:'americano',name:'Americano',alcoholFree:false,flavour:'Bitter · sparkling · herbal',glass:'rocks',tone:'#c67d49',equipment:'Rocks glass, spoon',serves:1,source:iba('americano'),garnish:'Orange slice and lemon zest',
    ingredients:[item('campari',30),item('vermouth',30),item('soda',30,'ml',true)],steps:['Pour Campari and vermouth over ice.','Finish with a splash of soda and a gentle stir.']},
  {id:'cuba-libre',name:'Cuba Libre',alcoholFree:false,flavour:'Cola · lime · refreshing',glass:'highball',tone:'#805638',equipment:'Tall glass, spoon',serves:1,source:iba('cuba-libre'),garnish:'Lime wedge',
    ingredients:[item('rum',50),item('cola',120),item('lime',10)],steps:['Fill a tall glass with ice.','Pour in rum, cola and fresh lime juice; gently combine.']},
  {id:'moscow-mule',name:'Moscow Mule',alcoholFree:false,flavour:'Ginger · citrus · lively',glass:'mug',tone:'#d4b974',equipment:'Mug or rocks glass, spoon',serves:1,source:iba('moscow-mule'),garnish:'Lime slice',
    ingredients:[item('vodka',45),item('gingerBeer',120),item('lime',10)],steps:['Combine vodka and ginger beer in a mug or rocks glass with ice.','Stir in the lime juice gently.']},
  {id:'spritz',name:'Spritz',alcoholFree:false,flavour:'Orange · bittersweet · bubbly',glass:'wine',tone:'#e19850',equipment:'Wine glass, spoon',serves:1,source:iba('spritz'),garnish:'Orange slice',
    ingredients:[item('prosecco',90),item('aperol',60),item('soda',30,'ml',true)],steps:['Add the ingredients to an ice-filled wine glass.','Stir gently, keeping the bubbles. Adjust the soda splash to taste.']},
  {id:'husker-mule',name:'Husker Mule',alcoholFree:true,flavour:'Ginger · lime · sparkling',glass:'mug',tone:'#e4cd86',equipment:'Glass or mug, spoon',serves:1,source:unl('House planning measures adapted from the source’s unmeasured ginger, lime and soda combination.'),garnish:'Optional mint',
    ingredients:[item('gingerBeer',120,'ml',true),item('lime',15,'ml',true),item('soda',60,'ml',true)],steps:['Combine the liquids over ice.','Stir and adjust the lime and soda to taste. Choose alcohol-free ginger beer.']},
  {id:'sweetheart',name:'Sweetheart Serenade',alcoholFree:true,flavour:'Cranberry · coconut · soft citrus',glass:'highball',tone:'#cf8a8f',equipment:'Tall glass, spoon',serves:1,source:unl('Adapted from Husker Sweetheart Serenade with cranberry juice and rounded metric measures.'),garnish:'Optional lime slice',
    ingredients:[item('lime',7.5),item('syrup',15),item('cranberry',80),item('coconut',90)],steps:['Stir the lime, syrup and cranberry juice together.','Add ice, then pour in the coconut water.']},
  {id:'cornhusker',name:'Cornhusker Crush',alcoholFree:true,flavour:'Strawberry · mint · fresh',glass:'highball',tone:'#d59394',equipment:'Blender, glasses',serves:2,source:unl('Two-glass source recipe; cup = 240 ml and tablespoon = 15 ml for planning.'),garnish:'Optional berries, mint or lime',
    ingredients:[item('coconut',120),item('strawberries',1,'cup'),item('mint',12,'leaf'),item('lime',30),item('honey',15),item('soda',240)],steps:['Blend everything except the soda until smooth.','Divide over ice and add the soda last.']},
];
const STORE='vegas:mixology:v1';
const plural={sprig:'sprigs',leaf:'leaves','bar spoon':'bar spoons',cup:'cups'};
export function quantity(amount,unit,estimated=false){return `${estimated?'≈ ':''}${Number(amount.toFixed(2))} ${amount===1?unit:plural[unit]||unit}`;}
/** @param {{ingredients:IngredientMeasure[],serves:number}} recipe @param {number} servings */
export function scaleRecipe(recipe,servings){
  if(!Number.isInteger(servings)||servings<1||servings>20)throw new RangeError('Choose 1–20 glasses.');
  return recipe.ingredients.map(i=>({...i,amount:i.amount*servings/recipe.serves}));
}
/** @param {{ingredients:IngredientMeasure[]}} recipe @param {Set<string>} pantry */
export function missingIngredients(recipe,pantry){return recipe.ingredients.filter(i=>!pantry.has(i.id));}
export function shoppingList(plan,pantry=new Set(),missingOnly=false){
  const totals=new Map();
  for(const [id,count] of Object.entries(plan)){
    const recipe=RECIPES.find(r=>r.id===id);if(!recipe)continue;
    for(const i of scaleRecipe(recipe,count)){
      if(missingOnly&&pantry.has(i.id))continue;
      const key=`${i.id}:${i.unit}`,old=totals.get(key);
      totals.set(key,{...i,key,amount:i.amount+(old?.amount||0),estimated:i.estimated||!!old?.estimated});
    }
  }
  return [...totals.values()].sort((a,b)=>INGREDIENTS[a.id][0].localeCompare(INGREDIENTS[b.id][0])||a.unit.localeCompare(b.unit));
}
export function restoreMixology(raw){
  let data;try{data=JSON.parse(raw||'{}');}catch{data={};}
  if(!data||typeof data!=='object')data={};
  const pantry=new Set((Array.isArray(data.pantry)?data.pantry:[]).filter(id=>Object.hasOwn(INGREDIENTS,id)));
  const plan={};
  for(const recipe of RECIPES){const n=data.plan?.[recipe.id];if(Number.isInteger(n)&&n>=1&&n<=20)plan[recipe.id]=n;}
  const keys=new Set(shoppingList(plan).map(i=>i.key));
  return {pantry,plan,purchased:new Set((Array.isArray(data.purchased)?data.purchased:[]).filter(k=>keys.has(k)))};
}

export function createMixology({el}){
  let state=null,dialog=null,view='discover',detail=null,query='',type='all',match='all',previousFocus=null,unavailable=false;
  let main,navButtons,status;
  function save(){try{localStorage.setItem(STORE,JSON.stringify({pantry:[...state.pantry],plan:state.plan,purchased:[...state.purchased]}));}catch{unavailable=true;if(status)status.textContent='Browser storage is unavailable. Your changes last for this page only.';}}
  function nav(){
    for(const [name,button] of Object.entries(navButtons)){button.setAttribute('aria-pressed',String(view===name));button.classList.toggle('selected',view===name);}
    navButtons.pantry.textContent=`My pantry · ${state.pantry.size}`;
    navButtons.party.textContent=`Party list · ${Object.keys(state.plan).length}`;
  }
  const art=r=>el('div',{class:`drink-art drink-${r.glass}`,style:`--drink-tone:${r.tone}`,'aria-hidden':'true'},[el('span',{class:'drink-vessel'}),el('span',{class:'drink-garnish'}),el('span',{class:'drink-stem'})]);
  function close(){if(dialog){const old=dialog;dialog=null;old.close();old.remove();if(previousFocus?.isConnected)previousFocus.focus();}}
  function switchView(next){view=next;detail=null;render();}
  function render(){
    nav();status.textContent=unavailable?'Browser storage is unavailable. Your changes last for this page only.':'Saved on this device · pantry availability, not stock quantities';
    if(detail)renderDetail();else if(view==='pantry')renderPantry();else if(view==='party')renderParty();else renderDiscover();
    main.scrollTop=0;
  }
  function renderDiscover(){
    const search=el('input',{type:'search',placeholder:'Try lime, Mojito, ginger…',value:query,'aria-label':'Find a drink',oninput:e=>{query=e.target.value;updateCards();}});
    const kind=el('select',{'aria-label':'Drink type',onchange:e=>{type=e.target.value;updateCards();}},[['all','All drinks'],['cocktail','Cocktails'],['free','Alcohol-free']].map(([value,label])=>el('option',{value,selected:type===value},label)));
    const matches=el('select',{'aria-label':'Pantry match',onchange:e=>{match=e.target.value;updateCards();}},[['all','All recipes'],['ready','Ingredients on hand'],['almost','Missing 1–2 ingredients']].map(([value,label])=>el('option',{value,selected:match===value},label)));
    const count=el('p',{class:'mix-result-count',role:'status'}),grid=el('div',{class:'mix-grid'});
    main.replaceChildren(el('section',{class:'mix-intro'},[el('div',{},[el('p',{class:'mix-eyebrow'},'FROM OUR BAR TO YOURS'),el('h2',{},'A good evening starts here.'),el('p',{},'A small recipe book for real gatherings. Find a drink, check your ingredients, and make a little plan.')]),art(RECIPES[7])]),
      el('div',{class:'mix-pantry-callout'},[`${RECIPES.length} recipes · ${RECIPES.filter(r=>r.alcoholFree).length} alcohol-free · Ice assumed on hand`,el('button',{onclick:()=>switchView('pantry')},state.pantry.size?'Edit my pantry':'Choose my ingredients')]),
      el('div',{class:'mix-filters'},[search,kind,matches]),count,grid);
    function updateCards(){
      const q=query.trim().toLowerCase();
      const recipes=RECIPES.filter(r=>(type==='all'||(type==='free')===r.alcoholFree)&&(!q||[r.name,r.flavour,...r.ingredients.map(i=>INGREDIENTS[i.id][0])].join(' ').toLowerCase().includes(q)))
        .map(r=>({r,missing:missingIngredients(r,state.pantry)})).filter(({missing})=>match==='all'||match==='ready'&&missing.length===0||match==='almost'&&missing.length>=1&&missing.length<=2)
        .sort((a,b)=>a.missing.length-b.missing.length||a.r.name.localeCompare(b.r.name));
      count.textContent=`${recipes.length} ${recipes.length===1?'recipe':'recipes'} found`;
      grid.replaceChildren(...recipes.map(({r,missing})=>el('article',{class:'mix-card'},[
        el('div',{class:'mix-card-art'},[art(r),el('span',{class:`mix-badge ${r.alcoholFree?'free':''}`},r.alcoholFree?'Alcohol-free':'Cocktail')]),
        el('div',{class:'mix-card-copy'},[el('h3',{},r.name),el('p',{class:'mix-flavour'},r.flavour),el('p',{class:'mix-match'},missing.length?`Missing ${missing.length} · ${missing.slice(0,2).map(i=>INGREDIENTS[i.id][0]).join(', ')}${missing.length>2?'…':''}`:'✓ All recipe ingredients on hand'),
          el('button',{'aria-label':`View ${r.name} recipe`,onclick:()=>{detail=r.id;render();}},'View recipe →')]),
      ])));
      if(!recipes.length)grid.append(el('div',{class:'mix-empty'},[el('h3',{},'Nothing in this round.'),el('p',{},'Try a different search or pantry filter.'),el('button',{onclick:()=>{query='';type='all';match='all';renderDiscover();}},'Show all recipes')]));
    }
    updateCards();
  }
  function renderPantry(){
    const search=el('input',{type:'search',placeholder:'Find an ingredient…','aria-label':'Find an ingredient',oninput:e=>{const q=e.target.value.toLowerCase();for(const row of rows)row.node.hidden=!row.name.toLowerCase().includes(q);for(const group of groups)group.hidden=[...group.querySelectorAll('.mix-ingredient')].every(row=>row.hidden);}});
    const rows=[],groups=[];
    for(const group of [...new Set(Object.values(INGREDIENTS).map(i=>i[1]))]){
      const list=el('div',{class:'mix-ingredients'});
      for(const [id,[name,category]] of Object.entries(INGREDIENTS))if(category===group){
        const checkbox=el('input',{type:'checkbox',checked:state.pantry.has(id),onchange:e=>{if(e.target.checked)state.pantry.add(id);else state.pantry.delete(id);save();nav();status.textContent=unavailable?'Changes last for this page only.':`${state.pantry.size} ingredients saved on this device`;}});
        const node=el('label',{class:'mix-ingredient'},[checkbox,el('span',{},name)]);rows.push({name,node,checkbox,id});list.append(node);
      }
      groups.push(el('section',{class:'mix-pantry-group'},[el('h3',{},group),list]));
    }
    main.replaceChildren(el('h2',{},'What’s in your home bar?'),el('p',{class:'mix-subtitle'},'Tick the ingredients you have. This records availability; check that you have enough for the quantities in your plan.'),
      el('div',{class:'mix-pantry-tools'},[search,el('button',{onclick:()=>{state.pantry.clear();for(const r of rows)r.checkbox.checked=false;save();nav();}},'Clear pantry'),el('button',{class:'mix-primary',onclick:()=>switchView('discover')},'Find matching drinks')]),...groups);
  }
  function renderDetail(){
    const r=RECIPES.find(r=>r.id===detail);let servings=state.plan[r.id]||1;
    const amounts=el('ul',{class:'mix-measures'}),message=el('p',{role:'status',class:'mix-feedback'});
    const updateAmounts=()=>amounts.replaceChildren(...scaleRecipe(r,servings).map(i=>el('li',{},[el('span',{},INGREDIENTS[i.id][0]),el('strong',{},quantity(i.amount,i.unit,i.estimated)),el('small',{class:state.pantry.has(i.id)?'on-hand':'missing'},state.pantry.has(i.id)?'On hand':'Not in pantry')])));
    const number=el('input',{type:'number',min:1,max:20,step:1,value:String(servings),'aria-label':'Number of glasses',oninput:e=>{
      const n=Number(e.target.value);if(!Number.isInteger(n)||n<1||n>20){message.textContent='Choose 1–20 whole glasses.';add.disabled=true;return;}servings=n;add.disabled=false;message.textContent='';updateAmounts();
    }});
    const add=el('button',{class:'mix-primary',onclick:()=>{state.plan[r.id]=servings;state.purchased.clear();save();nav();message.textContent=`${servings} ${servings===1?'glass':'glasses'} of ${r.name} saved to your party list.`;}},state.plan[r.id]?'Update party list':'Add to party list');
    main.replaceChildren(el('button',{class:'mix-back',onclick:()=>{detail=null;render();}},'← Back to recipes'),
      el('section',{class:'mix-detail-hero'},[art(r),el('div',{},[el('p',{class:'mix-eyebrow'},r.alcoholFree?'ALCOHOL-FREE':'CLASSIC COCKTAIL'),el('h2',{},r.name),el('p',{},r.flavour),el('small',{},`You’ll need: ${r.equipment}`)])]),
      el('div',{class:'mix-detail-columns'},[el('section',{},[el('h3',{},'Your measures'),el('label',{class:'mix-servings'},['Number of glasses ',number]),amounts,el('p',{class:'mix-small'},'≈ is a planning estimate for a splash or top-up. Adjust it to your glass. Ice and optional garnish are extra.'),add,message]),
        el('section',{class:'mix-method'},[el('h3',{},'Make it'),el('ol',{},r.steps.map(s=>el('li',{},s))),el('p',{},`Garnish: ${r.garnish}.`),el('div',{class:'mix-source'},[el('p',{},r.source.note),el('a',{href:r.source.url,target:'_blank',rel:'noopener'},`Recipe source · ${r.source.name}`)])])]),
      el('button',{onclick:()=>switchView('party')},'Open party list →'));
    updateAmounts();
  }
  function renderParty(){
    const selected=Object.entries(state.plan),total=selected.reduce((n,[,s])=>n+s,0);
    if(!selected.length){main.replaceChildren(el('div',{class:'mix-empty'},[el('p',{class:'mix-eyebrow'},'A LITTLE PLAN GOES A LONG WAY'),el('h2',{},'Your party list is empty.'),el('p',{},'Open a recipe, choose the number of glasses and add it here. We’ll combine the ingredients for you.'),el('button',{class:'mix-primary',onclick:()=>switchView('discover')},'Find a drink')]));return;}
    const totals=el('ul',{class:'mix-shopping'}),message=el('p',{class:'mix-feedback',role:'status'}),fallback=el('textarea',{'aria-label':'Shopping list to copy',readonly:true,hidden:true,rows:8});let onlyMissing=false;
    const listText=()=>['LAS VEGAS · PARTY LIST',...selected.map(([id,n])=>`${RECIPES.find(r=>r.id===id).name}: ${n} glasses`),'',...(shoppingList(state.plan,state.pantry,onlyMissing).map(i=>`${state.purchased.has(i.key)?'[x]':'[ ]'} ${INGREDIENTS[i.id][0]} — ${quantity(i.amount,i.unit,i.estimated)}`)),'','≈ marks planning estimates. Ice and optional garnish are extra.','Pantry records availability, not quantities.'].join('\n');
    const updateTotals=()=>{
      const list=shoppingList(state.plan,state.pantry,onlyMissing);
      totals.replaceChildren(...list.map(i=>el('li',{},[el('label',{},[el('input',{type:'checkbox',checked:state.purchased.has(i.key),'aria-label':`Bought ${INGREDIENTS[i.id][0]} (${i.unit})`,onchange:e=>{if(e.target.checked)state.purchased.add(i.key);else state.purchased.delete(i.key);save();}}),el('span',{},INGREDIENTS[i.id][0])]),el('strong',{},quantity(i.amount,i.unit,i.estimated)),el('small',{},state.pantry.has(i.id)?'In pantry':'To get')])));
      if(!list.length)totals.append(el('li',{},'All selected ingredients are in your pantry. Check quantities before mixing.'));
      fallback.hidden=true;message.textContent='';
    };
    main.replaceChildren(el('h2',{},'A plan for your next gathering.'),el('p',{class:'mix-subtitle'},`${total} glasses · ${selected.length} ${selected.length===1?'recipe':'recipes'} · Saved on this device`),
      el('div',{class:'mix-planned'},selected.map(([id,n])=>{const r=RECIPES.find(r=>r.id===id);return el('div',{},[el('strong',{},r.name),el('label',{},['Glasses ',el('input',{type:'number',min:1,max:20,step:1,value:String(n),'aria-label':`${r.name} glasses`,onchange:e=>{const v=Number(e.target.value);if(!Number.isInteger(v)||v<1||v>20){e.target.value=String(state.plan[id]);return;}state.plan[id]=v;state.purchased.clear();save();renderParty();}})]),el('button',{'aria-label':`Remove ${r.name}`,onclick:()=>{delete state.plan[id];state.purchased.clear();save();nav();renderParty();}},'Remove')]);})),
      el('div',{class:'mix-shopping-heading'},[el('h3',{},'Your ingredients'),el('label',{},[el('input',{type:'checkbox',onchange:e=>{onlyMissing=e.target.checked;updateTotals();}}),' Only ingredients not in my pantry'])]),
      el('p',{class:'mix-small'},'These are total recipe quantities. Pantry ticks do not measure how much you own. ≈ marks estimated top-ups; ice and garnish are extra.'),totals,
      el('div',{class:'mix-copy-actions'},[el('button',{class:'mix-primary',onclick:async()=>{
        const text=listText();try{if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');await navigator.clipboard.writeText(text);message.textContent='Shopping list copied.';}
        catch{fallback.value=text;fallback.hidden=false;fallback.focus();fallback.select();message.textContent='Select and copy the list below.';}
      }},'Copy shopping list'),el('button',{onclick:()=>switchView('discover')},'Add another drink')]),message,fallback);
    updateTotals();
  }
  function open(container){
    if(dialog)return;
    if(!state){try{state=restoreMixology(localStorage.getItem(STORE));}catch{state=restoreMixology(null);unavailable=true;}}
    previousFocus=document.activeElement;view='discover';detail=null;
    navButtons={};main=el('div',{class:'mix-main'});status=el('p',{class:'mix-storage'});
    const navigation=el('nav',{'aria-label':'Mixology sections'});
    for(const [id,label] of [['discover','Discover'],['pantry','My pantry'],['party','Party list']]){const b=el('button',{onclick:()=>switchView(id)},label);navButtons[id]=b;navigation.append(b);}
    dialog=el('dialog',{class:'mixology-book','aria-labelledby':'mixology-title'},[
      el('header',{class:'mix-header'},[el('div',{},[el('p',{class:'mix-eyebrow'},'LAS VEGAS · THE COUNTER'),el('h1',{id:'mixology-title'},'The mixology book')]),el('button',{class:'mix-close','aria-label':'Close mixology book',onclick:close},'×')]),navigation,main,status,
    ]);
    const book=dialog;book.addEventListener('close',()=>{if(dialog===book)close();});container.append(dialog);render();dialog.showModal();
  }
  return {open,close};
}
