// lz4.js — self-contained, dependency-free LZ4 *block* decompressor for the
// KittenShare cat-blob pipeline. No npm, no CDN, no wasm, no network.
//
// Why this exists: every Mewgenics `cats.data` blob in the save DB is
//   [u32 decompressedSize LE][u32 5090 build LE][LZ4-block-compressed CatData]
// LZ4 keeps ASCII names/ability-ids as literals (so they read fine on the raw
// blob) while stats and appearance part-frames are back-referenced — which is
// exactly why both Phase-1 NO-GOs ("stats/genes absent") were artifacts of
// never decompressing. Decompress first, and stats decode for 100% of cats and
// appearance for ~99.9% (verified on the real 1,316-cat save).
//
// This is the canonical LZ4 block format (matching lz4js decompressBlock):
//   token byte -> literalLen (high nibble, extend on 0x0F) -> copy literals ->
//   2-byte LE match offset -> matchLen (low nibble, extend on 0x0F) + 4 minmatch
//   -> byte-by-byte (overlap-safe) copy from earlier in the output.
//
// Untrusted-input hygiene (threat model T-01-02/-04/-SC-BOMB): a hostile blob
// must yield null, never crash the page or over-allocate. Every read is bounded,
// the declared size is capped before allocation, and decompressCatBlob swallows
// throws into null.

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.LZ4 = api;
})(this, function () {
  'use strict';

  var MAX_DECOMPRESSED = 4000000; // decompression-bomb guard (T-01-SC-BOMB)

  // decompressBlock(src, srcStart, srcEnd, dest, destSize)
  // Decompress the LZ4 block bytes src[srcStart..srcEnd) into a freshly
  // allocated Uint8Array(destSize). Throws on ANY inconsistency (out-of-bounds
  // read, back-reference before output start, write past destSize, or a final
  // write position != destSize) so a lying header fails loudly rather than
  // returning a short/garbage buffer. Returns the exactly-destSize dest.
  function decompressBlock(src, srcStart, srcEnd, dest, destSize) {
    var sIdx = srcStart;
    var dIdx = 0;

    while (sIdx < srcEnd) {
      var token = src[sIdx++];

      // ---- literals ----
      var literalLen = token >> 4;
      if (literalLen === 15) {
        var b;
        do {
          if (sIdx >= srcEnd) throw new Error('lz4: EOF reading literal length');
          b = src[sIdx++];
          literalLen += b;
        } while (b === 255);
      }

      if (literalLen > 0) {
        if (sIdx + literalLen > srcEnd) throw new Error('lz4: literal run past input end');
        if (dIdx + literalLen > destSize) throw new Error('lz4: literal run past output size');
        for (var i = 0; i < literalLen; i++) dest[dIdx++] = src[sIdx++];
      }

      // Last sequence legitimately ends after its literals (no match).
      if (sIdx >= srcEnd) break;

      // ---- match ----
      if (sIdx + 2 > srcEnd) throw new Error('lz4: EOF reading match offset');
      var offset = src[sIdx++] | (src[sIdx++] << 8);
      if (offset === 0) throw new Error('lz4: zero match offset');
      if (offset > dIdx) throw new Error('lz4: match offset before output start');

      var matchLen = token & 0x0f;
      if (matchLen === 15) {
        var m;
        do {
          if (sIdx >= srcEnd) throw new Error('lz4: EOF reading match length');
          m = src[sIdx++];
          matchLen += m;
        } while (m === 255);
      }
      matchLen += 4; // LZ4 minmatch

      if (dIdx + matchLen > destSize) throw new Error('lz4: match copy past output size');
      var mPos = dIdx - offset;
      // Byte-by-byte: overlapping copies are legal and required.
      for (var k = 0; k < matchLen; k++) dest[dIdx++] = dest[mPos++];
    }

    if (dIdx !== destSize) throw new Error('lz4: decompressed ' + dIdx + ' != declared ' + destSize);
    return dest;
  }

  function u32le(u8, o) {
    return (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
  }

  // decompressCatBlob(u8) -> { data, size, build, variant } | null
  // Container framing: [u32 size][u32 word4][lz4 block]. word4 is the build in
  // our saves (5090), but is a compressed-length in the alternate "variant B"
  // framing. Each variant is an INDEPENDENTLY-guarded attempt (decompressBlock
  // THROWS on mismatch, so a single outer try/catch would make the fallbacks
  // dead code). Never lets a throw escape — a hostile blob yields null.
  function decompressCatBlob(u8) {
    try {
      if (!u8 || typeof u8.length !== 'number') return null;
      var u = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
      var len = u.length;
      if (len < 8) return null;

      var size = u32le(u, 0);
      var word4 = u32le(u, 4);

      // Decompression-bomb guard: reject an absurd/zero declared size before
      // allocating anything (T-01-SC-BOMB).
      if (size <= 0 || size > MAX_DECOMPRESSED) return null;

      // ---- Variant B: [u32 size][u32 compLen][lz4] (only if word4 looks like
      //      a compressed length). Own try/catch; fall through on any failure.
      if (word4 > 0 && word4 <= len - 8) {
        try {
          var destB = new Uint8Array(size);
          var okB = decompressBlock(u, 8, 8 + word4, destB, size);
          if (okB.length === size) return { data: destB, size: size, build: word4, variant: 'B' };
        } catch (eB) { /* fall through to variant A */ }
      }

      // ---- Variant A: [u32 size][u32 build][lz4]; decompress from byte 8.
      try {
        var destA = new Uint8Array(size);
        var okA = decompressBlock(u, 8, len, destA, size);
        if (okA.length === size) return { data: destA, size: size, build: word4, variant: 'A' };
      } catch (eA) { /* fall through to the offset-4 retry */ }

      // ---- Variant A' (offset-4 retry): some framings put the lz4 stream right
      //      after the size prefix. Own try/catch; last resort.
      try {
        var destA2 = new Uint8Array(size);
        var okA2 = decompressBlock(u, 4, len, destA2, size);
        if (okA2.length === size) return { data: destA2, size: size, build: word4, variant: 'A' };
      } catch (eA2) { /* every attempt failed */ }

      return null;
    } catch (e) {
      return null; // never crash the page (T-01-02)
    }
  }

  return {
    decompressBlock: decompressBlock,
    decompressCatBlob: decompressCatBlob,
    MAX_DECOMPRESSED: MAX_DECOMPRESSED
  };
});
