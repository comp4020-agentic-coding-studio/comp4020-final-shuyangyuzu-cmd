// Original canvas art. World-space fixtures and camera-space input are
// separate; movement remains adjacent steps validated by the server.
export function bindDirectionHold(button, { onPress, onRelease, onTap }) {
  let pointer = null;
  const release = e => { if (pointer !== null) { pointer = null; onRelease({ cancelled: e?.type !== 'pointerup' }); } };
  const down = e => {
    if (e.isPrimary === false || e.button !== 0) return;
    e.preventDefault(); pointer = e.pointerId; onPress();
  };
  const up = e => { if (e.pointerId === pointer) release(e); };
  const click = e => { if (e.detail === 0) onTap(); }; // keyboard/assistive activation only
  const hidden = () => { if (button.ownerDocument.hidden) release(); };
  const win = button.ownerDocument.defaultView;
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerleave', release);
  button.addEventListener('click', click);
  win.addEventListener('pointerup', up);
  win.addEventListener('pointercancel', up);
  win.addEventListener('blur', release);
  button.ownerDocument.addEventListener('visibilitychange', hidden);
  return () => {
    release(); button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointerleave', release); button.removeEventListener('click', click);
    win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', up);
    win.removeEventListener('blur', release); button.ownerDocument.removeEventListener('visibilitychange', hidden);
  };
}
// Splits the server's own [startedAt, endsAt) window evenly across
// however many kinds are actually being eaten/drunk (one or two — never
// more), each kind getting an equal share and the same lift/active/down
// sub-stages within its own share, so a solo meal and the "meal" half of
// a combined action look identical — only the window they sit inside
// differs. Pure function of (kinds, progress 0..1), independently
// testable without a real clock or a running animation frame.
//
// `localProgress` (2026-11 addition, Codex-reviewed "the plate just sits
// there" gap) is the same 0..1 value `local` always was internally, now
// exposed so drawEatingScene can interpolate a CONTINUOUS pick-up/eat/
// put-down motion instead of only three discrete snapshots — `stage`
// itself is unchanged and still exactly "lift" | "active" | "down" at the
// same 0.25/0.75 thresholds, so nothing that only reads `.kind`/`.stage`
// breaks.
export function eatingPhaseAt(kinds, progress) {
  const n = kinds.length;
  if (n === 0) return null;
  const clamped = Math.max(0, Math.min(1, progress));
  const index = Math.min(n - 1, Math.floor(clamped * n));
  const kind = kinds[index];
  const local = clamped * n - index; // 0..1 within this kind's own share
  const stage = local < 0.25 ? 'lift' : local < 0.75 ? 'active' : 'down';
  return { kind, stage, localProgress: local };
}

// ---- The seated eating/drinking cutscene, redone 2026-11-04 after the
// student's own review of the previous version: the figure had no face,
// the "plate" was a flat rectangle, and the "glass" was a plain box —
// none of it actually read as a plate, a glass, or a person eating.
// This rewrite keeps eatingPhaseAt's own public contract (`{kind, stage,
// localProgress}`, `stage` still exactly lift/active/down at the same
// 0.25/0.75 split — spec/eatingAnimation.test.ts's existing assertions
// are untouched) and only changes how drawEatingScene interprets
// `localProgress` within a kind's own share, breaking it into the
// seven sub-beats the student specifically asked to see:
//   1. utensils + plate/glass down on the table, character holding fork+knife
//   2. fork lifts a bite to the mouth, with visible chewing
//   3. utensils set down, hand lifts the plate itself toward the face
//   4. the plate continuously TILTS while rising — front visible, rotating
//      to show its own underside — never a snap, never a whole-canvas zoom
//   5. the now-empty plate lowers back down, un-tilting as it goes
//   6. the stemmed glass lifts to the mouth and tilts, liquid visibly draining
//   7. the empty glass lowers back to the table
// A solo "meal" plays beats 1-5 across its own full local share; a solo
// "drink" plays 1 + 6-7. A combined action is still exactly two
// back-to-back per-kind cycles (meal's own full share, then drink's own
// full share) — eatingPhaseAt already guarantees this split; nothing here
// changes that boundary. ----

// Fractions of ONE KIND's own local 0..1 share — tuned so "hold up the
// bite, chew" and "tilt the plate/glass" both get a real, visible
// window rather than being instantaneous. Meal: fork phase first, then
// the plate-lift phase. Drink: a bare hold (no separate "fork" stage)
// straight into the glass-lift.
const MEAL_FORK_END = 0.34; // fork-to-mouth + chewing ends here
const MEAL_PLATE_LIFT_END = 0.5; // plate fully risen+tilted by here
const MEAL_PLATE_LOWER_START = 0.86; // plate starts descending here
const MEAL_PLATE_LANDED_BY = 0.96; // plate is fully back on the table by here — see the REST_BUFFER note below
const DRINK_LIFT_END = 0.22;
const DRINK_LOWER_START = 0.74;
const DRINK_LANDED_BY = 0.92; // glass is fully back on the table by here

// 2026-11-05 manual-acceptance correction: the lowering phase previously
// finished landing EXACTLY at local=1.0 — the same instant the server's
// own lock naturally expires. With zero buffer between "finished landing"
// and "the window is actually over," ordinary SSE/poll round-trip latency
// (confirmed directly: the client's own clear typically lands 100-600ms
// after the true local=1.0, not before — a real, measured range, not
// assumed) meant the viewer's own LAST SEEN frame was still mid-descent,
// the plate/glass genuinely hanging in front of the chest when the scene
// vanished — exactly the "空盘不悬在胸前" (the empty plate must not hang
// in front of the chest) the student's own playtest called out. Giving
// the lowering phase its own earlier finish line (*_LANDED_BY, well
// before 1.0) means the prop is provably resting ON the table for a real,
// visible span before the window — and any ordinary network jitter on
// top of it — ever ends, confirmed by re-running the same burst-
// screenshot timing check this correction was itself found with.

/** Smoothstep-style ease for every continuous motion below — a plain
 * linear ramp reads as mechanical at this scale; this keeps every
 * rise/tilt/lower feeling like an actual arm movement without needing a
 * real physics/easing library for a handful of lerps. */
function ease(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/** All the derived sub-phase values drawEatingScene needs for a 'meal'
 * kind, purely a function of localProgress — kept as one pure helper so
 * the actual drawing code below just reads named fields instead of
 * re-deriving thresholds inline. */
function mealBeats(local) {
  const forkRaise = ease(Math.min(1, local / (MEAL_FORK_END * 0.5)));
  const forkLower = local > MEAL_FORK_END * 0.5 ? ease(Math.min(1, (local - MEAL_FORK_END * 0.5) / (MEAL_FORK_END * 0.5))) : 0;
  const forkHeight = local <= MEAL_FORK_END ? forkRaise - forkLower : 0; // 0..1..0 bite arc
  const chewing = local > MEAL_FORK_END * 0.25 && local < MEAL_FORK_END * 0.85;
  const biteEaten = local >= MEAL_FORK_END * 0.6; // the one forked bite disappears from the plate partway through its own arc

  let plateLift = 0, plateTilt = 0;
  if (local <= MEAL_FORK_END) {
    plateLift = 0; plateTilt = 0;
  } else if (local < MEAL_PLATE_LIFT_END) {
    const t = ease((local - MEAL_FORK_END) / (MEAL_PLATE_LIFT_END - MEAL_FORK_END));
    plateLift = t; plateTilt = t; // rises and tilts together, continuously
  } else if (local < MEAL_PLATE_LOWER_START) {
    plateLift = 1; plateTilt = 1; // held up, tipped to the mouth, emptying
  } else if (local < MEAL_PLATE_LANDED_BY) {
    const t = ease((local - MEAL_PLATE_LOWER_START) / (MEAL_PLATE_LANDED_BY - MEAL_PLATE_LOWER_START));
    plateLift = 1 - t; plateTilt = 1 - t; // continuous un-tilt + lower, together
  } else {
    // Genuinely resting on the table for the remainder of the window —
    // this real, visible rest span (not just a mathematical instant at
    // local=1.0) is what the fix above is actually for.
    plateLift = 0; plateTilt = 0;
  }
  // Food remaining on the plate: the one forked bite goes first (a visible
  // notch), then the rest drains away continuously while the plate itself
  // is held up tilted (never instantly empty the moment it's lifted).
  const plateEmptySpan = Math.max(0.0001, MEAL_PLATE_LOWER_START - MEAL_PLATE_LIFT_END);
  const plateConsumed = local <= MEAL_PLATE_LIFT_END ? 0 : ease(Math.min(1, (local - MEAL_PLATE_LIFT_END) / plateEmptySpan));
  return { forkHeight, chewing, biteEaten, plateLift, plateTilt, plateConsumed };
}

function drinkBeats(local) {
  let lift = 0;
  if (local <= DRINK_LIFT_END) lift = ease(local / DRINK_LIFT_END);
  else if (local < DRINK_LOWER_START) lift = 1;
  else if (local < DRINK_LANDED_BY) lift = 1 - ease((local - DRINK_LOWER_START) / (DRINK_LANDED_BY - DRINK_LOWER_START));
  else lift = 0; // genuinely resting on the table for the remainder of the window
  const span = Math.max(0.0001, DRINK_LOWER_START - DRINK_LIFT_END);
  const consumed = local <= DRINK_LIFT_END ? 0 : Math.min(1, (local - DRINK_LIFT_END) / span);
  return { lift, consumed };
}

/** A filled ellipse — used for the plate rim/inner-circle and the
 * glass's own rounded bowl, since a plate/glass drawn only from boxes
 * reads as a slab, never as tableware (the student's own specific
 * complaint about the previous version). */
function ellipse(ctx, x, y, rx, ry, color) {
  if (rx <= 0 || ry <= 0) return;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---- 2026-11-05 manual-acceptance correction ----
//
// The student's own real-browser playtest rejected the previous round's
// contact geometry outright: the glass's rim reached up near the eyes
// instead of the mouth, the plate's CENTRE (not its near rim) was being
// driven toward the mouth, and a grey, vertically-standing utensil was
// left floating beside the character with nothing holding it. All three
// traced to the same root cause — every prop computed its own ad hoc
// offset toward a loosely-shared "mouth height" number, rather than every
// prop being placed from one single shared anchor set (MOUTH/TABLE/hand
// rests below) via the actual geometry of what "contact" means for that
// prop's own shape (a flat-vs-tilted ellipse for the plate, a rotated
// local point for the glass). This section replaces that ad hoc approach
// with exactly one coordinate system and two small, independently
// testable pure geometry functions (plateCenterForRim/glassOriginForRim)
// that every prop's placement is derived from — see spec/eatingAnimation.test.ts's
// own geometry checks, which re-run the SAME forward transform these
// functions are built from and assert the resulting rim/rotated point
// actually lands within a small pixel tolerance of the mouth, rather than
// re-asserting the formula's own output (the student's own explicit
// instruction: verify the transformed contact point, don't just restate
// the implementation).

/** The plate's own vertical half-extent at a given tilt — the single
 * source of truth both drawPlate itself and this file's own rim-contact
 * math read from, so "how flat is the plate right now" can never silently
 * drift between the two. */
function plateRy(w, tilt) {
  return w * 0.22 * (1 - tilt * 0.92); // never fully to 0 — a hairline edge still reads as "a plate", not nothing
}

/** Given the on-screen point the plate's own NEAR rim — the edge closest
 * to the mouth, the point that actually makes contact, never the plate's
 * centre — must land at, returns the ellipse centre drawPlate itself must
 * be given. The near rim sits at local (0, -ry) relative to the centre in
 * this scene's own up-is-negative-y convention, so centre = rim + (0, ry).
 * Exported as its own pure function specifically so it can be verified
 * directly: feed it a rim target and a tilt, and the rim of the ellipse
 * drawPlate would actually draw at the returned centre is provably at
 * that exact target, not merely "close by construction." */
export function plateCenterForRim(rimX, rimY, ry) {
  return { x: rimX, y: rimY + ry };
}

/** Rotates the point (px,py) by `theta` radians — canvas's own rotation
 * convention (ctx.rotate), used below so the glass's contact math matches
 * exactly what ctx.rotate will actually do to its local geometry, not an
 * approximation of it. */
export function rotatePoint(px, py, theta) {
  const c = Math.cos(theta), sn = Math.sin(theta);
  return { x: px * c - py * sn, y: px * sn + py * c };
}

/** Given the desired on-screen contact point for the glass's own rim
 * (local point (0, -bowlH), the top of its bowl before any rotation) at a
 * given tilt `theta`, returns the untransformed (x, y) drawGlass must be
 * called with so that ctx.translate(x,y); ctx.rotate(theta) places that
 * exact local rim point at (contactX, contactY) on screen — "compute the
 * rim's actual position from the rotation angle, then derive the
 * translation" (the student's own explicit instruction), rather than
 * guessing a translation and hoping the rim lands near the target. This
 * is the exact inverse of the forward transform
 * (origin + rotate(localPoint, theta) = onScreenPoint), so any caller can
 * verify correctness by re-applying the forward transform to the
 * returned origin and checking it reproduces the requested contact point
 * (spec/eatingAnimation.test.ts does exactly this, not just re-stating
 * this formula). */
export function glassOriginForRim(contactX, contactY, bowlH, theta) {
  const rimLocal = rotatePoint(0, -bowlH, theta);
  return { x: contactX - rimLocal.x, y: contactY - rimLocal.y };
}

/** The plate, drawn with real thickness/rim/inner-circle so it reads as
 * a dish rather than a rectangle. `tilt` (0..1) continuously rotates it
 * from lying flat (an ellipse, food visible on top) to edge-on (a thin
 * sliver — its own underside facing the viewer), via a vertical scale on
 * the ellipse itself — this IS the "plate continuously flips to show its
 * back" behaviour, expressed as geometry rather than a whole-canvas
 * zoom/snap. `food` (0..1, 1 = full) draws the remaining portion only
 * while the plate is still closer to flat than edge-on, since food on an
 * edge-on plate wouldn't visibly sit on it anyway. `x,y` is always this
 * plate's own ELLIPSE CENTRE (as returned by plateCenterForRim) — never
 * the contact/rim point directly, which is what caused the previous
 * round's "centre aimed at the mouth" bug. */
function drawPlate(ctx, x, y, w, tilt, food, biteNotch) {
  const ry = plateRy(w, tilt);
  const rx = w / 2;
  ellipse(ctx, x, y + ry * 0.12, rx * 1.02, ry * 1.1, '#00000022'); // soft shadow of the rim's own thickness
  ellipse(ctx, x, y, rx, ry, '#efe3c9'); // plate body
  ellipse(ctx, x, y, rx * 0.72, ry * 0.72, '#f8f1dd'); // inner well
  ellipse(ctx, x, y, rx * 0.72, ry * 0.72, '#00000012'); // faint well shading
  if (food > 0.02 && tilt < 0.6) {
    const foodAlpha = Math.min(1, (0.6 - tilt) / 0.3);
    ctx.save();
    ctx.globalAlpha = foodAlpha;
    const fw = rx * 0.95 * food;
    const fh = ry * 0.5 * food;
    ellipse(ctx, x - (biteNotch ? rx * 0.08 : 0), y, fw, fh, '#8a5f3f');
    ellipse(ctx, x - (biteNotch ? rx * 0.08 : 0), y - fh * 0.2, fw * 0.7, fh * 0.55, '#a9754c');
    ctx.restore();
  }
}

/** A stemmed glass (bowl + stem + base), tilted continuously toward the
 * mouth as it's lifted, with a visibly draining liquid level. `x,y` is
 * always this glass's own untransformed TRANSLATE ORIGIN, as returned by
 * glassOriginForRim — never a guessed "roughly near the mouth" point,
 * which is what let the rim drift up near the eyes in the previous
 * round. */
function drawGlass(ctx, x, y, h, tiltRad, liquidFrac) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tiltRad);
  const bowlW = h * 0.46, bowlH = h * 0.5, stemH = h * 0.32, baseW = h * 0.4;
  // Base + stem, drawn first (lowest, behind the bowl).
  ctx.fillStyle = '#d8d2c0';
  ctx.fillRect(-baseW / 2, stemH + bowlH * 0.02, baseW, h * 0.05);
  ctx.fillRect(-h * 0.035, 0, h * 0.07, stemH);
  // The bowl: an outer glass shell (a rounded trapezoid via two ellipses
  // and a connecting rect reads close enough at this scale) plus the
  // liquid drawn only up to its own current, shrinking level from the
  // bowl's own bottom.
  const bowlTopY = -bowlH, bowlBottomY = 0;
  ctx.fillStyle = '#f5ecd955';
  ctx.beginPath();
  ctx.moveTo(-bowlW * 0.32, bowlBottomY);
  ctx.lineTo(-bowlW * 0.5, bowlTopY);
  ctx.lineTo(bowlW * 0.5, bowlTopY);
  ctx.lineTo(bowlW * 0.32, bowlBottomY);
  ctx.closePath();
  ctx.fill();
  ellipse(ctx, 0, bowlTopY, bowlW * 0.5, bowlW * 0.14, '#f5ecd977'); // rim ellipse — the contact point glassOriginForRim solves for
  if (liquidFrac > 0.01) {
    const liquidTopY = bowlBottomY - (bowlBottomY - bowlTopY) * liquidFrac;
    const liquidHalfW = bowlW * (0.32 + 0.18 * liquidFrac);
    ctx.fillStyle = '#d99a4f';
    ctx.beginPath();
    ctx.moveTo(-bowlW * 0.32, bowlBottomY);
    ctx.lineTo(-liquidHalfW, liquidTopY);
    ctx.lineTo(liquidHalfW, liquidTopY);
    ctx.lineTo(bowlW * 0.32, bowlBottomY);
    ctx.closePath();
    ctx.fill();
    ellipse(ctx, 0, liquidTopY, liquidHalfW, bowlW * 0.1, '#e6b162');
  }
  ctx.restore();
}

/** A face drawn directly on the close-up head — eyes, eyebrows, nose,
 * mouth — the student's own specific complaint about the previous
 * version ("人物没有五官"). `chewing` animates the mouth between a
 * closed line and a small open oval; otherwise a plain closed mouth.
 * `headX/headY/headW/headH` are the already-positioned head box this is
 * drawn relative to, so this needs no knowledge of the outer transform.
 * `mouthY` is always computed by `mouthAnchor` below — kept as a passed-in
 * value rather than recomputed here so the face and every prop reaching
 * toward it can never silently use two different formulas for the same
 * point. */
function drawFace(ctx, headX, headY, headW, headH, mouthY, skin, chewing) {
  const eyeY = headY + headH * 0.42;
  const eyeDX = headW * 0.22, eyeW = headW * 0.1, eyeH = headH * 0.07;
  // Eyebrows, just above the eyes.
  ctx.fillStyle = '#4a3a30';
  ctx.fillRect(headX + headW / 2 - eyeDX - eyeW * 0.6, eyeY - eyeH * 2.1, eyeW * 1.8, eyeH * 0.5);
  ctx.fillRect(headX + headW / 2 + eyeDX - eyeW * 1.2, eyeY - eyeH * 2.1, eyeW * 1.8, eyeH * 0.5);
  // Eyes — simple dark ellipses, legible at this close-up scale.
  ellipse(ctx, headX + headW / 2 - eyeDX, eyeY, eyeW * 0.55, eyeH * 0.6, '#2b2320');
  ellipse(ctx, headX + headW / 2 + eyeDX, eyeY, eyeW * 0.55, eyeH * 0.6, '#2b2320');
  // Nose — a small vertical shading stroke, not a filled shape (reads as
  // a nose bridge at this scale without looking like a growth).
  ctx.strokeStyle = '#00000030'; ctx.lineWidth = Math.max(1, headW * 0.015);
  ctx.beginPath(); ctx.moveTo(headX + headW / 2, eyeY + eyeH); ctx.lineTo(headX + headW / 2, mouthY - headH * 0.12); ctx.stroke();
  // Mouth — animates open/closed while chewing, a plain closed line otherwise.
  if (chewing) {
    const openness = 0.4 + 0.6 * Math.abs(Math.sin(Date.now() / 140));
    ellipse(ctx, headX + headW / 2, mouthY, headW * 0.16, headH * 0.07 * openness, '#6b3a34');
  } else {
    ctx.strokeStyle = '#6b3a34'; ctx.lineWidth = Math.max(1, headW * 0.03);
    ctx.beginPath(); ctx.moveTo(headX + headW / 2 - headW * 0.14, mouthY); ctx.lineTo(headX + headW / 2 + headW * 0.14, mouthY); ctx.stroke();
  }
  void skin; // kept in the signature for symmetry/future use (e.g. a skin-toned nose highlight); not needed for the current strokes
}

/** The ONE shared anchor the entire scene places every prop relative to —
 * exported so spec/eatingAnimation.test.ts can compute it exactly once
 * and reuse it to verify every other prop's own contact point against the
 * same value, rather than each test re-deriving its own copy of "where is
 * the mouth" and silently drifting from what the drawing code actually
 * uses. `headX` only matters for drawFace's own horizontal centring;
 * every prop below reaches for x=0 (the character's own horizontal
 * centre line in this scene's translated coordinate space), matching
 * drawFace's own `headX + headW/2`. */
export function mouthAnchor(headY, headH) {
  return { x: 0, y: headY + headH * 0.78 };
}

/** Lying flat on the table, oriented along the X axis — the student's own
 * explicit fix for the previous round's grey, vertically-standing utensil
 * that read as floating beside the character with nothing holding it. A
 * knife/fork at rest always has this one clear position and orientation;
 * it is never drawn standing on end. */
function drawRestingFork(ctx, x, y, len) {
  ctx.fillStyle = '#cfd3d8';
  ctx.fillRect(x - len / 2, y - len * 0.05, len * 0.6, len * 0.1); // handle
  ctx.fillRect(x - len / 2 + len * 0.58, y - len * 0.09, len * 0.42, len * 0.18); // tine block
  ctx.fillStyle = '#9aa0a8';
  for (let i = 0; i < 3; i++) ctx.fillRect(x - len / 2 + len * 0.64 + i * len * 0.12, y - len * 0.09, len * 0.045, len * 0.18);
}
function drawRestingKnife(ctx, x, y, len) {
  ctx.fillStyle = '#cfd3d8';
  ctx.fillRect(x - len / 2, y - len * 0.04, len * 0.68, len * 0.08); // blade
  ctx.fillStyle = '#9aa0a8';
  ctx.fillRect(x - len / 2 + len * 0.66, y - len * 0.07, len * 0.34, len * 0.14); // handle
}

// The seated eating/drinking cutscene (CLAUDE.md's seated-eating
// section) — a third-person close-up drawn with the viewer's own
// clothing colour/skin tone, over a dining-table or counter/back-bar
// background depending on where they're seated. Pure canvas drawing,
// code-authored like the rest of this file's art (CLAUDE.md: original or
// clearly licensed, never copied). Kept as its own module-level
// function, not a method on the big closure below, since it only needs
// its 2D context, the colour/skin hexes already in scope, and plain
// numbers — nothing from the rest of createTavern's internal state.
// `box(x, y, w, h, colour)` is intentionally a 5-argument helper closing
// over this function's own `ctx` — a prior round's bug was calling it
// with a stray leading `ctx` argument copied from this file's OTHER
// `box(c, x, y, w, h, colour)` helper (used for the live map canvas);
// every call site below passes exactly five arguments, never six.
function drawEatingScene(ctx, vw, vh, { color, skin, phase, seatKind, reduceMotion }) {
  const cx = vw / 2, cy = vh / 2;
  const box = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
  // Background: the counter/back-bar (dark cabinet, bottles) for a bar
  // stool, a dining-table close-up (warm wood, a plate) otherwise —
  // CLAUDE.md's two required backgrounds, reusing this file's existing
  // warm pixel palette (the same cabinetBottle/rug colours drawn
  // elsewhere in this module for the live map).
  if (seatKind === 'stool') {
    box(0, 0, vw, vh, '#2e211d');
    box(0, vh * 0.55, vw, vh * 0.45, '#6b4635');
    box(0, vh * 0.55, vw, 6, '#8a5f3f');
    for (let i = 0; i < 5; i++) box(vw * 0.08 + i * vw * 0.18, vh * 0.12, vw * 0.07, vh * 0.3, ['#729f80', '#9c6848', '#b78a59', '#5e7d9e', '#8a594c'][i % 5]);
  } else {
    box(0, 0, vw, vh, '#473943');
    box(0, vh * 0.58, vw, vh * 0.42, '#8d4545');
    box(vw * 0.08, vh * 0.6, vw * 0.84, vh * 0.06, '#ad7054');
  }
  if (!phase) return;
  // The seated figure, large and centred — reuses this scene's own
  // skin/colour swatches, not the shared world sprite() primitive (that
  // one is tuned for a small top-down tile, not a close-up).
  const s = Math.min(vw, vh) / 7;
  ctx.save();
  ctx.translate(cx, cy + s * 0.6);
  box(-s * 1.1, -s * 0.4, s * 2.2, s * 1.4, color); // torso
  const headX = -s * 0.7, headY = -s * 1.9, headW = s * 1.4, headH = s * 1.5;
  box(headX, headY, headW, headH, skin); // head
  box(headX - s * 0.2, headY - s * 0.15, headW + s * 0.4, s * 0.55, '#43302d'); // hair
  const tableY = -s * 0.15; // resting height on the table/counter top
  const local = Math.max(0, Math.min(1, phase.localProgress ?? 0));

  // ONE shared coordinate system every prop below reaches toward or rests
  // on — the student's own explicit requirement. No prop computes its own
  // independent "approximately near the mouth/table" offset; every
  // contact point is derived from MOUTH/TABLE plus that prop's own real
  // geometry (plateCenterForRim for the plate, glassOriginForRim's actual
  // rotation math for the glass).
  const MOUTH = mouthAnchor(headY, headH);
  const TABLE = { x: s * 0.1, y: tableY };
  const HAND_L_REST = { x: TABLE.x - s * 0.95, y: TABLE.y }; // character's own right hand -> screen-left (fork)
  const HAND_R_REST = { x: TABLE.x + s * 0.95, y: TABLE.y }; // character's own left hand -> screen-right (knife/glass)

  const chewingNow = phase.kind === 'meal' && mealBeats(local).chewing;
  drawFace(ctx, headX, headY, headW, headH, MOUTH.y, skin, reduceMotion ? false : chewingNow);

  // A small sipping/chewing wobble only while actually holding something
  // up near the mouth, skipped entirely under prefers-reduced-motion
  // (CLAUDE.md: a less-motion pose is fine, a frozen illusion of eating is
  // not required to move). Applied only to the MOUTH-side end of a lerp
  // below, scaled by how close the prop currently is to the mouth, so it
  // never pulls a resting prop off the table and never moves the verified
  // contact point by more than this small amplitude.
  const wobbleAmp = reduceMotion ? 0 : s * 0.025;
  const wobble = reduceMotion ? 0 : Math.sin(Date.now() / 160) * wobbleAmp;

  const lerp = (a, b, t) => a + (b - a) * t;

  if (phase.kind === 'meal') {
    const { forkHeight, biteEaten, plateLift, plateTilt, plateConsumed } = mealBeats(local);
    const PLATE_W = s * 1.8;
    const UTENSIL_LEN = s * 0.9;

    // Fork: rests flat on the table until its own bite beat raises it;
    // the FOOD END (the tine block, drawn at the tip) is what travels to
    // MOUTH — never just "the hand" — and lowers back to its exact
    // resting pose afterward (forkHeight returns to 0 by construction).
    if (forkHeight > 0.02) {
      const forkTip = { x: lerp(HAND_L_REST.x, MOUTH.x, forkHeight) + wobble * forkHeight, y: lerp(HAND_L_REST.y, MOUTH.y, forkHeight) };
      ctx.strokeStyle = skin; ctx.lineWidth = s * 0.22; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(HAND_L_REST.x, HAND_L_REST.y + s * 0.1); ctx.lineTo(forkTip.x, forkTip.y); ctx.stroke();
      // The food end: a small tine block plus, while still near the
      // plate, a visible morsel riding on it — this is the "food reaches
      // the mouth" beat, not a bare rectangle standing in for a hand.
      box(forkTip.x - s * 0.06, forkTip.y - s * 0.07, s * 0.12, s * 0.14, '#cfd3d8');
      if (forkHeight < 0.75) ellipse(ctx, forkTip.x, forkTip.y - s * 0.02, s * 0.07 * (1 - forkHeight / 0.75), s * 0.05 * (1 - forkHeight / 0.75), '#8a5f3f');
    } else {
      drawRestingFork(ctx, HAND_L_REST.x, HAND_L_REST.y, UTENSIL_LEN);
    }
    // Knife: always resting, flat, on its own clear table position —
    // never drawn standing on end, never left floating once the plate is
    // lifted (the actual bug the student's screenshot caught: a grey,
    // vertical, unheld shape beside the character).
    drawRestingKnife(ctx, HAND_R_REST.x, HAND_R_REST.y, UTENSIL_LEN);

    if (plateLift > 0.02) {
      // Beats 3-5: the plate's own NEAR RIM — not its centre — travels
      // continuously from just above the table to MOUTH as plateLift
      // goes 0..1, while plateTilt independently rotates it (via
      // plateRy's own vertical squish) from flat to edge-on. The two are
      // driven by the same mealBeats() values as before (unchanged
      // timing contract); only the contact-point math changed.
      const restRy = plateRy(PLATE_W, 0);
      const restContact = { x: TABLE.x, y: TABLE.y - restRy };
      const contact = { x: lerp(restContact.x, MOUTH.x, plateLift) + wobble * plateLift, y: lerp(restContact.y, MOUTH.y, plateLift) };
      const ry = plateRy(PLATE_W, plateTilt);
      const center = plateCenterForRim(contact.x, contact.y, ry);
      const rx = PLATE_W / 2;
      drawPlate(ctx, center.x, center.y, PLATE_W, plateTilt, 1 - plateConsumed, false);
      // Two hands holding the plate's own ACTUAL edges (± rx from its
      // real current centre) — they move with the plate because they are
      // computed from the plate's own current geometry every frame, not
      // from a separately-guessed offset.
      ctx.strokeStyle = skin; ctx.lineWidth = s * 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(HAND_L_REST.x, HAND_L_REST.y + s * 0.15); ctx.lineTo(center.x - rx * 0.85, center.y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(HAND_R_REST.x, HAND_R_REST.y + s * 0.15); ctx.lineTo(center.x + rx * 0.85, center.y); ctx.stroke();
    } else {
      // Beats 1/2: plate flat on the table — drawn at TABLE itself, tilt
      // 0, so its centre and its rim coincide with no lift applied yet.
      drawPlate(ctx, TABLE.x, TABLE.y, PLATE_W, 0, 1, biteEaten);
    }
  } else {
    const { lift, consumed } = drinkBeats(local);
    const GLASS_H = s * 1.1;
    const bowlH = GLASS_H * 0.5;
    const GLASS_REST = { x: TABLE.x + s * 0.45, y: TABLE.y };
    // The rim's own resting contact point, computed FORWARD from the
    // glass's real resting origin/geometry (theta=0) rather than assumed —
    // this is what keeps the lifted trajectory continuous with the
    // glass's own true resting pose instead of snapping at lift=0.
    const restContact = { x: GLASS_REST.x, y: GLASS_REST.y - bowlH };
    const contact = { x: lerp(restContact.x, MOUTH.x, lift) + wobble * lift, y: lerp(restContact.y, MOUTH.y, lift) };
    const theta = -lift * 0.9; // tips toward the mouth as it's raised
    // The actual fix: compute the translation FROM the rotation and the
    // desired rim position, not the other way around (CLAUDE.md's own
    // instruction this round, taken literally) — glassOriginForRim is the
    // exact algebraic inverse of what ctx.translate+ctx.rotate will do to
    // the glass's own local rim point.
    const origin = glassOriginForRim(contact.x, contact.y, bowlH, theta);
    if (lift > 0.02) {
      // The grip point is a REAL point on the glass's own stem (local
      // (0, stemH/2) before rotation, transformed the same way as the
      // rim) — the hand is drawn to that exact transformed point, so it
      // can never read as detached from the glass regardless of tilt.
      const stemH = GLASS_H * 0.32;
      const gripLocal = rotatePoint(0, stemH * 0.55, theta);
      const grip = { x: origin.x + gripLocal.x, y: origin.y + gripLocal.y };
      ctx.strokeStyle = skin; ctx.lineWidth = s * 0.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(HAND_R_REST.x, HAND_R_REST.y + s * 0.15); ctx.lineTo(grip.x, grip.y); ctx.stroke();
    }
    drawGlass(ctx, origin.x, origin.y, GLASS_H, theta, 1 - consumed);
  }
  ctx.restore();
}

// A password <input> plus its own independent show/hide eye toggle
// (2026-11-04) — used by every password field in the account forms
// (login, register, confirm, and the later reset-password form), so the
// behavior is defined once rather than copied per field. Returns
// {wrapper, input}: `wrapper` is what the caller actually appends to the
// DOM (an input-and-button pair), `input` is the real <input> element
// for reading .value / calling .focus().
//
// - type="button" on the toggle, never type="submit" — clicking it must
//   never submit the enclosing <form> (a real risk here specifically,
//   since every caller of this helper sits inside a form whose own
//   submit handler does real work).
// - Each instance owns its own closed-over `visible` flag — toggling one
//   field never touches any other field's own visibility, content, or
//   focus; clicking the eye re-focuses the input afterward so the next
//   keystroke lands where the user expects rather than on the button.
// - aria-label text and aria-pressed both flip with the state ("Show
//   password" / "Hide password"), so a screen reader announces the
//   actual current action, not a static label.
// - Nothing here writes the password anywhere (no console.log, no
//   storage) — toggling visibility only ever changes the input's own
//   `type` attribute, which the browser already renders; this helper
//   introduces no new place a password value could end up persisted.
function passwordField(el, { id, placeholder, autocomplete, required=true }) {
  let visible=false;
  const input=el('input',{type:'password',id,placeholder,autocomplete,required:required||undefined});
  const eye=el('button',{
    type:'button',class:'password-toggle','aria-label':'Show password','aria-pressed':'false',
    'aria-controls':id,tabindex:'0',
  },[el('span',{'aria-hidden':'true',class:'password-toggle-icon'},'👁')]);
  eye.onclick=()=>{
    visible=!visible;
    input.type=visible?'text':'password';
    eye.setAttribute('aria-label',visible?'Hide password':'Show password');
    eye.setAttribute('aria-pressed',String(visible));
    eye.classList.toggle('password-toggle-active',visible);
    input.focus();
  };
  const wrapper=el('div',{class:'password-field'},[input,eye]);
  return {wrapper,input};
}

export function createTavern({ el, render, navigate, buildClassicPanel, saveSession, shouldApplyLiveUpdate, createMenuBook, mixologyModule, ordersApi, accountsApi }) {
  const menuBook=createMenuBook({el,mixologyModule,ordersApi});
  const colors = { red:'#c85e59', blue:'#6485bc', green:'#629e86', yellow:'#ddba65', purple:'#997cb5', teal:'#66b5b0', orange:'#cf8858', pink:'#cd88a3' };
  const skins = { fair:'#f3d7b6', warm:'#dcb58a', tan:'#ba875f', brown:'#906044', deep:'#614437' };
  let dispose = () => {};
  let enteredThisPage = false;
  const sessionKey = 'vegas:bar:session';
  // A real, previously-undocumented weakness found this round: the eating
  // cutscene's own client-side "has endsAt passed?" check originally
  // compared the server's endsAt directly against this browser's own
  // Date.now(), unconditionally assuming the two clocks agree. A real
  // browser can run meaningfully ahead of or behind the server's own
  // clock (an unsynced system clock, a VM, a phone with manual time set)
  // — reproduced directly with a 6-second-fast simulated browser clock:
  // the cutscene vanished roughly 5 seconds BEFORE the server's real lock
  // actually ended. The server's own gating was never at risk (confirmed
  // in the same test: a direct move attempt during that window was still
  // correctly refused with eating_active — gameplay authority has always
  // been server-only, CLAUDE.md's own standing rule, and this bug could
  // never bypass it), but the player would be staring at the ordinary
  // world with no visible reason they still can't act. `clockSkewMs` is a
  // rolling estimate of (server time − this browser's own Date.now()),
  // taken from the standard `Date` response header every ordinary bar
  // request already receives for free (no new endpoint, no extra round
  // trip) — `serverNow()` below is what the eating-expiry check now
  // compares against instead of a bare `Date.now()`.
  //
  // The `Date` header is only second-precision (RFC 7231) — real
  // measurement found this introduces up to roughly ±1s of its own noise
  // even on a perfectly synced clock, which showed up as the cutscene
  // lingering ~100ms past the true end in one real run. SKEW_DEADBAND_MS
  // ignores any estimate smaller than that noise floor, so the overwhelmingly
  // common well-synced-clock case stays exactly as accurate as a bare
  // Date.now() comparison always was; only a genuinely large skew (several
  // seconds, the actual bug this exists to fix) is ever corrected for.
  const SKEW_DEADBAND_MS = 1500;
  let clockSkewMs = 0;
  function noteServerTime(res) {
    const header = res.headers && res.headers.get && res.headers.get('date');
    if (!header) return;
    const serverMs = Date.parse(header);
    if (Number.isNaN(serverMs)) return;
    const estimate = serverMs - Date.now();
    clockSkewMs = Math.abs(estimate) > SKEW_DEADBAND_MS ? estimate : 0;
  }
  function serverNow() { return Date.now() + clockSkewMs; }
  const post = async (path, body) => {
    const r = await fetch('/api/bar'+path,{ method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body) });
    noteServerTime(r);
    const data = await r.json(); if(!r.ok) throw Object.assign(new Error(data.message),{status:r.status}); return data;
  };
  const read = async path => { const r=await fetch('/api/bar'+path); noteServerTime(r); if(!r.ok) throw new Error('Unable to connect to the tavern'); return r.json(); };
  function sprite(c,x,y,color,skin,scale=1,step=0,seated=false) {
    c.save(); c.translate(Math.round(x),Math.round(y)); c.scale(scale,scale);
    const rect=(a,b,w,h,t)=>{c.fillStyle=t;c.fillRect(a,b,w,h);};
    c.fillStyle='#130e1760'; c.beginPath(); c.ellipse(0,1,12,4,0,0,Math.PI*2);c.fill();
    const leg=Math.sin(step)*2;
    if(seated){
      rect(-11,-12,22,7,'#393a52');rect(-11,-5,6,7,'#393a52');rect(5,-5,6,7,'#393a52');
      rect(-13,1,9,4,'#251f2d');rect(4,1,9,4,'#251f2d');
    }else{
      rect(-7,-12,6,12+leg,'#393a52'); rect(1,-12,6,12-leg,'#393a52');
      rect(-8,leg-3,7,4,'#251f2d');rect(1,-leg-3,8,4,'#251f2d');
    }
    rect(-10,-28,20,17,color);rect(-10,-13,20,3,'#00000022');
    rect(-14,-26,4,12,skin);rect(10,-26,4,12,skin);
    rect(-9,-45,18,18,skin);rect(-11,-48,22,8,'#43302d');
    rect(-11,-40,4,8,'#43302d');rect(7,-40,4,6,'#43302d');
    rect(-5,-36,2,3,'#302635');rect(4,-36,2,3,'#302635');rect(-2,-30,4,1,'#a56656');
    c.restore();
  }
  async function mount() {
    dispose(); document.body.classList.add('world-mode');
    let active=true, session=null, state={players:[],tables:[]}, mine=null, camera={x:0,y:0}, path=[], moving=false, frame=0, lowStaminaNotified=false;
    // The logged-in account's own {id, username}, or null for a guest —
    // refreshed from the server's own cookie-backed session (src/accountRoutes.ts's
    // GET /me), never inferred from anything stored client-side. Purely
    // a display/UI-gating concern: the actual bar identity this browser
    // controls always flows through `session` above exactly as it did
    // before accounts existed (CLAUDE.md:昵称只是显示名称... 不能把"换昵称"
    // 等同于换玩家 — likewise, logging in/out is a different thing from
    // "which bar identity is this browser currently acting as").
    let account=null;
    // A short poll (ACCOUNT_POLL_MS) for "did my account session get
    // replaced elsewhere" — the multi-device takeover's own explicit
    // requirement ("旧设备明确显示...") needs *some* way to notice a
    // revoked cookie without the user taking any action first. Reusing
    // the existing SSE/heartbeat channels would conflate two different
    // identity layers (account vs bar); a small dedicated interval is
    // simpler and correct, matching this file's own existing fallback-poll
    // pattern (the 10s state fetch below).
    let accountCheckTimer=null, loggedOutElsewhereShown=false;
    async function refreshAccount(){
      try{account=(await accountsApi.whoAmI()).account;}catch{account=null;}
      return account;
    }
    // This identity's own currently-bound table seat, if any —
    // {tableId, roomCode} or null, re-validated server-side on every
    // join/rejoin/appearance response (src/tables.ts's getActiveSeat),
    // never a client-trusted cache. Deliberately NOT part of `session`
    // (which is persisted to localStorage): a new character's first join
    // response always carries activeSeat:null, so "Return to your game"
    // can never leak a *different* character's game the way the old
    // single global vegas:lastRoom key did (PLAN.md's
    // product-direction-update entry — the actual reported bug).
    let activeSeat=null;
    let returnGameButton=null;
    let keys=new Set(), lastTime=0, destination=null, cameraInitialized=false, movementEpoch=0, heldDirection=null;
    // Crit 9: live updates arrive over SSE, not a fixed poll interval —
    // see CLAUDE.md. `liveCursor` is this channel's staleness-gate
    // baseline (`{epoch, seq}`, or `null` before the first payload is
    // ever applied); every incoming payload — a push, a fallback fetch, a
    // mutation's own response — goes through applyIncoming, which defers
    // the actual accept/reject decision to the shared
    // `shouldApplyLiveUpdate` (public/liveSync.js, passed in from
    // app.js — the same function tavern.js's room-view sibling uses, not
    // a separately hand-written copy; a Crit 9 phase 7 review pointed out
    // two copies passing the same manual trace isn't the guarantee one
    // shared function actually is). `pendingMoveTarget` is the narrow
    // exception: while this patron's own step is in flight, an update
    // that predates it must not visually snap the local avatar back to
    // its pre-move tile — every *other* player's position and the live
    // table list still apply immediately regardless (continuous walking
    // must not block receiving others' updates).
    let liveCursor=null, eventSource=null, pendingMoveTarget=null, visibilityHandler=null;
    // Phase 2 (product-direction-update): the seat a click/tap is walking
    // this patron toward, if any — set by beginSit, consumed once step()
    // confirms arrival at that exact tile (see step() below). Click-a-
    // chair-then-walk-then-sit is one gesture from the player's point of
    // view, but still two real, separately-validated server calls: a
    // normal adjacent-step /move for each tile of the walk, then one
    // /seats/:id/sit once actually standing there — never a shortcut
    // around either check.
    let pendingSitSeat=null;
    // Product-direction-update, part 2: the walk-toward-a-player gesture
    // in flight — {playerId, approach:{x,y}, targetX, targetY, attempts}
    // or null — mirroring pendingSitSeat's own shape/lifecycle (set by a
    // click, consumed once step() confirms arrival, aborted by the
    // animate() loop if the target moves away too many times or goes
    // offline). Previously also triggered an auto-opened private chat
    // dialog on arrival; after the student's own acceptance testing, chat
    // became public speech bubbles (see the "say" section below) with no
    // per-player targeting at all, so this is now purely "walk up next to
    // someone instead of into them" — the original, chat-independent part
    // 2 rule.
    let approachTarget=null;
    // The seated eating/drinking lock (CLAUDE.md's seated-eating
    // section) — mirrors exactly what the public snapshot's own
    // mine.eating field says, never a locally-invented duration: the
    // cutscene's progress is always computed from the server's own
    // startedAt/endsAt, so a refresh or a reconnect mid-animation simply
    // resumes at the right point rather than restarting or losing it.
    // {kinds, startedAt, endsAt, seatKind} while active, else null.
    let eatingUI=null;
    // Set to the endsAt timestamp (ms) we've already triggered a catch-up
    // fetch for, so the 1-per-second animate() loop requests at most one
    // extra /state read per actual eating action rather than spamming the
    // server every frame once the local clock passes endsAt. Reset to null
    // whenever a genuinely new eatingUI is reconciled (reconcile() below).
    let eatingExpiryFetchedFor=null;
    const holdCleanups=[];
    // Same-browser, multiple-tabs logout sync: `localStorage.removeItem`
    // fires a `storage` event in every OTHER tab of the same origin (never
    // the tab that made the change) — exactly the signal needed for "I
    // logged out in tab 1, tab 2 should reflect that immediately" without
    // waiting for either poll below. A late response already in flight
    // for the old identity still can't resurrect this UI: `session` is
    // cleared here before any such response could land, and every bar
    // route re-checks the (now-gone) session_secret server-side anyway.
    const storageHandler=e=>{
      if(e.key!==sessionKey||e.newValue!==null||!active)return;
      session=null;mine=null;staminaFill.style.width='0%';staminaLabel.textContent='—';
      activeSeat=null;if(returnGameButton){returnGameButton.remove();returnGameButton=null;}
      overlay.replaceChildren();openAuthOverlay();
    };
    window.addEventListener('storage',storageHandler);
    dispose=()=>{
      active=false;holdCleanups.forEach(cleanup=>cleanup());document.body.classList.remove('world-mode');
      if(eventSource){eventSource.close();eventSource=null;}
      if(visibilityHandler){document.removeEventListener('visibilitychange',visibilityHandler);window.removeEventListener('focus',visibilityHandler);visibilityHandler=null;}
      window.removeEventListener('storage',storageHandler);
    };
    const displayPositions=new Map();
    const timers=[];
    const canvas=el('canvas',{'aria-label':'Shared tavern map',tabindex:'0'});
    const toast=el('div',{class:'world-toast','role':'status'},'WASD / arrows to walk · click the floor to explore');
    const online=el('span',{class:'online-count'},'Connecting…');
    // Phase 2: visible only while mine.seatId is set (toggled in
    // reconcile below) — standing up is always available from the HUD,
    // not just by walking away (which also stands you up, via the
    // server's own moveBar — src/bar.ts).
    const standBtn=el('button',{class:'hud-button',onclick:async()=>{
      try{const resp=await post('/stand',session);applyIncoming(resp);toast.textContent='Standing — click a chair to sit down.';}catch(e){toast.textContent=e.message||'Could not stand up';}
    }},'Stand up');
    standBtn.style.display='none';
    // Compact, read-only stamina readout beside "Your character" — a
    // server-computed status display, never a form field: there is no
    // input here, only a bar fill and a percentage rendered straight
    // from mine.stamina (reconcile() below), the same public field
    // every other per-player HUD element already reads. Clicking it
    // opens the same character panel "Your character" does (CLAUDE.md:
    // one combined entry point, not a second place to look), where the
    // full bar plus a short restore-amount note lives.
    const staminaFill=el('span',{class:'stamina-fill'});
    const staminaLabel=el('span',{class:'stamina-pct'},'—');
    const staminaButton=el('button',{class:'hud-button stamina-chip','aria-label':'View your stamina',onclick:()=>{path=[];chooseCharacter();}},[
      el('span',{class:'stamina-track'},[staminaFill]),staminaLabel,
    ]);
    const hud=el('header',{class:'world-hud'},[
      el('div',{class:'world-brand'},[el('span',{class:'brand-mark'},'◆'),el('div',{},[el('strong',{},'Las Vegas'),el('small',{},'A little place to be together')])]),
      el('div',{class:'hud-actions'},[online,standBtn,staminaButton,el('button',{class:'hud-button',onclick:()=>{path=[];chooseCharacter();}},'Your character'),el('button',{class:'hud-button',onclick:()=>openGames()},'Join by code')]),
    ]);
    const directions=el('div',{class:'world-dpad','aria-label':'Movement controls'});
    for(const [label,dx,dy] of [['↑',0,-1],['←',-1,0],['↓',0,1],['→',1,0]]) {
      const b=el('button',{'aria-label':`Walk ${label}`},label);directions.appendChild(b);
      holdCleanups.push(bindDirectionHold(b, {
        onPress:()=>{ if(!mine||overlay.childElementCount||eatingUI)return;path=[];heldDirection={dx,dy};queueStep(dx,dy); },
        onRelease:({cancelled})=>{ if(heldDirection?.dx===dx&&heldDirection?.dy===dy){heldDirection=null;if(cancelled)path=[];} },
        onTap:()=>queueStep(dx,dy),
      }));
    }
    const seatLayer=el('div',{class:'seat-layer'});
    // The overhead holding/eat/drink prompt (CLAUDE.md's seated-eating
    // section) — a single DOM button layered over the canvas, following
    // this patron's own head position every frame exactly like
    // menuBookButton/seat-target buttons already do, rather than a
    // canvas-drawn label (which can't be a real click target). Hidden
    // whenever there's nothing to show; its own text is set per-frame
    // from holdingLabelFor() below. Only ever rendered — let alone
    // clickable — for `mine`; a bystander's own holding/eating status is
    // drawn as a plain, non-interactive canvas tag in animate() instead
    // (CLAUDE.md: others can see it, but never click it for someone else).
    const eatPromptBtn=el('button',{class:'seat-target eat-prompt-target',onclick:async()=>{
      if(!mine||overlay.childElementCount||eatingUI)return;
      try{
        const idempotencyKey=`${session.playerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
        const resp=await ordersApi.startEating(session,idempotencyKey);
        eatingUI={kinds:resp.kinds,startedAt:resp.startedAt,endsAt:resp.endsAt,seatKind:mySeatKind()};
      }catch(e){toast.textContent=e.message||'Could not start eating.';}
    }});
    seatLayer.appendChild(eatPromptBtn);
    // The eating cutscene's own full-screen canvas — a separate layer
    // above everything else in the scene (including the HUD/toast),
    // shown only while eatingUI is set. Kept as a second canvas rather
    // than reusing the map's own one: the map canvas keeps rendering the
    // live world underneath at its own resolution/camera, which this
    // scene has no use for and would have to fight for context state
    // with (fillStyle/transform) every frame.
    const eatCanvas=el('canvas',{class:'eating-cutscene','aria-hidden':'true'});
    const eatCtx=eatCanvas.getContext('2d');
    const eatReduceMotion=typeof matchMedia==='function'?matchMedia('(prefers-reduced-motion: reduce)'):{matches:false};
    const scene=el('div',{class:'tavern-world'},[canvas,seatLayer,hud,toast,directions,eatCanvas]); render(scene);
    const overlay=el('div',{class:'world-overlay'});scene.appendChild(overlay);
    // The counter's own physical menu book (public/menuBook.js) — one
    // in-scene entry point replacing the old "Mixology book"/"Meals/
    // Drinks" HUD buttons entirely (CLAUDE.md). Its cover offers all
    // three destinations (the Mixology book, Meals, Drinks); opening it
    // stops held movement the same way every other overlay dialog here
    // already does.
    function openMenuBook(){
      if(!mine||overlay.childElementCount||eatingUI)return;
      path=[];destination=null;keys.clear();heldDirection=null;pendingSitSeat=null;approachTarget=null;
      menuBook.open(overlay,session,menuBookButton.getBoundingClientRect());
    }
    // Which background the cutscene should show — a stool (counter/
    // back-bar) or a dining-table seat — read from the real seat/
    // furniture layout, the same `layout.seats`/fixtures data every
    // other seat-aware function here already uses, never guessed from
    // position alone.
    function mySeatKind(){
      if(!mine?.seatId)return 'dining';
      const seat=(layout.seats||[]).find(s=>s.id===mine.seatId);
      const f=seat&&fixtures.find(x=>x.id===seat.furnitureId);
      return f?.kind==='stool'?'stool':'dining';
    }
    // "Eat" / "Drink" / "Eat & Drink", from this patron's own currently-
    // held kinds (CLAUDE.md: the prompt names the action, never the
    // specific dish) — null when there is nothing to hold/eat yet, which
    // hides the prompt entirely rather than showing an empty button.
    function holdingLabelFor(p){
      if(!p)return null;
      const seated=p.seatId!=null;
      const meal=p.holding?.meal, drink=p.holding?.drink;
      if(!meal&&!drink)return null;
      const what=meal&&drink?'Eat & Drink':meal?'Eat':'Drink';
      // Standing: a plain, non-clickable "holding" tag — can carry food/
      // a drink around, but can't consume it until actually seated
      // (CLAUDE.md: server already refuses this; the prompt just never
      // invites the click it would be refused anyway).
      return seated?{label:what,actionable:true}:{label:'Holding',actionable:false};
    }
    let layout;
    try { layout=await read('/layout'); } catch(e) {toast.textContent=e.message;return;}
    if(!active)return;
    const tile=64, worldW=layout.gridCols*tile,worldH=layout.gridRows*tile;
    const fixtures=layout.furniture;
    // A real-time Canberra/Sydney clock, mounted above the counter. Must
    // be drawn per-frame in animate() below, in screen space, never baked
    // into the static `floor` canvas further down — that canvas is
    // painted once at load and never updates, so a clock face baked into
    // it would freeze at load time. Intl.DateTimeFormat with an explicit
    // IANA zone resolves AEST/AEDT and the actual transition dates
    // correctly using the runtime's own tzdata — no hand-coded UTC
    // offset or DST rule of this app's own, which would silently go
    // wrong on the next transition.
    const counterFixture=fixtures.find(f=>f.kind==='counter');
    // The menu book sits on the counter's own top surface (CLAUDE.md:
    // "draw a clearly recognisable menu book on the front counter"),
    // placed 3 tiles in from the counter's right edge — clear of the
    // clock (mounted on the wall strip above, not the counter surface
    // itself: see drawClock's own placement reasoning just below) and
    // of the evenly-spaced bottle-shelf decoration drawn above the
    // counter in the fixtures loop further down, which only occupies
    // y-24..y-2 (above the counter's own tile row), never the surface
    // band (y+5..y+h-10) this book is drawn on.
    const bookWorldX=counterFixture?((counterFixture.x+counterFixture.w-3)*tile+tile/2):0;
    const bookWorldY=counterFixture?(counterFixture.y*tile+34):0;
    const clockTimeFmt=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Sydney',hour:'2-digit',minute:'2-digit',hour12:false});
    const clockAngleFmt=new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Sydney',hour:'numeric',minute:'numeric',second:'numeric',hour12:false});
    function drawClock(now){
      if(!counterFixture)return;
      // Mounted on the near wall strip directly above the counter (the
      // `wallX/wallY/wallW` band drawn in the static floor layer below,
      // which is itself derived from the real `back-bar` cabinet_wall
      // fixture — NOT the far brick wall at the top of the map, which an
      // earlier version of this placement mistakenly targeted after
      // misreading CORE_FURNITURE's pre-offset coordinates in the source
      // file instead of the actual, `+10,+6`-shifted values FURNITURE
      // exports and the server actually serves via GET /api/bar/layout.
      // That mistake put the clock nowhere near the counter at all (world
      // y=56, inside the distant top wall) — found only by querying the
      // live layout directly and comparing real numbers, not by trusting
      // a source-file read or a screenshot. Placed just past the
      // counter's own right edge, clear of its last candle sconce
      // (ends ~x+872) and the "Las Vegas" sign (centred, well to the
      // left) on one side, and the nearest hanging shelf unit on the
      // wall strip itself on the other — every one of those checked by
      // real coordinate arithmetic against the fixtures this function
      // already has in scope, the same way the plant/rug placements
      // elsewhere in this file were verified.
      const worldX=(counterFixture.x+counterFixture.w)*tile+40, worldY=counterFixture.y*tile-68;
      const x=worldX-camera.x, y=worldY-camera.y;
      if(x<-60||x>vw+60||y<-60||y>vh+60)return; // off-screen — skip the work
      const parts=Object.fromEntries(clockAngleFmt.formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
      const hour=parts.hour%12, minute=parts.minute, second=parts.second;
      const r=22;
      ctx.save();
      ctx.translate(x,y);
      ctx.fillStyle='#2e211d';ctx.beginPath();ctx.arc(0,0,r+6,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#e4bf7e';ctx.beginPath();ctx.arc(0,0,r+3,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#f5ecd9';ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();
      ctx.strokeStyle='#352b2d';ctx.lineWidth=1;
      for(let i=0;i<12;i++){
        const a=i*Math.PI/6;
        ctx.beginPath();ctx.moveTo(Math.sin(a)*(r-3),-Math.cos(a)*(r-3));ctx.lineTo(Math.sin(a)*(r-6),-Math.cos(a)*(r-6));ctx.stroke();
      }
      const hourAngle=(hour+minute/60)*Math.PI/6, minuteAngle=(minute+second/60)*Math.PI/30;
      ctx.lineCap='round';
      ctx.strokeStyle='#352b2d';ctx.lineWidth=2.5;
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.sin(hourAngle)*(r*0.5),-Math.cos(hourAngle)*(r*0.5));ctx.stroke();
      ctx.strokeStyle='#5a4a3f';ctx.lineWidth=1.6;
      ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(Math.sin(minuteAngle)*(r*0.78),-Math.cos(minuteAngle)*(r*0.78));ctx.stroke();
      ctx.fillStyle='#352b2d';ctx.beginPath();ctx.arc(0,0,2,0,Math.PI*2);ctx.fill();
      ctx.restore();
      // A small digital readout below the analog face, specifically for
      // legibility at the 390px mobile breakpoint where the analog hands
      // alone would be too small to read at a glance.
      const label=clockTimeFmt.format(now);
      ctx.font='bold 11px monospace';ctx.textAlign='center';
      const width=ctx.measureText(label).width+14;
      ctx.fillStyle='#292635dc';ctx.fillRect(x-width/2,y+r+9,width,15);
      ctx.fillStyle='#f5e7d2';ctx.fillText(label,x,y+r+20);
    }
    const seatTargets=[];
    for(const s of layout.seats||[]){
      const f=fixtures.find(f=>f.id===s.furnitureId);
      const label=`Sit — ${f?.kind==='stool'?'bar stool':'dining chair'} ${s.id}`;
      const button=el('button',{class:'seat-target','aria-label':label,'data-hint':'Sit down',title:'Sit down',onclick:()=>{
        if(!mine||overlay.childElementCount||eatingUI)return;
        // A seat-target button is a separate DOM element layered over the
        // canvas — it never goes through the canvas's own click handler,
        // so the same player-click-takes-priority rule (part 2) has to be
        // repeated here: someone actually seated there is walked up to,
        // never just refused as "taken".
        const occupant=playerAt(s.x,s.y);
        if(occupant){approachPlayer(occupant);return;}
        beginSit(s);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    for(const s of layout.gameChairs||[]){
      const f=fixtures.find(f=>f.id===s.tableId);
      const button=el('button',{class:'seat-target','aria-label':`Choose ${s.color} seat — ${f.label}`,'data-hint':f.available?`Choose ${s.color} seat`:'Not yet open',title:f.available?`Choose ${s.color} seat`:'Not yet open',onclick:()=>{
        if(!mine||overlay.childElementCount||eatingUI)return;
        // A present game occupant's effective position is this exact
        // chair tile (src/position.ts) — clicking it walks up to them
        // (part 2's "real chair position, not a hidden lobby coordinate"
        // rule), same priority as any other player click, ahead of the
        // table dialog this chair would otherwise open.
        const occupant=playerAt(s.x,s.y);
        if(occupant){approachPlayer(occupant);return;}
        if(!f.available)toast.textContent=f.label;
        else if(f.tableMode==='npc')openNpcTableDialog(f,s.color);
        else openTableDialog(f,s.color);
      }});
      seatLayer.appendChild(button);seatTargets.push({...s,button});
    }
    // The menu book's own clickable hotspot — a real DOM button layered
    // over the canvas, following the exact same "separate hitbox tracks
    // drawn art every frame, never routed through the canvas's own
    // click-to-tile handler" pattern every seat-target button above
    // already uses (CLAUDE.md: "the hit area must track the map's own
    // pan/zoom and never be a floating control independent of it"). No
    // hover-only text label sits over the book at rest — `data-hint`
    // only renders on `:hover`/`:focus-visible` (seat-target's own CSS,
    // reused here unmodified), and `title` gives the same text to a
    // touch/keyboard user who can't hover. Reachable by Tab (a real
    // `<button>`) and by a plain tap on mobile (CLAUDE.md: "must not
    // require hover to be discoverable").
    const menuBookButton=el('button',{class:'seat-target menu-book-target','aria-label':'Open the counter’s book','data-hint':'Open the book','title':'Open the book',onclick:()=>{
      if(!mine||overlay.childElementCount||eatingUI)return;
      openMenuBook();
    }});
    seatLayer.appendChild(menuBookButton);
    const ctx=canvas.getContext('2d');
    let vw=window.innerWidth,vh=window.innerHeight;
    const resize=()=>{
      vw=window.innerWidth;vh=window.innerHeight;const dpr=Math.min(devicePixelRatio||1,2);
      canvas.width=vw*dpr;canvas.height=vh*dpr;canvas.style.width=vw+'px';canvas.style.height=vh+'px';ctx.setTransform(dpr,0,0,dpr,0,0);
      eatCanvas.width=vw*dpr;eatCanvas.height=vh*dpr;eatCanvas.style.width=vw+'px';eatCanvas.style.height=vh+'px';eatCtx.setTransform(dpr,0,0,dpr,0,0);
    };resize();
    window.addEventListener('resize',resize);
    // Mirrors src/barLayout.ts's isWalkingFloor, from the same
    // FURNITURE list (fetched via GET /api/bar/layout) — a fixture with
    // blocksMovement:false (the restroom) is a walkable zone marker, not
    // an obstacle, same rule server-side, so the two can't disagree.
    function walkable(x,y) {return x>=0&&x<layout.gridCols&&y>=0&&y<layout.gridRows&&!fixtures.some(f=>f.blocksMovement!==false&&x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h)&&![...(layout.seats||[]),...(layout.gameChairs||[])].some(s=>s.x===x&&s.y===y);}
    function canStep(x,y){return walkable(x,y)&&!occupiedByOther(x,y)&&(!(x!==mine.x&&y!==mine.y)||(walkable(mine.x,y)&&walkable(x,mine.y)));}
    // Product-direction-update, part 2: no two patrons may occupy the
    // same tile. `state.players` already reports each online patron's
    // *effective* position (src/position.ts — a present game-table
    // occupant's real chair tile, never a frozen pre-game coordinate),
    // so this single check is correct for a standing bar patron and a
    // seated game occupant alike, with no special-casing between them.
    function occupiedByOther(x,y){return state.players.some(p=>mine&&p.id!==mine.id&&p.x===x&&p.y===y);}
    // Which other online patron (if any) is standing at this exact tile —
    // used to give a player-click priority over the floor/furniture/seat
    // beneath them, the same lookup reused by every click surface below
    // (the canvas itself, a seat-target button, a game-chair button) so
    // the three can't drift into disagreeing about who's clickable where.
    function playerAt(x,y){return state.players.find(p=>mine&&p.id!==mine.id&&p.x===x&&p.y===y);}
    // Breadth-first path on a small grid; each submitted step is still checked
    // server-side. No client teleport, no optimistic persistent positions.
    // Avoids every other patron's current tile, not just furniture — a
    // path is never planned straight through someone else's body.
    function findPath(tx,ty) {
      if(!mine||!walkable(tx,ty)||occupiedByOther(tx,ty))return [];
      const start=`${mine.x},${mine.y}`,end=`${tx},${ty}`,q=[[mine.x,mine.y]],prev=new Map([[start,null]]);
      for(let i=0;i<q.length;i++){const [x,y]=q[i];if(`${x},${y}`===end)break;
        for(const [dx,dy] of [[0,-1],[1,0],[0,1],[-1,0]]){const nx=x+dx,ny=y+dy,k=`${nx},${ny}`;if(walkable(nx,ny)&&!occupiedByOther(nx,ny)&&!prev.has(k)){prev.set(k,`${x},${y}`);q.push([nx,ny]);}}
      }
      if(!prev.has(end))return [];const result=[];let key=end;while(key!==start){result.unshift(key.split(',').map(Number));key=prev.get(key);}return result;
    }
    function queueStep(dx,dy){if(!mine||moving||overlay.childElementCount||eatingUI)return;const x=mine.x+dx,y=mine.y+dy;if(canStep(x,y)){pendingSitSeat=null;approachTarget=null;path=[[x,y]];destination={x,y};}}
    // The one free-adjacent-tile picker behind both "click an occupied
    // floor tile" (part 2) and "click a nearby player to chat" (part 3):
    // among the up to 4 cardinal neighbours of (tx,ty) that are actually
    // walkable, unoccupied, and in bounds, picks whichever is closest
    // (Manhattan) to the mover's own current position — the side nearest
    // the clicker when one exists, and simply the nearest reachable
    // fallback otherwise. Never the target's own tile: a click never
    // walks *into* someone, only up next to them. Returns null if every
    // neighbour is blocked.
    function findApproachTile(tx,ty){
      if(!mine)return null;
      const candidates=[[0,-1],[0,1],[-1,0],[1,0]].map(([dx,dy])=>({x:tx+dx,y:ty+dy}))
        .filter(c=>walkable(c.x,c.y)&&!occupiedByOther(c.x,c.y));
      if(!candidates.length)return null;
      candidates.sort((a,b)=>(Math.abs(a.x-mine.x)+Math.abs(a.y-mine.y))-(Math.abs(b.x-mine.x)+Math.abs(b.y-mine.y)));
      return candidates.find(c=>(c.x===mine.x&&c.y===mine.y)||findPath(c.x,c.y).length)||null;
    }
    function manhattan(ax,ay,bx,by){return Math.abs(ax-bx)+Math.abs(ay-by);}
    // Phase 2 (product-direction-update): "click an empty chair, walk
    // there, sit down" is one gesture — if already beside the chair,
    // sit immediately; otherwise path to adjacent clear floor first
    // (ordinary, server-validated step by step) and let step() below
    // finish the gesture once it confirms arrival.
    function beginSit(seat){
      if(!mine||overlay.childElementCount||eatingUI)return;
      if(manhattan(mine.x,mine.y,seat.x,seat.y)<=1){
        path=[];destination=null;pendingSitSeat=null;
        post(`/seats/${seat.id}/sit`,session).then(resp=>{applyIncoming(resp);toast.textContent='Seated — use Stand up to leave the chair.';}).catch(e=>{toast.textContent=e.message||'Could not sit down';});
        return;
      }
      const approach=findApproachTile(seat.x,seat.y);
      if(!approach){toast.textContent='No clear space beside this chair.';return;}
      pendingSitSeat=seat;path=findPath(approach.x,approach.y);destination=path.length?approach:null;
      if(!path.length)pendingSitSeat=null;
    }
    // Product-direction-update, part 2: clicking a player walks up to a
    // free adjacent tile rather than into them — never a chat trigger
    // (that was part 3's own, now superseded by public speech bubbles;
    // see CLAUDE.md's "Public tavern speech" section for the history).
    function approachPlayer(player){
      if(!mine||overlay.childElementCount||eatingUI||player.id===mine.id)return;
      if(manhattan(mine.x,mine.y,player.x,player.y)<=1)return; // already adjacent — nothing more to do
      const approach=findApproachTile(player.x,player.y);
      if(!approach){toast.textContent="Can't reach them right now.";return;}
      pendingSitSeat=null;
      approachTarget={playerId:player.id,approach,targetX:player.x,targetY:player.y,attempts:0};
      path=findPath(approach.x,approach.y);destination=path.length?approach:null;
      if(!path.length){approachTarget=null;toast.textContent="Can't reach them right now.";}
    }
    function reconcile(next){
      state=next;
      mine=state.players.find(p=>p.id===session?.playerId)||mine;
      if(pendingMoveTarget&&mine)mine={...mine,x:pendingMoveTarget.x,y:pendingMoveTarget.y};
      online.textContent=`${state.players.length} here`;
      standBtn.style.display=mine?.seatId?'':'none';
      // Server-computed, read-only — rendered straight from the public
      // snapshot's own stamina field, never written back anywhere.
      if(typeof mine?.stamina==='number'){
        const pct=Math.round(mine.stamina);
        staminaFill.style.width=`${Math.max(0,Math.min(100,pct))}%`;
        staminaLabel.textContent=`${pct}%`;
        staminaButton.classList.toggle('stamina-low',pct<20);
        // A gentle, one-time nudge per low-stamina stretch — never a
        // forced action (CLAUDE.md: stamina never blocks a roll, a bet,
        // or walking to the counter). Resets once stamina rises back
        // above the threshold (eating/drinking, or simply time passing
        // differently), so a second genuine dip is nudged again rather
        // than only ever once per whole session.
        if(pct<20&&!lowStaminaNotified){lowStaminaNotified=true;toast.textContent='Getting low on energy — the counter has meals and drinks.';}
        else if(pct>=20)lowStaminaNotified=false;
      }
      // Recovers the eating lock straight from the server's own public
      // field on every reconcile — including the very first one after a
      // fresh page load/refresh or a reconnect — rather than only ever
      // being set locally by the prompt's own click handler. This is
      // what makes a mid-animation refresh resume the cutscene instead
      // of silently losing it, and what clears it the moment the
      // server's own lazy-expiry says the 8 seconds are up, with no
      // client "I'm done" message required either way (CLAUDE.md).
      if(mine?.eating){
        if(!eatingUI||eatingUI.startedAt!==mine.eating.startedAt){
          eatingUI={kinds:mine.eating.kinds,startedAt:mine.eating.startedAt,endsAt:mine.eating.endsAt,seatKind:mySeatKind()};
          eatingExpiryFetchedFor=null;
        }
      }else if(eatingUI){
        eatingUI=null;
      }
    }
    // The staleness rule for this channel: public/liveSync.js's
    // shouldApplyLiveUpdate, shared with app.js (see this file's own doc
    // comment for the full contract). A late-arriving stale response and
    // two near-simultaneous updates racing each other are handled by the
    // plain seq comparison, same as before; the epoch check is what
    // additionally survives a real server restart mid-session (seq alone
    // can't — a restarted process's seq legitimately restarts at 0,
    // which a bare "incoming<=lastSeq" rule would reject forever).
    function applyIncoming(next){
      if(typeof next.epoch==='number'&&typeof next.seq==='number'){
        const incoming={epoch:next.epoch,seq:next.seq};
        if(!shouldApplyLiveUpdate(liveCursor,incoming))return;
        liveCursor=incoming;
      }
      reconcile(next);
    }
    async function fetchAndApply(){if(!session)return;try{applyIncoming(await read('/state'));}catch(e){toast.textContent='Connection interrupted — retrying…';}}
    function connectEvents(){
      if(eventSource)eventSource.close();
      const es=new EventSource('/api/bar/events');
      es.onmessage=ev=>{try{applyIncoming(JSON.parse(ev.data));}catch{}};
      // Fires on first connect *and* every automatic reconnect — either
      // way, one unconditional fresh fetch rather than trusting nothing
      // was missed while the connection was down.
      es.onopen=()=>{fetchAndApply();};
      eventSource=es;
    }
    function openGames(){
      path=[];
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':'Game rooms'},[
        el('button',{class:'dialog-close','aria-label':'Close game rooms',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'PULL UP A CHAIR'),buildClassicPanel(),
      ]));
    }
    // Phase 2: each Vegas fixture is bound to its own independent room
    // (src/tables.ts), not a generic "create a room" form — this reads
    // that table's *current* status fresh on every click (not a cached
    // guess) and offers exactly the one legal action for it. The bar
    // nickname is reused automatically (never re-asked); only a game
    // colour — a different, smaller palette from the bar's own — is
    // chosen here, and taken colours at a waiting table are disabled
    // rather than left to fail server-side.
    // 5, not 4 — the official rulebook ships 5 player colours' worth of
    // dice (see src/rooms.ts's MAX_PLAYERS comment); this mirrors that
    // server-side constant, with no shared module linking the two (a
    // pre-existing risk, not new — spec/tables.test.ts exercises the
    // real server-side limit regardless of what this list says).
    const GAME_COLORS=['red','blue','green','yellow','purple'];
    const MAX_SEATS=GAME_COLORS.length;
    async function openTableDialog(f,preferredColor){
      if(f.gameType==='dominoes'){window.dispatchEvent(new CustomEvent('domino-open',{detail:{mode:'online',seat:preferredColor}}));return;}
      if(f.gameType==='texas'){window.dispatchEvent(new CustomEvent('poker-open',{detail:{mode:'online',seat:preferredColor}}));return;}
      path=[];
      let tableList;
      try{tableList=await read('/tables');}catch(e){toast.textContent='Could not reach the tables — try again.';return;}
      const t=tableList.find(x=>x.id===f.id);
      if(!t){toast.textContent='That table is not available.';return;}

      const taken=new Set(t.takenColors||[]);
      if(preferredColor&&taken.has(preferredColor)){toast.textContent='That chair is occupied. Choose another chair.';return;}
      let selected=preferredColor&&!taken.has(preferredColor)?preferredColor:GAME_COLORS.find(c=>!taken.has(c))||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const isEmpty=t.status==='empty';
      const isWaiting=t.status==='waiting';
      const roomFull=t.playerCount>=MAX_SEATS;
      // Phase 3 (product-direction-update): the first person to open an
      // empty table is seated immediately as host; everyone after that
      // submits a request the host approves or declines — never an
      // immediate seat (CLAUDE.md's leave/exit states section references
      // this same split). A waiting table that's already full can't even
      // accept a new request.
      const canAct=isEmpty||(isWaiting&&!roomFull);

      const swatches=el('div',{class:'avatar-swatches','aria-label':'Table colour (seat preview)'},GAME_COLORS.map(c=>
        el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,disabled:taken.has(c),
          'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
          onclick:e=>{if(taken.has(c))return;selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
        },'')));

      const statusLine=isEmpty?`${f.label} is empty.`
        :`${f.label} — ${t.playerCount}/${MAX_SEATS} ${isWaiting?'waiting to start':t.status==='in_progress'?'mid-game':'round over'}.`;
      const pendingNote=t.pendingCount>0?` (${t.pendingCount} waiting for the host's approval)`:'';
      const subtitle=isEmpty
        ? `Starting as ${mine?.nickname??'you'} — just pick a table colour, and you're the host.`
        : isWaiting
          ? (roomFull
              ? `This table already has its ${MAX_SEATS} players.${pendingNote}`
              : `Pick a colour to request a seat — the host approves or declines it.${pendingNote}`)
          : t.status==='in_progress'
            ? "This table is already playing — ask to be invited, or wait for it to finish."
            : "This round is over. Whoever's hosting can disband it to free the table.";

      const body=[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'VEGAS DICE'),el('h1',{},statusLine),
        el('p',{class:'dialog-subtitle'},subtitle),
      ];
      if(canAct){
        body.push(swatches,error,el('button',{class:'enter-world',onclick:async e=>{
          const btn=e.currentTarget;btn.disabled=true;error.textContent='';
          try{
            const endpoint=isEmpty?'create':'join';
            const result=await post(`/tables/${f.id}/${endpoint}`,{...session,color:selected});
            try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
            // A deliberate, explicit "heading back to this table" action —
            // clears any pending away-from-table departure (see
            // src/tables.ts's resumeActiveTable for why only an explicit
            // action like this one, never a passive heartbeat, may do so).
            await post('/resume',session);
            overlay.replaceChildren();
            navigate(`/?room=${result.code}`);
          }catch(err){error.textContent=err.message||'Could not join that table';btn.disabled=false;}
        }},isEmpty?'Start a game here':'Request to join'));
      }
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
    }
    // A solo NPC table (src/tables.ts's startNpcGame) is never a dialog
    // about a shared table's live status — there's no host, no waiting
    // list, no approval, and nobody else can ever show up here, so this
    // is a separate, simpler flow from openTableDialog above: pick a
    // colour, start immediately against 3 computer-controlled opponents.
    async function openNpcTableDialog(f,preferredColor){
      if(f.gameType==='dominoes'){window.dispatchEvent(new CustomEvent('domino-open',{detail:{mode:'offline',seat:preferredColor}}));return;}
      if(f.gameType==='texas'){window.dispatchEvent(new CustomEvent('poker-open',{detail:{mode:'offline',seat:preferredColor}}));return;}
      path=[];
      // Total players including the human (2-MAX_SEATS), defaulting to
      // the full table ("默认五人" — the product default, not a cap this
      // dialog invents: src/tables.ts's startNpcGame validates the real
      // range regardless of what this sends). Choosing a count narrows
      // the colour swatches below to the first `count` of them, so the
      // human's own colour choice and "how many NPCs" can never produce a
      // contradiction (e.g. picking a colour that a lower count would
      // have had to assign to an NPC seat instead).
      let count=MAX_SEATS;
      let selected=preferredColor||GAME_COLORS[0];
      const error=el('p',{class:'error',role:'alert'});
      const countRow=el('div',{class:'avatar-swatches','aria-label':'Total players, including you'});
      const swatchRow=el('div',{class:'avatar-swatches','aria-label':'Table colour (seat preview)'});
      const startBtn=el('button',{class:'enter-world',onclick:async e=>{
        const btn=e.currentTarget;btn.disabled=true;error.textContent='';
        try{
          const result=await post(`/tables/${f.id}/start-npc`,{...session,color:selected,playerCount:count});
          try{saveSession(result.code,{playerId:result.playerId,sessionSecret:result.sessionSecret});}catch{}
          await post('/resume',session);
          overlay.replaceChildren();
          navigate(`/?room=${result.code}`);
        }catch(err){error.textContent=err.message||'Could not start that table';btn.disabled=false;}
      }},'');
      function renderCountRow(){
        countRow.replaceChildren(...Array.from({length:MAX_SEATS-1},(_,i)=>i+2).map(n=>
          el('button',{type:'button',class:'avatar-swatch count-swatch','aria-label':`${n} players`,
            'aria-pressed':n===count?'true':'false',
            onclick:()=>{
              count=n;
              if(!GAME_COLORS.slice(0,count).includes(selected))selected=GAME_COLORS[0];
              renderCountRow();renderSwatches();renderStart();
            },
          },String(n))));
      }
      function renderSwatches(){
        swatchRow.replaceChildren(...GAME_COLORS.slice(0,count).map(c=>
          el('button',{type:'button',class:'avatar-swatch','aria-label':`Colour ${c}`,
            'aria-pressed':c===selected?'true':'false',style:`--swatch:${colors[c]}`,
            onclick:e=>{selected=c;for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');},
          },'')));
      }
      function renderStart(){
        const npcCount=count-1;
        startBtn.textContent=`Play vs. ${npcCount} NPC${npcCount===1?'':'s'}`;
      }
      renderCountRow();renderSwatches();renderStart();
      const body=[
        el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>overlay.replaceChildren()},'×'),
        el('p',{class:'eyebrow'},'VEGAS DICE · OFFLINE MODE'),el('h1',{},f.label),
        el('p',{class:'dialog-subtitle'},"Just you against computer-controlled opponents — starts right away, nobody else can join."),
        el('p',{class:'option-label'},'Players (including you)'),countRow,
        swatchRow,error,startBtn,
      ];
      overlay.replaceChildren(el('section',{class:'world-dialog game-dialog',role:'dialog','aria-label':f.label},body));
    }
    // ---- Public tavern speech (product-direction-update, part 3's
    // replacement for private 1:1 chat, after the student's own
    // acceptance testing — see CLAUDE.md's "Public tavern speech"
    // section) — a compact always-visible input, never a dialog, never
    // targeted at anyone: everyone watching the bar sees the bubble. ----
    //
    // A client-generated id per outgoing message (crypto.randomUUID when
    // available, a timestamp+random fallback otherwise — this only needs
    // to be unique per sender, never verified client-side) is what makes
    // a retried /say after a dropped response idempotent server-side
    // (src/bar.ts's say): the same id resent twice is the same logical
    // utterance, applied once, and must not restart the display clock.
    function newClientMsgId(){
      try{if(crypto.randomUUID)return crypto.randomUUID();}catch{}
      return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const speechInput=el('input',{class:'speech-input',placeholder:'Say something…',maxlength:'500','aria-label':'Say something to the tavern'});
    const speechSend=el('button',{class:'hud-button speech-send'},'Send');
    const speechBar=el('div',{class:'speech-bar'},[speechInput,speechSend]);
    speechBar.id='tavern-speech-input';speechBar.hidden=true;
    const speechToggle=el('button',{class:'speech-toggle','aria-label':'Open chat','aria-expanded':'false','aria-controls':speechBar.id,title:'Chat'},[el('span',{'aria-hidden':'true'},'•••')]);
    function toggleSpeech(open){
      speechBar.hidden=!open;speechToggle.setAttribute('aria-expanded',String(open));
      speechToggle.setAttribute('aria-label',open?'Close chat':'Open chat');
      keys.clear();heldDirection=null;path=[];
      if(open)speechInput.focus();else canvas.focus();
    }
    // Real bug, not just a visual one (2026-11-04): every other
    // interactive control in this file already checks
    // overlay.childElementCount before acting (movement, clicks, seat
    // targets, keydown) — this toggle never did, so the chat bubble
    // button remained clickable (and, worse, visually painted on top of)
    // any open dialog, including the new login/signup form. The CSS
    // fix below (`.tavern-world:has(>.world-overlay>*) .speech-toggle`)
    // hides it from view the same way world-overlay's own :has()
    // selector already hides the map's background tint rules; this JS
    // guard is the actual behavioral fix (a hidden-but-still-wired
    // onclick could still fire from a stale reference or synthetic
    // event) and the one that matches this file's own established
    // pattern for every other control.
    speechToggle.onclick=()=>{if(overlay.childElementCount)return;toggleSpeech(speechBar.hidden);};
    speechInput.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();toggleSpeech(false);}});
    async function doSay(){
      if(!mine)return;
      const text=speechInput.value.trim();
      if(!text)return;
      speechSend.disabled=true;
      try{
        applyIncoming(await post('/say',{...session,clientMsgId:newClientMsgId(),text}));
        speechInput.value='';
      }catch(e){toast.textContent=e.message||'Could not send that message';}
      speechSend.disabled=false;
    }
    speechSend.onclick=doSay;
    speechInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doSay();}});
    scene.append(speechBar,speechToggle);
    // Revokes the server-side account session (the cookie itself is
    // cleared by the server's own Set-Cookie response — see
    // src/accountRoutes.ts's logout route), then clears every piece of
    // THIS browser's own cached identity for the character that account
    // controlled: the bar session, every room session this tab might
    // still be holding, and voice/game credentials are covered
    // transitively since they're never cached independently of those —
    // a late response to any in-flight request for the OLD identity
    // naturally 403s once this has run, never silently resurrecting the
    // old UI (CLAUDE.md: "迟到的响应不能恢复旧账号界面"). Logging out
    // itself never calls exitGame/fold/disband — CLAUDE.md's own
    // "退出登录... 不能把旧玩家座位交给新账号" is about NOT silently
    // reassigning a seat, not about forcing an exit; an active game seat
    // simply keeps running exactly as the existing disconnect-tolerant
    // policy already handles any other disconnect.
    async function doLogout(){
      if(activeSeat&&!confirm("You're still seated at a game table. Logging out won't exit it — your seat is handled by the normal disconnect rules, exactly like closing this tab would be. Log out anyway?")){
        return false;
      }
      try{await accountsApi.logout();}catch{}
      account=null;
      session=null;
      try{localStorage.removeItem(sessionKey);}catch{}
      activeSeat=null;
      if(returnGameButton){returnGameButton.remove();returnGameButton=null;}
      // This browser no longer controls any identity at all — clear the
      // just-logged-out character's own cached view (nickname tag,
      // sprite, stamina chip) rather than leaving it rendered stale
      // behind the auth overlay until some future server response
      // happens to overwrite it (CLAUDE.md: "退出/切换...不能把...界面
      // 恢复"). `mine` stays null until a fresh join/login repopulates it.
      mine=null;
      staminaFill.style.width='0%';staminaLabel.textContent='—';
      enteredThisPage=false;
      return true;
    }
    // Shown exactly once, right after the codes are generated (at
    // registration, after a successful reset, or after a voluntary
    // regenerate) — the server has already forgotten the plaintext by
    // the time this renders (only the hash is ever stored), so this is
    // the one and only chance the user has to see these. `onDone` is
    // called once the user explicitly acknowledges — never auto-advances
    // on a timer, since copying/writing them down takes real time.
    function renderRecoveryCodes(codes,onDone){
      const copyMsg=el('p',{class:'dialog-footnote',role:'status'},'');
      overlay.replaceChildren(el('section',{class:'world-dialog auth-dialog',role:'dialog','aria-label':'Save your recovery codes'},[
        el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Save these recovery codes'),
        el('p',{class:'dialog-subtitle'},"If you ever forget your password, any ONE of these unused codes lets you set a new one. Each code works only once, and this is the only time they'll ever be shown — write them down or copy them somewhere safe now."),
        el('ul',{class:'recovery-code-list'},codes.map(code=>el('li',{},el('code',{},code)))),
        el('div',{class:'account-panel-actions'},[
          el('button',{type:'button',class:'hud-button',onclick:async()=>{
            try{
              if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
              await navigator.clipboard.writeText(codes.join('\n'));
              copyMsg.textContent='Copied to clipboard.';
            }catch{copyMsg.textContent="Couldn't copy automatically — please select and copy the codes above.";}
          }},'Copy all'),
        ]),
        copyMsg,
        el('button',{type:'button',class:'enter-world',onclick:()=>{overlay.replaceChildren();onDone();}},"I've saved these codes"),
      ]));
    }
    // A logged-in user voluntarily re-rolling their own recovery-code
    // batch (e.g. after using one, or suspecting the old batch leaked) —
    // requires the current password first (CLAUDE.md: "旧账号补设恢复方
    // 式必须验证当前密码"), the server's own check, not just a client
    // gate.
    function openRegenerateRecoveryCodes(){
      const error=el('p',{class:'error',role:'alert'});
      const currentPasswordField=passwordField(el,{id:'regen-current-password',placeholder:'Current password',autocomplete:'current-password'});
      const submit=el('button',{type:'submit',class:'enter-world'},'Get new codes');
      const form=el('form',{class:'world-dialog auth-dialog',role:'dialog','aria-label':'Get new recovery codes',onsubmit:async e=>{
        e.preventDefault();submit.disabled=true;error.textContent='';
        try{
          const result=await accountsApi.regenerateRecoveryCodes({currentPassword:currentPasswordField.input.value});
          renderRecoveryCodes(result.recoveryCodes,()=>chooseCharacter());
        }catch(err){error.textContent=err.message||'Could not generate new codes';submit.disabled=false;}
      }},[
        el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Get new recovery codes'),
        el('p',{class:'dialog-subtitle'},'This replaces your entire existing batch — any old codes, used or not, stop working.'),
        el('label',{for:'regen-current-password'},'Current password'),currentPasswordField.wrapper,
        error,submit,
        el('button',{type:'button',class:'hud-button',onclick:()=>chooseCharacter()},'Cancel'),
      ]);overlay.replaceChildren(form);currentPasswordField.input.focus();
    }
    // The floating Log in / Sign up / Continue as guest entry point
    // (CLAUDE.md's account section) — shown over the existing character
    // editor rather than replacing it, since "continue as guest" is
    // exactly today's existing chooseCharacter() flow with nothing new
    // required of it.
    function openAuthOverlay(startMode='menu'){
      let mode=startMode; // 'menu' | 'login' | 'register' | 'reset'
      const error=el('p',{class:'error',role:'alert'});
      function renderMenu(){
        error.textContent='';
        overlay.replaceChildren(el('section',{class:'world-dialog auth-dialog',role:'dialog','aria-label':'Log in or sign up'},[
          el('button',{class:'dialog-close','aria-label':'Close',onclick:()=>{overlay.replaceChildren();chooseCharacter();}},'×'),
          el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Welcome back — or welcome in.'),
          el('div',{class:'auth-menu'},[
            el('button',{type:'button',class:'enter-world',onclick:()=>{mode='login';renderForm();}},'Log in'),
            el('button',{type:'button',class:'enter-world',onclick:()=>{mode='register';renderForm();}},'Sign up'),
            el('button',{type:'button',class:'hud-button',onclick:()=>{overlay.replaceChildren();chooseCharacter();}},'Continue as guest'),
          ]),
          error,
        ]));
      }
      function renderForm(){
        error.textContent='';
        const username=el('input',{placeholder:'Username',id:'auth-username',maxlength:'24',required:true,autocomplete:'username'});
        const passwordField1=passwordField(el,{id:'auth-password',placeholder:'Password',autocomplete:mode==='login'?'current-password':'new-password'});
        const password=passwordField1.input;
        const confirmPasswordField=mode==='register'?passwordField(el,{id:'auth-confirm',placeholder:'Confirm password',autocomplete:'new-password'}):null;
        const confirmPassword=confirmPasswordField?confirmPasswordField.input:null;
        // The optional "keep my current guest character" checkbox
        // (CLAUDE.md: 服务器验证过的当前游客凭证进行一次性、事务性的绑定) —
        // only offered when this browser actually has a guest character
        // right now (`session` set) and only at signup; nothing is
        // trusted here beyond the fact that this checkbox was ticked —
        // the actual proof is session.playerId/sessionSecret, verified
        // server-side exactly the way every other bar action already is.
        const migrateCheckbox=(mode==='register'&&session)?el('input',{type:'checkbox',id:'auth-migrate',checked:true}):null;
        const submit=el('button',{type:'submit',class:'enter-world'},mode==='login'?'Log in':'Create account');
        const form=el('form',{class:'world-dialog auth-dialog',role:'dialog','aria-label':mode==='login'?'Log in':'Sign up',onsubmit:async e=>{
          e.preventDefault();submit.disabled=true;error.textContent='';
          try{
            let result;
            if(mode==='login'){
              result=await accountsApi.login({username:username.value,password:password.value});
            }else{
              if(password.value!==confirmPassword.value){error.textContent='Passwords do not match';submit.disabled=false;return;}
              result=await accountsApi.register({
                username:username.value,password:password.value,confirmPassword:confirmPassword.value,
                migrateGuest:(migrateCheckbox&&migrateCheckbox.checked&&session)?{playerId:session.playerId,sessionSecret:session.sessionSecret}:null,
              });
            }
            account={id:result.accountId,username:result.username};
            if(result.barPlayerId){
              // A fresh bar secret is only reported for login (always,
              // via the takeover rotation) or a brand-new register with
              // no migration — a migrated-guest register deliberately
              // reports none (the browser already holds the real one),
              // so keep the existing local session in that case rather
              // than overwriting it with undefined.
              if(result.barSessionSecret){
                session={playerId:result.barPlayerId,sessionSecret:result.barSessionSecret};
                try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}
              }
              // A Vegas room this account is actively bound to gets its
              // own freshly-rotated credential too (the takeover design,
              // CLAUDE.md) — update this tab's own cached room session so
              // "Return to your game" and any already-open room view use
              // the new credential rather than the one that was just
              // revoked.
              if(result.vegasRoom){
                saveSession(result.vegasRoom.code,{playerId:result.barPlayerId,sessionSecret:result.vegasRoom.sessionSecret});
              }
            }
            const afterAuth=async()=>{
              if(session){
                try{const resp=await post('/rejoin',session);applyIncoming(resp);activeSeat=resp.activeSeat??null;}catch{}
              }
              chooseCharacter();
            };
            // A brand-new account's first recovery-code batch is shown
            // exactly once, right here — nothing else in this app ever
            // has another chance to show these (only the hash survives
            // server-side). A login never generates new codes, so this
            // only ever fires for mode==='register'.
            if(result.recoveryCodes){
              renderRecoveryCodes(result.recoveryCodes,afterAuth);
            }else{
              overlay.replaceChildren();
              await afterAuth();
            }
          }catch(err){error.textContent=err.message||'Could not complete that request';submit.disabled=false;}
        }},[
          el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},mode==='login'?'Log in':'Sign up'),
          el('label',{for:'auth-username'},'Username'),username,
          el('label',{for:'auth-password'},'Password'),passwordField1.wrapper,
          ...(confirmPasswordField?[el('label',{for:'auth-confirm'},'Confirm password'),confirmPasswordField.wrapper]:[]),
          ...(migrateCheckbox?[el('div',{class:'auth-migrate-row'},[migrateCheckbox,el('label',{for:'auth-migrate'},'Keep my current guest character')])]:[]),
          error,submit,
          ...(mode==='login'?[el('button',{type:'button',class:'hud-button auth-forgot-link',onclick:()=>{mode='reset';renderResetForm();}},'Forgot password?')]:[]),
          el('button',{type:'button',class:'hud-button',onclick:()=>{mode='menu';renderMenu();}},'Back'),
          ...(mode==='register'?[el('p',{class:'dialog-footnote'},'No email is required. If you forget your password, the recovery codes shown after signup are the only way back in — there is no email-based recovery.')]:[]),
        ]);overlay.replaceChildren(form);username.focus();
      }
      // The reset-password form (CLAUDE.md's recovery-code design) — a
      // real recovery code is the ONLY proof accepted here, never
      // username/nickname/localStorage alone. No account cookie is read
      // or required: by definition, someone resetting a forgotten
      // password cannot be expected to still have a valid session.
      function renderResetForm(){
        error.textContent='';
        const resetUsername=el('input',{placeholder:'Username',id:'reset-username',maxlength:'24',required:true,autocomplete:'username'});
        const codeInput=el('input',{placeholder:'XXXX-XXXX',id:'reset-code',required:true,autocomplete:'off',style:'text-transform:uppercase'});
        const newPasswordField=passwordField(el,{id:'reset-new-password',placeholder:'New password',autocomplete:'new-password'});
        const confirmNewPasswordField=passwordField(el,{id:'reset-confirm-password',placeholder:'Confirm new password',autocomplete:'new-password'});
        const submit=el('button',{type:'submit',class:'enter-world'},'Reset password');
        const form=el('form',{class:'world-dialog auth-dialog',role:'dialog','aria-label':'Reset your password',onsubmit:async e=>{
          e.preventDefault();submit.disabled=true;error.textContent='';
          try{
            if(newPasswordField.input.value!==confirmNewPasswordField.input.value){
              error.textContent='Passwords do not match';submit.disabled=false;return;
            }
            const result=await accountsApi.resetPassword({
              username:resetUsername.value,recoveryCode:codeInput.value,
              newPassword:newPasswordField.input.value,confirmNewPassword:confirmNewPasswordField.input.value,
            });
            account={id:result.accountId,username:result.username};
            // Exactly the same takeover-style credential handoff a fresh
            // login already performs — this device is now logged in with
            // the new password, immediately usable.
            if(result.barPlayerId&&result.barSessionSecret){
              session={playerId:result.barPlayerId,sessionSecret:result.barSessionSecret};
              try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}
            }
            if(result.vegasRoom){
              saveSession(result.vegasRoom.code,{playerId:result.barPlayerId,sessionSecret:result.vegasRoom.sessionSecret});
            }
            const afterReset=async()=>{
              if(session){
                try{const resp=await post('/rejoin',session);applyIncoming(resp);activeSeat=resp.activeSeat??null;}catch{}
              }
              chooseCharacter();
            };
            // The just-used code's whole batch is replaced — shown once,
            // exactly like a fresh registration's own first batch.
            renderRecoveryCodes(result.newRecoveryCodes,afterReset);
          }catch(err){error.textContent=err.message||'Could not reset your password';submit.disabled=false;}
        }},[
          el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Reset your password'),
          el('p',{class:'dialog-subtitle'},'Enter your username and one of your unused recovery codes.'),
          el('label',{for:'reset-username'},'Username'),resetUsername,
          el('label',{for:'reset-code'},'Recovery code'),codeInput,
          el('label',{for:'reset-new-password'},'New password'),newPasswordField.wrapper,
          el('label',{for:'reset-confirm-password'},'Confirm new password'),confirmNewPasswordField.wrapper,
          error,submit,
          el('button',{type:'button',class:'hud-button',onclick:()=>{mode='login';renderForm();}},'Back'),
        ]);overlay.replaceChildren(form);resetUsername.focus();
      }
      if(mode==='menu')renderMenu();else if(mode==='reset')renderResetForm();else renderForm();
    }
    function chooseCharacter(){
      let color=mine?.color||'green',skin=mine?.skin||'warm';
      const preview=el('canvas',{width:'180',height:'180','aria-label':'Character preview'});
      function update(){const c=preview.getContext('2d');c.clearRect(0,0,180,180);c.imageSmoothingEnabled=false;sprite(c,90,148,colors[color],skins[skin],2.6);}
      const error=el('p',{class:'error',role:'alert'});
      const input=el('input',{placeholder:'Your nickname',id:'patron-nickname',maxlength:'20',required:true,autocomplete:'nickname',value:mine?.nickname||''});
      const makeChoices=(values,label,select)=>el('div',{class:'avatar-swatches','aria-label':label},Object.entries(values).map(([key,hex],i)=>el('button',{type:'button',class:'avatar-swatch','aria-label':`${label} ${key}`,'aria-pressed':(label==='Clothes'?key===color:key===skin)?'true':'false',style:`--swatch:${hex}`,onclick:e=>{select(key);for(const b of e.currentTarget.parentElement.children)b.setAttribute('aria-pressed','false');e.currentTarget.setAttribute('aria-pressed','true');update();}},'')));
      const enter=el('button',{type:'submit',class:'enter-world'},'Step inside  →');
      const form=el('form',{class:'world-dialog avatar-dialog',role:'dialog','aria-label':'Create your character',onsubmit:async e=>{
        e.preventDefault();enter.disabled=true;error.textContent='';
        try{const appearance={nickname:input.value.trim(),color,skin};let resp;if(session){resp=await post('/appearance',{...session,...appearance});applyIncoming(resp);session={...session,...appearance};}else{resp=await post('/join',appearance);session={...resp,...appearance};}activeSeat=resp.activeSeat??null;try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}overlay.replaceChildren();applyIncoming(await read('/state'));begin();}
        catch(err){error.textContent=err.message||'Could not enter';enter.disabled=false;}
      }},[
        el('p',{class:'eyebrow'},'Las Vegas · OPEN ALL EVENING'),el('h1',{},'Come as you are.'),el('p',{class:'dialog-subtitle'},'Make yourself a little character. Your friends are inside.'),
        el('div',{class:'avatar-editor'},[el('div',{class:'avatar-preview'},[preview,el('span',{},'YOUR LITTLE SELF')]),el('div',{class:'avatar-options'},[
          el('label',{for:'patron-nickname'},'What should we call you?'),input,
          el('span',{class:'option-label'},'Clothes'),makeChoices(colors,'Clothes',v=>color=v),
          el('span',{class:'option-label'},'Skin tone'),makeChoices(skins,'Skin',v=>skin=v),
          // Server-computed, read-only (CLAUDE.md's "Stamina" section) —
          // no input element at all, so there is no path through this
          // form's own submit handler (which only ever sends nickname/
          // color/skin) that could set it. Only shown for a returning
          // identity that already has a stamina value to report; a
          // brand-new join hasn't been created yet at the point this
          // dialog first renders, so there's nothing real to show.
          ...(typeof mine?.stamina==='number'?[
            el('span',{class:'option-label'},'Stamina'),
            el('div',{class:'stamina-panel'},[
              el('div',{class:'stamina-track stamina-track-large'},[el('span',{class:'stamina-fill',style:`width:${Math.max(0,Math.min(100,Math.round(mine.stamina)))}%`})]),
              el('span',{class:'stamina-panel-pct'},`${Math.round(mine.stamina)}%`),
              el('p',{class:'stamina-note'},'Eating a meal restores +70%, a drink +30% — both cap at 100%, with nothing stored for later.'),
            ]),
          ]:[]),
          // Account status + Log out/Switch account — the one combined
          // entry point this user's own design asked for ("Your character
          // 面板显示当前账号/游客状态，提供 Log out / Switch account"),
          // never a second place to look for this. A guest sees no
          // account section at all here beyond the existing footnote
          // below; only a logged-in browser sees this block.
          ...(account?[
            el('span',{class:'option-label'},'Account'),
            el('div',{class:'account-panel'},[
              el('p',{},[el('strong',{},account.username),' is logged in on this browser.']),
              el('div',{class:'account-panel-actions'},[
                el('button',{type:'button',class:'hud-button',onclick:async e=>{
                  e.preventDefault();
                  // Logging out leaves this browser with no character at
                  // all (session cleared above) — the same choice as a
                  // brand-new visitor gets, not a half-finished panel for
                  // an identity that no longer exists.
                  if(await doLogout())openAuthOverlay();
                }},'Log out'),
                el('button',{type:'button',class:'hud-button',onclick:async e=>{
                  e.preventDefault();
                  if(await doLogout())openAuthOverlay('login');
                }},'Switch account'),
                el('button',{type:'button',class:'hud-button',onclick:e=>{e.preventDefault();openRegenerateRecoveryCodes();}},'Get new recovery codes'),
              ]),
            ]),
          ]:[
            el('span',{class:'option-label'},'Account'),
            el('div',{class:'account-panel'},[
              el('p',{},"You're playing as a guest — this character only exists in this browser."),
              el('button',{type:'button',class:'hud-button',onclick:e=>{e.preventDefault();openAuthOverlay();}},'Log in or sign up'),
            ]),
          ]),
        ])]),error,enter,el('p',{class:'dialog-footnote'},account?'':'No account needed — or log in above to keep this character across devices.'),
      ]);overlay.replaceChildren(form);update();input.focus();
    }
    function begin(){
      enteredThisPage=true;
      if(timers.length||!active)return;
      if(mine){session={...session,nickname:mine.nickname,color:mine.color,skin:mine.skin};try{localStorage.setItem(sessionKey,JSON.stringify(session));}catch{}}
      post('/heartbeat',session).catch(()=>{});
      connectEvents();fetchAndApply();
      // 10s fallback poll — cheap insurance if the stream silently
      // stalls without EventSource noticing; gated through the same
      // seq check above, so it's a no-op whenever the stream is doing
      // its job.
      timers.push(setInterval(()=>post('/heartbeat',session).then(resp=>{
        activeSeat=resp.activeSeat??null;
        if(!activeSeat&&returnGameButton){returnGameButton.remove();returnGameButton=null;}
      }).catch(async e=>{
        // A 403 here is this identity's bar secret itself being revoked —
        // the heartbeat's own natural ~5s cadence is what makes this the
        // FASTEST place to notice an account takeover from elsewhere
        // (CLAUDE.md's "旧设备明确显示" requirement), faster than the
        // slower, dedicated 15s accountCheckTimer poll below, which
        // exists for the case where this tab isn't even logged in to an
        // account (so there'd be nothing for a rotated bar secret to
        // mean) or hasn't acted in a while. Every other transient
        // network error still silently retries next tick, unchanged.
        if(e.status===403&&active&&!loggedOutElsewhereShown){
          loggedOutElsewhereShown=true;
          session=null;try{localStorage.removeItem(sessionKey);}catch{}
          mine=null;staminaFill.style.width='0%';staminaLabel.textContent='—';
          activeSeat=null;if(returnGameButton){returnGameButton.remove();returnGameButton=null;}
          const wasLoggedIn=!!account;
          await refreshAccount();
          toast.textContent=wasLoggedIn
            ?'Your account was signed in on another device. Please log in again.'
            :'Your session could not be restored. Reload to rejoin.';
          openAuthOverlay(wasLoggedIn?'login':'menu');
        }
      }),5000),setInterval(fetchAndApply,10000));
      visibilityHandler=()=>{
        if(document.visibilityState!=='visible')return;
        // A backgrounded tab can have its EventSource suspended by the
        // browser; coming back is exactly when a stale view would
        // otherwise sit unnoticed.
        if(!eventSource||eventSource.readyState===EventSource.CLOSED)connectEvents();
        fetchAndApply();
      };
      document.addEventListener('visibilitychange',visibilityHandler);
      window.addEventListener('focus',visibilityHandler);
      // Driven by the server's own re-validated activeSeat, never a
      // locally-cached room code — a closed, left, or expired room, or a
      // different character's game entirely, is never offered here.
      if(activeSeat){returnGameButton=el('button',{class:'hud-button',onclick:async()=>{
        // Clicking this is exactly "I'm deliberately going back to my
        // table" — clears any pending away-from-table departure (see
        // src/tables.ts's resumeActiveTable: only an explicit action like
        // this one may do so, never a passive heartbeat).
        try{
          const response=await post('/resume',session);activeSeat=response.activeSeat??null;
          if(!activeSeat){returnGameButton?.remove();returnGameButton=null;toast.textContent='Your previous game has ended.';return;}
          navigate(`/?room=${activeSeat.roomCode}`);
        }catch(error){toast.textContent=error.message||'Could not return to the game';}
      }},'Return to your game');hud.querySelector('.hud-actions').appendChild(returnGameButton);}
      toast.textContent='Welcome in. WASD / arrows to walk · click a destination';canvas.focus();
    }
    const keyDown=e=>{if(['INPUT','TEXTAREA'].includes(e.target.tagName)||overlay.childElementCount||eatingUI)return;const key=e.key.toLowerCase();if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)){e.preventDefault();keys.add(key);path=[];pendingSitSeat=null;approachTarget=null;}if(e.key==='Escape'){path=[];destination=null;pendingSitSeat=null;approachTarget=null;}};
    const keyUp=e=>keys.delete(e.key.toLowerCase());const blur=()=>{keys.clear();heldDirection=null;path=[];pendingSitSeat=null;approachTarget=null;};
    window.addEventListener('keydown',keyDown);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);
    canvas.addEventListener('click',e=>{
      if(!mine||overlay.childElementCount||eatingUI)return;const rect=canvas.getBoundingClientRect(),x=Math.floor((e.clientX-rect.left+camera.x)/tile),y=Math.floor((e.clientY-rect.top+camera.y)/tile);
      // A player's own tile takes priority over whatever floor, seat, or
      // table is underneath them (product-direction-update, part 2) —
      // clicking yourself is a deliberate no-op. Checked first, before
      // any furniture/seat logic below.
      if(x===mine.x&&y===mine.y)return;
      const other=playerAt(x,y);
      if(other){approachPlayer(other);return;}
      const f=fixtures.find(f=>x>=f.x&&x<f.x+f.w&&y>=f.y&&y<f.y+f.h);
      // A walkable-zone fixture (blocksMovement:false — the restroom)
      // falls through to the normal walk/pathfinding below, same as any
      // other floor tile; only a genuinely non-walkable, interactive
      // fixture (a table, the counter) intercepts the click for its own
      // dialog/message instead.
      if(f&&f.blocksMovement!==false){
        if(f.kind==='game_table'){if(!f.available)toast.textContent=`${f.label}`;else if(f.tableMode==='npc')openNpcTableDialog(f);else openTableDialog(f);}
        else if(f.kind==='counter'){
          // The book itself is the one click target for the menu
          // (CLAUDE.md: "the book is the click target, not a separate
          // floating button") — clicking the rest of the counter's long
          // surface is just a gentle pointer toward it, never a second
          // way to open the menu.
          toast.textContent='The book on the counter opens the menu.';
        }
        else if(f.kind==='stool'||f.kind==='dining_table'){
          // Phase 2: a real seat — pick the nearest free one belonging to
          // this fixture (its own x/y distance to where this patron is
          // standing right now, not path length, which is a reasonable,
          // cheap approximation for "nearest" on this small a grid).
          const seats=(layout.seats||[]).filter(s=>s.furnitureId===f.id);
          const free=seats.filter(s=>!state.players.some(p=>p.seatId===s.id));
          if(!free.length){toast.textContent='No free seat there.';return;}
          free.sort((a,b)=>(Math.abs(a.x-mine.x)+Math.abs(a.y-mine.y))-(Math.abs(b.x-mine.x)+Math.abs(b.y-mine.y)));
          beginSit(free[0]);
        }
        return;
      }
      // A bare seat tile, clicked directly rather than via its furniture —
      // still sittable (the same tile beginSit would compute), as long as
      // it's actually free.
      const seat=(layout.seats||[]).find(s=>s.x===x&&s.y===y);
      if(seat){
        if(state.players.some(p=>p.seatId===seat.id&&p.id!==mine.id)){toast.textContent='Someone is already sitting there.';return;}
        beginSit(seat);
        return;
      }
      pendingSitSeat=null;approachTarget=null;path=findPath(x,y);destination=path.length?{x,y}:null;
    });
    async function step(x,y){
      moving=true;movementEpoch++;pendingMoveTarget={x,y};
      try{
        const next=await post('/move',{playerId:session.playerId,sessionSecret:session.sessionSecret,x,y});
        pendingMoveTarget=null;if(active)applyIncoming(next);
        // Arrived at the tile a click-to-sit gesture was walking toward —
        // finish it with the real, separately-validated sit call (beginSit).
        if(pendingSitSeat&&manhattan(pendingSitSeat.x,pendingSitSeat.y,x,y)===1){
          path=[];destination=null;
          const seat=pendingSitSeat;pendingSitSeat=null;
          try{applyIncoming(await post(`/seats/${seat.id}/sit`,session));toast.textContent='Seated — use Stand up to leave the chair.';}
          catch(err){toast.textContent=err.message||'Could not sit down';}
        }
        // Arrived at the approach tile a "walk up to this player" gesture
        // was heading toward — nothing further happens on arrival (no
        // chat to open; that side effect was removed along with the
        // private chat dialog), just clear the in-flight marker.
        if(approachTarget&&approachTarget.approach.x===x&&approachTarget.approach.y===y){
          approachTarget=null;
        }
      }
      catch(e){pendingMoveTarget=null;path=[];destination=null;pendingSitSeat=null;approachTarget=null;toast.textContent=e.status===403?'Your session could not be restored. Reload to rejoin.':'Could not move — try again.';await fetchAndApply();}
      finally{moving=false;}
    }
    // A static world layer is painted once, not rebuilt on every animation frame.
    const floor=document.createElement('canvas');floor.width=worldW;floor.height=worldH;const fc=floor.getContext('2d');
    const box=(c,x,y,w,h,color)=>{c.fillStyle=color;c.fillRect(x,y,w,h);};
    box(fc,0,0,worldW,worldH,'#533c34');
    for(let y=0;y<layout.gridRows;y++)for(let x=0;x<layout.gridCols;x++){
      const px=x*tile,py=y*tile;box(fc,px,py,tile,tile,['#76513e','#7d5742','#825b45'][(x*7+y*3)%3]);
      box(fc,px,py,tile,2,'#482f28');box(fc,px+2,py+31,tile-4,1,'#956c4e');
      box(fc,px+((y%2)*21),py,2,tile,'#573c30');
      box(fc,px+12,py+13,23,1,'#ffffff09');box(fc,px+31,py+47,20,1,'#38281b20');
    }
    // Brick back wall, beams, and a back-bar liquor cabinet.
    box(fc,0,0,worldW,128,'#473943');
    for(let y=0;y<4;y++)for(let x=0;x<40;x++){box(fc,x*64+(y%2)*32,y*24,60,21,['#67504a','#5e4848','#71564a'][(x+y)%3]);}
    box(fc,0,96,worldW,32,'#332a31');box(fc,0,98,worldW,5,'#a07a4d');
    // Behind the serving counter is a back-bar cabinet/kitchen, not a
    // window to the outside — a window there made no architectural sense
    // (the counter already fills this wall). Dark wood frame around two
    // interior shelves lined with bottles, matching the counter's own
    // bottle silhouettes just below it.
    const cabinetBottle=(c,x,bottomY,i)=>{
      const body=['#729f80','#9c6848','#b78a59','#5e7d9e','#8a594c'][i%5];
      box(c,x,bottomY-16,9,16,body);box(c,x+2,bottomY-22,5,7,'#d8b873');box(c,x+1,bottomY-24,7,3,'#3b2f29');
    };
    for(const x of [256,768,1536,2112]){
      box(fc,x,24,130,74,'#6b4635');box(fc,x+6,30,118,62,'#2e211d');
      box(fc,x+6,50,118,3,'#8a5f3f');box(fc,x+6,72,118,3,'#8a5f3f');
      let i=0;
      for(const bottomY of [50,72,92])for(let bx=x+14;bx<x+118;bx+=20)cabinetBottle(fc,bx,bottomY,i++);
    }
    // One window in each gap between the far-back cabinet units.
    for(const x of [256,768,1536].map((x,i)=>(x+130+[768,1536,2112][i])/2-42)){
      box(fc,x,18,84,78,'#302c32');box(fc,x+5,23,74,68,'#b98b60');
      box(fc,x+10,28,64,58,'#405d70');box(fc,x+14,32,24,50,'#7393a0');
      box(fc,x+40,28,4,58,'#bc9165');box(fc,x+10,54,64,4,'#bc9165');
      box(fc,x-5,91,94,7,'#d0a171');
    }
    const rug=(x,y,w,h)=>{box(fc,x,y,w,h,'#8d4545');box(fc,x+6,y+6,w-12,h-12,'#ad7054');box(fc,x+12,y+12,w-24,h-24,'#864347');for(let a=x+24;a<x+w-12;a+=24)box(fc,a,y+20,8,8,'#c39968');};
    // One dining-room rug, sized and centred from the four dining tables'
    // own real bounding box (tables + their seats) rather than hand-typed
    // literals — the two rugs this replaces were positioned by guesswork
    // (one sat stranded between the game-table rows, the other only
    // partly under one dining table) and the student's own screenshot
    // flagged the stray one directly. A fixed margin on every side keeps
    // it clear of the tables' own seat-approach tiles. Drawn in this
    // static floor layer, under every fixture, so it never affects
    // movement (a rug has never been checked by isWalkable).
    {
      const diningFixtures=fixtures.filter(f=>f.kind==='dining_table');
      const diningSeats=(layout.seats||[]).filter(s=>diningFixtures.some(f=>f.id===s.furnitureId));
      const minX=Math.min(...diningFixtures.map(f=>f.x),...diningSeats.map(s=>s.x));
      const maxX=Math.max(...diningFixtures.map(f=>f.x+f.w),...diningSeats.map(s=>s.x+1));
      const minY=Math.min(...diningFixtures.map(f=>f.y),...diningSeats.map(s=>s.y));
      const maxY=Math.max(...diningFixtures.map(f=>f.y+f.h),...diningSeats.map(s=>s.y+1));
      const margin=0.6*tile;
      rug(minX*tile-margin,minY*tile-margin,(maxX-minX)*tile+margin*2,(maxY-minY)*tile+margin*2);
    }
    function plant(x,y){box(fc,x-13,y-19,26,22,'#b67b58');box(fc,x-15,y-23,30,8,'#d29a6e');for(const [dx,dy] of [[-12,-42],[2,-49],[-4,-61],[14,-38]]){box(fc,x+dx-7,y+dy,14,25,'#527c5a');box(fc,x+dx-3,y+dy,4,19,'#7ca472');}}
    // A closed book lying flat on the counter — the menu's own in-scene
    // entry point (CLAUDE.md: a recognisable book on the counter, not a
    // floating HUD button). Drawn here, in the static floor layer
    // (baked once, same as the counter itself), with warm-brown leather
    // covers and visible cream page edges so it reads clearly against
    // the counter's own wood tones without needing a label to explain
    // itself. (x,y) is the book's own centre; the interactive hotspot
    // that makes it clickable is a separate DOM button positioned over
    // this same art every frame, exactly like every seat-target button
    // in this file already is — never re-registered on the canvas's own
    // click handler, which only resolves grid tiles, not book-shaped art.
    function drawMenuBookArt(c,x,y){
      // An open book lying flat, viewed top-down: two cream pages split by
      // a dark gutter, a thin leather cover border, faint text-line rules,
      // and a hanging ribbon bookmark for a colour accent that reads at a
      // glance — the earlier closed-book-on-an-easel silhouette tested as
      // a picture frame, not a book, once zoomed (caught by direct
      // screenshot review, not just "the art exists").
      const w=40,h=30;
      c.save();c.translate(Math.round(x),Math.round(y));
      c.fillStyle='#00000035';c.beginPath();c.ellipse(1,h/2+2,w/2+3,6,0,0,Math.PI*2);c.fill();
      // Leather cover border, visible all around the pages.
      box(c,-w/2,-h/2,w,h,'#5a3824');
      // Two open pages, cream, inset from the cover with a dark centre gutter.
      const pagePad=3,gutter=2.5;
      const pageW=(w-pagePad*2-gutter)/2;
      box(c,-w/2+pagePad,-h/2+pagePad,pageW,h-pagePad*2,'#f6ecd4');
      box(c,gutter/2,-h/2+pagePad,pageW,h-pagePad*2,'#f6ecd4');
      box(c,-gutter/2,-h/2+pagePad,gutter,h-pagePad*2,'#8a6a4a');
      // Faint text-line rules on each page.
      c.fillStyle='#cbb98f';
      for(let i=0;i<4;i++){
        const ly=-h/2+pagePad+6+i*5;
        box(c,-w/2+pagePad+3,ly,pageW-6,1.4,'#cbb98f');
        box(c,gutter/2+3,ly,pageW-6,1.4,'#cbb98f');
      }
      // A small warm-gold ribbon bookmark hanging over the top edge — the
      // one spot of saturated colour that makes the shape pop against the
      // counter's own browns at a glance, on the page side (not the
      // gutter) so it doesn't read as a spine decoration instead.
      box(c,pageW*0.35,-h/2-3,4,h*0.55,'#c23b3b');
      box(c,pageW*0.35,h*0.05,4,5,'#8a2525');
      c.restore();
    }
    const bookHotspotHalfW=26,bookHotspotHalfH=20;
    // The original room is dressed as a room, rather than bare shapes on
    // endless floor. Empty surrounding world space can host later extensions.
    const wallX=8*tile,wallY=5*tile,wallW=24*tile;
    box(fc,wallX,wallY,wallW,88,'#4b363d');
    for(let row=0;row<3;row++)for(let col=0;col<24;col++)box(fc,wallX+col*tile+(row%2)*24,wallY+row*24,60,20,['#705147','#634844','#78584a'][(row+col)%3]);
    box(fc,wallX,wallY+72,wallW,16,'#322b32');box(fc,wallX,wallY+73,wallW,4,'#ba8a57');
    // This inner wall strip sits directly above the serving counter —
    // originally four more windows, which made no architectural sense
    // right behind a bar counter (the student's own screenshot flagged
    // this). Replaced with small hanging shelf/cabinet units, matching
    // the back-bar cabinet motif used on the outer brick wall above.
    for(const wx of [11,17,24,29]){
      box(fc,wx*tile,wallY+10,90,53,'#6b4635');box(fc,wx*tile+6,wallY+16,78,40,'#2e211d');
      box(fc,wx*tile+6,wallY+30,78,3,'#8a5f3f');
      for(let i=0,bx=wx*tile+14;bx<wx*tile+84;bx+=20,i++){
        const body=['#729f80','#9c6848','#b78a59','#5e7d9e'][i%4];
        box(fc,bx,wallY+40,8,13,body);box(fc,bx+1,wallY+34,5,6,'#d8b873');
      }
    }
    // Corner plants are pure decoration, far from any furniture — left as
    // hand-placed art, never implicated in the chair-overlap bug. The
    // four plants near the game-table rows are now real FURNITURE
    // fixtures (src/barLayout.ts's "plant" kind) drawn from the fixtures
    // loop below instead of hand-typed pixel literals here, so their
    // drawn position always matches their actual shared collision tile.
    for(const [x,y] of [[100,170],[worldW-100,170],[120,worldH-110],[worldW-120,worldH-110]])plant(x,y);
    for(const f of fixtures){const x=f.x*tile,y=f.y*tile,w=f.w*tile,h=f.h*tile;
      if(f.kind==='cabinet_wall'){
        // Painted above; this shared fixture supplies its collision footprint.
      }else if(f.kind==='plant'){
        plant(x+tile/2,y+tile*0.82);
      }else if(f.kind==='counter'){
        box(fc,x-3,y+9,w+6,h,'#37282b');box(fc,x,y+5,w,h-10,'#b58153');box(fc,x,y+13,w,5,'#dfb979');box(fc,x,y+h-8,w,8,'#6b4635');
        for(let i=12;i<w;i+=64){box(fc,x+i,y+29,46,25,'#815636');box(fc,x+i+2,y+30,42,2,'#cf9c5e');}
        for(let i=32;i<w;i+=80){box(fc,x+i,y-24,9,22,'#729f80');box(fc,x+i+2,y-29,5,6,'#d8b873');box(fc,x+i+14,y-15,7,13,'#ddc6a0');}
        fc.font='bold 17px monospace';fc.textAlign='center';fc.fillStyle='#e4bf7e';fc.fillText('Las Vegas',x+w/2,y-43);
        drawMenuBookArt(fc,bookWorldX,bookWorldY);
      }else if(f.kind==='stool'){
        // Drawn below from the same seat tile the player can click.
      }else if(f.kind==='restroom'){
        // A walkable alcove, not an obstacle — a floor-level marker only
        // (no raised/blocking shape like a table): a faint floor patch,
        // a door frame on the south edge patrons actually approach from,
        // and a hanging sign. Same box()-primitive pixel style as every
        // other fixture here, nothing imported (CLAUDE.md).
        box(fc,x-4,y-4,w+8,h+8,'#352b2d2e');
        const doorX=x+w/2-14;
        box(fc,doorX,y+h-6,28,10,'#43302d');box(fc,doorX+4,y+h-4,20,6,'#1c1620');
        box(fc,x+w/2-34,y-18,68,16,'#37282b');box(fc,x+w/2-30,y-15,60,10,'#e4bf7e');
        fc.font='bold 10px monospace';fc.textAlign='center';fc.fillStyle='#352b2d';fc.fillText('RESTROOM',x+w/2,y-7);
      }else if(f.kind==='game_table'&&f.gameType==='vegas'){
        const cx=x+w/2,cy=y+h/2,r=w/2;
        fc.beginPath();fc.ellipse(cx,cy+10,r+5,r*.86,0,0,Math.PI*2);fc.fillStyle='#392822';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r,0,Math.PI*2);fc.fillStyle='#b78a59';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r-9,0,Math.PI*2);fc.fillStyle='#396c58';fc.fill();
        fc.beginPath();fc.arc(cx,cy,r-14,0,Math.PI*2);fc.strokeStyle='#bcad7770';fc.lineWidth=2;fc.stroke();
        fc.fillStyle='#eadcc5';for(let i=0;i<3;i++){box(fc,cx-28+i*21,cy-21,15,21,'#eadcc5');box(fc,cx-23+i*21,cy-14,5,5,'#8a594c');}
        fc.font='bold 10px monospace';fc.textAlign='center';fc.fillStyle='#f7e6c6';fc.fillText(f.label,cx,cy+28);
      }else if(f.kind==='game_table'&&f.gameType==='dominoes'){
        box(fc,x-5,y+12,w+10,h,'#382a2d');box(fc,x-6,y,w+12,h,'#b78a59');box(fc,x,y+6,w,h-12,'#356451');
        box(fc,x+8,y+h/2-1,w-16,2,'#d3b783');
        for(let pair=0;pair<2;pair++){
          const py=y+pair*h/2;
          for(let i=0;i<2;i++){box(fc,x+w/2-24+i*25,py+12,20,28,'#eee3c6');box(fc,x+w/2-22+i*25,py+25,16,1,'#8e7858');box(fc,x+w/2-16+i*25,py+17,4,4,'#43392c');box(fc,x+w/2-16+i*25,py+30,4,4,'#43392c');}
          fc.textAlign='center';fc.font='bold 9px monospace';fc.fillStyle='#f7e6c6';fc.fillText(`PAIR ${pair+1} · ALL FIVES`,x+w/2,py+53);
        }
      }else{
        box(fc,x-5,y+12,w+10,h,'#382a2d');box(fc,x-6,y,w+12,h,'#b78a59');box(fc,x,y+6,w,h-12,f.kind==='game_table'?(f.available?'#487c69':'#665969'):'#9c6848');
        box(fc,x+6,y+12,w-12,3,'#ffffff19');
        if(f.kind==='game_table'){
          for(let i=0;i<3;i++){box(fc,x+30+i*23,y+33,17,26,'#eadcc5');box(fc,x+34+i*23,y+41,7,7,i%2?'#c87769':'#4d515d');}
          fc.textAlign='center';fc.font='bold 12px monospace';fc.fillStyle='#f7e6c6';fc.fillText(f.gameType==='texas'?(f.tableMode==='npc'?'Hold’em Offline':'Hold’em Online'):f.available?f.label:f.gameType.toUpperCase(),x+w/2,y+h-26);
          if(!f.available){fc.fillStyle='#d0c0b1';fc.font='10px monospace';fc.fillText('COMING LATER',x+w/2,y+h-12);}
        }else{box(fc,x+43,y+35,28,24,'#eee0bd');box(fc,x+51,y+40,12,12,'#bd8253');box(fc,x+77,y+29,11,18,'#94b0a5');}
      }
    }
    function chair(c,x,y,accent){
      box(c,x+13,y+44,7,13,'#352b2d');box(c,x+44,y+44,7,13,'#352b2d');
      box(c,x+10,y+12,44,16,'#6a4938');box(c,x+13,y+14,38,8,'#d0a171');
      box(c,x+9,y+28,46,20,'#684638');box(c,x+12,y+29,40,14,accent||'#b78163');
      box(c,x+14,y+29,36,3,'#e1b985');
    }
    for(const s of layout.seats||[])chair(fc,s.x*tile,s.y*tile);
    for(const s of layout.gameChairs||[])chair(fc,((s.displayX??s.x+.5)-.5)*tile,((s.displayY??s.y+.5)-.5)*tile,colors[s.color]);
    // ---- Public speech bubbles (product-direction-update, part 3's
    // replacement for private chat) ----
    //
    // Canvas text has no built-in word-wrap, and this has to handle both
    // space-delimited English (wrap on word boundaries) and CJK/emoji/
    // long no-space tokens (wrap mid-word, by actual measured width, once
    // a single "word" alone already exceeds the max width) — a plain
    // split(' ') alone only handles the first case. Iterating a string
    // with for...of (not index/split('')) walks by Unicode code point,
    // so a surrogate-pair emoji is never cut in half mid-character.
    function wrapBubbleText(text,maxWidth){
      const lines=[];
      for(const para of text.split('\n')){
        if(para===''){lines.push('');continue;}
        let line='';
        for(const word of para.split(/(\s+)/)){
          if(word==='')continue;
          const candidate=line+word;
          if(ctx.measureText(candidate).width<=maxWidth||line===''){
            if(ctx.measureText(word).width>maxWidth){
              // The word itself is wider than the whole bubble (a long
              // CJK run, a long no-space token) — flush what's queued,
              // then break this one by character instead of by word.
              if(line){lines.push(line.trimEnd());line='';}
              let chunk='';
              for(const ch of word){
                if(chunk&&ctx.measureText(chunk+ch).width>maxWidth){lines.push(chunk);chunk=ch;}
                else chunk+=ch;
              }
              line=chunk;
            }else{
              line=candidate;
            }
          }else{
            lines.push(line.trimEnd());line=word;
          }
        }
        if(line)lines.push(line.trimEnd());
      }
      return lines;
    }
    function roundedRect(x,y,w,h,r){
      ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
    }
    const BUBBLE_MAX_WIDTH=240, BUBBLE_PAD=10, BUBBLE_LINE_H=16;
    // Drawn directly on the canvas, not a DOM element — it can never
    // intercept a click on the floor/a character/a chair underneath it,
    // since every click is resolved from grid coordinates alone,
    // independent of anything drawn (product-direction-update, part 3).
    // `anchorX,anchorBottomY` is the screen point the bubble's tail
    // points at (just above a nickname tag); clamped to stay on screen
    // (minus a small margin) so it's never cut off at an edge, with the
    // tail itself re-clamped to stay within the (possibly shifted) box.
    function drawSpeechBubble(anchorX,anchorBottomY,text){
      ctx.font='12px "Segoe UI Emoji",monospace';ctx.textAlign='left';
      const lines=wrapBubbleText(text,BUBBLE_MAX_WIDTH-BUBBLE_PAD*2);
      const contentWidth=Math.max(20,...lines.map(l=>ctx.measureText(l).width));
      const boxW=Math.min(BUBBLE_MAX_WIDTH,contentWidth+BUBBLE_PAD*2);
      const boxH=lines.length*BUBBLE_LINE_H+BUBBLE_PAD*2;
      const margin=8;
      const boxX=Math.max(margin,Math.min(vw-boxW-margin,anchorX-boxW/2));
      const boxY=Math.max(margin,anchorBottomY-boxH-9);
      ctx.fillStyle='rgba(32,30,38,0.82)';
      roundedRect(boxX,boxY,boxW,boxH,10);ctx.fill();
      const tailX=Math.max(boxX+12,Math.min(boxX+boxW-12,anchorX));
      ctx.beginPath();ctx.moveTo(tailX-7,boxY+boxH);ctx.lineTo(tailX+7,boxY+boxH);ctx.lineTo(tailX,boxY+boxH+8);ctx.closePath();ctx.fill();
      ctx.fillStyle='#ffffff';
      lines.forEach((line,i)=>ctx.fillText(line,boxX+BUBBLE_PAD,boxY+BUBBLE_PAD+(i+0.8)*BUBBLE_LINE_H));
      ctx.textAlign='center';
    }
    function animate(now){
      if(!active)return;frame=requestAnimationFrame(animate);
      if(session&&mine&&!moving&&now-lastTime>145&&!overlay.childElementCount&&!eatingUI){
        let dx=0,dy=0;if(keys.has('w')||keys.has('arrowup'))dy=-1;else if(keys.has('s')||keys.has('arrowdown'))dy=1;
        if(keys.has('a')||keys.has('arrowleft'))dx=-1;else if(keys.has('d')||keys.has('arrowright'))dx=1;
        if(heldDirection){dx=heldDirection.dx;dy=heldDirection.dy;}
        if(dx||dy){path=[];pendingSitSeat=null;approachTarget=null;if(canStep(mine.x+dx,mine.y+dy)){lastTime=now;step(mine.x+dx,mine.y+dy);}}
        else if(path.length){
          // A seat this patron is walking toward can be taken by someone
          // else mid-journey — stop the attempt and say so rather than
          // walking the rest of the way for nothing (the server would
          // refuse the final sit anyway, but catching it here is a
          // clearer, earlier signal than an error only at arrival).
          if(pendingSitSeat&&state.players.some(p=>p.seatId===pendingSitSeat.id&&p.id!==mine.id)){
            path=[];destination=null;pendingSitSeat=null;toast.textContent='Someone sat down there first.';
          }else if(approachTarget){
            // The person being approached can walk, log off, or (rarely)
            // have their old approach tile taken by someone else while
            // this patron is still en route — re-pathed a bounded number
            // of times (never an infinite chase), and abandoned outright
            // if they're simply gone.
            const target=state.players.find(p=>p.id===approachTarget.playerId);
            if(!target){
              path=[];destination=null;approachTarget=null;toast.textContent='They left the bar.';
            }else if(target.x!==approachTarget.targetX||target.y!==approachTarget.targetY){
              if(approachTarget.attempts>=3){
                path=[];destination=null;approachTarget=null;toast.textContent="They're moving around too much — try again.";
              }else{
                approachTarget.attempts++;approachTarget.targetX=target.x;approachTarget.targetY=target.y;
                const approach=findApproachTile(target.x,target.y);
                if(!approach){path=[];destination=null;approachTarget=null;toast.textContent="Can't reach them right now.";}
                else{
                  approachTarget.approach=approach;path=findPath(approach.x,approach.y);destination=path.length?approach:null;
                  if(!path.length){approachTarget=null;toast.textContent="Can't reach them right now.";}
                  else{lastTime=now;const [x,y]=path.shift();step(x,y);}
                }
              }
            }else{
              lastTime=now;const [x,y]=path.shift();step(x,y);
            }
          }else{
            lastTime=now;const [x,y]=path.shift();step(x,y);
          }
        }
        else destination=null;
      }
      const target=mine||{x:20,y:12};const desiredX=Math.max(0,Math.min(Math.max(0,worldW-vw),(target.x+.5)*tile-vw/2)),desiredY=Math.max(0,Math.min(Math.max(0,worldH-vh),(target.y+.5)*tile-vh/2));
      if(!cameraInitialized){camera={x:desiredX,y:desiredY};cameraInitialized=true;}else{camera.x+=(desiredX-camera.x)*.12;camera.y+=(desiredY-camera.y)*.12;}
      ctx.clearRect(0,0,vw,vh);ctx.imageSmoothingEnabled=false;ctx.drawImage(floor,-Math.round(camera.x),-Math.round(camera.y));
      drawClock(new Date());
      for(const s of seatTargets){
        const x=((s.displayX??s.x+.5)-.5)*tile-camera.x,y=((s.displayY??s.y+.5)-.5)*tile-camera.y;
        s.button.style.display=mine&&x+tile>0&&y+tile>0&&x<vw&&y<vh?'block':'none';
        s.button.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;
      }
      if(counterFixture){
        const bx=bookWorldX-bookHotspotHalfW-camera.x, by=bookWorldY-bookHotspotHalfH-camera.y;
        menuBookButton.style.width=`${bookHotspotHalfW*2}px`;menuBookButton.style.height=`${bookHotspotHalfH*2}px`;
        menuBookButton.style.display=mine&&bx+bookHotspotHalfW*2>0&&by+bookHotspotHalfH*2>0&&bx<vw&&by<vh?'block':'none';
        menuBookButton.style.transform=`translate(${Math.round(bx)}px,${Math.round(by)}px)`;
      }
      // My own overhead holding/eat/drink prompt (CLAUDE.md's seated-
      // eating section) — positioned every frame above my own head,
      // exactly where the nickname tag itself will be drawn a little
      // further below, so the two never overlap (the prompt sits above
      // the tag, not beside it). Hidden entirely once eatingUI is set
      // (the cutscene has taken over) or once there's nothing held.
      if(mine&&!eatingUI){
        const myPrompt=holdingLabelFor(mine);
        if(myPrompt){
          const myPos=displayPositions.get(mine.id)||{x:mine.x,y:mine.y};
          const px=(myPos.x+.5)*tile-camera.x, py=(mine.seatId?(myPos.y+.75)*tile-7:(myPos.y+.75)*tile)-camera.y-92;
          eatPromptBtn.textContent=myPrompt.label;
          eatPromptBtn.disabled=!myPrompt.actionable;
          eatPromptBtn.classList.toggle('eat-prompt-passive',!myPrompt.actionable);
          eatPromptBtn.style.display='block';
          // The button's own width is auto/text-sized (CSS), so centering
          // it under px is a CSS transform (translateX(-50%)) rather than
          // a JS-measured half-width — correct regardless of how long
          // "Eat & Drink" ends up being in any given font/zoom.
          eatPromptBtn.style.transform=`translate(${Math.round(px)}px,${Math.round(py)}px) translateX(-50%)`;
        }else{
          eatPromptBtn.style.display='none';
        }
      }else{
        eatPromptBtn.style.display='none';
      }
      const seatedPatrons=new Set();
      for(const s of layout.gameChairs||[]){
        const t=state.tables.find(t=>t.id===s.tableId);
        const occupant=t?.seats?.find(p=>p?.color===s.color);
        if(!occupant)continue;
        const x=(s.displayX??s.x+.5)*tile-camera.x,y=((s.displayY??s.y+.5)+.15)*tile-camera.y;
        if(occupant.present){
          sprite(ctx,x,y,colors[occupant.color],skins[occupant.skin]||skins.warm,1,0,true);
          if(occupant.barPlayerId)seatedPatrons.add(occupant.barPlayerId);
        }
        ctx.font='10px monospace';ctx.textAlign='center';ctx.fillStyle='#f5e7d2';
        ctx.fillText(occupant.nickname+(occupant.controller==='npc'?' · NPC':occupant.present?'':' · away'),x,y-52);
        // A game-seated patron's speech still appears at their real,
        // actual on-screen position (part 2's "real chair position" rule,
        // carried over for part 3's own bubble) — cross-referenced from
        // the bar's own player list, since table seat data has no speech
        // field of its own.
        if(occupant.barPlayerId){
          const barP=state.players.find(bp=>bp.id===occupant.barPlayerId);
          if(barP?.speech)drawSpeechBubble(x,y-60,barP.speech);
        }
      }
      if(destination){ctx.strokeStyle='#ecd29b';ctx.lineWidth=2;ctx.strokeRect(destination.x*tile-camera.x+8,destination.y*tile-camera.y+8,tile-16,tile-16);}
      for(const p of [...state.players].sort((a,b)=>a.y-b.y)){
        if(seatedPatrons.has(p.id))continue;
        let pos=displayPositions.get(p.id);if(!pos){pos={x:p.x,y:p.y};displayPositions.set(p.id,pos);}
        const walking=!p.seatId&&Math.abs(pos.x-p.x)+Math.abs(pos.y-p.y)>.02;pos.x+=(p.x-pos.x)*.22;pos.y+=(p.y-pos.y)*.22;
        const x=(pos.x+.5)*tile-camera.x,y=(pos.y+.75)*tile-camera.y;
        // A seated patron (p.seatId set) gets the same sprite at rest —
        // no walk animation, and a touch smaller/lower to read as sitting
        // at the chair rather than standing over it. Still the one
        // sprite() primitive, not a distinct seated illustration.
        sprite(ctx,x,p.seatId?y-7:y,colors[p.color]||colors.green,skins[p.skin]||skins.warm,p.seatId?1.0:1.15,walking?now/90:0,!!p.seatId);
        ctx.font='12px monospace';ctx.textAlign='center';const label=p.nickname+(p.id===mine?.id?' · you':'');const width=ctx.measureText(label).width+14;
        box(ctx,x-width/2,y-72,width,20,'#292635dc');ctx.fillStyle='#f5e7d2';ctx.fillText(label,x,y-58);
        // A bystander's own holding/eating status (CLAUDE.md: visible to
        // others, never clickable for anyone but the actor themselves,
        // and never the specific dish) — drawn as a plain canvas tag
        // just above the nickname, never for `mine` here (the clickable
        // DOM prompt positioned earlier in this same frame already
        // covers that case, and would otherwise double-render this
        // text). Skipped for a frame where this patron also has an
        // active speech bubble — that already occupies the same spot
        // just above the nickname tag, and a speech bubble (max 8s) is
        // the more time-sensitive of the two to show without crowding.
        if(p.id!==mine?.id&&!p.speech){
          const tag=p.eating?(p.eating.kinds.length>1?'Eating & drinking':p.eating.kinds[0]==='meal'?'Eating':'Drinking')
            :(p.holding?.meal||p.holding?.drink)?'Holding':null;
          if(tag){
            const tw=ctx.measureText(tag).width+12;
            box(ctx,x-tw/2,y-95,tw,17,'#3f4a3399');ctx.fillStyle='#e9f0d8';ctx.font='10px monospace';ctx.fillText(tag,x,y-83);ctx.font='12px monospace';
          }
        }
        // Follows the same interpolated, camera-adjusted (x,y) the
        // nickname tag and sprite themselves use — walking, sitting at a
        // dining/stool chair, and the camera panning all move the bubble
        // with them for free, no separate position tracking needed.
        if(p.speech)drawSpeechBubble(x,y-80,p.speech);
      }
      if(!session){sprite(ctx,vw/2,vh/2+60,colors.green,skins.warm,1.2);}
      const shade=ctx.createRadialGradient(vw/2,vh/2,100,vw/2,vh/2,Math.max(vw,vh)*.7);shade.addColorStop(0,'#100d1800');shade.addColorStop(1,'#100d1870');ctx.fillStyle=shade;ctx.fillRect(0,0,vw,vh);
      // The seated eating/drinking cutscene (CLAUDE.md's seated-eating
      // section) — drawn on its own full-screen layer above the whole
      // map whenever eatingUI is set, timed purely from the server's own
      // startedAt/endsAt (never a locally-invented duration), so a
      // refresh mid-animation resumes at the right point rather than
      // restarting. Cleared back to transparent the instant eatingUI
      // goes null (reconcile() above, driven by the server's own lazy
      // expiry) — nothing here ever decides on its own that the action
      // is "done"; the server's state is what ends it.
      if(mine&&eatingUI){
        const startMs=new Date(eatingUI.startedAt).getTime(), endMs=new Date(eatingUI.endsAt).getTime();
        // serverNow(), not a bare Date.now() — see noteServerTime's own
        // comment above for the real bug this closes (a fast/slow browser
        // clock made the cutscene vanish before, or linger after, the
        // server's own real window).
        if(serverNow()>=endMs){
          // The local (clock-skew-corrected) estimate has reached the
          // server's own endsAt. Never decide on our own that the action
          // is actually over — only the server's next reported `eating`
          // (null once its lazy expiry check sees it) does that, via
          // reconcile() above — but don't keep drawing a cutscene for a
          // window that's visibly finished either, and don't just sit
          // waiting for an opportunistic SSE push or a seq-gated poll that
          // might not carry a bumped seq for this specific transition (the
          // lock's own expiry writes nothing to the DB, so nothing bumps
          // bar_seq on its own until the presence ticker's signature-diff
          // happens to notice it). One extra direct fetchAndApply() per
          // action, deduped by endsAt so a slow network/frame-rate can't
          // fire it twice, forces exactly the same authoritative re-check
          // a refresh would already trigger — gameplay gating is still
          // entirely the server's call via `mine.eating`/isEating, never
          // this timer; a real clock-skew test confirmed a direct move
          // attempt during this exact window is still correctly refused
          // server-side even though the local canvas already hid.
          eatCanvas.style.display='none';
          if(eatingExpiryFetchedFor!==eatingUI.endsAt){
            eatingExpiryFetchedFor=eatingUI.endsAt;
            fetchAndApply();
          }
        }else{
          eatCanvas.style.display='block';
          const progress=(serverNow()-startMs)/(endMs-startMs);
          const phase=eatingPhaseAt(eatingUI.kinds,progress);
          drawEatingScene(eatCtx,vw,vh,{color:colors[mine.color]||colors.green,skin:skins[mine.skin]||skins.warm,phase,seatKind:eatingUI.seatKind,reduceMotion:eatReduceMotion.matches});
        }
      }else{
        eatCanvas.style.display='none';
      }
    }
    frame=requestAnimationFrame(animate);
    dispose=()=>{active=false;cancelAnimationFrame(frame);timers.forEach(clearInterval);holdCleanups.forEach(cleanup=>cleanup());if(accountCheckTimer)clearInterval(accountCheckTimer);window.removeEventListener('resize',resize);window.removeEventListener('keydown',keyDown);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);document.body.classList.remove('world-mode');};
    // A short, dedicated poll for "did my account session get revoked
    // elsewhere" (the multi-device takeover's own "旧设备明确显示" —
    // CLAUDE.md) — independent of whatever bar action this tab happens
    // to be doing right now, since a device can sit idle in the bar for
    // a long time with nothing else triggering a 403 to notice it by.
    const ACCOUNT_POLL_MS=15000;
    accountCheckTimer=setInterval(async()=>{
      if(!active||!account||loggedOutElsewhereShown)return;
      const was=account.id;
      await refreshAccount();
      if(active&&!account&&was&&!loggedOutElsewhereShown){
        loggedOutElsewhereShown=true;
        toast.textContent='Your account was signed in on another device. Please log in again.';
      }
    },ACCOUNT_POLL_MS);
    await refreshAccount();
    try{session=JSON.parse(localStorage.getItem(sessionKey)||'null');}catch{}
    if(session){
      try{
        const resp=await post('/rejoin',session);applyIncoming(resp);activeSeat=resp.activeSeat??null;
        if(active){if(enteredThisPage)begin();else chooseCharacter();}
      }catch(e){
        if(e.status===403){
          session=null;try{localStorage.removeItem(sessionKey);}catch{}
          // Was this rejection because another device just logged into
          // THIS account (rotating the bar secret out from under this
          // tab), or an ordinary stale/forged session? refreshAccount()
          // right before the attempt already told us whether an account
          // was active; a 403 immediately after that is this tab's own
          // signal of exactly the takeover scenario CLAUDE.md names.
          if(account){
            loggedOutElsewhereShown=true;
            await refreshAccount(); // the cookie itself is still this tab's own, unaffected — only the bar secret was rotated
            toast.textContent='Your account was signed in on another device. Please log in again.';
            openAuthOverlay('login');
          }else chooseCharacter();
        }else toast.textContent='Unable to reconnect. Reload to retry.';
      }
    }
    else if(account){
      // A valid account cookie but no local bar session at all (e.g. a
      // brand-new tab/device for an already-registered account, or local
      // storage was cleared) — skip straight to the login form rather
      // than the generic menu, since "which account" isn't in question.
      openAuthOverlay('login');
    }
    else openAuthOverlay();
  }
  return {mount,stop:()=>{menuBook.close();dispose();}};
}
