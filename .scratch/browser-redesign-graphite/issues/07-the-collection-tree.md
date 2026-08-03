# 07 — The collection tree

**What to build:** a permanent left rail listing every collection, expandable to folder level, from
which any node can be opened. The breadcrumb and the tree stay in agreement in both directions:
walking down through the table moves and expands the tree, and clicking a tree node moves the
table.

Slides do not appear in the tree. It answers *where can I go*, and the table answers *what is
here*; putting slides in both makes the rail long and the question ambiguous.

**Blocked by:** 03 (navigation state), 05 (tokens).

**Status:** ready-for-agent

- [ ] The rail is 240px, lists collections, and expands to show folders and sub-folders. Expansion
      state is independent of where the table is pointing — collapsing the branch you are inside
      does not navigate you out of it.
- [ ] Clicking any node navigates the table to it. The current location is marked, and navigating
      via the table or the breadcrumb expands the tree to reveal it.
- [ ] A node's item count renders where Girder has computed one and renders as an em dash where it
      has not. Every folder in this instance currently reports no count; showing `0` would read as
      "this is empty, skip it", which is a different and false statement.
- [ ] Children are fetched when a branch is first expanded, not up front.
- [ ] The rail survives a shallow tree without looking broken. Most collections here hold a single
      folder; Penn Pathology holds forty empty case folders and is the one deep branch.
- [ ] Verified in both themes at 1440px and 1280px.

## Notes

The tree is a bet on the schema rather than on today's data — the hierarchy allows case folders
holding blocks holding slides, and today's contents are almost all one level. That was decided
with the shallowness known; it is not a surprise to design around.
