# Vulos Office — Screenshots

This document describes the screenshot gallery, how screenshots are captured, and the seed data used to produce populated views.

---

## Prerequisites

```bash
# Install npm dependencies (including Playwright)
npm install

# Install Playwright's Chromium browser
npx playwright install chromium

# Build the frontend (the screenshotter uses the compiled binary + dist/)
npm run build:frontend
```

---

## Capturing screenshots

```bash
npm run screenshots
```

The screenshotter is self-contained — it:
1. Writes demo data files to `/tmp/vulos-demo-data/` (never touches `./data`)
2. Builds the Go binary (which embeds the frontend via `//go:embed`)
3. Starts the binary on port 8083 pointed at the demo data dir
4. Captures all surfaces at 1440×900 (dark mode)
5. Stops the server

To capture against a deployed instance:

```bash
BASE_URL=https://office.example.com npm run screenshots
```

---

## Seed data

Demo data is committed in `scripts/seed-demo.mjs` and never touches `./data` — it uses a temporary directory at `/tmp/vulos-demo-data`.

| Surface | Seed content |
|---------|-------------|
| **Docs** | "Q2 2026 Product Update" — headings, prose, bullet lists, table; "ADR-014: Sync Layer" — decision record |
| **Sheets** | "Revenue Tracker H1 2026" — 6 months × 5 columns, SUM + margin formulas, 2 sheets |
| **Slides** | "Vulos Office Product Overview" — 5 slides, Reveal.js obsidian theme |

---

## Route list

| File | Route | Surface | Populated? |
|------|-------|---------|------------|
| `hero.png` | `/` | Home / file list | Yes — shows seeded docs/sheets/slides |
| `home.png` | `/` | Home | Yes — shows seeded docs/sheets/slides |
| `docs-editor.png` | `/docs/demo` | Documents editor | Yes — Q2 Product Update with prose + table |
| `sheets-editor.png` | `/sheets/demo-sheet` | Spreadsheets editor | Yes — Revenue Tracker with formulas |
| `slides-editor.png` | `/slides/demo-slides` | Presentations editor | Yes — 5-slide product overview |
| `pdf-editor.png` | `/pdf/demo` | PDF viewer/annotator | Partial — UI shell (no PDF pre-loaded) |

---

## Gallery

### Home

![Home](screenshots/home.png)

The Vulos Office home screen showing the seeded file list (doc, sheet, slides), recent files, and navigation sidebar.

### Docs Editor

![Docs Editor](screenshots/docs-editor.png)

The Documents editor (TipTap) open on "Q2 2026 Product Update" — headings, a metrics table, and bullet lists.

### Sheets Editor

![Sheets Editor](screenshots/sheets-editor.png)

The Spreadsheets editor (Fortune Sheet) with the "Revenue Tracker H1 2026" — 6 months of revenue, expenses, profit (SUM formula), and margin % columns.

### Slides Editor

![Slides Editor](screenshots/slides-editor.png)

The Presentations editor (Reveal.js) open on the 5-slide "Vulos Office Product Overview" deck with the obsidian dark theme.

### PDF Editor

![PDF Editor](screenshots/pdf-editor.png)

The PDF viewer with annotation and signing tools. (A PDF file must be opened or uploaded to show content — the seed data does not include a pre-loaded PDF.)

> **Calendar and Contacts** moved to the mail connector — their screenshots
> and seed data now live with lilmail, not here.
