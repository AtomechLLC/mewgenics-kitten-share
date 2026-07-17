#!/usr/bin/env node
// golden-save-test.js — the DEC-04 fail-loud golden-save regression harness.
//
// Run: `node --test tools/golden-save-test.js` (zero dependency — node:test +
// node:assert only, matching the project's no-build ethos). Any failure exits
// non-zero so a CI/pre-commit run blocks a shipped layout drift.
//
// What it locks down (see .planning/.../01-RESEARCH.md "Phase Requirements -> Test Map"):
//   * GOLDEN (DEC-01/02): every committed fixture decodes to EXACT name/stats AND
//     appearance (coatId + 14 part-frames) from tools/fixtures/expected.json. A
//     shifted byte offset changes a value and FAILS LOUD instead of silently
//     shipping a wrong "this is your kitten" card.
//   * BUILD-GATE (DEC-03, T-01-06): a build-mutated blob (u32@4 -> unknown) yields
//     buildOk=false + appearanceVerified=false with no crash, name/class still decode.
//   * DoS (T-01-02): empty / 3-byte / truncated blobs return an object without throwing
//     or hanging (bounded wall-clock).
//   * RANGE/DRIFT (T-01-03): appearanceVerified requires buildOk && genesResolved &&
//     genes decoded && range/symmetry — an out-of-range or L/R-asymmetric decode can
//     never forge a verified look, and a corrupted blob degrades without throwing.
//   * PARITY (DEC-05): the harness require()s the very same public/kittenshare/save-decode.js
//     that kittenshare.html <script src>-loads, so page and tools can never drift.
//
// 01-05 LZ4 truth: each compact cats.data blob is [u32 size][u32 5090 build][LZ4 block].
// decodeCat decompresses first, then reads real stats + appearance. GENES_RESOLVED is
// now true; a valid build-5090 fixture legitimately verifies its appearance.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// PARITY (DEC-05): require the shared module by the same relative path the page uses.
const MODULE_REL = '../public/kittenshare/save-decode.js';
const mod = require(MODULE_REL);
const decodeCat = mod.decodeCat || mod;

const FIX = path.join(__dirname, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));

function bin(name) { return new Uint8Array(fs.readFileSync(path.join(FIX, name))); }

// Compare only the seven core stat fields (hp/mp/level are honestly null where the
// record does not expose a plausible value; expected.json omits them).
function coreStats(s) {
  if (!s) return null;
  return { str: s.str, dex: s.dex, con: s.con, int: s.int, spd: s.spd, cha: s.cha, lck: s.lck };
}
// Compare only the load-bearing appearance fields (pattern/coatPalette/classPalette
// + the 14 slots); the derived frame/palette convenience keys are not part of the
// golden. coatPalette (f8) is the real fur COLOR; pattern (f4) is the texture id.
function coreGenes(g) {
  if (!g) return null;
  return { pattern: g.pattern, coatPalette: g.coatPalette, classPalette: g.classPalette, slots: g.slots };
}

// ---- GOLDEN: every fixture decodes to its exact expected name/stats/appearance ----
for (const [file, exp] of Object.entries(expected.fixtures)) {
  test(`golden: ${file} decodes name/stats/appearance exactly (drift fails loud)`, () => {
    const c = decodeCat(bin(file));
    // Exact name — a one-byte varint/offset shift changes this and fails loud.
    assert.strictEqual(c.name, exp.name, `name mismatch for ${file}`);
    // Exact core stats.
    assert.deepStrictEqual(
      coreStats(c.stats),
      exp.stats ? coreStats(exp.stats) : null,
      `stats mismatch for ${file}`
    );
    // Exact appearance: coatId + all 14 part-frames.
    assert.deepStrictEqual(
      coreGenes(c.genes),
      exp.genes ? coreGenes(exp.genes) : null,
      `appearance mismatch for ${file}`
    );
    // Honest appearance gate per fixture (build-5090 verify true; self-describing false).
    assert.strictEqual(
      c.appearanceVerified, exp.appearanceVerified,
      `appearanceVerified mismatch for ${file}`
    );
  });
}

// ---- MUTATIONS: a slot-frame >= 300 is a mutation, resolved via mutations-catalog.js,
// L/R deduped. Any fixture carrying a `mutations` expectation must decode it EXACTLY
// (region/id/name) — a shifted offset or a catalog drift fails loud. Additive to the
// appearance golden above (coreGenes deliberately omits the mutations list).
for (const [file, exp] of Object.entries(expected.fixtures)) {
  if (!exp.mutations) continue;
  test(`golden: ${file} decodes its mutation list exactly (region/id/name)`, () => {
    const g = decodeCat(bin(file)).genes;
    assert.ok(g && Array.isArray(g.mutations), `${file} decodes a mutations array`);
    const got = g.mutations.map(m => ({ region: m.region, id: m.id, name: m.name }));
    assert.deepStrictEqual(got, exp.mutations, `mutation list mismatch for ${file}`);
    // Every listed mutation resolves in the vendored catalog (0 Unknown for the goldens).
    for (const m of g.mutations) {
      assert.strictEqual(m.inCatalog, true, `${file} ${m.region} id ${m.id} must be catalogued`);
    }
  });
}

// Honest Unknown labelling: an id absent from the catalog is never dropped or fabricated —
// it decodes to inCatalog=false with a "Unknown mutation #<id>" label.
test('mutations: an uncatalogued id decodes as an honest "Unknown mutation #id" (never dropped)', () => {
  const muts = mod.decodeMutations({}, 1, { Body: 999, Head: 0, Tail: 0,
    RearLeg_L: 0, RearLeg_R: 0, FrontLeg_L: 0, FrontLeg_R: 0, Eye_L: 0, Eye_R: 0,
    Brow_L: 0, Brow_R: 0, Ear_L: 0, Ear_R: 0, Mouth: 0 });
  assert.strictEqual(muts.length, 1, 'the one >=300 slot is reported');
  assert.strictEqual(muts[0].region, 'Body');
  assert.strictEqual(muts[0].inCatalog, false);
  assert.strictEqual(muts[0].name, 'Unknown mutation #999');
});

// L/R dedupe: symmetric paired slots (Eyes/Brows/Ears) list once per region.
test('mutations: symmetric L/R paired slots dedupe to one entry per region', () => {
  const cat = require('../public/kittenshare/mutations-catalog.js');
  const muts = mod.decodeMutations(cat, 1, { Body: 0, Head: 0, Tail: 0,
    RearLeg_L: 0, RearLeg_R: 0, FrontLeg_L: 0, FrontLeg_R: 0,
    Eye_L: 327, Eye_R: 327, Brow_L: 0, Brow_R: 0, Ear_L: 0, Ear_R: 0, Mouth: 0 });
  assert.strictEqual(muts.length, 1, 'Eye_L==Eye_R lists a single Eyes mutation');
  assert.strictEqual(muts[0].region, 'Eyes');
  assert.strictEqual(muts[0].name, 'Baby Blue Eyes');
});

// L/R symmetry is the appearance-decode fingerprint: the rich fixture's paired slots
// must be exactly equal (a shifted record breaks this and fails loud).
test('golden: reinaldo appearance is exactly L/R symmetric (Eye/Ear/Brow)', () => {
  const g = decodeCat(bin('reinaldo.bin')).genes;
  assert.ok(g && g.pattern > 0, 'reinaldo decodes a pattern');
  assert.ok(g.coatPalette >= 1 && g.coatPalette <= 49, 'reinaldo coatPalette is an in-range fur color');
  assert.strictEqual(g.slots.Eye_L, g.slots.Eye_R, 'Eye_L == Eye_R');
  assert.strictEqual(g.slots.Ear_L, g.slots.Ear_R, 'Ear_L == Ear_R');
  assert.strictEqual(g.slots.Brow_L, g.slots.Brow_R, 'Brow_L == Brow_R');
  assert.ok(g.slots.Body > 0 && g.slots.Head > 0, 'rich (non-default) frames are non-zero');
});

// Explicit coverage of the two-byte-varint UTF-16 name path (churrito).
test('golden: two-byte varint name path (churrito) decodes exactly', () => {
  assert.strictEqual(decodeCat(bin('churrito.bin')).name, 'Churrito');
});

// ---- AST-02 NO-REGRESSION under the 02-03 full-coverage chunk export ----
// The 02-03 export chunked every sprite's FULL frame range into
// public/kittenshare/parts/<Sprite>/<lo>-<hi>.json (+ patterns/CatTexture chunks). This
// asserts that every ground-truth VERIFIED fixture's decoded slot frames + fur pattern
// each (a) resolve to a real manifest range, (b) whose chunk file exists on disk, and
// (c) are present as an actual entry in that chunk — i.e. the full-coverage export
// renders the KNOWN cats' EXACT frames, unchanged from the corpus-union behavior. A
// regressed / dropped frame fails loud here instead of silently rendering a shared card
// with a missing part. The frame-0 box-guard fallback chunk must resolve for every
// sprite too. The exact name/stats/appearance goldens above still pin the decode itself;
// this adds the "does the full-coverage asset set still back these cats" guarantee.
// Uses the page's OWN resolver (lifted verbatim between the @resolver markers) so the
// page and this test can never drift on the SLOT->SPRITE / chunk-resolution logic.
const PARTS_DIR = path.join(__dirname, '..', 'public', 'kittenshare', 'parts');
const PATTERNS_DIR = path.join(__dirname, '..', 'public', 'kittenshare', 'patterns');

function liftResolver() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'kittenshare.html'), 'utf8');
  const m = html.match(/\/\* @resolver-start \*\/([\s\S]*?)\/\* @resolver-end \*\//);
  assert.ok(m, 'kittenshare.html contains the /* @resolver-start … @resolver-end */ block');
  // eslint-disable-next-line no-new-func
  return (new Function(m[1] + '\nreturn { resolveChunks, SLOT_TO_SPRITE };'))();
}
function rangeFor(ranges, frame) { return (ranges || []).find(r => frame >= r.lo && frame <= r.hi) || null; }
function chunkHasFrame(dir, file, frame) {
  const obj = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  return Object.prototype.hasOwnProperty.call(obj, String(frame));
}

for (const [file, exp] of Object.entries(expected.fixtures)) {
  if (!exp.appearanceVerified) continue;   // ground-truth VERIFIED cats only (the render targets)
  test(`no-regression: ${file}'s decoded frames all resolve to a real full-coverage chunk (unchanged)`, () => {
    const { resolveChunks, SLOT_TO_SPRITE } = liftResolver();
    const partsMan = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, 'manifest.json'), 'utf8'));
    const patternsMan = JSON.parse(fs.readFileSync(path.join(PATTERNS_DIR, 'manifest.json'), 'utf8'));
    const g = decodeCat(bin(file)).genes;
    assert.ok(g && g.slots, `${file} decodes appearance genes`);

    for (const label of Object.keys(SLOT_TO_SPRITE)) {
      const sprite = SLOT_TO_SPRITE[label];
      const frame = g.slots[label];
      const r = rangeFor(partsMan.slots[sprite], frame);
      assert.ok(r, `${file} ${label} frame ${frame} resolves to a ${sprite} manifest range`);
      assert.ok(fs.existsSync(path.join(PARTS_DIR, r.file)), `${file} ${label} chunk ${r.file} exists on disk`);
      assert.ok(chunkHasFrame(PARTS_DIR, r.file, frame),
        `${file} ${label} frame ${frame} present in ${r.file} (full coverage renders the exact frame)`);
      // Box-guard fallback (frame 0) must always resolve to a real chunk entry.
      const r0 = rangeFor(partsMan.slots[sprite], 0);
      assert.ok(r0 && chunkHasFrame(PARTS_DIR, r0.file, 0), `${sprite} frame-0 box-guard fallback present`);
    }

    // Fur PATTERN (CatTexture) frame resolves + is present in its chunk.
    const pr = rangeFor(patternsMan.slots.CatTexture, g.pattern);
    assert.ok(pr, `${file} pattern ${g.pattern} resolves to a CatTexture range`);
    assert.ok(chunkHasFrame(PATTERNS_DIR, pr.file, g.pattern),
      `${file} pattern ${g.pattern} present in ${pr.file}`);

    // The page resolver returns only real, existing files (selective lazy-load stays valid).
    const { partFiles, patternFiles } = resolveChunks(g.slots, g.pattern, partsMan, patternsMan);
    for (const f of partFiles) assert.ok(fs.existsSync(path.join(PARTS_DIR, f)), `resolved part chunk ${f} exists`);
    for (const f of patternFiles) assert.ok(fs.existsSync(path.join(PATTERNS_DIR, f)), `resolved pattern chunk ${f} exists`);
  });
}

// ---- BUILD-GATE (DEC-03 / T-01-06): unrecognized format degrades, never mis-verifies ----
// NOTE (01-05 framing correction): the compact container is [u32 size][LZ4 @4].
// u32@4 of the compressed blob (0x13e2 = 5090) is the LZ4 token stream's start —
// the compressed signature of every record's [u32 19 SELF_MARKER] header, which is
// why it reads a constant "5090" for the whole corpus. It is NOT a separable build
// word, so overwriting it corrupts the stream: an unrecognized-format blob can no
// longer decompress, and honestly degrades to buildOk=false + appearanceVerified=
// false with no partial name (no fabrication), never a crash.
test('build-gate: an unrecognized format signature degrades to buildOk/appearanceVerified false, no throw', () => {
  // Sanity: the unmutated fixture is a recognized build AND verifies its look.
  assert.strictEqual(decodeCat(bin('garik.bin')).buildOk, true, 'garik.bin is the recognized 5090 format');
  assert.strictEqual(decodeCat(bin('garik.bin')).build, 5090, 'reads the format signature 5090');
  assert.strictEqual(decodeCat(bin('garik.bin')).appearanceVerified, true, 'valid build-5090 fixture verifies');

  const b = bin('garik.bin');
  b[4] = 0x0f; b[5] = 0x27; b[6] = 0x00; b[7] = 0x00; // corrupt the format signature
  let c;
  assert.doesNotThrow(() => { c = decodeCat(b); });
  assert.strictEqual(c.buildOk, false, 'unrecognized format is not recognized');
  assert.strictEqual(c.appearanceVerified, false, 'unrecognized format can never claim a verified look');
  assert.strictEqual(c.genes, null, 'no fabricated genes on an undecodable blob');
  assert.strictEqual(c.stats, null, 'no fabricated stats on an undecodable blob');
});

// ---- DoS (T-01-02): malformed / truncated input returns gracefully, no hang ----
test('malformed/DoS: empty, 3-byte, and truncated blobs return an object without throwing or hanging', () => {
  const inputs = [
    new Uint8Array(0),
    new Uint8Array(3),
    bin('save_file_cat.bin').slice(0, 20), // a real blob chopped mid-record
  ];
  const start = Date.now();
  for (const u of inputs) {
    let c;
    assert.doesNotThrow(() => { c = decodeCat(u); }, 'malformed input must not throw');
    assert.ok(c && typeof c === 'object', 'returns a best-partial object');
    assert.strictEqual(c.appearanceVerified, false);
  }
  assert.ok(Date.now() - start < 2000, 'decodes within a wall-clock bound (no infinite loop)');
});

// ---- RANGE / DRIFT (T-01-03): the appearance gate cannot be spoofed ----
test('range/drift: the range + L/R-symmetry gate rejects out-of-range / asymmetric slots', () => {
  const inRange = mod._appearanceInRange;
  assert.strictEqual(typeof inRange, 'function', 'gate is exported for testing');

  const good = decodeCat(bin('reinaldo.bin')).genes.slots; // real symmetric slots
  assert.strictEqual(inRange(good), true, 'valid symmetric slots pass the gate');

  // Break L/R symmetry -> gate must reject.
  const asym = Object.assign({}, good, { Eye_R: good.Eye_R + 1 });
  assert.strictEqual(inRange(asym), false, 'asymmetric Eye_L/Eye_R is rejected');
  const asymEar = Object.assign({}, good, { Ear_L: good.Ear_L + 5 });
  assert.strictEqual(inRange(asymEar), false, 'asymmetric Ear_L/Ear_R is rejected');

  // Push a slot out of range (> 5000) -> gate must reject.
  const oor = Object.assign({}, good, { Body: 99999 });
  assert.strictEqual(inRange(oor), false, 'out-of-range Body frame is rejected');
  const neg = Object.assign({}, good, { Head: -1 });
  assert.strictEqual(inRange(neg), false, 'negative frame is rejected');
});

test('range/drift: a hand-corrupted blob never verifies appearance and never throws', () => {
  // Corrupt the compressed LZ4 stream of a valid build-5090 fixture: it can no
  // longer decompress/validate, so appearanceVerified must be false with no throw.
  const b = bin('reinaldo.bin');
  for (let i = 12; i < Math.min(b.length, 60); i++) b[i] = 0xff;
  let c;
  assert.doesNotThrow(() => { c = decodeCat(b); });
  assert.strictEqual(c.appearanceVerified, false, 'corrupted bytes never verify appearance');

  // And the appearanceVerified invariant holds for every committed fixture.
  for (const file of Object.keys(expected.fixtures)) {
    const d = decodeCat(bin(file));
    if (d.appearanceVerified) {
      assert.strictEqual(d.buildOk, true, `${file}: verified look requires buildOk`);
      assert.strictEqual(d.genesResolved, true, `${file}: verified look requires genesResolved`);
      assert.ok(d.genes, `${file}: verified look requires decoded genes`);
    }
  }
});

// ---- PARITY (DEC-05): page and tools decode via the SAME module file ----
test('parity (DEC-05): harness + page use the same public/kittenshare/save-decode.js', () => {
  const resolved = require.resolve(MODULE_REL);
  const norm = resolved.replace(/\\/g, '/');
  assert.ok(
    norm.endsWith('public/kittenshare/save-decode.js'),
    `harness must require the shared module; resolved to ${norm}`
  );

  // The page <script src>-loads the identical file (relative to public/).
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'kittenshare.html'), 'utf8');
  assert.ok(
    /<script[^>]+src="kittenshare\/save-decode\.js"/.test(page),
    'kittenshare.html must <script src> the same kittenshare/save-decode.js the harness requires'
  );
  // The page must also load the LZ4 decompressor the decoder depends on.
  assert.ok(
    /<script[^>]+src="vendor\/lz4\.js"/.test(page),
    'kittenshare.html must <script src> vendor/lz4.js before save-decode.js'
  );

  // Prove it is the very same file on disk (not two copies that could drift).
  const pageModulePath = path.join(__dirname, '..', 'public', 'kittenshare', 'save-decode.js');
  assert.strictEqual(
    fs.realpathSync(pageModulePath),
    fs.realpathSync(resolved),
    'the page <script src> and the required module resolve to one file on disk'
  );
});
