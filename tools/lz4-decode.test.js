#!/usr/bin/env node
// lz4-decode.test.js — proves the vendored pure-JS LZ4 decompressor turns real
// compressed cat blobs into their declared u32@0 size, and (given a save path)
// runs a full-corpus census of how many cats decode real stats + symmetric
// appearance. Zero dependencies beyond the repo's vendored sql-wasm.js.
//
// Usage:
//   node tools/lz4-decode.test.js                 # always-run fixture asserts
//   node tools/lz4-decode.test.js <save.sav>      # + full-corpus census
//
// The GO rationale rests on the CORPUS numbers this prints (not the 2 tiny
// fixtures). Copy a READ-ONLY save into a gitignored scratch path first; never
// pass the live save directly and never commit a .sav.

const fs = require('fs');
const path = require('path');
const LZ4 = require('../public/vendor/lz4.js');

const FIX = path.join(__dirname, 'fixtures');
function bin(name) { return new Uint8Array(fs.readFileSync(path.join(FIX, name))); }

let failures = 0;
function check(desc, cond) {
  if (cond) { console.log('  ok   - ' + desc); }
  else { failures++; console.error('  FAIL - ' + desc); }
}

// ---- (a) always-run committed-fixture asserts ----
console.log('LZ4 fixture decompression:');
const garik = LZ4.decompressCatBlob(bin('garik.bin'));
const churrito = LZ4.decompressCatBlob(bin('churrito.bin'));

if (garik) console.log('  garik.bin 410B -> ' + garik.data.length + 'B ' + (garik.data.length === 934 ? 'MATCH' : 'MISMATCH'));
else console.log('  garik.bin -> decompress returned null');
if (churrito) console.log('  churrito.bin 455B -> ' + churrito.data.length + 'B ' + (churrito.data.length === 941 ? 'MATCH' : 'MISMATCH'));
else console.log('  churrito.bin -> decompress returned null');

check('garik.bin decompresses to declared size 934', !!garik && garik.data.length === 934);
check('churrito.bin decompresses to declared size 941', !!churrito && churrito.data.length === 941);
check('garik.bin variant A (word4=5090 build)', !!garik && garik.variant === 'A' && garik.build === 5090);

// ---- census decode helpers (inlined jv/Cp/RO/Wv, same logic as save-decode.js) ----
const Fe = (e, t) => (e[t] | (e[t + 1] << 8) | (e[t + 2] << 16) | (e[t + 3] << 24 >>> 0)) >>> 0;
const GA = (e, t) => new DataView(e.buffer, e.byteOffset, e.byteLength).getFloat32(t, true);
const SLOTS = { 1: 'Body', 2: 'Head', 3: 'Tail', 4: 'RearLeg_L', 5: 'RearLeg_R', 6: 'FrontLeg_L', 7: 'FrontLeg_R', 8: 'Eye_L', 9: 'Eye_R', 10: 'Brow_L', 11: 'Brow_R', 12: 'Ear_L', 13: 'Ear_R', 14: 'Mouth' };

function Cp(e, t) {
  const n = t + 84; if (n + 13 > e.length) return false;
  const r = Fe(e, n); if (Fe(e, n + 4) !== 0 || r === 0 || r > 64) return false;
  const s = n + 8; if (s + r + 4 > e.length) return false;
  for (let i = 0; i < r; i++) { const a = e[s + i]; if (a < 32 || a >= 127) return false; }
  return true;
}
function jv(e, t = 460, n = 320) {
  const r = e.length; if (r < 28) return null;
  const o = new DataView(e.buffer, e.byteOffset, e.byteLength);
  const cands = []; const lo = Math.max(0, t - n), hi = Math.min(r - 28, t + n);
  for (let u = lo; u <= hi; u++) {
    let ok = true; const p = [];
    for (let w = 0; w < 7; w++) { const S = o.getInt32(u + w * 4, true); if (S < 1 || S > 10) { ok = false; break; } p.push(S); }
    if (!ok) continue; const h = Math.abs(u - t), g = p.reduce((x, y) => x + y, 0);
    cands.push({ off: u, vals: p, score: 1000 - h + g * 0.1 });
  }
  if (!cands.length) return null; cands.sort((a, b) => b.score - a.score);
  let l = cands[0]; if (!Cp(e, l.off)) { const v = cands.find(c => Cp(e, c.off)); if (v) l = v; }
  return { str: l.vals[0], dex: l.vals[1], con: l.vals[2], int: l.vals[3], spd: l.vals[4], cha: l.vals[5], lck: l.vals[6] };
}
function RO(e) {
  const t = e.length; const Rp = 296; if (t < Rp) return null;
  let best = -1, base = null;
  for (let o = 0; o <= t - Rp; o++) {
    const s = GA(e, o), i = Fe(e, o + 4), a = Fe(e, o + 8), l = Fe(e, o + 12);
    // 01-06 locator fix: finite scale (NaN no longer passes) + >=3 part records whose
    // 2nd u32 == the pattern value (not the zero-region count). Colorless cats locate.
    if (!(Number.isFinite(s) && s >= 0.05 && s <= 20) || i === 0 || i > 2e4 || a > 500 || (l !== 4294967295 && l > 5000)) continue;
    let c = 0; for (let f = 0; f < 14; f++) { const p = o + 16 + f * 20, h = Fe(e, p + 4); if (h === i) c++; }
    if (c < 3) continue;
    const score = c * 1000 + o; if (score > best) { best = score; base = o; }
  }
  return base;
}
function Wv(e) {
  const t = RO(e); if (t === null) return null;
  const pattern = Fe(e, t + 4), coatPalette = Fe(e, t + 8), slots = {};
  for (let s = 0; s < 14; s++) slots[SLOTS[s + 1]] = Fe(e, t + 16 + s * 20);
  return { pattern, coatPalette, slots };
}
function symmetric(slots) {
  return slots.Eye_L === slots.Eye_R && slots.Ear_L === slots.Ear_R && slots.Brow_L === slots.Brow_R;
}

// ---- (b) full-corpus census when a save path is passed ----
const savePath = process.argv[2];
if (savePath) {
  const initSqlJs = require('../public/vendor/sql-wasm.js');
  const VENDOR = path.join(__dirname, '..', 'public', 'vendor');
  (async () => {
    const SQL = await initSqlJs({ locateFile: f => path.join(VENDOR, f) });
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(savePath)));
    const res = db.exec('SELECT data FROM cats');
    const rows = res && res[0] ? res[0].values : [];
    let total = 0, decompOk = 0, statsOk = 0, appOk = 0;
    for (const [d] of rows) {
      total++;
      try {
        const blob = new Uint8Array(d);
        const want = Fe(blob, 0);
        const r = LZ4.decompressCatBlob(blob);
        if (!r || r.data.length !== want) continue;
        decompOk++;
        const e = r.data;
        if (jv(e)) statsOk++;
        const ap = Wv(e);
        if (ap && symmetric(ap.slots)) appOk++;
      } catch (_) { /* one bad row can't abort the census */ }
    }
    db.close();
    const pct = (a, b) => b ? (a / b * 100).toFixed(1) : '0.0';
    console.log('\nFull-corpus census (' + path.basename(savePath) + '):');
    console.log('  decompressed OK ' + decompOk + '/' + total + ' (' + pct(decompOk, total) + '%)');
    console.log('  stats-decoded ' + pct(statsOk, total) + '% (' + statsOk + '/' + total + ')');
    console.log('  appearance+symmetry ' + pct(appOk, total) + '% (' + appOk + '/' + total + ')');
    if (failures) { console.error('\n' + failures + ' fixture check(s) failed.'); process.exit(1); }
    if (decompOk !== total) { console.error('\nNot every blob decompressed to its declared size.'); process.exit(1); }
    console.log('\nAll LZ4 decode checks passed.');
  })().catch(e => { console.error('CENSUS FATAL', e.stack); process.exit(1); });
} else {
  if (failures) { console.error('\n' + failures + ' fixture check(s) failed.'); process.exit(1); }
  console.log('\nAll LZ4 fixture checks passed. (pass a save path for the full-corpus census)');
}
