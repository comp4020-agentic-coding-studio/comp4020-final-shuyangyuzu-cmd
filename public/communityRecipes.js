// Account-backed recipes, mounted inside the existing physical menu book.
// All user text is rendered as text nodes. No user HTML/CSS is accepted.
export function createCommunityBook({ house, model }) {
    const { RECIPE_UNITS, recipeMeasures, recipeShopping, ingredientKey } = model;
    const n = (tag, attrs = {}, ...children) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('on'))
            e.addEventListener(k.slice(2), v);
        else if (k === 'class')
            e.className = v;
        else if (k in e && k !== 'list')
            e[k] = v;
        else
            e.setAttribute(k, v);
    } e.append(...children.flat().filter(x => x !== null && x !== undefined).map(x => x instanceof Node ? x : document.createTextNode(String(x)))); return e; };
    const button = (text, fn, cls = '') => n('button', { type: 'button', class: cls, onclick: () => run(fn) }, text);
    let root, main, notice, nav, account = null, lib = null, screen = 'discover', draft = null, editRevision = 0, dirty = false, editId, saveTimer, savePromise = null, saveError = null, disposed = true, epoch = 0, readSeq = 0, poll, dialog;
    let reloadDiscover = null, identityPending = false;
    let query = '', source = 'all', alcohol = 'all', match = 'all', page = 0, searchTimer, preview = false, partyTab = 'saved', importedLegacy = null;
    const empty = () => ({ name: '', description: '', tags: [], equipment: '', alcoholFree: false, serves: 1, imageId: null, imageWidth: 35, imageX: 50, imageY: 50, imageZoom: 1, ingredients: [{ name: '', amount: null, unit: 'ml' }], steps: [''], garnish: '' });
    const say = (text, bad = false) => { if (notice) {
        notice.textContent = text;
        notice.className = 'cr-notice' + (bad ? ' cr-error' : '');
    } };
    async function run(fn) { try {
        await fn();
    }
    catch (e) {
        if (!disposed)
            say(e.message || 'Something went wrong. Please retry.', true);
    } }
    async function api(path, data, raw = false) { const generation = epoch; const r = await fetch('/api/community/' + path, { credentials: 'same-origin', cache: 'no-store', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }, body: raw ? data : JSON.stringify(data) }) }); const result = await r.json(); if (generation !== epoch)
        throw Error('Your account changed. Please reopen the book.'); if (!r.ok) {
        if (r.status === 401) {
            account = null;
            lib = null;
            epoch++;
            draft = null;
            dirty = false;
            clearTimeout(saveTimer);
            renderNav();
            main.replaceChildren(loginNote());
        }
        throw Error(result.message || result.error || 'Request failed.');
    } return result; }
    const loginNote = () => n('div', { class: 'cr-empty' }, n('h2', {}, 'Make this book yours'), n('p', {}, 'Log in from Your character to publish recipes and keep your pantry, saved recipes and party plan across devices. You can browse all public recipes here.'));
    const requireLogin = () => { if (!account)
        throw Error('Log in from Your character first.'); };
    const backupKey = () => account ? 'vegas:recipe-draft:' + account.id : null;
    function backup() { const key = backupKey(); if (key && draft)
        try {
            sessionStorage.setItem(key, JSON.stringify({ id: editId, revision: editRevision, recipe: draft }));
        }
        catch { } }
    function changed() { dirty = true; saveError = null; backup(); say('Unsaved draft…'); clearTimeout(saveTimer); saveTimer = setTimeout(() => run(() => flush()), 900); }
    async function flush() {
        clearTimeout(saveTimer);
        if (savePromise)
            await savePromise;
        if (saveError)
            throw saveError;
        if (!dirty || !draft)
            return;
        const generation = epoch, copy = JSON.parse(JSON.stringify(draft)), id = editId, revision = editRevision;
        dirty = false;
        savePromise = api('draft', { id, revision, recipe: copy }).then(result => { if (generation !== epoch)
            return; editId = result.id; editRevision = result.revision; say('Draft saved · only you can see these edits'); if (!dirty) {
            const key = backupKey();
            if (key)
                sessionStorage.removeItem(key);
        }
        else
            backup(); }).catch(e => { if (generation === epoch) {
            dirty = true;
            saveError = e;
            backup();
        } throw e; }).finally(() => { savePromise = null; });
        await savePromise;
        if (dirty && !saveError)
            await flush();
    }
    async function changeScreen(next) { await flush(); draft = null; preview = false; screen = next; renderNav(); await render(); main.scrollTop = 0; }
    function renderNav() { if (!nav)
        return; nav.replaceChildren(...[['discover', 'Discover'], ['pantry', 'My pantry'], ['party', 'Party list'], ['mine', 'My Recipes'], ...(account?.admin ? [['moderation', 'Review reports']] : [])].map(([key, label]) => button(label, () => changeScreen(key), screen === key ? 'active' : ''))); }
    const field = (label, input) => n('label', { class: 'cr-field' }, n('span', {}, label), input);
    const select = (items, value, change, label) => n('select', { 'aria-label': label, value, onchange: e => change(e.target.value) }, items.map(([v, t]) => n('option', { value: v, selected: v === value }, t)));
    function image(r) { if (!r.imageId) {
        const original = house.RECIPES.find(x => 'house:' + x.id === r.id);
        return n('div', { class: 'cr-placeholder', 'aria-label': 'Drink illustration' }, original ? n('div', { class: 'drink-art drink-' + original.glass, style: '--drink-tone:' + original.tone, 'aria-hidden': 'true' }, n('span', { class: 'drink-vessel' }), n('span', { class: 'drink-garnish' }), n('span', { class: 'drink-stem' })) : '🍹');
    } return n('img', { src: '/api/community/images/' + encodeURIComponent(r.imageId), alt: r.name || 'Drink photograph', loading: 'lazy', style: `object-position:${r.imageX}% ${r.imageY}%;transform:scale(${r.imageZoom})` }); }
    function hero(r, editing = false) {
        const pic = n('div', { class: 'cr-photo' }, image(r));
        const copy = n('div', { class: 'cr-hero-copy' }, n('small', {}, editing ? 'YOUR RECIPE' : r.source === 'house' ? 'HOUSE RECIPE' : 'COMMUNITY RECIPE'), n('h2', {}, r.name || 'Your drink name'), n('p', {}, r.description || 'A drink worth sharing.'), n('p', { class: 'cr-muted' }, r.equipment ? 'You’ll need: ' + r.equipment : ''), !editing ? n('small', {}, 'By ' + (r.author || account?.username || 'you')) : null);
        const h = n('div', { class: 'cr-hero'+(editing?' cr-hero-edit':''), style: `--photo-width:${r.imageWidth}%;--hero-height:${r.heroHeight??260}px` }, pic, copy);
        if (editing) {
            const paintPhoto=()=>{
                const controls=n('div',{class:'cr-photo-actions'});
                const upload=n('input',{type:'file',hidden:true,accept:'image/jpeg,image/png,image/webp','aria-label':'Choose drink photo',onchange:e=>run(async()=>{
                    const file=e.target.files[0];if(!file)return;
                    if(file.size>5*1024*1024)throw Error('Choose a photo up to 5 MB.');
                    const thisDraft=draft;say('Preparing photo…');
                    const result=await api('images',file,true);if(draft!==thisDraft)return;
                    r.imageId=result.id;r.imageX=50;r.imageY=50;r.imageZoom=1;changed();paintPhoto();
                })});
                controls.append(button(r.imageId?'Change photo':'+ Add photo',()=>upload.click()));
                if(r.imageId)controls.append(button('Remove',()=>{r.imageId=null;changed();paintPhoto();}));
                pic.replaceChildren(image(r),controls,upload);
            };
            paintPhoto();
            const grip = n('button', { type: 'button', class: 'cr-divider', 'aria-label': 'Resize photo area', 'aria-valuemin': '20', 'aria-valuemax': '60', 'aria-valuenow': r.imageWidth, role: 'slider', style: `left:${r.imageWidth}%` }, '⋮');
            let dragging = false;
            const update = value => { r.imageWidth = Math.max(20, Math.min(60, Math.round(value))); h.style.setProperty('--photo-width', r.imageWidth + '%'); grip.style.left = r.imageWidth + '%'; grip.setAttribute('aria-valuenow', r.imageWidth); changed(); };
            grip.onpointerdown = e => { dragging = true; grip.setPointerCapture(e.pointerId); };
            grip.onpointermove = e => { if (dragging) {
                const box = h.getBoundingClientRect();
                update((e.clientX - box.left) / box.width * 100);
            } };
            grip.onpointerup = () => dragging = false;
            grip.onpointercancel = () => dragging = false;
            grip.onkeydown = e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                update(r.imageWidth + (e.key === 'ArrowRight' ? 1 : -1));
            } };
            h.append(grip);
            const bottom=n('button',{type:'button',class:'cr-bottom-edge',role:'slider','aria-label':'Resize header height','aria-orientation':'vertical','aria-valuemin':180,'aria-valuemax':440,'aria-valuenow':r.heroHeight??260,title:'Drag up or down to resize'},'');
            let resizing=false,startY=0,startHeight=0;
            const resize=value=>{r.heroHeight=Math.max(180,Math.min(440,Math.round(value)));h.style.setProperty('--hero-height',r.heroHeight+'px');bottom.setAttribute('aria-valuenow',r.heroHeight);changed();};
            bottom.onpointerdown=e=>{e.preventDefault();resizing=true;startY=e.clientY;startHeight=h.getBoundingClientRect().height;bottom.setPointerCapture(e.pointerId);};
            bottom.onpointermove=e=>{if(resizing)resize(startHeight+e.clientY-startY);};
            bottom.onpointerup=()=>resizing=false;bottom.onpointercancel=()=>resizing=false;
            bottom.onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();resize((r.heroHeight??260)+(e.key==='ArrowDown'?10:-10));}};
            h.append(bottom);
        }
        return h;
    }
    async function updateLibrary(action, extra = {}) { requireLogin(); try {
        lib = await api('library', { version: lib.version, action, ...extra });
    }
    catch (e) {
        const state = await api('me');
        lib = state.library;
        throw e;
    } }
    function card(r, extras = []) { return n('article', { class: 'cr-card' }, n('div', { class: 'cr-card-image' }, image(r)), n('div', {}, n('small', {}, r.source === 'house' ? 'HOUSE RECIPE' : 'COMMUNITY · ' + r.author), n('h3', {}, r.name), n('p', {}, r.description), button('View recipe', () => showRecipe(r.id)), ...extras)); }
    async function discover() {
        let lastResult = '';
        const search = n('input', { type: 'search', placeholder: 'Drink, ingredient, tag or creator…', value: query, 'aria-label': 'Search recipes', maxlength: 120, oninput: e => { query = e.target.value; page = 0; clearTimeout(searchTimer); searchTimer = setTimeout(() => run(load), 220); } });
        const filters = n('div', { class: 'cr-tools' }, search, select([['all', 'All recipes'], ['house', 'House recipes'], ['community', 'Community recipes']], source, v => { source = v; page = 0; run(load); }, 'Recipe source'), select([['all', 'All drinks'], ['free', 'Alcohol-free'], ['cocktail', 'With alcohol']], alcohol, v => { alcohol = v; page = 0; run(load); }, 'Alcohol filter'), select([['all', 'Any ingredients'], ['ready', 'Ready from my pantry'], ['almost', 'Missing 1–2 ingredients']], match, v => { match = v; page = 0; run(load); }, 'Pantry filter'), button('+ Create recipe', () => newDraft(), 'cr-primary'));
        const list = n('div', { class: 'cr-grid' }), pager = n('div', { class: 'cr-tools' }), count = n('p', { class: 'cr-muted' });
        main.replaceChildren(n('h1', {}, 'A recipe worth sharing'), n('p', {}, 'House favourites and drinks made by this community.'), filters, count, list, pager);
        async function load() { const seq = ++readSeq; const result = await api('discover?' + new URLSearchParams({ q: query, source, alcohol, match, page: String(page) })); if (seq !== readSeq || screen !== 'discover' || disposed)
            return; const fingerprint = JSON.stringify(result); if (fingerprint === lastResult)
            return; lastResult = fingerprint; count.textContent = result.total + ' recipes' + (query ? ' · closest and related matches' : ''); list.replaceChildren(...result.recipes.map(r => card(r))); if (!result.total)
            list.append(n('p', {}, 'No recipes found. Try another name or ingredient.')); pager.replaceChildren(button('← Previous', () => { if (page) {
            page--;
            return load();
        } }), n('span', {}, 'Page ' + (page + 1) + ' of ' + Math.max(1, Math.ceil(result.total / 24))), button('Next →', () => { if ((page + 1) * 24 < result.total) {
            page++;
            return load();
        } })); pager.firstChild.disabled = page === 0; pager.lastChild.disabled = (page + 1) * 24 >= result.total; }
        reloadDiscover = load;
        await load();
    }
    function detail(r, { isPreview = false, plan = false } = {}) {
        let glasses = r.serves;
        const measures = n('div'), steps = n('section', {}, n('h3', {}, 'Make it'), n('ol', {}, r.steps.map(s => n('li', {}, s))), r.garnish ? n('p', {}, 'Garnish: ' + r.garnish) : null);
        const paint = () => { const have = new Set((lib?.pantry ?? []).map(ingredientKey)); measures.replaceChildren(...recipeMeasures(r, glasses).map(i => n('div', { class: 'cr-measure' }, n('span', {}, i.name, account && !have.has(ingredientKey(i.name)) ? n('small', {}, 'Not in pantry') : null), n('strong', {}, i.amount === null ? i.unit : (i.estimated ? '≈ ' : '') + i.amount + ' ' + i.unit)))); };
        paint();
        const controls = n('div', { class: 'cr-tools' });
        if (!isPreview) {
            controls.append(button(lib?.saved.some(s => s.id === r.id) ? 'Remove from saved' : 'Save recipe', async () => { requireLogin(); await updateLibrary(lib.saved.some(s => s.id === r.id) ? 'unsave' : 'save', { id: r.id }); say('Saved recipes updated.'); await showRecipe(r.id); }), button('Add to party plan', async () => { await updateLibrary('plan', { id: r.id, glasses }); say('Added to your party plan. The recipe is saved as it is today.'); }));
            if (r.source === 'community')
                controls.append(button('Report', () => reportDialog(r)));
        }
        return n('div', { class: 'cr-detail' }, hero(r), r.tags?.length ? n('p', { class: 'cr-tags' }, r.tags.join(' · ')) : null, plan ? n('p', { class: 'cr-muted' }, 'Saved party-plan version. Later author changes do not change these measures.') : null, n('div', { class: 'cr-columns' }, n('section', {}, n('h3', {}, 'Your measures'), field('Number of glasses', n('input', { type: 'number', min: 1, max: 20, value: glasses, onchange: e => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 20) {
                glasses = v;
                paint();
            }
            else
                e.target.value = glasses; } })), measures), steps), controls, r.sourceNote ? n('p', { class: 'cr-muted' }, r.sourceNote) : null, r.sourceUrl ? n('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Original recipe source') : null);
    }
    async function showRecipe(id) { await flush(); draft = null; screen = 'detail'; renderNav(); const r = await api('recipe/' + encodeURIComponent(id)); main.replaceChildren(button('← Back to recipes', () => changeScreen('discover')), detail(r)); main.scrollTop = 0; }
    function modal(title, content, accept, label = 'Confirm') {
        const d = n('dialog', { class: 'cr-dialog' }, n('h2', {}, title), content, n('div', { class: 'cr-tools' }, button('Cancel', () => d.close()), button(label, async () => { await accept(); d.close(); }, 'cr-primary')));
        root.append(d);
        d.addEventListener('close', () => d.remove());
        d.showModal();
    }
    function reportDialog(r) { requireLogin(); const text = n('textarea', { maxlength: 500, rows: 4, 'aria-label': 'Report reason' }); modal('Report ' + r.name, n('div', {}, n('p', {}, 'Explain what needs review. A moderator can hide inappropriate posts.'), text), async () => { await api('report', { id: r.id, reason: text.value }); say('Report sent for review.'); }, 'Send report'); }
    async function newDraft() { requireLogin(); await flush(); draft = empty(); editId = undefined; editRevision = 0; dirty = false; saveError = null; screen = 'editor'; preview = false; renderNav(); editor(); }
    async function mine() {
        if (!account) {
            main.replaceChildren(loginNote());
            return;
        }
        const { recipes } = await api('mine');
        const selected = new Map();
        const bulk = button('Delete selected', () => modal('Delete selected recipes?', n('p', {}, 'These posts will leave Discover and saved lists. Existing party-plan snapshots remain.'), async () => { await api('delete', { items: [...selected.values()] }); await mine(); }, 'Delete'));
        bulk.disabled = true;
        const restore = button('Restore unsaved draft', async () => { const raw = sessionStorage.getItem(backupKey()); if (!raw)
            return; const data = JSON.parse(raw); if (data.id) {
            const current = recipes.find(r => r.id === data.id);
            if (!current || current.revision !== data.revision)
                throw Error('This backup conflicts with a newer server draft. Open the current recipe instead.');
        } draft = data.recipe; editId = data.id; editRevision = data.revision; dirty = true; saveError = null; screen = 'editor'; editor(); });
        restore.hidden = !sessionStorage.getItem(backupKey());
        main.replaceChildren(n('h1', {}, 'My Recipes'), n('p', {}, 'Drafts are private. Published recipes change only when you choose Publish update.'), n('div', { class: 'cr-tools' }, button('+ Create recipe', () => newDraft(), 'cr-primary'), bulk, restore), n('div', { class: 'cr-my-list' }, recipes.map(r => n('article', { class: 'cr-my-row' }, n('input', { type: 'checkbox', 'aria-label': 'Select ' + (r.recipe.name || 'Untitled recipe'), onchange: e => { if (e.target.checked)
                selected.set(r.id, { id: r.id, revision: r.revision });
            else
                selected.delete(r.id); bulk.disabled = !selected.size; } }), n('div', {}, n('h3', {}, r.recipe.name || 'Untitled recipe'), n('small', {}, r.hidden ? 'Hidden by moderator' : r.published ? (r.revision !== r.publishedRevision ? 'Published · draft changes' : 'Published') : 'Private draft')), button('Edit', () => { draft = r.recipe; editId = r.id; editRevision = r.revision; dirty = false; saveError = null; preview = false; screen = 'editor'; editor(); }), button('Delete', () => modal('Delete this recipe?', n('p', {}, r.recipe.name || 'Untitled recipe'), async () => { await api('delete', { items: [{ id: r.id, revision: r.revision }] }); await mine(); }, 'Delete'))))), !recipes.length ? n('p', {}, 'Your first recipe starts here.') : null);
    }
    function editor() {
        renderNav();
        const r = draft;
        const status = n('div', { class: 'cr-tools' }, button('← My Recipes', () => changeScreen('mine')), button(preview ? 'Edit recipe' : 'Preview', async () => { await flush(); preview = !preview; editor(); }), button('Save draft', async () => { saveError = null; await flush(); }), button('Publish / update', async () => { await flush(); const result = await api('draft', { id: editId, revision: editRevision, recipe: draft, publish: true }); editId = result.id; editRevision = result.revision; dirty = false; const key = backupKey(); if (key)
            sessionStorage.removeItem(key); say('Recipe published. Everyone can now discover it.'); await changeScreen('mine'); }, 'cr-primary'));
        if (preview) {
            main.replaceChildren(status, n('p', { class: 'cr-muted' }, 'Preview · nothing is published until you choose Publish / update.'), detail({ ...r, author: account.username, source: 'community' }, { isPreview: true }));
            return;
        }
        const text = (key, label, max, area = false) => field(label, n(area ? 'textarea' : 'input', { value: r[key], maxlength: max, rows: area ? 3 : undefined, oninput: e => { r[key] = e.target.value; changed(); refreshHero(); } }));
        const heroMount = n('div');
        const refreshHero = () => heroMount.replaceChildren(hero(r, true));
        refreshHero();
        const ingredientRows = n('div'), stepRows = n('div');
        function paintIngredients() { ingredientRows.replaceChildren(...r.ingredients.map((i, index) => n('div', { class: 'cr-ingredient-edit' }, n('input', { value: i.name, placeholder: 'Ingredient name', maxlength: 80, 'aria-label': 'Ingredient ' + (index + 1), oninput: e => { i.name = e.target.value; changed(); } }), n('input', { type: 'number', min: .01, max: 10000, step: 'any', value: i.amount ?? '', disabled: i.unit === 'to taste', 'aria-label': 'Amount ' + (index + 1), oninput: e => { i.amount = e.target.value === '' ? null : Number(e.target.value); changed(); } }), select(RECIPE_UNITS.map(u => [u, u]), i.unit, v => { i.unit = v; if (v === 'to taste')
            i.amount = null; changed(); paintIngredients(); }, 'Unit ' + (index + 1)), button('Remove', () => { r.ingredients.splice(index, 1); changed(); paintIngredients(); })))); }
        function paintSteps() { stepRows.replaceChildren(...r.steps.map((s, index) => n('div', { class: 'cr-step-edit' }, n('span', {}, index + 1 + '.'), n('textarea', { value: s, rows: 3, maxlength: 1200, 'aria-label': 'Step ' + (index + 1), oninput: e => { r.steps[index] = e.target.value; changed(); } }), button('Remove', () => { r.steps.splice(index, 1); changed(); paintSteps(); })))); }
        paintIngredients();
        paintSteps();
        main.replaceChildren(status, n('h1', {}, 'Create something delicious'), n('p', {}, 'Drag the bottom edge to resize the header, or the photo’s right edge to change its width.'), heroMount, n('div', { class: 'cr-columns' }, n('section', {}, text('name', 'Drink name', 80), text('description', 'Short description', 300, true), text('equipment', 'Glass and equipment', 200)), n('section', {}, field('Tags · comma separated', n('input', { value: r.tags.join(', '), maxlength: 240, oninput: e => { r.tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean); changed(); } })), field('Base servings', n('input', { type: 'number', min: 1, max: 20, value: r.serves, oninput: e => { r.serves = Number(e.target.value); changed(); } })), field('Alcohol-free', n('input', { type: 'checkbox', checked: r.alcoholFree, onchange: e => { r.alcoholFree = e.target.checked; changed(); } })), text('garnish', 'Garnish / finishing touch', 300))), n('div', { class: 'cr-columns' }, n('section', {}, n('h2', {}, 'Ingredients'), ingredientRows, button('+ Ingredient', () => { if (r.ingredients.length >= 30)
            throw Error('Up to 30 ingredients.'); r.ingredients.push({ name: '', amount: null, unit: 'ml' }); changed(); paintIngredients(); })), n('section', {}, n('h2', {}, 'Make it'), stepRows, button('+ Step', () => { if (r.steps.length >= 24)
            throw Error('Up to 24 steps.'); r.steps.push(''); changed(); paintSteps(); }))), n('p', { class: 'cr-muted' }, 'Upload a photo you own or have permission to share. Your name appears beside published recipes.'));
    }
    function pantry() {
        if (!account) {
            main.replaceChildren(loginNote());
            return;
        }
        const input = n('input', { placeholder: 'Add an ingredient…', maxlength: 80, list: 'cr-ingredients', 'aria-label': 'Pantry ingredient' });
        const add = async () => { if (input.value.trim()) {
            await updateLibrary('pantry', { pantry: [...lib.pantry, input.value.trim()] });
            pantry();
        } };
        main.replaceChildren(n('h1', {}, 'My pantry'), n('p', {}, 'What you have at home — availability, not stock quantities.'), n('div', { class: 'cr-tools' }, input, button('Add ingredient', add)), n('datalist', { id: 'cr-ingredients' }, Object.values(house.INGREDIENTS).map(i => n('option', { value: i[0] }))), n('div', { class: 'cr-tools' }, lib.pantry.map(name => button(name + ' ×', async () => { await updateLibrary('pantry', { pantry: lib.pantry.filter(x => x !== name) }); pantry(); }))), importButton());
        input.onkeydown = e => { if (e.key === 'Enter')
            run(add); };
    }
    function importButton() { return !lib.imported && importedLegacy ? button('Import this browser’s old pantry & party plan', () => modal('Import your old local list?', n('p', {}, 'Merge once into this account. Existing account quantities are kept, and the original local list is left intact.'), async () => { await updateLibrary('import', { legacy: importedLegacy }); await render(); say('Local list imported.'); }, 'Import')) : n('span'); }
    function party() {
        if (!account) {
            main.replaceChildren(loginNote());
            return;
        }
        const list = n('div');
        main.replaceChildren(n('h1', {}, 'Party list'), n('div', { class: 'cr-tools' }, button('Saved Recipes', () => { partyTab = 'saved'; party(); }, partyTab === 'saved' ? 'active' : ''), button('Party Plan', () => { partyTab = 'plan'; party(); }, partyTab === 'plan' ? 'active' : '')), importButton(), list);
        if (partyTab === 'saved') {
            list.className = 'cr-grid';
            list.append(...lib.saved.map(s => s.recipe ? card(s.recipe, [button('Remove', async () => { await updateLibrary('unsave', { id: s.id }); party(); })]) : n('article', { class: 'cr-card' }, n('p', {}, 'This recipe is no longer public.'), button('Remove', async () => { await updateLibrary('unsave', { id: s.id }); party(); }))));
            if (!lib.saved.length)
                list.append(n('p', {}, 'Save a recipe from Discover to find it here.'));
            return;
        }
        list.append(n('p', {}, 'Each plan keeps a snapshot. Refresh a recipe explicitly to use its author’s latest version.'), ...lib.plans.map(p => n('article', { class: 'cr-plan' }, n('h3', {}, p.snapshot.name), field('Glasses', n('input', { type: 'number', min: 1, max: 20, value: p.glasses, onchange: e => run(async () => { await updateLibrary('plan', { id: p.id, glasses: Number(e.target.value) }); party(); }) })), n('div', { class: 'cr-tools' }, button('View saved version', () => { main.replaceChildren(button('← Party plan', () => party()), detail(p.snapshot, { isPreview: true, plan: true })); }), button('Refresh from latest', () => modal('Replace the saved recipe version?', n('p', {}, 'Ingredients and measures may change.'), async () => { await updateLibrary('plan', { id: p.id, glasses: p.glasses, refresh: true }); party(); }, 'Refresh')), button('Remove', async () => { await updateLibrary('remove-plan', { id: p.id }); party(); })))));
        const shopping = recipeShopping(lib.plans, lib.pantry);
        list.append(n('h2', {}, 'Shopping list'), ...shopping.map(i => n('div', { class: 'cr-measure' }, n('label', {}, n('input', { type: 'checkbox', checked: lib.purchased.includes(i.key), 'aria-label': 'Bought ' + i.name, onchange: e => run(async () => { await updateLibrary('purchased', { keys: e.target.checked ? [...lib.purchased, i.key] : lib.purchased.filter(k => k !== i.key) }); }) }), i.name, i.onHand ? ' · in pantry' : ''), n('strong', {}, i.amount === null ? i.unit : (i.estimated ? '≈ ' : '') + i.amount + ' ' + i.unit))), button('Copy shopping list', async () => { await navigator.clipboard.writeText(shopping.map(i => `${i.name}: ${i.amount ?? ''} ${i.unit}${i.onHand ? ' (in pantry)' : ''}`).join('\n')); say('Shopping list copied.'); }));
        if (!lib.plans.length)
            list.append(n('p', {}, 'Add recipes from Discover to plan their measures.'));
    }
    async function review() { const { reports } = await api('moderation'); main.replaceChildren(n('h1', {}, 'Reported recipes'), ...reports.map(r => n('article', { class: 'cr-plan' }, n('h3', {}, r.published ? JSON.parse(r.published).name : 'Deleted post'), n('p', {}, 'By ' + r.username + ' · ' + (r.hidden ? 'Hidden' : 'Public')), n('p', {}, r.reason), ...['hide', 'restore', 'dismiss'].map(action => button(action, async () => { await api('moderation', { id: r.recipe, action }); await review(); }))))); if (!reports.length)
        main.append(n('p', {}, 'No reports waiting.')); }
    async function render() { readSeq++; if (screen === 'discover')
        await discover();
    else if (screen === 'mine')
        await mine();
    else if (screen === 'pantry')
        pantry();
    else if (screen === 'party')
        party();
    else if (screen === 'moderation')
        await review(); }
    async function checkIdentity() { const state = await api('me'); if (account?.id !== state.account?.id) {
        epoch++;
        draft = null;
        dirty = false;
        saveError = null;
        clearTimeout(saveTimer);
        account = state.account;
        lib = state.library;
        screen = 'discover';
        renderNav();
        await render();
        say('Account changed. Private drafts and lists have been cleared from this view.');
    }
    else {
        lib = state.library;
        if (screen === 'discover' && reloadDiscover)
            await reloadDiscover();
    } }
    function embed(container) {
        disposed = false;
        epoch++;
        screen = 'discover';
        draft = null;
        dirty = false;
        saveError = null;
        account = null;
        lib = null;
        nav = n('nav', { class: 'cr-nav', 'aria-label': 'Recipe book' });
        notice = n('p', { class: 'cr-notice', role: 'status', 'aria-live': 'polite' });
        main = n('div', { class: 'mix-main cr-main' });
        root = n('div', { class: 'cr-book' }, nav, notice, main);
        container.append(root);
        renderNav();
        main.append(n('p', {}, 'Opening the recipe book…'));
        try {
            importedLegacy = JSON.parse(localStorage.getItem('vegas:mixology:v1') || 'null');
        }
        catch {
            importedLegacy = null;
        }
        run(async () => { const state = await api('me'); account = state.account; lib = state.library; renderNav(); await render(); });
        clearInterval(poll);
        poll = setInterval(() => { if (root.isConnected && !disposed && !identityPending) {
            identityPending = true;
            run(checkIdentity).finally(() => { identityPending = false; });
        } }, 1000);
        return { root, teardown() { backup(); clearTimeout(saveTimer); clearTimeout(searchTimer); clearInterval(poll); disposed = true; epoch++; root.remove(); } };
    }
    function close() { if (dialog) {
        dialog.close();
        dialog = null;
    } }
    function open(container = document.body) { dialog = n('dialog', { class: 'cr-standalone' }); const mount = embed(dialog); dialog.prepend(button('Close', close)); container.append(dialog); dialog.addEventListener('close', () => { mount.teardown(); dialog?.remove(); }); dialog.showModal(); }
    return { embed, open, close };
}
