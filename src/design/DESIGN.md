# Vulos Office — Design System

This document describes the design language for **Vulos Office** and should be
treated as the source of truth when extending the UI to new surfaces (Sheets,
Slides, PDF Signing, Verify, and any sibling apps under the Vulos umbrella).

The system is **token-first**: every colour, font, spacing, radius, shadow,
and motion value lives in [`tokens.css`](./tokens.css) as a CSS custom property,
and is exposed to Tailwind through `tailwind.config.js`.  Do not introduce
new raw hex codes, pixel sizes, or shadow definitions in component code — add
or extend a token instead.

---

## 1. Direction

The suite is **dark-first** and aligned with the vulos-cloud landing surface: a
near-black, restrained, IDE / terminal aesthetic. No rainbow, no glow. Dark is
the DEFAULT canvas; a clean light theme is opt-in via the app toggle.

We are drawing from:

- **Linear** — information density without clutter; quiet active states; keyboard polish.
- **vulos-cloud / IDE chrome** — near-black surfaces, hairline 1px borders, one deliberate accent.
- **Tana / Bear** — document-first; the editing surface is the protagonist.
- **Vercel** — typographic discipline; uppercase mono eyebrows; tight tracking on chrome.

We are explicitly **avoiding**:

- shadcn defaults, Material Design, default Tailwind UI starters.
- Glassmorphism, neumorphism, heavy gradients, bloom / glow shadows.
- Slate-blue dark modes (`#0f172a`), generic react-icons sets, Bootstrap blue (`#3b82f6`).

---

## 2. Colour

The system is **near-black dark by default** (an IDE baseline), with an opt-in
light theme. All values live in [`tokens.css`](./tokens.css); the table below
is a summary — `tokens.css` is authoritative.

### 2.1 Palette

| Token           | Dark (default)          | Light (opt-in)         | Purpose                                       |
| --------------- | ----------------------- | ---------------------- | --------------------------------------------- |
| `bg`            | `#0c0c0c`               | `#ffffff`              | Base app canvas                               |
| `bg-elev-1` / `paper` | `#111111`         | `#ffffff`              | Panels, cards, primary surface                |
| `bg-elev-2`     | `#1a1a1a`               | `#f7f7f7`              | Rails, headers, elevated chrome               |
| `bg-sunk`       | `#090909`               | `#eeeeee`              | Deepest sunk wells                            |
| `ink`           | `#e5e5e5`               | `#1a1a1a`              | Primary text                                  |
| `ink-muted`     | `#cccccc`               | `#444444`              | Secondary text                               |
| `ink-faint`     | `#888888`               | `#777777`              | Metadata, eyebrows, placeholders              |
| `line`          | `#1a1a1a`               | `#e8e8e8`              | Hairline dividers, default borders            |
| `line-strong`   | `#222222`               | `#dcdcdc`              | Input borders, hover-emphasised dividers      |
| `accent`        | `#0f6a6c` (teal-600)    | `#0f6a6c` (teal-600)   | The one accent. Primary buttons, focus, links |
| `accent-press`  | `#2dd4bf` (teal-300)    | `#0a4548`              | Bright active text/icon on dark               |
| `accent-tint`   | `#0e1f1f`               | `#e6f2f1`              | Selected / hover tint on toolbars & anchors   |
| `brand`         | `#C96AFF` (Vulos purple)| same                   | Occasional brand accent only — never a 2nd UI accent |

### 2.2 The accent rule

**There is exactly one UI accent: deep teal (`#0f6a6c`).**  It reads calm +
trustworthy on a Docs/Signing surface and is committed across office + cloud.
Do not introduce a second UI accent.  **Vulos purple (`#C96AFF`)** exists as an
occasional *brand* mark only (and doubles as the neutral `info` signal); it is
never a general-purpose interactive accent.  When you need a new category colour
(e.g. an app icon), use a signal hue or one of the per-app icon tints below.

### 2.3 Signal + per-app colours

Signal colours are the cloud semantic set: `warning` amber (`#f59e0b`), `error`
rose (`#f43f5e`), `success` teal (`#2dd4bf`), `info` purple (`#C96AFF`) — each
with a low-alpha `-bg` companion so backgrounds never shout.  Each app carries
one low-saturation icon tint so Docs / Sheets / Slides / PDF are
findable at a glance (`--app-docs` blue, `--app-sheets` green, `--app-slides`
amber, `--app-pdf` red) — these colour the icon *stroke* in
the rail and the Home card chip, never a row background.

---

## 3. Typography

### 3.1 The trio

| Role     | Token         | Stack                                                                                  |
| -------- | ------------- | -------------------------------------------------------------------------------------- |
| Chrome   | `--font-sans` | **Inter** (webfont), then `system-ui`, SF Pro, Segoe UI                                |
| Document | `--font-serif`| `ui-serif`, then OS-native serifs (Iowan Old Style, Charter, Source Serif Pro, Cambria)|
| Micro-UI | `--font-mono` | `ui-monospace`, SF Mono, Cascadia Code, Fira Code, JetBrains Mono, Menlo                |

Chrome ships **Inter** as a webfont (imported at the top of `tokens.css`) to
match the vulos-cloud landing exactly across every OS. The **mono** face carries
the IDE feel: section eyebrows, `kbd` chips, and micro-UI labels (`.mono-label`)
render in mono with wide tracking. Serif stays reserved for document bodies.

**Optional swap**: to change the chrome face, override `--font-sans` in
`tokens.css` — no other change is needed.

### 3.2 Where each font goes

- **Sans / Inter (chrome)**: the entire app shell, toolbars, sidebars, buttons,
  metadata, comment author names, table headers.
- **Mono (micro-UI)**: uppercase section eyebrows (`.mono-label`), keyboard
  hints, and terminal-flavoured labels.
- **Serif (document)**: TipTap document body (`.tiptap p`, `.tiptap blockquote`,
  task list bodies), comment anchor quotes (`"…"`), SignView display
  headlines (`Welcome back.`, `Signed.`, `<Signer name>`).

If you're building a new surface and you're unsure: **default to sans**.
Use serif sparingly, only where the surface is itself a document or where
you want an editorial moment (e.g. "Signed." on the post-submit page).

### 3.3 Scale and tracking

The scale is `--text-2xs` (11px) → `--text-3xl` (36px), minor-third ratio
anchored at 14 px.  Chrome uses the token-backed `tracking-tight` (`-0.014em`);
uppercase mono eyebrows use `tracking-wider` (`0.12em`) for the IDE feel.

Reach for the token-backed tracking utilities so refinement stays consistent.

---

## 4. Spacing, Radii, Elevation

### 4.1 Spacing

4-px base.  Prefer `gap-2` (8 px) for chrome rows, `gap-4` (16 px) for cards.
Generous whitespace beats density — give every section room.

### 4.2 Radii

| Token        | Use                                                  |
| ------------ | ---------------------------------------------------- |
| `rounded-xs` (4 px) | Inline marks, small chips, suggestion highlights |
| `rounded-sm` (6 px) | Default buttons, inputs                          |
| `rounded-md` (8 px) | Cards, segmented controls                        |
| `rounded-lg` (12 px)| Modals, document canvas, large panels            |
| `rounded-xl` (16 px)| Hero shells (use sparingly)                      |
| `rounded-pill`      | Badges, pill counters, toggle dots               |

### 4.3 Elevation

Three steps only.  Shadows are deep and neutral (`rgba(0,0,0,…)` on the
near-black dark canvas; a soft `rgba(20,20,20,…)` in light mode) with **no
bloom** — the UI should look printed/inset, not floating.

| Token        | Use                                                       |
| ------------ | --------------------------------------------------------- |
| `shadow-e1`  | Primary buttons, document canvas, light raise on cards    |
| `shadow-e2`  | Popovers (toolbar dropdowns, font picker), tooltips       |
| `shadow-e3`  | Modals                                                    |
| `shadow-focus` | Focus ring — accent tint at 3 px, replaces OS default   |

Do NOT use heavy `shadow-2xl` material-style shadows.  If a surface needs to
feel "raised", it should be by a border + e1, not by a giant drop.

---

## 5. Motion

| Token              | Value                                  | Use                                |
| ------------------ | -------------------------------------- | ---------------------------------- |
| `duration-fast`    | 150 ms                                 | Hover / focus colour transitions   |
| `duration-base`    | 200 ms                                 | Default opens, tab switches        |
| `duration-slow`    | 320 ms                                 | Modals, page reveals, scrolls      |
| `ease-out`         | `cubic-bezier(.22, .61, .36, 1)`        | Default UI ease                    |
| `ease-spring`      | `cubic-bezier(.16, 1.0, .3, 1)`         | Soft springs for open / close      |
| `ease-in`          | `cubic-bezier(.4, 0, 1, 1)`             | Used only for "leave" anims        |

Keyframes provided: `animate-fade-in`, `animate-rise-in`, `animate-scale-in`,
`animate-slide-in-right` — use these for panel/modal mounts.  Prefer them
over inline JS / framer-motion.

`prefers-reduced-motion` is honoured: durations collapse to 0 ms automatically.

---

## 6. Components — patterns to follow

### 6.1 Buttons

Use `<Button>` from `src/components/ui`.  Variants:

- **primary** — exactly one per surface (the "yes" action: Save, Sign, Create).
- **secondary** — the default. Paper bg + line border.
- **ghost** — toolbars and tertiary actions.
- **destructive** — soft persimmon. Confirm dialogs only.
- **link** — underlined text-only. Use sparingly.

Do **not** stack two primary buttons next to each other — that loses the
hierarchy.

### 6.2 Inputs

Use `<Input>` from `src/components/ui` for any text field.  Pass `leading`
for an icon adornment (Search, Lock, …).  Errors go in the `error` prop;
hints in `hint`.  Heights line up with Button heights so rows align.

### 6.3 Tabs

Use `<Tabs>`.  Underline-only style.  Do **not** rebuild tabs with pill
backgrounds — that's the Tailwind-UI cliché.

### 6.4 Modals

Use `<Modal>`.  Backdrop is a near-black ink scrim with a 2 px blur.  Open
animation is `scale-in` with `ease-spring`.

### 6.5 Sidebar

Use `<Sidebar>` primitives.  Active rows get a 2-px accent rail on the LEFT,
not a filled background.  Collapsed width is 56 px; expanded is 240 px.
App-category icons may carry a single warm tint each; the rail itself is
neutral.

### 6.6 Topbar

Use `<Topbar>`.  44 px tall, hairline bottom border.  Slot model:
`leading | title | meta | actions`.  Status indicators (saving / saved / unsaved)
go in `meta` as a discreet inline line — **never** a banner.

### 6.7 Tooltips

Use `<Tooltip>`.  300 ms hover delay so the chrome doesn't flicker.

### 6.8 Save / sync status — `<SaveStatus>`

Use `<SaveStatus status=…>` for the editor save indicator (Docs / Sheets /
Slides share it).  It renders a crafted "breathing" dot (`.save-dot` ladder in
`index.css`: saved / saving / error / offline) + a quiet label, wrapped in a
`role="status"` live region.  `status ∈ 'saved'|'saving'|'dirty'|'error'|
'offline'`.  Pass `text` to override (e.g. "Retrying 2/3").  Never a banner.

### 6.9 Presence — `<Avatar>` / `<AvatarStack>`

Collaborator chips ride the shared `.avatar-chip` shape (ringed against the
chrome).  `<Avatar name color size>`; `<AvatarStack people max>` overlaps chips
and shows a `+N` overflow.  Hue is deterministic per name (`hueFor`) unless the
collab layer supplies a `color`.  The live-cursor name flag is `.rc-flag`
(shared by the Docs + Sheets cursor layers) — a crisp sans caplet, not serif.

### 6.10 Empty states — `<EmptyState>`

Use `<EmptyState icon title hint action size>` for every "nothing here yet"
surface (panels use `size="sm"`, full surfaces `size="lg"`).  Haloed icon +
serif headline + muted hint.  Do NOT hand-roll `<p className="italic">No X.</p>`.

### 6.11 Toolbars — `.toolbar-surface` + `<ToolbarButton>`

Every editor toolbar sits on `.toolbar-surface` (elevated band, hairline
bottom border) so the suite reads as one product.  Buttons are `<ToolbarButton>`
(the tactile `.toolbar-btn` ladder: hover tint → active accent-tint + inset
ring → pressed micro-nudge).  Group with `.toolbar-divider`.  Contextual
sub-toolbars (image tools, table tools) use `bg-bg-elev2` + `animate-slide-in-left`.

### 6.12 Launcher previews — `<DocThumb>`

Recent-file cards and the create-file picker use `<DocThumb type=…>` — a crafted
per-type SVG mock (ruled doc / grid / slide stage / PDF page) tinted with the
app hue.  Reads as a real thumbnail with no server render.  Loading uses
`<Skeleton>` grids, not spinners.

### 6.13 Premium canvas surfaces

The document/slide "paper" rests on a faint lit surface, not flat black:
`.doc-desk` (top-lit wash behind the Docs paper) and `.slide-stage` (accent
spotlight behind the deck).  Keep them extremely subtle — the content is the
protagonist.  All these effects collapse under `prefers-reduced-motion`.

---

## 7. Do / Don't

### Do

- Reach for tokens (`bg-paper`, `text-ink`, `border-line`, `bg-accent`).
- Pair sans chrome with serif document bodies.
- Use one accent button per surface.
- Use the mono `tracking-wider` + uppercase 11-px `.mono-label` for section headings.
- Animate panel mounts with the provided keyframes.
- Use `paper-grain` on hero / signer-facing surfaces for letterpress tooth.
- Force `data-theme="light"` on public-facing surfaces (e.g. SignView) so a
  signer's OS dark mode doesn't make their signing page look threatening.

### Don't

- Don't write `bg-indigo-500`, `text-gray-700`, `border-gray-200`.  These
  bypass the token layer.  Use semantic tokens.
- Don't use `shadow-2xl` or `shadow-lg`.  Use `e1` / `e2` / `e3`.
- Don't use emerald / red-500 for success / error.  Use `success` / `error`.
- Don't introduce a second UI accent — `brand` purple is a mark, not a control.
- Don't swap Inter for a different chrome face inline.  Override `--font-sans`
  in `tokens.css` if a look is needed.
- Don't introduce framer-motion / motion-one / react-spring without a
  cross-team review — CSS keyframes + Tailwind transitions cover 95 % of
  what we need.

---

## 8. Theme model — dark by default

Dark is the **default** canvas (the IDE baseline); light is a first-class
opt-in, not a grudging inversion.

- The `:root` default IS the dark theme (near-black `#0c0c0c` base, `#111111`
  paper), matching vulos-cloud — **not** slate (`#0f172a`). `[data-theme="dark"]`
  is an explicit alias of the default so the cycler has a concrete target.
- `[data-theme="light"]` opts into the clean white/grey light theme (same teal
  accent, per-app tints darkened for AA contrast on white).
- The teal accent (`#0f6a6c`) is committed across both themes; on dark, active
  text/icons brighten to `accent-press` (`teal-300 #2dd4bf`) for legibility.
- Signal backgrounds ride a low (10–14 %) alpha overlay so they don't shout.
- `.paper-grain` reduces its opacity / switches blend in dark so the texture
  stays subtle.

The `useTheme()` hook (in `components/ui/useTheme.js`) provides explicit
light / dark / system cycling, persisted to `localStorage['vulos.theme']`.
The cycler IconButton lives in the sidebar footer.

---

## 9. Surfaces touched in this pass

| Surface                | Status                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `tokens.css`           | **New**. Source of truth.                                           |
| `tailwind.config.js`   | Rebuilt against tokens.                                             |
| `index.css`            | Rebuilt: token-driven base, TipTap prose in serif, scrollbar, marks.|
| `index.html`           | Inter removed; theme-color tracks light/dark; comments documented.  |
| `components/ui/*`      | **New** primitives: Button, IconButton, Input, Card, Tabs, Modal, Tooltip, Sidebar, Topbar, useTheme. |
| `components/Layout.jsx`| Rewritten against design-system Sidebar.                            |
| `components/LoginScreen.jsx` | Warm paper, serif headline, single accent button.              |
| `components/CommentsPanel.jsx` | Clean side rail, design-system Tabs, anchor quoted in serif. |
| `apps/docs/DocsEditor.jsx` | New Topbar + meta-line save status + paper canvas + grain.     |
| `apps/docs/DocsToolbar.jsx`| Token colours, eyebrow group labels, quiet Export dropdown.     |
| `apps/pdf/SignView.jsx`| Public signer page: warm paper, serif name, single-accent fields, progress bar, sage-success completion screen. |
| `apps/sheets/SheetsEditor.jsx` | Design-system `Topbar` + meta-line save status + quiet Export dropdown; Fortune Sheet kept intact, selection / header / tab chrome retinted via `.sheets-themed` rules through tokens (accent + warm neutrals). |
| `apps/slides/SlidesEditor.jsx` | Design-system `Topbar` + meta-line save status; thumbnail rail rebuilt against `bg-clay` + 2-px accent rail for active slide; quiet token-driven mini toolbar (uses `IconButton` + `Tooltip`); paper-grain slide canvas; speaker notes use the warm `warning-bg` strip. DOMPurify `sanitize()` retained on every `slide.content` rendering path. |
| `apps/slides/SlidePreview.jsx` | Light-touch retint — reveal.js owns the deck rendering; only the close affordance is design-system (focus ring + token colours). `sanitize()` + DOMPurify wrapper preserved. |
| `components/PresenceBar.jsx` | Warm-signal `PresenceDot` palette (sage / honey / persimmon / accent), serif-italic small-caps tooltip name labels, token-driven `StatusPicker`. |
| `components/RemoteCursors.jsx` | Caret + cell-selection name labels rendered in serif italic with the warm tracking; aligned with the PresenceBar tooltip treatment. |
| `apps/pdf/PDFEditor.jsx` | Design-system `Topbar` with quiet meta-line, distinguished primary "Prepare to Sign" `Button`, warm-paper canvas + `paper-grain`, page thumbnails sidebar with 2-px accent rail on the selected slot, signature modal ported to design-system `Tabs` + `IconButton`, single-accent annotation overlays (no rainbow). |
| `apps/pdf/SigningSetup.jsx` | Field type chips as `IconButton`s with serif-italic labels, signer roster as `Card`s with a per-signer colour stripe (name + email in serif italic), required toggle as a clear box-check control, signing-order picker (sequential / parallel) via underline `Tabs`. Drag-place + persist logic untouched. |
| `components/EnvelopeDashboard.jsx` | Card-per-envelope with warm signal-hue status badges (sage / honey / persimmon), quiet horizontal accent progress bar, expandable per-signer rows in serif italic, remind/cancel as `IconButton`s + `Tooltip`s. |
| `components/Verify.jsx` | Public verification page: warm paper drop-zone, serif "Verify a Vulos-signed document" headline, calm verdict reveal with sage `ShieldCheck` / persimmon `ShieldAlert`, collapsible per-signer rows in serif body, `Powered by Vulos Office` provenance footer. |

## 10. Surfaces deferred to the next pass

All previously deferred PDF / Signing surfaces — `PDFEditor`, `SigningSetup`,
`EnvelopeDashboard`, `Verify` — have been migrated to the token layer in this
pass and are documented in §9 above.  No surfaces remain on the deferred list.
