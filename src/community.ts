import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { AccountError, type AccountSessionInfo } from './accounts.ts';
import { transact } from './actionLog.ts';
import { RECIPES, INGREDIENTS } from '../public/mixology.js';
import { ingredientKey, searchScore, RECIPE_UNITS, recipeShopping } from '../public/recipeModel.js';
export type Recipe = {
    name: string;
    description: string;
    tags: string[];
    equipment: string;
    alcoholFree: boolean;
    serves: number;
    imageId: string | null;
    imageWidth: number;
    imageX: number;
    imageY: number;
    imageZoom: number;
    ingredients: {
        name: string;
        amount: number | null;
        unit: string;
        estimated?: boolean;
    }[];
    steps: string[];
    garnish: string;
};
export type RecipeView = Recipe & {
    id: string;
    author: string;
    source: 'house' | 'community';
    revision: number;
    sourceUrl?: string;
    sourceNote?: string;
};
type Row = {
    id: string;
    owner: string;
    draft: string;
    published: string | null;
    revision: number;
    published_revision: number;
    hidden: number;
    deleted: number;
    updated: number;
};
export const problem = (message: string, code = 'invalid_recipe', status = 400): never => { throw new AccountError(message, code, status); };
function str(v: unknown, max: number): string { if (typeof v !== 'string' || v.length > max)
    problem('A text field is missing or too long.'); return (v as string).trim(); }
function num(v: unknown, min: number, max: number): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    problem('A number is outside the allowed range.'); return v as number; }
export function validateRecipe(raw: unknown, publish = false): Recipe {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        problem('Expected a recipe.');
    const r = raw as Record<string, unknown>;
    const name = str(r.name, 80), description = str(r.description, 300), equipment = str(r.equipment, 200), garnish = str(r.garnish, 300);
    if (!Array.isArray(r.ingredients) || r.ingredients.length > 30 || !Array.isArray(r.steps) || r.steps.length > 24 || !Array.isArray(r.tags) || r.tags.length > 8)
        problem('Use up to 30 ingredients, 24 steps and 8 tags.');
    const ingredients = (r.ingredients as unknown[]).map(raw => { if (!raw || typeof raw !== 'object')
        problem('Invalid ingredient.'); const i = raw as Record<string, unknown>; const unit = str(i.unit, 20); if (!RECIPE_UNITS.includes(unit))
        problem('Choose a supported unit.'); const amount = unit === 'to taste' ? null : i.amount === null ? null : num(i.amount, 0.01, 10000); const name = str(i.name, 80); if (publish && (!name || amount === null && unit !== 'to taste'))
        problem('Complete every ingredient and quantity.'); return { name, amount, unit }; });
    const steps = (r.steps as unknown[]).map(s => str(s, 1200)), tags = (r.tags as unknown[]).map(s => str(s, 30)).filter(Boolean);
    const serves = num(r.serves, 1, 20);
    if (!Number.isInteger(serves))
        problem('Base servings must be a whole number.');
    if (publish && (!name || !ingredients.length || !steps.length || steps.some(s => !s)))
        problem('Add a name, ingredients and all preparation steps before publishing.');
    if (typeof r.alcoholFree !== 'boolean')
        problem('Choose whether this drink contains alcohol.');
    const imageId = r.imageId === null ? null : str(r.imageId, 80);
    if (imageId && !/^img-[a-f0-9-]{36}$/.test(imageId))
        problem('Invalid image.');
    return { name, description, equipment, garnish, ingredients, steps, tags, serves, alcoholFree: r.alcoholFree as boolean, imageId, imageWidth: num(r.imageWidth, 20, 60), imageX: num(r.imageX, 0, 100), imageY: num(r.imageY, 0, 100), imageZoom: num(r.imageZoom, 1, 3) };
}
export function houseRecipes(): RecipeView[] { return RECIPES.map(r => ({ id: 'house:' + r.id, name: r.name, description: r.flavour, tags: [r.alcoholFree ? 'Alcohol-free' : 'Classic'], equipment: r.equipment, alcoholFree: r.alcoholFree, serves: r.serves, imageId: null, imageWidth: 30, imageX: 50, imageY: 50, imageZoom: 1, ingredients: r.ingredients.map(i => ({ name: INGREDIENTS[i.id as keyof typeof INGREDIENTS][0], amount: i.amount, unit: i.unit, estimated: !!i.estimated })), steps: r.steps, garnish: r.garnish, author: 'House recipes', source: 'house', revision: 1, sourceUrl: r.source.url, sourceNote: r.source.note })); }
export const isAdmin = (a: AccountSessionInfo) => (process.env.COMMUNITY_ADMIN_ACCOUNTS ?? '').split(',').map(s => s.trim()).includes(a.accountId);
function audit(db: Database.Database, a: AccountSessionInfo, action: string, target: string) { db.prepare('INSERT INTO community_audit(actor,action,target,at) VALUES(?,?,?,?)').run(a.accountId, action, target, Date.now()); }
export function limit(db: Database.Database, owner: string, kind: string, max: number, window = 3600000): void {
    db.prepare('DELETE FROM community_limits WHERE at<?').run(Date.now() - 86400000);
    const { n } = db.prepare('SELECT count(*) n FROM community_limits WHERE owner=? AND kind=? AND at>?').get(owner, kind, Date.now() - window) as {
        n: number;
    };
    if (n >= max)
        problem('Please wait before trying again.', 'rate_limited', 429);
    db.prepare('INSERT INTO community_limits VALUES(?,?,?)').run(owner, kind, Date.now());
}
function own(db: Database.Database, a: AccountSessionInfo, id: string): Row {
    const r = db.prepare('SELECT * FROM community_recipes WHERE id=? AND owner=? AND deleted=0').get(id, a.accountId) as Row | undefined;
    if (!r)
        problem('Recipe not found.', 'not_found', 404);
    return r!;
}
export function publicRecipe(db: Database.Database, id: string): RecipeView | null {
    if (id.startsWith('house:'))
        return houseRecipes().find(r => r.id === id) ?? null;
    const r = db.prepare('SELECT r.*,a.username FROM community_recipes r JOIN accounts a ON a.id=r.owner WHERE r.id=? AND r.published IS NOT NULL AND r.deleted=0 AND r.hidden=0').get(id) as (Row & {
        username: string;
    }) | undefined;
    return r ? { ...JSON.parse(r.published!), id: r.id, author: r.username, source: 'community', revision: r.published_revision } : null;
}
export function discover(db: Database.Database, q: string, source: string, page: number, alcohol: string, pantry: string[] = [], match = 'all') {
    const results: {
        id: string;
        score: number;
        updated: number;
    }[] = [], have = new Set(pantry.map(ingredientKey));
    const matches = (keys: string[]) => { const missing = keys.filter(k => !have.has(k)).length; return match === 'all' || match === 'ready' && missing === 0 || match === 'almost' && missing > 0 && missing <= 2; };
    if (source !== 'community')
        for (const r of houseRecipes()) {
            if (alcohol !== 'all' && (alcohol === 'free') !== r.alcoholFree || !matches(r.ingredients.map(i => ingredientKey(i.name))))
                continue;
            const score = searchScore([r.name, r.description, r.author, ...r.ingredients.map(i => i.name)].join(' '), q);
            if (score)
                results.push({ id: r.id, score, updated: 0 });
        }
    if (source !== 'house')
        for (const raw of db.prepare('SELECT id,search_text,ingredient_keys,alcohol_free,updated FROM community_recipes WHERE published IS NOT NULL AND hidden=0 AND deleted=0').iterate()) {
            const r = raw as {
                id: string;
                search_text: string;
                ingredient_keys: string;
                alcohol_free: number;
                updated: number;
            };
            if (alcohol !== 'all' && (alcohol === 'free') !== !!r.alcohol_free || !matches(JSON.parse(r.ingredient_keys)))
                continue;
            const score = searchScore(r.search_text, q);
            if (score)
                results.push({ id: r.id, score, updated: r.updated });
        }
    results.sort((a, b) => b.score - a.score || b.updated - a.updated || a.id.localeCompare(b.id));
    return { recipes: results.slice(page * 24, (page + 1) * 24).map(r => publicRecipe(db, r.id)), total: results.length, page };
}
export function saveDraft(db: Database.Database, a: AccountSessionInfo, id: string | undefined, revision: number, raw: unknown, publish: boolean) {
    const recipe = validateRecipe(raw, publish);
    return transact(db, () => {
        limit(db, a.accountId, 'save', 90, 60000);
        if (publish)
            limit(db, a.accountId, 'publish', 12);
        if (recipe.imageId && !db.prepare('SELECT 1 FROM community_images WHERE id=? AND owner=?').get(recipe.imageId, a.accountId))
            problem('Choose an image uploaded by this account.', 'image_not_owned', 403);
        const data = JSON.stringify(recipe);
        let r: Row;
        if (id) {
            r = own(db, a, id);
            if (r.revision !== revision)
                problem('This draft changed in another tab. Reload it before saving.', 'conflict', 409);
            if (publish && r.hidden)
                problem('This post is hidden for review. You can save a draft, but only a moderator can restore it.', 'hidden', 403);
        }
        else {
            const count = db.prepare('SELECT count(*) n FROM community_recipes WHERE owner=? AND deleted=0').get(a.accountId) as {
                n: number;
            };
            if (count.n >= 100)
                problem('You can keep up to 100 recipes.');
            id = randomUUID();
            db.prepare('INSERT INTO community_recipes(id,owner,draft,updated) VALUES(?,?,?,?)').run(id, a.accountId, data, Date.now());
            r = own(db, a, id);
            revision = 0;
        }
        const next = revision + 1;
        db.prepare('UPDATE community_recipes SET draft=?,revision=?,updated=? WHERE id=?').run(data, next, Date.now(), id);
        if (publish)
            db.prepare('UPDATE community_recipes SET published=?,published_revision=?,search_text=?,ingredient_keys=?,alcohol_free=? WHERE id=?').run(data, next, [recipe.name, recipe.description, a.username, ...recipe.tags, ...recipe.ingredients.map(i => i.name)].join(' '), JSON.stringify(recipe.ingredients.map(i => ingredientKey(i.name))), recipe.alcoholFree ? 1 : 0, id);
        audit(db, a, publish ? 'publish' : 'save-draft', id!);
        return { id, revision: next, published: publish || !!r.published, hidden: !!r.hidden };
    });
}
export function myRecipes(db: Database.Database, a: AccountSessionInfo) { return (db.prepare('SELECT * FROM community_recipes WHERE owner=? AND deleted=0 ORDER BY updated DESC').all(a.accountId) as Row[]).map(r => ({ id: r.id, revision: r.revision, publishedRevision: r.published_revision, published: !!r.published, hidden: !!r.hidden, recipe: JSON.parse(r.draft) as Recipe })); }
export function deleteRecipes(db: Database.Database, a: AccountSessionInfo, items: {
    id: string;
    revision: number;
}[]): void {
    if (!items.length || items.length > 100)
        problem('Select 1–100 posts.');
    transact(db, () => { for (const i of items) {
        const r = own(db, a, i.id);
        if (r.revision !== i.revision)
            problem('A selected draft changed. Reload your list.', 'conflict', 409);
    } for (const i of items) {
        db.prepare('UPDATE community_recipes SET deleted=1,published=NULL,draft=?,revision=revision+1 WHERE id=?').run('{}', i.id);
        audit(db, a, 'delete', i.id);
    } });
}
export function library(db: Database.Database, a: AccountSessionInfo) {
    db.prepare('INSERT OR IGNORE INTO community_library(owner) VALUES(?)').run(a.accountId);
    const r = db.prepare('SELECT * FROM community_library WHERE owner=?').get(a.accountId) as {
        version: number;
        pantry: string;
        imported: number;
        purchased: string;
    };
    return { version: r.version, pantry: JSON.parse(r.pantry) as string[], imported: !!r.imported, purchased: JSON.parse(r.purchased) as string[],
        saved: (db.prepare('SELECT recipe FROM community_saved WHERE owner=?').all(a.accountId) as {
            recipe: string;
        }[]).map(({ recipe }) => ({ id: recipe, recipe: publicRecipe(db, recipe) })),
        plans: (db.prepare('SELECT recipe,snapshot,glasses FROM community_plan WHERE owner=?').all(a.accountId) as {
            recipe: string;
            snapshot: string;
            glasses: number;
        }[]).map(p => ({ id: p.recipe, snapshot: JSON.parse(p.snapshot) as RecipeView, glasses: p.glasses })) };
}
export function updateLibrary(db: Database.Database, a: AccountSessionInfo, body: Record<string, unknown>) {
    return transact(db, () => {
        const current = library(db, a);
        if (body.version !== current.version)
            problem('Your list changed on another device. Reload and try again.', 'conflict', 409);
        limit(db, a.accountId, 'library', 120, 60000);
        const action = body.action, id = typeof body.id === 'string' ? body.id : '';
        if (action === 'pantry') {
            if (!Array.isArray(body.pantry) || body.pantry.length > 200)
                problem('Use up to 200 pantry ingredients.');
            const list = [...new Set((body.pantry as unknown[]).map(v => str(v, 80)).filter(Boolean))];
            db.prepare('UPDATE community_library SET pantry=? WHERE owner=?').run(JSON.stringify(list), a.accountId);
        }
        else if (action === 'purchased') {
            if (!Array.isArray(body.keys) || body.keys.length > 900)
                problem('Invalid shopping checklist.');
            const valid = new Set(recipeShopping(current.plans, current.pantry).map(i => i.key));
            const keys = [...new Set((body.keys as unknown[]).filter(k => typeof k === 'string' && valid.has(k)))];
            db.prepare('UPDATE community_library SET purchased=? WHERE owner=?').run(JSON.stringify(keys), a.accountId);
        }
        else if (action === 'save') {
            if (!publicRecipe(db, id))
                problem('Recipe unavailable.', 'not_found', 404);
            if (current.saved.length >= 200 && !current.saved.some(r => r.id === id))
                problem('Your saved list is full.');
            db.prepare('INSERT OR IGNORE INTO community_saved VALUES(?,?)').run(a.accountId, id);
        }
        else if (action === 'unsave')
            db.prepare('DELETE FROM community_saved WHERE owner=? AND recipe=?').run(a.accountId, id);
        else if (action === 'plan') {
            const recipe = body.refresh === true ? publicRecipe(db, id) : current.plans.find(p => p.id === id)?.snapshot ?? publicRecipe(db, id);
            if (!recipe)
                problem('Recipe unavailable.', 'not_found', 404);
            const glasses = num(body.glasses, 1, 20);
            if (!Number.isInteger(glasses))
                problem('Choose a whole number of glasses.');
            if (current.plans.length >= 30 && !current.plans.some(p => p.id === id))
                problem('A plan can include up to 30 drinks.');
            db.prepare('INSERT INTO community_plan VALUES(?,?,?,?) ON CONFLICT(owner,recipe) DO UPDATE SET glasses=excluded.glasses,snapshot=excluded.snapshot').run(a.accountId, id, JSON.stringify(recipe), glasses);
        }
        else if (action === 'remove-plan')
            db.prepare('DELETE FROM community_plan WHERE owner=? AND recipe=?').run(a.accountId, id);
        else if (action === 'import') {
            if (current.imported)
                problem('This account has already imported its local list.', 'already_imported', 409);
            const raw = body.legacy as {
                pantry?: unknown;
                plan?: unknown;
            } | undefined;
            if (!raw || !Array.isArray(raw.pantry) || !raw.plan || typeof raw.plan !== 'object')
                problem('No valid local list found.');
            const pantry = [...new Set([...current.pantry, ...(raw!.pantry as unknown[]).filter(k => typeof k === 'string' && Object.hasOwn(INGREDIENTS, k)).map(k => INGREDIENTS[k as keyof typeof INGREDIENTS][0])])];
            if (pantry.length > 200)
                problem('Your pantry is full.');
            for (const recipe of houseRecipes()) {
                const n = (raw!.plan as Record<string, unknown>)[recipe.id.slice(6)];
                if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 20)
                    db.prepare('INSERT OR IGNORE INTO community_plan VALUES(?,?,?,?)').run(a.accountId, recipe.id, JSON.stringify(recipe), n as number);
            }
            const count = db.prepare('SELECT count(*) n FROM community_plan WHERE owner=?').get(a.accountId) as {
                n: number;
            };
            if (count.n > 30)
                problem('Import would exceed 30 drinks. Remove some planned drinks first.');
            db.prepare('UPDATE community_library SET pantry=?,imported=1 WHERE owner=?').run(JSON.stringify(pantry), a.accountId);
        }
        else
            problem('Unknown list action.');
        db.prepare('UPDATE community_library SET version=version+1 WHERE owner=?').run(a.accountId);
        return library(db, a);
    });
}
export function report(db: Database.Database, a: AccountSessionInfo, id: string, reason: string) { if (!publicRecipe(db, id) || id.startsWith('house:'))
    problem('Post unavailable.', 'not_found', 404); const text = str(reason, 500); if (text.length < 3)
    problem('Please explain the issue.'); transact(db, () => { limit(db, a.accountId, 'report', 10); db.prepare('INSERT INTO community_reports VALUES(?,?,?,?,0) ON CONFLICT(recipe,reporter) DO UPDATE SET reason=excluded.reason,created=excluded.created,resolved=0').run(id, a.accountId, text, Date.now()); }); }
export function moderation(db: Database.Database, a: AccountSessionInfo) { if (!isAdmin(a))
    problem('Moderator access required.', 'forbidden', 403); return db.prepare('SELECT q.recipe,q.reason,q.created,r.hidden,r.deleted,r.published,a.username FROM community_reports q JOIN community_recipes r ON r.id=q.recipe JOIN accounts a ON a.id=r.owner WHERE q.resolved=0 OR (r.hidden=1 AND r.deleted=0) ORDER BY q.created LIMIT 100').all(); }
export function moderate(db: Database.Database, a: AccountSessionInfo, id: string, action: string) { if (!isAdmin(a))
    problem('Moderator access required.', 'forbidden', 403); if (!['hide', 'restore', 'dismiss'].includes(action))
    problem('Unknown moderation action.'); transact(db, () => { if (action !== 'dismiss')
    db.prepare('UPDATE community_recipes SET hidden=?,revision=revision+1 WHERE id=? AND deleted=0').run(action === 'hide' ? 1 : 0, id); if (action !== 'hide')
    db.prepare('UPDATE community_reports SET resolved=1 WHERE recipe=?').run(id); audit(db, a, action, id); }); }
