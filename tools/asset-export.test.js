#!/usr/bin/env node
// asset-export.test.js — behavior tests for the AST-01 chunked asset export +
// the standalone shared-card lazy-load resolver.
//
// What it proves (see .planning/phases/02-.../02-RESEARCH.md "Phase Requirements ->
// Test Map" + 02-03-PLAN.md <behavior>):
//   * MANIFEST COMPLETENESS: for every sprite in parts/manifest.json the ranges are
//     contiguous, non-overlapping, start at 0 and cover the sprite's FULL frame count
//     (last.hi === totalFrames-1, cross-checked against the eager monolith); every
//     listed chunk file exists on disk. Same for patterns/manifest.json.
//   * CHUNK-SIZE CAP: no parts/ or patterns/ JSON file exceeds 25 MiB (Cloudflare
//     Pages hard cap) — re-asserted independently of the tool run.
//   * FILE-COUNT: total parts+patterns file count < 20,000 (CF Pages Free cap).
//   * SELECTIVE LOAD: the pure resolveChunks() lifted from kittenshare.html, given a
//     cat's 14 slots + pattern and a MOCK manifest, fetches exactly one range file per
//     referenced frame per sprite PLUS the frame-0 chunk per sprite (box-guard) and
//     NOTHING else — a shared link can never trigger a whole-tree download.
//
// Plain-node harness (mirrors tools/share-encode.test.js): a test()/failures counter,
// no network/DOM (the resolver is a pure function), exit non-zero on any failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARTS = path.join(ROOT, 'public/kittenshare/parts');
const PATTERNS = path.join(ROOT, 'public/kittenshare/patterns');
const HTML = path.join(ROOT, 'public/kittenshare.html');
const CAP = 25 * 1024 * 1024;      // 25 MiB
const FILE_LIMIT = 20000;

let failures = 0;
function test(desc, fn) {
  try { fn(); console.log('  ok   -', desc); }
  catch (e) { failures++; console.error('  FAIL -', desc, '\n        ', e.message); }
}

function readManifest(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function walkJson(dir) {
  const out = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) rec(f); else if (e.name.endsWith('.json')) out.push(f);
    }
  })(dir);
  return out;
}

// The eager monolith carries totalFrames per sprite — the ground truth for "full coverage".
const { CAT_PARTS } = require('../public/kittenshare/parts.js');

// --- 1. MANIFEST COMPLETENESS (parts) ---
test('parts manifest: ranges are contiguous from 0, cover the FULL sprite frame count, files exist', () => {
  const man = readManifest(path.join(PARTS, 'manifest.json'));
  assert.ok(man.slots && Object.keys(man.slots).length === 8, 'manifest lists all 8 render sprites');
  for (const [sprite, ranges] of Object.entries(man.slots)) {
    assert.ok(ranges.length > 0, `${sprite} has ranges`);
    let expectLo = 0;
    for (const r of ranges) {
      assert.strictEqual(r.lo, expectLo, `${sprite} range starts contiguous at ${expectLo} (got ${r.lo})`);
      assert.ok(r.hi >= r.lo, `${sprite} range ${r.lo}-${r.hi} is well-formed`);
      assert.ok(fs.existsSync(path.join(PARTS, r.file)), `${sprite} chunk file ${r.file} exists on disk`);
      expectLo = r.hi + 1;
    }
    const total = CAT_PARTS[sprite] && CAT_PARTS[sprite].totalFrames;
    assert.ok(total > 0, `${sprite} totalFrames known from monolith`);
    assert.strictEqual(ranges[ranges.length - 1].hi, total - 1,
      `${sprite} last range covers the full frame count (hi=${ranges[ranges.length - 1].hi}, totalFrames=${total})`);
  }
});

// --- 1b. MANIFEST COMPLETENESS (patterns) ---
test('patterns manifest: CatTexture ranges contiguous from 0 and every chunk file exists', () => {
  const man = readManifest(path.join(PATTERNS, 'manifest.json'));
  const ranges = man.slots && man.slots.CatTexture;
  assert.ok(Array.isArray(ranges) && ranges.length > 0, 'CatTexture ranges present');
  let expectLo = 0;
  for (const r of ranges) {
    assert.strictEqual(r.lo, expectLo, `CatTexture range contiguous at ${expectLo} (got ${r.lo})`);
    assert.ok(fs.existsSync(path.join(PATTERNS, r.file)), `CatTexture chunk ${r.file} exists`);
    expectLo = r.hi + 1;
  }
});

// --- 1c. head sockets exist (full-coverage eager file) ---
test('head-sockets: parts/head-sockets.json exists and covers every CatHead frame', () => {
  const socks = readManifest(path.join(PARTS, 'head-sockets.json'));
  const total = CAT_PARTS.CatHead.totalFrames;
  assert.strictEqual(Object.keys(socks).length, total, `head-sockets has one entry per CatHead frame (${total})`);
});

// --- 2. CHUNK-SIZE CAP ---
test('chunk-size cap: no parts/ or patterns/ JSON exceeds 25 MiB', () => {
  const files = [...walkJson(PARTS), ...walkJson(PATTERNS)];
  let biggest = 0, biggestF = '';
  for (const f of files) {
    const sz = fs.statSync(f).size;
    if (sz > biggest) { biggest = sz; biggestF = f; }
    assert.ok(sz <= CAP, `${path.relative(ROOT, f)} is ${(sz / 1048576).toFixed(2)} MB (<= 25 MiB)`);
  }
  console.log('        largest chunk:', (biggest / 1048576).toFixed(2) + ' MB', path.relative(ROOT, biggestF));
});

// --- 3. FILE-COUNT ---
test('file-count: total parts+patterns file count is well under 20,000', () => {
  const count = walkJson(PARTS).length + walkJson(PATTERNS).length;
  console.log('        chunk-tree file count:', count);
  assert.ok(count < FILE_LIMIT, `file count ${count} < 20,000`);
});

// --- 4. SELECTIVE LOAD (pure resolver lifted from kittenshare.html) ---
// The resolver is the single source of truth in the page; we lift it verbatim between
// its /* @resolver-start */ … /* @resolver-end */ markers and exercise it in Node with a
// MOCK manifest — no DOM, no fetch. This guarantees the test checks the page's real code.
function liftResolver() {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/\/\* @resolver-start \*\/([\s\S]*?)\/\* @resolver-end \*\//);
  assert.ok(m, 'kittenshare.html contains the /* @resolver-start … @resolver-end */ block');
  // eslint-disable-next-line no-new-func
  return (new Function(m[1] + '\nreturn { resolveChunks, SLOT_TO_SPRITE };'))();
}

test('selective load: resolveChunks fetches only referenced-frame chunks + frame-0 per sprite', () => {
  const { resolveChunks, SLOT_TO_SPRITE } = liftResolver();
  assert.strictEqual(typeof resolveChunks, 'function', 'resolveChunks lifted');
  assert.ok(SLOT_TO_SPRITE && Object.keys(SLOT_TO_SPRITE).length === 14, 'SLOT_TO_SPRITE maps all 14 slots');

  // MOCK manifests: every sprite has two 150-frame ranges (0-149, 150-299).
  const two = (sprite) => [
    { lo: 0, hi: 149, file: sprite + '/0-149.json' },
    { lo: 150, hi: 299, file: sprite + '/150-299.json' },
  ];
  const sprites = ['CatBody', 'CatHead', 'CatTail', 'CatLeg', 'CatEye', 'CatEyebrow', 'CatEar', 'CatMouth'];
  const partsMan = { version: 1, chunkFrames: 150, slots: {} };
  for (const s of sprites) partsMan.slots[s] = two(s);
  const patternsMan = { version: 1, chunkFrames: 150, slots: { CatTexture: [
    { lo: 0, hi: 149, file: '0-149.json' }, { lo: 150, hi: 299, file: '150-299.json' } ] } };

  // A cat: Body/Head/Mouth reference frame 200 (upper chunk), everything else frame 0.
  const slots = {
    Body: 200, Head: 200, Tail: 0, RearLeg_L: 0, RearLeg_R: 0, FrontLeg_L: 0,
    FrontLeg_R: 0, Eye_L: 0, Eye_R: 0, Brow_L: 0, Brow_R: 0, Ear_L: 0, Ear_R: 0, Mouth: 200,
  };
  const { partFiles, patternFiles } = resolveChunks(slots, 200, partsMan, patternsMan);

  // Box-guard: frame-0 chunk present for EVERY sprite.
  for (const s of sprites) assert.ok(partFiles.includes(s + '/0-149.json'), `${s} frame-0 chunk fetched (box-guard)`);
  // Referenced upper chunk only for Body/Head/Mouth.
  for (const s of ['CatBody', 'CatHead', 'CatMouth']) assert.ok(partFiles.includes(s + '/150-299.json'), `${s} upper chunk fetched`);
  // Sprites that only reference frame 0 must NOT fetch the upper chunk.
  for (const s of ['CatTail', 'CatLeg', 'CatEye', 'CatEyebrow', 'CatEar'])
    assert.ok(!partFiles.includes(s + '/150-299.json'), `${s} upper chunk NOT fetched (unreferenced)`);
  // Exactly 8 frame-0 + 3 upper = 11 part files, not the whole 16-file tree.
  assert.strictEqual(partFiles.length, 11, `resolves to 11 part chunks (got ${partFiles.length}), not the full tree`);
  // Pattern: only the frame-200 chunk (no box-guard for patterns).
  assert.deepStrictEqual(patternFiles, ['150-299.json'], 'pattern resolves to exactly one chunk');
});

// --- 5. loadNeededParts wired into the standalone path only ---
test('wiring: kittenshare.html defines loadNeededParts + fetches chunks; local browse view untouched', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(/function loadNeededParts/.test(html), 'loadNeededParts defined');
  assert.ok(/fetch\(\s*['"`]kittenshare\/parts\//.test(html), 'fetches kittenshare/parts/ chunks');
  // tryShareView must await loadNeededParts before rendering the standalone card.
  const tsv = html.match(/function tryShareView\(\)[\s\S]*?\n}/);
  assert.ok(tsv && /await loadNeededParts/.test(tsv[0]), 'tryShareView awaits loadNeededParts');
  // The local browse path (renderCards) must NOT lazy-load chunks (eager monolith, D3).
  const rc = html.match(/function renderCards\(\)[\s\S]*?\n}/);
  assert.ok(rc, 'renderCards present');
  assert.ok(!/loadNeededParts|parts\/manifest/.test(rc[0]), 'renderCards contains no chunk lazy-load (eager monolith kept)');
});

if (failures) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll asset-export behavior tests passed.');
