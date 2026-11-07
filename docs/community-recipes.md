# Community recipes

Implemented by Codex, 2026-11-07. This feature extends The Mixology Book inside the existing counter book; it does not change Meals/Drinks ordering, stamina, eating or game rules. Claude's menu expansion (`dd8e33c`) is included unchanged apart from the menu book's new embedded-view teardown hook.

## Using the book

- **Discover** includes house and community recipes. Search matches names, ingredients, tags and creator names, including partial words and one-character typos for words of at least four characters. Filters select source, alcohol-free drinks, and pantry readiness. Public results refresh approximately once a second while this view is open.
- **My Recipes** holds private drafts and published posts. Fill the template, upload an optional photo, adjust the photo width/crop, enter ingredient measures and preparation steps, and preview before publishing. Drag the outer bottom edge to set header height (180-440 px); the photo fills that height. Drag the right photo edge to set its width (20-60%). Both handles support keyboard arrows. Add/change/remove controls live inside the photo area; the separate upload row and crop/zoom sliders were removed following user feedback. Old crop values remain compatible; replacing a photo centres it. On mobile, ingredients and preparation stack vertically.
- Draft edits autosave after 900 ms. Publishing is explicit: editing a published recipe does not change its public version until Publish / update is selected. A tab-local, account-scoped sessionStorage backup supports recovery if the book closes before saving; My Recipes offers Restore unsaved draft. It is not a cross-device backup until the server acknowledges the save. A conflicting newer draft is never overwritten by that backup.
- **Party list / Saved Recipes** references the latest public version, including your own posts. A hidden/deleted post becomes unavailable. **Party Plan** stores a snapshot and number of glasses; author edits/deletions do not silently change shopping quantities. Refresh from latest explicitly replaces that snapshot. Shopping quantities merge matching ingredient names only when units agree; there are no speculative mass/volume conversions.
- **My pantry**, saved recipes and party plans belong to the logged-in account and persist across sessions. An explicit, one-time import can merge the old browser-local pantry/plan. Existing account plan quantities win; no automatic claim or overwrite of another browser user's data occurs.

## Authority and persistence

All mutation routes under `/api/community/` authenticate the existing HttpOnly account cookie and reject cross-site Origin/Sec-Fetch-Site requests. No client-supplied owner is trusted. Public discovery does not disclose private drafts. Owner checks apply to edits and every item in atomic batch deletion. Recipe and library version checks return conflicts instead of overwriting another tab/device's changes. Existing account session revocation applies here too.

The existing SQLite database stores recipes, normalized photo BLOBs, library entries, reports, limits and a durable `community_audit` (actor account ID, action, target and timestamp; no recipe content, credentials or photos). It uses the existing Fly `/data` volume and therefore needs no new external storage account. Back up that database together with the rest of the application data. Recipe deletion removes it from public discovery but retains party-plan snapshots deliberately.

Photos are optional still JPEG/PNG/WebP files: 5 MB input, 16 million decoded pixels, normalized to WebP with a maximum 1600-pixel edge, auto-oriented and stripped of metadata. SVG, animated/multipage images and invalid image bytes are refused regardless of extension. Sharp processes one image at a time with cache disabled. Limit: 20 uploads/hour and 20 MB normalized image data per account. Old unreferenced uploads are reclaimed on that owner's next upload after 24 hours. Private draft photos require their owner; public images require a public recipe reference; private plan snapshots retain access for their saving account. There are no public arbitrary file paths.

Other bounds: 100 active recipes/account, 200 saved recipes, 30 drinks per party plan, 200 pantry entries, 12 publishes/hour, 10 reports/hour. Recipe text is rendered with text nodes, not HTML. Uploaders are told to use photos they own or have permission to share.

## Moderation

Set `COMMUNITY_ADMIN_ACCOUNTS` to comma-separated **account UUIDs** of designated moderators, not usernames. No account is made an administrator automatically. The authenticated `/api/community/me` response includes the current user's own account ID; administrators can also look it up in the database. This configuration is operational setup, not a credential bundled in the client.

Moderators see Review reports and can hide, restore or dismiss. Hidden posts remain in the moderation queue even after a report is dismissed, so they can still be restored. Owners may edit hidden drafts but cannot republish around the moderation decision. Hide/restore/delete/publish/draft changes are recorded in `community_audit`. No automated content classifier, comments, likes or following system is included.

## Verification boundaries

`spec/community.test.ts` exercises draft/public separation, ownership, atomic batches, optimistic concurrency, saved-reference versus snapshot semantics, import, fuzzy search, moderation, quantities, photo decoding/metadata stripping/access, database reopen persistence, publication limits and HTTP authentication/CSRF.

Codex's real Edge automation uses two isolated local browser profiles and actual button/pointer clicks, including image-file selection, publication, second-account discovery/save/plan, unpublished edit isolation, deletion, mobile editor, divider dragging, tab-local draft restore and batch deletion. It opens the real menu-book component programmatically as the test entry point; this is not a claim of a manual walk to the counter or a human playtest. Desktop and mobile screenshots were inspected at 1920×1080 and 390×844. No test posts were sent to production.

Production deployment, administrator provisioning and the user's own acceptance are separate from these local checks. No AI generation is introduced; the previously paused AI custom-drink feature remains paused.
