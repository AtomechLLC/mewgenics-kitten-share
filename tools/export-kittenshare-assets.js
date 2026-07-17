#!/usr/bin/env node
// Export cat puppet part SVGs + head anchor sockets from catparts.swf into
// public/kittenshare/parts.js for the KittenShare page.
//
// RESOLVED SLOT -> FRAME MAPPING (01-06 gap closure):
//   A decoded appearance slot value (save-decode.js genes.slots.<Label>) is the
//   DIRECT frame index into that slot's catparts.swf master sprite — NOT 1000+value
//   and NOT a variant table lookup. Frame 0 is the part's default (base-kitten look).
//   Evidence:
//     * data/custom_cats.gon documents the gene fields (body/head/tail/leg/eye/
//       ear/brow/mouth N) as "frame indices into catparts.swf master sprites";
//       the game's own vocabulary is a direct frame index.
//     * The 01-05 corpus decode reads slot values as small ints that sit inside
//       each sprite's real frame count (CatBody has 1200 frames and decoded Body
//       values span 0..900; CatHead 1700 frames, values 0..900; etc.) — i.e. every
//       decoded value is a valid in-range frame index for its own sprite.
//     * In-game ground truth is the 01-06 Task-3 human visual-match checkpoint:
//       rendering these direct frames must visibly reproduce each cat's portrait.
//   The prior parts.js only emitted frames 1000-1049 (the base/custom-cat band),
//   which the decoded values never reference — hence real cats rendered as the
//   neutral base kitten. This tool now emits the LOW decoded band instead.
//
//   coatId -> palette: genes.coatId is a DIRECT row index into CAT_PALETTES
//   (public/kittenshare/palettes.js, row N = game textures/palette.png row N).
//   Corpus coatId values fall in [46,207], all within [0,255] — a plain palette row.
//
// SLOT LABEL -> SPRITE:
//   Body->CatBody, Head->CatHead, Tail->CatTail, RearLeg_*/FrontLeg_*->CatLeg,
//   Eye_L/Eye_R->CatEye, Brow_L/Brow_R->CatEyebrow, Ear_L/Ear_R->CatEar,
//   Mouth->CatMouth.
//
// FRAME BAND (minimal expansion — RENDER-SCOPE option A, Phase-1 proof):
//   Emitting a contiguous 0..~1030 band for every sprite would blow past a sane
//   parts.js size, and most of those frames are never referenced by a real cat.
//   Instead we emit, per sprite, the UNION of frame indices that the decoded slot
//   values actually occupy across the full ~1,316-cat corpus census (plus frame 0).
//   This deterministically covers every real cat in the corpus — including the
//   Task-3 proof cats (Reinaldo Body=223/Head=40/Eye=166/Ear=129/Tail=27/Mouth=24,
//   Dex, Evelyn, and their L/R pairs) — while keeping the output a single, plain
//   parts.js (no chunking/manifest/lazy-load — that is Phase-2 AST-01).
//   Full per-slot asset coverage + pixel-polish is Phase-2 (AST-01/AST-02).
//
// Usage: node tools/export-kittenshare-assets.js
const fs = require('fs');
const path = require('path');
const { parseSwf, renderChar } = require('./swf-render.js');

const SWF = 'data/game/catparts.swf';
const OUT = 'public/kittenshare/parts.js';

// Per-sprite UNION of decoded frame indices used across the full corpus census
// (steamcampaign02.sav, 1,298 cats, 1,293 with genes / 1,016 appearanceVerified,
// build 5090). Computed by decoding EVERY cat's genes.slots with the CURRENT
// save-decode.js and collecting the frames each render sprite references (CatLeg is
// the union of all four leg slots); frame 0 (default) is always included.
//
// REGENERATED 2026-07-14 against the POST-RO-fix decoder (commit 154b1c3). The prior
// embedded union was computed BEFORE that fix, so ~617 Colorless cats decoded to a
// mislocated base and the union covered a STALE frame set — missing ~30-40 frames per
// slot that real cats actually use (e.g. CatHead 160 for "Eri", the whole Colorless
// band). partSvg() fell back to frame 0 for those → bare/wrong faces. This union now
// covers the complete post-fix set (per-slot counts printed at export time). This is a
// COVERAGE regen only — no decoder/rig/coat change.
//
// Embedded here so this export is reproducible from the repo + catparts.swf alone,
// with no save file required. Regenerate with .scratch/compute-union.cjs (decodes a
// corpus save via save-decode.js) if the corpus grows or the decode changes.
const FRAME_UNION = {
  CatBody: [0,1,2,3,5,6,8,10,11,16,18,19,21,23,26,27,29,32,36,37,38,40,42,45,46,47,50,52,57,67,68,69,70,71,75,78,81,82,86,88,89,90,91,92,93,94,95,98,100,101,106,107,110,111,117,118,119,122,125,126,129,130,132,133,134,135,136,139,141,142,147,151,152,153,154,157,159,160,164,166,169,174,176,177,183,184,185,189,191,192,193,195,196,197,198,199,200,201,204,211,214,217,218,219,220,222,223,224,227,228,229,231,233,235,241,246,247,303,308,318,321,324,408,419,425,428,441,442,700,701,702,703,704,750,900],
  CatHead: [0,4,7,10,15,16,19,21,23,25,26,32,34,35,37,39,40,41,42,43,44,47,48,52,59,60,61,62,63,65,66,71,72,73,74,75,76,77,79,80,87,88,94,96,97,99,102,103,105,106,110,113,114,120,121,122,126,127,130,131,133,136,137,138,141,145,151,152,153,154,155,157,158,160,163,164,165,167,168,170,173,180,181,182,186,189,190,194,196,197,198,203,206,207,208,209,212,214,217,219,221,226,230,231,232,241,248,249,302,304,308,313,404,407,416,417,419,420,421,423,425,426,429,432,433,438,700,701,702,703,704,705,706,757,900],
  CatTail: [0,1,8,11,12,13,17,18,27,28,29,33,39,41,42,44,49,50,51,53,55,56,57,64,67,68,72,73,75,78,79,81,84,85,86,90,91,96,97,98,99,102,103,104,105,107,109,111,113,116,118,119,120,123,124,125,126,129,130,131,132,133,134,135,138,140,141,144,149,150,152,156,158,160,161,162,163,168,171,172,174,175,176,183,189,193,196,198,199,201,203,205,206,209,211,212,214,219,221,224,228,230,231,234,235,236,237,240,243,244,245,246,300,301,306,308,310,313,320,321,326,334,400,402,409,422,424,425,430,431,432,436,437,439,700,701,703,704,750,757,900],
  CatLeg: [0,5,7,12,13,15,16,17,19,21,23,25,26,27,30,31,39,41,42,43,44,45,47,48,53,55,56,58,62,63,72,76,82,83,84,88,89,91,94,98,99,100,101,102,105,106,109,112,114,117,118,120,122,130,132,133,134,137,138,145,147,149,150,152,155,157,158,160,161,162,163,164,165,166,167,169,170,171,173,176,180,181,184,186,187,190,193,194,195,196,197,198,206,209,210,212,213,214,215,216,217,218,219,220,221,222,224,225,226,228,229,230,231,234,238,241,243,244,246,250,301,302,303,305,307,309,310,311,312,317,324,325,327,329,334,335,336,337,340,400,402,403,404,407,408,409,410,411,412,415,416,419,424,425,426,427,428,432,433,437,438,439,440,700,701,702,703,704,705,706,707,758,761,900],
  CatEye: [0,2,3,5,9,11,12,13,22,24,26,27,29,30,33,35,36,41,42,43,45,47,48,50,51,52,53,54,55,57,58,59,61,62,63,66,68,70,71,74,75,76,79,81,82,88,90,92,93,94,95,99,103,104,105,107,110,113,116,117,118,120,122,127,128,132,133,137,139,140,143,146,148,149,151,152,154,155,157,163,165,166,167,170,171,172,176,179,181,186,187,188,189,190,191,201,202,206,207,209,211,212,218,222,224,225,226,228,233,237,238,240,241,244,247,301,303,315,316,325,327,329,334,336,337,339,344,351,400,401,420,424,425,429,432,434,442,700,701,702,704,705,706,900,1029],
  CatEyebrow: [0,2,7,11,13,15,18,21,24,25,29,31,36,38,40,41,42,43,45,49,50,51,52,58,59,60,62,63,65,69,71,73,74,77,80,83,84,86,88,89,91,93,100,101,104,105,106,107,108,111,112,113,116,119,120,125,130,132,133,134,135,136,137,142,144,147,148,151,153,155,158,159,166,168,169,170,171,172,173,178,181,183,185,186,187,188,190,192,193,194,196,197,199,202,207,211,215,220,223,224,227,229,231,232,237,238,244,245,247,248,301,304,305,308,309,310,311,313,315,400,402,404,408,409,412,416,418,423,425,426,427,434,437,439,440,700,701,702,900],
  CatEar: [0,1,2,5,6,11,16,18,19,22,26,27,31,32,35,36,39,41,43,46,50,51,52,55,60,61,63,65,67,70,71,72,76,79,81,82,85,88,90,92,94,96,99,100,102,105,109,111,112,114,117,123,125,129,130,132,134,137,138,143,144,146,147,148,151,152,154,156,158,160,162,163,166,168,171,173,176,177,178,180,181,183,184,186,187,188,191,192,196,197,203,204,205,214,216,217,222,224,226,227,228,231,232,233,235,238,241,244,247,319,320,322,327,331,343,344,401,411,414,417,419,422,427,441,700,701,702,703,704,900],
  CatMouth: [0,6,7,17,23,24,25,28,29,30,31,32,35,40,41,43,45,46,48,49,51,52,53,54,59,61,62,68,69,70,73,74,75,76,77,78,79,80,83,85,86,88,90,94,98,100,102,103,104,105,111,114,115,116,118,123,124,125,126,128,129,132,133,135,136,137,141,144,145,148,150,152,153,155,156,160,166,168,169,173,178,179,183,186,188,189,193,198,199,202,203,209,210,211,212,213,214,215,223,224,225,226,227,230,237,238,240,241,242,245,248,249,305,310,312,314,315,321,326,401,403,404,405,415,418,420,424,432,441,700,701,703,704,752,755,900],
};
// Non-rendered sprites kept for back-compat (default frame only).
const DEFAULT_ONLY = { CatEyeClosed: [0], CatMouthSmile: [0] };

const swf = parseSwf(SWF);

// Union of every frame we emit per sprite (drives both parts + sockets).
const framesFor = Object.assign({}, FRAME_UNION, DEFAULT_ONLY);

// FRAME OFF-BY-ONE FIX (2026-07-15): a decoded slot value V is a 1-INDEXED Flash frame
// number (the game stores gotoAndStop(V) targets). swf-render's parseSpriteBody builds a
// 0-INDEXED frames[] array (frames[0] = Flash frame 1), and renderChar(id, V) returns
// frames[V] = Flash frame V+1 — one frame too far. Verified in-game: Brimp's tail value
// 130 is Flash frame 130 = frames[129], not frames[130]; Julie's frog head is value 308 =
// frames[307]. So every value->frame lookup must render frames[V-1]. `ff` maps a decoded
// value to its 0-indexed array position; value 0 (the "default/base" sentinel) stays 0.
const ff = v => (v > 0 ? v - 1 : 0);

// CatLeg depth 26 (charId 9086) is the CLAW layer — a 2-frame toggle sprite the game
// shows/hides per leg via the `claws` gene (num_claws, 1..10). Most cats render clawless
// in-game, but a static render always draws its frame 0 (claws visible), so every paw
// wrongly sprouted dangling claw strokes. We strip depth 26 from all CatLeg renders so
// paws are clean by default; the per-leg `claws` gene is decoded separately (save-decode)
// for any future selective claw display.
const LEG_SPRITE = 'CatLeg';

// The FUR-FILL rect. Every part (body/head/legs/tail) paints its fur as a single flat
// grey rect clipped to that part's silhouette by a Flash mask layer, with the outlines and
// any painted art drawn as LATER siblings on top. CatTexture's plain frame places that very
// same shape at the very same matrix — so a pattern is applied by substituting the pattern's
// tile for this rect, in place. The part's own mask then clips the tile to the silhouette
// and the linework still draws over it, for free.
//
// Derive the id rather than hardcoding it: it is the one NON-CLIP shape that CatTexture's
// plain frame places (its other placement, at a lower depth, is the tile-boundary mask).
function findFurShapeId() {
  const tid = swf.symbols['CatTexture'];
  if (!tid || !swf.dict[tid] || !swf.dict[tid].frames.length) return null;
  const f0 = swf.dict[tid].frames[0];
  const cands = Object.keys(f0).map(Number).sort((a, b) => a - b)
    .map(d => f0[d])
    .filter(pl => pl.charId != null && pl.clipDepth == null &&
                  swf.dict[pl.charId] && swf.dict[pl.charId].type === 'shape');
  return cands.length === 1 ? cands[0].charId : null;
}
const FUR_SHAPE_ID = findFurShapeId();
if (FUR_SHAPE_ID == null) {
  console.warn('!! could not identify the fur-fill shape in CatTexture frame 0 — parts will ' +
               'export without data-fur markers and fur patterns will not render');
} else {
  console.log('fur-fill shape id =', FUR_SHAPE_ID);
}
const markChars = FUR_SHAPE_ID != null ? new Set([FUR_SHAPE_ID]) : null;

// AGE COSMETICS — grey hair + wrinkles. Both are sprites nested INSIDE a part's fur sprite,
// alongside the fur rect, and the game gotoAndStops them per cat based on age. renderChar pins
// every nested clip to frame 0, so a static render draws them on EVERY cat — the same bug class
// as the claw layer, and why kittens turned up grey-haired and wrinkled.
//
// Neither is honestly derivable: the trigger is runtime exe logic (and the "old" state is a
// random nightly roll after age ~20, not an age threshold), so we cannot know WHICH cats should
// have them. Drawing them on a kitten is a visible falsehood; omitting them from an elder is an
// absence. Per the project's no-fabrication rule, they default OFF — like claws.
//
// Derived, not hardcoded: a part's fur sprite is the one placing FUR_SHAPE_ID, and any SPRITE
// nested in there is an overlay on the fur. Today that finds exactly CatHead's 5961 (grey hair,
// 15 frames = 10 variants + 5 empty "hidden" frames) and 5972 (wrinkles, 10 frames), matching
// catgen's `num_grayhair 10` / `num_wrinkles 10`, and nothing on any other part.
function findFurCosmeticIds() {
  const out = new Set();
  if (FUR_SHAPE_ID == null) return out;
  for (const slot of Object.keys(swf.symbols)) {
    if (!/^Cat/.test(slot)) continue;
    const P = swf.dict[swf.symbols[slot]];
    if (!P || P.type !== 'sprite' || !P.frames) continue;
    for (const f of P.frames) {
      for (const d of Object.keys(f)) {
        const pl = f[d];
        if (pl.charId == null) continue;
        const c = swf.dict[pl.charId];
        if (!c || c.type !== 'sprite' || !c.frames[0]) continue;
        const kids = Object.keys(c.frames[0]).map(k => c.frames[0][k]).filter(p => p.charId != null);
        if (!kids.some(p => p.charId === FUR_SHAPE_ID)) continue;   // not a fur sprite
        for (const k of kids) {
          const kc = swf.dict[k.charId];
          if (kc && kc.type === 'sprite') out.add(k.charId);          // overlay on the fur
        }
      }
    }
  }
  return out;
}
const FUR_COSMETICS = findFurCosmeticIds();
console.log('age cosmetics (grey hair/wrinkles) stripped:',
  FUR_COSMETICS.size ? [...FUR_COSMETICS].join(', ') : 'NONE FOUND — check catparts');

const legRenderOpts = { skipDepths: new Set([26]) };
function renderOptsFor(sprite) {
  const o = sprite === LEG_SPRITE ? Object.assign({}, legRenderOpts) : {};
  if (markChars) o.markChars = markChars;
  if (FUR_COSMETICS.size) o.skipChars = FUR_COSMETICS;
  return Object.keys(o).length ? o : undefined;
}

const parts = {};
for (const slot of Object.keys(framesFor)) {
  const id = swf.symbols[slot];
  if (!id) { console.warn('missing symbol', slot); continue; }
  const ch = swf.dict[id];
  const n = ch.frames ? ch.frames.length : 0;
  parts[slot] = { frames: {}, totalFrames: n };
  for (const f of framesFor[slot]) {
    if (f >= n) { console.warn('  frame out of range', slot, f, 'of', n); continue; }
    const defs = [];
    const inner = renderChar(swf, id, ff(f), defs, 0, renderOptsFor(slot));   // value f -> Flash frame f -> frames[f-1]
    parts[slot].frames[f] = { defs: defs.join(''), body: inner };
  }
}

// Head anchor sockets — emit one entry per exported CatHead frame (the decoded
// Head band), keyed by head frame. The page keys HEAD_SOCKETS by genes.slots.Head.
// EVERY used head frame MUST get a socket set: a socket-less head frame renders no
// ears/eyes/brows/mouth (a bare ball). If CatHeadPlacements genuinely lacks placement
// data for a used head frame, fall back to the nearest available head frame's sockets
// (ties -> lower frame), or frame 0 if none exists. Fallbacks are logged so we know
// which frames borrowed placements. (On the current corpus 0 frames needed fallback —
// all 135 used head frames carry their own CatHeadPlacements data.)
const hpId = swf.symbols['CatHeadPlacements'];
const hp = swf.dict[hpId];
// A head's anchors are identified by the PLACEHOLDER charId, NOT by depth.
//
// Depths are only stable across the plain heads. Mutation heads re-rig their anchors onto
// other depths: the sloth head (value 706) puts earL/earR/eyeL/mouth on 46/50/54/58 and eyeR
// on 62. The old depth map therefore read a mutation head's depth-62 as "eyeL" when the
// placeholder there is really eyeR — so Guiseppi rendered ONE eye, and the wrong one, with no
// ears. Keying on the placeholder charId fixes 1090 of 1505 frames: frames with BOTH eyes go
// 318 -> 1398 and both ears 749 -> 1401, while the plain heads are byte-identical (their
// depths already agreed).
//
// 11001/11003/11005 are the equipped-item anchors (head/face/neck) so worn items land where
// the game puts them.
const SOCKET_BY_CHAR = { 10987: 'earL', 10989: 'earR', 10997: 'mouth',
  11001: 'headItem', 11003: 'faceItem', 11005: 'neckItem' };
// Brows REUSE the eye placeholders (a plain head has 10993 at both the eyeL and browL depths),
// so charId alone is ambiguous for these two. Resolve by order: ascending depth, the FIRST
// occurrence is the eye and the SECOND is the brow. Heads with no brow simply never hit the
// second slot.
const SOCKET_PAIR = { 10993: ['eyeL', 'browL'], 10999: ['eyeR', 'browR'] };
function socketsForFrame(f) {
  const fr = hp.frames[f]; if (!fr) return null;
  const s = {};
  const seen = {};
  const depths = Object.keys(fr).map(Number).sort((a, b) => a - b);
  for (const d of depths) {
    const pl = fr[d];
    if (!pl || !pl.matrix || pl.charId == null) continue;
    let name = SOCKET_BY_CHAR[pl.charId];
    if (!name && SOCKET_PAIR[pl.charId]) {
      const n = seen[pl.charId] || 0;
      seen[pl.charId] = n + 1;
      name = SOCKET_PAIR[pl.charId][n];        // undefined past the 2nd — ignored
    }
    if (!name) continue;
    // Depth is deliberately NOT exported. This sprite is ANCHOR DATA (hence "Placements") —
    // the game reads these matrices and composites the parts in its own fixed order, so a
    // depth here is guide-file stacking, not draw order. Proof: the item anchors stay at
    // 82/86/90 on every head even when the face re-rigs (62/66/70 plain -> 54/58/62 sloth),
    // and depth order would draw headItem(82) behind neckItem(90) — a hat under a collar,
    // the opposite of the order we draw and have verified on real cats. Exporting a `z` here
    // would just invite the page to sort by it again.
    s[name] = { tx: +pl.matrix.tx.toFixed(2), ty: +pl.matrix.ty.toFixed(2), sx: +pl.matrix.sx.toFixed(4), sy: +pl.matrix.sy.toFixed(4) };
  }
  // A BROW USES ITS EYE'S ANCHOR. Only 1 of 1505 frames (head 1) actually carries a second
  // eye-placeholder pair, and on that one frame the brow anchor is IDENTICAL to the eye's
  // (same tx/ty, same sx/sy — delta 0). So the anchor was never per-brow: the CatEyebrow art
  // itself carries the offset that lifts it above the eye. Deriving it here gives all 1504
  // other heads their brows, which is why cats like Ernie rendered with no eyebrows at all
  // despite having a real brow gene.
  if (!s.browL && s.eyeL) s.browL = s.eyeL;
  if (!s.browR && s.eyeR) s.browR = s.eyeR;
  // A frame with no anchor placeholders at all is treated as "no socket source".
  return Object.keys(s).length ? s : null;
}
// Frames that actually carry placement data — the fallback search space.
const availSocketFrames = [];
for (let f = 0; f < (hp.frames ? hp.frames.length : 0); f++) if (socketsForFrame(f)) availSocketFrames.push(f);
function nearestSocketFrame(f) {
  let best = -1, bestD = Infinity;
  for (const g of availSocketFrames) {
    const d = Math.abs(g - f);
    if (d < bestD || (d === bestD && g < best)) { bestD = d; best = g; }
  }
  return best;
}
const sockets = {};
const socketFallbacks = [];
for (const f of FRAME_UNION.CatHead) {
  const fi = ff(f);                        // sockets align to the SAME Flash frame as the head art
  let s = socketsForFrame(fi);
  if (!s) {
    const nf = nearestSocketFrame(fi);
    const src = nf >= 0 ? nf : 0;
    s = socketsForFrame(src) || {};
    socketFallbacks.push({ frame: f, borrowedFrom: nf >= 0 ? nf : 0 });
  }
  sockets[f] = s;
}

const js = '// AUTO-GENERATED by tools/export-kittenshare-assets.js — do not edit.\n' +
  '// Cat puppet parts from catparts.swf. Frames are the DECODED slot->frame band\n' +
  '// (direct frame index per sprite; frame 0 = default), covering the full corpus\n' +
  '// census union — NOT the old 1000-1049 base band. coatId indexes CAT_PALETTES.\n' +
  '// Fur/texture areas use var(--cat-texture); recolor by setting that CSS var.\n' +
  'const CAT_PARTS = ' + JSON.stringify(parts) + ';\n' +
  'const HEAD_SOCKETS = ' + JSON.stringify(sockets) + ';\n' +
  // Node/CommonJS shim (browser uses the two consts as <script> globals): expose
  // them on module.exports + global so the Node harness/verify can read CAT_PARTS.
  'if (typeof module !== "undefined" && module.exports) { module.exports = { CAT_PARTS: CAT_PARTS, HEAD_SOCKETS: HEAD_SOCKETS };\n' +
  '  if (typeof global !== "undefined") { global.CAT_PARTS = CAT_PARTS; global.HEAD_SOCKETS = HEAD_SOCKETS; } }\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, js);
console.log('wrote', OUT, (js.length / 1024).toFixed(0) + 'KB', '(' + (js.length / 1048576).toFixed(2) + ' MB)');
for (const s of Object.keys(parts)) console.log(' ', s, Object.keys(parts[s].frames).length, 'frames of', parts[s].totalFrames);
console.log('  HEAD_SOCKETS', Object.keys(sockets).length, 'frames;', socketFallbacks.length, 'used nearest-frame fallback');
if (socketFallbacks.length) console.log('  socket fallbacks:', socketFallbacks.map(x => x.frame + '<-' + x.borrowedFrom).join(', '));

// --- patterns.js monolith (CAT_TEXTURES) — the eager fur-PATTERN band for the local
// browse view (genes.pattern -> CatTexture frame). Same value->frame off-by-one as the
// parts (ff), same corpus-union approach. Originally produced by an ad-hoc pattern spike;
// folded in here so the -1 fix and future regens stay in ONE tool. PATTERN_UNION is the
// set of decoded genes.pattern values across the live corpus (frame 0 excluded — a cat
// with no pattern renders solid fur, not CatTexture[0]).
const PATTERN_UNION = [1,5,9,10,12,15,16,17,19,20,22,23,26,27,28,29,31,35,36,37,38,39,51,52,53,54,55,57,63,65,71,73,74,76,77,78,81,83,86,88,90,91,92,94,99,101,103,110,112,113,115,116,120,121,122,125,129,130,131,134,135,137,138,140,141,144,148,149,150,151,155,157,161,162,168,169,170,171,172,173,179,181,185,186,187,188,189,192,196,202,203,204,205,206,207,208,209,212,214,217,218,219,221,226,227,231,233,235,236,244,245,246,248,250,301,304,308,400,407,415,417,422,424,425,427,441,700,701,702,703,704,705,706];
const PATTERNS_OUT = 'public/kittenshare/patterns.js';
const texMonoId = swf.symbols['CatTexture'];
const textures = {};
if (texMonoId) {
  const tn = swf.dict[texMonoId].frames.length;
  for (const p of PATTERN_UNION) {
    if (p >= tn) { console.warn('  pattern out of range', p, 'of', tn); continue; }
    const d = [];
    const inner = renderChar(swf, texMonoId, ff(p), d, 0);   // value p -> Flash frame p -> frames[p-1]
    textures[p] = { defs: d.join(''), body: inner };
  }
  const pjs = '// AUTO-GENERATED by tools/export-kittenshare-assets.js — do not edit.\n' +
    '// CatTexture fur-PATTERN frames from catparts.swf for the CORPUS-UNION of decoded\n' +
    '// genes.pattern values. Keyed by pattern id -> {defs, body}. Recolored at render time\n' +
    '// by the coat palette LUT. A decoded value V renders Flash frame V (frames[V-1]).\n' +
    'const CAT_TEXTURES = ' + JSON.stringify(textures) + ';\n' +
    'if (typeof module !== "undefined" && module.exports) { module.exports = { CAT_TEXTURES: CAT_TEXTURES };\n' +
    '  if (typeof global !== "undefined") { global.CAT_TEXTURES = CAT_TEXTURES; } }\n';
  fs.writeFileSync(PATTERNS_OUT, pjs);
  console.log('wrote', PATTERNS_OUT, (pjs.length / 1024).toFixed(0) + 'KB —', Object.keys(textures).length, 'pattern frames');
} else console.warn('missing CatTexture symbol — patterns.js not regenerated');

// --- items.js (ITEM_SPRITES) — worn equipped-item art. Head/face/neck items render on
// the cat via HeadItemF/FaceItemF/NeckItemF (+ HeadItemB behind the head); Weapon is held.
// Each item's data/items gon `frame` is a 1-indexed Flash frame (same convention as the
// part slots), so render frames[frame-1] via ff. Full sprite coverage (a few hundred frames
// each) is small enough to ship eagerly, and covers any shared cat too. Keyed by frame id
// so item-ids.js `frame` looks up directly.
// kind -> on-cat sprite(s). Only render the frames actually referenced by real items
// (from ITEM_VOCAB) rather than every sprite frame — keeps items.js small.
// Only the WORN, on-cat item sprites we actually render. Weapon (held-in-paw) isn't
// placed yet and its ~226 frames dominate items.js size, so it's excluded until rendered.
const KIND_SPRITES = { head: ['HeadItemF', 'HeadItemB'], face: ['FaceItemF'], neck: ['NeckItemF'] };
const ITEMS_OUT = 'public/kittenshare/items.js';
let ITEM_VOCAB = {};
try { ITEM_VOCAB = require('../public/kittenshare/item-ids.js').ITEM_VOCAB || {}; }
catch (e) { console.warn('  item-ids.js not found — run export-item-vocab.js first'); }
const framesByKind = {};                    // kind -> Set(frame values used)
for (const k in ITEM_VOCAB) {
  const it = ITEM_VOCAB[k];
  (framesByKind[it.kind] || (framesByKind[it.kind] = new Set())).add(it.frame);
}
const itemSprites = {};
for (const kind in KIND_SPRITES) {
  const used = framesByKind[kind]; if (!used) continue;
  for (const sp of KIND_SPRITES[kind]) {
    const sid = swf.symbols[sp];
    if (!sid || !swf.dict[sid] || !swf.dict[sid].frames) { console.warn('  missing item sprite', sp); continue; }
    const sn = swf.dict[sid].frames.length;
    const frames = {};
    for (const v of used) {                 // v = the gon `frame` value (1-indexed)
      if (v < 1 || v >= sn) continue;
      const d = [];
      frames[v] = { defs: d.join(''), body: renderChar(swf, sid, ff(v), d, 0) };
    }
    itemSprites[sp] = { frames: frames, totalFrames: sn };
  }
}
const ijs = '// AUTO-GENERATED by tools/export-kittenshare-assets.js — do not edit.\n' +
  '// Worn equipped-item sprites from catparts.swf (HeadItemF/HeadItemB/FaceItemF/NeckItemF/\n' +
  '// Weapon). Keyed by the data/items gon `frame` value; a value V renders Flash frame V\n' +
  '// (frames[V-1]). Placed on the cat at the head/face/neck item sockets (HEAD_SOCKETS).\n' +
  'const ITEM_SPRITES = ' + JSON.stringify(itemSprites) + ';\n' +
  'if (typeof module !== "undefined" && module.exports) { module.exports = { ITEM_SPRITES: ITEM_SPRITES };\n' +
  '  if (typeof global !== "undefined") { global.ITEM_SPRITES = ITEM_SPRITES; } }\n';
fs.writeFileSync(ITEMS_OUT, ijs);
console.log('wrote', ITEMS_OUT, (ijs.length / 1024).toFixed(0) + 'KB —',
  Object.keys(itemSprites).map(s => s + ':' + Object.keys(itemSprites[s].frames).length).join(' '));

// Fast path for verifying the monolith fix without regenerating the 84 MB chunk tree.
if (process.env.MONOLITH_ONLY) { console.log('MONOLITH_ONLY set — skipping chunk export.'); process.exit(0); }

// ============================================================================
// FULL-COVERAGE CHUNKED EXPORT (AST-01) — ADDITIVE to the eager monolith above.
//
// The eager parts.js/patterns.js written above cover only the CORPUS-UNION of frames
// real cats happen to use; the local browse view keeps using them (locked decision D3).
// But a shared link can carry ANY in-range frame, so the STANDALONE shared-card path
// needs FULL per-sprite coverage (~42 MB / ~12.7k part frames + ~2.8k pattern frames).
// Full coverage as one blob busts Cloudflare Pages' 25-MiB/file cap, and one-file-per-
// frame approaches its 20,000-file cap. So we emit per-slot RANGE chunks
// (parts/<Sprite>/<lo>-<hi>.json) + a manifest; kittenshare.html's loadNeededParts()
// fetches ONLY the ~12 chunks a given cat references. This block ADDS that tree; it does
// NOT touch parts.js/patterns.js above.
// ============================================================================
const CHUNK = 150;                       // frames per range chunk. CatHead (~12.5 KB/frame,
                                         // the heaviest sprite) -> ~1.9 MB/chunk, far under 25 MiB.
const CAP = 25 * 1024 * 1024;            // Cloudflare Pages HARD per-file cap.
const FILE_LIMIT = 20000;                // Cloudflare Pages Free plan HARD file-count cap.
const RENDER_SPRITES = ['CatBody', 'CatHead', 'CatTail', 'CatLeg', 'CatEye', 'CatEyebrow', 'CatEar', 'CatMouth'];
const PARTS_DIR = 'public/kittenshare/parts';
const PATTERNS_DIR = 'public/kittenshare/patterns';

function freshDir(d) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

let totalFiles = 0, maxBytes = 0, maxFile = '';
function writeJson(absPath, obj) {
  const json = JSON.stringify(obj);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, json);
  totalFiles++;
  if (json.length > maxBytes) { maxBytes = json.length; maxFile = absPath; }
  if (json.length > CAP) console.error('  !!! OVER 25 MiB CAP:', absPath, (json.length / 1048576).toFixed(2) + ' MB');
  return json.length;
}

// Render a sprite's FULL 0..n-1 frame range as CHUNK-sized {"<frame>":{defs,body}} files.
// `subdir` scopes part files under parts/<Sprite>/ ; patterns live flat under patterns/.
function exportSpriteChunks(id, baseDir, subdir) {
  const ch = swf.dict[id];
  const n = (ch && ch.frames) ? ch.frames.length : 0;
  const rOpts = renderOptsFor(subdir);   // strip the claw layer for CatLeg (subdir === sprite name)
  const ranges = [];
  for (let lo = 0; lo < n; lo += CHUNK) {
    const hi = Math.min(lo + CHUNK - 1, n - 1);
    const obj = {};
    for (let f = lo; f <= hi; f++) {
      const d = [];
      const inner = renderChar(swf, id, ff(f), d, 0, rOpts);   // key f = decoded value -> frames[f-1]
      obj[f] = { defs: d.join(''), body: inner };
    }
    const rel = (subdir ? subdir + '/' : '') + lo + '-' + hi + '.json';
    const bytes = writeJson(path.join(baseDir, rel), obj);
    ranges.push({ lo, hi, file: rel });
    console.log('   ', rel, (bytes / 1024).toFixed(0) + 'KB');
  }
  return { ranges, n };
}

// --- parts/ range chunks + manifest ---
freshDir(PARTS_DIR);
const partSlots = {};
for (const sprite of RENDER_SPRITES) {
  const id = swf.symbols[sprite];
  if (!id) { console.warn('missing sprite', sprite); continue; }
  console.log('chunking', sprite);
  const { ranges, n } = exportSpriteChunks(id, PARTS_DIR, sprite);
  partSlots[sprite] = ranges;
  console.log('  ', sprite, n, 'frames ->', ranges.length, 'chunks');
}
writeJson(path.join(PARTS_DIR, 'manifest.json'), { version: 1, chunkFrames: CHUNK, slots: partSlots });

// --- FULL head sockets (every CatHead frame, nearest-frame fallback) — one small eager file ---
// Sockets are tiny; loadNeededParts fetches head-sockets.json once and merges it into
// HEAD_SOCKETS so ANY shared head frame has ear/eye/brow/mouth anchors (never a bare ball).
// Iterate the CatHead frame count (not CatHeadPlacements' — the placement sprite is SHORTER,
// so head frames beyond its length must borrow the nearest available frame's sockets).
const catHeadId = swf.symbols['CatHead'];
const headN = (catHeadId && swf.dict[catHeadId] && swf.dict[catHeadId].frames) ? swf.dict[catHeadId].frames.length : 0;
const fullSockets = {};
const fullFallbacks = [];
for (let f = 0; f < headN; f++) {
  const fi = ff(f);                        // key f = decoded head value -> placements frame f-1
  let s = socketsForFrame(fi);
  if (!s) {
    const nf = nearestSocketFrame(fi);
    s = socketsForFrame(nf >= 0 ? nf : 0) || {};
    fullFallbacks.push(f);
  }
  fullSockets[f] = s;
}
writeJson(path.join(PARTS_DIR, 'head-sockets.json'), fullSockets);
console.log('  head-sockets', Object.keys(fullSockets).length, 'frames;', fullFallbacks.length, 'used nearest-frame fallback');

// --- patterns/ range chunks + manifest (CatTexture) ---
freshDir(PATTERNS_DIR);
const patSlots = {};
const texId = swf.symbols['CatTexture'];
if (texId) {
  console.log('chunking CatTexture');
  const { ranges, n } = exportSpriteChunks(texId, PATTERNS_DIR, '');
  patSlots['CatTexture'] = ranges;
  console.log('   CatTexture', n, 'frames ->', ranges.length, 'chunks');
} else console.warn('missing CatTexture');
writeJson(path.join(PATTERNS_DIR, 'manifest.json'), { version: 1, chunkFrames: CHUNK, slots: patSlots });

console.log('\nCHUNK EXPORT SUMMARY');
console.log('  total chunk-tree files:', totalFiles, totalFiles < FILE_LIMIT ? '(under 20,000 cap)' : '(!!! OVER 20,000 CAP)');
console.log('  largest file:', (maxBytes / 1048576).toFixed(2) + ' MB', maxFile);
if (maxBytes > CAP) { console.error('  FATAL: a chunk exceeds the 25 MiB cap'); process.exit(1); }
if (totalFiles >= FILE_LIMIT) { console.error('  FATAL: chunk-tree file count exceeds the 20,000 cap'); process.exit(1); }
