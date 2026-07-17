# KittenShare Share-Link Spec (permanent, versioned)

> **Status: FROZEN — v1.** This document is the SHR-01 / SHR-02 written spec and MUST
> exist *before any public `#k=` link is minted*. Once a public link exists, the URL
> scheme and the v1 payload shape are **un-migratable** (see §2). Treat "publish this
> spec" as a hard gate that precedes any Phase-3 deploy.
>
> This is the contract that `encodeShare` / `decodeShare` in
> `public/kittenshare/save-decode.js` (plan 02-02) implement against. A reader should be
> able to implement both functions from §4–§8 without opening any other file.

Compression dependency: **lz-string 1.5.0**, vendored at
`public/vendor/lz-string.min.js` (no runtime CDN, no build step).
Pinned integrity (sha256 of the upstream jsDelivr file
`lz-string@1.5.0/libs/lz-string.min.js`):

```
95f4d1cbf099f57161b664bc048426ec3df92637801a4c79116e83315aa787e7
```

Used API: `LZString.compressToEncodedURIComponent` /
`LZString.decompressFromEncodedURIComponent` — these emit/consume an already
URI-safe alphabet, so no extra `encodeURIComponent` or `btoa`+char-swap step is needed.

---

## 1. Version history

The payload is a compact JSON object whose **first field is an integer `v`** (the
schema version). Parsers read `v` first and dispatch on it.

| Version | Status  | Date       | Change |
|---------|---------|------------|--------|
| v1      | current | 2026-07-15 | Initial frozen schema: `v n c g a s k p cp xp`. Carries the full 14-slot appearance (as 11 unique frames), 7 core stats + HP, pattern + coat + class palette. Shared cards render VERIFIED. |

**Evolution rules (permanent):**

1. **Append-only.** New fields are *added*; existing keys are **never renamed,
   renumbered, or repurposed.** A field's meaning is frozen the moment a public link
   carries it.
2. **Old parsers are kept indefinitely.** When `v2` ships, the `v1` decode branch stays
   so every historical `v1` link still renders. Removing an old parser breaks minted
   links — it is forbidden.
3. **Additive fields are optional on read.** A `v1` decoder ignores unknown keys; a `v2`
   decoder treats new keys as optional (absent = the v1 default) so a `v2` reader can
   still read a `v1` blob.
4. **A structural/meaning change bumps `v`.** Anything that would change how an existing
   key is interpreted requires a new version number and a new parser branch, never an
   in-place edit of the v1 shape.

---

## 2. URL scheme — URL fragment `#k=<blob>` (FROZEN)

The share link is:

```
https://<host>/kittenshare.html#k=<lz-string-blob>
```

The payload lives entirely in the **URL fragment** (the part after `#`).

**Rationale (this is the load-bearing decision):** a URL fragment is a client-only
component — browsers **never transmit it to the origin server** and it never appears in
server access logs or CDN edge logs. The share payload is *derived from the user's save
file*, so keeping it in the fragment honors the project's core value — **"your save
never leaves your device" (SIT-03)** — exactly the way the `.sav` itself is parsed
locally and never uploaded. A query string (`?k=`) would ship the (save-derived) cat
data to the server on every request, directly violating that promise, so **`?k=` is
rejected for the primary link.**

**Un-migratable warning:** the moment a public `#k=` link is shared, the scheme and the
v1 payload shape are **frozen forever**. Switching `#` → `?` later — or reshaping v1 —
breaks *every* previously minted link. This is why the spec must precede the first
public link. There is no server-side redirect that can fix a fragment change, because
the server never sees the fragment.

---

## 3. OG / social-preview strategy

Because the fragment is unreadable server-side, a crawler fetching a share URL sees only
the static page — it cannot render the specific cat. The strategy:

- **Ship one static, generic, branded OG image**, referenced by
  `<meta property="og:image">` in `kittenshare.html`. Every shared link previews as the
  same branded KittenShare card. This is honest: the recipient's *real* cat renders on
  load from the fragment, client-side.
- **Deferred escape hatch (v2, opt-in — do NOT build now):** if per-kitten rich previews
  are ever wanted, add a separate *opt-in* "make a rich preview link" action that mints a
  `?`-based link routed through an edge function which reads the query string and renders
  a per-cat OG image. This is **additive** — it does not migrate or replace the primary
  fragment links, and it is a deliberate, per-link opt-out of the privacy default.

---

## 4. Payload field table (v1)

The decoded object is built from `decodeCat()` output (see
`public/kittenshare/save-decode.js`). Short keys keep the JSON compact; lz-string
compresses the redundancy in the string fields.

| Key  | Type            | Range / shape                              | Meaning |
|------|-----------------|--------------------------------------------|---------|
| `v`  | int             | `1`                                        | Schema version. **Read first.** |
| `n`  | string          | ≤ 20 chars, ASCII 32–126                    | Cat name (the decoder only accepts printable ASCII; truncate to 20). |
| `c`  | string          | one of 14 class names                      | Class name **string** (Fighter, Mage, Hunter, Druid, Tank, Medic, Monk, Thief, Jester, Psychic, Necromancer, Tinkerer, Butcher, Colorless). |
| `g`  | string          | `"male"` / `"female"`                       | Gender. |
| `a`  | string[]        | ≤ 6 ability **id strings**                  | Ability **id strings**, never indices — see note below. |
| `s`  | int[8] or null  | `[str,dex,con,int,spd,cha,lck,hp]`          | 7 core stats (each 1–10) + HP. **`hp = -1` is the null sentinel** (unknown HP). `mp` and `level` are **NOT carried** — reserved for a future locate; a decoder sets them to `null`. |
| `k`  | int[11]         | frame indices `0 … 5000`                    | The **11 UNIQUE slot frames** in the fixed order in §6. Eye/Ear/Brow are L/R-symmetric so only one of each pair is stored; the 4 legs are distinct. |
| `p`  | int             | pattern id (`0 … ~706`)                     | Fur PATTERN (CatTexture frame index). |
| `cp` | int             | coat palette row (`1 … 49`)                 | Coat COLOR (direct row index into `textures/palette.png`). |
| `xp` | int             | class palette row (`50 … 68`) or `-1`       | Class accent palette row; `-1` = none. |

**Why ability *id strings*, not indices:** `public/kittenshare/ability-ids.js` is
auto-generated "longest-first" and can **reorder** whenever it is regenerated. Storing an
*index* into that list would silently corrupt every previously minted link the first time
the list reorders. An **ability id string** is stable regardless of list order, so it is
migration-safe; lz-string compresses the shared prefixes cheaply. (The byte budget is
~10× under the limit — see §7 — so density is not a reason to switch to indices.)

**Mutations are carried implicitly — no separate field.** A slot frame `≥ 300` (in `k`)
or a pattern `≥ 300` (in `p`) *is* a mutation (base part sets are `1 … 250`; mutations
start at 300 per `catgen.gon`). So the `k` + `p` values the payload already carries fully
encode the mutation set. The receiver re-derives the mutation list from those frames (via
the same `decodeMutations` path + `mutations-catalog.js` loaded eagerly on the receiver);
no dedicated mutation field is stored.

---

## 5. Encode / decode algorithm

### Encode (producer)

1. Read the `decodeCat()`-shaped object (`cat`).
2. Build the compact `payload` object with the keys in §4 (`v:1` first). Store the 11
   unique slot frames into `k` in the §6 order; abilities as id strings, sliced to 6;
   name sliced to 20; `s.hp` null → `-1`.
3. `blob = LZString.compressToEncodedURIComponent(JSON.stringify(payload))`.
4. `url = location.origin + location.pathname + '#k=' + blob`.
5. Apply the **producer length guard** (§7) before offering the URL to the user.

The lz-string output is already URI-safe (base64url-style alphabet), so the **legacy
`btoa` + manual `+/=` → `-_` char-swap is dropped** — do not re-add it.

### Decode (consumer)

1. On load (and on `hashchange`), read `location.hash`; match `#k=<blob>`.
2. Apply the **consumer length cap** (§7): reject a blob longer than 4000 chars *before*
   decompressing.
3. `json = LZString.decompressFromEncodedURIComponent(blob)`; if falsy → `null`.
4. `p = JSON.parse(json)`; if not an object → `null`.
5. **Read `p.v` first** (§8). If `p.v !== 1` → return the unsupported-version sentinel.
6. Reconstruct the full 14-slot shape from `k` (§6), coerce every field
   (`String()` / `Number()`), rebuild the `decodeCat`-shaped object with
   `appearanceVerified: true` (a shared link *is* the verified truth), and set
   `mp: null, level: null`.
7. Wrap the whole decode in `try/catch → null`. A `null` (or the sentinel) drives a
   friendly fallback card, never a thrown error or garbled output.

Reference implementation shape (v1):

```js
function decodeShare(blob){
  try {
    if (typeof blob !== 'string' || blob.length > 4000) return null;   // consumer cap (§7)
    const json = LZString.decompressFromEncodedURIComponent(blob);
    if (!json) return null;
    const p = JSON.parse(json);
    if (!p || typeof p !== 'object') return null;
    if (p.v !== 1) return { __unsupportedVersion: p.v || null };       // §8
    const k = Array.isArray(p.k) ? p.k : [];
    const slots = {                                                    // §6 L/R reconstruction
      Body:k[0], Head:k[1], Tail:k[2], RearLeg_L:k[3], RearLeg_R:k[4],
      FrontLeg_L:k[5], FrontLeg_R:k[6], Eye_L:k[7], Eye_R:k[7],
      Ear_L:k[8], Ear_R:k[8], Brow_L:k[9], Brow_R:k[9], Mouth:k[10]
    };
    const s = Array.isArray(p.s) ? p.s : null;
    return {
      name: String(p.n||''), cls: String(p.c||''), gender: String(p.g||''),
      abilities: Array.isArray(p.a) ? p.a.map(String) : [],
      stats: s ? { str:s[0],dex:s[1],con:s[2],int:s[3],spd:s[4],cha:s[5],lck:s[6],
                   hp: s[7]===-1?null:s[7], mp:null, level:null } : null,
      genes: { slots, pattern:p.p, coatPalette:p.cp, classPalette:p.xp,
               frame: slots.Body, palette: p.cp, mutations: [] },
      buildOk:true, genesResolved:true, appearanceVerified:true
    };
  } catch(e){ return null; }
}
```

---

## 6. L/R reconstruction rule

The decoder gate enforces symmetry (`Eye_L===Eye_R`, `Ear_L===Ear_R`,
`Brow_L===Brow_R`), so those pairs carry one value each; the 4 legs are distinct. The 11
unique frames are stored in `k` in this **fixed, frozen order**:

| `k` index | 0    | 1    | 2    | 3         | 4         | 5          | 6          | 7     | 8     | 9      | 10    |
|-----------|------|------|------|-----------|-----------|------------|------------|-------|-------|--------|-------|
| slot      | Body | Head | Tail | RearLeg_L | RearLeg_R | FrontLeg_L | FrontLeg_R | Eye_L | Ear_L | Brow_L | Mouth |

On decode, mirror the paired slots back to the full 14-slot shape:

```
Eye_R  = Eye_L  = k[7]
Ear_R  = Ear_L  = k[8]
Brow_R = Brow_L = k[9]
```

The 4 leg slots (`k[3..6]`) stay distinct. The full 14-slot order used elsewhere is:
`Body, Head, Tail, RearLeg_L, RearLeg_R, FrontLeg_L, FrontLeg_R, Eye_L, Eye_R,
Brow_L, Brow_R, Ear_L, Ear_R, Mouth` (SLOTS 1..14 in `save-decode.js`).

---

## 7. Length guard

The budget is ~2,000 URL chars. Real payloads land ~200 chars (§9), so the guard is a
**safety net, not a design constraint.**

- **Producer side (primary):** after building the URL, if `url.length > 1900` (margin
  under 2,000 for very long names / max-length abilities / edge browsers), **refuse to
  copy** and surface a friendly message. In practice this essentially never triggers
  given the headroom, but it satisfies SHR-02.
- **Consumer side (defensive):** in `decodeShare`, reject any fragment blob longer than
  **4000 chars before decompressing** — untrusted-input / decompression-bomb hygiene,
  the same discipline `decodeCat` applies to save bytes. Then wrap decode in
  `try/catch → null`.

Measured headroom: a real fixture cat compresses to ~150 blob chars / ~200 URL chars
(§9) versus the ~2,000 budget — roughly a 10× margin.

---

## 8. Version handling (forward/backward compatibility)

`decodeShare` reads `p.v` **first**:

- `p.v === 1` → run the v1 parser (§5).
- `p.v` unknown / newer / missing → return a graceful sentinel
  (`{ __unsupportedVersion: p.v || null }`). The caller renders a friendly card —
  *"This link was made with a newer version of KittenShare — update the page"* — plus the
  "Open your own save →" CTA. **Never** garbled output, never a thrown error.
- Old-version parsers are kept indefinitely (§1 rule 2), so a future `v2` build still
  renders every `v1` link.

The bad-link path (`null` from oversized / malformed / failed-decompress) renders a
different friendly card — *"This share link couldn't be read"* — also with the CTA. Both
fallbacks show the CTA (SHR-05: on *every* shared card).

---

## 9. Worked example (real, measured)

Produced by decoding `tools/fixtures/reinaldo.bin` with `decodeCat()` and running the §5
encode against the vendored lz-string 1.5.0 (round-trip verified). These are real
numbers, not a placeholder.

Decoded cat: **Reinaldo**, class **Mage**, male, `appearanceVerified: true`
(this fixture happens to have no abilities recorded, so `a` is empty — a cat with 6
max-length abilities encodes larger, still well under budget).

Compact payload JSON (140 chars):

```json
{"v":1,"n":"Reinaldo","c":"Mage","g":"male","a":[],"s":[5,6,6,7,4,4,3,-1],"k":[223,40,27,26,26,26,26,166,129,207,24],"p":71,"cp":48,"xp":55}
```

- `k = [223,40,27, 26,26,26,26, 166,129,207, 24]` → Body 223, Head 40, Tail 27, all four
  legs 26, Eye_L 166, Ear_L 129, Brow_L 207, Mouth 24. (Note frame 207 is `< 300`, so no
  mutation here; a value `≥ 300` would re-derive as a mutation on the receiver — §4.)
- `s = [5,6,6,7,4,4,3,-1]` → STR 5, DEX 6, CON 6, INT 7, SPD 4, CHA 4, LCK 3, HP unknown
  (`-1` sentinel).

lz-string `compressToEncodedURIComponent` blob (**154 chars**):

```
N4IgbiBcCMA0IDsogEoFMCWCCGAbAJgPYjwDGyAstgOZokjXIC2ed82UA2gLrwDOXAKywAbKNgB2WABYZsAMywAtNF4gA1lwBMWxdIAMsLVK1jTRs2OgirWgJxH9J6WoAOUCXBCl3kaQA54AA9fQUEAXyA
```

Full share URL (with a sample host `https://kittenshare.example`), **201 chars total**:

```
https://kittenshare.example/kittenshare.html#k=N4IgbiBcCMA0IDsogEoFMCWCCGAbAJgPYjwDGyAstgOZokjXIC2ed82UA2gLrwDOXAKywAbKNgB2WABYZsAMywAtNF4gA1lwBMWxdIAMsLVK1jTRs2OgirWgJxH9J6WoAOUCXBCl3kaQA54AA9fQUEAXyA
```

201 chars ≪ 1900 (producer guard) ≪ ~2000 (budget) — a ~10× margin. The blob round-trips
losslessly (`decompressFromEncodedURIComponent` → `JSON.parse` reproduces the payload).
