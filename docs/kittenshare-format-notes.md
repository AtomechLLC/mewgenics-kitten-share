# KittenShare — save/asset format research notes

Working notes from reverse-engineering Mewgenics for KittenShare. Everything here
was verified against the real game files unless marked (hypothesis).

## Save files

- Location: `%APPDATA%\Glaiel Games\Mewgenics\<steam-id>\saves\*.sav`
  (backups in `saves\backups\*.savbackup`, same format)
- Format: **SQLite 3** database. Tables:
  - `cats(key INTEGER, data BLOB)` — one row per cat (campaign save had 1,308)
  - `files(key TEXT, data BLOB)` — `save_file_cat`, `pedigree`, `inventory_*`,
    `house_state`, `npc_progress`, `unlocks`, …
  - `furniture`, `properties`, `winning_teams`

## Cat blob (cats.data) — LZ4-compressed record

> **UPDATED 2026-07-14 (01-05/01-06):** the compact blob is **LZ4-block-compressed**,
> not a bit-packed stream. The "bit-packed serializer" framing below the header line
> was the pre-LZ4 misread — see **## Located layout** for the resolved truth. Once
> decompressed the record is the regular `save_file_cat`-style layout, and stats +
> the 14-slot appearance decode cleanly (100% stats / 99.0% appearance on the corpus).

Custom Glaiel serialization. Container framing (resolved):

- The blob is `[u32 decompressedSize LE][LZ4 block @ offset 4]`. The `u32 5090` at
  offset 4 is the **LZ4 stream start** (the compressed signature of every record's
  `[u32 19 SELF_MARKER]` header), which is why it reads 5090 for the whole corpus;
  it still doubles as the DEC-03 format gate. Decompress via `public/vendor/lz4.js`
  `decompressCatBlob` before reading any field.
- ASCII names / ability-ids survive as LZ4 literals (so they read raw even in the
  still-compressed bytes — which is why earlier tools got names but not stats/genes).
- **Name**: varint prefix where low 5 bits = `0x12` and `value >> 5 = charLen - 1`
  (verified: len 3 → `0x52`, 5 → `0x92`, 6 → `0xb2`, 8 → `0xf2 0x00` two-byte varint).
  Followed by UTF-16LE chars stored as **2×len−1 bytes — the final char's high
  byte is omitted**. This dropped-final-byte trick applies to ascii strings in the
  blob too (e.g. ability id `Infiltrate` is stored as `Infiltrat`).
  Robust extraction: find the longest `[printable, 0x00]` pair-run in the first
  ~96 bytes, accept one bare trailing char.
- Class (`Fighter`…`Colorless`), gender (`male26`/`female45`) and ability ids
  appear as ascii; match against known vocab (kittenshare/ability-ids.js).
- **Appearance genes: NOT located — spike-confirmed unresolved for build 5090.**
  They must encode the fields from custom_cats.gon (below). Byte-aligned scans for
  known stray gene sequences (Mangy2 body 1028 head 1028 tail 1010 …) found nothing
  → values are bit-packed or delta-encoded. See **## Located layout** below for the
  Phase-1 go/no-go finding and the debunked prior "gene block". Next approaches:
  controlled single-gene diff saves (unavailable this spike), or trace the
  `Mewgenics.exe` serializer.

## files.save_file_cat — fixed-width single cat (easier target)

The save-select poster cat, 931 bytes, regular layout:
`u32 19`, 8-byte uid, `u64 nameLen`, UTF-16LE name (full, not truncated),
u32 fields, `u64 len`-prefixed ascii strings ("None"), doubles, `-1` sentinels,
repeating 12-byte structs (ability list?). Field order likely matches the
compact blob. Decode this first next session.

## Appearance gene vocabulary (data/custom_cats.gon)

```
default_frame N   # base variant for all parts (e.g. 1000-1003)
texture N         # fur texture variant (1000, 1050=champion)
palette N         # row in textures/palette.png (0-255)
body/head/tail/leg1/leg2/arm1/arm2 N          # per-part frame override
lefteye/righteye/lefteyebrow/righteyebrow N
leftear/rightear/mouth N
claws N
```
Values are **frame indices into catparts.swf master sprites**.

## catparts.swf (extract via tools/ gpak parser; FWS uncompressed)

- Master sprites (SymbolClass names → char ids):
  `CatHead` 7132 (1700 frames), `CatBody` 8845 (1200), `CatTail` 10982 (1560),
  `CatLeg` 9925 (1505), `CatEar` 8051 (1505), `CatEye` 5949 (1088),
  `CatEyeClosed` 5165, `CatEyebrow` 5519 (1070), `CatMouth` 5947 (1502),
  `CatMouthSmile` 3435, `CatEye_Right` 2338, `CatTexture` 2675,
  item overlays `HeadItemF/B`, `FaceItemF/B`, `NeckItemF/B`, `Weapon`, `Trinket`.
- **frame index = part variant** (gene value). Each frame places layered shapes
  via PlaceObject2 with matrices; masks use clipDepth (render as SVG `<mask>`).
- `CatHeadPlacements` 11006 (1505 frames): per-head-frame **anchor sockets** —
  depth 31/35 = ear L/R (sx mirrored), 62/70 = eye L/R, 74/78 = eyebrows,
  66 = mouth, 82 = hat/top. Exported per-frame in kittenshare/parts.js.
- Part art is grayscale; the game tints it with the cat's palette (cxform).
  KittenShare emulates via `tintGrays()` — gray fills remapped onto the
  palette's dark/mid/light fur ramp.

## gpak container format

`[u32 entryCount]` then per entry `[u16 nameLen][name][u32 size]`, then raw file
data concatenated in TOC order (offset = TOC end + running size sum).

## Tools

- `tools/swf-inventory.js` — tag/symbol inventory of an FWS swf
- `tools/swf-sprite-dump.js` — dump a sprite's timeline placements
- `tools/swf-render.js` — DefineShape1-4 → SVG paths + sprite composer (masks OK)
- `tools/export-kittenshare-assets.js` — emits public/kittenshare/parts.js. Emits,
  per master sprite, the UNION of decoded frame indices used across the corpus (see
  `## Render coverage-gap fix`), plus HEAD_SOCKETS per used head frame. Regenerate the
  embedded union with `.scratch/compute-union.cjs` (decodes a corpus save).

## Located layout (Phase 1 decode spike — RESOLVED via LZ4)

> **RESOLVED 2026-07-14 (01-05/01-06).** The pre-LZ4 subsections below (STATS caveat,
> GENES UNRESOLVED) are the honest pre-decompression investigation trail and are now
> **OVERTURNED**. Current truth is stated here first.

**The compact blob is LZ4-compressed; decompress first, then it is the
`save_file_cat` record layout.** After `decompressCatBlob`:

- **Container:** `[u32 decompressedSize LE][LZ4 block @ offset 4]` (the 5090 word is
  the LZ4 stream start, not a separable build field; still a format gate).
- **Stats (7 core):** a run of 7 `Int32 LE` (STR/DEX/CON/INT/SPD/CHA/LCK) near
  offset **460** in the decompressed record, validated by the adjacent `Cp`
  status-effect ASCII string (length-prefixed name at `stats_off+84`). **HP** is the
  `u32` right after that status string, taken only when it reads as a plausible small
  positive int (Stian in-game: HP 32 matched). **MP is NOT stored — it is a FORMULA,
  `MP = Charisma × 3`** (derived on the card, never decoded; see the 02-04 disposition).
  **Level is NOT located → `null`** (unfalsifiable while every known cat is Lv 0).
- **Appearance record — 3 leading fields + 14-slot part table (01-06 RESOLVED):**
  locate the base offset `t`, then:
  - `f0`  float32 — coat/body **scale** (0.05..20).
  - `f4`  u32 — **pattern**: the fur TEXTURE id (1..706), repeated as each part
    record's 2nd u32 (`texture`). **NOT a color.** (Was mislabeled `coatId`.)
  - `f8`  u32 — **coatPalette**: the REAL fur **COLOR** — a direct row index into
    `textures/palette.png`, range **1..49** (= `catgen.gon num_palettes 49`). This is
    what the tinter keys on.
  - `f12` u32 — **classPalette**: class accent color row (50..68), or `0xFFFFFFFF`
    (decoded as `-1`) = none. Verified against `custom_cats.gon` miniboss palettes
    (Mage 55, Hunter 50, Tank 51, …) — 8/8 class↔palette matches.
  - then 14 part records at `t+16+s*20`, each `[frame u32, texture u32, …]`; the
    slot's frame index is `u32 @ t+16+s*20`, order `Body, Head, Tail, RearLeg_L/R,
    FrontLeg_L/R, Eye_L/R, Brow_L/R, Ear_L/R, Mouth`. Eye/Ear/Brow L/R pairs are
    exactly symmetric on valid records (the range+symmetry gate).
  - `appearanceVerified` = buildOk AND genes located AND slots in-range/symmetric AND
    **coatPalette in [1,49]**.
- **RO locator fix (01-06):** the old base locator gated the coat scale with
  `s < 0.05 || s > 20` — which lets **NaN pass** (NaN compares false) — and counted
  part records whose 2nd u32 was `0` (empty regions). Both bugs mislocated every
  **Colorless** cat ~12 bytes late (their coat region is often zeros), reading a
  phantom coat header. **Fix:** require the scale be **finite** and in [0.05,20], and
  require **≥3** of the 14 part records' 2nd u32 == the pattern value (`f4`), not the
  zero-region count. Correct base-location goes **~694 → 1311/1316** corpus cats.
- **Slot value → catparts.swf frame:** a decoded slot value is the **direct frame
  index** into that slot's master sprite (frame 0 = default). See
  `tools/export-kittenshare-assets.js` header.

## Rendering — real idle pose + real coat color (01-06)

The portrait is now composed from each cat's **real** decoded data, not hand-tuned
constants:

- **Idle-pose rig (`catanis.swf` `CatTest` id 1614, frame 0 = `idleF` keyframe).** 7
  part layers back-to-front by SWF depth (== `SerializeCatData` slot order): Tail,
  RearLeg_L/R, Body, FrontLeg_L/R, Head. Each layer carries a **full** SVG matrix
  `matrix(sx r0 r1 sy tx ty)` — rotation/skew (`r0`/`r1`) plus the ~**0.621** idle
  scale — applied inside a group offset `matrix(1 0 0 1 3.85 -47.95)`; recommended
  `viewBox -80 -100 170 135`. The four legs reuse one `CatLeg` sprite (L/R differ by
  skew). The **Head** layer is a group: `CatHead` + the existing `CatHeadPlacements`
  ear/eye/brow/mouth sockets in CatHead-local coords, wrapped in the Head matrix
  (replacing the old hand-tuned `matrix(1 0 0 1 0 -34)`). Part silhouettes (Tail/Body
  verified pixel-identical, Leg within 3px) share catanis's local coord system, so the
  catparts.swf art drops straight into the rig. Matrices are mirrored verbatim into
  `kittenshare.html` `CAT_RIG_FRONT` (not referenced from any scratch/spike path).
- **Coat color (`shaders/paletted_full.shader`).** The game recolors a grayscale part
  pixel by `texelFetch(palettemap, ivec2(r*15+0.5, palette))`: luminance picks a
  **column** (0..15), the cat's `coatPalette` row picks the **row**. Only gray pixels
  are remapped (col 0 = `#000000`, so black outlines survive); painted-color pixels
  pass through. KittenShare emulates this exactly with `CAT_PALETTE_LUT16[coatPalette]`
  (vendored in `public/kittenshare/palette-lut.js`); unverified cats fall back to a
  neutral gray row.
### Render coverage-gap fix (2026-07-14)

**Symptom.** Some real cats rendered bare-faced / wrong — e.g. **Eri** (key 2, head
160) had no face, **May** (key 109, head 170) rendered wrong. The pose, coat color and
decoder were all correct; the fault was the **exported asset set**, not the render math.

**Root cause — stale frame union.** `public/kittenshare/parts.js` is generated by
`tools/export-kittenshare-assets.js`, which emits only the per-sprite UNION of frame
indices that real cats actually reference (a full contiguous band would bloat the file).
That union was computed **before the RO appearance-locator fix (commit 154b1c3)**. The
fix changed which frames the ~617 Colorless cats decode to, so the embedded union
covered a **stale** set — missing ~30-40 frames **per slot** (Body 38, Head 40, Tail
32, Legs ~38, Eyes 41, Brows 32, Ears 34, Mouth 38), and `HEAD_SOCKETS` was missing 40
used head frames (including head 160). For any missing frame `partSvg()` correctly falls
back to the part's default **frame 0** (never injecting markup), so those cats rendered
the base-kitten look / a socket-less bare head ball. This was a COVERAGE gap, not a
scaling or decode bug (head art is identical size across frames).

**Fix — regenerate the complete union.** Re-decoded EVERY cat in the corpus save with
the CURRENT `save-decode.js` (`.scratch/compute-union.cjs`) and rebuilt the embedded
`FRAME_UNION` from that post-fix set (CatLeg = union of all four leg slots). New per-slot
counts: Body 135, Head 135, Tail 141, Leg 174, Eye 145, Eyebrow 139, Ear 130, Mouth 136
(was ~91-137). parts.js grew 2.9 MB → **3.75 MB** (well under the ~8 MB chunk-later
threshold). Post-regen census: **1,016 appearance-verified cats have 0 missing art
frames in any slot and 0 missing head sockets**; Eri (head 160) and May (head 170) now
render real faces (verified headless with the shipped `renderPortrait`).

**Head sockets — documented fallback.** `HEAD_SOCKETS` now emits one entry for **every**
used head frame. If `CatHeadPlacements` ever lacks placement data for a used head frame,
the exporter borrows the **nearest available frame's** sockets (ties → lower frame, else
frame 0) so no cat is ever socket-less (a bare ball). On the current corpus **0 frames**
needed the fallback — all 135 used head frames carry their own CatHeadPlacements data.

### Fur PATTERN overlay — RESOLVED (2026-07-14)

The fur **PATTERN** (tabby/spots/stripes) now composites in `renderPortrait`. It is a
*separate* grayscale sheet: `pattern (f4)` → a **`CatTexture`** frame index in
catparts.swf (symbol 2675, 2800 frames). The corpus-union set of decoded `genes.pattern`
values (133 frames) is exported to `public/kittenshare/patterns.js` as
`CAT_TEXTURES[pattern] = {defs, body}` (same shape as a `CAT_PARTS` frame).

**Composite model** (proven by the pattern spike + `test-align.js` co-registration proof):

- **Which texture.** `CAT_TEXTURES[genes.pattern]`; absent (pattern outside the set, or a
  no-pattern placeholder) → skip the overlay, part renders solid fur (never a box).
- **Z-layer — per textured slot, not one whole-cat layer.** The texture is drawn
  **immediately after each part's body, INSIDE that part's rig-layer `<g>`**, sharing the
  part's rig matrix verbatim (identity placement). Textured slots = `CatBody`, `CatHead`,
  `CatTail`, and all four `CatLeg`s (`PATTERN_SLOTS`). Ears and the small painted facial
  features (eyes/brows/mouth) are **not** textured; on the Head the texture goes on
  `CatHead` only, **before** the eye/brow/mouth sockets so features stay on top.
- **Masking — clip to the part's own silhouette.** A `<mask>` is built from the part's own
  body art with every fill/stroke forced white (`silMask`), so the flat native texture is
  clipped to *that part's* slice of the pattern — **not** the texture's rectangular box.
  The native part silhouette and native texture content share one coordinate system in
  catparts.swf (align proof: `CatBody` 223 ∩ `CatTexture` 427 land with zero offset).
- **Tint — same coat LUT as the part.** The texture is the fur luminance map, drawn opaque
  over the part's gray placeholder rect; the final `tintGrays()` pass remaps its grays
  through the **same** `CAT_PALETTE_LUT16[coatPalette]` row, so markings come out in the
  cat's coat color. `tintGrays` was extended to also remap gradient **`stop-color`**
  rgb/rgba (preserving alpha) — the soft-spot frames encode their markings as radial
  gradients that the fill/stroke pass never touched (they would otherwise render raw gray).
- **Id namespacing (mandatory).** A cat composites ~14 parts + up to 6 texture overlays
  into one `<svg>`; `namespaceIds()` suffixes every mask/gradient id per instance
  (`#id` → `#id_uN`) so duplicate ids can't make the browser resolve `url(#..)` to the
  wrong element and mis-clip.

**One approximation.** SVG can't do the game's per-pixel UV texture sampling; the flat
native texture masked to each part means **stripes render straight**, not wrapped to the
body contour. They still read unambiguously as the cat's markings. The card labels this
honestly ("real pose + coat color + fur pattern · stripes render straight (no UV contour
wrap)"). `patterns.js` is ~540 KB — the single largest page asset, acceptable for a
self-contained (no-build/CDN) tool.

Verified headless against the shipped `renderPortrait`: Churrito (pattern 112, tabby) and
Melinka (pattern 427, soft-spot gradient) each render 7 per-part masked texture overlays
where a no-pattern cat renders 0; Melinka's gradient stops tint through the LUT with alpha
preserved; a cat whose pattern isn't in the set stays solid (no box).

### Textured box-frame investigation (2026-07-14)

**Question.** A handful of textured part frames export with **empty `defs`** and render
as a solid filled rectangle (the "box" bug) instead of a masked part silhouette —
e.g. `CatLeg` frame **250**. The hypothesis was a **mask-extraction bug** in
`tools/swf-render.js`: that a stateful Flash mask (a `PlaceObject` with `clipDepth`)
was being dropped when carried across later sprite frames, so the texture rectangle
rendered unclipped.

**Finding — there is NO mask-extraction bug.** Audited every textured union frame
(`CatBody/CatHead/CatTail/CatLeg/CatEar`) against the raw master timeline. Exactly
**11** distinct union frames render maskless, and **all 11** have **no `clipDepth`
placement in the master display list at that frame** (`realBug = 0` for every slot —
i.e. there is not a single frame where the SWF *has* a clip mask that the renderer
failed to emit). `parseSpriteBody` carries `clipDepth` across frames correctly
(the display list `cur` is stateful and copies prior entries on a move), and
`renderChar` emits an SVG `<mask>` for every clip that exists. Re-running the export
with no code change reproduces the byte-identical `parts.js`.

**Why the boxes are genuinely maskless.** The master `CatLeg` sprite is a Flash
timeline of dense **keyframe bands** (each frame a distinct masked leg, e.g. 245–249,
299–321, 399–440) separated by long **held/filler runs** (250–298, 322–398, …). At a
keyframe (e.g. 301) the master places a **mask shape** at depth 1 (`clipDepth 24`)
that supplies the leg silhouette, clipping the gray texture-box child. At frame 250 the
mask layer has ended: the display list is just `box(9053)@d1 + lineart(9083)@d21 +
detail(9086)@d26` with **no clip**, so the raw gray texture rectangle is all that a
static render of that frame can produce. The per-frame line/detail art of the held
frames lives in **frame-synced graphic child layers** (e.g. child `9083` is empty at
its frame 0 but draws real filled art at its synced frame ~250); the renderer pins
every nested child to **frame 0** (`renderChar(..., 0, ...)`), which is the correct,
regression-free choice for masked keyframes (box@0 + master mask = textured
silhouette) but cannot reconstruct a silhouette for a held frame that has no master
mask. Full graphic-symbol frame-sync would change the output of **all** 1,016
currently-verified cats (the box child `9053` becomes a real per-frame silhouette that
then double-masks under the keyframe mask), so it is a **rig-level change out of this
scope** — deferred, not a bug fix.

**The 11 maskless frames (verified-cat reference counts, corpus census 1,016 verified):**

| Slot     | Frame | Refs | In master |
| -------- | ----- | ---- | --------- |
| CatBody  | 324   | 190  | no clip   |
| CatBody  | 704   | 11   | no clip   |
| CatBody  | 900   | 2    | no clip   |
| CatHead  | 706   | 16   | no clip   |
| CatHead  | 900   | 2    | no clip   |
| CatTail  | 704   | 31   | no clip   |
| CatTail  | 900   | 1    | no clip   |
| CatLeg   | 250   | 134  | no clip   |
| CatLeg   | 707   | 30   | no clip   |
| CatEar   | 704   | 28   | no clip   |
| CatEar   | 900   | 4    | no clip   |

These cluster on **default/sentinel gene values** (Body 324, Leg 250 dominate) plus a
small `704/706/707/900` mutation-adjacent band — high-traffic "default" values, not a
lost mask. The prior "~72 maskless frames" estimate is **stale** (pre RO-fix decoder +
union regen); the real, current number over all verified cats is **11**.

**Tiny Tina (key 1075)** decodes to `FrontLeg 303 / RearLeg 301 / Body 408 / Head 65 /
Tail 84 / Ear 72 / Mouth 432 / Eye 327 / Brow 170` — **none** of which is a maskless
frame. Legs 301/303 are dense keyframes that render with real `mask=` silhouettes. She
has **no** box frames; the earlier note that her FrontLeg 303 was a "box'd mutation
frame" is incorrect.

**Resolution.** No renderer change is warranted (making one would be a no-op or a
regression-risky rig change). The `partSvg()` box-frame guard in `kittenshare.html`
(`TEXTURED_SLOTS` maskless → frame 0) is **retained** and is confirmed to handle
exactly these 11 genuine default frames — frame 0 of every textured slot renders with a
real `mask=` silhouette, so the affected cats show a real (if generic) base part rather
than a box. Recovering each held frame's true silhouette requires frame-synced
graphic-symbol rendering (Phase-2 rig scope).

> ### ⚠️ SUPERSEDED 2026-07-16 (plan 02-04) — the section above is WRONG
>
> **All 11 frames now render MASKED. There WAS a bug; two of them, in fact.** The audit's
> headline conclusion ("there is NO mask-extraction bug", "genuinely maskless", "defer the
> rig change") does not survive re-testing — see **"Box-frame disposition (02-04)"** below.
> The 11-frame table is kept only as a record of the wrong turn; do not act on it.

**Corpus census (01-05):** decompressed 1316/1316 (100%), stats 100%, appearance +
L/R symmetry 99.0%; golden harness locks it fail-loud. In-game ground truth: cat
**Stian** — name/gender/all-7-base-stats(=7)/HP(32) matched exactly.

### Pre-LZ4 investigation trail (OVERTURNED — retained for honesty)

Build 5090. Corpus: 25 ad-hoc campaign saves + 16 rolling backups (all one
campaign, `steamcampaign02*`). **No controlled single-gene saves were available**
— the plan's primary attack (diff two saves after a single in-game appearance
change) could not be run. The finding below WAS the NO-GO / fallback outcome for
appearance genes — now overturned by the LZ4 discovery above.

### STATS — LOCATED (self-describing `save_file_cat`)

The seven core stats are a run of **7 plain `u32` LE** in `files.save_file_cat`,
in the `player_cat.gon` order:

| field | STR | DEX | CON | INT | SPD | CHA | LCK |
|-------|-----|-----|-----|-----|-----|-----|-----|
| Lucina (poster) | 4 | 4 | 6 | 7 | 4 | 5 | 5 |

- Anchor: immediately after the gender string (`male6`) + a pitch `double`
  (`0.8863…`); at offset **457** in the 931-byte poster record. Terminated by the
  trailing zero padding, then the ability/spell list (`DefaultMove`,
  `BasicShortRanged`, `Reduce`, … , class `Colorless`).
- Encoding is **`u32`, NOT IEEE-754 doubles** — correcting the plan/research
  assumption A3. Values cluster around the PlayerCat default of 5.
- Verify: `node tools/decode-genes-proof.js tools/fixtures/save_file_cat.bin`.

**Caveat:** this is the *self-describing poster* record. Per-cat stats in the
compact `cats.data` blob are bit-packed in the variable-length tagged stream and
are **not** cleanly decodable without the serializer or controlled saves. So even
stats are only proven for the regular record, not for what KittenShare reads.

**Compact stats decode ATTEMPTED and disproved (2026-07-14, plan 01-04).** The
voice→pitch→stats anchor + S2.1 tag value rule was tried against the full corpus
via `tools/decode-compact-stats.js`: the ordering sanity passes (recovers Lucina
4,4,6,7,4,5,5) but the live-corpus census yields **0/1,297** clean 7-int runs —
the compact STATS window shows the same variable/optional-subfield ambiguity that
defeated appearance (FINDINGS S2.2), and no ground truth exists (Lucina absent from
`cats`; stat changes re-serialize the blob at a different length, defeating
byte-diff). **VERDICT: NO-GO.** Compact stats stay `null`, consistent with genes;
see `docs/kittenshare-decode-decision.md` "## STATS — compact blob UNRESOLVED
(fallback adopted)". **HP/MP/level remain UNRESOLVED in BOTH formats.**

### ⚠ Debunked prior finding — "u32 appearance-gene block"

The previous spike reported a *"7-value u32 appearance-gene frame-index block
`[1087,1024,1536,1792,1024,1280,1280]` @456"* in `save_file_cat` and called it a
"strong GO lead". **It is a mis-aligned read.** `0x3f` at offset 456 is the high
byte of the double at 449 (`0.8863…`); reading `u32` one byte early manufactures
values that happen to fall in the 1000-2700 frame range. The correctly-aligned
`u32` at **457** are the stats `4,4,6,7,4,5,5`. `save_file_cat` contains **no**
appearance-gene frame-index block. `decode-genes-proof.js` deliberately requires a
clean run of ≥12 in-range integers before flagging a gene "candidate", so this
7-long misalignment ghost correctly stays UNRESOLVED.

### GENES — UNRESOLVED (bit-packed; fallback adopted)

Appearance-gene frame indices are **not stored as plain aligned integers** in the
compact `cats.data` blob:

- **Full-corpus pattern search** (1,308 cats, `steamcampaign02.sav`): median **2**
  in-range (`[1000,2700]`) aligned `u32` per cat, max 11 — nowhere near the ~18 a
  plain 18-field gene block would need. The ~27 in-range `u16`/cat are unaligned
  coincidental byte pairs (noise), not gene fields.
- **Poster cross-reference failed:** the only cat with any candidate gene values
  (`save_file_cat` = "Lucina", uid `8b1b5976a321870c`) is a fixed poster cat that
  is **not present in the `cats` table** of any of the 25 saves, so its values
  cannot be triangulated into a compact blob.
- **Compact format is a variable-length tagged bit-packed stream:** ascii tokens
  (`male26`, class `Colorless`, ability ids like `Infiltrat`) are interleaved with
  packed binary and `double`s; a single stat change re-serializes the cat at a
  **different length** (confirmed: 4 cats changed between two saves 1 min apart,
  all length-changes 474→608, 645→638, …). Because downstream field offsets shift,
  byte-offset diffing cannot isolate a gene field without first aligning the tag
  stream — which needs the serializer or controlled single-gene diffs.
- Ground truth exists (`data/custom_cats.gon`: `default_frame/texture/palette` +
  per-part `body/head/tail/leg1/leg2/arm1/arm2/…` frame indices), but campaign
  cats are **bred** (procedural), so they never match a named template exactly and
  can't be used as a known-value crib.

**Stopping trigger (a) fired** (not the 4-hour budget): the equivalent of the
diff-iteration budget — poster-cross-reference, full-corpus pattern search,
temporally-adjacent diff, and the `save_file_cat` cross-check — all completed
**without** producing a candidate gene cluster decoding to plausible frame indices
in 1000-1799. No ImHex bitfield pass was warranted because there is no isolated
single-gene diff window to point it at (the primary method that would produce one
was unavailable).

**Go/no-go decision input:** appearance genes = **NO-GO for build 5090 from this
corpus.** 01-03 should adopt the pre-agreed **fallback scope**: decode
name/class/gender/abilities (all working) + stats (from the self-describing
record), render the portrait with the default gene range, and mark appearance
**"unverified."** A future GO requires either (1) controlled single-gene saves to
diff, or (2) reversing the `Mewgenics.exe` cat serializer. Do NOT fabricate gene
offsets to claim a GO.

## KittenShare page status (v1)

- Reads .sav locally via sql.js (public/vendor/), parses names (100% on the
  1,308-cat test save), class/gender/abilities via vocab match.
- Portraits: real game art, default gene range + per-key pseudo palette —
  **not the cat's true appearance yet** (labeled WIP in the UI).
- Share links: cat data compressed into `#k=` base64url fragment, rendered
  standalone without a save file.

## Mutations — decode + labels (mutation-spike, 2026-07-14)

**Mutations are NOT a separate structure — they are the appearance part-frames
themselves.** A slot's frame value (the `u32 @ t+16+s*20` decoded above, and the
`pattern`/`f4` field for fur) encodes the mutation directly:

- `slotId` in **1..~250** → a **base** part (no mutation). `catgen.gon` sets the base
  part sets 250 wide (`num_bodies/heads/legs/... = 250`, `num_textures 250`).
- `slotId >= 300` → a **MUTATION**. The id is the block key in
  `data/mutations/<category>.gon`; e.g. legs 303 = "Lobster Claws" (crab hands),
  eyes 327 = "Baby Blue Eyes", body 750 = "spike body". Bands: `300..~360` named
  signature mutations, `400..441` unnamed common **stat-mod** parts (`tag common`,
  no in-game name — labelled by their stat delta), `700..~763` birth defects
  (`tag birth_defect`), `750+/900/1026/1500` rare/celebrity.
- `slotId == 0xFFFFFFFE` (or `0xFFFFFFFF`) → **part hidden/removed** sentinel, NOT a
  mutation — never looked up.

The mutation ART already renders via the existing frame rig (a mutation is just a
higher-numbered frame of the same `CatBody/CatLeg/...` clip, `gotoAndStop(slotId)` —
frame replacement, no overlay layer). This decode adds the **human-readable labels**.

**Slot → logical region (dedupe).** The 14 slots map to display regions; the 4 leg
slots split **rear "Legs"** vs **front "Arm"**, and the paired Eye/Brow/Ear L/R slots
each collapse to one region so a symmetric mutation is reported **once** (a genuinely
one-sided mutation still lists both, being distinct region+id). The fur/texture
mutation rides in `pattern` (`f4`), region "Fur", category `texture`.

**Catalog.** `public/kittenshare/mutations-catalog.js` — a self-contained (no build,
no CDN, no runtime file read) `{ category: { id: {name, effect, type} } }` lookup
(755 entries across 9 categories) generated from the game's `data/mutations/*.gon`.
`name` = the block's `//comment`; the common 400-band has no name so carries only
`effect` (its stat delta); `type` = `mutation | common | defect`.

**Decode + display.** `save-decode.js decodeMutations(catalog, pattern, slots)`
returns `genes.mutations = [{region, slot, category, id, name, effect, type,
inCatalog}]`; `kittenshare.html mutBlock()` renders a compact "🧬 Region: Name ·
Region: Name" line, only for mutated cats. **Honest labelling:** an id absent from the
catalog is `"Unknown mutation #<id>"` (inCatalog=false), never dropped or fabricated.

**Census (corpus `steamcampaign02.sav`, 1298 cats):** **1066 = 82.1 %** have ≥1
mutation, **100 % catalog coverage** (0 Unknown), 251 distinct ids. Oracle **Tiny
Tina (key 1075)**: 6 regions — Arm **303 Lobster Claws** ✓, Legs 301 Hooves, Body 408
(common +2 CON/-1 CHA), Eyes 327 Baby Blue Eyes, Mouth 432 (common **`:3`** = +2
LCK/-1 CHA), Fur 427 (common). Golden-locked on the `save_file_cat.bin` fixture
(9 regions) in `tools/golden-save-test.js`.

## AST-02 render-tail dispositions (Phase 2, plan 02-04)

Phase 2 closed the AST-02 render-fidelity tail carried from Phase 1. Pose / head
sockets / coat COLOR / fur PATTERN were built + verified in Phase 1; 02-04 is the
honest disposition of the three remaining tail items + a no-regression re-check after
the 02-03 full-coverage chunk export. **Locked decision D5** governs all three — none
was re-opened. Nothing was silently scoped out (threat T-02-11): each item below has an
explicit documented disposition and a human in-game re-confirmation checkpoint.

### 1. Maskless textured frames — RESOLVED (all 11 now render their TRUE art)

**REWRITTEN 2026-07-16. The earlier disposition ("11 genuinely maskless in the master
timeline — not an extraction bug; rig fix deferred as regression-risky") was WRONG on
both counts. There were two real bugs, and both are now fixed.**

Re-testing the exact 11 frames the investigation named, against current assets:

| Slot | Frame | Refs | Then | Now |
| ---- | ----- | ---- | ---- | --- |
| CatBody | 324 | 190 | maskless "box" | **MASKED** (defs 1371) |
| CatBody | 704 | 11 | maskless | **MASKED** (defs 2445) |
| CatBody | 900 | 2 | maskless | **MASKED** (defs 1606) |
| CatHead | 706 | 16 | maskless | **MASKED** (defs 843) |
| CatHead | 900 | 2 | maskless | **MASKED** (defs 684) |
| CatTail | 704 | 31 | maskless | **MASKED** (defs 611) |
| CatTail | 900 | 1 | maskless | **MASKED** (defs 565) |
| CatLeg | 250 | 134 | maskless | **MASKED** (defs 624) |
| CatLeg | 707 | 30 | maskless | **MASKED** (defs 777) |
| CatEar | 704 | 28 | maskless | **MASKED** (defs 640) |
| CatEar | 900 | 4 | maskless | **MASKED** (defs 475) |

**11 of 11 resolved → 449 cat-slot references that were showing a generic fallback part
now render their true art.** Two root causes, neither of them "the art is like that":

1. **The off-by-one (`ff(v)=v-1`).** The audit inspected `frames[324]`; we render
   `frames[323]`. It measured the wrong frames and concluded the art was maskless.
2. **A RECT is byte-aligned** (`swf-render.js parseRECT`). Every `DefineShape4` in
   catparts — 124 of 124 — failed to parse, because DefineShape4 is the only shape with
   two back-to-back RECTs (ShapeBounds + EdgeBounds) and we read the second mid-byte.
   Symptom was `unknown fill type 0x<garbage>`. See that section for the full write-up.

**Current measurement:** of the frames real cats actually use (the corpus union), **0
trigger the box-frame guard.** Across full chunk coverage 4651 of 7470 textured frames
are maskless, but **none are in our corpus** — they are unused/held frames.

**The guard STAYS — but as a safety net, not "the correct permanent handling".** A
shared `#k=` link from another player's save can name a frame outside our corpus, and
the guard keeps that a real generic part instead of a solid box. It is now dead code for
every cat we have ever decoded.

### 2. Scar — CONFIRMED OUT-OF-MODEL (not built)

The **scar** decal is a **separate injury/decal system, NOT part of the appearance-gene
model.** `decodeCat` produces no scar field: the appearance record is the 3 leading
fields (scale / pattern / coatPalette / classPalette) + the 14-slot part table, and the
gene vocabulary in `data/custom_cats.gon` (`default_frame / texture / palette` + per-part
`body/head/tail/leg/eye/ear/brow/mouth/claws` frame indices) has **no scar entry**. Scar
is therefore **confirmed absent from the appearance render scope** and is **not built**
this phase (assumption A5 resolved: out-of-model, confirm-absent — no decal system added,
nothing fabricated).

**UPDATE 2026-07-16 — the scar ART is now LOCATED (storage still is not).** The above
stands for the *gene model* (decodeCat still produces no scar field). But the claim
elsewhere in these notes that "scar art is NOT in catparts.swf — try effects.swf" was
**wrong**: it is nested inside each part, as UNNAMED sprites, which is why symbol-name
searches missed it. Frame counts match `data/injuries.gon`'s scar ranges exactly:

| Layer | Frames | injuries.gon range |
| ----- | ------ | ------------------ |
| CatHead depth 27 → sprite 6337 | 46 | `Radiated head[42,46]` |
| CatBody depth 22 → sprite 8083 | 30 | `Radiated body[26,30]` |
| CatLeg depth 22 → sprite 9083 | 31 | `TornTendon limbs[21,31]` (also arms[10,20], legs[2,9]) |

CatTail/CatEar carry no scar layer. **Frame 0 of 6337 is EMPTY**, so the frame-0 pin does
not wrongly draw scars — they simply never show. Remaining work is the STORAGE side:
injury ids are numeric (not ascii tokens — scanning the keys hits only "Cursed" on 7
cats, which is the ITEM `cursed true` flag), so they need a diff pass. Scar stays
**out-of-model and not built** for Phase 2; the art being located changes the estimate,
not this phase's scope.

### 3. MP / level — MP is a FORMULA (solved); level CONFIRM-NULL

> **UPDATE 2026-07-16 — MP is no longer confirm-null. It was never stored.**
>
> **MP = Charisma × 3.** It is *computed*, which is exactly why every byte-scan below
> failed: there is no MP field to find. Sourced from mewgenics.wiki.gg and consistent
> with the corpus (garik cha 3 → MP 9, churrito cha 5 → 15, reinaldo cha 4 → 12). The
> card derives it via `derivedMp(cha)` rather than decoding it, so this is a resolution,
> not a fabrication — the same shape as **HP = effective CON × 4**, verified at 99.1%
> (105/106 decoded `hp` values divisible by 4), which makes `effectiveCon = hp/4` an
> exact oracle for one stat.
>
> **LEVEL stays confirm-null, and the blocker is GROUND TRUTH, not scanning.** Every cat
> we can read in-game is **Lv 0** (Arcadia, Guiseppi, and Filip on the latest screenshot).
> A field that reads 0 for every known cat is **unfalsifiable** — any all-zero tail slot
> fits equally well, and level cannot be distinguished from padding, XP, or a reserved
> field. Note the record has a FIXED 103-byte tail (`birthDay` at len−103, `deathDay` at
> len−95), so the end-anchored diff that cracked birthDay is the tool that would resolve
> level **in one pass — as soon as a save contains a cat at Lv > 0** (level is gained on
> adventures; house kittens are Lv 0). That is the unblocking condition; more scanning
> against Lv-0 cats cannot help.

*(Original bounded-attempt record follows — its MP conclusion is superseded above.)*

`stats.mp` and `stats.level` are honest `null` today (the payload schema reserves both
so a future locate needs no schema bump). Per D5, **one bounded locate attempt** was made
in the decompressed record around the located 7-core-stat block (`jv`, near offset 460)
and the `hp` anchor, across all four committed fixtures (garik / churrito / reinaldo /
save_file_cat):

- The 7 core stats occupy `statOff .. statOff+24` (7×`int32`); the region immediately
  after (`+28 .. +80`) is padding/zeros except **one** sporadic small int at `statOff+40`
  reading `{garik:1, churrito:1, reinaldo:2, save_file_cat:0}` — **inconsistent** (0 for
  the poster cat) and not a validated MP/level pair.
- The `hp` slot (the `u32` after the `Cp` status string) reads a **constant float ≈2.0**
  (`0x3FFFFFFF`) for every fixture, so `hp` also stays `null` there — consistent with the
  existing `jv` guard (hp only trusted when it reads a plausible small int 1..999; the
  in-corpus cat **Stian** did validate HP 32, but no committed fixture does).
- **No in-game ground truth for MP/level exists for the committed fixtures**, so no
  candidate can be validated as consistent. Wiring `{1,1,2}` in as "MP" or "level" would
  be **fabrication** — forbidden (D5, Phase-1 discipline).

**Outcome: confirm-null.** MP/level unlocated after this bounded Phase-2 attempt — the
reserved fields **stay `null`**, `save-decode.js` is unchanged (`hp: hp, mp: null,
level: null` in `jv`), and no value is fabricated. This matches the Phase-1 NO-GO
precedent on the compact-stats decode. (Bounded-attempt inspector: throwaway
`.scratch/mp-level-locate.cjs`, not committed — it only reads the fixtures, changes no
shipped code.)

### No-regression golden (02-03 full-coverage export)

`tools/golden-save-test.js` was extended (not rewritten) with a **no-regression**
assertion: every ground-truth VERIFIED fixture's decoded slot frames **and** fur pattern
each resolve to a real `parts/`/`patterns/` manifest range whose chunk file exists on
disk and **contains that exact frame as an entry** — i.e. the full-coverage chunk export
renders the known cats' exact frames, unchanged from the corpus-union behaviour. The
frame-0 box-guard fallback is asserted resolvable per sprite. The existing exact
name/stats/appearance goldens still pass byte-identically (the 7 core stats + appearance
are unchanged). It lifts the page's OWN `resolveChunks`/`SLOT_TO_SPRITE` (via the
`@resolver` markers) so the page and the harness cannot drift.
