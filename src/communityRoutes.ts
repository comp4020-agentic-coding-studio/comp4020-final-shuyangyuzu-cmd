import type { Hono, Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type Database from 'better-sqlite3';
import { AccountError, verifyAccountSession } from './accounts.ts';
import * as recipes from './community.ts';
import { uploadImage, readImage } from './communityImages.ts';
export function registerCommunity(app: Hono, db: Database.Database) {
    const auth = (c: Context) => verifyAccountSession(db, getCookie(c, 'vegas_account') ?? '');
    const optional = (c: Context) => { try {
        return auth(c);
    }
    catch (e) {
        if (e instanceof AccountError && e.status === 401)
            return null;
        throw e;
    } };
    app.use('/api/community/*', async (c, next) => {
        c.header('Cache-Control', 'private, no-store');
        if (c.req.method !== 'GET') {
            const origin = c.req.header('origin');
            let mismatch = false;
            try {
                mismatch = !!origin && new URL(origin).host !== (c.req.header('host') ?? new URL(c.req.url).host);
            }
            catch {
                mismatch = true;
            }
            if (mismatch || c.req.header('sec-fetch-site') === 'cross-site')
                recipes.problem('Cross-site request refused.', 'bad_origin', 403);
            auth(c);
        }
        await next();
    });
    app.use('/api/community/*', bodyLimit({ maxSize: 5 * 1024 * 1024, onError: c => c.json({ error: 'Upload must be 5 MB or smaller.' }, 413) }));
    const body = async (c: Context): Promise<Record<string, unknown>> => {
        const text = await c.req.text();
        if (text.length > 64000)
            recipes.problem('Recipe request too large.', 'too_large', 413);
        try {
            const v = JSON.parse(text);
            if (!v || typeof v !== 'object' || Array.isArray(v))
                throw Error();
            return v;
        }
        catch {
            return recipes.problem('Invalid JSON.');
        }
    };
    app.get('/api/community/me', c => { const a = optional(c); return c.json({ account: a ? { id: a.accountId, username: a.username, admin: recipes.isAdmin(a) } : null, library: a ? recipes.library(db, a) : null }); });
    app.get('/api/community/discover', c => {
        const q = (c.req.query('q') ?? '').slice(0, 120), source = c.req.query('source') ?? 'all', alcohol = c.req.query('alcohol') ?? 'all', match = c.req.query('match') ?? 'all';
        const page = Number(c.req.query('page') ?? 0);
        if (!Number.isInteger(page) || page < 0 || page > 10000 || !['all', 'house', 'community'].includes(source) || !['all', 'free', 'cocktail'].includes(alcohol) || !['all', 'ready', 'almost'].includes(match))
            recipes.problem('Invalid search.');
        const a = optional(c);
        return c.json(recipes.discover(db, q, source, page, alcohol, a ? recipes.library(db, a).pantry : [], match));
    });
    app.get('/api/community/mine', c => c.json({ recipes: recipes.myRecipes(db, auth(c)) }));
    app.get('/api/community/recipe/:id', c => { const r = recipes.publicRecipe(db, c.req.param('id')); if (!r)
        recipes.problem('This recipe is no longer available.', 'not_found', 404); return c.json(r); });
    app.post('/api/community/draft', async (c) => { const b = await body(c); return c.json(recipes.saveDraft(db, auth(c), typeof b.id === 'string' ? b.id : undefined, Number(b.revision), b.recipe, b.publish === true)); });
    app.post('/api/community/delete', async (c) => { const b = await body(c); if (!Array.isArray(b.items) || b.items.some(i => !i || typeof i.id !== 'string' || !Number.isInteger(i.revision)))
        recipes.problem('Select valid recipes.'); recipes.deleteRecipes(db, auth(c), b.items as {
        id: string;
        revision: number;
    }[]); return c.json({ ok: true }); });
    app.post('/api/community/library', async (c) => c.json(recipes.updateLibrary(db, auth(c), await body(c))));
    app.post('/api/community/report', async (c) => { const b = await body(c); if (typeof b.id !== 'string' || typeof b.reason !== 'string')
        recipes.problem('Add a report reason.'); recipes.report(db, auth(c), b.id as string, b.reason as string); return c.json({ ok: true }); });
    app.get('/api/community/moderation', c => c.json({ reports: recipes.moderation(db, auth(c)) }));
    app.post('/api/community/moderation', async (c) => { const b = await body(c); recipes.moderate(db, auth(c), String(b.id), String(b.action)); return c.json({ ok: true }); });
    app.post('/api/community/images', async (c) => c.json(await uploadImage(db, auth(c), new Uint8Array(await c.req.arrayBuffer()))));
    app.get('/api/community/images/:id', c => { const data = readImage(db, c.req.param('id'), optional(c)); if (!data)
        return c.json({ error: 'Image unavailable' }, 404); c.header('Content-Type', 'image/webp'); c.header('X-Content-Type-Options', 'nosniff'); return c.body(new Uint8Array(data)); });
}
