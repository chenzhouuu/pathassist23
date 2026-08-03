# 04 — Split the landing page stylesheet by region

**What to build:** the landing page's single 344-line stylesheet becomes one file per region, so
that the four tickets which follow can each own their styles instead of three of them editing the
same file at the same time.

This exists because the work is being run by several agents at once. 06 restyles the table, 07 adds
a tree, 09 adds a grid; under one stylesheet those are three concurrent edits to one file with no
logical relationship to each other. Splitting first turns a guaranteed conflict into none.

Purely mechanical. Every rule moves; none is rewritten.

**Blocked by:** None — can start immediately. Runs in parallel with 01 and 03; the three touch
disjoint files.

**Status:** ready-for-agent

- [ ] The landing page stylesheet becomes an index that imports one partial per region: shell and
      top bar, toolbar and breadcrumb, table, preview pane — plus empty reserved partials for the
      tree (07) and the grid (09), so those tickets add a file's contents rather than a file.
- [ ] The move is mechanical: no selector, property or value is changed. Rule order within a
      partial is preserved, and the import order reproduces the original cascade.
- [ ] The landing page is pixel-identical before and after, in the palette it has today.
- [ ] `npm run build` succeeds and the emitted CSS contains the same rules.

## Notes

The nine shadcn tokens the page reads — `--background`, `--foreground`, `--border`, `--card`,
`--accent`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--ring` — are not touched
here. They stay exactly as they are; 05 is what redefines them in a scope.
