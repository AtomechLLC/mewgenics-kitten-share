#!/usr/bin/env node
// Export ability display names + the game's REAL ability icon art for KittenShare.
//
// WHY FRAMELABELS: a cat's abilities decode as internal ids (BasicRanged_Hunter). The gon
// gives each one `meta { ability_icon <Name> }` — an icon referenced BY NAME, not a number.
// The name resolves through the SWF's FrameLabel tags: swfs/ability_icons.swf exports two
// sprites, AbilityIcon (901 frames / 842 labels) and PassiveIcon (915 / 513), and the game
// does the equivalent of gotoAndStop("<Name>"). swf-render ignores tag 43, so the labels are
// parsed here directly. `unknown` -> frame 0 is the game's own fallback.
//
// This mapping is the GAME'S, and it supersedes the wiki's scraped ids (CLAUDE.md: "Some
// ability icon IDs may be wrong — sourced from class page scraping"). Cross-checked against
// data/icons.js: the label frame equals (wiki id - 1) for 660 abilities and disagrees on 17,
// and spot-rendering shows the LABEL is right in those 17 (e.g. Melee Attack is frame 1, not
// the wiki's 11). The (id-1) relationship also re-confirms the project-wide 1-indexed Flash
// convention (a value V renders frames[V-1]) — but we use labels, so no ff() is needed here:
// a FrameLabel's counted value IS the 0-indexed frames[] position.
//
// SIZE: only the CORPUS UNION of abilities real cats carry is rendered (~561 of 829), which
// is ~3.7 MB — the same order as parts.js, so ability-icons.js is LAZY-loaded by the page,
// never eager (same treatment as items.js).
//
// Usage: node tools/export-ability-icons.js   (needs data/game/ability_icons.swf + GPAK)
// Writes: public/kittenshare/ability-icons.js  (ABILITY_INFO + ABILITY_ART)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { parseSwf, renderChar } = require('./swf-render.js');

const SWF = process.env.ABILITY_SWF || 'data/game/ability_icons.swf';
const GPAK = process.env.GPAK || 'Z:/SteamLibrary/steamapps/common/Mewgenics/resources.gpak';
const OUT = 'public/kittenshare/ability-icons.js';
const CORPUS = process.env.CORPUS || '';   // optional JSON array of ids to limit the art

// ---- FrameLabel parsing (tag 43) — swf-render drops these, so read the raw tags ----
function frameLabels(file, spriteId) {
  const buf = fs.readFileSync(file);
  const u16 = o => buf.readUInt16LE(o);
  let pos = 8;
  { const nbits = (buf[8] >> 3) & 0x1f; pos = 8 + Math.ceil((5 + nbits * 4) / 8) + 4; }
  let target = null;
  while (pos < buf.length) {
    const cal = u16(pos); const code = cal >> 6; let len = cal & 0x3f; let hdr = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(pos + 2); hdr = 6; }
    const body = pos + hdr;
    if (code === 39 && u16(body) === spriteId) { target = { body, len }; break; }
    if (code === 0) break;
    pos = body + len;
  }
  if (!target) return {};
  const out = {};
  let sp = target.body + 4, frame = 0;
  while (sp < target.body + target.len) {
    const cal = u16(sp); const c = cal >> 6; let l = cal & 0x3f; let h = 2;
    if (l === 0x3f) { l = buf.readUInt32LE(sp + 2); h = 6; }
    const b2 = sp + h;
    // A FrameLabel precedes its frame's ShowFrame, so the running count IS the 0-indexed
    // frames[] position of the frame it names.
    if (c === 1) frame++;
    else if (c === 43) { let s = '', o = b2; while (buf[o] !== 0) { s += String.fromCharCode(buf[o]); o++; } out[s] = frame; }
    else if (c === 0) break;
    sp = b2 + l;
  }
  return out;
}

// ---- gpak ----
function openGpak(file) {
  const fd = fs.openSync(file, 'r');
  const rd = (o, n) => { const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, o); return b; };
  let off = 0; const count = rd(0, 4).readUInt32LE(0); off = 4;
  const map = {}; const names = [];
  const ents = [];
  for (let i = 0; i < count; i++) {
    const nl = rd(off, 2).readUInt16LE(0); off += 2;
    const nm = rd(off, nl).toString('latin1'); off += nl;
    const sz = rd(off, 4).readUInt32LE(0); off += 4;
    ents.push({ nm, sz });
  }
  let data = off;
  for (const e of ents) { map[e.nm] = { off: data, size: e.sz }; names.push(e.nm); data += e.sz; }
  return { names, read: n => { const m = map[n]; return m ? rd(m.off, m.size).toString('utf8') : ''; } };
}

// ---- gon blocks (brace-matched, comment-stripped — same discipline as export-item-vocab) ----
function parseBlocks(t) {
  t = t.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  const re = /^[ \t]*(\w+)\s*\{/gm; let m;
  while ((m = re.exec(t))) {
    const key = m[1];
    let depth = 1, i = re.lastIndex;
    while (i < t.length && depth > 0) { const ch = t[i]; if (ch === '{') depth++; else if (ch === '}') depth--; i++; }
    out[key] = t.slice(re.lastIndex, i - 1);
    re.lastIndex = i;
  }
  return out;
}

if (!fs.existsSync(SWF)) { console.error('missing', SWF); process.exit(1); }
const swf = parseSwf(SWF);
const AB_ID = swf.symbols['AbilityIcon'], PA_ID = swf.symbols['PassiveIcon'];
const LABELS = { A: frameLabels(SWF, AB_ID), P: frameLabels(SWF, PA_ID) };
console.log('FrameLabels — AbilityIcon:', Object.keys(LABELS.A).length, '| PassiveIcon:', Object.keys(LABELS.P).length);

const g = openGpak(GPAK);
// text keys -> EN string. combined.csv is `KEY,English,...`; English is the 2nd column and is
// quoted when it contains a comma ("Heal some HP, then fall asleep."). Both _NAME and _DESC
// are collected — descriptions keep the game's own [img:token] markup, which the card renders.
const EN = {};
for (const line of (g.read('data/text/combined.csv') || '').split(/\r?\n/)) {
  const c = line.indexOf(','); if (c < 1) continue;
  const k = line.slice(0, c); if (!/_(NAME|DESC)$/.test(k)) continue;
  let rest = line.slice(c + 1), en;
  if (rest[0] === '"') { const e = rest.indexOf('"', 1); en = rest.slice(1, e); }
  else { const e = rest.indexOf(','); en = e === -1 ? rest : rest.slice(0, e); }
  if (en) EN[k] = en;
}

// id -> raw fields (variant_of resolved after the first pass)
const raw = {};
for (const f of g.names.filter(n => /^data\/abilities\/.*\.gon$/i.test(n))) {
  const blocks = parseBlocks(g.read(f) || '');
  for (const key of Object.keys(blocks)) {
    const b = blocks[key];
    // mana lives in a NESTED `cost { mana N ... }` block, so match it inside that block only
    // — a bare /mana\s+(\d+)/ would also catch mana_regen or a status effect elsewhere.
    const costBlock = (b.match(/\bcost\s*\{([\s\S]*?)\}/) || [])[1] || '';
    const mana = (costBlock.match(/^\s*mana\s+(-?\d+)\s*$/m) || [])[1];
    raw[key] = {
      nameKey:  (b.match(/name\s+"([^"]+)"/) || [])[1],
      descKey:  (b.match(/desc\s+"([^"]+)"/) || [])[1],
      icon:     (b.match(/ability_icon\s+(\w+)/) || [])[1],
      template: (b.match(/^\s*template\s+(\w+)/m) || [])[1],
      variant:  (b.match(/variant_of\s+(\w+)/) || [])[1],
      mana:     mana === undefined ? undefined : +mana,
    };
  }
}
// Resolve inheritance: a variant keeps only its overrides, so walk up for the rest.
function resolve(id, field, seen) {
  seen = seen || new Set();
  const r = raw[id];
  if (!r || seen.has(id)) return undefined;
  if (r[field] != null) return r[field];
  seen.add(id);
  return r.variant ? resolve(r.variant, field, seen) : undefined;
}

const info = {};
for (const id of Object.keys(raw)) {
  const nameKey = resolve(id, 'nameKey');
  const tmpl = resolve(id, 'template');
  const kind = tmpl === 'passive' ? 'P' : 'A';
  const iconName = resolve(id, 'icon') || id;
  let frame = LABELS[kind][iconName];
  // Fall back to the other sprite, then to the id itself, before giving up: some abilities
  // are labelled only in the sheet their template does not imply.
  let usedKind = kind;
  if (frame === undefined) { const o = kind === 'A' ? 'P' : 'A'; if (LABELS[o][iconName] !== undefined) { frame = LABELS[o][iconName]; usedKind = o; } }
  if (frame === undefined && LABELS[kind][id] !== undefined) frame = LABELS[kind][id];
  const descKey = resolve(id, 'descKey');
  const rec = { n: (nameKey && EN[nameKey]) || id };
  const d = descKey && EN[descKey];
  if (d) rec.d = d;                        // keeps the game's [img:token] markup
  // mana cost — 0 is MEANINGFUL (a free ability), so only an absent field is omitted.
  const mana = resolve(id, 'mana');
  if (mana !== undefined) rec.m = mana;
  if (frame !== undefined) { rec.k = usedKind; rec.f = frame; }
  info[id] = rec;
}
console.log('abilities in gons:', Object.keys(info).length, '| with icon art:', Object.values(info).filter(x => x.f !== undefined).length);

// ---- render art for the corpus union (or everything referenced, if no corpus given) ----
let wanted = Object.keys(info);
if (CORPUS && fs.existsSync(CORPUS)) {
  const ids = JSON.parse(fs.readFileSync(CORPUS, 'utf8'));
  wanted = ids.filter(id => info[id]);
  console.log('corpus union:', ids.length, 'ids ->', wanted.length, 'known');
}
const art = {};
let bytes = 0;
for (const id of wanted) {
  const r = info[id];
  if (r.f === undefined) continue;
  const key = r.k + r.f;
  if (art[key]) continue;
  const sid = r.k === 'A' ? AB_ID : PA_ID;
  const defs = [];
  const body = renderChar(swf, sid, r.f, defs, 0);
  if (!/<path/.test(body)) continue;   // blank frame — leave it out, the card falls back to text
  art[key] = { defs: defs.join(''), body: body };
  bytes += body.length;
}
console.log('rendered art frames:', Object.keys(art).length, '(' + (bytes / 1048576).toFixed(1) + ' MB of geometry)');

// Unlike the FontIcon glyphs (each at its own arbitrary offset), these are a UNIFORM icon
// sheet: getBBox across a sample spans only x[-2.4,66.0] y[-1.4,59.5], so ONE shared viewBox
// fits every frame and no per-icon measurement is needed. Padded slightly.
const ABILITY_VIEWBOX = '-3 -2 71 64';

const js = '// AUTO-GENERATED by tools/export-ability-icons.js — do not edit.\n' +
  '// ABILITY_INFO: ability id -> { n: display name, d: description, k: "A"|"P" sheet, f: frame }.\n' +
  '// ABILITY_ART:  "<k><f>" -> { defs, body } — the game\'s real icon art.\n' +
  '// ABILITY_VIEWBOX: one shared box — the icons are a uniform sheet (measured via getBBox).\n' +
  '// Frames come from the SWF\'s FrameLabels (the game\'s own gotoAndStop targets), NOT the\n' +
  '// wiki\'s scraped ids, which are wrong for at least 17 abilities. Art is multi-colour, so\n' +
  '// fills are left intact (unlike the mono FontIcon glyphs in ui-icons.js).\n' +
  '// LAZY-loaded (~3.7 MB) — never add this to a <script> tag.\n' +
  'const ABILITY_VIEWBOX = ' + JSON.stringify(ABILITY_VIEWBOX) + ';\n' +
  'const ABILITY_INFO = ' + JSON.stringify(info) + ';\n' +
  'const ABILITY_ART = ' + JSON.stringify(art) + ';\n' +
  'if (typeof module !== "undefined" && module.exports) {\n' +
  '  module.exports = { ABILITY_INFO: ABILITY_INFO, ABILITY_ART: ABILITY_ART, ABILITY_VIEWBOX: ABILITY_VIEWBOX };\n' +
  '  if (typeof global !== "undefined") { global.ABILITY_INFO = ABILITY_INFO; global.ABILITY_ART = ABILITY_ART; global.ABILITY_VIEWBOX = ABILITY_VIEWBOX; }\n' +
  '}\n';
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, js);
console.log('wrote', OUT, (js.length / 1048576).toFixed(2) + ' MB');

// ALSO write the vocab ALONE (names/descriptions/mana, no art) as a small companion. The
// standalone share card needs ability DETAILS but must not download the ~6.6 MB of icon art to
// get them — a shared link is meant to be light. This is ABILITY_INFO only (~240 KB); the icon
// art in ability-icons.js stays lazy on top. ABILITY_VIEWBOX rides along so a page that loads
// only the vocab still has a valid box for whatever icons DO later resolve.
const INFO_OUT = 'public/kittenshare/ability-info.js';
const infoJs = '// AUTO-GENERATED by tools/export-ability-icons.js — do not edit.\n' +
  '// ABILITY_INFO only (id -> { n, d, k, f[, m] }) — the small vocab for ability names,\n' +
  '// descriptions, and mana. NO icon art (that is the ~6.6 MB ability-icons.js, loaded lazily\n' +
  '// on top). Loaded on BOTH the browse view and the standalone share card so a shared link\n' +
  '// shows real ability details (~240 KB) without the icon-art download.\n' +
  'const ABILITY_VIEWBOX = ' + JSON.stringify(ABILITY_VIEWBOX) + ';\n' +
  'const ABILITY_INFO = ' + JSON.stringify(info) + ';\n' +
  'if (typeof module !== "undefined" && module.exports) {\n' +
  '  module.exports = { ABILITY_INFO: ABILITY_INFO, ABILITY_VIEWBOX: ABILITY_VIEWBOX };\n' +
  '  if (typeof global !== "undefined") { global.ABILITY_INFO = ABILITY_INFO; global.ABILITY_VIEWBOX = ABILITY_VIEWBOX; }\n' +
  '}\n';
fs.writeFileSync(INFO_OUT, infoJs);
console.log('wrote', INFO_OUT, (infoJs.length / 1024).toFixed(0) + ' KB (vocab only)');

// PER-FRAME icon files so the standalone share card loads ONLY the ~8 icons its cat's abilities
// use (~70 KB), not the 6.6 MB monolith. The filename IS the ABILITY_INFO key (k+f, e.g. "A9"),
// so the card derives the URL directly from each ability's {k,f} — no manifest needed; a missing
// file just means no icon for that ability. Full-colour art, never tinted.
const ICON_DIR = 'public/kittenshare/ability-icons';
fs.mkdirSync(ICON_DIR, { recursive: true });
let iconBytes = 0;
for (const key of Object.keys(art)) {
  const j = JSON.stringify(art[key]);
  fs.writeFileSync(path.join(ICON_DIR, key + '.json'), j);
  iconBytes += j.length;
}
console.log('wrote', ICON_DIR + '/', Object.keys(art).length, 'per-frame icons,',
  (iconBytes / 1048576).toFixed(1) + ' MB total (a cat loads ~8)');
