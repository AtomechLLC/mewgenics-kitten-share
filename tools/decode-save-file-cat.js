#!/usr/bin/env node
// decode-save-file-cat.js — field-order oracle for the compact cat blob.
//
// files.save_file_cat is the save-select poster cat: a *self-describing*,
// u64-length-prefixed record (unlike the bit-packed cats.data blob). Decoding it
// tells us WHAT fields a cat carries and in WHAT ORDER, so we know what to look
// for (and roughly where) when locating the same fields in the compact blob.
//
// Verified layout (build 5090):
//   u32 marker(=19), u64? uid(8), u64 nameLen, UTF-16LE name,
//   ...struct..., gender ascii ("male6"), a 4-byte-aligned run of u32 appearance
//   -gene frame indices (values in the catparts.swf frame range ~1000-2700),
//   ...doubles/level..., u64-length-prefixed ascii ability/class strings,
//   0xFF..FF (-1) sentinels.
//
// Usage:
//   node tools/decode-save-file-cat.js <file.sav>        # read files.save_file_cat
//   node tools/decode-save-file-cat.js <blob.bin> [...]  # decode raw blob(s)
//
// A .bin may be EITHER a self-describing save_file_cat (u32@0 == 19) or a compact
// cats.data blob (u32@0 == header ~930-940); the tool detects which and decodes
// accordingly, so `decode-save-file-cat.js tools/fixtures/*.bin` handles a mix.
//
// Untrusted-input hygiene: every read is bounded vs buffer length and wrapped.

const fs = require('fs');
const path = require('path');

const SELF_MARKER = 19;          // u32@0 of a self-describing save_file_cat
const FRAME_MIN = 1000, FRAME_MAX = 2700; // catparts.swf master frame-index range

// ---- compact cats.data name decode (varint) ----
// Header: u32 hdr, u32 build(=5090), 00, uid(8), u16 charLen, 01, 00,
//         name varint (tag low5==0x12), UTF-16LE chars (final char high byte dropped).
function decodeCompactName(b) {
  if (b.length < 24) return null;
  const L = b.readUInt16LE(17);
  if (L < 1 || L > 64) return null;
  if ((b[21] & 0x1f) !== 0x12) return null;
  for (const start of [22, 23]) {          // 1-byte vs 2-byte varint
    const need = 2 * L - 1;
    if (start + need > b.length) continue;
    const bytes = Buffer.concat([b.slice(start, start + need), Buffer.from([0])]);
    let s = '', ok = true;
    for (let i = 0; i < L; i++) {
      const code = bytes.readUInt16LE(i * 2);
      if (code === 0) { ok = false; break; }
      s += String.fromCharCode(code);
    }
    if (ok && s.length === L) return s;
  }
  return null;
}

// ---- u64-length-prefixed ascii strings anywhere in the record ----
function scanStrings(b, from) {
  const out = [];
  for (let i = from; i + 8 <= b.length; i++) {
    const lo = b.readUInt32LE(i), hi = b.readUInt32LE(i + 4);
    if (hi === 0 && lo > 0 && lo < 40 && i + 8 + lo <= b.length) {
      const s = b.slice(i + 8, i + 8 + lo);
      if (s.every(c => c >= 32 && c < 127)) out.push({ off: i, len: lo, str: s.toString('latin1') });
    }
  }
  return out;
}

// ---- 4-byte-aligned run of u32 frame indices in the gene range ----
function findGeneRun(b, from) {
  let best = null;
  for (let base = from; base < b.length - 4; base++) {
    if (base % 4 !== from % 4) { /* still try every start */ }
    const run = [];
    let i = base;
    while (i + 4 <= b.length) {
      const v = b.readUInt32LE(i);
      if (v >= FRAME_MIN && v <= FRAME_MAX) { run.push({ off: i, v }); i += 4; }
      else break;
    }
    if (run.length >= 3 && (!best || run.length > best.length)) best = run;
  }
  return best || [];
}

// ---- near-integer doubles in a plausible stat/level range ----
// The near-integer + range filter is strict enough to reject the denormal
// garbage that misaligned 8-byte reads produce, so we scan every offset.
function findStatDoubles(b, from) {
  const out = [];
  for (let i = from; i + 8 <= b.length; i++) {
    const d = b.readDoubleLE(i);
    if (Number.isFinite(d) && d >= 1 && d <= 999 && Math.abs(d - Math.round(d)) < 1e-9) {
      out.push({ off: i, v: Math.round(d) });
    }
  }
  return out;
}

function decodeSelfDescribing(b) {
  console.log('  format: self-describing save_file_cat');
  console.log('  marker u32@0 =', b.readUInt32LE(0));
  console.log('  uid =', b.slice(4, 12).toString('hex'));
  const nameLen = b.readUInt32LE(12);              // u64 low word
  console.log('  nameLen =', nameLen);
  let p = 20;
  let name = '';
  if (nameLen > 0 && nameLen < 128 && p + nameLen * 2 <= b.length) {
    name = b.slice(p, p + nameLen * 2).toString('utf16le');
    p += nameLen * 2;
  }
  console.log('  name =', JSON.stringify(name));

  const genes = findGeneRun(b, p);
  console.log('  candidate appearance-gene frame indices (u32 run):',
    genes.length ? genes.map(g => g.v).join(', ') + `  (@${genes[0].off})` : '(none found)');

  const stats = findStatDoubles(b, p);
  console.log('  candidate stat/level doubles:',
    stats.length ? stats.map(s => `${s.v}@${s.off}`).join(', ') : '(none found)');

  const strs = scanStrings(b, p);
  const uniq = [...new Set(strs.map(s => s.str))];
  console.log('  ascii fields (class/gender/abilities):', uniq.join(' | '));
  return { name, genes: genes.map(g => g.v), stats: stats.map(s => s.v), strings: uniq };
}

function decodeCompactBlob(b) {
  console.log('  format: compact cats.data blob');
  console.log('  header u32@0 =', b.readUInt32LE(0));
  console.log('  build u32@4 =', b.readUInt32LE(4));
  console.log('  uid =', b.slice(9, 17).toString('hex'));
  const name = decodeCompactName(b);
  console.log('  name =', JSON.stringify(name));
  console.log('  (appearance genes/stats are bit-packed here — see decode-genes-proof.js)');
  return { name };
}

function decodeFile(fp) {
  console.log(`\n${fp}`);
  let b;
  try {
    b = fs.readFileSync(fp);
  } catch (e) {
    console.error('  cannot read:', e.message);
    return;
  }
  if (b.length < 20) { console.error('  too short to be a cat record'); return; }
  try {
    if (b.readUInt32LE(0) === SELF_MARKER) decodeSelfDescribing(b);
    else decodeCompactBlob(b);
  } catch (e) {
    console.error('  decode error:', e.message);
  }
}

async function decodeSav(fp) {
  const initSqlJs = require('../public/vendor/sql-wasm.js');
  const VENDOR = path.join(__dirname, '..', 'public', 'vendor');
  const SQL = await initSqlJs({ locateFile: f => path.join(VENDOR, f) });
  let db;
  try {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(fp)));
  } catch (e) {
    console.error('not a readable SQLite .sav:', fp, '-', e.message);
    process.exit(2);
  }
  const res = db.exec("SELECT data FROM files WHERE key='save_file_cat'");
  if (!res.length) { console.error('no save_file_cat in', fp); db.close(); process.exit(2); }
  const b = Buffer.from(res[0].values[0][0]);
  db.close();
  console.log(`\n${fp} (files.save_file_cat)`);
  decodeSelfDescribing(b);
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node tools/decode-save-file-cat.js <file.sav | blob.bin ...>');
    process.exit(2);
  }
  for (const a of args) {
    if (/\.sav$/i.test(a)) await decodeSav(a);
    else decodeFile(a);
  }
}

main().catch(e => { console.error('error:', e.message); process.exit(2); });
