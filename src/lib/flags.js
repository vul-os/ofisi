/**
 * src/lib/flags.js — build/deploy-time feature flags.
 *
 * ── VITE_DOCS_COLLAB — live co-editing in Docs ──────────────────────────────
 *
 * Docs' live collaboration (server relay + P2P invite links) is gated behind
 * this flag so a deployment can turn co-editing OFF and keep a perfectly good
 * single-user editor. It exists because collaborative sync is the one feature
 * whose failure mode is SILENT DATA CORRUPTION rather than a visible error:
 * a sync path that mis-maps a remote change onto the local document can move
 * content into the wrong node (inside a table cell, across a block boundary)
 * and the user has no way to know. When the flag is off, Docs never opens a
 * sync transport at all — no ops in, no ops out — and the UI says so plainly
 * instead of showing collaboration affordances that quietly do nothing.
 *
 * HONESTY CONTRACT (the reason this flag is not just an if-statement):
 *   • Off  → every co-editing affordance is hidden or explicitly labelled
 *            unavailable. A user must never believe their edits are syncing
 *            when they are not. See DocsEditor's "Live co-editing off" pill,
 *            the AccountShareModal notice, and the invite-link toast.
 *   • On   → co-editing runs the structure-aware (Yjs / y-prosemirror) path,
 *            which propagates formatting + structure and can never place a
 *            remote change at a wrong offset.
 *
 * Values: "on" | "1" | "true" enable; "off" | "0" | "false" disable.
 *
 * DEFAULT: OFF, today, deliberately. The current Docs sync path diffs the
 * document as PLAIN TEXT (editor.getText()), so (a) remote formatting and
 * structure never propagate at all and (b) a plain-text offset does not map to
 * a ProseMirror position in a multi-block document, which can land a remote
 * insertion inside the wrong node and corrupt the document structure. Until
 * that transport is replaced with a structure-aware one, co-editing is off by
 * default and honestly labelled unavailable rather than silently corrupting
 * documents. Set VITE_DOCS_COLLAB=on to re-enable it knowingly.
 */

function env(name) {
  try {
    // import.meta.env is replaced at build time by Vite; guard for non-Vite
    // consumers of the library build (jest/node) where it may be undefined.
    const e = typeof import.meta !== 'undefined' ? import.meta.env : undefined
    if (e && e[name] !== undefined) return String(e[name])
  } catch { /* no import.meta in this runtime */ }
  try {
    if (typeof process !== 'undefined' && process.env && process.env[name] !== undefined) {
      return String(process.env[name])
    }
  } catch { /* no process */ }
  return undefined
}

function boolFlag(name, dflt) {
  const raw = env(name)
  if (raw === undefined || raw === '') return dflt
  const v = raw.trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return false
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true
  return dflt
}

/**
 * True when Docs may open a live co-editing transport (server relay and/or the
 * P2P invite-link fabric). When false, Docs is a single-user editor: it still
 * autosaves, exports, comments, and version-histories exactly as before — it
 * simply never sends or applies a remote document op.
 */
export function docsCollabEnabled() {
  return boolFlag('VITE_DOCS_COLLAB', false)
}

/** User-facing copy for why co-editing is unavailable (kept in one place). */
export const DOCS_COLLAB_OFF_NOTICE =
  'Live co-editing is turned off on this deployment. You can still share this ' +
  'document and take turns editing it, but changes will not appear in real time ' +
  "— reload to see someone else's saved edits, and avoid editing at the same time."
