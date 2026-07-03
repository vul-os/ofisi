# Frontend testing — Vulos Office

Two complementary layers cover the React app. Both are hermetic (no Go backend,
no relay): the API surface is mocked.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 1 — Vitest (jsdom)            npm test                         │
│   • unit tests (helpers, CRDT, exporters, pure logic)               │
│   • RTL + MSW integration: real component trees (real TipTap editor, │
│     real HistoryPanel/CommentsPanel/SuggestionPanel, real api client)│
│     with /api served by Mock Service Worker (msw/node).             │
│   • runs everywhere, fast, no browser.                              │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2 — Playwright (chromium)     npm run test:e2e                 │
│   • real browser against a production `vite preview` build.         │
│   • the entire backend is mocked in-browser via page.route.         │
│   • covers the flows jsdom cannot: the @fortune-sheet canvas grid,  │
│     reveal.js rendering, real toolbar + menu interaction.           │
└─────────────────────────────────────────────────────────────────────┘
```

## Running

### Layer 1 — Vitest (runs now, no setup)

```bash
npm test                      # whole suite
npx vitest run src/__tests__/msw/           # just the MSW integration tests
npx vitest                    # watch mode
```

The MSW integration tests live in `src/__tests__/msw/`:

| File | Covers |
|------|--------|
| `versionHistory.integration.test.jsx` | snapshot list + restore; **wave-14** role gate (viewer/commenter refused, owner/editor allowed) |
| `comments.integration.test.jsx` | add / resolve / reopen / reply, tab filters |
| `suggestions.integration.test.jsx` | create / accept / reject, state PUT round-trip |
| `docsEditor.integration.test.jsx` | **real TipTap** — typing order (no "olleh"), **wave-19** font size/family, bold/heading/list/link, export menu (DOCX/PDF/MD) |
| `p2pShare.integration.test.jsx` | **wave-25** share modal, invite parse → room, ro rejection, E2E crypto seal, two-session convergence |
| `slidesEditor.integration.test.jsx` | **full SlidesEditor mount** — open, add slide, reorder, presenter toggle, presence pill |
| `sheetsEditor.integration.test.jsx` | cell-edit round-trip via SheetsFindReplace, presence pill derivation |

**How the mock works.** `src/__tests__/msw/handlers.js` is a small, *stateful*
in-memory backend (files, versions, comments, suggestions). `resetMock({ role })`
reseeds it per test; the `role` flips the server-side restore gate. Requests flow
through the *real* `src/lib/api.js` client → `fetch` → MSW. The CRDT stores
(`getCommentStore`, `getSuggestionStore`) are module singletons, so the tests
`evict*Store()` in `beforeEach` to avoid cross-test leakage.

### Layer 2 — Playwright (one-time browser install)

```bash
npx playwright install --with-deps chromium   # once
npm run test:e2e                              # builds vite, serves preview, runs
npm run test:e2e:ui                           # interactive UI mode
```

`pretest:e2e` runs `vite build` first; `playwright.config.js` then serves the
build with `vite preview` on port **47317** (an uncommon port, and
`reuseExistingServer: false`, so a stale preview of another Vulos app on a shared
port can never be tested by mistake). Service workers are blocked so a cached PWA
shell can't shadow the mocks.

**How the mock works.** `e2e/fixtures.js` installs a `page.route('**/api/**')`
handler mirroring the MSW backend (auth, files, versions with the wave-14 gate,
comments, suggestions). The `officePage` fixture attaches it automatically;
`installBackend(page, { role })` lets a test choose the role for the restore gate.

The E2E specs:

| File | Covers |
|------|--------|
| `docs.e2e.js` | open doc, typing order, bold, **wave-19 font size**, outline, find, word count, export menu |
| `collab.e2e.js` | version restore (owner ✓ / **wave-14** viewer ✗ 403), comments add + resolve |
| `p2p.e2e.js` | **wave-25** share modal generates rw+ro links; ro fragment survives navigation |
| `sheets-slides.e2e.js` | Sheets: open + cell type + presence; Slides: open + add slide + presenter + presence |

## Coverage boundaries (what's tested where, and why)

- **Sheets grid interaction** (click a cell, formula bar) is Playwright-only:
  `@fortune-sheet` needs a real `<canvas>` and hangs under jsdom. The cell/model
  logic is unit-tested in vitest.
- **P2P convergence / read-only *enforcement* / crypto seal** is proven headless
  with an injected in-process fabric (`src/lib/crdt/__tests__/p2pSession.test.js`
  and `p2pShare.integration.test.jsx`). The browser E2E covers the *sharer UI* and
  invite-link format; full ro enforcement in the browser would need a live relay.
