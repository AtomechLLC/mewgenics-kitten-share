#!/usr/bin/env node
// share-encode.test.js — behavior tests for the SHR-01..05 share codec in
// public/kittenshare/save-decode.js (encodeShare / decodeShare).
//
// The permanent contract is docs/kittenshare-share-spec.md (§4 field table, §5
// algorithm, §6 L/R reconstruction, §7 length guard, §8 version handling). This suite
// proves, against the committed fixtures and the vendored lz-string 1.5.0:
//   * ROUND-TRIP (SHR-01): decodeShare(encodeShare(cat)) reproduces the render object.
//   * VERSION (SHR-01/§8): v===1 first; an unknown v -> a graceful sentinel, not a throw.
//   * BUDGET (SHR-02/§7): a worst-case cat still fits well under the ~2000-char budget.
//   * VERIFIED SHAPE (SHR-03): the decoded object is standalone-verified + L/R mirrored.
//   * MUTATIONS (§4): a >=300 slot frame re-derives a non-empty genes.mutations.
//   * BAD-LINK (SHR-04/§7): null / garbage / oversized blobs -> null, never a throw.
//
// Plain-node harness (mirrors tools/save-decode.test.js): a test()/failures counter,
// require the shared module, exit non-zero on any failure.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const mod = require('../public/kittenshare/save-decode.js');
const LZString = require('../public/vendor/lz-string.min.js');

const { decodeCat, encodeShare, decodeShare } = mod;

function bin(name) { return new Uint8Array(fs.readFileSync(path.join(FIX, name))); }

let failures = 0;
function test(desc, fn) {
  try { fn(); console.log('  ok   -', desc); }
  catch (e) { failures++; console.error('  FAIL -', desc, '\n        ', e.message); }
}

// The 14-slot order used across the codebase (SLOTS 1..14 in save-decode.js).
const SLOT_KEYS = ['Body', 'Head', 'Tail', 'RearLeg_L', 'RearLeg_R', 'FrontLeg_L',
  'FrontLeg_R', 'Eye_L', 'Eye_R', 'Brow_L', 'Brow_R', 'Ear_L', 'Ear_R', 'Mouth'];

// The render-object projection the share link must reproduce losslessly.
function renderView(c) {
  const g = c.genes || {};
  const s = c.stats;
  const slots = {};
  for (const k of SLOT_KEYS) slots[k] = (g.slots || {})[k];
  return {
    name: c.name, cls: c.cls, gender: c.gender,
    abilities: c.abilities || [],
    stats: s ? { str: s.str, dex: s.dex, con: s.con, int: s.int, spd: s.spd,
      cha: s.cha, lck: s.lck, hp: s.hp == null ? null : s.hp } : null,
    slots: slots, pattern: g.pattern, coatPalette: g.coatPalette,
    classPalette: g.classPalette
  };
}

// 0. The module exports both functions (contract for the page's window.SaveDecode).
test('exports: encodeShare and decodeShare are both functions', () => {
  assert.strictEqual(typeof encodeShare, 'function', 'encodeShare exported');
  assert.strictEqual(typeof decodeShare, 'function', 'decodeShare exported');
});

// 1. ROUND-TRIP (SHR-01): every committed fixture survives encode->decode with equal
// name, class, gender, abilities, the 7 core stats + hp, all 14 slots, pattern,
// coatPalette, classPalette.
for (const file of ['garik.bin', 'reinaldo.bin', 'churrito.bin']) {
  test(`round-trip: ${file} encodeShare -> decodeShare reproduces the render object`, () => {
    const src = decodeCat(bin(file));
    assert.ok(src.genes, `${file} decodes genes to share`);
    const blob = encodeShare(src);
    assert.strictEqual(typeof blob, 'string', 'encodeShare returns a blob string');
    const back = decodeShare(blob);
    assert.ok(back && !back.__unsupportedVersion, 'decodeShare returns a real object');
    assert.deepStrictEqual(renderView(back), renderView(src),
      'the decoded render object equals the source render object');
  });
}

// 2. VERSION (SHR-01 / §8): encodeShare emits v===1 as the first JSON field; a blob
// carrying v===2 decodes to the graceful unsupported-version sentinel (not a throw,
// not a neutral cat).
test('version: encodeShare emits v===1 as the first field', () => {
  const blob = encodeShare(decodeCat(bin('reinaldo.bin')));
  const json = LZString.decompressFromEncodedURIComponent(blob);
  assert.ok(json.indexOf('{"v":1') === 0, 'the compact JSON starts with {"v":1');
  assert.strictEqual(JSON.parse(json).v, 1, 'v decodes to 1');
});
test('version: a v===2 blob decodes to { __unsupportedVersion: 2 } (graceful, no throw)', () => {
  const future = LZString.compressToEncodedURIComponent(JSON.stringify({ v: 2, n: 'FromTheFuture' }));
  let out;
  assert.doesNotThrow(() => { out = decodeShare(future); });
  assert.deepStrictEqual(out, { __unsupportedVersion: 2 }, 'unknown version -> sentinel');
});

// 3. BUDGET (SHR-02 / §7): a worst-case cat — a 20-char name plus six max-length
// ability id strings — still encodes to a full URL well under the ~2000-char budget.
test('budget: a worst-case cat encodes to a URL under 2000 chars', () => {
  const worst = {
    name: 'X'.repeat(30),                               // will be truncated to 20
    cls: 'Necromancer', gender: 'female',
    abilities: Array.from({ length: 6 }, (_, i) => ('MoonHeadCommandStopHittingYourself' + i)),
    stats: { str: 10, dex: 10, con: 10, int: 10, spd: 10, cha: 10, lck: 10, hp: 999 },
    genes: { pattern: 706, coatPalette: 49, classPalette: 68,
      slots: { Body: 5000, Head: 5000, Tail: 5000, RearLeg_L: 5000, RearLeg_R: 5000,
        FrontLeg_L: 5000, FrontLeg_R: 5000, Eye_L: 5000, Eye_R: 5000, Brow_L: 5000,
        Brow_R: 5000, Ear_L: 5000, Ear_R: 5000, Mouth: 5000 } }
  };
  const blob = encodeShare(worst);
  const url = 'https://kittenshare.example/kittenshare.html#k=' + blob;
  assert.ok(url.length < 2000, `worst-case URL is ${url.length} chars (< 2000 budget)`);
  // The name was truncated to the 20-char cap on the way in.
  assert.strictEqual(decodeShare(blob).name.length, 20, 'name truncated to 20 chars');
});

// 4. VERIFIED SHAPE (SHR-03): a decoded share is standalone-verified, L/R mirrored,
// with mp/level null (unlocated fields never fabricated).
test('verified shape: decodeShare output is verified + L/R mirrored + mp/level null', () => {
  const back = decodeShare(encodeShare(decodeCat(bin('reinaldo.bin'))));
  assert.strictEqual(back.buildOk, true, 'buildOk true (a shared link IS the truth)');
  assert.strictEqual(back.genesResolved, true, 'genesResolved true');
  assert.strictEqual(back.appearanceVerified, true, 'appearanceVerified true');
  assert.strictEqual(back.genes.slots.Eye_L, back.genes.slots.Eye_R, 'Eye_L === Eye_R');
  assert.strictEqual(back.genes.slots.Ear_L, back.genes.slots.Ear_R, 'Ear_L === Ear_R');
  assert.strictEqual(back.genes.slots.Brow_L, back.genes.slots.Brow_R, 'Brow_L === Brow_R');
  assert.strictEqual(back.stats.mp, null, 'mp is honestly null');
  assert.strictEqual(back.stats.level, null, 'level is honestly null');
});

// 5. MUTATIONS (§4): a payload whose k/p frames carry a >=300 value re-derives a
// non-empty genes.mutations on decode (mutations ride the frames, no separate field).
test('mutations: a >=300 slot frame re-derives a non-empty genes.mutations', () => {
  // save_file_cat carries real mutations (Porcupine, Hippo Teeth, …); round-trip them.
  const src = decodeCat(bin('save_file_cat.bin'));
  assert.ok(src.genes && src.genes.mutations.length > 0, 'source fixture has mutations');
  const back = decodeShare(encodeShare(src));
  assert.ok(Array.isArray(back.genes.mutations) && back.genes.mutations.length > 0,
    're-derived a non-empty mutation list from the carried frames');
  // A synthetic frame >= 300 also yields a mutation regardless of fixture specifics.
  const synth = decodeShare(encodeShare({
    name: 'Mutant', cls: 'Butcher', gender: 'male', abilities: [],
    stats: null, genes: { pattern: 1, coatPalette: 17, classPalette: -1,
      slots: { Body: 314, Head: 0, Tail: 0, RearLeg_L: 0, RearLeg_R: 0, FrontLeg_L: 0,
        FrontLeg_R: 0, Eye_L: 0, Eye_R: 0, Brow_L: 0, Brow_R: 0, Ear_L: 0, Ear_R: 0,
        Mouth: 0 } }
  }));
  assert.ok(synth.genes.mutations.some(m => m.region === 'Body'),
    'a Body frame of 314 re-derives a Body mutation');
});

// 6. BAD-LINK (SHR-04 / §7): non-string, non-lz-string garbage, and an oversized blob
// each return null WITHOUT throwing — driving the friendly fallback card, never a crash.
test('bad-link: null / garbage / oversized inputs return null without throwing', () => {
  let a, b, c, d;
  assert.doesNotThrow(() => { a = decodeShare(null); });
  assert.doesNotThrow(() => { b = decodeShare('!!!not-lz-string!!!'); });
  assert.doesNotThrow(() => { c = decodeShare('x'.repeat(5000)); });     // > 4000 cap
  assert.doesNotThrow(() => { d = decodeShare(12345); });                // non-string
  assert.strictEqual(a, null, 'null -> null');
  assert.strictEqual(b, null, 'garbage -> null');
  assert.strictEqual(c, null, 'oversized (>4000) -> null (before decompressing)');
  assert.strictEqual(d, null, 'non-string -> null');
});

if (failures) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll share-encode behavior tests passed.');
