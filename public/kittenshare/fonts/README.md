# Card hand-font (drop-in)

The kitten card uses a hand-drawn font for the Mewgenics look. It is **self-hosted** and
loaded via `@font-face { font-family:'KittenHand' }` in `kittenshare.html`.

To enable it, drop a woff2 here named exactly:

    PatrickHand-Regular.woff2

Recommended font: **Patrick Hand** (SIL Open Font License, free) —
https://fonts.google.com/specimen/Patrick+Hand  (or any hand-drawn woff2; just match the filename,
or edit the `src:` path in the `@font-face` block).

Until the file is present, the card falls back to a system hand-font
(Comic Sans MS / Chalkboard / Comic Neue), so it still reads hand-drawn everywhere.
