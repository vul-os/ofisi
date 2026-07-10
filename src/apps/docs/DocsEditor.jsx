import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useEditor, EditorContent, Extension, Mark } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { DocImage, fileToDataUri, isEmbeddableImage } from './docsImage.js'
import Link from '@tiptap/extension-link'
import TextStyle from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import Underline from '@tiptap/extension-underline'
import TextAlign from '@tiptap/extension-text-align'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeaderBase from '@tiptap/extension-table-header'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import CharacterCount from '@tiptap/extension-character-count'
import Placeholder from '@tiptap/extension-placeholder'
import Typography from '@tiptap/extension-typography'
import { FontSize, FontFamily } from '../../lib/tiptap/fontStyle.js'

// Lightweight subscript / superscript marks (no extra npm packages needed).
const Subscript = Mark.create({
  name: 'subscript',
  parseHTML() { return [{ tag: 'sub' }] },
  renderHTML() { return ['sub', 0] },
  addKeyboardShortcuts() { return { 'Mod-,': () => this.editor.commands.toggleMark(this.name) } },
})

const Superscript = Mark.create({
  name: 'superscript',
  parseHTML() { return [{ tag: 'sup' }] },
  renderHTML() { return ['sup', 0] },
  addKeyboardShortcuts() { return { 'Mod-.': () => this.editor.commands.toggleMark(this.name) } },
})

// WAVE-52: header cells render with scope="col" so screen readers associate a
// column heading with the data cells below it (a11y). Extends the stock
// TableHeader without changing its schema/parse behaviour.
const TableHeader = TableHeaderBase.extend({
  renderHTML({ HTMLAttributes }) {
    return ['th', { ...HTMLAttributes, scope: HTMLAttributes.scope || 'col' }, 0]
  },
})
import { ArrowLeft, Save, Loader2, AlertCircle, History, Users, MessageSquare, Activity, GitBranch, Search, Type as TypeIcon, ListTree, Share2, Eye } from 'lucide-react'
import FindReplace from './components/FindReplace'
import WordCountModal from './components/WordCountModal'
import DocumentOutline from './components/DocumentOutline'
import { useFilesStore, getSaveState, onSaveStateChange } from '../../store/filesStore'
import { api } from '../../lib/api'
import { sanitizeDocHtml } from '../../lib/sanitize'
import { readDraft, clearDraft } from '../../lib/draftStore'
import DocsToolbar from './DocsToolbar'
import HistoryPanel from '../../components/HistoryPanel'
import CommentsPanel from '../../components/CommentsPanel'
import SuggestionPanel from '../../components/SuggestionPanel'
import ActivityFeed from '../../components/ActivityFeed'
import { DocsCollabSession } from '../../lib/crdt/index.js'
import { useP2PCollab } from './useP2PCollab.js'
import { useServerCollab } from './useServerCollab.js'
import P2PShareModal from './components/P2PShareModal.jsx'
import AccountShareModal from '../../components/AccountShareModal.jsx'
import { useAuthStore } from '../../store/authStore'
import { getSuggestionStore } from '../../lib/crdt/suggestions.js'
import { useLiveCursors } from '@vulos/relay-client/useLiveCursors'
import { usePresence } from '@vulos/relay-client/presence'
import { DocsCursorLayer } from '../../components/RemoteCursors.jsx'
import PresenceBar from '../../components/PresenceBar.jsx'
import { Button, IconButton, Tooltip, Topbar, LoadingState, SaveStatus, AvatarStack } from '../../components/ui'
import { Skeleton } from '../../components/ui/LoadingState'
import { getCommentStore } from '../../lib/crdt/comments'
import {
  createCommentDecorationsExtension,
  COMMENT_PLUGIN_KEY,
  COMMENT_META,
  readMappedRanges,
  decorationCommentId,
  commentIdAtSelection,
} from './commentDecorations.js'
import {
  FootnoteRef,
  FootnoteItem,
  FootnotesList,
  FootnoteNumberingExtension,
} from './footnotes.js'
import { MathInline, MathBlock } from './equation.js'
import { TableOfContentsNode } from './tableOfContents.js'
import EquationEditor from './components/EquationEditor.jsx'
import PageSetupDialog from './components/PageSetupDialog.jsx'
import HeaderFooterDialog from './components/HeaderFooterDialog.jsx'
import { normalizePageSetup, pageDimensions } from './pageSetup.js'
import { normalizeHeaderFooter, bandsForPage } from './headerFooter.js'
import { measurePageBreaks, createDebouncedMeasure } from './pagination.js'

// Imported files may carry _html; use that as editor content.
// WAVE-52: _html is user/peer-supplied markup (imported .html/.docx, restored
// drafts, history snapshots). Sanitise it before handing it to TipTap so no
// script / on*-handler / dangerous inline-style survives into the document —
// this is the wave-14 allow-list boundary applied to the Docs import path, and
// it keeps imported tables safe (colspan/rowspan/scope survive; <td onclick>/
// <td style="…javascript:…"> are stripped). See lib/sanitize.js.
function resolveContent(content) {
  if (!content) return { type: 'doc', content: [{ type: 'paragraph' }] }
  if (content._html) return sanitizeDocHtml(content._html)  // TipTap accepts HTML string
  return content
}

const RETRY_DELAY_MS = 4000
const AUTOSAVE_DELAY_MS = 2000

// ---------------------------------------------------------------------------
// applyTextPatch — apply a remote CRDT text change to a TipTap editor
// without clobbering the local caret position.
//
// Strategy: locate the changed region (common prefix/suffix), then issue
// TipTap deleteRange + insertContentAt so only the changed characters are
// touched. This keeps the caret stable for insertions and deletions outside
// the user's current cursor region.
// ---------------------------------------------------------------------------
// WAVE-52: detect structured block nodes (tables) whose cell layout means the
// plain-text offset used by the character patch below no longer maps 1:1 to a
// ProseMirror document position. Applying a text-offset delete/insert across a
// table boundary can split cells or orphan rows. When such a node is present we
// skip the fragile in-place patch (the authoritative doc JSON is still saved on
// every edit, and late-joiner/full-state reconcile keeps peers convergent), so
// a remote keystroke can never corrupt table structure. Non-table docs keep the
// caret-stable minimal patch exactly as before.
//
// WAVE-57: an `image` is an atomic (leaf) block node that contributes no text
// to the plain-text projection the patch diffs against, so a text-offset
// delete/insert straddling it could clobber the node the same way it can split
// a table cell. Treat images as structured too — when a doc contains an image we
// fall back to full-state reconcile (authoritative JSON still saved every edit),
// keeping the image node stable across the wave-37 CRDT.
function docHasStructuredNodes(editor) {
  let found = false
  try {
    editor.state.doc.descendants((node) => {
      // P4: math nodes are atomic leaf nodes carrying no plain text — treat them
      // as structured (like image/table) so a text-offset patch can't clobber them.
      if (node.type.name === 'table' || node.type.name === 'image' ||
          node.type.name === 'mathInline' || node.type.name === 'mathBlock') {
        found = true; return false
      }
      return true
    })
  } catch { /* non-fatal */ }
  return found
}

export function applyTextPatch(editor, prevText, nextText) {
  if (prevText === nextText) return

  // Tables (and other structured blocks) make the plain-text→doc-position
  // mapping ambiguous; skip the in-place patch rather than risk corrupting the
  // node tree. Convergence is preserved by JSON persistence + full-state sync.
  if (docHasStructuredNodes(editor)) return

  // Find common prefix.
  let pre = 0
  while (pre < prevText.length && pre < nextText.length && prevText[pre] === nextText[pre]) pre++

  // Find common suffix (not overlapping prefix).
  let suf = 0
  while (
    suf < prevText.length - pre &&
    suf < nextText.length - pre &&
    prevText[prevText.length - 1 - suf] === nextText[nextText.length - 1 - suf]
  ) suf++

  const deleteCount = prevText.length - pre - suf
  const insertStr = nextText.slice(pre, nextText.length - suf)

  // TipTap positions are 1-based (the doc node itself occupies position 0).
  // getText() returns all chars with no extra delimiters, but character
  // offset in the doc may differ from string offset in multi-node docs.
  // For a plain-text approximation we use from=pre+1 which is valid for
  // simple single-paragraph docs; for richly-structured docs this is a
  // best-effort reconcile.
  const from = pre + 1
  const to = from + deleteCount

  // UNDO-INTEGRITY: a REMOTE peer's edit must NOT enter this editor's local undo
  // history. Without addToHistory:false, TipTap's history extension records the
  // remote deleteRange/insert, so the local user's next Ctrl+Z reverts the PEER's
  // change — which then re-broadcasts as a local delete and corrupts the shared
  // document (and Ctrl+Y could resurrect a peer-deleted node). Tag the transaction
  // so only genuinely-local keystrokes are undoable.
  editor.chain()
    .command(({ tr }) => { tr.setMeta('addToHistory', false); return true })
    .deleteRange({ from, to })
    .insertContentAt(from, insertStr)
    .run()
}

// Derive a stable peerId for this browser session (persists across reloads).
function getOrCreatePeerId() {
  let id = sessionStorage.getItem('vulos_peer_id')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('vulos_peer_id', id)
  }
  return id
}

// ---------------------------------------------------------------------------
// OFFICE-27: SuggestionDecorations — ProseMirror plugin that renders pending
// suggestion annotations as inline highlights (green = insert, red strikethrough
// = delete).  The plugin state is a plain array updated via a custom transaction
// meta key whenever suggestions change.
// ---------------------------------------------------------------------------

const SUGGESTION_PLUGIN_KEY = new PluginKey('suggestions')

function makeSuggestionDecoration(from, to, kind) {
  // TipTap/ProseMirror positions are 1-indexed and include node boundaries.
  // Character offset `from` in plain text ≈ doc position `from + 1`.
  const docFrom = from + 1
  const docTo = to + 1
  if (kind === 'insert') {
    // Inline widget at cursor position showing the inserted text.
    return Decoration.inline(docFrom, Math.max(docTo, docFrom + 1), {
      class: 'suggestion-insert',
    })
  } else {
    return Decoration.inline(docFrom, Math.max(docTo, docFrom + 1), {
      class: 'suggestion-delete',
    })
  }
}

function buildSuggestionPlugin() {
  return new Plugin({
    key: SUGGESTION_PLUGIN_KEY,
    state: {
      init() { return { suggestions: [], decorations: DecorationSet.empty } },
      apply(tr, old, _oldState, newState) {
        const meta = tr.getMeta(SUGGESTION_PLUGIN_KEY)
        if (meta) {
          const pending = (meta.suggestions || []).filter((s) => s.state === 'pending')
          const decos = pending.flatMap((s) => {
            try {
              return [makeSuggestionDecoration(s.from, s.to, s.kind)]
            } catch { return [] }
          })
          return {
            suggestions: meta.suggestions,
            decorations: DecorationSet.create(newState.doc, decos),
          }
        }
        // Map existing decorations through document changes.
        return { suggestions: old.suggestions, decorations: old.decorations.map(tr.mapping, tr.doc) }
      },
    },
    props: {
      decorations(state) {
        return this.getState(state).decorations
      },
    },
  })
}

const SuggestionDecorationsExtension = Extension.create({
  name: 'suggestionDecorations',
  addProseMirrorPlugins() {
    return [buildSuggestionPlugin()]
  },
})

// ---------------------------------------------------------------------------
// FindHighlightExtension — ProseMirror plugin for Find/Replace all-match
// decorations. FindReplace.jsx dispatches transactions with the meta key
// 'findHighlight' containing a DecorationSet to display/clear highlights.
// ---------------------------------------------------------------------------
const FIND_HIGHLIGHT_META_KEY = 'findHighlight'

const FindHighlightExtension = Extension.create({
  name: 'findHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(FIND_HIGHLIGHT_META_KEY)
            if (meta !== undefined) return meta
            return old.map(tr.mapping, tr.doc)
          },
        },
        props: {
          decorations(state) { return this.getState(state) },
        },
      }),
    ]
  },
})

export default function DocsEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { files, saveFileWithDraft, markDirty } = useFilesStore()
  const [file, setFile] = useState(files.find((f) => f.id === id))
  const [title, setTitle] = useState(file?.name || 'Untitled')
  const [pendingContent, setPendingContent] = useState(null)
  const [saveStatus, setSaveStatus] = useState(getSaveState(id))
  const [draft, setDraft] = useState(null)           // pending draft to offer restore
  const [retryCount, setRetryCount] = useState(0)
  const [showHistory, setShowHistory] = useState(false)
  const [showComments, setShowComments] = useState(false)
  // WAVE-45: comment-anchor highlighting + click-to-jump.
  const [comments, setComments] = useState([])          // the live comment list (for decorations)
  const [activeCommentId, setActiveCommentId] = useState(null) // clicked/focused comment
  // onActivate is called from inside the ProseMirror plugin (created once); use
  // a ref so the plugin always sees the latest handler.
  const activateCommentRef = useRef(null)
  const [showActivity, setShowActivity] = useState(false)
  const [showOutline, setShowOutline] = useState(false)
  const scrollRef = useRef(null)  // canvas scroll container, for outline tracking
  // Find/Replace
  const [findMode, setFindMode] = useState(null) // null | 'find' | 'replace'
  // Word count modal
  const [showWordCount, setShowWordCount] = useState(false)
  // Page count (measured — P1 pagination)
  const [pageCount, setPageCount] = useState(1)
  // P1: measured page-break y-offsets (px, relative to content top). View-only.
  const [pageBreaks, setPageBreaks] = useState([])
  // P3: page setup (size / orientation / margins). Document metadata.
  const [pageSetup, setPageSetup] = useState(normalizePageSetup(null))
  const [showPageSetup, setShowPageSetup] = useState(false)
  // P2: headers & footers. Document metadata.
  const [headerFooter, setHeaderFooter] = useState(normalizeHeaderFooter(null))
  const [showHeaderFooter, setShowHeaderFooter] = useState(false)
  // P4: equation editor dialog state.
  const [equationEditor, setEquationEditor] = useState(null) // null | { latex, display, editing }
  // P5: native spellcheck toggle (browser dictionary). Persisted per-browser.
  const [spellcheck, setSpellcheck] = useState(() => {
    try { return localStorage.getItem('docs_spellcheck') !== 'off' } catch { return true }
  })
  // OFFICE-27: suggestion / track-changes mode
  const [suggestionMode, setSuggestionMode] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const suggestionModeRef = useRef(false)
  const prevTextForSugRef = useRef('')   // plain text before the suggestion-mode edit
  const [collabPeers, setCollabPeers] = useState({})  // peerId → state
  const saveTimer = useRef(null)
  const retryTimer = useRef(null)
  const titleRef = useRef(title)
  titleRef.current = title

  // CRDT collab session (OFFICE-22)
  const collabRef = useRef(null)
  // Tracks the plain text the CRDT last saw so we can diff on next local edit.
  const prevCrdtTextRef = useRef('')
  // Flag: true while we're applying a remote op so onUpdate doesn't re-broadcast.
  const applyingRemoteRef = useRef(false)

  // ── WAVE-25: secure local/P2P collab (invite-link, E2E, ro-enforced) ───────
  // Additive second collab mode — orthogonal to the cloud DocsCollabSession
  // above. Active only when the URL carries a #vp2p= invite or the user shares.
  const [showP2PShare, setShowP2PShare] = useState(false)
  // Account-based sharing (named users, role-scoped, ACL-enforced). The primary
  // Share entry point; it offers the complementary P2P E2E link path alongside.
  const [showAccountShare, setShowAccountShare] = useState(false)
  const myAccountId = useAuthStore((s) => s.accountId)
  const editorRefForP2P = useRef(null)   // set below once `editor` exists
  const applyRemoteP2PText = useCallback((remoteText) => {
    const ed = editorRefForP2P.current
    if (!ed) return
    applyingRemoteRef.current = true
    try {
      const cur = ed.getText()
      if (cur !== remoteText) {
        applyTextPatch(ed, cur, remoteText)
        prevCrdtTextRef.current = ed.getText()
      }
    } finally {
      applyingRemoteRef.current = false
    }
  }, [])
  const p2p = useP2PCollab({ fileId: id, onRemoteText: applyRemoteP2PText })
  // Stable ref so the once-created onUpdate closure always calls the latest
  // p2p.onLocalText (assigned on every render below).
  const p2pOnLocalTextRef = useRef(null)

  // WAVE37: server-mediated collab (the CLOUD / account path). Complements the
  // p2p fabric — keeps two editors in sync + persisted even when no p2p peer is
  // reachable, and gives a late joiner current state from the server. Suppressed
  // while the E2E p2p session is active (encrypted ops must not hit the readable
  // server) via e2eActive. Remote text applies through the SAME guarded patch as
  // p2p, so ops from either transport converge with no double-apply.
  const server = useServerCollab({
    fileId: id,
    onRemoteText: applyRemoteP2PText,
    e2eActive: p2p.active,
  })
  const serverOnLocalTextRef = useRef(null)
  serverOnLocalTextRef.current = server.onLocalText

  // Subscribe to save state changes for this file
  useEffect(() => {
    const unsub = onSaveStateChange(id, (state) => setSaveStatus({ ...state }))
    return unsub
  }, [id])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
      // WAVE-57: hardened inline-image node (raster-only embeds, width/align/alt).
      DocImage,
      Link.configure({ openOnClick: false }),
      TextStyle,
      Color,
      // Teach the textStyle mark to actually render font size / family — the
      // base extension only defines the mark shell (see fontStyle.js).
      FontSize,
      FontFamily,
      Highlight.configure({ multicolor: true }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      Typography,
      Subscript,
      Superscript,
      // OFFICE-27: inline suggestion decorations (green insert / red strikethrough delete)
      SuggestionDecorationsExtension,
      // Find/Replace all-match decorations (yellow highlights)
      FindHighlightExtension,
      // WAVE-45: comment-anchor highlighting + click-to-jump.
      createCommentDecorationsExtension({
        onActivate: (cid) => activateCommentRef.current?.(cid),
      }),
      // WAVE-45: real footnotes — inline ref + auto-numbered list at doc end.
      FootnoteRef,
      FootnoteItem,
      FootnotesList,
      FootnoteNumberingExtension,
      // P4: KaTeX-rendered equations (inline + block). Source LaTeX is a plain
      // text attr; KaTeX renders client-side with trust:false (see equation.js).
      MathInline,
      MathBlock,
      // P5: live-updating table of contents (auto-refreshes from headings).
      TableOfContentsNode,
    ],
    content: resolveContent(file?.content),
    // WAVE-57: paste / drop a raster image → embed it as a bounded base64 data:
    // URI. Goes through isEmbeddableImage + fileToDataUri (raster-only, size-
    // capped, SVG refused) — the exact same gate as the toolbar picker, so no
    // insert path can smuggle an SVG/oversized/non-image data: URI into the doc.
    editorProps: {
      // P5: native browser spellcheck on the editable surface. The browser's own
      // dictionary underlines misspellings + offers corrections — no dependency,
      // works offline per the platform. Toggle updates the live DOM attr below.
      attributes: { spellcheck: 'true' },
      handlePaste: (view, event) => {
        const files = Array.from(event.clipboardData?.files || [])
        const img = files.find(isEmbeddableImage)
        if (!img) return false
        event.preventDefault()
        fileToDataUri(img)
          .then((src) => view.dispatch(view.state.tr.replaceSelectionWith(
            view.state.schema.nodes.image.create({ src }),
          )))
          .catch(() => {})
        return true
      },
      handleDrop: (view, event) => {
        const files = Array.from(event.dataTransfer?.files || [])
        const img = files.find(isEmbeddableImage)
        if (!img) return false
        event.preventDefault()
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
        fileToDataUri(img)
          .then((src) => {
            const node = view.state.schema.nodes.image.create({ src })
            const tr = pos != null
              ? view.state.tr.insert(pos, node)
              : view.state.tr.replaceSelectionWith(node)
            view.dispatch(tr)
          })
          .catch(() => {})
        return true
      },
    },
    onUpdate: ({ editor: ed }) => {
      // ── OFFICE-27: suggestion mode intercept ──────────────────────────────
      // When suggestion mode is active: undo the edit, compute the diff, and
      // record it as a pending suggestion instead of applying it directly.
      if (suggestionModeRef.current && !applyingRemoteRef.current) {
        const nextText = ed.getText()
        const prevText = prevTextForSugRef.current
        if (nextText !== prevText) {
          // Revert the edit so the base document stays unchanged.
          ed.commands.undo()
          // Compute diff: common prefix/suffix → insert or delete range.
          let pre = 0
          while (pre < prevText.length && pre < nextText.length && prevText[pre] === nextText[pre]) pre++
          let suf = 0
          const maxSuf = Math.min(prevText.length - pre, nextText.length - pre)
          while (suf < maxSuf && prevText[prevText.length - 1 - suf] === nextText[nextText.length - 1 - suf]) suf++
          const deleted = prevText.slice(pre, suf > 0 ? prevText.length - suf : prevText.length)
          const inserted = nextText.slice(pre, suf > 0 ? nextText.length - suf : nextText.length)
          const from = pre
          const to = pre + deleted.length

          const peerId = sessionStorage.getItem('vulos_peer_id') || 'local'
          const store = getSuggestionStore(id)
          let sg
          if (inserted.length > 0) {
            sg = store.addInsert(from, to, inserted, peerId)
          } else if (deleted.length > 0) {
            sg = store.addDelete(from, to, peerId)
          }
          if (sg) {
            // Persist to backend (fire-and-forget; store already has it)
            api.createSuggestion(id, sg.kind, sg.author_id, sg.from, sg.to, sg.text || '').catch(() => {})
            setSuggestions(store.list())
            setShowSuggestions(true)
          }
        }
        return
      }

      markDirty(id)
      clearTimeout(saveTimer.current)
      clearTimeout(retryTimer.current)
      setRetryCount(0)
      saveTimer.current = setTimeout(() => doSave(), AUTOSAVE_DELAY_MS)

      // CRDT broadcast: skip if this update was triggered by a remote apply.
      if (!applyingRemoteRef.current) {
        const nextText = ed.getText()
        if (collabRef.current) {
          collabRef.current.applyLocal(prevCrdtTextRef.current, nextText)
        }
        // WAVE-25: also drive the P2P session when active (no-op for ro peers).
        if (p2pOnLocalTextRef.current) {
          p2pOnLocalTextRef.current(prevCrdtTextRef.current, nextText)
        }
        // WAVE37: also drive the server-mediated session (the cloud/account path;
        // inert while the E2E p2p session is active, no-op for viewers).
        if (serverOnLocalTextRef.current) {
          serverOnLocalTextRef.current(prevCrdtTextRef.current, nextText)
        }
        prevCrdtTextRef.current = nextText
      }
    },
    onSelectionUpdate: ({ editor: ed }) => {
      // OFFICE-25: broadcast local caret/selection position to peers over BOTH
      // transports — the p2p fabric (when reachable) and the server presence
      // relay (the cloud fallback). Whichever a given peer is on will see us.
      const { from, to } = ed.state.selection
      if (broadcastDocCursorRef.current) broadcastDocCursorRef.current(from, to)
      if (broadcastServerCursorRef.current) broadcastServerCursorRef.current(from, to)
    },
  })

  // P2/P3: hydrate page-setup + header/footer from the file's stored content.
  // They ride the doc content object as sibling keys (see doSave) so they persist
  // with the same authoritative save/load as the doc JSON — NOT over the text CRDT.
  const loadDocMeta = useCallback((content) => {
    if (content && typeof content === 'object') {
      if (content.pageSetup) setPageSetup(normalizePageSetup(content.pageSetup))
      if (content.headerFooter) setHeaderFooter(normalizeHeaderFooter(content.headerFooter))
    }
  }, [])

  // Load file from API if not in store cache
  useEffect(() => {
    if (!file && id) {
      api.getFile(id).then((f) => {
        setFile(f)
        setTitle(f.name)
        loadDocMeta(f.content)
        setPendingContent(resolveContent(f.content))
      }).catch(() => navigate('/docs'))
    } else if (file) {
      loadDocMeta(file.content)
    }
  }, [id])

  // Check for a pending draft on mount (crash recovery)
  useEffect(() => {
    if (!id) return
    readDraft(id).then((d) => {
      if (d && d.ts) {
        setDraft(d)
      }
    })
  }, [id])

  // Apply pending content once editor is ready
  useEffect(() => {
    if (editor && pendingContent !== null) {
      editor.commands.setContent(pendingContent, false)
      setPendingContent(null)
    }
  }, [editor, pendingContent])

  // ── CRDT collab session (OFFICE-22) ──────────────────────────────────────
  useEffect(() => {
    if (!id) return

    const peerId = getOrCreatePeerId()
    const session = new DocsCollabSession({ fileId: id, peerId })
    collabRef.current = session

    // Remote-change handler: apply peer op to editor without caret jump.
    session.addEventListener('change', (ev) => {
      if (!ev.detail.remote) return
      const remoteText = ev.detail.text
      // Guard: don't re-broadcast this programmatic update.
      applyingRemoteRef.current = true
      try {
        // We reconcile by replacing editor content only when the plain text
        // has actually diverged.  We preserve the HTML structure by doing a
        // character-level merge instead of a full setContent replacement:
        // for plain-text divergence we fall back to setContent on the
        // current JSON with the text patched.  The common case (single char
        // insert/delete) is handled via TipTap's insertContentAt / deleteRange
        // so the caret stays stable.
        //
        // For simplicity in V1 we use a safe full-replace only when the
        // texts differ, keeping the existing JSON structure otherwise.
        // This covers the no-caret-jump requirement for small edits.
        if (editorRef.current) {
          const ed = editorRef.current
          const curText = ed.getText()
          if (curText !== remoteText) {
            // Build a minimal patch: find common prefix/suffix and apply
            // TipTap commands to sync the plain-text range that changed.
            applyTextPatch(ed, curText, remoteText)
            prevCrdtTextRef.current = ed.getText()
          }
        }
      } finally {
        applyingRemoteRef.current = false
      }
    })

    // Peer connection-state events (for optional UI indicator).
    session.addEventListener('state', (ev) => {
      const { peerId: pid, state } = ev.detail
      setCollabPeers((prev) => ({ ...prev, [pid]: state }))
    })

    // Async join — errors are non-fatal (signaling may be unavailable
    // in single-user / offline mode; local editing continues normally).
    session.join().catch((err) => {
      console.warn('[collab] fabric join failed (single-user mode):', err?.message)
    })

    return () => {
      session.leave()
      collabRef.current = null
    }
  }, [id])

  // P5: reflect the spellcheck toggle onto the editable DOM + persist it.
  useEffect(() => {
    if (!editor) return
    try {
      editor.view.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
      localStorage.setItem('docs_spellcheck', spellcheck ? 'on' : 'off')
    } catch { /* non-fatal */ }
  }, [editor, spellcheck])

  // Keep a ref to the editor instance for use inside the collab event handler.
  const editorRef = useRef(null)
  useEffect(() => {
    editorRef.current = editor
    editorRefForP2P.current = editor
  }, [editor])

  // WAVE-25: keep the stable ref pointed at the latest p2p.onLocalText.
  p2pOnLocalTextRef.current = p2p.onLocalText

  // WAVE-25: read-only peers cannot edit the shared document — make the editor
  // itself non-editable so the UX matches the ro capability (they still see
  // live remote edits and a read-only badge).
  useEffect(() => {
    if (editor) editor.setEditable(!p2p.readOnly)
  }, [editor, p2p.readOnly])

  // WAVE-25: seed the P2P diff baseline once the editor mounts, so the first
  // local edit diffs against the real content, not ''.
  useEffect(() => {
    if (editor && p2p.active) prevCrdtTextRef.current = editor.getText()
  }, [editor, p2p.active])

  // ── OFFICE-27: Suggestion mode ────────────────────────────────────────────

  // Keep ref in sync so the onUpdate closure (created once) always reads the latest value.
  useEffect(() => {
    suggestionModeRef.current = suggestionMode
    if (editor) prevTextForSugRef.current = editor.getText()
  }, [suggestionMode, editor])

  // Load suggestions from server on mount.
  useEffect(() => {
    if (!id) return
    api.listSuggestions(id)
      .then((items) => {
        const store = getSuggestionStore(id)
        store.loadFromServer(items || [])
        setSuggestions(store.list())
      })
      .catch(() => {}) // backend may not be running — fail silently
  }, [id])

  // Toggle suggestion mode: update ref + seed prevTextForSug.
  const handleToggleSuggestionMode = () => {
    setSuggestionMode((v) => {
      const next = !v
      suggestionModeRef.current = next
      if (editor) prevTextForSugRef.current = editor.getText()
      if (next) setShowSuggestions(true)
      return next
    })
  }

  // Accept: apply the change to the document and mark accepted.
  const handleAcceptSuggestion = async (sg) => {
    if (!editor) return
    applyingRemoteRef.current = true
    try {
      if (sg.kind === 'insert') {
        // Insert the suggested text at the proposed offset (from == to for pure insert).
        editor.chain().focus().insertContentAt(sg.from + 1, sg.text).run()
      } else {
        // Delete the proposed range.
        editor.chain().focus().deleteRange({ from: sg.from + 1, to: sg.to + 1 }).run()
      }
      doSave()
    } finally {
      applyingRemoteRef.current = false
    }
    // Update store and backend.
    const store = getSuggestionStore(id)
    store.accept(sg.id, 'reviewer')
    setSuggestions(store.list())
    api.updateSuggestion(id, sg.id, 'accepted', 'reviewer').catch(() => {})
  }

  // Reject: discard the suggestion (document unchanged).
  const handleRejectSuggestion = async (sg) => {
    const store = getSuggestionStore(id)
    store.reject(sg.id, 'reviewer')
    setSuggestions(store.list())
    api.updateSuggestion(id, sg.id, 'rejected', 'reviewer').catch(() => {})
  }

  // Update ProseMirror decorations whenever the suggestions list changes.
  useEffect(() => {
    if (!editor) return
    try {
      const { tr } = editor.state
      tr.setMeta(SUGGESTION_PLUGIN_KEY, { suggestions })
      editor.view.dispatch(tr)
    } catch {
      // Editor may not be ready; decorations will be applied on next update.
    }
  }, [suggestions, editor])

  // ── WAVE-45: Comment-anchor highlighting + click-to-jump ──────────────────
  // Hydrate the comment list (used only to drive highlights; the CommentsPanel
  // maintains its own copy of the same CRDT store, so both stay in sync).
  const refreshCommentHighlights = useCallback(() => {
    if (!id) return
    try {
      const store = getCommentStore(id)
      setComments(store.list())
    } catch { /* store may not be ready */ }
  }, [id])

  useEffect(() => {
    if (!id) return
    api.listComments(id)
      .then((items) => {
        const store = getCommentStore(id)
        store.loadFromServer(items || [])
        setComments(store.list())
      })
      .catch(() => {}) // backend may be offline — highlights simply stay empty
  }, [id])

  // Refresh highlights while the panel is open (it mutates the same store) so
  // adding/resolving a comment updates the body highlight without a reload.
  useEffect(() => {
    if (!showComments) return
    const t = setInterval(refreshCommentHighlights, 800)
    return () => clearInterval(t)
  }, [showComments, refreshCommentHighlights])

  // Push the current comment list + active id into the decoration plugin.
  useEffect(() => {
    if (!editor) return
    try {
      const tr = editor.state.tr
      tr.setMeta(COMMENT_META, { comments, activeId: activeCommentId })
      editor.view.dispatch(tr)
    } catch { /* editor not ready */ }
  }, [comments, activeCommentId, editor])

  // Best-effort: after edits move highlights, persist the new [from,to] back
  // into the store so anchors survive reloads (and mark collapsed ones
  // orphaned). Debounced via the same save cadence.
  const remapTimer = useRef(null)
  useEffect(() => {
    if (!editor) return
    const onUpdate = () => {
      clearTimeout(remapTimer.current)
      remapTimer.current = setTimeout(() => {
        try {
          const pluginState = COMMENT_PLUGIN_KEY.getState(editor.state)
          if (!pluginState) return
          const store = getCommentStore(id)
          const mapped = readMappedRanges(pluginState.decorations, store.list())
          if (mapped.size > 0) store.remapAnchors(mapped)
        } catch { /* non-fatal */ }
      }, 500)
    }
    editor.on('update', onUpdate)
    return () => {
      editor.off('update', onUpdate)
      clearTimeout(remapTimer.current)
    }
  }, [editor, id])

  // Scroll to + flash a comment's anchor in the body (panel → doc jump).
  const jumpToComment = useCallback((commentId) => {
    if (!editor) return
    setActiveCommentId(commentId)
    try {
      const pluginState = COMMENT_PLUGIN_KEY.getState(editor.state)
      const decos = pluginState?.decorations
      const match = decos?.find()?.find(
        (d) => decorationCommentId(d) === commentId,
      )
      if (!match) return // orphaned / not in body — panel still highlights it
      // Move the selection to the anchor so screen readers + caret follow.
      editor.chain().setTextSelection({ from: match.from, to: match.to }).run()
      // Scroll the decorated span into view.
      const el = editor.view.dom.querySelector(`[data-comment-id="${commentId}"]`)
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      // Flash it.
      const trFlash = editor.state.tr
      trFlash.setMeta(COMMENT_META, { flash: commentId })
      editor.view.dispatch(trFlash)
      setTimeout(() => {
        try {
          const trClear = editor.state.tr
          trClear.setMeta(COMMENT_META, { clearFlash: commentId })
          editor.view.dispatch(trClear)
        } catch { /* editor gone */ }
      }, 1200)
    } catch { /* non-fatal */ }
  }, [editor])

  // Doc → panel jump: clicking a highlight opens the panel + focuses the comment.
  activateCommentRef.current = (commentId) => {
    setActiveCommentId(commentId)
    setShowComments(true)
  }

  // ── OFFICE-25: Live cursors ───────────────────────────────────────────────
  // Derive a stable local identity from sessionStorage (mirrors CRDT peerId approach).
  const localCursorIdentity = useRef(null)
  if (!localCursorIdentity.current) {
    try {
      const stored = localStorage.getItem('presence_identity')
      const parsed = stored ? JSON.parse(stored) : null
      localCursorIdentity.current = parsed && parsed.accountId ? parsed : {
        accountId: `guest:${sessionStorage.getItem('vulos_peer_id') || 'local'}`,
        displayName: 'Me',
      }
    } catch { localCursorIdentity.current = { accountId: 'local', displayName: 'Me' } }
  }
  // Expose fabric from collab session for cursor transport.
  const [fabricForCursors, setFabricForCursors] = useState(null)
  useEffect(() => {
    // collabRef.current is set inside the CRDT effect above; check after it runs.
    const check = () => setFabricForCursors(collabRef.current?.fabric ?? null)
    // Give the collab effect a tick to run first.
    const t = setTimeout(check, 100)
    return () => clearTimeout(t)
  }, [id])

  const { remoteCursors, broadcastDocCursor } = useLiveCursors({
    fabric: fabricForCursors,
    localIdentity: localCursorIdentity.current,
    color: localCursorIdentity.current
      ? (() => { let h=0; for(const c of localCursorIdentity.current.accountId){h=(h<<5)-h+c.charCodeAt(0);h|=0} return `hsl(${Math.abs(h)%360},65%,50%)` })()
      : '#6366f1',
  })
  // Presence roster (avatar bar + typing/active indicators). Reuses the SAME
  // fabric + local identity as the cursor layer, so Docs now shows who is in the
  // room — parity with Sheets/Slides — not just who is actively typing.
  const { roster } = usePresence({
    fabric: fabricForCursors,
    localIdentity: localCursorIdentity.current,
  })
  // Stable ref so the useEditor onSelectionUpdate closure can call the latest version.
  const broadcastDocCursorRef = useRef(null)
  broadcastDocCursorRef.current = broadcastDocCursor

  // ── Server-mediated presence (CLOUD path) ─────────────────────────────────
  // The p2p fabric above carries presence when a relay/peer is reachable. When
  // it is NOT (the fabric's degrade-to-local-only gap), presence would be empty
  // — so we ALSO ride the server collab session's presence relay, which is ACL-
  // gated + identity-stamped server-side. The two are merged: p2p wins when
  // present (E2E), the server fills the gap otherwise. This is what makes "who
  // is here" + live cursors work on the account/cloud path, not just p2p.
  const localColor = localCursorIdentity.current
    ? (() => { let h = 0; for (const c of localCursorIdentity.current.accountId) { h = (h << 5) - h + c.charCodeAt(0); h |= 0 } return `hsl(${Math.abs(h) % 360},65%,50%)` })()
    : '#6366f1'
  const broadcastServerCursorRef = useRef(null)
  broadcastServerCursorRef.current = (from, to) => {
    server.broadcastPresence?.({
      displayName: localCursorIdentity.current?.displayName || 'Me',
      color: localColor,
      cursor: { type: 'doc', from, to },
    })
  }

  // Merge p2p + server presence into a single remoteCursors Map + roster. p2p
  // entries take precedence (E2E/local-first); server entries fill peers the
  // fabric can't reach. Keyed by accountId so the same peer never double-counts.
  const mergedRemoteCursors = useMemo(() => {
    const merged = new Map(remoteCursors || [])
    for (const p of server.roster || []) {
      if (!p?.accountId || merged.has(p.accountId)) continue
      const cur = p.cursor || {}
      if (cur.type !== 'doc' || typeof cur.from !== 'number') continue
      merged.set(p.accountId, {
        accountId: p.accountId,
        displayName: p.displayName || 'Guest',
        color: p.color || '#6366f1',
        type: 'doc',
        from: cur.from,
        to: typeof cur.to === 'number' ? cur.to : cur.from,
      })
    }
    return merged
  }, [remoteCursors, server.roster])

  const mergedRoster = useMemo(() => {
    // Start from the p2p roster (already includes the local user); fold in any
    // server-only peers so the avatar bar reflects everyone on either transport.
    const byId = new Map()
    for (const r of roster || []) if (r?.accountId) byId.set(r.accountId, r)
    for (const p of server.roster || []) {
      if (!p?.accountId || byId.has(p.accountId)) continue
      byId.set(p.accountId, { accountId: p.accountId, displayName: p.displayName || 'Guest', color: p.color })
    }
    return [...byId.values()]
  }, [roster, server.roster])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setFindMode((m) => (m ? null : 'find'))
        return
      }
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        setFindMode((m) => (m === 'replace' ? null : 'replace'))
        return
      }
      if (e.key === 'p' || e.key === 'P') {
        // Ctrl+P / Cmd+P: print document (set title for the print dialog).
        e.preventDefault()
        const old = document.title
        document.title = titleRef.current || 'Document'
        window.print()
        document.title = old
        return
      }
      if (e.key === 'k' || e.key === 'K') {
        // Handled by TipTap shortcut, but ensure link popover is triggered
        // if editor has text selected — nothing to override here since TipTap's
        // Link extension binds Cmd+K by default.
        return
      }
      // WAVE-45: Cmd/Ctrl+Alt+M — keyboard affordance for comment highlights.
      // If the caret sits inside a commented span, focus that comment in the
      // panel (keyboard equivalent of clicking the highlight). Otherwise open
      // the panel so the user can add a comment on the current selection.
      if ((e.key === 'm' || e.key === 'M') && e.altKey) {
        e.preventDefault()
        const ed = editorRef.current
        if (ed) {
          const cid = commentIdAtSelection(ed)
          if (cid) { activateCommentRef.current?.(cid); return }
        }
        setShowComments(true)
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ── P1: real pagination — measure rendered page breaks (debounced) ─────────
  // Pagination is a VIEW concern: we measure the laid-out block heights against
  // the page-setup content height and compute break y-offsets. Nothing is written
  // to the document or synced over the CRDT (two peers can page differently with
  // zero divergence). Debounced off requestAnimationFrame so it never reflows on
  // every keystroke.
  const contentHeightPx = pageDimensions(pageSetup).contentHeightPx
  const contentHeightPxRef = useRef(contentHeightPx)
  contentHeightPxRef.current = contentHeightPx
  useEffect(() => {
    if (!editor) return
    const measure = () => {
      // Measure the ProseMirror element whose DIRECT children are the document
      // blocks. `.tiptap` is the EditorContent WRAPPER — its only child is the
      // `.ProseMirror` editor, so measuring it saw a single page-tall block and
      // never paginated (pageCount stuck at 1 for any multi-page doc). The real
      // blocks live one level deeper.
      const contentEl = scrollRef.current?.querySelector('.tiptap .ProseMirror')
        || scrollRef.current?.querySelector('.ProseMirror')
      if (!contentEl) return
      const { breaks, pageCount: pc } = measurePageBreaks(contentEl, contentHeightPxRef.current)
      setPageBreaks(breaks)
      setPageCount(pc)
    }
    const debounced = createDebouncedMeasure(measure, 250)
    editor.on('update', debounced)
    // Re-measure on window resize (block widths → heights change).
    window.addEventListener('resize', debounced)
    // Initial measurement after first paint.
    const t = setTimeout(() => debounced.flush(), 120)
    return () => {
      editor.off('update', debounced)
      window.removeEventListener('resize', debounced)
      debounced.cancel()
      clearTimeout(t)
    }
  }, [editor])

  // Re-measure when the page geometry changes (size/orientation/margins).
  useEffect(() => {
    const contentEl = scrollRef.current?.querySelector('.tiptap .ProseMirror')
      || scrollRef.current?.querySelector('.ProseMirror')
    if (!contentEl) return
    const { breaks, pageCount: pc } = measurePageBreaks(contentEl, contentHeightPx)
    setPageBreaks(breaks)
    setPageCount(pc)
  }, [contentHeightPx])

  // Keep page-setup / header-footer in refs so doSave (a stable callback) always
  // serialises the latest metadata without being re-created on every change.
  const pageSetupRef = useRef(pageSetup)
  pageSetupRef.current = pageSetup
  const headerFooterRef = useRef(headerFooter)
  headerFooterRef.current = headerFooter

  const doSave = useCallback(async (retryNum = 0) => {
    if (!editor || !id) return
    try {
      // P2/P3: persist page setup + headers/footers as sibling keys on the doc
      // content object. TipTap's setContent ignores unknown top-level keys, so
      // this round-trips cleanly (load reads them back via loadDocMeta).
      const content = {
        ...editor.getJSON(),
        pageSetup: pageSetupRef.current,
        headerFooter: headerFooterRef.current,
      }
      await saveFileWithDraft(id, titleRef.current, content)
      setRetryCount(0)
    } catch {
      // Schedule retry with backoff (up to 3 retries)
      if (retryNum < 3) {
        const delay = RETRY_DELAY_MS * (retryNum + 1)
        retryTimer.current = setTimeout(() => {
          setRetryCount(retryNum + 1)
          doSave(retryNum + 1)
        }, delay)
      }
    }
  }, [editor, id, saveFileWithDraft])

  const handleSave = () => {
    clearTimeout(saveTimer.current)
    clearTimeout(retryTimer.current)
    setRetryCount(0)
    doSave()
  }

  // ── P3: page setup ────────────────────────────────────────────────────────
  const applyPageSetup = useCallback((next) => {
    setPageSetup(normalizePageSetup(next))
    markDirty(id)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => doSave(), 800)
  }, [id, markDirty, doSave])

  // ── P2: headers & footers ─────────────────────────────────────────────────
  const applyHeaderFooter = useCallback((next) => {
    setHeaderFooter(normalizeHeaderFooter(next))
    markDirty(id)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => doSave(), 800)
  }, [id, markDirty, doSave])

  // ── P4: equations ─────────────────────────────────────────────────────────
  // Open the equation editor. When a math node is selected, edit it in place;
  // otherwise open a blank editor to insert a new one.
  const openEquationEditor = useCallback(() => {
    if (!editor) return
    if (editor.isActive('mathInline') || editor.isActive('mathBlock')) {
      const display = editor.isActive('mathBlock')
      const attrs = editor.getAttributes(display ? 'mathBlock' : 'mathInline')
      setEquationEditor({ latex: attrs.latex || '', display, editing: true })
    } else {
      setEquationEditor({ latex: '', display: false, editing: false })
    }
  }, [editor])

  const submitEquation = useCallback(({ latex, display }) => {
    if (!editor) return
    const editing = equationEditor?.editing
    if (editing) {
      // Update the selected node. If the display mode flipped, replace the node
      // type; otherwise just update the latex attr.
      const wasBlock = editor.isActive('mathBlock')
      if (wasBlock === display) {
        editor.chain().focus().updateAttributes(display ? 'mathBlock' : 'mathInline', { latex }).run()
      } else {
        editor.chain().focus().deleteSelection().run()
        if (display) editor.chain().focus().insertMathBlock(latex).run()
        else editor.chain().focus().insertMathInline(latex).run()
      }
    } else if (display) {
      editor.chain().focus().insertMathBlock(latex).run()
    } else {
      editor.chain().focus().insertMathInline(latex).run()
    }
    setEquationEditor(null)
  }, [editor, equationEditor])

  const handleTitleChange = (newTitle) => {
    setTitle(newTitle)
    markDirty(id)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => doSave(), 1500)
  }

  const handleRestoreDraft = () => {
    if (!draft || !editor) return
    editor.commands.setContent(resolveContent(draft.content), false)
    if (draft.name) setTitle(draft.name)
    setDraft(null)
    markDirty(id)
  }

  const handleDiscardDraft = () => {
    clearDraft(id)
    setDraft(null)
  }

  const wordCount = editor?.storage.characterCount?.words() ?? 0
  const charCount = editor?.storage.characterCount?.characters() ?? 0

  // P1/P3: concrete page geometry for the paper card + break overlay.
  const geo = pageDimensions(pageSetup)
  // P2: the header/footer bands for page 1 (the page visible in-editor). Full
  // per-page resolution happens in export/print (docsExport paginate*).
  const firstPageBands = bandsForPage(headerFooter, 1, { title, pages: pageCount })

  // Discreet save status — a meta-line, never a banner. Rendered via the shared
  // <SaveStatus> (a breathing dot + quiet label). We only compute the retry text
  // override here; the component owns the crafted visual + a11y announcement.
  const saveStatusText =
    saveStatus.status === 'error' && retryCount > 0 ? `Retrying ${retryCount}/3` : undefined

  if (!editor) {
    // Paper-shaped skeleton (not a bare spinner) so the open feels like a
    // document settling in, using the shared shimmer.
    return (
      <div className="flex-1 overflow-hidden bg-bg" role="status" aria-label="Opening document…">
        <div className="mx-auto my-8 w-full max-w-3xl px-10 py-12 bg-paper border border-line rounded-md shadow-e1">
          <Skeleton className="h-8 w-2/3 mb-6" />
          <LoadingState.Lines count={3} className="mb-6" />
          <LoadingState.Lines count={4} className="mb-6" />
          <LoadingState.Lines count={3} />
        </div>
      </div>
    )
  }

  const peerCount = Object.values(collabPeers)
    .filter((s) => s === 'connected' || s === 'relay').length
  // Live collaborators (from the merged p2p + server cursor layer) → avatar stack.
  const collaborators = Array.from(mergedRemoteCursors?.values?.() || [])
    .filter((p) => p && p.accountId)
    .map((p) => ({ id: p.accountId, name: p.displayName || 'Guest', color: p.color }))
  const pendingSuggestions = suggestions.filter((s) => s.state === 'pending').length

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg">
      {/* Draft-restore banner — only banner we keep, because it requires action */}
      {draft && (
        <div className="flex items-center gap-3 px-4 py-2 bg-warning-bg border-b border-line text-xs text-warning animate-fade-in">
          <AlertCircle size={14} className="flex-shrink-0" />
          <span className="flex-1 text-ink-muted">
            Unsaved changes from a previous session were found.
          </span>
          <Button variant="primary" size="sm" onClick={handleRestoreDraft}>Restore</Button>
          <Button variant="secondary" size="sm" onClick={handleDiscardDraft}>Discard</Button>
        </div>
      )}

      {/*
        Save errors are reported in the meta-line of the topbar (statusInfo);
        we deliberately do NOT show a big red banner — that's a Mercury-style
        restraint: errors stay surfaced, never alarming, with action via Save.
      */}

      {/* Top bar — composed from the design system */}
      <Topbar
        leading={
          <Tooltip label="Back to Docs">
            <IconButton size="sm" onClick={() => navigate('/docs')}>
              <ArrowLeft size={15} />
            </IconButton>
          </Tooltip>
        }
        title={
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Untitled document"
            className={[
              'flex-1 min-w-0 text-sm font-semibold tracking-tightish',
              'bg-transparent border border-transparent rounded-sm px-2 py-1',
              'text-ink placeholder:text-ink-faint',
              'hover:border-line focus:border-line-strong focus:bg-paper',
              'transition-[border-color,background] duration-fast ease-out outline-none',
            ].join(' ')}
          />
        }
        meta={
          <>
            {saveStatus.status && (
              <SaveStatus
                status={saveStatus.status}
                text={saveStatusText}
                title={saveStatus.error || undefined}
              />
            )}
            {/* Presence roster — avatar bar of everyone in the room (parity with
                Sheets/Slides). Shows the full roster; a subtle "editing now" cue
                still comes from the live cursor layer. Falls back to a peer-count
                pill or a cursor-derived avatar stack when the roster is empty. */}
            {mergedRoster && mergedRoster.length > 1 ? (
              <PresenceBar roster={mergedRoster} className="ml-1" />
            ) : collaborators.length > 0 ? (
              <Tooltip label={`${collaborators.length} editing now`}>
                <AvatarStack people={collaborators} size={22} max={4} />
              </Tooltip>
            ) : peerCount > 0 && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-accent-tint text-accent-press"
                title={`${peerCount} peer(s) connected`}
              >
                <Users size={11} />
                {peerCount}
              </span>
            )}
            {/* Typing/active indicator: someone has a live cursor in the doc. */}
            {mergedRoster && mergedRoster.length > 1 && collaborators.length > 0 && (
              <span className="text-2xs text-ink-faint italic" title={`${collaborators.length} actively editing`}>
                {collaborators.length === 1 ? 'editing…' : `${collaborators.length} editing…`}
              </span>
            )}
            {/* WAVE-25: P2P collaboration status */}
            {p2p.active && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-accent-tint text-accent-press"
                title={`Peer-to-peer collaboration (${p2p.peerCount} peer(s), end-to-end encrypted)`}
              >
                <Users size={11} />
                {p2p.peerCount} · P2P
              </span>
            )}
            {p2p.readOnly && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-pill bg-bg-elev2 text-ink-muted border border-line"
                title="You joined with a view-only link — you can read live edits but not change the document."
              >
                <Eye size={11} />
                View only
              </span>
            )}
          </>
        }
        actions={
          <>
            <Tooltip label="Document outline">
              <IconButton size="sm" active={showOutline} onClick={() => setShowOutline((v) => !v)}>
                <ListTree size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Find (Cmd+F)">
              <IconButton size="sm" active={!!findMode} onClick={() => setFindMode((m) => (m ? null : 'find'))}>
                <Search size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Version history">
              <IconButton size="sm" active={showHistory} onClick={() => setShowHistory((v) => !v)}>
                <History size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Activity">
              <IconButton size="sm" active={showActivity} onClick={() => setShowActivity((v) => !v)}>
                <Activity size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label="Comments">
              <IconButton size="sm" active={showComments} onClick={() => setShowComments((v) => !v)}>
                <MessageSquare size={14} />
              </IconButton>
            </Tooltip>
            <Tooltip label={suggestionMode ? 'Exit suggestion mode' : 'Suggestion mode (track changes)'}>
              <button
                onClick={handleToggleSuggestionMode}
                className={[
                  'inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium',
                  'tracking-tightish transition-colors duration-fast ease-out',
                  suggestionMode
                    ? 'bg-success-bg text-success border border-success'
                    : 'text-ink-muted hover:bg-accent-tint hover:text-ink',
                ].join(' ')}
              >
                <GitBranch size={13} />
                {suggestionMode ? 'Suggesting' : 'Suggest'}
              </button>
            </Tooltip>
            {!suggestionMode && pendingSuggestions > 0 && (
              <Tooltip label={`${pendingSuggestions} pending suggestion${pendingSuggestions === 1 ? '' : 's'}`}>
                <IconButton size="sm" active={showSuggestions} onClick={() => setShowSuggestions((v) => !v)}>
                  <GitBranch size={14} />
                </IconButton>
              </Tooltip>
            )}
            {/* Share entry point. Opens account-based sharing (named users,
                role-scoped, ACL-enforced) which also offers the complementary
                P2P end-to-end-encrypted link path. Hidden for ro peers who
                joined via a view-only link (they cannot re-share). */}
            {!p2p.readOnly && (
              <Tooltip label="Share — with people (accounts) or via an E2E link">
                <IconButton
                  size="sm"
                  active={showAccountShare || showP2PShare}
                  onClick={() => setShowAccountShare(true)}
                >
                  <Share2 size={14} />
                </IconButton>
              </Tooltip>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={saveStatus.status === 'saving'}
            >
              {saveStatus.status === 'saving'
                ? <Loader2 size={13} className="animate-spin" />
                : <Save size={13} />}
              Save
            </Button>
          </>
        }
      />

      {/* Suggestion-mode hint strip — quiet, not alarming */}
      {suggestionMode && (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-success-bg border-b border-line text-xs text-success animate-fade-in">
          <GitBranch size={12} className="flex-shrink-0" />
          <span className="flex-1 text-ink-muted tracking-tightish">
            Suggestion mode — edits are recorded as proposals.
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShowSuggestions((v) => !v)}>
            {showSuggestions ? 'Hide' : 'Review'}
          </Button>
        </div>
      )}

      <DocsToolbar
        editor={editor}
        title={title}
        pageSetup={pageSetup}
        headerFooter={headerFooter}
        onInsertEquation={openEquationEditor}
        onPageSetup={() => setShowPageSetup(true)}
        onHeaderFooter={() => setShowHeaderFooter(true)}
        spellcheck={spellcheck}
        onToggleSpellcheck={() => setSpellcheck((v) => !v)}
      />

      {/* Editor canvas + side panels */}
      <div className="flex-1 flex overflow-hidden bg-bg">
        {/* Document outline rail (navigable, live) */}
        {showOutline && (
          <DocumentOutline
            editor={editor}
            scrollContainerRef={scrollRef}
            onClose={() => setShowOutline(false)}
          />
        )}
        {/*
          Page canvas — the document feels like paper:
            - warm paper background under a measured (~720px) writing column
            - generous side margins and vertical padding
            - subtle 1-px line on the page edge, no heavy shadow
            - .paper-grain adds a near-imperceptible letterpress tooth
        */}
        <div ref={scrollRef} className="doc-desk flex-1 overflow-auto px-6 py-10 relative">
          {/* Find/Replace floating bar */}
          {findMode && (
            <FindReplace
              editor={editor}
              mode={findMode}
              onClose={() => setFindMode(null)}
            />
          )}
          {/*
            P1/P3: the paper card's width now derives from the page-setup
            geometry (Letter/A4/Legal, portrait/landscape) rather than a fixed
            760px, and horizontal padding tracks the configured L/R margins so
            the writing column matches the real page. Page BREAKS are drawn as an
            absolutely-positioned overlay inside the article (a view concern —
            the document has no page-break nodes). Header/footer bands (P2) sit
            in the top/bottom margins of the first rendered page.
          */}
          <article
            className="doc-pages paper-grain mx-auto bg-paper border border-line rounded-lg shadow-e2 relative"
            style={{
              maxWidth: `${geo.pageWidthPx}px`,
              paddingLeft: `${geo.marginLeftPx}px`,
              paddingRight: `${geo.marginRightPx}px`,
              paddingTop: `${geo.marginTopPx}px`,
              paddingBottom: `${geo.marginBottomPx}px`,
              '--page-pad-x': `${geo.marginLeftPx}px`,
            }}
          >
            {/* P2: first-page header/footer bands (rendered inside the margins).
                Full per-page bands are drawn in export/print; in-editor we show
                the page-1 band as an at-a-glance affordance. */}
            {firstPageBands && (firstPageBands.header.left || firstPageBands.header.center || firstPageBands.header.right) && (
              <div className="doc-hf-band" style={{ top: `${Math.max(8, geo.marginTopPx / 2 - 6)}px` }} aria-hidden="true">
                <span>{firstPageBands.header.left}</span>
                <span className="hf-center">{firstPageBands.header.center}</span>
                <span className="hf-right">{firstPageBands.header.right}</span>
              </div>
            )}
            <div className="tiptap-cursor-host relative animate-fade-in">
              <EditorContent editor={editor} className="tiptap" />
              <DocsCursorLayer editor={editor} remoteCursors={mergedRemoteCursors} />
              {/* P1: rendered page-break separators. Positioned by measured
                  y-offsets; purely visual, never part of the document. */}
              {pageBreaks.map((y, i) => (
                <div
                  key={`${y}-${i}`}
                  className="doc-page-break"
                  style={{ top: `${y}px`, '--page-gap': '40px', '--page-pad-x': `${geo.marginLeftPx}px` }}
                >
                  <span className="doc-page-num">page {i + 2}</span>
                </div>
              ))}
            </div>
            {firstPageBands && (firstPageBands.footer.left || firstPageBands.footer.center || firstPageBands.footer.right) && (
              <div className="doc-hf-band" style={{ bottom: `${Math.max(8, geo.marginBottomPx / 2 - 6)}px` }} aria-hidden="true">
                <span>{firstPageBands.footer.left}</span>
                <span className="hf-center">{firstPageBands.footer.center}</span>
                <span className="hf-right">{firstPageBands.footer.right}</span>
              </div>
            )}
          </article>
        </div>

        {/* History panel (OFFICE-08) */}
        {showHistory && (
          <HistoryPanel
            fileId={id}
            onClose={() => setShowHistory(false)}
            onRestore={(updated) => {
              if (editor && updated?.content) {
                editor.commands.setContent(resolveContent(updated.content), false)
              }
              if (updated?.name) setTitle(updated.name)
            }}
          />
        )}

        {/* Activity feed + named snapshots (OFFICE-28) */}
        {showActivity && (
          <ActivityFeed
            fileId={id}
            onClose={() => setShowActivity(false)}
            onRestore={(updated) => {
              if (editor && updated?.content) {
                editor.commands.setContent(resolveContent(updated.content), false)
              }
              if (updated?.name) setTitle(updated.name)
            }}
          />
        )}

        {/* Comments panel (OFFICE-26) */}
        {showComments && (
          <CommentsPanel
            fileId={id}
            activeCommentId={activeCommentId}
            onJump={jumpToComment}
            onChange={refreshCommentHighlights}
            anchorCtx={editor?.state?.selection
              ? {
                  type: 'text_range',
                  from: editor.state.selection.from,
                  to: editor.state.selection.to,
                  snapshot: editor.state.doc.textBetween(
                    editor.state.selection.from,
                    editor.state.selection.to,
                    ' '
                  ).slice(0, 80),
                }
              : null
            }
            onClose={() => setShowComments(false)}
          />
        )}

        {/* Suggestion panel (OFFICE-27) */}
        {showSuggestions && (
          <SuggestionPanel
            fileId={id}
            suggestions={suggestions}
            onAccept={handleAcceptSuggestion}
            onReject={handleRejectSuggestion}
            onClose={() => setShowSuggestions(false)}
          />
        )}
      </div>

      <footer className="status-bar justify-end">
        {p2p.readOnly && (
          <span className="status-item text-ink-faint mr-auto">
            <Eye size={11} aria-hidden /> View only
          </span>
        )}
        <button
          onClick={() => setShowWordCount(true)}
          title="Word count details"
          className="status-item"
          aria-label="Open word count details"
        >
          <span>{wordCount} words</span>
          <span className="opacity-40">·</span>
          <span>{pageCount} {pageCount === 1 ? 'page' : 'pages'}</span>
          <span className="opacity-40">·</span>
          <span>{charCount} characters</span>
        </button>
      </footer>

      {/* Word count detail modal */}
      {showWordCount && (
        <WordCountModal editor={editor} onClose={() => setShowWordCount(false)} />
      )}

      {/* Account-based sharing (named users, role-scoped, ACL-enforced) — the
          primary Share dialog; offers the P2P E2E link path alongside. */}
      <AccountShareModal
        open={showAccountShare}
        onClose={() => setShowAccountShare(false)}
        file={{ id, name: title }}
        me={myAccountId}
        onSwitchToLink={async () => {
          setShowP2PShare(true)
          try { if (!p2p.links) await p2p.startShare() } catch { /* surfaced in modal */ }
        }}
      />

      {/* WAVE-25: P2P collaborate-via-link modal */}
      <P2PShareModal
        open={showP2PShare}
        onClose={() => setShowP2PShare(false)}
        links={p2p.links}
        roomId={p2p.roomId}
        onRotate={() => p2p.rotate()}
      />

      {/* P4: equation editor (LaTeX input + live KaTeX preview) */}
      {equationEditor && (
        <EquationEditor
          open
          initialLatex={equationEditor.latex}
          initialDisplay={equationEditor.display}
          onSubmit={submitEquation}
          onClose={() => setEquationEditor(null)}
        />
      )}

      {/* P3: page setup (size / orientation / margins) */}
      <PageSetupDialog
        open={showPageSetup}
        value={pageSetup}
        onApply={applyPageSetup}
        onClose={() => setShowPageSetup(false)}
      />

      {/* P2: headers & footers */}
      <HeaderFooterDialog
        open={showHeaderFooter}
        value={headerFooter}
        onApply={applyHeaderFooter}
        onClose={() => setShowHeaderFooter(false)}
      />
    </div>
  )
}
