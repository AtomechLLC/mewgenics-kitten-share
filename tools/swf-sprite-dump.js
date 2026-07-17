#!/usr/bin/env node
// Dump a DefineSprite's timeline: frames, and which character IDs are placed
// with what depth/matrix per frame. Usage:
//   node tools/swf-sprite-dump.js data/game/catparts.swf 7132
const fs = require('fs');

const buf = fs.readFileSync(process.argv[2]);
const wantId = +process.argv[3];

// skip header
let bitPos = 8 * 8;
function readUBAt(n) { let v = 0; for (let i = 0; i < n; i++) { const b = buf[bitPos >> 3]; v = (v << 1) | ((b >> (7 - (bitPos & 7))) & 1); bitPos++; } return v; }
const nb = readUBAt(5); readUBAt(nb * 4);
let pos = (bitPos + 7 >> 3) + 4;

function u16(o) { return buf.readUInt16LE(o); }

// bit reader for matrices
function bitReader(startByte) {
  let bp = startByte * 8;
  return {
    ub(n) { let v = 0; for (let i = 0; i < n; i++) { const b = buf[bp >> 3]; v = (v << 1) | ((b >> (7 - (bp & 7))) & 1); bp++; } return v; },
    sb(n) { let v = this.ub(n); if (n > 0 && (v & (1 << (n - 1)))) v -= (1 << n); return v; },
    align() { bp = (bp + 7) & ~7; },
    bytePos() { return bp >> 3; },
  };
}

function parseMatrix(r) {
  const m = { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
  if (r.ub(1)) { const n = r.ub(5); m.sx = r.sb(n) / 65536; m.sy = r.sb(n) / 65536; }
  if (r.ub(1)) { const n = r.ub(5); m.r0 = r.sb(n) / 65536; m.r1 = r.sb(n) / 65536; }
  const n = r.ub(5); m.tx = r.sb(n) / 20; m.ty = r.sb(n) / 20; // twips → px
  return m;
}

while (pos < buf.length) {
  const cal = u16(pos); const code = cal >> 6; let len = cal & 0x3f; let hdr = 2;
  if (len === 0x3f) { len = buf.readUInt32LE(pos + 2); hdr = 6; }
  const body = pos + hdr;
  if (code === 39 && u16(body) === wantId) {
    const frames = u16(body + 2);
    console.log('sprite', wantId, 'frames:', frames);
    let sp = body + 4, frame = 0;
    const placements = [];
    while (sp < body + len) {
      const c2 = u16(sp); const c = c2 >> 6; let l = c2 & 0x3f; let h = 2;
      if (l === 0x3f) { l = buf.readUInt32LE(sp + 2); h = 6; }
      const b2 = sp + h;
      if (c === 1) frame++;
      else if (c === 26) { // PlaceObject2
        const flags = buf[b2];
        const depth = u16(b2 + 1);
        let o = b2 + 3;
        let charId = null;
        if (flags & 2) { charId = u16(o); o += 2; }
        let matrix = null;
        if (flags & 4) { const r = bitReader(o); matrix = parseMatrix(r); }
        placements.push({ frame, depth, charId, hasMove: !!(flags & 1), matrix });
      } else if (c === 28) {
        placements.push({ frame, remove: true, depth: u16(b2) });
      } else if (c === 43) {
        let s = '', q = b2; while (buf[q] !== 0 && q < b2 + l) { s += String.fromCharCode(buf[q]); q++; }
        placements.push({ frame, label: s });
      }
      if (c === 0) break;
      sp = b2 + l;
    }
    console.log('placements (first 60):');
    placements.slice(0, 60).forEach(p => console.log(' ', JSON.stringify(p)));
    console.log('total placements:', placements.length);
    process.exit(0);
  }
  if (code === 0) break;
  pos = body + len;
}
console.log('sprite not found');
