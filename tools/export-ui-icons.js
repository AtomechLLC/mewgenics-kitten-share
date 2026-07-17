// Export the game's REAL UI glyphs from swfs/ui.swf into public/kittenshare/ui-icons.js
// for the KittenShare card. Three sets, all exported symbols, all single-frame sprites
// wrapping one shape:
//
//   STAT_ICONS   FontIcon_<stat>  — the cat sheet's 7 stat glyphs (arm, bow, medical heart,
//                                   lightbulb, boot, lips, clover)
//   CLASS_ICONS  FontIcon_<Class> — the class emblem shown top-left (paw, spiral, bow, leaf,
//                                   shield, heart, yin-yang, dice, skull, tools, ham, Ø …)
//   GENDER_ICONS FontIcon_<sex>   — the ♂ / ♀ / ? shown after the name
//
// COLOR: the stat glyphs are authored BLACK but the class/gender glyphs are authored WHITE
// (they sit on dark backing in-game). An inline fill beats CSS, so every monochrome fill is
// rewritten to currentColor — the card then picks the colour and white-on-white can't happen.
//
// VIEWBOX: a symbol's art is NOT centred on its own origin — each sits at an arbitrary offset
// in ui.swf's coordinate space, so a naive viewBox crops it to a sliver. These boxes were
// measured in a browser via getBBox() on the rendered output (the only transform-aware way to
// get true bounds without reimplementing curve math) and padded ~8%. Re-measure the same way
// if ui.swf changes; a wrong box shows as a cropped or tiny glyph, which is obvious on sight.
//
// CLASS NAMING: the decoder (and the game's UI) say "Medic", but ui.swf exports the symbol as
// FontIcon_Cleric — the class was renamed and the art keeps the old name. Keyed by the
// DECODER's name so lookups are cat.cls -> icon with no translation at the callsite.
//
// Usage: node tools/export-ui-icons.js   (needs data/game/ui.swf — extract from
//        resources.gpak `swfs/ui.swf`; override with UI_SWF=<path>)

const fs = require('fs');
const path = require('path');
const { parseSwf, renderChar } = require('./swf-render.js');

const SWF = process.env.UI_SWF || 'data/game/ui.swf';
const OUT = 'public/kittenshare/ui-icons.js';

// key -> { sym: ui.swf export name, viewBox: measured via getBBox }
const STATS = {
  str: { sym: 'FontIcon_str', viewBox: '-4.9 -69.9 73.2 74.6' },
  dex: { sym: 'FontIcon_dex', viewBox: '-11.5 -66.8 84.6 70.6' },
  con: { sym: 'FontIcon_con', viewBox: '-13.6 -68.4 90.6 75.1' },
  int: { sym: 'FontIcon_int', viewBox: '-11.4 -87.4 89.0 95.5' },
  spd: { sym: 'FontIcon_spd', viewBox: '-20.2 -61.1 102.0 68.2' },
  cha: { sym: 'FontIcon_cha', viewBox: '-13.1 -57.3 89.4 61.7' },
  lck: { sym: 'FontIcon_lck', viewBox: '-6.1 -71.2 76.3 80.0' },
};

// Keyed by the DECODER's class name. `Medic` deliberately maps to FontIcon_Cleric (see above).
const CLASSES = {
  Fighter:     { sym: 'FontIcon_Fighter',     viewBox: '-5.6 -67.2 74.5 72.3' },
  Mage:        { sym: 'FontIcon_Mage',        viewBox: '-4.0 -67.8 71.4 72.6' },
  Hunter:      { sym: 'FontIcon_Hunter',      viewBox: '-5.0 -69.1 74.1 74.3' },
  Druid:       { sym: 'FontIcon_Druid',       viewBox: '-3.9 -69.6 73.1 74.8' },
  Tank:        { sym: 'FontIcon_Tank',        viewBox: '-3.4 -69.1 71.0 74.2' },
  Medic:       { sym: 'FontIcon_Cleric',      viewBox: '-4.1 -66.8 72.7 71.8' },
  Monk:        { sym: 'FontIcon_Monk',        viewBox: '-4.2 -67.6 72.7 72.7' },
  Thief:       { sym: 'FontIcon_Thief',       viewBox: '-5.1 -69.0 74.1 74.1' },
  Jester:      { sym: 'FontIcon_Jester',      viewBox: '-1.6 -67.6 68.4 72.6' },
  Psychic:     { sym: 'FontIcon_Psychic',     viewBox: '-16.7 -70.0 97.4 76.7' },
  Necromancer: { sym: 'FontIcon_Necromancer', viewBox: '-3.0 -69.2 70.5 74.3' },
  Tinkerer:    { sym: 'FontIcon_Tinkerer',    viewBox: '-5.4 -67.8 74.6 72.9' },
  Butcher:     { sym: 'FontIcon_Butcher',     viewBox: '-5.2 -69.1 74.7 74.7' },
  Colorless:   { sym: 'FontIcon_Colorless',   viewBox: '-4.2 -67.4 72.4 72.4' },
};

// Keyed by the decoder's gender enum values (male/female/neutral).
const GENDERS = {
  male:    { sym: 'FontIcon_male',    viewBox: '-5.0 -67.5 72.5 72.4' },
  female:  { sym: 'FontIcon_female',  viewBox: '-5.2 -57.9 54.5 74.8' },
  neutral: { sym: 'FontIcon_neutral', viewBox: '-5.6 -69.7 58.2 81.7' },
};

// The NON-stat [img:token]s that actually occur in ability descriptions (the 7 stat tokens
// are already covered by STAT_ICONS). Counted across the shipped descriptions: shield 69,
// divineshield 14, champion 3, elite 1 — that is the whole set, so these four close it.
//
// NOTE these are NOT all mono like the class/gender art: shield is black+grey (shaded) and
// divineshield is genuinely BLUE (rgb 51,51,102 + 102,204,255). The build() colour rule
// handles that correctly without a special case — it only rewrites PURE black/white, so
// champion/elite (white -> invisible on paper) become currentColor while shield's grey and
// divineshield's blue survive untouched. Do not "simplify" that to a blanket rewrite.
const TOKENS = {
  shield:       { sym: 'RawFontIcon_shield',       viewBox: '-15.0 -77.9 82.3 91.4' },
  divineshield: { sym: 'RawFontIcon_divineshield', viewBox: '-12.6 -78.9 65.9 94.2' },
  champion:     { sym: 'FontIcon_champion',        viewBox: '-3.4 -68.9 62.8 74.0' },
  elite:        { sym: 'FontIcon_elite',           viewBox: '-10.6 -72.1 86.9 79.0' },
};

if (!fs.existsSync(SWF)) {
  console.error('missing', SWF, '— extract swfs/ui.swf from resources.gpak first');
  process.exit(1);
}
const swf = parseSwf(SWF);

function build(spec, label) {
  const out = {};
  for (const [key, s] of Object.entries(spec)) {
    const id = swf.symbols[s.sym];
    if (!id) { console.warn('  missing symbol', s.sym); continue; }
    const defs = [];
    let body = renderChar(swf, id, 0, defs, 0);
    if (!/<path/.test(body)) { console.warn('  no geometry for', s.sym); continue; }
    // Monochrome art: normalise both authored colours, on fill AND stroke. Butcher's outline
    // is a white STROKE — a fill-only rewrite left it invisible on the paper card.
    body = body.replace(/(fill|stroke)="rgb\(0,\s*0,\s*0\)"/g, '$1="currentColor"')
               .replace(/(fill|stroke)="rgb\(255,\s*255,\s*255\)"/g, '$1="currentColor"');
    if (/(fill|stroke)="rgb\(/.test(body)) console.warn('  NOTE', s.sym, 'kept a non-mono colour — check it renders');
    if (defs.length) console.warn('  NOTE', s.sym, 'has defs — ids would repeat across cards; namespace them');
    out[key] = { viewBox: s.viewBox, defs: defs.join(''), body: body };
  }
  console.log(' ', label + ':', Object.keys(out).length, 'of', Object.keys(spec).length);
  return out;
}

const stats = build(STATS, 'stats');
const classes = build(CLASSES, 'classes');
const genders = build(GENDERS, 'genders');
const tokens = build(TOKENS, 'tokens');

const js = '// AUTO-GENERATED by tools/export-ui-icons.js — do not edit.\n' +
  '// The game\'s real UI glyphs from swfs/ui.swf (FontIcon_*), as {viewBox,defs,body}.\n' +
  '// Fills are normalised to currentColor, so the card sets colour with CSS `color`; the\n' +
  '// class/gender art is authored WHITE and would be invisible on paper otherwise.\n' +
  '// CLASS_ICONS is keyed by the DECODER class name (Medic -> the FontIcon_Cleric art).\n' +
  '// No defs/gradients, so the markup is safe to repeat on every card.\n' +
  'const STAT_ICONS = ' + JSON.stringify(stats) + ';\n' +
  'const CLASS_ICONS = ' + JSON.stringify(classes) + ';\n' +
  'const GENDER_ICONS = ' + JSON.stringify(genders) + ';\n' +
  'const TOKEN_ICONS = ' + JSON.stringify(tokens) + ';\n' +
  'if (typeof module !== "undefined" && module.exports) {\n' +
  '  module.exports = { STAT_ICONS: STAT_ICONS, CLASS_ICONS: CLASS_ICONS, GENDER_ICONS: GENDER_ICONS, TOKEN_ICONS: TOKEN_ICONS };\n' +
  '  if (typeof global !== "undefined") { global.STAT_ICONS = STAT_ICONS; global.CLASS_ICONS = CLASS_ICONS; global.GENDER_ICONS = GENDER_ICONS; global.TOKEN_ICONS = TOKEN_ICONS; }\n' +
  '}\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, js);
console.log('wrote', OUT, (js.length / 1024).toFixed(1) + 'KB');
