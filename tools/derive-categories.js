#!/usr/bin/env node
// Derive a best-guess category (Offense / Defense / Other / Special) for every
// ability, straight from the game's packed data, and emit:
//   1. data/categories.js                 (source-of-truth map)
//   2. the inline map inside public/abilities.html, between the
//      @@CATEGORY_MAP_BEGIN / @@CATEGORY_MAP_END markers
//
// The game has no explicit category field, so we infer it from each ability's
// template + damage + status effects. The four categories match the in-game
// spellbook slot symbols (sword / shield / arrow / star).
//
// Usage:  node tools/derive-categories.js
// Env:    GPAK=<path to resources.gpak>   (defaults to the Steam install below)
//
// Requires Node 18+ (uses global fetch) and a local Mewgenics install.

const fs = require('fs');
const path = require('path');

const GPAK = process.env.GPAK ||
  'Z:/SteamLibrary/steamapps/common/Mewgenics/resources.gpak';
const API = 'https://mewgenics.wiki/api/v1/abilities.json';
const ROOT = path.resolve(__dirname, '..');

// ---- gpak reader ----
// Format: [u32 entryCount] then per entry [u16 nameLen][name][u32 size], then the
// file data blob (files concatenated in TOC order). Offsets = running sum of sizes.
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
    readBuf(name) { const m = offsets[name]; if (!m) return null; const b = Buffer.alloc(m.size); fs.readSync(fd, b, 0, m.size, m.off); return b; },
    read(name) { const b = this.readBuf(name); return b ? b.toString('utf8') : null; },
    close() { fs.closeSync(fd); },
  };
}

// ---- gon helpers ----
function topBlocks(txt) {
  const blocks = []; let i = 0; const n = txt.length;
  while (i < n) {
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*\{/g; m.lastIndex = i;
    const r = m.exec(txt); if (!r) break;
    const name = r[1]; let depth = 1, j = r.index + r[0].length; const start = j;
    for (; j < n && depth > 0; j++) { const c = txt[j]; if (c === '{') depth++; else if (c === '}') depth--; }
    blocks.push({ name, body: txt.slice(start, j - 1) }); i = j;
  }
  return blocks;
}

// ---- effect classification ----
const BUFF = new Set(['Shield','DivineShield','Brace','Charge','Regen','ManaRegen','Lifesteal','Thorns','BleedThorns','KineticSpikes','Reflect','Steeled','Flying','Haste','AllStatsUp','Block','Dodge','Heal','Champion','Regeneration','HealthRegen','Bless','Adoubment','Invisible','Stealth']);
const DEBUFF = new Set(['Bleed','Burn','Poison','Freeze','Frozen','Slow','Confusion','Fear','Leech','Sleep','Drowsy','Immobile','Stun','Webbed','Petrify','Charm','Blind','Silence','Bruise','Exhaustion','Shock','Rage','Frostbite','Attraction','Marked','SoulLink','Weakness','Rot','Doom','Knockback','AllStatsDown','Trample','Backstab','ChangeTile']);
const MOVE_EFFECT = /(temp)?(movement|teleport|reposition|blink)/i;
const isBuff = e => BUFF.has(e) || /(Up$|^Temp|Regen|Shield|Brace|Dodge|Crit|Bless|Heal|Steeled|Reflect|Thorns|Lifesteal|Charge|Haste|Counterspell|Penetrate|Invis|Stealth|Armor)/.test(e);
const isDebuff = e => DEBUFF.has(e) || /Down$/.test(e);
function classifyEffects(eff) { let buff = 0, deb = 0, move = 0; (eff || []).forEach(e => { if (MOVE_EFFECT.test(e)) move++; else if (isBuff(e)) buff++; else if (isDebuff(e)) deb++; }); return { buff, deb, move }; }

const MOVE_T = new Set(['move', 'teleport', 'swap', 'trample_dash']);
const ATTACK_T = /(attack|dash|trample)/i;
function dealsDamage(f) {
  if (f.damage == null) return false;
  const d = String(f.damage).trim();
  if (/^0(\b|$)/.test(d) && !/[A-Za-z]/.test(d)) return false;
  if (/^(none|null)$/i.test(d)) return false;
  return true;
}
function categorize(f) {
  const t = f.template || '';
  const { buff, deb, move } = classifyEffects(f.effects);
  const dmg = dealsDamage(f);
  if (MOVE_T.has(t)) return 'Other';
  if (t === 'spawn') return 'Other';
  if (move > 0 && !dmg && buff === 0 && deb === 0) return 'Other';
  if (/heal/i.test(t) || (f.heal && !/^0/.test(String(f.heal)))) return 'Defense';
  if (ATTACK_T.test(t) || t === 'melee_spell' || t === 'straightshot_attack') return 'Offense';
  if (dmg) return 'Offense';
  if (t === 'self_buff') return (move > 0 && buff === 0) ? 'Other' : 'Defense';
  if (buff > 0 && buff >= deb) return 'Defense';
  if (deb > 0) return 'Offense';
  if (move > 0) return 'Other';
  return 'Special';
}

// ---- parse all ability definitions ----
function parseAbilities(gpak) {
  const files = gpak.entries.filter(e => /^data\/abilities\/.*\.gon$/.test(e.name)).map(e => e.name);
  const raw = {};
  for (const f of files) {
    const txt = gpak.read(f); if (!txt) continue;
    for (const b of topBlocks(txt)) {
      const body = b.body, fld = {}; let m;
      if ((m = body.match(/\btemplate\s+([A-Za-z_]+)/))) fld.template = m[1];
      if ((m = body.match(/\bvariant_of\s+([A-Za-z0-9_]+)/))) fld.variant_of = m[1];
      if ((m = body.match(/\btarget_mode\s+([A-Za-z_]+)/))) fld.target_mode = m[1];
      const di = body.match(/damage_instance\s*\{([\s\S]*?)\n\s*\}/);
      if (di) { const dm = di[1].match(/\bdamage\s+([^\n]+)/); if (dm) fld.damage = dm[1].trim(); const h = di[1].match(/\bheal\w*\s+([^\n]+)/i); if (h) fld.heal = h[1].trim(); }
      const eff = body.match(/effects\s*\{([\s\S]*?)\}/);
      if (eff) fld.effects = [...new Set((eff[1].match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)/gm) || []).map(s => s.trim()))];
      raw[b.name] = fld;
    }
  }
  for (let pass = 0; pass < 3; pass++) for (const id in raw) { const f = raw[id]; const base = raw[f.variant_of]; if (base) for (const k of ['template','target_mode','damage','heal','effects']) if (f[k] == null && base[k] != null) f[k] = base[k]; }
  const cat = {};
  for (const id in raw) cat[id] = categorize(raw[id]);
  for (const id in raw) { const v = raw[id].variant_of; if (v && !cat[v] && cat[id]) cat[v] = cat[id]; }
  return cat;
}

(async function main() {
  if (!fs.existsSync(GPAK)) { console.error('resources.gpak not found at', GPAK, '\nSet GPAK=<path> to override.'); process.exit(1); }
  const gpak = openGpak(GPAK);
  const cat = parseAbilities(gpak);
  gpak.close();

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const api = (await (await fetch(API)).json()).records;
  const byId = {}, byName = {};
  for (const r of api) { const c = cat[r.id]; if (!c) continue; byId[r.id] = c; byName[norm((r.name && r.name.en) || r.id)] = c; }

  const cnt = {}; Object.values(byId).forEach(c => (cnt[c] = (cnt[c] || 0) + 1));
  console.log('coverage:', Object.keys(byId).length + '/' + api.length, '  counts:', JSON.stringify(cnt));

  // 1) data/categories.js
  const header =
`// Best-guess ability category per ability, DERIVED from the game's packed data
// (resources.gpak -> data/abilities/*.gon). The game has no explicit category
// field; this is inferred from each ability's template, damage, and effects.
// Four categories match the in-game spellbook symbols: Offense (sword),
// Defense (shield), Other (arrow/movement), Special (star).
// Counts: ${JSON.stringify(cnt)}. Coverage: ${Object.keys(byId).length}/${api.length}.
// Regenerate: node tools/derive-categories.js
`;
  const mapJs =
`const ABILITY_CATEGORY = ${JSON.stringify(byId)};\n` +
`const ABILITY_CATEGORY_BYNAME = ${JSON.stringify(byName)};\n`;
  fs.writeFileSync(path.join(ROOT, 'data/categories.js'), header + mapJs);
  console.log('wrote data/categories.js');

  // 1b) public/kittenshare/ability-categories.js — the by-ID map ALONE (~19 KB), for the
  // KittenShare card (eager-loaded on both browse + standalone share, to colour + symbol each
  // ability row like the wiki). The BYNAME map and the abilities.html inline map are the
  // wiki page's concern; the share card only needs id -> category.
  const ksJs =
`// AUTO-GENERATED from data/categories.js (node tools/derive-categories.js) — do not edit.
// ability id -> best-guess spellbook category (Offense/Defense/Other/Special).
const ABILITY_CATEGORY = ${JSON.stringify(byId)};
if (typeof module !== "undefined" && module.exports) { module.exports = { ABILITY_CATEGORY };
  if (typeof global !== "undefined") global.ABILITY_CATEGORY = ABILITY_CATEGORY; }
`;
  fs.writeFileSync(path.join(ROOT, 'public/kittenshare/ability-categories.js'), ksJs);
  console.log('wrote public/kittenshare/ability-categories.js');

  // 2) inline map in public/abilities.html (between markers)
  const htmlPath = path.join(ROOT, 'public/abilities.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const begin = '// @@CATEGORY_MAP_BEGIN', end = '// @@CATEGORY_MAP_END';
  const re = new RegExp(begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (re.test(html)) {
    html = html.replace(re, begin + ' (regenerate with tools/derive-categories.js)\n' + mapJs + end);
    fs.writeFileSync(htmlPath, html);
    console.log('updated inline map in public/abilities.html');
  } else {
    console.warn('markers not found in abilities.html — inline map left unchanged');
  }
})();
