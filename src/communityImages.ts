import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccountSessionInfo } from './accounts.ts';
import { isAdmin, limit, problem } from './community.ts';
import { transact } from './actionLog.ts';
sharp.concurrency(1);
sharp.cache(false);
let processing = false;
export async function uploadImage(db: Database.Database, a: AccountSessionInfo, bytes: Uint8Array) {
    if (bytes.length > 5 * 1024 * 1024 || !bytes.length)
        problem('Choose a JPEG, PNG or WebP up to 5 MB.');
    if (processing)
        problem('Another image is processing. Please try again shortly.', 'busy', 429);
    transact(db, () => limit(db, a.accountId, 'image', 20));
    processing = true;
    try {
        let data: Buffer;
        try {
            const image = sharp(bytes, { limitInputPixels: 16000000, failOn: 'warning' });
            const meta = await image.metadata();
            if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) > 1)
                problem('Use a still JPEG, PNG or WebP image.');
            data = await image.autoOrient().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
        }
        catch {
            problem('This image could not be read. Use a still JPEG, PNG or WebP up to 16 megapixels.');
        }
        return transact(db, () => {
            // Remove abandoned uploads after a day; keep all draft, published and party-plan references.
            db.prepare(`DELETE FROM community_images WHERE owner=? AND created<?
        AND id NOT IN (SELECT json_extract(draft,'$.imageId') FROM community_recipes WHERE json_extract(draft,'$.imageId') IS NOT NULL)
        AND id NOT IN (SELECT json_extract(published,'$.imageId') FROM community_recipes WHERE json_extract(published,'$.imageId') IS NOT NULL)
        AND id NOT IN (SELECT json_extract(snapshot,'$.imageId') FROM community_plan WHERE json_extract(snapshot,'$.imageId') IS NOT NULL)`).run(a.accountId, Date.now() - 86400000);
            const usage = db.prepare('SELECT coalesce(sum(length(data)),0) n FROM community_images WHERE owner=?').get(a.accountId) as {
                n: number;
            };
            if (usage.n + data!.length > 20 * 1024 * 1024)
                problem('Your image storage is full (20 MB). Remove unused recipe photos and try again after a day.');
            const id = 'img-' + randomUUID();
            db.prepare('INSERT INTO community_images VALUES(?,?,?,?)').run(id, a.accountId, data!, Date.now());
            return { id };
        });
    }
    finally {
        processing = false;
    }
}
export function readImage(db: Database.Database, id: string, a: AccountSessionInfo | null): Buffer | null {
    const row = db.prepare('SELECT owner,data FROM community_images WHERE id=?').get(id) as {
        owner: string;
        data: Buffer;
    } | undefined;
    if (!row)
        return null;
    if (a && (a.accountId === row.owner || isAdmin(a)))
        return row.data;
    if (db.prepare("SELECT 1 FROM community_recipes WHERE hidden=0 AND deleted=0 AND json_extract(published,'$.imageId')=?").get(id))
        return row.data;
    if (a && db.prepare("SELECT 1 FROM community_plan WHERE owner=? AND json_extract(snapshot,'$.imageId')=?").get(a.accountId, id))
        return row.data;
    return null;
}
