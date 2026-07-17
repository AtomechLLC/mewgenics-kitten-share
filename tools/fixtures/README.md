# Decode fixtures

These `.bin` files are **minimal, extracted single-cat blobs** from a real save,
used as golden-master inputs for the decode tooling and regression checks.

**Rule (privacy / IP — threat T-1-05):** only single-cat blobs may live here.
**Never** commit a whole `.sav` file or `resources.gpak` — those contain the full
private campaign (all cats, houses, progress) and copyrighted game data.

## Contents

| File | Format | Source | What it exercises |
|------|--------|--------|-------------------|
| `garik.bin` | compact `cats.data` blob | steamcampaign02.sav, cat key 1 | simple single-byte name varint (name @ offset 22) |
| `churrito.bin` | compact `cats.data` blob | steamcampaign02.sav, cat key 3 | two-byte name varint edge case (name @ offset 23) |
| `save_file_cat.bin` | self-describing `files.save_file_cat` | steamcampaign02.sav | field-order oracle (name + u32 gene block + ascii fields) |

Expected decoded values are in `expected.json`.

## Note on the "non-ASCII name" fixture

Plan 01-01 asked for one non-ASCII / non-Latin-name cat. A scan of all 24 save +
backup files in the local corpus found **no** cat with a non-ASCII name, so the
harder decode path is instead covered by `churrito.bin` (the two-byte-varint
case). The non-ASCII edge (Pitfall 3) is deferred until such a save exists.

## Regenerating

Fixtures are extracted from a local save with the vendored sql.js; they are
committed so the decode tools can be checked without a game install. To refresh,
re-extract the same cat keys from a build-5090 save.
