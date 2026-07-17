#!/usr/bin/env node
// Export the equipped-ITEM vocabulary for KittenShare: every item's stable KEY (the
// ascii token stored in the cat blob) -> { kind, frame, name }. `kind` selects the
// on-cat sprite (head->HeadItemF, face->FaceItemF, neck->NeckItemF, weapon->Weapon;
// trinket/modifier aren't worn) and `frame` is the frame in that sprite. `name` is the
// localized display string resolved from data/text/combined.csv.
//
// Usage:  node tools/export-item-vocab.js   (needs a local Mewgenics install / GPAK env)
// Writes: public/kittenshare/item-ids.js  (ITEM_VOCAB global + CommonJS export)

const fs = require('fs');
const path = require('path');
const GPAK = process.env.GPAK || 'Z:/SteamLibrary/steamapps/common/Mewgenics/resources.gpak';
const OUT = path.resolve(__dirname, '../public/kittenshare/item-ids.js');

// ---- gpak reader (same as derive-categories.js) ----
function openGpak(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16 * 1024 * 1024);
  fs.readSync(fd, head, 0, head.length, 0);
  const count = head.readUInt32LE(0);
  let p = 4; const entries = [];
  for (let i = 0; i < count; i++) {
    const nlen = head.readUInt16LE(p);
    const name = head.slice(p + 2, p + 2 + nlen).toString('latin1');
    const size = head.readUInt32LE(p + 2 + nlen);
    entries.push({ name, size }); p += 2 + nlen + 4;
  }
  let off = p; const offsets = {};
  for (const e of entries) { offsets[e.name] = { off, size: e.size }; off += e.size; }
  return {
    entries,
    read(name) { const m = offsets[name]; if (!m) return null; const b = Buffer.alloc(m.size); fs.readSync(fd, b, 0, m.size, m.off); return b.toString('utf8'); },
    close() { fs.closeSync(fd); },
  };
}

const g = openGpak(GPAK);

// ---- localized names: combined.csv is `KEY,English,...` ----
const csv = g.read('data/text/combined.csv') || '';
const nameByKey = {};
for (const line of csv.split(/\r?\n/)) {
  const c = line.indexOf(',');
  if (c < 1) continue;
  const key = line.slice(0, c);
  if (!/_NAME$/.test(key)) continue;
  // English is the 2nd column; handle simple quoting
  let rest = line.slice(c + 1);
  let en;
  if (rest[0] === '"') { const e = rest.indexOf('"', 1); en = rest.slice(1, e); }
  else { en = rest.slice(0, rest.indexOf(',') === -1 ? undefined : rest.indexOf(',')); }
  if (en) nameByKey[key] = en;
}

// ---- gon block parsing ----
// Brace-MATCHED so a nested block can't truncate the body: the old regex stopped at the
// first `\n}`, which for `Horns { … passives { Thorns 1 } }` is the passives closer. It
// happened to work for kind/frame/name (those precede passives) but is wrong in general
// and unusable for stats. Advancing lastIndex past each block also stops nested keys
// (Thorns) from being read as top-level items.
function parseBlocks(t) {
  const out = {};
  // Block comments are stripped first: modifiers.gon has a commented-out `/*LevelUp {…}*/`
  // that the old unanchored regex published as a real item.
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  // Leading indentation is allowed: armor_sets.gon indents its blocks under `//SET` header
  // comments, and anchoring at column 0 silently dropped all 288 of them. Nested blocks
  // (`passives {`) are still never matched as items because lastIndex skips past each
  // consumed block entirely.
  //
  // \w+ (not [A-Za-z_]\w*) because item keys may START WITH A DIGIT — e.g. `22Rifle`. The
  // old regex could only start matching at a letter, so it produced the key `Rifle` from
  // the middle of `22Rifle`. That key never matches the blob's real `22Rifle` token, so a
  // cat holding a .22 Rifle silently showed no weapon.
  const re = /^[ \t]*(\w+)\s*\{/gm; let m;
  while ((m = re.exec(t))) {
    const key = m[1];
    let depth = 1, i = re.lastIndex;
    while (i < t.length && depth > 0) {
      const ch = t[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    out[key] = t.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
  }
  return out;
}

// `key <int>` pairs at the block's OWN depth only — a stat inside `passives { … }` belongs
// to the passive, not the item, and must not be summed into the item's bonus.
function topLevelScalars(body) {
  const out = {};
  let depth = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (depth === 0) {
      const m = line.match(/^([A-Za-z_]\w*)\s+(-?\d+)\s*$/);
      if (m) out[m[1].toLowerCase()] = +m[2];
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return out;
}

// The 7 core stats the card's triplet covers. shield/hp/mp also appear on items but are
// not part of the in-game 7-stat grid, so they're deliberately not collected here.
const STAT_KEYS = ['str', 'dex', 'con', 'int', 'spd', 'cha', 'lck'];

// ---- parse every item gon into key -> {kind, frame, name, stats?} ----
const items = {};
const itemGons = g.entries.filter(e => /data\/items\/.*\.gon$/i.test(e.name)).map(e => e.name);
for (const f of itemGons) {
  const blocks = parseBlocks(g.read(f) || '');
  for (const key of Object.keys(blocks)) {
    const body = blocks[key];
    const kind = (body.match(/^\s*kind\s+(\w+)/m) || [])[1];
    const frame = (body.match(/^\s*frame\s+(\d+)/m) || [])[1];
    const nameKey = (body.match(/^\s*name\s+"([^"]+)"/m) || [])[1];
    // Same gate as before: a block with no kind/frame is a variant/set/fragment, not a
    // wearable item, and never appears as an equipped token.
    if (!kind || frame == null) continue;
    const rec = { kind, frame: +frame, name: (nameKey && nameByKey[nameKey]) || key };
    const scal = topLevelScalars(body);
    const stats = {};
    for (const s of STAT_KEYS) if (scal[s]) stats[s] = scal[s];   // 0 == no bonus; omit
    if (Object.keys(stats).length) rec.stats = stats;
    items[key] = rec;
  }
}
g.close();

// Regression guard: the kind/frame/name fields feed the on-cat item ART and are already
// verified against the live corpus. This rewrite is only meant to ADD `stats`, so fail
// loudly if any existing field moved.
// These keys are EXPECTED to change — each fixes a bug in the old unanchored, comment-blind
// regex, and each was verified by reading the raw gon. Anything NOT listed here is
// unintended drift and fails the export.
//
// 1) Nine phantoms: items sitting inside /* … */ blocks (disabled/unfinished, several tagged
//    //todo). The old regex had no comment awareness and published them as real equipment.
// 2) `Rifle`: matched from the middle of `22Rifle` because the old key pattern could only
//    start at a letter. The bogus key never matched the blob's real `22Rifle` token, so the
//    .22 Rifle silently rendered no weapon — replacing it with 22Rifle FIXES that item.
const COMMENTED_OUT = ['LevelUp', 'Upgrade', 'StatUp', 'StatShuffle', 'InstantHeal',
  'CureDisorder', 'TemporaryBuff', 'Rosary', 'WeatherVane', 'Checkers'];
const EXPECTED_DRIFT = { 'Rifle REMOVED': 'bogus key from the middle of `22Rifle`', '22Rifle ADDED': 'the real digit-leading .22 Rifle key' };
for (const k of COMMENTED_OUT) EXPECTED_DRIFT[k + ' REMOVED'] = 'commented-out /* … */ block — never a real item';
const prev = (() => { try { return require(OUT).ITEM_VOCAB; } catch (e) { return null; } })();
if (prev) {
  const drift = [];
  const keys = new Set([...Object.keys(prev), ...Object.keys(items)]);
  for (const k of keys) {
    const a = prev[k], b = items[k];
    if (!a || !b) { drift.push(k + (a ? ' REMOVED' : ' ADDED')); continue; }
    if (a.kind !== b.kind || a.frame !== b.frame || a.name !== b.name) drift.push(k + ' CHANGED');
  }
  const unexpected = drift.filter(d => !(d in EXPECTED_DRIFT));
  if (unexpected.length) {
    console.error('  !!! UNEXPECTED ITEM_VOCAB drift (' + unexpected.length + '):', unexpected.slice(0, 8).join(', '));
    process.exit(1);
  }
  for (const d of drift) console.log('  expected fix:', d, '—', EXPECTED_DRIFT[d]);
  console.log('  regression guard: kind/frame/name otherwise unchanged across', Object.keys(items).length, 'items');
}

const js = '// AUTO-GENERATED by tools/export-item-vocab.js — do not edit.\n' +
  '// Equipped-item vocabulary: item KEY (ascii token in the cat blob) -> { kind, frame, name, stats? }.\n' +
  '// kind selects the on-cat sprite (head/face/neck -> *ItemF, weapon -> Weapon; trinket/modifier\n' +
  '// are inventory-only, not worn). frame is the frame index in that sprite. name is localized (EN).\n' +
  '// stats (optional) = the item\'s flat bonuses to the 7 core stats, e.g. {cha:2} for the Wig.\n' +
  '// Only present when non-zero. shield/hp/mp bonuses exist on items but are NOT collected:\n' +
  '// they are not part of the in-game 7-stat grid the card mirrors.\n' +
  'const ITEM_VOCAB = ' + JSON.stringify(items) + ';\n' +
  'if (typeof module !== "undefined" && module.exports) { module.exports = { ITEM_VOCAB: ITEM_VOCAB };\n' +
  '  if (typeof global !== "undefined") { global.ITEM_VOCAB = ITEM_VOCAB; } }\n';
fs.writeFileSync(OUT, js);
const byKind = {};
for (const k in items) byKind[items[k].kind] = (byKind[items[k].kind] || 0) + 1;
const withStats = Object.keys(items).filter(k => items[k].stats).length;
console.log('wrote', OUT, (js.length / 1024).toFixed(0) + 'KB —', Object.keys(items).length, 'items;', withStats, 'carry stat bonuses');
console.log('  by kind:', JSON.stringify(byKind));
