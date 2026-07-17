#!/usr/bin/env node
// decode-compact-stats.js — PROVE-OR-DISPROVE the compact cats.data per-cat stats
// decode (Phase 1, Plan 04 gap closure for DEC-02).
//
// THE GAP (01-VERIFICATION.md): decodeCat only decodes the 7 core stats when the
// blob is the self-describing files.save_file_cat record (u32@0==19). But the
// KittenShare page's openSave() only ever reads the compact `cats` table, so
// 0/1,308 real cats ever get a non-null stats object. This tool attempts the
// compact stats decode behind an OBJECTIVE statistical gate (live-corpus census +
// 17-backup invariance oracle + a Lucina cross-format ordering sanity) and prints
// an explicit VERDICT: GO or VERDICT: NO-GO. A blocking HUMAN value-check (Plan-04
// Task 3) sits behind a GO before any fixture is trusted — statistics alone never
// lock in a value.
//
// APPROACH (from scratchpad genes-spike/FINDINGS.md, ported into the repo):
//   * Compact tag grammar (§1, PROVEN): tag byte -> type=tag&0x1f, param=tag>>5;
//     if param==7 read a LEB128 varint and param = 7 + leb. A value field is
//     (1+param) bytes LE immediately after the type byte (S2.1 value rule).
//   * Field order (§2): ... appearance . voice("male26"/"female45") . pitch double
//     . STATS . item . abilities . class. So the 7 stats follow the voice token +
//     one 8-byte pitch double, in STR/DEX/CON/INT/SPD/CHA/LCK order.
//   * Honest limit (S2.2): the spike could NOT pin compact APPEARANCE per-part
//     values because each part record carries variable/optional subfields and
//     parts are omitted when equal to default — a fixed-shape walk is ambiguous.
//     If the STATS region shows the same ambiguity, the gate fails and NO-GO is a
//     VALID, expected outcome — never fabricate a stat value to force a GO.
//
// Untrusted-input hygiene (T-1-07): every read is bounded vs length, every scan is
// capped at min(n,65536), and the whole decode is wrapped so malformed input
// returns null and never throws or hangs. The live save + backups are READ-ONLY:
// this tool opens them, never writes. No .sav/.savbackup and nothing from the
// spike scratchpad is committed — only this tool.
//
// Usage:
//   node tools/decode-compact-stats.js                 # census + oracle + VERDICT
//   node tools/decode-compact-stats.js <path-to.sav>   # override the live-save path
//   node tools/decode-compact-stats.js --cat <name>    # decoded stats for a named cat
//   node tools/decode-compact-stats.js --list-named 10 # N named cats + decoded stats

'use strict';

const fs = require('fs');
const path = require('path');

const VENDOR = path.join(__dirname, '..', 'public', 'vendor');

// ---- constants ----
const SELF_MARKER = 19;                    // u32@0 of a self-describing save_file_cat
const BUILD_5090 = 5090;                   // the recognized compact build
const STAT_NAMES = ['str', 'dex', 'con', 'int', 'spd', 'cha', 'lck'];
const STAT_LO = 1, STAT_HI = 50;           // candidate-stat range guard (generous)
const CENSUS_HI = 20;                      // census "clean" band ceiling
const MAXSCAN = 65536;                     // DoS cap on every byte scan

// ---- default live-save + backup locations (READ-ONLY) ----
const SAVE_GLOB_ROOT = 'C:/Users/alexy/AppData/Roaming/Glaiel Games/Mewgenics';
const DEFAULT_SAVE = SAVE_GLOB_ROOT + '/76561197962382056/saves/steamcampaign02.sav';

// ------------------------------------------------------------------ helpers ----

// Voice-token anchor: 'm''a''l''e'+digits OR 'f''e''m''a''l''e'+digits. Returns the
// byte offset just past the trailing digits, or -1. Mandatory anchor — no offset-0
// scan (mirrors decode-appearance.js findVoice + save-decode.test.js #6 discipline).
function findVoiceEnd(u, n) {
  const MAX = Math.min(n, MAXSCAN);
  for (let i = 24; i + 6 < MAX; i++) {
    const m = u[i] === 0x6d && u[i + 1] === 0x61 && u[i + 2] === 0x6c && u[i + 3] === 0x65 &&
      u[i + 4] >= 0x30 && u[i + 4] <= 0x39;
    const f = u[i] === 0x66 && u[i + 1] === 0x65 && u[i + 2] === 0x6d && u[i + 3] === 0x61 &&
      u[i + 4] === 0x6c;
    if (m || f) {
      let j = i + 4;
      while (j < MAX && u[j] >= 0x30 && u[j] <= 0x39) j++;
      if (j > i + 4) return j;
    }
  }
  return -1;
}

// Read one tag field per the PROVEN grammar. value = (1+param) bytes LE after the
// type byte, param = tag>>5 with LEB128 extension when param==7.
function readTag(u, i, n) {
  if (i < 0 || i >= n) return null;
  const tag = u[i];
  const type = tag & 0x1f;
  let param = tag >> 5;
  let p = i + 1;
  if (param === 7) {
    let shift = 0, ext = 0, steps = 0;
    while (p < n && steps++ < 6) {
      const c = u[p++];
      ext += (c & 0x7f) * Math.pow(2, shift);
      if (!(c & 0x80)) break;
      shift += 7;
    }
    param = 7 + ext;
  }
  const w = 1 + param;
  if (w < 1 || w > 8 || p + w > n) return null;
  let val = 0;
  for (let k = 0; k < w; k++) val += u[p + k] * Math.pow(2, 8 * k);
  return { type, param, val, width: w, next: p + w };
}

// locateCompactStats — the honest attempt. Anchor on voice, skip the 8-byte pitch
// double, then walk the tag stream in the STATS window collecting single-byte
// value fields in [STAT_LO,STAT_HI] as the 7 core stats. Structural/filler tags
// (SEP 08 02 00, marker 0f .. 00, bare 00) are skipped; a frame-range or wide
// value field (the S2.2 variable-subfield failure mode) aborts the walk -> null.
// Returns { str,dex,con,int,spd,cha,lck } | null. Never throws.
function locateCompactStats(u8) {
  try {
    if (!u8 || typeof u8.length !== 'number') return null;
    const u = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    const n = u.length;
    if (n < 24) return null;
    const vend = findVoiceEnd(u, n);
    if (vend < 0) return null;
    let i = vend + 8;                       // skip the pitch double (8-byte IEEE-754)
    const run = [];
    let guard = 0;
    const WINDOW = Math.min(n, vend + 8 + 96); // stats sit close after the pitch double
    while (run.length < 7 && i < WINDOW && guard++ < 128) {
      const r = readTag(u, i, n);
      if (!r) break;
      // structural / filler tags advance without contributing a stat
      if (r.type === 0 && r.param === 0) { i = r.next; continue; }        // bare 00 filler
      if (r.width === 1 && r.val >= STAT_LO && r.val <= STAT_HI) {
        run.push(r.val); i = r.next; continue;                            // candidate stat
      }
      if (r.width === 1 && r.val === 0) { i = r.next; continue; }         // 0-valued filler
      // a multi-byte / frame-range value = intervening subfield -> ambiguous walk
      break;
    }
    if (run.length !== 7) return null;
    const o = {};
    STAT_NAMES.forEach((k, idx) => { o[k] = run[idx]; });
    return o;
  } catch (e) {
    return null;
  }
}

// ---- cross-format ordering sanity: recover Lucina's stats from save_file_cat ----
// Self-describing uses plain u32 (not tag ints); we validate the voice->pitch->stats
// ORDERING logic here against the one record with ground truth [4,4,6,7,4,5,5].
function locateSelfStats(u, n) {
  const vend = findVoiceEnd(u, n);
  if (vend < 0) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  for (let base = vend; base + 28 <= n && base <= vend + 16; base++) {
    const run = [];
    let i = base;
    while (i + 4 <= n && run.length < 7) {
      const v = dv.getUint32(i, true);
      if (v >= 1 && v <= 50) { run.push(v); i += 4; } else break;
    }
    if (run.length >= 7) {
      const o = {};
      STAT_NAMES.forEach((k, idx) => { o[k] = run[idx]; });
      return o;
    }
  }
  return null;
}

// ---- compact name (mirrors decode-genes-proof.js decodeCompactName) ----
function decodeCompactName(b) {
  if (b.length < 24) return null;
  const L = b.readUInt16LE(17);
  if (L < 1 || L > 64) return null;
  if ((b[21] & 0x1f) !== 0x12) return null;
  for (const start of [22, 23]) {
    const need = 2 * L - 1;
    if (start + need > b.length) continue;
    const bytes = Buffer.concat([b.slice(start, start + need), Buffer.from([0])]);
    let s = '', ok = true;
    for (let k = 0; k < L; k++) {
      const code = bytes.readUInt16LE(k * 2);
      if (code === 0) { ok = false; break; }
      s += String.fromCharCode(code);
    }
    if (ok && s.length === L) return s;
  }
  return null;
}

// ------------------------------------------------------------------ sql.js ----
function loadSql() {
  const initSqlJs = require(path.join(VENDOR, 'sql-wasm.js'));
  return initSqlJs({ locateFile: f => path.join(VENDOR, f) });
}

function readCats(SQL, savPath) {
  const out = [];
  let db;
  try {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(savPath)));
  } catch (e) {
    return out;
  }
  try {
    const res = db.exec('SELECT key, data FROM cats');
    if (res.length) {
      for (const [key, data] of res[0].values) {
        const b = Buffer.from(data);
        if (b.length < 20) continue;
        out.push({ key, b });
      }
    }
  } catch (e) { /* no cats table */ }
  db.close();
  return out;
}

function isBuild5090(b) { return b.length >= 8 && b.readUInt32LE(4) === BUILD_5090; }
function uidHex(b) { return b.length >= 17 ? b.slice(9, 17).toString('hex') : ''; }

// ------------------------------------------------------------------ stats math ----
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return Math.sqrt(v);
}

// ------------------------------------------------------------------ save path ----
function resolveSavePath(argPath) {
  if (argPath && fs.existsSync(argPath)) return argPath;
  if (fs.existsSync(DEFAULT_SAVE)) return DEFAULT_SAVE;
  // glob .../Mewgenics/*/saves/steamcampaign02.sav
  try {
    for (const id of fs.readdirSync(SAVE_GLOB_ROOT)) {
      const p = path.join(SAVE_GLOB_ROOT, id, 'saves', 'steamcampaign02.sav');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* ignore */ }
  return null;
}
function backupsDir(savPath) {
  return savPath ? path.join(path.dirname(savPath), 'backups') : null;
}

// ------------------------------------------------------------------ modes ----
function fmtStats(s) {
  return s ? STAT_NAMES.map(k => `${k.toUpperCase()}=${s[k]}`).join(' ') : '(stats null — unresolved)';
}

async function modeCat(name, savPath) {
  const SQL = await loadSql();
  const cats = readCats(SQL, savPath);
  const target = String(name).toLowerCase();
  let hits = 0;
  for (const { b } of cats) {
    const nm = decodeCompactName(b);
    if (nm && nm.toLowerCase() === target) {
      hits++;
      console.log(`uid ${uidHex(b)}  ${nm}  ${fmtStats(locateCompactStats(b))}`);
    }
  }
  if (!hits) console.log(`no cat named "${name}" found in ${path.basename(savPath)}`);
}

async function modeListNamed(nRaw, savPath) {
  const N = Math.max(1, Math.min(200, parseInt(nRaw, 10) || 5));
  const SQL = await loadSql();
  const cats = readCats(SQL, savPath);
  const seen = new Set();
  let shown = 0;
  for (const { b } of cats) {
    if (shown >= N) break;
    const nm = decodeCompactName(b);
    if (!nm || seen.has(nm.toLowerCase())) continue;
    seen.add(nm.toLowerCase());
    console.log(`uid ${uidHex(b)}  ${nm.padEnd(16)}  ${fmtStats(locateCompactStats(b))}`);
    shown++;
  }
  if (!shown) console.log('no named cats decoded');
}

// characterization dump: shows WHY the walk succeeds/fails on a handful of cats
function characterize(cats) {
  console.log('\n-- characterization: STATS window (after voice+pitch) for 6 sample cats --');
  let shown = 0;
  for (const { b } of cats) {
    if (shown >= 6) continue;
    if (!isBuild5090(b)) continue;
    const n = b.length;
    const vend = findVoiceEnd(b, n);
    if (vend < 0) continue;
    const nm = decodeCompactName(b) || '(unnamed)';
    const start = vend + 8;
    const win = [...b.slice(start, Math.min(start + 40, n))]
      .map(x => x.toString(16).padStart(2, '0')).join(' ');
    const st = locateCompactStats(b);
    console.log(`  ${nm.padEnd(14)} win: ${win}`);
    console.log(`  ${' '.padEnd(14)} decode: ${st ? fmtStats(st) : 'null (no clean 7-int run — subfield ambiguity)'}`);
    shown++;
  }
}

async function modeVerdict(savPath) {
  console.log('=== decode-compact-stats — compact cats.data stats PROOF/DISPROOF ===');
  console.log('hypothesis: 7 tag ints (STR/DEX/CON/INT/SPD/CHA/LCK) after voice+pitch');
  console.log('value rule: (1+param) bytes LE after the type byte, param = tag>>5\n');

  const SQL = await loadSql();

  // ---- Gate 1: cross-format ordering sanity (Lucina) ----
  const sfcPath = path.join(__dirname, 'fixtures', 'save_file_cat.bin');
  let lucinaOk = false, lucinaStats = null;
  if (fs.existsSync(sfcPath)) {
    const b = new Uint8Array(fs.readFileSync(sfcPath));
    lucinaStats = locateSelfStats(b, b.length);
    lucinaOk = !!lucinaStats && lucinaStats.str === 4 && lucinaStats.dex === 4 &&
      lucinaStats.con === 6 && lucinaStats.int === 7 && lucinaStats.spd === 4 &&
      lucinaStats.cha === 5 && lucinaStats.lck === 5;
  }
  console.log(`[gate 1] cross-format ordering sanity (save_file_cat -> Lucina):`);
  console.log(`         decoded ${fmtStats(lucinaStats)} -> ${lucinaOk ? 'MATCH 4,4,6,7,4,5,5 ✓' : 'MISMATCH ✗'}`);

  // ---- Gate 2: live-corpus census ----
  const cats = readCats(SQL, savPath);
  const total = cats.length;
  const b5090 = cats.filter(c => isBuild5090(c.b));
  let clean = 0;
  const perStat = STAT_NAMES.reduce((m, k) => (m[k] = [], m), {});
  for (const { b } of b5090) {
    const st = locateCompactStats(b);
    if (!st) continue;
    const vals = STAT_NAMES.map(k => st[k]);
    if (vals.every(v => Number.isInteger(v) && v >= STAT_LO && v <= CENSUS_HI)) {
      clean++;
      STAT_NAMES.forEach(k => perStat[k].push(st[k]));
    }
  }
  const yieldPct = b5090.length ? (100 * clean / b5090.length) : 0;
  console.log(`\n[gate 2] live-corpus census (${path.basename(savPath)}):`);
  console.log(`         total cats=${total}  build-5090=${b5090.length}  clean-7-stat=${clean}  yield=${yieldPct.toFixed(1)}%`);
  console.log('         per-stat  median / stddev / min-max:');
  let censusBandsOk = clean > 0;
  for (const k of STAT_NAMES) {
    const a = perStat[k];
    const med = median(a), sd = stddev(a);
    const mn = a.length ? Math.min(...a) : null, mx = a.length ? Math.max(...a) : null;
    const bandOk = med != null && med >= 3 && med <= 9 && sd > 0.5;
    if (!bandOk) censusBandsOk = false;
    console.log(`           ${k.toUpperCase()}  med=${med}  sd=${sd == null ? '—' : sd.toFixed(2)}  [${mn}..${mx}]  ${bandOk ? '' : '<-- out of GO band (med[3,9] & sd>0.5)'}`);
  }

  // ---- Gate 3: backup-invariance oracle ----
  const bkDir = backupsDir(savPath);
  const byUid = new Map();          // uid -> [{len, region(hex), stats}]
  let backupFiles = [];
  if (bkDir && fs.existsSync(bkDir)) {
    backupFiles = fs.readdirSync(bkDir).filter(f => /\.savbackup$/i.test(f)).map(f => path.join(bkDir, f));
  }
  const allFiles = backupFiles.concat([savPath]);
  for (const fp of allFiles) {
    const rows = readCats(SQL, fp);
    for (const { b } of rows) {
      if (!isBuild5090(b)) continue;
      const uid = uidHex(b);
      const vend = findVoiceEnd(b, b.length);
      const region = vend >= 0 ? b.slice(vend + 8, Math.min(vend + 8 + 32, b.length)).toString('hex') : null;
      const st = locateCompactStats(b);
      if (!byUid.has(uid)) byUid.set(uid, []);
      byUid.get(uid).push({ len: b.length, region, stats: st });
    }
  }
  let multi = 0, decodeStableOk = 0, decodeStableTot = 0;
  let regionPairs = 0, regionInvariantOk = 0;
  let changedCats = 0, plausibleChanges = 0;
  for (const [, arr] of byUid) {
    if (arr.length < 2) continue;
    multi++;
    // (a) decode stability: if it decoded in ANY appearance, it should decode in all
    const anyDecoded = arr.some(x => x.stats);
    if (anyDecoded) {
      decodeStableTot++;
      if (arr.every(x => x.stats)) decodeStableOk++;
    }
    // (b) region invariance: identical region -> identical decoded stats
    for (let k = 1; k < arr.length; k++) {
      const a = arr[k - 1], c = arr[k];
      if (a.region != null && a.region === c.region) {
        regionPairs++;
        const sa = JSON.stringify(a.stats), sc = JSON.stringify(c.stats);
        if (sa === sc) regionInvariantOk++;
      }
    }
    // (c) change plausibility: decoded stats differ -> total abs delta <= 8
    for (let k = 1; k < arr.length; k++) {
      const a = arr[k - 1], c = arr[k];
      if (!a.stats || !c.stats) continue;
      const delta = STAT_NAMES.reduce((s, key) => s + Math.abs(a.stats[key] - c.stats[key]), 0);
      if (delta > 0) {
        changedCats++;
        const inRange = STAT_NAMES.every(key => c.stats[key] >= STAT_LO && c.stats[key] <= CENSUS_HI);
        if (inRange && delta <= 8) plausibleChanges++;
      }
    }
  }
  const stabilityPct = decodeStableTot ? (100 * decodeStableOk / decodeStableTot) : 0;
  const regionPct = regionPairs ? (100 * regionInvariantOk / regionPairs) : 100;
  const changePct = changedCats ? (100 * plausibleChanges / changedCats) : 100;
  console.log(`\n[gate 3] backup-invariance oracle (${backupFiles.length} backups + live):`);
  console.log(`         cats in >=2 saves=${multi}`);
  console.log(`         (a) decode-stability : ${decodeStableOk}/${decodeStableTot} = ${stabilityPct.toFixed(1)}%  (GO needs >=98%)`);
  console.log(`         (b) region-invariance: ${regionInvariantOk}/${regionPairs} = ${regionPct.toFixed(1)}%  (GO needs 100%)`);
  console.log(`         (c) change-plausible : ${plausibleChanges}/${changedCats} = ${changePct.toFixed(1)}%  (GO needs >=90% or 0 changed)`);

  // ---- characterization evidence ----
  characterize(b5090);

  // ---- malformed-safe self-check ----
  const safe = locateCompactStats(new Uint8Array(3)) === null &&
    locateCompactStats(new Uint8Array(0)) === null;
  console.log(`\nmalformed-safe: ${safe ? 'ok' : 'FAIL'}`);

  // ---- VERDICT ----
  const gate1 = lucinaOk;
  const gate2 = yieldPct >= 98 && censusBandsOk;
  const gate3 = stabilityPct >= 98 && regionPct >= 100 && changePct >= 90;
  console.log('\n--------------------------------------------------------------');
  let verdict, failMsg = '';
  if (gate1 && gate2 && gate3) {
    verdict = 'GO';
  } else {
    verdict = 'NO-GO';
    const fails = [];
    if (!gate1) fails.push('cross-format ordering sanity did not recover Lucina 4,4,6,7,4,5,5');
    if (!gate2) {
      if (yieldPct < 98) fails.push(`census yield ${yieldPct.toFixed(1)}% < 98% (no clean 7-int run for most cats)`);
      if (!censusBandsOk) fails.push('per-stat median/stddev outside the GO band (med[3,9] & sd>0.5) — decoded values are not real stats');
    }
    if (!gate3) {
      if (stabilityPct < 98) fails.push(`decode-stability ${stabilityPct.toFixed(1)}% < 98%`);
      if (regionPct < 100) fails.push(`region-invariance ${regionPct.toFixed(1)}% < 100%`);
      if (changePct < 90) fails.push(`change-plausibility ${changePct.toFixed(1)}% < 90%`);
    }
    failMsg = fails.join('; ');
  }
  if (verdict === 'NO-GO') {
    console.log('FAILING GATE(S): ' + failMsg);
    console.log('This is the S2.2 variable-subfield failure mode carried from appearance');
    console.log('to stats: the compact STATS region has no clean fixed 7-field shape, and');
    console.log('no ground truth (Lucina poster is absent from the cats table; stat changes');
    console.log('re-serialize the blob at a different length so byte-diff cannot isolate a');
    console.log('stat field). Honest fallback (stats stay null) is the correct outcome.');
  }
  console.log('--------------------------------------------------------------');
  console.log('VERDICT: ' + verdict);
}

// ------------------------------------------------------------------ main ----
async function main() {
  const argv = process.argv.slice(2);

  // inline malformed-safe self-check runs in every mode path via modeVerdict; also
  // assert it here cheaply so --cat/--list-named runs exercise it too.
  if (locateCompactStats(new Uint8Array(3)) !== null) {
    console.error('FATAL: malformed input did not return null');
    process.exit(1);
  }

  // parse flags
  let savOverride = null, catName = null, listN = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cat') { catName = argv[++i]; }
    else if (a === '--list-named') { listN = argv[++i]; }
    else if (!a.startsWith('--')) { savOverride = a; }
  }

  const savPath = resolveSavePath(savOverride);
  if (!savPath) {
    console.error('No live save found. Pass a path: node tools/decode-compact-stats.js <save.sav>');
    console.error('(looked for ' + DEFAULT_SAVE + ')');
    process.exit(2);
  }

  if (catName != null) return modeCat(catName, savPath);
  if (listN != null) return modeListNamed(listN, savPath);
  return modeVerdict(savPath);
}

main().catch(e => { console.error('error:', e && e.message); process.exit(2); });

module.exports = { locateCompactStats, findVoiceEnd, readTag };
