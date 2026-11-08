import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import sharp from 'sharp';
import { openDb } from '../src/db.ts';
import { register, AccountError } from '../src/accounts.ts';
import * as c from '../src/community.ts';
import { uploadImage, readImage } from '../src/communityImages.ts';
import { registerCommunity } from '../src/communityRoutes.ts';
import { recipeMeasures, recipeShopping, searchScore } from '../public/recipeModel.js';
let db: Database.Database, dir: string, a: ReturnType<typeof register>, b: ReturnType<typeof register>;
const recipe = (): c.Recipe => ({ name: 'Garden fizz', description: 'Fresh lime and mint', tags: ['summer'], equipment: 'Tall glass', kind: 'drink', alcoholFree: true, prepMinutes: null, cookMinutes: null, serves: 1, imageId: null, imageWidth: 35, imageX: 50, imageY: 50, imageZoom: 1, ingredients: [{ name: 'Lime juice', amount: 30, unit: 'ml' }, { name: 'Mint', amount: 2, unit: 'leaf' }], steps: ['Stir over ice.'], garnish: 'Mint' });
const foodRecipe = (): c.Recipe => ({ ...recipe(), name: 'Garden salad', kind: 'food', alcoholFree: false, prepMinutes: 10, cookMinutes: 0 });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'community-')); db = openDb(join(dir, 'test.db')); a = register(db, 'Maker', 'test-password-long', null); b = register(db, 'Reader', 'test-password-long', null); });
afterEach(() => { delete process.env.COMMUNITY_ADMIN_ACCOUNTS; db.close(); rmSync(dir, { recursive: true, force: true }); });
const publish = () => c.saveDraft(db, a, undefined, 0, recipe(), true);
it('keeps private drafts and later unpublished changes out of public results', () => { let r = c.saveDraft(db, a, undefined, 0, recipe(), false); expect(c.publicRecipe(db, r.id)).toBeNull(); r = c.saveDraft(db, a, r.id, r.revision, recipe(), true); c.saveDraft(db, a, r.id, r.revision, { ...recipe(), name: 'Private edit' }, false); expect(c.publicRecipe(db, r.id)?.name).toBe('Garden fizz'); expect(c.myRecipes(db, a)[0].recipe.name).toBe('Private edit'); expect(c.myRecipes(db, b)).toEqual([]); });
it('rejects stale edits and non-owner writes including all-or-nothing batch delete', () => { const r = publish(), s = c.saveDraft(db, b, undefined, 0, recipe(), true); expect(() => c.saveDraft(db, b, r.id, r.revision, recipe(), true)).toThrow(); expect(() => c.saveDraft(db, a, r.id, 0, recipe(), true)).toThrow(/another tab/); expect(() => c.deleteRecipes(db, a, [{ id: r.id, revision: r.revision }, { id: s.id, revision: s.revision }])).toThrow(); expect(c.publicRecipe(db, r.id)).not.toBeNull(); });
it('saved references follow published updates, while party snapshots survive edits and deletion', () => { let r = publish(); let l = c.library(db, b); l = c.updateLibrary(db, b, { action: 'save', id: r.id, version: l.version }); l = c.updateLibrary(db, b, { action: 'plan', id: r.id, glasses: 3, version: l.version }); r = c.saveDraft(db, a, r.id, r.revision, { ...recipe(), name: 'New name' }, true); expect(c.library(db, b).saved[0].recipe?.name).toBe('New name'); expect(c.library(db, b).plans[0].snapshot.name).toBe('Garden fizz'); c.deleteRecipes(db, a, [{ id: r.id, revision: r.revision }]); expect(c.library(db, b).saved[0].recipe).toBeNull(); expect(c.library(db, b).plans[0].glasses).toBe(3); });
it('checks account library versions and never overwrites another device silently', () => { const l = c.library(db, a); c.updateLibrary(db, a, { action: 'pantry', version: l.version, pantry: ['Gin'] }); expect(() => c.updateLibrary(db, a, { action: 'pantry', version: l.version, pantry: [] })).toThrow(/another device/); expect(c.library(db, a).pantry).toEqual(['Gin']); expect(c.library(db, b).pantry).toEqual([]); });
it('imports local lists explicitly once without replacing account quantities', () => { const first = c.houseRecipes()[0]; let l = c.library(db, a); l = c.updateLibrary(db, a, { action: 'plan', version: l.version, id: first.id, glasses: 4 }); l = c.updateLibrary(db, a, { action: 'import', version: l.version, legacy: { pantry: [], plan: { [first.id.slice(6)]: 2 } } }); expect(l.plans[0].glasses).toBe(4); expect(() => c.updateLibrary(db, a, { action: 'import', version: l.version, legacy: { pantry: [], plan: {} } })).toThrow(/already imported/); });
it('searches typos, ingredients, author and filters pantry readiness', () => { publish(); expect(c.discover(db, 'gardem', 'community', 0, 'all').total).toBe(1); expect(c.discover(db, 'maker', 'all', 0, 'all').total).toBe(1); expect(c.discover(db, 'mint', 'community', 0, 'free').total).toBe(1); expect(c.discover(db, '', 'community', 0, 'cocktail').total).toBe(0); expect(c.discover(db, '', 'community', 0, 'all', ['Lime juice', 'Mint'], 'ready').total).toBe(1); expect(searchScore('Garden fizz', 'unrelated')).toBe(0); });
it('moderation is privileged and hidden posts disappear without deleting private drafts', () => { const r = publish(); c.report(db, b, r.id, 'Misleading recipe'); expect(() => c.moderate(db, b, r.id, 'hide')).toThrow(/Moderator/); process.env.COMMUNITY_ADMIN_ACCOUNTS = b.accountId; c.moderate(db, b, r.id, 'hide'); expect(c.publicRecipe(db, r.id)).toBeNull(); const own = c.myRecipes(db, a)[0]; expect(() => c.saveDraft(db, a, r.id, own.revision, recipe(), true)).toThrow(/hidden/); c.moderate(db, b, r.id, 'restore'); expect(c.publicRecipe(db, r.id)).not.toBeNull(); });
it('validates quantities, field sizes, required content and owned images on server', () => { expect(() => c.saveDraft(db, a, undefined, 0, { ...recipe(), ingredients: [] }, true)).toThrow(); expect(() => c.validateRecipe({ ...recipe(), serves: 1.2 })).toThrow(); expect(() => c.validateRecipe({ ...recipe(), imageWidth: 99 })).toThrow(); expect(() => c.validateRecipe({ ...recipe(), heroHeight: 900 })).toThrow(); expect(c.validateRecipe(recipe()).heroHeight).toBe(260); const resized=c.saveDraft(db,a,undefined,0,{...recipe(),heroHeight:325},true); expect(c.publicRecipe(db,resized.id)?.heroHeight).toBe(325); expect(() => c.validateRecipe({ ...recipe(), name: 'a'.repeat(81) })).toThrow(); expect(() => c.saveDraft(db, a, undefined, 0, { ...recipe(), imageId: 'img-00000000-0000-0000-0000-000000000000' }, true)).toThrow(/uploaded by/); });
it('scales per serving and merges only compatible ingredient units', () => { const r = recipe(); r.serves = 2; expect(recipeMeasures(r, 4)[0].amount).toBe(60); const other = { ...r, ingredients: [{ name: 'fresh lime juice', amount: 10, unit: 'ml' }, { name: 'Lime juice', amount: 3, unit: 'g' }] }; const list = recipeShopping([{ snapshot: r, glasses: 2 }, { snapshot: other, glasses: 2 }], ['lime juice']); expect(list.find(i => i.unit === 'ml')?.amount).toBe(40); expect(list.find(i => i.unit === 'g')?.amount).toBe(3); expect(list.find(i => i.unit === 'ml')?.onHand).toBe(true); });
it('stores normalized private images, strips metadata and persists after database restart', async () => { const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#008060' } }).jpeg().withExif({ IFD0: { Artist: 'private-metadata' } }).toBuffer(); const img = await uploadImage(db, a, bytes); expect(readImage(db, img.id, null)).toBeNull(); expect(readImage(db, img.id, b)).toBeNull(); const data = readImage(db, img.id, a)!; const meta = await sharp(data).metadata(); expect(meta.format).toBe('webp'); expect(meta.exif).toBeUndefined(); expect(() => c.saveDraft(db, b, undefined, 0, { ...recipe(), imageId: img.id }, true)).toThrow(); const r = c.saveDraft(db, a, undefined, 0, { ...recipe(), imageId: img.id }, true); expect(readImage(db, img.id, null)).not.toBeNull(); db.close(); db = openDb(join(dir, 'test.db')); expect(c.publicRecipe(db, r.id)?.imageId).toBe(img.id); expect(readImage(db, img.id, null)?.equals(data)).toBe(true); });
it('rejects SVG, disguised content and oversized uploads', async () => { await expect(uploadImage(db, a, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>'))).rejects.toThrow(); await expect(uploadImage(db, a, Buffer.from('<script>alert(1)</script>'))).rejects.toThrow(); await expect(uploadImage(db, a, new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toThrow(/5 MB/); });
it('rate limits publishing without partially saving the rejected request', () => { for (let i = 0; i < 12; i++)
    publish(); expect(() => publish()).toThrow(/wait/); expect(c.myRecipes(db, a)).toHaveLength(12); });
it('keeps hidden posts restorable after dismissing their reports and records moderation', () => { const r = publish(); c.report(db, b, r.id, 'Please review'); process.env.COMMUNITY_ADMIN_ACCOUNTS = b.accountId; c.moderate(db, b, r.id, 'hide'); c.moderate(db, b, r.id, 'dismiss'); expect(c.moderation(db, b)).toHaveLength(1); c.moderate(db, b, r.id, 'restore'); expect(c.moderation(db, b)).toHaveLength(0); expect(db.prepare("SELECT count(*) n FROM community_audit WHERE actor=? AND action='restore'").get(b.accountId)).toEqual({ n: 1 }); });
it('persists shopping checkmarks only for actual planned ingredient keys', () => { const r = publish(); let l = c.updateLibrary(db, b, { action: 'plan', version: c.library(db, b).version, id: r.id, glasses: 2 }); const key = recipeShopping(l.plans, l.pantry)[0].key; l = c.updateLibrary(db, b, { action: 'purchased', version: l.version, keys: [key, 'forged'] }); expect(l.purchased).toEqual([key]); expect(c.library(db, a).purchased).toEqual([]); });
it('HTTP enforces cookie authentication, CSRF, validation and private cache headers', async () => { const app = new Hono(); registerCommunity(app, db); app.onError((e, ctx) => ctx.json({ error: e.message }, (e instanceof AccountError ? e.status : 500) as 400)); const post = (path: string, data: unknown, token = a.token, origin = 'http://localhost') => app.request('http://localhost/api/community/' + path, { method: 'POST', headers: { cookie: 'vegas_account=' + token, origin, 'content-type': 'application/json' }, body: JSON.stringify(data) }); expect((await post('draft', { recipe: recipe() }, '')).status).toBe(401); expect((await post('draft', { recipe: recipe() }, a.token, 'https://evil.example')).status).toBe(403); expect((await post('delete', { items: [null] })).status).toBe(400); const response = await post('draft', { recipe: recipe(), publish: true }); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store'); const r = await response.json(); expect((await post('delete', { items: [{ id: r.id, revision: r.revision }] }, b.token)).status).toBe(404); });

// Drink vs. Food (the user's own explicit request): a food post publishes
// with its own kind, is findable through the new Discover kind filter
// alongside drinks, never required to say whether it contains alcohol,
// and carries optional prep/cook minutes that a drink never has.
it('publishes food alongside drinks, filterable by kind, with food-only prep/cook time and no alcohol requirement', () => {
  const drink = publish();
  const food = c.saveDraft(db, a, undefined, 0, foodRecipe(), true);
  expect(c.publicRecipe(db, food.id)?.kind).toBe('food');
  expect(c.publicRecipe(db, food.id)?.alcoholFree).toBe(false);
  expect(c.publicRecipe(db, food.id)?.prepMinutes).toBe(10);
  expect(c.publicRecipe(db, food.id)?.cookMinutes).toBe(0);
  expect(c.discover(db, '', 'community', 0, 'all', [], 'all', 'food').recipes.map(r => r!.id)).toEqual([food.id]);
  expect(c.discover(db, '', 'community', 0, 'all', [], 'all', 'drink').recipes.map(r => r!.id)).toEqual([drink.id]);
  expect(c.discover(db, '', 'community', 0, 'all', [], 'all', 'all').total).toBe(2);
  // Food is never required to answer alcoholFree, and a bogus boolean
  // passed for a food post is simply ignored rather than rejected or
  // surfaced — validated by the type, not the caller's own say-so.
  expect(() => c.validateRecipe({ ...foodRecipe(), alcoholFree: undefined }, true)).not.toThrow();
  expect(c.validateRecipe({ ...foodRecipe(), alcoholFree: 'yes' as unknown as boolean }).alcoholFree).toBe(false);
  // A drink still must answer alcoholFree.
  expect(() => c.validateRecipe({ ...recipe(), alcoholFree: undefined })).toThrow();
});

// House recipes (public/mixology.js) and every pre-existing record written
// before this round had no `kind` column/field at all — CLAUDE.md's own
// compatibility requirement is that these default to 'drink' rather than
// erroring or disappearing, checked here against a row written directly
// with the OLD shape (no kind column value at all, simulating a record
// from before the addColumnIfMissing migration ran), not just a fresh one.
it('defaults every pre-existing house and legacy community recipe to kind drink, losing no favourites or plans', () => {
  expect(c.houseRecipes().every(r => r.kind === 'drink')).toBe(true);
  const r = publish();
  // Simulate a draft/published blob saved before `kind` existed: strip it
  // from the stored JSON directly, bypassing saveDraft's own validator.
  const row = db.prepare('SELECT draft, published FROM community_recipes WHERE id=?').get(r.id) as { draft: string; published: string };
  const stripKind = (json: string) => { const obj = JSON.parse(json); delete obj.kind; return JSON.stringify(obj); };
  db.prepare('UPDATE community_recipes SET draft=?, published=? WHERE id=?').run(stripKind(row.draft), stripKind(row.published), r.id);
  expect(c.publicRecipe(db, r.id)?.kind).toBe('drink');
  expect(c.myRecipes(db, a)[0].recipe.kind).toBe('drink');
  // A saved reference and a party-plan snapshot taken from a pre-kind
  // record both still resolve correctly, with nothing lost.
  let l = c.updateLibrary(db, b, { action: 'save', id: r.id, version: c.library(db, b).version });
  l = c.updateLibrary(db, b, { action: 'plan', id: r.id, glasses: 2, version: l.version });
  expect(l.saved[0].recipe?.kind).toBe('drink');
  expect(l.plans[0].snapshot.kind).toBe('drink');
});
