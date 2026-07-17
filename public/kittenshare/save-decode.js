// save-decode.js — the single shared Mewgenics cat-blob decoder.
//
// One module, two loaders (DEC-05): the KittenShare page pulls it in with a
// <script src>, and the Node tools/tests pull it in with require(). Both call the
// same decodeCat() so the page, the tools, and the golden harness can never drift.
//
// LZ4 TRUTH (01-05 gap closure — supersedes the 01-03/01-04 NO-GOs):
//   Every compact `cats.data` blob is
//     [u32 decompressedSize LE][u32 5090 build LE][LZ4-block-compressed CatData]
//   Both prior NO-GOs ("appearance genes / stats absent") were artifacts of never
//   decompressing: LZ4 keeps ASCII names/ability-ids as literals (so they read raw)
//   while stats and appearance part-frames are back-referenced. Decompress first
//   (vendor/lz4.js decompressCatBlob) and, on the real 1,316-cat save, stats decode
//   for 100% of cats and appearance for ~99% with exact L/R part symmetry.
//
// DEC-03 — three DISTINCT flags, never collapsed:
//   * buildOk       = do we recognize the save format? (compact blob only:
//                     u32@4 in KNOWN_BUILDS; the self-describing record keeps its
//                     uid at offset 4 and exposes no known build word, so build
//                     stays null / buildOk false there)
//   * genesResolved = has the gene/appearance layout been located? (YES as of 01-05)
//   * appearanceVerified = buildOk AND genesResolved AND genes decoded AND every
//                     range + L/R-symmetry check passed
// Only when all three hold may the UI claim a portrait is the cat's true look.
//
// No fabrication: any failure path leaves the corresponding field null. A blob
// that fails to decompress or validate degrades honestly (null + flags false),
// never a guessed value. hp is read from the record only when it validates as a
// plausible small positive int; mp/level are not yet located and stay null.
//
// Untrusted-input hygiene (T-01-02/-04): every read is bounded vs the buffer
// length, every loop is capped, the whole body is wrapped in try/catch to return
// a best-partial object, and it makes NO network request — decode is fully offline.

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.SaveDecode = api;
    window.decodeCat = api.decodeCat; // page global: <script src> then decodeCat(data)
    window.catAge = api.catAge;       // page global: catAge(birthDay, current_day, deathDay)
  }
})(this, function () {
  'use strict';

  // ---- format + range constants ----
  var SELF_MARKER = 19;                 // u32@0 of an already-decompressed self-describing record
  var KNOWN_BUILDS = new Set([5090]);   // save formats we recognize (DEC-03 build gate)
  var GENES_RESOLVED = true;            // 01-05: appearance/gene layout LOCATED in the decompressed record
  var SLOT_FRAME_MAX = 5000;            // a decoded part-frame index above this is out-of-range (T-01-03)
  // Two u32 sentinels mark a legitimately REMOVED/hidden part (e.g. a no-tail or
  // no-brows mutation like anophthalmia). They are valid appearance data, NOT a decode
  // error — so the range gate must accept them even though they exceed SLOT_FRAME_MAX.
  var SLOT_REMOVED = new Set([0xFFFFFFFE, 0xFFFFFFFF]);

  var CLASSES = ['Fighter', 'Mage', 'Hunter', 'Druid', 'Tank', 'Medic', 'Monk',
    'Thief', 'Jester', 'Psychic', 'Necromancer', 'Tinkerer', 'Butcher', 'Colorless'];

  // slot index (1..14) -> label (catparts.swf part order)
  var SLOTS = { 1: 'Body', 2: 'Head', 3: 'Tail', 4: 'RearLeg_L', 5: 'RearLeg_R',
    6: 'FrontLeg_L', 7: 'FrontLeg_R', 8: 'Eye_L', 9: 'Eye_R', 10: 'Brow_L',
    11: 'Brow_R', 12: 'Ear_L', 13: 'Ear_R', 14: 'Mouth' };

  // ---- mutation model (mutation-spike, 2026-07-14) ----
  // A part-frame >= 300 IS a mutation (base parts are 1..250); the frame value is the
  // block key in data/mutations/<category>.gon (see mutations-catalog.js). The fur
  // PATTERN field (genes.pattern) is the same story for category "texture". Two
  // sentinels (0xFFFFFFFE hidden / 0xFFFFFFFF) mark a removed part — never a mutation.
  var MUT_MIN = 300;           // catgen.gon: base part sets are 250 wide; mutations start at 300
  var MUT_MAX = 0x10000;       // real mutation ids top out ~1500; anything above is a sentinel
  // Each appearance slot -> { region (deduped display group), category (gon file). The 4
  // leg slots split into two logical regions: rear "Legs" and front "Arm"; the paired
  // eye/brow/ear slots each collapse to one region so a symmetric mutation is reported once.
  var MUT_SLOT = {
    Body: { region: 'Body', cat: 'body' }, Head: { region: 'Head', cat: 'head' }, Tail: { region: 'Tail', cat: 'tail' },
    RearLeg_L: { region: 'Legs', cat: 'legs' }, RearLeg_R: { region: 'Legs', cat: 'legs' },
    FrontLeg_L: { region: 'Arm', cat: 'legs' }, FrontLeg_R: { region: 'Arm', cat: 'legs' },
    Eye_L: { region: 'Eyes', cat: 'eyes' }, Eye_R: { region: 'Eyes', cat: 'eyes' },
    Brow_L: { region: 'Brows', cat: 'eyebrows' }, Brow_R: { region: 'Brows', cat: 'eyebrows' },
    Ear_L: { region: 'Ears', cat: 'ears' }, Ear_R: { region: 'Ears', cat: 'ears' }, Mouth: { region: 'Mouth', cat: 'mouth' }
  };
  function isMutId(v) { return v >= MUT_MIN && v < MUT_MAX; }

  // ---- primitive readers (bounded by callers) ----
  function Fe(e, t) { return (e[t] | (e[t + 1] << 8) | (e[t + 2] << 16) | (e[t + 3] << 24 >>> 0)) >>> 0; }
  function GA(e, t) { return new DataView(e.buffer, e.byteOffset, e.byteLength).getFloat32(t, true); }

  // ---- lazy LZ4 accessor: window.LZ4 on the page, require() in Node ----
  function getLZ4() {
    if (typeof window !== 'undefined' && window.LZ4) return window.LZ4;
    if (typeof require === 'function') {
      try { return require('../vendor/lz4.js'); } catch (e) { return null; }
    }
    return null;
  }

  // ---- lazy lz-string accessor: window.LZString on the page, require() in Node ----
  // Mirrors getLZ4 so the share codec stays drift-free across both loaders. Used only
  // for the share payload (encodeShare/decodeShare); its compressToEncodedURIComponent
  // / decompressFromEncodedURIComponent emit/consume an already URI-safe alphabet, so
  // no extra btoa/char-swap step is needed (share-spec §5).
  function getLZString() {
    if (typeof window !== 'undefined' && window.LZString) return window.LZString;
    if (typeof require === 'function') {
      try { return require('../vendor/lz-string.min.js'); } catch (e) { return null; }
    }
    return null;
  }

  // ---- name: [u64 len][2*len UTF-16LE] near the record head (decompressed buffer) ----
  function nameUtf16(e) {
    for (var i = 8; i < 48; i++) {
      var len = Fe(e, i);
      if (len >= 1 && len <= 20 && Fe(e, i + 4) === 0) {
        var ok = true, s = '';
        for (var c = 0; c < len; c++) {
          var lo = e[i + 8 + c * 2], hi = e[i + 8 + c * 2 + 1];
          if (hi !== 0 || lo < 32 || lo >= 127) { ok = false; break; }
          s += String.fromCharCode(lo);
        }
        if (ok && s.length === len) return s;
      }
    }
    return null;
  }

  // ---- class / gender / abilities from ascii tokens in the record ----
  // Class detection must NOT use a bare substring test: ability-id tokens embed
  // class names ("FighterTaunt", "BasicMelee_Fighter", "PathOfTheThief", …) and
  // would win over the real class field. A class name only counts when it appears
  // as a standalone word (no identifier char [A-Za-z0-9_] on either side).
  var WORD_CH = /[A-Za-z0-9_]/;
  function classInToken(str) {
    for (var k = 0; k < CLASSES.length; k++) {
      var name = CLASSES[k];
      var idx = str.indexOf(name);
      while (idx !== -1) {
        var before = idx > 0 ? str.charAt(idx - 1) : '';
        var after = idx + name.length < str.length ? str.charAt(idx + name.length) : '';
        if (!WORD_CH.test(before) && !WORD_CH.test(after)) return name;
        idx = str.indexOf(name, idx + 1);
      }
    }
    return '';
  }

  function scanAsciiFields(u, n, abilityIds) {
    var ascii = [], cur = '', curStart = 0;
    var voiceOff = -1;                              // byte offset of the voice-set token
    var MAX = Math.min(n, 65536);                   // cap the scan (DoS hygiene)
    for (var i = 0; i < MAX; i++) {
      var c = u[i];
      if (c >= 32 && c < 127) { if (!cur) curStart = i; cur += String.fromCharCode(c); }
      else {
        if (cur.length >= 3) {
          ascii.push(cur);
          // First standalone voice-set token ("male11"/"female50") — records its byte
          // offset so the real GENDER enum can be read at a fixed distance before it.
          if (voiceOff < 0 && /^(male|female)\d+$/.test(cur)) voiceOff = curStart;
        }
        cur = '';
      }
    }
    if (cur.length >= 3) {
      ascii.push(cur);
      if (voiceOff < 0 && /^(male|female)\d+$/.test(cur)) voiceOff = curStart;
    }
    var blobAscii = ascii.join(' ');

    var cls = '', voiceGender = '';
    for (var j = 0; j < ascii.length; j++) {
      var str = ascii[j];
      if (!cls) cls = classInToken(str);
      var vg = str.match(/(male|female)(\d+)/);
      if (vg && !voiceGender) voiceGender = vg[1];
    }

    // GENDER — the real gender is an enum u32 at voiceOff-400 (0=male,1=female,2=neutral),
    // a fixed-size field before the voice set. The voice-SET name ("male11"/"female50")
    // is NOT the gender — a ♀ cat can carry a male voice set (e.g. Julie), so the old
    // voice-token read mislabelled ~45% of females. Verified: this enum is a clean
    // {0,1,2} for 100% of voice-cats and matches in-game (Ferb ♂=0, Brimp/Julie ♀=1).
    // Fall back to the voice token only if the enum is unreadable (short record / out of
    // the {0,1,2} range) so a truncated blob still gets a best-effort answer.
    var GENDER_ENUM = { 0: 'male', 1: 'female', 2: 'neutral' };
    var gender = voiceGender;
    if (voiceOff >= 400 && voiceOff - 400 + 4 <= n) {
      var gv = Fe(u, voiceOff - 400);
      if (GENDER_ENUM.hasOwnProperty(gv)) gender = GENDER_ENUM[gv];
    }

    // Abilities: match known ids, longest first (ABILITY_IDS is pre-sorted). The
    // serializer drops each string's final byte, so also accept id minus last char.
    var abilities = [];
    for (var a = 0; a < abilityIds.length; a++) {
      if (abilities.length >= 8) break;
      var id = abilityIds[a];
      var hit = blobAscii.indexOf(id) !== -1 ||
        (id.length >= 5 && blobAscii.indexOf(id.slice(0, -1)) !== -1);
      if (!hit) continue;
      var dup = false;
      for (var d = 0; d < abilities.length; d++) {
        if (abilities[d].indexOf(id) !== -1 || id.indexOf(abilities[d]) !== -1) { dup = true; break; }
      }
      if (!dup) abilities.push(id);
    }

    // Size trait: the game shows a size-name PREFIX ("Lil' …" / "Tiny …") for cats
    // with a size-shrinking birth-defect disorder. That prefix string + its exact
    // wording live only in compiled game code (not in the save or the gpak data —
    // see docs), so it can't be faithfully reproduced. What IS decodable is the
    // disorder itself: PrimordialDwarf / Dwarfism are stored as standalone ASCII
    // tokens in the record. We surface an honest "tiny" size trait naming the real
    // disorder, rather than fabricating the game's exact prefix. Matched with the
    // same substring/last-byte-drop tolerance used for abilities (the serializer
    // drops each string's final byte); both ids are distinctive enough not to
    // collide. Only small disorders exist (no giant defect in the birth-defect pool).
    var SIZE_DISORDERS = [
      { id: 'PrimordialDwarf', label: 'Primordial Dwarf' },
      { id: 'Dwarfism', label: 'Dwarfism' }
    ];
    var sizeTrait = null;
    for (var z = 0; z < SIZE_DISORDERS.length; z++) {
      var did = SIZE_DISORDERS[z].id;
      if (blobAscii.indexOf(did) !== -1 ||
          (did.length >= 5 && blobAscii.indexOf(did.slice(0, -1)) !== -1)) {
        sizeTrait = { kind: 'small', disorder: SIZE_DISORDERS[z].label };
        break;
      }
    }

    // Equipped items: item KEYS are stored as standalone ascii tokens (like abilities).
    // Map each to its { kind, frame, name } via ITEM_VOCAB (item-ids.js). `kind` selects
    // the on-cat sprite — head/face/neck/weapon are WORN; trinket/modifier are inventory-
    // only. Matched exact, or minus the serializer's dropped final byte (via the lookup).
    var items = [];
    var ivLookup = getItemLookup();   // scanAsciiFields has no opts — uses global/require vocab
    if (ivLookup) {
      var seenI = {};
      for (var q = 0; q < ascii.length; q++) {
        var hitI = ivLookup[ascii[q]];
        if (hitI && !seenI[hitI.key]) { seenI[hitI.key] = 1; items.push(hitI); }
        if (items.length >= 12) break;
      }
    }

    return { cls: cls, gender: gender, abilities: abilities, sizeTrait: sizeTrait, items: items };
  }

  // ---- stats (jv) + status-string validator (Cp) on the DECOMPRESSED record ----
  // Cp: at off+84 there must be a length-prefixed ASCII status-effect name
  // (u32 len @+84, u32 0 @+88, len in (0,64], len printable-ASCII bytes).
  function Cp(e, t) {
    var n = t + 84; if (n + 13 > e.length) return false;
    var r = Fe(e, n); if (Fe(e, n + 4) !== 0 || r === 0 || r > 64) return false;
    var s = n + 8; if (s + r + 4 > e.length) return false;
    for (var i = 0; i < r; i++) { var a = e[s + i]; if (a < 32 || a >= 127) return false; }
    return true;
  }

  // jv: 7 consecutive Int32 LE in [1,10] near offset 460 (STR/DEX/CON/INT/SPD/CHA/LCK).
  // Score = 1000 - |u-460| + sum*0.1; prefer a Cp-validated candidate. hp is the u32
  // right after the Cp status string, but only when it reads as a plausible small
  // positive int (1..999) — otherwise honestly null (mp/level unlocated -> null).
  function jv(e, t, n) {
    t = t || 460; n = n || 320;
    var r = e.length; if (r < 28) return null;
    var o = new DataView(e.buffer, e.byteOffset, e.byteLength);
    var cands = []; var lo = Math.max(0, t - n), hi = Math.min(r - 28, t + n);
    for (var u = lo; u <= hi; u++) {
      var ok = true, p = [];
      for (var w = 0; w < 7; w++) { var S = o.getInt32(u + w * 4, true); if (S < 1 || S > 10) { ok = false; break; } p.push(S); }
      if (!ok) continue;
      var h = Math.abs(u - t), g = p.reduce(function (x, y) { return x + y; }, 0);
      cands.push({ off: u, vals: p, score: 1000 - h + g * 0.1 });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.score - a.score; });
    var l = cands[0];
    if (!Cp(e, l.off)) { var v = cands.find(function (c) { return Cp(e, c.off); }); if (v) l = v; }

    // hp: u32 right after the Cp-validated status string (off+84 -> len u32 -> zero
    // u32 -> len bytes -> hp). Only trust a plausible small positive int; else null.
    var hp = null;
    if (Cp(e, l.off)) {
      var slen = Fe(e, l.off + 84);
      var hpOff = l.off + 84 + 8 + slen;
      if (hpOff + 4 <= e.length) {
        var hv = Fe(e, hpOff);
        if (hv >= 1 && hv <= 999) hp = hv;
      }
    }
    return {
      str: l.vals[0], dex: l.vals[1], con: l.vals[2], int: l.vals[3],
      spd: l.vals[4], cha: l.vals[5], lck: l.vals[6],
      hp: hp, mp: null, level: null
    };
  }

  // ---- appearance (RO base locator + Wv slot reader) on the DECOMPRESSED record ----
  // The appearance record's 3 leading fields are (01-06 coat-decode spike):
  //   f0  float32  coat/body scale (0.05..20)
  //   f4  u32      PATTERN — fur texture id (1..706), repeated as each part-record's
  //                2nd u32 (the "texture" field). NOT a color.
  //   f8  u32      coatPalette — the REAL fur COLOR: a direct row index into
  //                textures/palette.png, range 1..49.
  //   f12 u32      classPalette — class accent color row (50..68), or 0xFFFFFFFF = none.
  // then 14 part records @f16+s*20, each [frame u32, texture u32, ...].
  //
  // RO locator fix (01-06): the old gate `s < 0.05 || s > 20` let NaN scales PASS
  // (NaN compares false) and its part-matcher counted `hh === 0` (empty regions), so
  // every "Colorless" cat (whose coat region is often zeros) landed on a bogus base
  // ~12 bytes late. Fix: require the scale be FINITE and in [0.05,20], and require
  // >=3 of the 14 part records' 2nd u32 == the pattern value (not the zero-region
  // count). This raises correct base-location from ~694 to 1311/1316 corpus cats.
  function RO(e) {
    var t = e.length, Rp = 296; if (t < Rp) return null;
    var best = -1, base = null;
    for (var o = 0; o <= t - Rp; o++) {
      var s = GA(e, o), i = Fe(e, o + 4), a = Fe(e, o + 8), l = Fe(e, o + 12);
      if (!(Number.isFinite(s) && s >= 0.05 && s <= 20) || i === 0 || i > 2e4 || a > 500 || (l !== 4294967295 && l > 5000)) continue;
      var c = 0;
      for (var f = 0; f < 14; f++) { var p = o + 16 + f * 20, hh = Fe(e, p + 4); if (hh === i) c++; }
      if (c < 3) continue;
      var score = c * 1000 + o;
      if (score > best) { best = score; base = o; }
    }
    return base;
  }
  function Wv(e) {
    var t = RO(e); if (t === null) return null;
    var pattern = Fe(e, t + 4), coatPalette = Fe(e, t + 8);
    var rawClass = Fe(e, t + 12);
    var classPalette = rawClass === 4294967295 ? -1 : rawClass; // 0xFFFFFFFF = none
    var slots = {};
    // Each part record is 20 bytes: [frame u32, texture u32, _ u32, field3 u32, _ u32].
    // field3 (offset +12) is the per-leg `claws` gene (num_claws 1..10) on the four leg
    // slots and 0 everywhere else — the game toggles the claw sprite from it. Captured so
    // the render/UI can tell which legs are genetically clawed (see catgen.gon num_claws).
    var claws = {};
    for (var s = 0; s < 14; s++) {
      var nm = SLOTS[s + 1];
      slots[nm] = Fe(e, t + 16 + s * 20);
      if (/Leg/.test(nm)) claws[nm] = Fe(e, t + 16 + s * 20 + 12);
    }
    return { baseOffset: t, pattern: pattern, coatPalette: coatPalette, classPalette: classPalette, slots: slots, claws: claws };
  }

  // ---- life span: birth day + death day (the tail's two i64 day stamps) ----
  // Both are signed 64-bit LITTLE-ENDIAN ints in the record's fixed tail:
  //   birthDay @ len-103, deathDay @ len-95
  // They are i64, NOT bytes. Reading a byte appeared to work only because most values are
  // 0..227 — it silently mangled two real cases: a NEGATIVE sentinel (one cat's birthDay is
  // -2, which a byte read reports as 254 = "day 254") and any campaign past day 255.
  //
  // deathDay < 0 means the cat has not died. A cat with a real deathDay gets a plausible age
  // at death on this corpus (64 cats died at 1-20, 14 at 21-30), which is what confirms the
  // field. Living-but-ancient cats exist (age 60+), so "not dead" is NOT the same as "in the
  // house" — that distinction is a separate, still-unlocated field.
  //
  // NOT every cat shares this tail layout: ~33 read as absurd values (7.2e16), so both
  // fields are range-checked and degrade to null rather than emitting nonsense.
  var BIRTH_DAY_FROM_END = 103;
  var DEATH_DAY_FROM_END = 95;
  var DAY_MAX = 100000;              // far beyond any real campaign; rejects mis-layout garbage

  function readI64(e, off) {
    if (!e || off < 0 || off + 8 > e.length) return null;
    // Hand-assembled: this module must run on plain Uint8Array in both loaders, and BigInt
    // round-tripping per cat is needless. Low 4 bytes unsigned + high 4 bytes signed.
    var lo = (e[off] | (e[off + 1] << 8) | (e[off + 2] << 16)) + (e[off + 3] * 16777216);
    var hi = (e[off + 4] | (e[off + 5] << 8) | (e[off + 6] << 16)) | (e[off + 7] << 24);
    if (hi === 0) return lo;                       // small positive — the common case
    if (hi === -1) return lo - 4294967296;         // small negative (sentinels like -1/-2)
    return hi * 4294967296 + lo;                   // large: only used to fail the range check
  }
  // A day stamp we trust: a whole number in [0, DAY_MAX]. Negative = sentinel (no such event);
  // anything else = this cat's tail is not the layout we know.
  function readDayStamp(e, fromEnd) {
    var v = readI64(e, e ? e.length - fromEnd : -1);
    if (v === null || !Number.isFinite(v) || Math.floor(v) !== v) return null;
    if (v < 0) return -1;                          // normalise every sentinel to -1
    return v <= DAY_MAX ? v : null;                // out of range => unknown layout
  }

  // ---- house roster (which cats are actually IN the house) ----
  // The `cats` table is every cat that ever existed (ancestors, the dead, the long gone), so
  // it cannot answer "who is in my house" — and `alive` is NOT a proxy: hundreds of not-dead
  // cats are 60+ day-old archive entries. The roster lives in `files.house_state`, which
  // places each resident in a room. Record layout, read off the raw bytes:
  //     [i64 catKey][i64 strLen][strLen ascii room chars][position floats...]
  // e.g. key 1428 -> len 5 -> "Attic". Rooms seen: Attic, Floor1_Small, Floor1_Large,
  // Floor2_Large.
  //
  // Verified against a player's stated house: Guiseppi/Ferb/Ernie/Kramer all appear, and the
  // ancestor ALSO named Kramer (a different key, age 114) correctly does NOT. Every one of
  // the 81 residents decodes as alive with a plausible age (1..35) — an accidental pattern
  // match would not produce that.
  //
  // Scans every offset rather than walking a header: the file interleaves furniture and room
  // data we do not model, and a record is only accepted when the key, the length AND the room
  // name all validate — so a false positive would have to fake all three.
  var HOUSE_ROOM_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
  function readI64At(e, o) {
    if (!e || o < 0 || o + 8 > e.length) return null;
    var lo = (e[o] | (e[o + 1] << 8) | (e[o + 2] << 16)) + (e[o + 3] * 16777216);
    var hi = (e[o + 4] | (e[o + 5] << 8) | (e[o + 6] << 16)) | (e[o + 7] << 24);
    if (hi === 0) return lo;
    if (hi === -1) return lo - 4294967296;
    return hi * 4294967296 + lo;
  }
  // -> [{ key, room }] for each resident. Empty array on a missing/foreign blob (never throws).
  function parseHouseRoster(e) {
    var out = [];
    if (!e || !e.length) return out;
    var seen = {};
    for (var o = 0; o + 16 <= e.length; o++) {
      var key = readI64At(e, o);
      if (!Number.isInteger(key) || key < 1 || key > 100000) continue;
      var len = readI64At(e, o + 8);
      if (!Number.isInteger(len) || len < 3 || len > 24) continue;
      if (o + 16 + len > e.length) continue;
      var s = '', ok = true;
      for (var i = 0; i < len; i++) {
        var ch = e[o + 16 + i];
        if (ch < 32 || ch > 126) { ok = false; break; }
        s += String.fromCharCode(ch);
      }
      if (!ok || !HOUSE_ROOM_RE.test(s)) continue;
      if (seen[key]) continue;                 // a cat is in exactly one room
      seen[key] = 1;
      out.push({ key: key, room: s });
    }
    return out;
  }

  // age = current_day - birth_day, floored at 1 (the game never shows age 0; a newborn is 1).
  // A DEAD cat's age is frozen at death, so pass its deathDay as the "now" — otherwise a cat
  // that died on day 23 would keep ageing to 227 in the browser.
  // Returns null unless the inputs are real — never a guessed age.
  function catAge(birthDay, currentDay, deathDay) {
    if (!Number.isInteger(birthDay) || birthDay < 0) return null;
    var end = (Number.isInteger(deathDay) && deathDay >= 0) ? deathDay : currentDay;
    if (!Number.isInteger(end)) return null;
    return Math.max(1, end - birthDay);
  }

  // Range + L/R-symmetry gate: every frame a non-negative int <= SLOT_FRAME_MAX AND
  // the paired slots equal. Any violation flips appearanceVerified false (T-01-03).
  function appearanceInRange(slots) {
    var keys = Object.keys(slots);
    for (var i = 0; i < keys.length; i++) {
      var v = slots[keys[i]];
      if (!Number.isInteger(v)) return false;
      // Reject negatives BEFORE the sentinel test. A real decode reads every slot as an
      // UNSIGNED u32 (Fe/getUint32), so a genuine removed-part sentinel always arrives as
      // 4294967294/4294967295 — never as a negative. Testing the sentinel first via
      // `v >>> 0` would coerce -1 to 0xFFFFFFFF (and -2 to 0xFFFFFFFE), letting a negative
      // frame masquerade as "removed" and skip the range gate entirely (T-01-03).
      if (v < 0) return false;
      // A removed-part sentinel is valid appearance data (see SLOT_REMOVED); only a
      // genuinely out-of-range frame (above the max, and NOT a sentinel) is a bad decode.
      if (SLOT_REMOVED.has(v)) continue;
      if (v > SLOT_FRAME_MAX) return false;
    }
    return slots.Eye_L === slots.Eye_R && slots.Ear_L === slots.Ear_R && slots.Brow_L === slots.Brow_R;
  }

  // ---- mutation catalog accessor: window/global on the page, require() in Node ----
  // Same lazy pattern as getLZ4/ABILITY_IDS so the module stays drift-free across both
  // loaders. opts.mutationsCatalog wins (test injection), then a global, then require.
  function getMutationsCatalog(opts) {
    if (opts && opts.mutationsCatalog) return opts.mutationsCatalog;
    if (typeof MUTATIONS_CATALOG !== 'undefined') return MUTATIONS_CATALOG;
    if (typeof window !== 'undefined' && window.MUTATIONS_CATALOG) return window.MUTATIONS_CATALOG;
    if (typeof require === 'function') {
      try { return require('./mutations-catalog.js'); } catch (e) { return null; }
    }
    return null;
  }

  // Equipped-item vocab accessor (same lazy pattern as the mutation catalog).
  function getItemVocab(opts) {
    if (opts && opts.itemVocab) return opts.itemVocab;
    if (typeof ITEM_VOCAB !== 'undefined') return ITEM_VOCAB;
    if (typeof window !== 'undefined' && window.ITEM_VOCAB) return window.ITEM_VOCAB;
    if (typeof require === 'function') {
      try { return require('./item-ids.js').ITEM_VOCAB; } catch (e) { return null; }
    }
    return null;
  }
  // Build (and cache) a token -> {key,kind,frame,name} lookup from the item vocab. Keys
  // are matched exact AND minus the serializer's dropped final byte, so a blob that stored
  // "ProwlersCa" still resolves. Cached per vocab object so it is built at most once.
  var _itemLookupCache = null, _itemLookupSrc = null;
  function getItemLookup(opts) {
    var vocab = getItemVocab(opts);
    if (!vocab) return null;
    if (_itemLookupCache && _itemLookupSrc === vocab) return _itemLookupCache;
    var map = {};
    for (var key in vocab) {
      if (!Object.prototype.hasOwnProperty.call(vocab, key)) continue;
      var v = vocab[key];
      // `stats` (optional) = the item's flat bonuses to the 7 core stats. Carried through so
      // the card can show WHERE a stat modifier comes from; absent when the item grants none.
      var rec = { key: key, kind: v.kind, frame: v.frame, name: v.name };
      if (v.stats) rec.stats = v.stats;
      if (!(key in map)) map[key] = rec;                       // exact
      var trunc = key.slice(0, -1);                            // minus dropped final byte
      if (trunc.length >= 4 && !(trunc in map)) map[trunc] = rec;
    }
    _itemLookupCache = map; _itemLookupSrc = vocab;
    return map;
  }

  // Resolve one mutation id to a human label. Honest: an id absent from the catalog is
  // labelled "Unknown mutation #<id>" (never dropped, never fabricated). A catalogued
  // but un-named entry (the "common" 400-441 stat-mod band has no in-game name) falls
  // back to its stat effect, then its type — always a non-empty string.
  function mutLabel(entry, id) {
    if (entry) {
      if (entry.name) return entry.name;
      if (entry.effect) return entry.effect;
      if (entry.type) return entry.type.charAt(0).toUpperCase() + entry.type.slice(1) + ' part';
    }
    return 'Unknown mutation #' + id;
  }

  // decodeMutations(catalog, pattern, slots) -> [{ region, slot, category, id, name,
  // effect, type, inCatalog }]. Walks the 14 part-frames (in SLOTS order) plus the fur
  // PATTERN field; a frame >= 300 (and not a hidden sentinel) is a mutation. L/R pairs
  // are deduped by region+id so a symmetric mutation lists once (a genuinely one-sided
  // mutation still lists both, being distinct region+id pairs).
  function decodeMutations(catalog, pattern, slots) {
    var muts = [], seen = {};
    catalog = catalog || {};
    function add(region, category, slotLabel, id) {
      if (!isMutId(id)) return;                 // base part or hidden sentinel — not a mutation
      var key = region + ':' + id;
      if (seen[key]) return;                    // dedupe symmetric L/R
      seen[key] = true;
      var entry = (catalog[category] || {})[id] || null;
      muts.push({
        region: region, slot: slotLabel, category: category, id: id,
        name: mutLabel(entry, id),
        effect: entry && entry.effect ? entry.effect : '',
        type: entry ? entry.type : 'unknown',
        inCatalog: !!entry
      });
    }
    for (var s = 0; s < 14; s++) {
      var label = SLOTS[s + 1], m = MUT_SLOT[label];
      if (m) add(m.region, m.cat, label, slots[label]);
    }
    // Fur / texture mutation rides in the pattern field, category "texture".
    add('Fur', 'texture', 'Fur', pattern);
    return muts;
  }

  // ---- public: decode one cat blob into the shared contract ----
  // decodeCat(u8[, opts]) -> { name, cls, gender, abilities, stats, genes,
  //                            build, buildOk, genesResolved, appearanceVerified }
  // opts.abilityIds overrides the ability vocabulary (Node); otherwise the global
  // ABILITY_IDS (kittenshare/ability-ids.js) is used on the page, else [].
  function decodeCat(u8, opts) {
    var abilityIds = (opts && opts.abilityIds) ||
      (typeof ABILITY_IDS !== 'undefined' ? ABILITY_IDS : []);

    var out = {
      name: '(unnamed)', cls: '', gender: '', abilities: [], sizeTrait: null, items: [],
      stats: null, genes: null,
      build: null, buildOk: false,
      genesResolved: GENES_RESOLVED, appearanceVerified: false
    };

    try {
      if (!u8 || typeof u8.length !== 'number') return out;
      var u = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
      if (u.length < 1) return out;

      // Container: an already-decompressed self-describing record starts with the
      // SELF_MARKER; otherwise the blob is the compact LZ4 container that must be
      // decompressed before any field extraction.
      var selfDescribing = u.length >= 4 && Fe(u, 0) === SELF_MARKER;
      var rec = u;                                  // the record buffer we decode

      if (!selfDescribing) {
        var lz4 = getLZ4();
        var r = lz4 && lz4.decompressCatBlob ? lz4.decompressCatBlob(u) : null;
        if (r && r.data) {
          rec = r.data;
          out.build = r.build;
          out.buildOk = KNOWN_BUILDS.has(r.build);
        }
        // On decompress failure rec stays = original bytes for a best-effort ascii/
        // name scan; stats/genes will simply fail to validate and remain null.
      }
      var n = rec.length;

      // Content-anchored fields (best effort, never throw).
      var nm = nameUtf16(rec);
      if (nm) out.name = nm;

      var fields = scanAsciiFields(rec, n, abilityIds);
      out.cls = fields.cls;
      out.gender = fields.gender;
      out.abilities = fields.abilities;
      out.sizeTrait = fields.sizeTrait;   // {kind:'small', disorder} or null
      out.items = fields.items || [];     // [{key,kind,frame,name}] equipped items

      // BIRTH/DEATH DAY — the game stores no `age`; it derives it as `current_day - birth_day`
      // (mewgenics.wiki.gg: a cat ages +1 per in-game day), floored at 1. `current_day` is a
      // GLOBAL in the save's `properties` table, not in the cat blob, so decodeCat can only
      // supply the birth day — the caller pairs it with the day (see catAge).
      //
      // The field sits in a FIXED-SIZE 103-byte tail, so it is anchored from the END of the
      // record: everything before it shifts, because the name and the ability/item token
      // lists are variable-length. Located with two in-game ground truths at current_day 227
      // (Arcadia birth 212 -> age 15, Guiseppi birth 226 -> age 1, both exact) and confirmed
      // across two saves at different days: byte-identical for all 1297 shared cats, which is
      // the invariant a birth day must satisfy. Spread is a clean 0..227 (35 day-0 starting
      // cats; 4 cats read ABOVE current_day, which is real — the TimeMachineQuest runs the
      // day counter backwards, and those simply floor to age 1).
      out.birthDay = readDayStamp(rec, BIRTH_DAY_FROM_END);
      out.deathDay = readDayStamp(rec, DEATH_DAY_FROM_END);
      // A cat with a real death day is dead; -1 is the game's "hasn't happened" sentinel, and
      // null means this cat's tail isn't the layout we know (so we claim nothing either way).
      out.status = out.deathDay == null ? null : (out.deathDay >= 0 ? 'dead' : 'alive');

      // Stats — 7 core (+hp when plausible) from the decompressed record.
      var st = jv(rec);
      if (st) out.stats = st;

      // Appearance — 14 part-frames + pattern/coatPalette/classPalette. Map into
      // out.genes. `frame`/`palette` are legacy convenience keys the share payload
      // still reads; `palette` now carries the REAL coat COLOR (coatPalette), which
      // is what the renderer tints on (01-06 coat-decode spike).
      var ap = Wv(rec);
      var rangeOk = false, coatOk = false;
      if (ap) {
        rangeOk = appearanceInRange(ap.slots);
        // coatPalette is a direct palette.png row in [1,49]; out of range degrades
        // honestly (appearanceVerified stays false) rather than tinting with junk.
        coatOk = Number.isInteger(ap.coatPalette) && ap.coatPalette >= 1 && ap.coatPalette <= 49;
        // Mutations: label the part-frames/pattern that are >= 300 via the catalog
        // (L/R deduped, honest Unknown labels). Independent of appearanceVerified — a
        // mutation list is a decode of the same genes, not a claim the portrait is real.
        var mutations = decodeMutations(getMutationsCatalog(opts), ap.pattern, ap.slots);
        out.genes = {
          pattern: ap.pattern,            // fur texture id (1..706) — pattern, not color
          coatPalette: ap.coatPalette,    // real fur COLOR (palette.png row 1..49)
          classPalette: ap.classPalette,  // class accent row (50..68) or -1 = none
          slots: ap.slots,
          claws: ap.claws,                // per-leg claws gene (num_claws 1..10); 0/absent = none
          mutations: mutations,           // [{region,slot,category,id,name,effect,type,inCatalog}]
          frame: ap.slots.Body,
          palette: ap.coatPalette
        };
      }

      // Honest gate: all three flags AND range/symmetry AND an in-range coat color
      // must hold. A self-describing record has no known build word (buildOk false),
      // so it can decode genes for reference but never claims a verified portrait.
      var genesDecoded = out.genes !== null;
      out.appearanceVerified = out.buildOk && GENES_RESOLVED && genesDecoded && rangeOk && coatOk;
    } catch (e) {
      // Untrusted input: return the best partial object, never throw (T-01-02).
    }
    return out;
  }

  // ---- share codec (SHR-01..05): the versioned #k= payload ----
  // The permanent contract lives in docs/kittenshare-share-spec.md (§4 field table,
  // §5 algorithm, §6 L/R reconstruction). This module owns the ONE implementation the
  // page and the tools share, so a producer link and a consumer render can never drift.
  //
  // v1 payload (compact keys keep the JSON small; lz-string compresses the redundancy):
  //   v  int      schema version (READ FIRST)
  //   n  string   name (<=20 printable-ASCII chars)
  //   c  string   class name
  //   g  string   gender ("male"/"female")
  //   a  string[] <=6 ability id STRINGS (never indices — the id list can reorder)
  //   s  int[8]|null  [str,dex,con,int,spd,cha,lck,hp] ; hp=-1 is the null sentinel
  //   k  int[11]  the 11 UNIQUE slot frames in §6 order (Eye/Ear/Brow are L/R-mirrored)
  //   p  int      fur PATTERN (CatTexture frame)
  //   cp int      coat palette row (real fur COLOR)
  //   xp int      class accent palette row, or -1 = none
  // Mutations are NOT a field: a k/p frame >= 300 IS a mutation, re-derived on decode
  // via decodeMutations (share-spec §4).
  function shNum(x) { var n = Number(x); return Number.isFinite(n) ? n : 0; }

  function encodeShare(cat) {
    var LZ = getLZString();
    if (!LZ) return null;
    cat = cat || {};
    var g = cat.genes || {};
    var slots = g.slots || {};
    var st = cat.stats;
    var payload = {
      v: 1,
      n: String(cat.name == null ? '' : cat.name).slice(0, 20),
      c: String(cat.cls == null ? '' : cat.cls),
      g: String(cat.gender == null ? '' : cat.gender),
      a: Array.isArray(cat.abilities) ? cat.abilities.slice(0, 6).map(String) : [],
      s: st ? [shNum(st.str), shNum(st.dex), shNum(st.con), shNum(st.int),
        shNum(st.spd), shNum(st.cha), shNum(st.lck),
        (st.hp == null ? -1 : shNum(st.hp))] : null,
      // §6 fixed order: Body, Head, Tail, RearLeg_L, RearLeg_R, FrontLeg_L,
      // FrontLeg_R, Eye_L, Ear_L, Brow_L, Mouth (L/R pairs stored once).
      k: [slots.Body, slots.Head, slots.Tail, slots.RearLeg_L, slots.RearLeg_R,
        slots.FrontLeg_L, slots.FrontLeg_R, slots.Eye_L, slots.Ear_L, slots.Brow_L,
        slots.Mouth].map(shNum),
      p: shNum(g.pattern),
      cp: shNum(g.coatPalette),
      xp: (g.classPalette == null ? -1 : shNum(g.classPalette))
    };
    return LZ.compressToEncodedURIComponent(JSON.stringify(payload));
  }

  // decodeShare(blob[, opts]) -> a decodeCat-shaped object with buildOk/genesResolved/
  // appearanceVerified all true (a shared link IS the verified truth), full 14-slot
  // genes (L/R mirrored), stats with mp/level null, and genes.mutations re-derived.
  //   * unknown/newer version -> { __unsupportedVersion: v }  (graceful, not a throw)
  //   * non-string / >4000 chars / decompress-fail / parse-fail / wrong shape -> null
  // The >4000 cap runs BEFORE decompressing (decompression-bomb hygiene, T-02-04); the
  // whole body is wrapped in try/catch -> null so a crafted #k= can never crash/hang.
  function decodeShare(blob, opts) {
    try {
      var LZ = getLZString();
      if (!LZ) return null;
      if (typeof blob !== 'string' || blob.length > 4000) return null;   // consumer cap (§7)
      var json = LZ.decompressFromEncodedURIComponent(blob);
      if (!json) return null;
      var p = JSON.parse(json);
      if (!p || typeof p !== 'object') return null;
      if (p.v !== 1) return { __unsupportedVersion: (p.v || null) };     // §8
      var k = Array.isArray(p.k) ? p.k : [];
      // §6 L/R reconstruction: mirror the paired slots back to the full 14-slot shape.
      var slots = {
        Body: shNum(k[0]), Head: shNum(k[1]), Tail: shNum(k[2]),
        RearLeg_L: shNum(k[3]), RearLeg_R: shNum(k[4]),
        FrontLeg_L: shNum(k[5]), FrontLeg_R: shNum(k[6]),
        Eye_L: shNum(k[7]), Eye_R: shNum(k[7]),
        Ear_L: shNum(k[8]), Ear_R: shNum(k[8]),
        Brow_L: shNum(k[9]), Brow_R: shNum(k[9]),
        Mouth: shNum(k[10])
      };
      var s = Array.isArray(p.s) ? p.s : null;
      var pattern = shNum(p.p);
      var coatPalette = shNum(p.cp);
      var classPalette = (p.xp == null ? -1 : shNum(p.xp));
      // Mutations ride in the k/p frames (>=300) — re-derive via the same path the
      // local decode uses so a shared mutant lists its mutations too (share-spec §4).
      var mutations = decodeMutations(getMutationsCatalog(opts), pattern, slots);
      return {
        name: String(p.n == null ? '' : p.n),
        cls: String(p.c == null ? '' : p.c),
        gender: String(p.g == null ? '' : p.g),
        abilities: Array.isArray(p.a) ? p.a.map(String) : [],
        stats: s ? {
          str: shNum(s[0]), dex: shNum(s[1]), con: shNum(s[2]), int: shNum(s[3]),
          spd: shNum(s[4]), cha: shNum(s[5]), lck: shNum(s[6]),
          hp: (s[7] === -1 ? null : shNum(s[7])), mp: null, level: null
        } : null,
        genes: {
          pattern: pattern, coatPalette: coatPalette, classPalette: classPalette,
          slots: slots, mutations: mutations,
          frame: slots.Body, palette: coatPalette
        },
        build: null, buildOk: true, genesResolved: true, appearanceVerified: true
      };
    } catch (e) { return null; }
  }

  return {
    decodeCat: decodeCat,
    encodeShare: encodeShare,
    decodeShare: decodeShare,
    KNOWN_BUILDS: KNOWN_BUILDS,
    GENES_RESOLVED: GENES_RESOLVED,
    CLASSES: CLASSES,
    SLOTS: SLOTS,
    // mutation decode: exposed so tools/tests can label a slots+pattern set directly.
    decodeMutations: decodeMutations,
    // age = catAge(cat.birthDay, save.properties.current_day, cat.deathDay). Exposed because
    // the day is a GLOBAL the caller must fetch; decodeCat only ever sees one cat's blob.
    catAge: catAge,
    // parseHouseRoster(files.house_state blob) -> [{key, room}]. Same reason: the roster is a
    // save-wide file, not part of any cat's record.
    parseHouseRoster: parseHouseRoster,
    // test hook: the range + L/R-symmetry gate that governs appearanceVerified
    // (exported so the golden harness can prove out-of-range / asymmetric slots
    // are rejected — see tools/golden-save-test.js RANGE/DRIFT).
    _appearanceInRange: appearanceInRange
  };
});
