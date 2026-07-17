# KittenShare decode — go/no-go decision record (Phase 1 gate)

**Decision: GO (on the decode)** — as of the 01-05/01-06 gap-closure wave the cat
blob **decodes correctly and is verified against real in-game ground truth**. The
Phase-1 gate is **GO**, scoped precisely: GO is on the **decode** (names, stats,
appearance genes). Pixel-accurate **portrait rendering** is consciously **deferred
to Phase 2** by an explicit user decision at the visual-match checkpoint (see
"## Decision: GO" below). The prior NO-GO records are preserved further down as a
**superseded / OVERTURNED** historical trail.

- **Date:** 2026-07-14
- **Phase:** 01-decode-spike-go-no-go-gate, gap-closure plans 01-05 (LZ4 decode) +
  01-06 (render wiring + this GO record)
- **Requirements:** DEC-01 (appearance genes), DEC-02 (stats — 7 core + HP; MP/level
  deferred), DEC-03 (build gate), DEC-04 (golden harness), DEC-05 (shared module)

## Decision: GO

**GO is on the DECODE.** The launch-bar question — *can KittenShare decode a cat's
appearance genes + stats from the compact `cats.data` blob?* — is answered **yes**,
and the decode is now confirmed against real in-game ground truth.

### Root cause of BOTH prior NO-GOs (the LZ4 discovery)

Every compact `cats.data` blob is **LZ4-block-compressed**:
`[u32 decompressedSize LE][LZ4 block @ offset 4]` (the "5090 build" word at
compressed offset 4 is the LZ4 stream start — the compressed signature of every
record's `[u32 19 SELF_MARKER]` header — and still functions as a format gate).
**Every prior tool decoded the still-compressed bytes**, so stats and appearance
part-frames looked absent or bit-packed. Decompress first (`public/vendor/lz4.js`
`decompressCatBlob`) and the record is the plain `save_file_cat`-style layout: the
7 core stats read as a run of `Int32` near offset 460 (validated by the adjacent
`Cp` status-effect ASCII string), and the appearance is a **14-slot part table**
(coatId = `u32 @ t+4`, each slot `u32 @ t+16+s*20`), with Eye/Ear/Brow L/R pairs
exactly symmetric.

### Evidence (GO)

1. **Full ~1,316-cat corpus census** (real `steamcampaign02.sav`, build 5090; see
   `01-05-SUMMARY.md`): **decompressed OK 1316/1316 (100.0%)**, **stats-decoded
   100.0% (1316/1316)**, **appearance+symmetry 99.0% (1303/1316)** (the ~1% are
   genuinely asymmetric/non-standard records, decoded honestly, never forced).
2. **Fail-loud golden harness** locks the decode: `tools/golden-save-test.js`,
   `tools/save-decode.test.js`, `tools/lz4-decode.test.js` assert exact
   name/stats/appearance + L/R symmetry against committed fixtures
   (`garik.bin`, `churrito.bin`, `reinaldo.bin`) — any layout drift fails the suite.
3. **In-game ground-truth match (the human check ROADMAP SC1 required).** The user
   opened cat **"Stian"** in-game and compared the shipped decoder's output: name
   **"Stian"**, gender **male**, all **seven BASE stats = 7** (the game showed base
   7 with buffs layered on top), **HP 32** — an exact match. This is a definitive
   decode-correctness proof against real in-game ground truth, not a machine-only
   check.
4. **Appearance genes decode correctly:** slot values are in-range, L/R-symmetric,
   and cross-validated against the fan editor's decode path; distinct per-cat
   portraits compose from them (01-06 headless proof: 0 missing-part references
   across the corpus; 125 distinct portrait signatures in the first 200 cats — the
   single-neutral-placeholder signature that drove the prior NO-GO is gone).

### Scope split — SC1 render clause deferred to Phase 2 (user decision)

ROADMAP Success Criterion 1 reads: *"the rendered card visibly matches the in-game
portrait."* At the 01-06 visual-match checkpoint the user confirmed that while the
**genes decode correctly**, the **rendered non-default portraits are not accurate**.

- **Root cause (confirmed):** only the **head** parts are placed with the game's
  real anchor data (`HEAD_SOCKETS` from `CatHeadPlacements`). The **body / legs /
  tail** are placed with hand-tuned constants. The full-body idle-pose puppet rig
  lives in **`catanis.swf` (9.4 MB, currently unextracted)**. Accurate composition
  is Phase-2 asset scope (**AST-02**).
- **User decision at the checkpoint (explicit):** close **Phase 1 as GO on the
  decode**, and move **accurate rendering to Phase 2**. The Phase-1 card renders a
  **labeled best-effort approximation** ("approx. render — accurate portrait coming
  in a later update"); it does **not** claim pixel-accuracy anywhere.
- **SC1 accounting (user-authorized scope split):** the **decode half** of SC1 is
  **met and verified** (Stian ground-truth match); the **accurate-render half** is
  **deferred to Phase 2 (AST-02, `catanis.swf` idle-pose rig extraction)**. This is
  a real user decision made via the checkpoint, recorded here as *user decision at
  checkpoint* — no name/email is signed on the user's behalf.

### DEC-02 — partial (DRAFT, for the re-verifier to rule on)

The **7 core stats AND HP** decode and render for real cats. **MP and level are NOT
located** in the decompressed record and stay `null` (no fabrication).

> **Partial-DEC-02 note (ACCEPTED):** "7 core stats + HP decoded and rendered for
> real cats; MP/level deferred as unlocated."
> **accepted_by:** user (GSD close-out decision: chose to formally close Phase 1 on
> the GO-on-decode basis)  **accepted_at:** 2026-07-14
> (Attribution reflects the user's explicit close-out directive — NOT a claim that the
> user personally located or verified MP/level. MP/level remain unlocated → null and
> are deferred to Phase 2.)

### DEC-01 — texture

DEC-01 names "texture" alongside frame indices + palette. **Texture is subsumed by
`coatId`** — the single coat/palette selector that also drives the fur sheet; there
is no separate texture field surfaced. A wrong coat/texture would show visibly, so
the render is the backstop (and the render is currently labeled approximate anyway).

### Phase-2 boundaries (deferred, not in Phase 1)

- **AST-01:** full per-slot asset coverage (lazy-loaded manifest).
- **AST-02:** accurate puppet rig / pixel-match — extract the `catanis.swf`
  idle-pose body/leg/tail placement rig so portraits match the game.

## Formal close-out (2026-07-14) — Phase 1 CLOSED, GO on decode

Per the user's explicit GSD close-out decision, **Phase 1 is formally CLOSED as GO on the
decode.** Since the GO record above, the render advanced substantially: the KittenShare card
now renders cats with the **real `catanis.swf` idle rig** plus their **real coat COLOR**
(`coatPalette` = the `palette.png` row at `base+8`, range 1..49, via a 16-column LUT), full
frame coverage, per-instance mask-id namespacing, box-frame fallback, and **decoded mutations**
(`slotId ≥ 300` → catalog; e.g. Tiny Tina "Lobster Claws"/":3"). 82% of cats are mutated with
100% catalog coverage. The earlier "coatId out of palette range → fallback tint" finding is
**resolved** (coatPalette decode + LUT render + an RO-locator NaN fix that had mislocated 617
Colorless cats). Decode re-confirmed against additional in-game ground truth (Ferb, Tiny Tina)
alongside Stian.

**Deferred to Phase 2 (render fidelity + stats tail — NOT claimed done):**

- **Fur PATTERN overlay** (tabby/spots) — coat COLOR is done; the pattern overlay spike is in
  progress and deferred.
- **11 genuinely-maskless textured frames** (Flash held frames) — ~320 cats show a generic part
  for one slot; the exact silhouette needs a deep frame-sync rig change (documented).
- **"Scar"** — a separate injury/decal system, not part of the appearance model; unresolved.
- **Stats MP + level** — unlocated in the decompressed record → honest null; accepted-as-deferred
  by this close-out (see the ACCEPTED partial-DEC-02 note above). No fabrication.

This close-out is a product-scope decision the user made explicitly. Closing GO-on-decode
inherently accepts the 7-core-stats + HP scope with MP/level deferred. The render-fidelity items
above are carried forward under Phase 2 (AST-02) — see `.planning/ROADMAP.md`.

---

## SUPERSEDED — historical NO-GO records (OVERTURNED by the LZ4 discovery)

> ⚠ **The two NO-GO records below are OVERTURNED.** Both were artifacts of decoding
> the compact blob **without first LZ4-decompressing it** (root cause above). They
> are retained verbatim as the honest investigation trail, NOT as current status.
> Current status is **GO on the decode** (above).

### Original NO-GO framing (01-03, pre-LZ4)

- **Date:** 2026-07-14
- **Phase:** 01-decode-spike-go-no-go-gate, plan 01-03 (requirement DEC-04 gate)
- **Verification mode:** ⚠ **machine-verified.** The operator delegated the Task-2
  checkpoint to autonomous execution. All evidence below was gathered by AUTOMATED
  means — orchestrator-driven Node decode of the real save plus live DOM inspection
  of the running page — **not** by a human comparing rendered cards to in-game
  portraits. No human has eyeballed the game for this record. (A human spot-check
  remains cheap and worthwhile whenever convenient, but on the fallback branch the
  portrait is a deliberate neutral placeholder, so there is no true-look claim for
  a human to falsify.)

## The question this gate answers

Can KittenShare decode a cat's **appearance genes + stats** from the compact
`cats.data` blob well enough to render the cat's *true in-game look*?

- **GO** would mean Phases 2–3 build the full share loop on real portraits.
- **NO-GO** means consciously shipping name/class/gender/abilities + stats with
  appearance marked **"unverified"** — still a working share-a-kitten loop,
  without asserting the true portrait. Either outcome was a pre-agreed, legitimate
  spike result.

## Evidence

### 1. Located-layout status (01-01 decode spike)

Per `docs/kittenshare-format-notes.md` "## Located layout" and
`.planning/phases/01-decode-spike-go-no-go-gate/01-01-SUMMARY.md`:

- **Appearance genes: UNRESOLVED for build 5090.** Frame indices are bit-packed in
  the variable-length tagged `cats.data` stream. Full-corpus scan (1,308 cats):
  median 2 in-range aligned u32/cat vs the ~18 a plain gene block needs. No
  controlled single-gene saves were available to diff.
- The prior spike's "7-value u32 gene block @456" was **debunked** as a misaligned
  read — the correctly-aligned u32 @457 are the seven core stats.
- **Stats: LOCATED** — 7 plain u32 LE (STR/DEX/CON/INT/SPD/CHA/LCK) in the
  self-describing `files.save_file_cat` record only. Per-cat stats in the compact
  blob remain bit-packed → `null`.

### 2. Golden-save regression harness (Task 1, DEC-04)

`node --test tools/golden-save-test.js` — **8/8 tests pass, exit 0**:

- golden name/stats/genes assertions per `tools/fixtures/expected.json` for all
  three committed fixtures (garik, churrito, save_file_cat) — a shifted offset
  fails loud (verified: a deliberately shifted expected value made the harness
  exit non-zero, then was restored);
- build-gate synthetic (u32@4 → 9999): `buildOk=false`,
  `appearanceVerified=false`, name/class still decode, no throw;
- malformed/DoS blobs (empty / 3-byte / truncated) return gracefully within a
  wall-clock bound;
- range/drift invariant: `appearanceVerified` can never be true while genes are
  unresolved, even on hand-corrupted bytes;
- parity (DEC-05): the harness `require()`s the **same**
  `public/kittenshare/save-decode.js` file the page `<script src>`-loads
  (realpath-identical) — page and tools cannot drift.

### 3. Verification against the real save (Task 2 — automated)

Node decode of the real live save (`steamcampaign02.sav`, 1,155,072 bytes,
copied read-only):

- **1,308/1,308** cats decode with plausible printable names, zero throws;
- **0/1,308** cats have fabricated genes (`genes=null` everywhere,
  `genesResolved=false`);
- `buildOk=true` for **1,297/1,308** — see "Known edge" below;
- live `files.save_file_cat` decodes to name=Lucina, stats
  {str:4, dex:4, con:6, int:7, spd:4, cha:5, lck:5}, genes null — matches
  `expected.json` exactly.

Browser DOM inspection of `http://localhost:3000/kittenshare` with the real save
loaded through the page's own `openSave()` path:

- 120 cards rendered (page cap), all data fields present (e.g.
  "Garik | Colorless · male | InfiltrateBlockSpit", "Evelyn | Hunter · male",
  "Reinaldo | Mage · male") — **12/12 sampled fields matched** the Node-decoded
  values field-for-field; no systematic mismatch found;
- portraits: exactly **1 distinct SVG portrait signature** across all 120 cards —
  a single neutral placeholder; **no confidently-wrong per-cat portraits**;
- "⚠ appearance unverified" label present on **120/120** cards;
- no console errors.

## What decodes reliably vs. not (build 5090)

**Updated 2026-07-14 (01-05/01-06):** the compact-stats and appearance rows are now
**✅ resolved** — the blob is LZ4-compressed and decodes cleanly once decompressed.

| Field | Status |
|-------|--------|
| Name (compact varint incl. two-byte; self-describing u64-len) | ✅ reliable (1,316/1,316) |
| Class / gender / abilities (ascii vocab match) | ✅ reliable |
| Stats — 7 core, compact per-cat `cats.data` blob (post-LZ4) | ✅ **resolved** — 100% of corpus; Stian in-game match |
| Stats — HP (compact blob) | ✅ resolved where plausible (Stian HP 32 matched); MP/level unlocated → `null` |
| Appearance genes — 14-slot part table + coatId (post-LZ4) | ✅ **resolved** — 99.0% w/ L/R symmetry; genes decode correctly |
| Portrait render matches in-game pixel-for-pixel | ⏭ **deferred to Phase 2 (AST-02)** — body/leg/tail rig in unextracted `catanis.swf`; Phase-1 card is a labeled approximation |
| Build gate (`u32@4 ∈ {5090}`) | ✅ enforced; degrades honestly on unknown builds |

> The rows below (in the SUPERSEDED section) describe the pre-LZ4 state where these
> were `❌ UNRESOLVED → null`. That state is OVERTURNED — see "## Decision: GO".

## Fallback scope adopted (NO-GO)

KittenShare Phases 2–3 proceed on this explicitly adopted **fallback** scope:

1. **Decode + display:** name, class, gender, abilities (from the compact blob)
   and stats (where a self-describing record is present).
2. **Appearance:** rendered as a **neutral placeholder** (frame 1000, palette 17)
   with a visible **"⚠ appearance unverified"** label. `genes` is always `null`;
   the decoder never fabricates a gene set (`GENES_RESOLVED=false` module
   constant; `appearanceVerified` requires buildOk AND genesResolved AND range
   checks).
3. **Share loop:** the `#k=` share payload shape is frozen ({n,c,g,a,f,p});
   f/p carry neutral placeholder values while genes are unresolved.

This is a real, honest share-a-kitten loop — it simply does not claim the true
portrait.

## STATS — compact blob UNRESOLVED (fallback adopted)

**Date:** 2026-07-14 · **Plan:** 01-04 (gap closure for DEC-02) · **Verdict: NO-GO**

`01-VERIFICATION.md` flagged one gap: per-cat **stats never decode or display for
real cats**. `decodeCat`'s stat path only fires for the self-describing
`save_file_cat` record (u32@0==19), but the page's `openSave()` only ever reads
the compact `cats` table — so 0/1,308 real cats produced a non-null `stats` object
and `statsBlock()` was dead code on every card.

Plan 01-04 **attempted** the compact stats decode behind an objective statistical
gate (`tools/decode-compact-stats.js`) — voice→pitch→stats anchor + the proven
S2.1 tag value rule — and it **failed the gate**:

- **Cross-format ordering sanity (gate 1): PASS.** The voice→pitch→stats ordering
  logic recovers Lucina's known stats `4,4,6,7,4,5,5` from the self-describing
  record — so the *ordering* model is correct.
- **Live-corpus census (gate 2): FAIL — the decisive metric.** Of the 1,297
  build-5090 cats in the live save, **0 (0.0%)** yield a clean run of 7 tag ints
  in `[1,20]` after the voice+pitch anchor. Per-stat median/stddev are undefined
  (no clean decodes), far outside the GO band (median ∈ [3,9], stddev > 0.5).
- **Backup-invariance oracle (gate 3): vacuous.** With ~0 cats decoding, region
  invariance / change plausibility are trivially satisfied and prove nothing.

**Root cause (same wall as appearance, FINDINGS.md S2.2).** The compact STATS
window is dominated by variable/optional subfields and frame-range values (the
appearance part-records overrun / interleave); there is **no clean fixed 7-field
shape** to walk deterministically. Compounding it: **there is no ground truth** —
the only cat with decodable stats (Lucina, the poster `save_file_cat`) is absent
from every save's `cats` table, and a stat change **re-serializes the blob at a
different length**, so byte-offset diffing across the 17 backups cannot isolate a
stat field either. `node tools/decode-compact-stats.js` prints the full census +
oracle + a per-cat characterization dump and ends with `VERDICT: NO-GO`.

**Honest note:** **HP/MP/level remain UNRESOLVED in BOTH formats** — the decoder
returns them `null` and this plan does not change that.

**Fallback extended to stats.** Exactly as appearance genes were handled, compact
per-cat stats stay `null`, KittenShare **never fabricates** a stat value, and every
real card now shows a visible **"⚠ stats unverified"** label (mirroring the
appearance-unverified label). The self-describing `save_file_cat` record still
decodes and renders real stats when present.

**What would reopen a stats GO.** The same path FINDINGS.md S2.5 recommends for
appearance: (1) a controlled single-stat save-diff (change one stat in-game, save,
diff the two blobs to isolate the field's exact byte layout), or (2) reversing the
`Mewgenics.exe` cat (de)serializer to read its tag→field schema — then **validate
the decode through the 17-backup invariance oracle** (`decode-compact-stats.js`
gate 3, ported from scratchpad `genes-spike/invariance-full.js`) before trusting
any value. Do NOT ship stat values without both the oracle AND a human in-game
value check.

## Known edge: 11 cats fail the build gate

11 of 1,308 cats in the live save decode with `buildOk=false` (their blob's
u32@4 is not 5090 — most likely serialized under an older game build and never
re-serialized). They still decode name/class honestly and render as unverified.
Not a blocker; if the count grows or names degrade, add the older build(s) to
`KNOWN_BUILDS` after fixture verification.

## What would reopen the GO branch

An asset-extraction/rendering spike against `resources.gpak` starts immediately
after this phase closes and may later supply the gene layout. The GO branch
(guarded, intentionally empty in `save-decode.js`) reopens when **both**:

1. **A proven gene layout** — e.g. controlled single-gene diff saves, a reversed
   `Mewgenics.exe` cat serializer, or serializer knowledge from the gpak spike —
   with fixture cats whose decoded frame/palette values are asserted in the
   golden harness (extend `tools/golden-save-test.js` with exact gene
   assertions + an out-of-range mutation test); **and**
2. **A true-portrait render verified against the game** — sampled cats' rendered
   cards match their in-game portraits (this check SHOULD be human-eyeballed,
   unlike this record), with no default-range (1000–1049) clustering red flag.

Then flip `GENES_RESOLVED` to `true`, implement the guarded GO branch, and
record the reversal in an updated decision record.

## Cross-references

- `mewgenics-wiki/tools/golden-save-test.js` — the DEC-04 regression harness
- `mewgenics-wiki/docs/kittenshare-format-notes.md` "## Located layout" — the
  spike's layout evidence and debunk
- `.planning/phases/01-decode-spike-go-no-go-gate/01-01-SUMMARY.md` — spike outcome
- `.planning/phases/01-decode-spike-go-no-go-gate/01-02-SUMMARY.md` — shared
  decoder + honest fallback UI
