// Export the per-CLASS idle animations from catanis.swf for the KittenShare card.
//
//   node tools/export-cat-anims.js
//   -> public/kittenshare/anims/<Class>.json   (one per class, lazy-loaded: a cat needs ONE)
//   -> public/kittenshare/anims/manifest.json  (class -> file + frames + viewBox)
//
// WHY THIS IS DERIVABLE, NOT GUESSED: catanis.swf's `CatTest` (id 1614) is an animation MENU —
// 854 frames, 776 FrameLabels. 65 of those labels are idles, including exactly one per class, and
// our 14 DECODED classes map 1:1 onto them. So a cat idles like its real class; nothing is
// invented. (Medic is the one rename — the game's internal name is "Healer". Colorless has no
// class idle and correctly gets the base `idleF`, which is the subtle one.)
//
// Each idle clip is 7 layers placing 1-FRAME placeholder sprites, so the animation is PURE
// MATRICES — the parts never change. That is the same seam the static rig renders into, so the
// card just swaps transforms.
//
// THREE TRAPS THIS TOOL EXISTS TO GET RIGHT (a naive extractor hits all three):
//
//  1. NAME identifies the slot; DEPTH is only the draw order. All four legs place the SAME char,
//     so charId can't separate them, and depth is NOT stable: HunterIdleF puts the head on depth
//     11 (where the standard rig has an arm) and JesterIdleF puts the tail on depth 3 and names
//     its head `head_happy`. Mapping by depth silently swaps parts.
//  2. Layer ORDER and COUNT vary PER FRAME. JesterIdleF has 4 distinct orders and 64 of its 426
//     frames carry EIGHT layers (FrontLeg_L drawn twice) because a tumbling cat's legs swap in
//     front of its body. So we emit a full layer LIST per frame — consumers must re-emit, never
//     index into a fixed list.
//  3. The card viewBox bounds the STATIC pose, not the clip. We record the headroom each clip
//     needs (see viewBoxFor) rather than letting the head clip.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseSwf } = require('./swf-render.js');

const SWF = 'data/game/catanis.swf';
const OUT_DIR = 'public/kittenshare/anims';
const CAT_TEST = 'CatTest';

// class -> CatTest frame label.
//
// NOT inferred — this IS the game's own config. `data/classes/classes.gon` and
// `data/classes/advanced_classes.gon` state it via `alt_animations [ [idle, <X>Idle] ]`:
//   Fighter->FighterIdle  Hunter->HunterIdle  Mage->MageIdle   Medic->HealerIdle
//   Tank->TankIdle        Thief->ThiefIdle    Monk->MonkIdle   Butcher->ButcherIdle
//   Druid->DruidIdle      Tinkerer->TinkererIdle   Necromancer->NecromancerIdle
//   Psychic->PsychicIdle  Jester->JesterIdle
// (Medic->HealerIdle is the game's rename, confirmed there, not our guess.) Colorless has NO
// alt_animations entry, so the base `idleF` is the game's own answer for a classless cat — its
// near-motionlessness is intended, not a gap. Re-read those two gons if a class is ever added.
const CLASS_ANIM = {
  Fighter: 'FighterIdleF', Mage: 'MageIdleF', Hunter: 'HunterIdleF', Druid: 'DruidIdleF',
  Tank: 'TankIdleF', Medic: 'HealerIdleF', Monk: 'MonkIdleF', Thief: 'ThiefIdleF',
  Jester: 'JesterIdleF', Psychic: 'PsychicIdleF', Necromancer: 'NecromancerIdleF',
  Tinkerer: 'TinkererIdleF',
  // Butcher: the game ships BOTH. `ButcherIdleF` (650f) carries an 8th `weapon` layer — his
  // cleaver, on 351 of those frames — and we do NOT render weapons (no held-in-paw socket yet),
  // so it would mime a swing with an invisible cleaver. `ButcherIdleNoWeapon` (81f) is the same
  // rig minus the cleaver, which is exactly our situation. Switch back if weapons ever render.
  Butcher: 'ButcherIdleNoWeapon',
  Colorless: 'idleF',
};

// BEHAVIOURS — occasional interjections mixed into any cat's idle loop, shared by all classes.
//
// Why this is NOT fabrication, when grey hair was: a behaviour asserts nothing about the cat.
// Drawing grey hair on a kitten claims it is old; a cat glancing around or scratching an ear
// claims nothing — it is animation, not data. And the game does exactly this: `toidleF`/`toidleB`
// (transitions back INTO idle) only exist because the game interjects other animations and
// returns to idle. We are reusing its own pattern, not inventing one.
//
// DELIBERATELY EXCLUDED — these DO assert something and would be fabrication:
//   zombie/skeleton/skeletonBig/werecat/albino/horntoad/catbot/berserk  -> "this cat is a ___"
//   girly/cute/dopey/twitchy  -> ENEMY animations, NOT a cat trait. `data/characters/
//     cat_enemies.gon` assigns them per enemy character via alt_animations: CatCaller->girlyIdle,
//     GlassSpitter/SpikedCat->twitchyIdle, PopeyeCat/GassyCat/BoomerCat->dopeyIdle. There is no
//     feature on a player cat that selects them, so giving one to a kitten would make it idle as
//     a specific enemy. Searched: these strings appear in NO player-cat data (catgen/mutations/
//     cats), only in the enemy roster.
//   brokenLeg/brokenPaw/dislocatedShoulder                              -> an injury (task #19)
//   lickAttack/bearHug/earthquakeSlam/disappear/slowPawMagic/tailwhip   -> combat; a cat on a
//                                                                          card is not attacking
//   sleep                                                               -> "this cat is asleep"
// sitAndSmileF is safe even though its head placeholders include head_insane/head_dead/
// head_terror: we substitute the CAT'S OWN head content and use catanis's head instance only for
// its MATRIX (a tilt). The expression never transfers — the cat keeps its real face throughout —
// so for us this reads as a calm sit with head turns, not a claim. (head_insane holds 62% of the
// clip, the rest are 1-2 frame flickers.)
const BEHAVIOURS = ['lookingaroundF', 'scratchearF', 'tailwagF', 'sitAndSmileF'];

// catanis instance name -> our appearance slot. Mewgenics calls FRONT legs "arm" and REAR legs
// "leg"; 1 = near (_L), 2 = far (_R). Heads vary by mood (`head`, `head_happy`, ...) -> Head.
const NAME_TO_SLOT = {
  tail: 'Tail', body: 'Body',
  leg1: 'RearLeg_L', leg2: 'RearLeg_R',
  arm1: 'FrontLeg_L', arm2: 'FrontLeg_R',
};
const slotFor = n => (!n ? null : (/^head/.test(n) ? 'Head' : (NAME_TO_SLOT[n] || null)));

// ---- FrameLabels (tag 43) live in the sprite's own tag stream; swf-render skips them.
function frameLabels(file, spriteId) {
  let buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 3) === 'CWS') buf = Buffer.concat([buf.slice(0, 8), zlib.inflateSync(buf.slice(8))]);
  let bp = 8 * 8;
  const rd = n => { let v = 0; for (let i = 0; i < n; i++) { const b = buf[bp >> 3]; v = (v << 1) | ((b >> (7 - (bp & 7))) & 1); bp++; } return v; };
  const nb = rd(5); rd(nb); rd(nb); rd(nb); rd(nb); bp = (bp + 7) & ~7;
  let pos = (bp >> 3) + 4;
  const u16 = p => buf.readUInt16LE(p);
  let sprite = null;
  while (pos < buf.length) {
    const cal = u16(pos); const code = cal >> 6; let len = cal & 0x3f; let hdr = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(pos + 2); hdr = 6; }
    const body = pos + hdr;
    if (code === 39 && u16(body) === spriteId) { sprite = { body, len }; break; }
    if (code === 0) break;
    pos = body + len;
  }
  if (!sprite) return {};
  const out = {};
  let p = sprite.body + 4, frame = 0;
  const end = sprite.body + sprite.len;
  while (p < end) {
    const cal = u16(p); const code = cal >> 6; let len = cal & 0x3f; let hdr = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(p + 2); hdr = 6; }
    const b = p + hdr;
    if (code === 43) { let s = '', q = b; while (buf[q] !== 0 && q < b + len) { s += String.fromCharCode(buf[q]); q++; } out[s] = frame; }
    if (code === 1) frame++;
    if (code === 0) break;
    p = b + len;
  }
  return out;
}

const swf = parseSwf(SWF);
const testId = swf.symbols[CAT_TEST];
if (!testId) { console.error('missing symbol', CAT_TEST, '- is', SWF, 'extracted?'); process.exit(1); }
const LABELS = frameLabels(SWF, testId);
const T = swf.dict[testId];
console.log(CAT_TEST, 'id', testId, '| frames', T.frames.length, '| FrameLabels', Object.keys(LABELS).length);

// Pull every frame's layer LIST (slot + full matrix) for one named animation.
function extractRig(label) {
  const fi = LABELS[label];
  if (fi == null) return { err: 'no FrameLabel "' + label + '"' };
  const f = T.frames[fi];
  if (!f) return { err: 'CatTest has no frame ' + fi };
  const placed = Object.keys(f).map(Number).sort((a, b) => a - b).map(d => f[d]).filter(pl => pl.charId != null);
  if (!placed.length) return { err: 'frame ' + fi + ' places nothing' };
  const S = swf.dict[placed[0].charId];
  if (!S || S.type !== 'sprite' || !S.frames.length) return { err: 'clip ' + placed[0].charId + ' is not an animated sprite' };
  const frames = [];
  let unnamed = 0;
  for (const fr of S.frames) {
    const layers = [];
    for (const d of Object.keys(fr).map(Number).sort((a, b) => a - b)) {   // depth == draw order
      const pl = fr[d];
      if (pl.charId == null || !pl.matrix) continue;
      const slot = slotFor(pl.name);
      if (!slot) { if (pl.name) unnamed++; continue; }
      const m = pl.matrix;
      layers.push({ s: slot, m: [m.sx, m.r0, m.r1, m.sy, m.tx, m.ty].map(v => +v.toFixed(4)) });
    }
    frames.push(layers);
  }
  return { clip: placed[0].charId, catTestFrame: fi, frames, unnamed };
}

// The card viewBox (-80 -100 170 135) bounds the STATIC pose. Keep its framing — it CROPS the
// parts on purpose (legs below, sides), so refitting the whole clip would un-crop the portrait —
// and extend only the TOP by however far the clip rises. Approximated from the layers' ty (the
// exact bbox needs a DOM); pad generously since this only ever ADDS headroom.
const CARD = { x: -80, y: -100, w: 170, h: 135 };
function viewBoxFor(frames) {
  let minTy = Infinity;
  for (const fr of frames) for (const l of fr) minTy = Math.min(minTy, l.m[5]);
  // ty is the layer ORIGIN; the art extends above it. The static rig's own min ty maps to the
  // card top, so shift the top by however much lower this clip's min ty goes.
  const base = -47.95;                       // groupOffset ty, the rig's frame of reference
  const rise = Math.min(0, minTy - (-24.45)); // -24.45 = the static idle's highest layer origin
  const top = Math.min(CARD.y, CARD.y + rise - 6);
  return [CARD.x, +top.toFixed(1), CARD.w, +(CARD.y + CARD.h - top).toFixed(1)];
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = {};
let total = 0, failed = 0;
for (const cls of Object.keys(CLASS_ANIM)) {
  const label = CLASS_ANIM[cls];
  const rig = extractRig(label);
  if (rig.err) { console.warn('  !!', cls.padEnd(12), label.padEnd(18), rig.err); failed++; continue; }
  const vb = viewBoxFor(rig.frames);
  const orders = new Set(rig.frames.map(fr => fr.map(l => l.s).join('>')));
  const counts = new Set(rig.frames.map(fr => fr.length));
  const out = { label, clip: rig.clip, fps: 30, viewBox: vb.join(' '), frames: rig.frames };
  const file = cls + '.json';
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(out));
  const kb = (fs.statSync(path.join(OUT_DIR, file)).size / 1024).toFixed(0);
  manifest[cls] = { file, label, frames: rig.frames.length, viewBox: out.viewBox };
  total += +kb;
  console.log('  ', cls.padEnd(12), label.padEnd(18), String(rig.frames.length).padStart(4) + 'f',
    String(kb).padStart(4) + 'KB', '| layer-orders', orders.size, '| counts', [...counts].join('/'),
    rig.unnamed ? '| UNNAMED ' + rig.unnamed : '');
}
// --- behaviours: ONE shared file every cat mixes into its idle loop
const behaviours = {};
for (const label of BEHAVIOURS) {
  const rig = extractRig(label);
  if (rig.err) { console.warn('  !! behaviour', label, rig.err); failed++; continue; }
  // A behaviour must not double-draw a slot: its head placeholders (head_bored/head_faceleft/…)
  // all normalise to Head, so verify they are mutually exclusive per frame before shipping it.
  const dup = rig.frames.filter(fr => {
    const seen = {};
    return fr.some(l => (seen[l.s] = (seen[l.s] || 0) + 1) > 1);
  }).length;
  if (dup) { console.warn('  !! behaviour', label, 'draws a slot twice on', dup, 'frames — SKIPPED'); failed++; continue; }
  behaviours[label] = { label, clip: rig.clip, fps: 30, viewBox: viewBoxFor(rig.frames).join(' '), frames: rig.frames };
  console.log('  ', ('~' + label).padEnd(14), String(rig.frames.length).padStart(4) + 'f');
}
const bFile = path.join(OUT_DIR, '_behaviours.json');
fs.writeFileSync(bFile, JSON.stringify(behaviours));
manifest._behaviours = { file: '_behaviours.json', names: Object.keys(behaviours) };

fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log();
console.log('wrote', OUT_DIR + '/ —', Object.keys(manifest).length - 1, 'classes +',
  Object.keys(behaviours).length, 'behaviours (' + (fs.statSync(bFile).size / 1024).toFixed(0) + 'KB shared),',
  total + 'KB class total,', failed, 'failed');
console.log('a cat lazy-loads exactly ONE class file + the shared behaviours.');
