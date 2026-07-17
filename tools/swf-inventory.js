#!/usr/bin/env node
// Inventory an uncompressed (FWS) SWF: tag counts, shape IDs, sprite IDs,
// and exported symbol names (ExportAssets / SymbolClass).
// Usage: node tools/swf-inventory.js data/game/catparts.swf
const fs = require('fs');

const file = process.argv[2];
const buf = fs.readFileSync(file);
if (buf.slice(0, 3).toString('latin1') !== 'FWS') { console.error('not an uncompressed SWF'); process.exit(1); }

const version = buf[3];
const fileLen = buf.readUInt32LE(4);

// header RECT (frame size) is bit-packed: 5 bits nbits, then 4 * nbits
let bitPos = 8 * 8; // byte 8, in bits
function readUB(n) { let v = 0; for (let i = 0; i < n; i++) { const byte = buf[bitPos >> 3]; const bit = (byte >> (7 - (bitPos & 7))) & 1; v = (v << 1) | bit; bitPos++; } return v; }
const nbits = readUB(5);
readUB(nbits * 4); // skip rect
let pos = (bitPos + 7 >> 3);
pos += 4; // frame rate (u16) + frame count (u16)

const TAG_NAMES = {
  0:'End',1:'ShowFrame',2:'DefineShape',4:'PlaceObject',5:'RemoveObject',6:'DefineBits',8:'JPEGTables',
  9:'SetBackgroundColor',10:'DefineFont',11:'DefineText',12:'DoAction',13:'DefineFontInfo',
  20:'DefineBitsLossless',21:'DefineBitsJPEG2',22:'DefineShape2',26:'PlaceObject2',28:'RemoveObject2',
  32:'DefineShape3',33:'DefineText2',34:'DefineButton2',35:'DefineBitsJPEG3',36:'DefineBitsLossless2',
  39:'DefineSprite',43:'FrameLabel',46:'DefineMorphShape',48:'DefineFont2',56:'ExportAssets',
  69:'FileAttributes',70:'PlaceObject3',73:'DefineFontAlignZones',74:'CSMTextSettings',75:'DefineFont3',
  76:'SymbolClass',77:'Metadata',78:'DefineScalingGrid',82:'DoABC',83:'DefineShape4',84:'DefineMorphShape2',
  86:'DefineSceneAndFrameLabelData',88:'DefineFontName'
};

const tagCounts = {};
const shapes = [];      // {id, tag}
const sprites = [];     // {id, frames, children}
const names = [];       // {id, name} from ExportAssets/SymbolClass
const labels = [];

function u16(o){ return buf.readUInt16LE(o); }

let guard = 0;
while (pos < buf.length && guard++ < 200000) {
  const codeAndLen = u16(pos);
  const code = codeAndLen >> 6;
  let len = codeAndLen & 0x3f;
  let hdr = 2;
  if (len === 0x3f) { len = buf.readUInt32LE(pos + 2); hdr = 6; }
  const body = pos + hdr;
  const tname = TAG_NAMES[code] || ('tag' + code);
  tagCounts[tname] = (tagCounts[tname] || 0) + 1;

  if (code === 2 || code === 22 || code === 32 || code === 83) {
    shapes.push({ id: u16(body), tag: tname, len });
  } else if (code === 39) {
    // DefineSprite: id, frameCount, then nested tags — count PlaceObject2/3 children
    const id = u16(body), frames = u16(body + 2);
    let sp = body + 4, children = 0, spGuard = 0;
    while (sp < body + len && spGuard++ < 10000) {
      const cal = u16(sp); const c = cal >> 6; let l = cal & 0x3f; let h = 2;
      if (l === 0x3f) { l = buf.readUInt32LE(sp + 2); h = 6; }
      if (c === 26 || c === 70 || c === 4) children++;
      if (c === 0) break;
      sp += h + l;
    }
    sprites.push({ id, frames, children });
  } else if (code === 56 || code === 76) {
    // ExportAssets & SymbolClass share layout: u16 count, then (u16 id, cstring name)*
    const n = u16(body); let sp = body + 2;
    for (let i = 0; i < n; i++) {
      const id = u16(sp); sp += 2;
      let s = ''; while (buf[sp] !== 0) { s += String.fromCharCode(buf[sp]); sp++; } sp++;
      names.push({ id, name: s, via: tname });
    }
  } else if (code === 43) {
    let s = '', sp = body; while (buf[sp] !== 0 && sp < body + len) { s += String.fromCharCode(buf[sp]); sp++; }
    labels.push(s);
  }

  if (code === 0) break;
  pos = body + len;
}

console.log(JSON.stringify({
  file, version, fileLen,
  tagCounts,
  shapeCount: shapes.length,
  spriteCount: sprites.length,
  nameCount: names.length,
  labelCount: labels.length,
  sampleShapes: shapes.slice(0, 8),
  sampleSprites: sprites.slice(0, 8),
  sampleNames: names.slice(0, 60),
  sampleLabels: labels.slice(0, 40),
}, null, 1));
