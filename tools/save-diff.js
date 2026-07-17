#!/usr/bin/env node
// save-diff.js — isolate the single changed cat blob between two adjacent saves.
//
// Cats are only re-serialized when they change, and each cat carries a stable
// 8-byte uid at blob offset 9 that is identical across saves. So keying every
// cat by that uid and diffing only the blobs that differ isolates a controlled
// single in-game change to (ideally) one cat with an almost noise-free byte diff.
// This is the primary attack for locating appearance-gene / stat fields.
//
// Usage:
//   node tools/save-diff.js A.sav B.sav        # diff two saves
//   node tools/save-diff.js --self-test X.sav  # diff a save against itself
//                                              # (must report zero changes, exit 0)
//
// Reads .sav SQLite via the already-vendored sql.js (no new dependency), the
// same WASM the browser page uses. Treats the .sav as untrusted: every buffer
// read is bounded, the SQLite open is wrapped, and output is capped.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('../public/vendor/sql-wasm.js');
const VENDOR = path.join(__dirname, '..', 'public', 'vendor');

const UID_OFF = 9;   // 8-byte per-cat identity key lives at offset 9
const UID_LEN = 8;
const MAX_DIFF_OFFSETS = 256; // cap noisy output on untrusted / non-minimal diffs

// Load every cat blob from a .sav, keyed by its uid (hex). Bounded + guarded.
async function loadCats(SQL, savPath) {
  let bytes;
  try {
    bytes = fs.readFileSync(savPath);
  } catch (e) {
    console.error('cannot read file:', savPath, '-', e.message);
    process.exit(2);
  }
  let db;
  try {
    db = new SQL.Database(new Uint8Array(bytes));
  } catch (e) {
    console.error('not a readable SQLite .sav:', savPath, '-', e.message);
    process.exit(2);
  }
  const out = new Map();
  try {
    const res = db.exec('SELECT key, data FROM cats');
    if (res.length) {
      for (const [, data] of res[0].values) {
        const b = Buffer.from(data);
        if (b.length < UID_OFF + UID_LEN) continue; // too short to key — skip
        // identity key = the 8-byte uid at offset 9, i.e. b.slice(9, 17)
        const uid = b.slice(UID_OFF, UID_OFF + UID_LEN).toString('hex');
        out.set(uid, b);
      }
    }
  } catch (e) {
    console.error('no readable cats table in', savPath, '-', e.message);
    db.close();
    process.exit(2);
  }
  db.close();
  return out;
}

// Differing byte offsets between two equal-length buffers (bounded).
function byteDiffs(a, b) {
  const n = Math.min(a.length, b.length);
  const diffs = [];
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      diffs.push(i);
      if (diffs.length >= MAX_DIFF_OFFSETS) break;
    }
  }
  return diffs;
}

// Per-byte bit-level view of a changed byte (which bits toggled).
function bitToggle(x, y) {
  const t = (x ^ y) & 0xff;
  return t.toString(2).padStart(8, '0');
}

async function main() {
  const argv = process.argv.slice(2);
  const selfTest = argv[0] === '--self-test';
  const paths = selfTest ? [argv[1], argv[1]] : argv;
  if (paths.length !== 2 || !paths[0] || !paths[1]) {
    console.error('usage: node tools/save-diff.js A.sav B.sav');
    console.error('       node tools/save-diff.js --self-test X.sav');
    process.exit(2);
  }

  const SQL = await initSqlJs({ locateFile: f => path.join(VENDOR, f) });
  const A = await loadCats(SQL, paths[0]);
  const B = await loadCats(SQL, paths[1]);

  const common = [...A.keys()].filter(uid => B.has(uid));
  const onlyA = [...A.keys()].filter(uid => !B.has(uid));
  const onlyB = [...B.keys()].filter(uid => !A.has(uid));

  const changed = [];
  for (const uid of common) {
    const a = A.get(uid), b = B.get(uid);
    if (a.length !== b.length || !a.equals(b)) changed.push(uid);
  }

  if (selfTest) {
    const bad = changed.length + onlyA.length + onlyB.length;
    console.log(`[self-test] ${paths[0]}`);
    console.log(`[self-test] cats=${A.size} changed=${changed.length} onlyA=${onlyA.length} onlyB=${onlyB.length}`);
    if (bad === 0) {
      console.log('[self-test] PASS — zero changed uids');
      process.exit(0);
    }
    console.error('[self-test] FAIL — a save diffed against itself is not identical');
    process.exit(1);
  }

  console.log(`A cats=${A.size}  B cats=${B.size}  common=${common.length}  changed=${changed.length}  onlyA=${onlyA.length}  onlyB=${onlyB.length}`);
  if (onlyA.length) console.log('only in A (uids):', onlyA.slice(0, 20).join(' '));
  if (onlyB.length) console.log('only in B (uids):', onlyB.slice(0, 20).join(' '));

  for (const uid of changed) {
    const a = A.get(uid), b = B.get(uid);
    if (a.length !== b.length) {
      console.log(`\nuid ${uid}: length changed ${a.length} -> ${b.length}`);
      continue;
    }
    const diffs = byteDiffs(a, b);
    console.log(`\nuid ${uid}: len ${a.length}, ${diffs.length} byte(s) differ`);
    console.log('  offsets:', diffs.join(' ') + (diffs.length >= MAX_DIFF_OFFSETS ? ' …(capped)' : ''));
    for (const off of diffs.slice(0, 32)) {
      console.log(`  @${off}: ${a[off].toString(16).padStart(2, '0')} -> ${b[off].toString(16).padStart(2, '0')}  bits ${bitToggle(a[off], b[off])}`);
    }
  }
  if (changed.length === 0) console.log('\nno changed cats.');
}

main().catch(e => { console.error('error:', e.message); process.exit(2); });
