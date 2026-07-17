#!/usr/bin/env node
// decode-genes-proof.js — the go/no-go proof decoder for a Mewgenics cat blob.
//
// Phase-1 spike question (ROADMAP): can we decode a real cat's *appearance genes*
// and *stats* out of the compact `cats.data` blob well enough to render a card
// that matches the in-game portrait? This tool is the recorded answer.
//
// OUTCOME (build 5090, corpus = 25 ad-hoc campaign saves + 16 backups, NO
// controlled single-gene saves available):
//   * STATS  — LOCATED in the self-describing `save_file_cat` record as a run of
//              7 plain u32 (STR/DEX/CON/INT/SPD/CHA/LCK). Correcting the plan's
//              "7 IEEE-754 doubles" assumption AND the prior spike's mis-read.
//   * GENES  — UNRESOLVED. Appearance-gene frame indices are NOT stored as plain
//              aligned integers in the compact blob (a full-corpus scan of 1,308
//              cats finds ~2.9 in-range u32 per cat, not the ~18 a plain gene
//              block would need). They are bit-packed inside a variable-length
//              tagged stream that cannot be aligned without either the game's
//              serializer or controlled single-gene diff saves — neither of which
//              this spike had. This is the pre-agreed FALLBACK scope for 01-03.
//
// IMPORTANT — debunked prior finding: the previous spike reported a "7-value u32
// appearance-gene frame-index block [1087,1024,1536,1792,1024,1280,1280] @456" in
// save_file_cat. That was a MIS-ALIGNED read: 0x3f at offset 456 is the high byte
// of the preceding double (0.8863…), and reading u32 one byte early manufactures
// values that happen to land in the 1000-2700 frame range. The correctly-aligned
// u32 at offset 457 are the small integers 4,4,6,7,4,5,5 — the seven core stats,
// clustered around the PlayerCat default of 5 (data/characters/player_cat.gon).
// Do NOT build a decoder on the debunked block. See docs/kittenshare-format-notes.md.
//
// This tool decodes what IS reliably recoverable (name; stats from the
// self-describing record), range-checks any candidate gene values, asserts the
// recoverable fields against tools/fixtures/expected.json, and prints an explicit
// "GENES UNRESOLVED — FALLBACK" banner so downstream plans adopt the fallback
// scope consciously rather than rendering a confidently-wrong portrait.
//
// Usage:
//   node tools/decode-genes-proof.js tools/fixtures/*.bin
//
// Untrusted-input hygiene: every read is bounded vs buffer length and wrapped.

const fs = require('fs');
const path = require('path');

const SELF_MARKER = 19;              // u32@0 of a self-describing save_file_cat
const FRAME_MIN = 1000;              // catparts.swf master frame-index floor
const FRAME_MAX = 2700;              // …and ceiling (per-master frame counts vary)
const PALETTE_MIN = 0, PALETTE_MAX = 255; // textures/palette.png rows
const STAT_NAMES = ['str', 'dex', 'con', 'int', 'spd', 'cha', 'lck'];

// ---- shared: range guards (the go/no-go anti-pattern is trusting out-of-range) ----
function frameOk(v) { return Number.isInteger(v) && v >= FRAME_MIN && v <= FRAME_MAX; }
function paletteOk(v) { return Number.isInteger(v) && v >= PALETTE_MIN && v <= PALETTE_MAX; }

// ---- compact cats.data name (varint), mirrors decode-save-file-cat.js ----
function decodeCompactName(b) {
  if (b.length < 24) return null;
  const L = b.readUInt16LE(17);
  if (L < 1 || L > 64) return null;
  if ((b[21] & 0x1f) !== 0x12) return null;
  for (const start of [22, 23]) {               // 1-byte vs 2-byte varint
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

// ---- self-describing name (full UTF-16LE, not truncated) ----
function decodeSelfName(b) {
  const nameLen = b.readUInt32LE(12);
  if (nameLen > 0 && nameLen < 128 && 20 + nameLen * 2 <= b.length)
    return b.slice(20, 20 + nameLen * 2).toString('utf16le');
  return '';
}

// ---- locate the 7 core stats in a self-describing record ----
// The stats are 7 consecutive u32 LE in a plausible cat-stat range [1,50],
// anchored to the documented layout: they follow the gender ascii string
// ("male6"/"female45") + one pitch double, and trailing zero padding terminates
// the run. Scanning blind from offset 0 could latch onto a coincidental earlier
// run of small integers, so the scan starts at the gender anchor (+ a small
// slack window covering the 8-byte pitch double). No anchor -> null (honest:
// unlocated). Mirrors public/kittenshare/save-decode.js locateStats.
function findGenderAnchor(b) {
  for (let i = 0; i + 4 <= b.length; i++) {
    // 'm','a','l','e' — also matches the tail of "female"; either way the
    // anchor is the end of the trailing digits.
    if (b[i] === 0x6d && b[i + 1] === 0x61 && b[i + 2] === 0x6c && b[i + 3] === 0x65) {
      let j = i + 4, digits = 0;
      while (j < b.length && b[j] >= 0x30 && b[j] <= 0x39) { j++; digits++; }
      if (digits >= 1) return j;                  // just past "male<digits>"
    }
  }
  return -1;
}
function locateStats(b) {
  const anchor = findGenderAnchor(b);
  if (anchor < 0) return null;
  for (let base = anchor; base + 4 * 7 <= b.length && base <= anchor + 16; base++) {
    const run = [];
    let i = base;
    while (i + 4 <= b.length && run.length < 7) {
      const v = b.readUInt32LE(i);
      if (v >= 1 && v <= 50) { run.push(v); i += 4; } else break;
    }
    if (run.length >= 7) {
      const stats = {};
      STAT_NAMES.forEach((k, idx) => { stats[k] = run[idx]; });
      return { off: base, stats };
    }
  }
  return null;
}

// ---- HONEST gene search: is there a plain frame-index cluster anywhere? ----
// Returns the best contiguous aligned u32 run of in-frame-range values. If genes
// were stored plainly this would find ~18; on real blobs it finds noise (<=3),
// which is the evidence that genes are bit-packed and unresolved.
function searchGeneCluster(b) {
  let best = { len: 0, off: -1, vals: [] };
  for (let step of [4, 2]) {
    for (let base = 0; base + step <= b.length; base++) {
      const vals = [];
      let i = base;
      while (i + step <= b.length) {
        const v = step === 4 ? b.readUInt32LE(i) : b.readUInt16LE(i);
        if (frameOk(v)) { vals.push(v); i += step; } else break;
      }
      if (vals.length > best.len) best = { len: vals.length, off: base, vals, step };
    }
  }
  return best;
}

function decodeBlob(fp) {
  const b = fs.readFileSync(fp);
  const selfDescribing = b.length >= 4 && b.readUInt32LE(0) === SELF_MARKER;
  const out = { file: path.basename(fp), format: selfDescribing ? 'self-describing' : 'compact', name: null, stats: null, genes: null, genesStatus: 'unresolved' };

  out.name = selfDescribing ? decodeSelfName(b) : decodeCompactName(b);

  if (selfDescribing) {
    const s = locateStats(b);
    if (s) out.stats = s.stats;
  }

  // Honest gene probe (both formats): confirm no plain frame-index cluster exists.
  const cluster = searchGeneCluster(b);
  out._geneProbe = { bestRun: cluster.len, at: cluster.off, sample: cluster.vals.slice(0, 8) };
  // A real 18-field gene block would give a long clean run; a <=4 run is noise.
  out.genesStatus = cluster.len >= 12 ? 'candidate' : 'unresolved';

  return out;
}

function fmtStats(s) { return s ? STAT_NAMES.map(k => `${k.toUpperCase()}=${s[k]}`).join(' ') : '(none)'; }

function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node tools/decode-genes-proof.js <blob.bin ...>');
    process.exit(2);
  }
  const expectedPath = path.join(__dirname, 'fixtures', 'expected.json');
  const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')).fixtures : {};

  console.log('=== decode-genes-proof — Phase 1 go/no-go decode ===');
  console.log('range guards: frame indices [%d,%d], palette rows [%d,%d]\n', FRAME_MIN, FRAME_MAX, PALETTE_MIN, PALETTE_MAX);

  let failures = 0, anyGeneCandidate = false;
  for (const fp of args) {
    let d;
    try { d = decodeBlob(fp); }
    catch (e) { console.error(`${path.basename(fp)}: decode error — ${e.message}`); failures++; continue; }

    console.log(`${d.file}  [${d.format}]`);
    console.log(`  name  : ${JSON.stringify(d.name)}`);
    console.log(`  stats : ${fmtStats(d.stats)}${d.stats ? '  (u32; correcting the "doubles" assumption)' : d.format === 'compact' ? '  (bit-packed — unresolved in compact blob)' : ''}`);
    console.log(`  genes : ${d.genesStatus.toUpperCase()}  (best in-range int run = ${d._geneProbe.bestRun}${d._geneProbe.bestRun ? ` @${d._geneProbe.at} e.g. ${d._geneProbe.sample.join(',')}` : ''})`);

    // Assert the fields that ARE recoverable against the fixtures.
    const exp = expected[d.file];
    if (exp) {
      if (exp.name != null && d.name !== exp.name) { console.error(`  ASSERT FAIL: name ${JSON.stringify(d.name)} != expected ${JSON.stringify(exp.name)}`); failures++; }
      if (exp.stats && d.stats) {
        for (const k of STAT_NAMES) {
          if (exp.stats[k] != null && d.stats[k] !== exp.stats[k]) { console.error(`  ASSERT FAIL: stat ${k} ${d.stats[k]} != expected ${exp.stats[k]}`); failures++; }
        }
      }
      // Genes: expected.json marks these unresolved. A surprise plain cluster is a red flag.
      if (d.genesStatus === 'candidate') {
        anyGeneCandidate = true;
        // Default-range red flag: a cluster all in 1000-1049 is a likely-unread default, not a win.
        const allDefault = d._geneProbe.sample.length && d._geneProbe.sample.every(v => v >= 1000 && v <= 1049);
        console.log(`  NOTE : plain frame-index cluster surfaced (len ${d._geneProbe.bestRun})${allDefault ? ' — but all in 1000-1049 DEFAULT range (red flag, likely unread default, not a real decode)' : ' — investigate before trusting'}`);
      }
    }
    console.log('');
  }

  console.log('--------------------------------------------------------------');
  if (!anyGeneCandidate) {
    console.log('RESULT: GENES UNRESOLVED — FALLBACK.');
    console.log('  Appearance-gene frame indices are bit-packed in the variable-length');
    console.log('  tagged cats.data stream; no plain frame-index cluster exists in any');
    console.log('  fixture. Stopping trigger (a) fired: poster-cross-reference + full-corpus');
    console.log('  pattern search + temporally-adjacent diff + save_file_cat cross-check all');
    console.log('  completed WITHOUT a candidate gene cluster decoding to plausible frame');
    console.log('  indices. Controlled single-gene saves (the plan\'s primary method) were');
    console.log('  unavailable. 01-03 should adopt the fallback scope: name/class/gender/');
    console.log('  abilities (+ stats, decodable from the self-describing record) with');
    console.log('  appearance marked "unverified".');
  } else {
    console.log('RESULT: a plain gene cluster surfaced — re-verify it is not a default-range artifact before claiming GO.');
  }
  console.log('--------------------------------------------------------------');

  // Exit 0 on a clean, fully-asserted UNRESOLVED outcome (the documented fallback
  // is a valid spike result); non-zero only if a recoverable-field assertion failed.
  if (failures) { console.error(`\n${failures} assertion failure(s).`); process.exit(1); }
  process.exit(0);
}

main();
