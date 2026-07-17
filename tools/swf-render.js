#!/usr/bin/env node
// Render a named symbol (or character id) from an uncompressed SWF to SVG.
// Parses the full character dictionary (shapes + sprites), converts
// DefineShape1-4 records to SVG paths, and composes sprite timelines.
//
// Usage:
//   node tools/swf-render.js <file.swf> <SymbolName|charId> <frame> <out.svg>
//   node tools/swf-render.js data/game/catparts.swf CatHead 0 _head0.svg
const fs = require('fs');

// ---------------- bit reader ----------------
class BitReader {
  constructor(buf, byteOff = 0) { this.buf = buf; this.bp = byteOff * 8; }
  ub(n) { let v = 0; for (let i = 0; i < n; i++) { const b = this.buf[this.bp >> 3]; v = (v << 1) | ((b >> (7 - (this.bp & 7))) & 1); this.bp++; } return v >>> 0; }
  sb(n) { let v = this.ub(n); if (n > 0 && (v & (1 << (n - 1)))) v -= Math.pow(2, n); return v; }
  fb(n) { return this.sb(n) / 65536; }
  align() { this.bp = (this.bp + 7) & ~7; }
  get byte() { return this.bp >> 3; }
  set byte(b) { this.bp = b * 8; }
  u8() { this.align(); const v = this.buf[this.byte]; this.bp += 8; return v; }
  u16() { this.align(); const v = this.buf.readUInt16LE(this.byte); this.bp += 16; return v; }
  u32() { this.align(); const v = this.buf.readUInt32LE(this.byte); this.bp += 32; return v; }
}

// A RECT begins byte-ALIGNED, like MATRIX/CXFORM below. This only bites when two RECTs sit
// back-to-back: DefineShape4 is ShapeBounds RECT + EdgeBounds RECT, and reading EdgeBounds from
// wherever ShapeBounds happened to stop mid-byte yields a garbage NumBits (1 instead of 12), a
// degenerate rect, and a reader left ~6 bytes short of the fill-style array. DefineShape1-3 carry
// a single RECT that starts aligned anyway, which is why they always parsed cleanly.
function parseRECT(r) { r.align(); const n = r.ub(5); return { xmin: r.sb(n) / 20, xmax: r.sb(n) / 20, ymin: r.sb(n) / 20, ymax: r.sb(n) / 20 }; }
function parseMATRIX(r) {
  r.align();
  const m = { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
  if (r.ub(1)) { const n = r.ub(5); m.sx = r.fb(n); m.sy = r.fb(n); }
  if (r.ub(1)) { const n = r.ub(5); m.r0 = r.fb(n); m.r1 = r.fb(n); }
  const n = r.ub(5); m.tx = r.sb(n) / 20; m.ty = r.sb(n) / 20;
  return m;
}
function parseCXFORM(r, hasAlpha) {
  r.align();
  const hasAdd = r.ub(1), hasMult = r.ub(1), n = r.ub(4);
  const cx = { rm: 1, gm: 1, bm: 1, am: 1, ra: 0, ga: 0, ba: 0, aa: 0 };
  if (hasMult) { cx.rm = r.sb(n) / 256; cx.gm = r.sb(n) / 256; cx.bm = r.sb(n) / 256; if (hasAlpha) cx.am = r.sb(n) / 256; }
  if (hasAdd) { cx.ra = r.sb(n); cx.ga = r.sb(n); cx.ba = r.sb(n); if (hasAlpha) cx.aa = r.sb(n); }
  return cx;
}
function rgb(r) { return { r: r.u8(), g: r.u8(), b: r.u8(), a: 255 }; }
function rgba(r) { return { r: r.u8(), g: r.u8(), b: r.u8(), a: r.u8() }; }
function colToCss(c) { return c.a === 255 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`; }

// ---------------- fill / line styles ----------------
function parseFillStyles(r, shapeVer) {
  let count = r.u8(); if (count === 0xff && shapeVer >= 2) count = r.u16();
  const styles = [];
  for (let i = 0; i < count; i++) styles.push(parseFillStyle(r, shapeVer));
  return styles;
}
function parseFillStyle(r, shapeVer) {
  const type = r.u8();
  if (type === 0x00) return { type: 'solid', color: shapeVer >= 3 ? rgba(r) : rgb(r) };
  if (type === 0x10 || type === 0x12 || type === 0x13) {
    const matrix = parseMATRIX(r); r.align();
    const pad = r.ub(2), interp = r.ub(2), n = r.ub(4);
    const stops = [];
    for (let i = 0; i < n; i++) stops.push({ ratio: r.u8(), color: shapeVer >= 3 ? rgba(r) : rgb(r) });
    let focal = 0; if (type === 0x13) focal = r.u16() / 256;
    return { type: type === 0x10 ? 'lgrad' : 'rgrad', matrix, stops, focal };
  }
  if (type >= 0x40 && type <= 0x43) {
    const bitmapId = r.u16(); const matrix = parseMATRIX(r);
    return { type: 'bitmap', bitmapId, matrix, smoothed: type === 0x40 || type === 0x41, clipped: type === 0x41 || type === 0x43 };
  }
  throw new Error('unknown fill type 0x' + type.toString(16));
}
function parseLineStyles(r, shapeVer) {
  let count = r.u8(); if (count === 0xff) count = r.u16();
  const styles = [];
  for (let i = 0; i < count; i++) {
    if (shapeVer < 4) {
      styles.push({ width: r.u16() / 20, color: shapeVer >= 3 ? rgba(r) : rgb(r) });
    } else {
      const width = r.u16() / 20;
      r.align();
      const startCap = r.ub(2), join = r.ub(2), hasFill = r.ub(1), noHScale = r.ub(1), noVScale = r.ub(1), pixelHint = r.ub(1);
      r.ub(5); const noClose = r.ub(1), endCap = r.ub(2);
      let miter = 0; if (join === 2) miter = r.u16() / 256;
      let color = { r: 0, g: 0, b: 0, a: 255 }, fill = null;
      if (hasFill) fill = parseFillStyle(r, shapeVer); else color = rgba(r);
      styles.push({ width, color, fill });
    }
  }
  return styles;
}

// ---------------- shape records → per-fill paths ----------------
function parseShape(buf, body, len, shapeVer) {
  const r = new BitReader(buf, body);
  const id = r.u16();
  const bounds = parseRECT(r);
  if (shapeVer === 4) { parseRECT(r); r.align(); r.u8(); } // edge bounds + flags
  let fills = parseFillStyles(r, shapeVer);
  let lines = parseLineStyles(r, shapeVer);
  r.align();
  let fillBits = r.ub(4), lineBits = r.ub(4);

  // collect edges tagged with current styles
  const edges = []; // {x1,y1,x2,y2,cx,cy,curve, f0,f1,ln, styleEpoch}
  const fillEpochs = [fills]; const lineEpochs = [lines];
  let f0 = 0, f1 = 0, ln = 0, epoch = 0;
  let x = 0, y = 0;
  for (;;) {
    const isEdge = r.ub(1);
    if (!isEdge) {
      const flags = r.ub(5);
      if (flags === 0) break; // end of shape
      if (flags & 1) { const n = r.ub(5); x = r.sb(n) / 20; y = r.sb(n) / 20; }
      if (flags & 2) f0 = r.ub(fillBits);
      if (flags & 4) f1 = r.ub(fillBits);
      if (flags & 8) ln = r.ub(lineBits);
      if (flags & 16) {
        fills = parseFillStyles(r, shapeVer); lines = parseLineStyles(r, shapeVer);
        r.align(); fillBits = r.ub(4); lineBits = r.ub(4);
        fillEpochs.push(fills); lineEpochs.push(lines); epoch++;
        f0 = 0; f1 = 0; ln = 0;
      }
    } else {
      const straight = r.ub(1);
      const n = r.ub(4) + 2;
      if (straight) {
        const general = r.ub(1);
        let dx = 0, dy = 0;
        if (general) { dx = r.sb(n) / 20; dy = r.sb(n) / 20; }
        else { if (r.ub(1)) dy = r.sb(n) / 20; else dx = r.sb(n) / 20; }
        edges.push({ x1: x, y1: y, x2: x + dx, y2: y + dy, curve: false, f0, f1, ln, epoch });
        x += dx; y += dy;
      } else {
        const cdx = r.sb(n) / 20, cdy = r.sb(n) / 20;
        const adx = r.sb(n) / 20, ady = r.sb(n) / 20;
        edges.push({ x1: x, y1: y, cx: x + cdx, cy: y + cdy, x2: x + cdx + adx, y2: y + cdy + ady, curve: true, f0, f1, ln, epoch });
        x += cdx + adx; y += cdy + ady;
      }
    }
  }
  return { id, bounds, fillEpochs, lineEpochs, edges };
}

// stitch edges belonging to one fill style into closed contours
function key(px, py) { return px.toFixed(2) + ',' + py.toFixed(2); }
function pathForFill(edges, epoch, styleIdx) {
  // edge contributes: fill1===styleIdx forward, fill0===styleIdx reversed
  const segs = [];
  for (const e of edges) {
    if (e.epoch !== epoch) continue;
    if (e.f1 === styleIdx) segs.push(e);
    if (e.f0 === styleIdx) segs.push(e.curve
      ? { x1: e.x2, y1: e.y2, cx: e.cx, cy: e.cy, x2: e.x1, y2: e.y1, curve: true }
      : { x1: e.x2, y1: e.y2, x2: e.x1, y2: e.y1, curve: false });
  }
  if (!segs.length) return '';
  // chain
  const byStart = new Map();
  for (const s of segs) { const k = key(s.x1, s.y1); if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(s); }
  const used = new Set();
  let d = '';
  for (const s0 of segs) {
    if (used.has(s0)) continue;
    let s = s0;
    d += `M${s.x1.toFixed(2)} ${s.y1.toFixed(2)}`;
    while (s && !used.has(s)) {
      used.add(s);
      d += s.curve ? `Q${s.cx.toFixed(2)} ${s.cy.toFixed(2)} ${s.x2.toFixed(2)} ${s.y2.toFixed(2)}` : `L${s.x2.toFixed(2)} ${s.y2.toFixed(2)}`;
      const nexts = (byStart.get(key(s.x2, s.y2)) || []).filter(n => !used.has(n));
      s = nexts[0];
    }
    d += 'Z';
  }
  return d;
}
function pathForLine(edges, epoch, styleIdx) {
  let d = '', lastX = null, lastY = null;
  for (const e of edges) {
    if (e.epoch !== epoch || e.ln !== styleIdx) continue;
    if (lastX !== e.x1 || lastY !== e.y1) d += `M${e.x1.toFixed(2)} ${e.y1.toFixed(2)}`;
    d += e.curve ? `Q${e.cx.toFixed(2)} ${e.cy.toFixed(2)} ${e.x2.toFixed(2)} ${e.y2.toFixed(2)}` : `L${e.x2.toFixed(2)} ${e.y2.toFixed(2)}`;
    lastX = e.x2; lastY = e.y2;
  }
  return d;
}

let gradSeq = 0;
function shapeToSvg(shape, defs) {
  let out = '';
  const nEpochs = shape.fillEpochs.length;
  for (let ep = 0; ep < nEpochs; ep++) {
    const fills = shape.fillEpochs[ep];
    for (let i = 1; i <= fills.length; i++) {
      const d = pathForFill(shape.edges, ep, i);
      if (!d) continue;
      const st = fills[i - 1];
      let fill = '#f0f';
      if (st.type === 'solid') fill = colToCss(st.color);
      else if (st.type === 'lgrad' || st.type === 'rgrad') {
        const gid = 'g' + (gradSeq++);
        const m = st.matrix;
        // SWF gradient square is (-16384..16384) twips = (-819.2..819.2) px
        const stops = st.stops.map(s => `<stop offset="${(s.ratio / 255 * 100).toFixed(1)}%" stop-color="${colToCss(s.color)}"/>`).join('');
        const gt = `gradientTransform="matrix(${m.sx} ${m.r0} ${m.r1} ${m.sy} ${m.tx} ${m.ty})"`;
        if (st.type === 'lgrad') defs.push(`<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="-819.2" x2="819.2" ${gt}>${stops}</linearGradient>`);
        else defs.push(`<radialGradient id="${gid}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="819.2" ${gt}>${stops}</radialGradient>`);
        fill = `url(#${gid})`;
      } else if (st.type === 'bitmap') {
        fill = 'var(--cat-texture, #b9866c)'; // palette-remap hook: bitmap fills are the fur texture
      }
      out += `<path d="${d}" fill="${fill}" fill-rule="evenodd"/>`;
    }
    const lines = shape.lineEpochs[ep];
    for (let i = 1; i <= lines.length; i++) {
      const d = pathForLine(shape.edges, ep, i);
      if (!d) continue;
      const st = lines[i - 1];
      out += `<path d="${d}" fill="none" stroke="${colToCss(st.color)}" stroke-width="${st.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  }
  return out;
}

// ---------------- SWF top-level parse ----------------
function parseSwf(file) {
  const buf = fs.readFileSync(file);
  const r0 = new BitReader(buf, 8);
  const n = r0.ub(5); r0.ub(n * 4);
  let pos = ((r0.bp + 7) >> 3) + 4;
  const dict = {}; const symbols = {};
  function u16(o) { return buf.readUInt16LE(o); }
  function parseSpriteBody(body, len) {
    const frames = [];
    let cur = {}; // depth -> {charId, matrix}
    let sp = body + 4;
    while (sp < body + len) {
      const cal = u16(sp); const c = cal >> 6; let l = cal & 0x3f; let h = 2;
      if (l === 0x3f) { l = buf.readUInt32LE(sp + 2); h = 6; }
      const b2 = sp + h;
      if (c === 1) { frames.push({ ...cur }); }
      else if (c === 26 || c === 70) {
        const r = new BitReader(buf, b2);
        let flags, flags2 = 0;
        flags = r.u8();
        if (c === 70) flags2 = r.u8();
        const depth = r.u16();
        if (c === 70 && (flags2 & 8)) { let s = ''; while (buf[r.byte] !== 0) { s += String.fromCharCode(buf[r.byte]); r.byte = r.byte + 1; } r.byte = r.byte + 1; }
        const entry = cur[depth] ? { ...cur[depth] } : {};
        if (flags & 2) entry.charId = r.u16();
        if (flags & 4) entry.matrix = parseMATRIX(r);
        if (flags & 8) entry.cxform = parseCXFORM(r, true);
        if (flags & 16) r.u16(); // ratio
        // PlaceObject2 instance NAME. Keep it: it is the only thing that identifies which leg
        // is which in the catanis rig (all four legs place the SAME char, and depths are NOT
        // stable across animations — HunterIdleF puts the head on depth 11, JesterIdleF puts
        // the tail on depth 3). Name is the authority; depth is not.
        if (flags & 32) { r.align(); let s = ''; while (buf[r.byte] !== 0) { s += String.fromCharCode(buf[r.byte]); r.byte = r.byte + 1; } r.byte = r.byte + 1; entry.name = s; }
        if (flags & 64) entry.clipDepth = r.u16();
        cur[depth] = entry;
      } else if (c === 28) {
        const depth = u16(b2); delete cur[depth];
      } else if (c === 0) break;
      sp = b2 + l;
    }
    if (Object.keys(cur).length && frames.length === 0) frames.push({ ...cur });
    return frames;
  }
  while (pos < buf.length) {
    const cal = u16(pos); const code = cal >> 6; let len = cal & 0x3f; let hdr = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(pos + 2); hdr = 6; }
    const body = pos + hdr;
    if (code === 2 || code === 22 || code === 32 || code === 83) {
      const ver = code === 2 ? 1 : code === 22 ? 2 : code === 32 ? 3 : 4;
      try { const s = parseShape(buf, body, len, ver); dict[s.id] = { type: 'shape', shape: s }; }
      catch (e) { dict[u16(body)] = { type: 'shape-error', err: String(e) }; }
    } else if (code === 39) {
      const id = u16(body);
      dict[id] = { type: 'sprite', frames: parseSpriteBody(body, len) };
    } else if (code === 56 || code === 76) {
      const n2 = u16(body); let sp = body + 2;
      for (let i = 0; i < n2; i++) { const id = u16(sp); sp += 2; let s = ''; while (buf[sp] !== 0) { s += String.fromCharCode(buf[sp]); sp++; } sp++; symbols[s] = id; }
    }
    if (code === 0) break;
    pos = body + len;
  }
  return { dict, symbols };
}

// ---------------- compose ----------------
function renderChar(swf, id, frameIdx, defs, depthStack, opts) {
  const ch = swf.dict[id];
  if (!ch) return `<!-- missing char ${id} -->`;
  if (ch.type === 'shape') return shapeToSvg(ch.shape, defs);
  if (ch.type === 'sprite') {
    const frames = ch.frames;
    if (!frames.length) return '';
    const f = frames[Math.min(frameIdx, frames.length - 1)];
    const depths = Object.keys(f).map(Number).sort((a, b) => a - b);
    let out = '';
    // active clip: {until: clipDepth, id: clipPathId}
    const clips = [];
    // opts.skipDepths (a Set) suppresses specific timeline depths at THIS level only —
    // it is NOT propagated into nested renderChar calls. Used to drop the CatLeg claw
    // layer (depth 26 -> 9086), a toggle sprite the game hides for most cats.
    const skipDepths = opts && opts.skipDepths;
    // opts.markChars (a Set) tags placements of specific chars with a data attribute so a
    // consumer can find and substitute them later. UNLIKE skipDepths this DOES propagate
    // into nested calls, because the char of interest (the fur-fill rect) is placed inside
    // a nested sprite rather than on the part's own timeline.
    const markChars = opts && opts.markChars;
    // opts.skipChars (a Set) suppresses placements of specific chars ANYWHERE in the tree —
    // it propagates, unlike skipDepths. Needed for the age cosmetics (grey hair / wrinkles),
    // which are nested two levels down inside the part's fur sprite rather than on the part's
    // own timeline, so no top-level depth can reach them. A clip layer is never skipped:
    // dropping one would silently delete a mask and leak the layers it clips.
    const skipChars = opts && opts.skipChars;
    const childOpts = (markChars || skipChars) ? { markChars, skipChars } : undefined;
    for (const d of depths) {
      if (skipDepths && skipDepths.has(d)) continue;
      const pl = f[d];
      if (pl.charId == null) continue;
      if (skipChars && skipChars.has(pl.charId) && pl.clipDepth == null) continue;
      // expire clips
      while (clips.length && d > clips[clips.length - 1].until) { out += '</g>'; clips.pop(); }
      const m = pl.matrix || { sx: 1, sy: 1, r0: 0, r1: 0, tx: 0, ty: 0 };
      const mat = `matrix(${m.sx} ${m.r0} ${m.r1} ${m.sy} ${m.tx} ${m.ty})`;
      const inner = renderChar(swf, pl.charId, 0, defs, depthStack + 1, childOpts);
      if (pl.clipDepth != null) {
        // Flash mask layer → SVG <mask> (clipPath can't hold <g> children).
        // Mask content: the clip char's geometry, all-white, alpha = coverage.
        const cid = 'mask' + (gradSeq++);
        const whiteInner = inner
          .replace(/fill="[^"]*"/g, 'fill="#fff"')
          .replace(/stroke="[^"]*"/g, 'stroke="#fff"');
        defs.push(`<mask id="${cid}"><g transform="${mat}">${whiteInner}</g></mask>`);
        out += `<g mask="url(#${cid})">`;
        clips.push({ until: pl.clipDepth, id: cid });
      } else if (markChars && markChars.has(pl.charId)) {
        out += `<g data-fur="1" transform="${mat}">${inner}</g>`;
      } else {
        out += `<g transform="${mat}">${inner}</g>`;
      }
    }
    while (clips.length) { out += '</g>'; clips.pop(); }
    return out;
  }
  return '';
}

// ---------------- main ----------------
if (require.main === module) {
  const [, , file, symArg, frameArg, outFile] = process.argv;
  const swf = parseSwf(file);
  const id = isNaN(+symArg) ? swf.symbols[symArg] : +symArg;
  if (!id) { console.error('symbol not found:', symArg, '— known:', Object.keys(swf.symbols).slice(0, 30).join(', ')); process.exit(1); }
  const defs = [];
  const inner = renderChar(swf, id, +frameArg || 0, defs, 0);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-150 -150 300 300" width="600" height="600">` +
    `<defs>${defs.join('')}</defs>${inner}</svg>`;
  fs.writeFileSync(outFile, svg);
  const ch = swf.dict[id];
  console.log('rendered', symArg, 'id', id, 'frame', frameArg, '->', outFile, `(${svg.length} bytes)`,
    ch.type === 'sprite' ? `[sprite ${ch.frames.length} frames]` : '[shape]');
}
module.exports = { parseSwf, renderChar };
