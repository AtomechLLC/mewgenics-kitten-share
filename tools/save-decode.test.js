#!/usr/bin/env node
// Behavior tests for public/kittenshare/save-decode.js (Phase 1, Plan 05).
//
// LZ4 truth (01-05): each compact cats.data blob is
//   [u32 decompressedSize][u32 5090 build][LZ4 block]
// decodeCat decompresses first (vendor/lz4.js), then reads real stats +
// appearance. The decoder gates on THREE distinct facts and never fabricates:
//   buildOk         — is u32@4 a save build we recognize?
//   genesResolved   — is the gene/appearance layout located? (true as of 01-05)
//   appearanceVerified = buildOk AND genesResolved AND genes decoded AND range/
//                        symmetry checks pass
// It must also survive malformed/truncated input without throwing or hanging.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures');
const mod = require('../public/kittenshare/save-decode.js');
const decodeCat = mod.decodeCat || mod;

function bin(name) { return new Uint8Array(fs.readFileSync(path.join(FIX, name))); }

let failures = 0;
function test(desc, fn) {
  try { fn(); console.log('  ok   -', desc); }
  catch (e) { failures++; console.error('  FAIL -', desc, '\n        ', e.message); }
}

// 1. GO branch: on a recognized build the compact blob decompresses and decodes
// real genes + real stats, and the appearance verifies (was the 01-01 NO-GO).
test('GO: build 5090 compact blob -> genesResolved true, genes non-null, appearanceVerified true', () => {
  const c = decodeCat(bin('garik.bin'));
  assert.strictEqual(c.buildOk, true, 'garik.bin is build 5090');
  assert.strictEqual(c.genesResolved, true, 'gene/appearance layout is located (01-05)');
  assert.ok(c.genes && c.genes.pattern > 0, 'genes decode with a fur pattern id');
  assert.ok(c.genes.coatPalette >= 1 && c.genes.coatPalette <= 49, 'genes decode a real coat color (coatPalette 1..49)');
  assert.strictEqual(c.appearanceVerified, true, 'valid build-5090 appearance verifies');
  assert.ok(c.name, 'still decodes a name');
});

// 1b. Compact blob decodes real 7 core stats (was the 01-04 NO-GO).
test('compact blob decodes real stats: garik -> 7 non-null core stats in [1,10]', () => {
  const s = decodeCat(bin('garik.bin')).stats;
  assert.ok(s, 'stats decode from the compact blob');
  for (const k of ['str', 'dex', 'con', 'int', 'spd', 'cha', 'lck']) {
    assert.ok(Number.isInteger(s[k]) && s[k] >= 1 && s[k] <= 10, `${k} is an Int32 in [1,10]`);
  }
});

// 1c. Compact blob decodes appearance with exact L/R symmetry (rich fixture).
test('compact blob decodes appearance with L/R symmetry: reinaldo', () => {
  const g = decodeCat(bin('reinaldo.bin')).genes;
  assert.ok(g && g.pattern > 0, 'reinaldo decodes a fur pattern id');
  assert.strictEqual(g.slots.Eye_L, g.slots.Eye_R, 'Eye_L == Eye_R');
  assert.strictEqual(g.slots.Ear_L, g.slots.Ear_R, 'Ear_L == Ear_R');
  assert.strictEqual(g.slots.Brow_L, g.slots.Brow_R, 'Brow_L == Brow_R');
  assert.ok(g.slots.Body > 0 && g.slots.Head > 0, 'rich (non-default) frames are non-zero');
});

// 2. Name comes from the varint length, not a printable-run guess.
test('name: compact varint decodes the exact in-game names', () => {
  assert.strictEqual(decodeCat(bin('garik.bin')).name, 'Garik');
  assert.strictEqual(decodeCat(bin('churrito.bin')).name, 'Churrito');
});

// 3. Self-describing record: decodes name + 7 core stats WITHOUT double-decompressing
// (u32@0 == 19 path). Genes decode for reference, but with no known build word
// (offset 4 is the uid) buildOk is false, so appearanceVerified stays false.
test('self-describing: name + stats decode directly, appearance not verified (buildOk false)', () => {
  const c = decodeCat(bin('save_file_cat.bin'));
  assert.strictEqual(c.name, 'Lucina');
  assert.ok(c.stats, 'stats located in the self-describing record');
  assert.strictEqual(c.stats.str, 4);
  assert.strictEqual(c.stats.int, 7);
  assert.strictEqual(c.stats.lck, 5);
  assert.strictEqual(c.buildOk, false, 'no known build word in a self-describing record');
  assert.strictEqual(c.appearanceVerified, false, 'appearance never verified without buildOk');
});

// 4. Unrecognized format: corrupting the compressed signature (u32@4, which is the
// LZ4 stream start — see golden-save-test.js) makes the blob undecodable. It must
// degrade to buildOk/appearanceVerified false, null stats/genes, and never throw —
// honest failure, never a fabricated value.
test('unrecognized format (compressed signature corrupted): buildOk false, no throw, no fabrication', () => {
  const b = bin('garik.bin');
  b[4] = 0x0f; b[5] = 0x27; // corrupt the LZ4 stream start / format signature
  let c;
  assert.doesNotThrow(() => { c = decodeCat(b); });
  assert.strictEqual(c.buildOk, false);
  assert.strictEqual(c.appearanceVerified, false);
  assert.strictEqual(c.stats, null, 'no fabricated stats on an undecodable blob');
  assert.strictEqual(c.genes, null, 'no fabricated genes on an undecodable blob');
});

// 5. Malformed / truncated blobs: graceful partial object, no throw, no hang.
test('truncated/empty blobs do not throw', () => {
  assert.doesNotThrow(() => decodeCat(new Uint8Array(3)));
  assert.doesNotThrow(() => decodeCat(new Uint8Array(0)));
  const c = decodeCat(new Uint8Array(3));
  assert.strictEqual(c.appearanceVerified, false);
  assert.strictEqual(c.genes, null);
});

// 6. Stats anchoring: a decoy run of small u32 planted EARLIER in the record must
// not be mistaken for the stat block. jv scans a +/-320 window around offset 460
// and scores by proximity to 460 + a Cp status-string validation, so the real
// stats at offset 457 win and a decoy run at offset 100 (outside the window) is
// ignored — exactly the drift-resistance the golden harness relies on.
test('stats: decoy small-int run outside the jv window is ignored', () => {
  const b = bin('save_file_cat.bin');
  for (let i = 0; i < 7; i++) {              // plant u32 LE = 9, x7, at offset 100
    const o = 100 + i * 4;
    b[o] = 9; b[o + 1] = 0; b[o + 2] = 0; b[o + 3] = 0;
  }
  const c = decodeCat(b);
  assert.ok(c.stats, 'real stats still located despite the decoy');
  assert.deepStrictEqual(
    [c.stats.str, c.stats.dex, c.stats.con, c.stats.int, c.stats.spd, c.stats.cha, c.stats.lck],
    [4, 4, 6, 7, 4, 5, 5],
    'decoy run must not shadow the anchored stat block'
  );
});

// ---- AGE (birth day + current_day) ----
// The save stores NO age: the game derives it as `current_day - birth_day`, floored at 1
// (a newborn is age 1, never 0). decodeCat can only ever supply the birth day, because
// current_day is a save-wide property in a different table — catAge() pairs them.
test('age: catAge floors at 1 and refuses to guess from partial inputs', () => {
  const { catAge } = mod;
  assert.strictEqual(typeof catAge, 'function', 'catAge is exported');
  // Ground truth, read off the in-game cat sheet at current_day 227:
  //   Arcadia  birth 212 -> Age 15      Guiseppi birth 226 -> Age 1
  assert.strictEqual(catAge(212, 227), 15, 'Arcadia: 227 - 212 = 15');
  assert.strictEqual(catAge(226, 227), 1, 'Guiseppi: newborn reads 1');
  assert.strictEqual(catAge(227, 227), 1, 'born today floors to 1, not 0');
  // A birth day AHEAD of the current day is real (TimeMachineQuest runs the counter
  // backwards) and must floor to 1 rather than go negative.
  assert.strictEqual(catAge(254, 227), 1, 'birth day ahead of the day floors to 1, not -27');
  // -1 is the "no birth day" sentinel — an age must never be invented from it.
  assert.strictEqual(catAge(-1, 227), null, 'sentinel birth day -> no age');
  assert.strictEqual(catAge(-2, 227), null, 'any negative birth day -> no age');
  // Never invent an age from a missing half.
  assert.strictEqual(catAge(212, null), null, 'no current_day -> no age');
  assert.strictEqual(catAge(null, 227), null, 'no birth day -> no age');
  assert.strictEqual(catAge(undefined, undefined), null, 'neither -> no age');
});

test('age: a DEAD cat freezes at its age on the death day', () => {
  const { catAge } = mod;
  // Evelyn: birth 0, death 23 -> she died aged 23 and must NOT keep ageing with the calendar.
  assert.strictEqual(catAge(0, 227, 23), 23, 'dead cat reads its age at death, not 227');
  assert.strictEqual(catAge(212, 227, -1), 15, '-1 death sentinel = still alive, use current_day');
  assert.strictEqual(catAge(212, 227, null), 15, 'unknown death day falls back to current_day');
  assert.strictEqual(catAge(0, 227, 0), 1, 'died the day it was born still floors to 1');
});

test('life span: birth/death decode as i64 day stamps and status never guesses', () => {
  const c = decodeCat(bin('reinaldo.bin'));
  // i64, NOT a byte: a byte read reported one cat's -2 sentinel as "day 254".
  assert.ok(c.birthDay === null || Number.isInteger(c.birthDay), 'birthDay is an int or null');
  assert.ok(c.deathDay === null || Number.isInteger(c.deathDay), 'deathDay is an int or null');
  // status is only ever the three honest outcomes — 'alive' here means "no death stamp",
  // NOT "in the house" (that field is still unlocated).
  assert.ok([null, 'alive', 'dead'].includes(c.status), 'status is null | alive | dead');
  if (c.deathDay !== null) {
    assert.strictEqual(c.status, c.deathDay >= 0 ? 'dead' : 'alive', 'status follows the death stamp');
  }
  const age = mod.catAge(c.birthDay, 227, c.deathDay);
  assert.ok(age === null || age >= 1, 'age is null or at least 1 — never 0/negative');
});

if (failures) { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
console.log('\nAll save-decode behavior tests passed.');
