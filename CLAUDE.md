# Mewgenics Wiki Tools

Local reference tools for the game **Mewgenics** by Edmund McMillen / Team Meat.

## Commands

- `npm run dev` — start local dev server at http://localhost:3000
- `npm start` — same as dev

No build step required — all files are plain HTML/CSS/JS.

## Project Structure

```
mewgenics-wiki/
├── public/                  # All served files (open index.html in browser)
│   ├── index.html           # Landing page linking to all tools
│   ├── abilities.html       # Abilities by class/collar — main tool
│   ├── items.html           # Items by slot/rarity/set — filters + table/card views
│   ├── elements.html        # Element interactions — reactions + statuses (static visual)
│   ├── kittenshare.html     # KittenShare — open a .sav, kitten cards, share links
│   │                        #   assets: public/kittenshare/ (parts.js, palettes.js,
│   │                        #   ability-ids.js) + public/vendor/sql-wasm.{js,wasm}
│   │                        #   format research: docs/kittenshare-format-notes.md
│   └── mutations.html       # Mutations & birth defects by body slot
├── data/                    # Extracted data files (source of truth)
│   ├── icons.js             # ICONS{} — ability icon URLs by name (955 entries)
│   │                        #   Format: "Ability Name" -> "https://mewgenics.wiki/images/AbilityIcon/N.webp"
│   ├── tokens.js            # TOKEN_IMGS{} — inline [img:token] URLs (~60 entries)
│   │                        #   Format: "tokenname" -> "https://mewgenics.wiki/images/StatusIcon/X.webp"
│   ├── abilities-fallback.js # FALLBACK_ABILITIES[] — static ability data for offline use
│   │                        #   Format: [name, class, type, mana, category, description]
│   └── categories.js        # ABILITY_CATEGORY{} / *_BYNAME{} — best-guess spell category
│                            #   per ability, derived from game files (see Spell Categories)
├── public/icons/            # Locally downloaded icon webps (offline): {Ability,Passive}Icon
│                            #   (abilities) + {Head,Face,Neck}ItemIcon, Weapon/TrinketIcon (items)
├── tools/
│   └── derive-categories.js # Regenerates data/categories.js + abilities.html category map
│                            #   from the game's resources.gpak
├── package.json
└── CLAUDE.md
```

## Data Sources

- **Live API**: `https://mewgenics.wiki/api/v1/abilities.json`
  - abilities.html fetches this on load; falls back to FALLBACK_ABILITIES if unavailable
  - API record shape: `{ id, class, type, template, cost: {mana}, category, description, ... }`
  - `template: "passive"` = passive ability; anything else = active
  - `cost.mana` = mana cost (nested object)
  - Descriptions use `[img:tokenname]` inline tokens for status effect icons

- **Items API**: `https://mewgenics.wiki/api/v1/items.json` (1093 items)
  - items.html fetches this on load (no static fallback; shows an error if unreachable)
  - Record shape: `{ id, kind, rarity, is_consumable, cursed, stats:{shield,con,…},
    sets:[], description, icon_url, name, … }`
  - `kind` = slot (head/face/neck/weapon/trinket/modifier); `rarity` = common/uncommon/
    rare/very_rare/quest/sidequest (API has a `uncommmon` typo → normalized to uncommon)
  - `stats` keys reuse the ability stat tokens (shield/str/dex/…); descriptions use the
    same `[img:token]` markup. Icons under `images/{Head,Face,Neck}ItemIcon`, `WeaponIcon`,
    `TrinketIcon` — all downloaded locally to `public/icons/` (offline; via `localImg()`)

- **Mutations**: Hardcoded in mutations.html (no live API needed)
  - Shape: `[name, slot, effect, type]` where type is "mutation" or "defect"

## Spell Categories

In-game, every ability/spell belongs to one of four categories (the tabs of the
spellbook UI):

| Category | Meaning |
|----------|---------|
| **Offense** | Damage-dealing abilities — attacks and offensive spells |
| **Defense** | Protective abilities — shields, buffs, heals, damage mitigation |
| **Other**   | Utility — movement, summons/spawns, repositioning, misc effects |
| **Special** | Unique / signature abilities that don't fit the above |

The public `abilities.json` API does **not** expose this categorization (`category`
is `null` for all records), so we **derive a best-guess from the game's packed data**:
- `tools/derive-categories.js` reads `resources.gpak → data/abilities/*.gon` and infers
  each ability's category from its `template`, `damage`, and status `effects` (the game
  has no explicit category field). It writes `data/categories.js` and refreshes the inline
  map in `abilities.html` (between the `@@CATEGORY_MAP_BEGIN/END` markers).
- Coverage: 829/829 wiki abilities. Distribution: Offense 383, Defense 233, Other 119,
  Special 94. These are heuristics — individual guesses can be wrong (e.g. a damage-dealing
  "defensive" ability is tagged Offense). The Category column tooltip notes it's a best-guess.
- `abilities.html` shows the category (symbol + label) in the **Category** column and a
  category **filter** bar. Lookup is by API `id`, falling back to normalized ability name
  (so the offline FALLBACK data resolves too).
- To refresh after a game update: `node tools/derive-categories.js` (needs a local
  Mewgenics install; override path with `GPAK=<path to resources.gpak>`).

## Key Implementation Notes

### abilities.html
- Loads live data from mewgenics.wiki API on page open
- Falls back to static `FALLBACK_ABILITIES` data if API fails
- `renderDesc(raw)` splits on `[token]` / `[img:token]` brackets and renders each
  status/keyword token as an inline **SVG icon** (`TOKEN_SVG` → `.status-icon`),
  falling back to a styled text badge (`.status-badge`) for recognized tokens that
  have no glyph. The 10 tokens that actually occur in descriptions all have glyphs:
  `str dex con int spd cha lck shield divineshield champion`
- Icons are hand-drawn inline SVGs (the wiki has no status-icon images and the game's
  real icons are locked inside `swfs/ability_icons.swf` Flash assets — see Known Issues)
- `TOKEN_IMGS` is now only the *set of recognized token keys*; its URLs are unused.
  `STAT_LABELS` maps stat tokens (str/dex/…) to uppercase labels (tooltip/badge text)
- `ICONS` lookup maps ability names to their wiki icon URLs
- Column icons are downloaded locally to `public/icons/{Ability,Passive}Icon/N.webp`.
  `localImg(url)` rewrites any `https://mewgenics.wiki/images/...` URL (from the live
  API `icon_url` or the `ICONS` map) to the local `icons/...` path, so the icon column
  works fully offline
- Category column: `abilityCategory(r)` resolves the best-guess category, `catHtml()`
  renders the symbol+label badge (`CATEGORY_SVG`, `.cat-*` classes). The inline maps
  (`ABILITY_CATEGORY` / `_BYNAME`) live between the `@@CATEGORY_MAP_BEGIN/END` markers
  and are auto-generated — edit `tools/derive-categories.js`, not the map by hand. The
  existing category-filter UI auto-populates from the now-non-empty `r.category` values
- Two view modes via `viewMode` ('table' | 'cards'), toggled by `setView()` and the
  Table/Cards buttons. `renderTable()` is the dispatcher → `renderTableView()` or
  `renderCards()`; both share `getSorted()`, `iconHtml()`, `manaText()`. Card view is a
  responsive grid (`.cards`, auto-fill minmax 300px) of `.ab-card`s laid out as
  `[name]` / `[icon] [description] [MP]`. Each card's left edge is colored by **class**
  (`.clsbd-<cls>`) and the **category symbol** sits in the top-right corner
  (`.ab-card-cat`). Search/class/type/category/element filters and sort apply to both views
- Class colors: a single `--cls` custom property per class (`.c-<cls>,.clsbd-<cls>{--cls:…}`)
  drives BOTH the table badge (tinted via `color-mix`) and the card left edge (solid).
  Colors are **pulled from the game's per-class cat palette** (`textures/palette.png` inside
  `resources.gpak`): each class block in `data/classes/*.gon` has a `graphics{palette N}`
  index → row N of the 16×256 palette image; we take the mid-tone fur shade (cols 1–6) as
  the class color (e.g. druid row 65 → `#4d362d` brown). Authentic, so some are muted
  (medic≈white, necro≈black) and Jester/Tinkerer share a mint palette in-game. Edit the
  palette block in the `<style>` head; values were extracted manually (not at runtime).
- Search (`#srch`) matches ability **name and description** (also class/category) — case-insensitive
- Element filter (`activeElement`, `#elemBtns`): Physical · Magical · Fire · Ice · Electric ·
  Holy · Water · Wind · Gravity · Earth · Grass · Poison · Explosion.
  `computeElemTags(elements, dmgType, type)` derives an ability's tags from the API
  `elements` array via `ELEMENT_ALIASES` (Napalm→Fire, Conducted→Electric, Rock→Earth,
  Bloom→Grass) plus `damage.type`/`type` (Physical←damage.type physical/combo;
  Magical←type magic or damage.type magic/combo/contextualspell). Stored as `r.elemTags`
  at load. Offline fallback uses `fallbackElemTags()` (keyword/raw-category heuristic).
  An ability can carry several tags (e.g. Fire Punch = Physical + Fire). The niche
  `Break_Web` element has no button. Most abilities (buffs/utility) carry no element tag.
- Class names from API are capitalised (e.g. `"Psychic"`) — `normalizeClass()` lowercases them
- Icon column uses `AbilityIcon/N.webp` for actives, `PassiveIcon/N.webp` for passives

### items.html
- Standalone page (self-contained; reuses the abilities page's look + `TOKEN_SVG`/
  `renderDesc` for stat glyphs and `[img:token]` descriptions). Loads `items.json` live.
- Filters: **Slot** (head/face/neck/weapon/trinket), **Rarity** (common→sidequest),
  plus **Cursed** and **Consumable** toggle buttons. Search matches name/description/
  set/slot/rarity. Sortable columns (name/slot/rarity/set); CSV export.
- Two views (`viewMode`): table and card grid. Card left edge colored by **rarity**
  (`.rbd-<rarity>` → `--rar`), cursed/consumable shown as a corner emoji.
- `render()` is the dispatcher → `renderTableView()`/`renderCards()`; `localImg()`
  rewrites icon URLs to the local copies.

### elements.html
- Fully static — no API. Visual reference for how elements interact.
- Three sections (data-driven JS arrays): element legend (`ELEMENTS`), reaction
  "equation" cards (`REACTIONS`: A + B → result), and elemental statuses (`STATUSES`).
- Interactions are sourced from the game text in `resources.gpak`: **Butch's in-game
  element tips** + keyword tooltips (`data/text/combined.csv`, `data/keyword_tooltips.gon`)
  + tile palette (`data/tiles.gon`). Only documented combos are shown — the game itself
  says "experimentation is key", so Holy/Gravity/Wind/Earth/Explosion pairings are omitted.
- Element colors match the abilities-page element filter.

### mutations.html
- Fully static — no API calls
- `[name, slot, effect, type]` array, 379 entries across 9 slots
- Slot filter, search, active/passive type filter, sortable columns, CSV export

## To Add Game Files from Local Disk

The game is installed at `Z:\SteamLibrary\steamapps\common\Mewgenics\`.
Note: all game assets are packed into a single ~5 GB `resources.gpak` archive
(only `Mewgenics.exe`, `resources.gpak`, `steam_api64.dll` are loose) — there are
no extractable loose icon/data files without first unpacking that archive.

**`.gpak` format** (reverse-engineered; see `tools/derive-categories.js` `openGpak`):
`[u32 entryCount]`, then per entry `[u16 nameLen][name bytes][u32 fileSize]`, then the
raw file-data blob with all files concatenated in TOC order. A file's offset = end of
TOC + running sum of preceding `fileSize`s. `.gon` files are plain text (Glaiel Object
Notation, brace-nested); textures are PNGs; sprites/icons are `.swf` (Flash vector art).

If you do unpack game data, place files in `data/game/` and update abilities.html
to read from them instead of the live API. Game data likely contains:
- Ability definitions with canonical descriptions and icon IDs
- Status effect sprite sheets
- Mutation data

## Known Issues / TODO

- ~~Status effect token images may 404~~ **Resolved.** The wiki has NO image files for
  status tokens — it renders `[img:shield]` etc. as styled text badges. The old
  `StatusIcon/*.webp` URLs were inferred guesses and all 404'd. We now render these as
  inline text badges to match. (Real sprite images exist only inside the game's packed
  `resources.gpak`, which is not extracted.)
- Colorless class abilities not fully populated in fallback data
- Some ability icon IDs may be wrong — sourced from class page scraping, not game files
- Mana column shows `0` for free abilities instead of `—` (fix: treat 0 as free)
