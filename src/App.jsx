import { useEffect } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import LoginScreen from './components/LoginScreen'
import Layout from './components/Layout'
import { LoadingState } from './components/ui'
import Home from './components/Home'
import AppHome from './components/AppHome'
import DocsEditor from './apps/docs/DocsEditor'
import SheetsEditor from './apps/sheets/SheetsEditor'
import SlidesEditor from './apps/slides/SlidesEditor'
import PDFEditor from './apps/pdf/PDFEditor'
import SigningSetup from './apps/pdf/SigningSetup'
import Settings from './components/Settings'
import SignView from './apps/pdf/SignView'
import EnvelopeDashboard from './components/EnvelopeDashboard'
import Verify from './components/Verify'
import AnonDocView from './components/AnonDocView'

// Chat + huddles ("Spaces"/Talk) is now the standalone Vulos Talk product, and
// Calendar + Contacts moved to the Vulos Mail/PIM product. seam-C handoff:
// those deep-links redirect to the owning app instead of being served in-process.
// See backend/seam for the integration contract.
// Cross-product handoff targets — set per deployment (VITE_*_URL). Empty (the
// default) means that product isn't wired here, so its deep-links 404 locally
// instead of bouncing to the public cloud. Keeps standalone/self-host Office
// self-contained; operators who run the sibling products opt in via env.
const TALK_URL = import.meta.env.VITE_TALK_URL || ''
const MEET_URL = import.meta.env.VITE_MEET_URL || ''
const MAIL_URL = import.meta.env.VITE_MAIL_URL || ''

// Public routes that bypass Vulos auth entirely.
// External signers and external verifiers have no Vulos account; anonymous
// share-link viewers ("/view/:token") are gated only by the unguessable token.
const PUBLIC_PREFIXES = ['/sign/', '/verify', '/view/']

function isPublicRoute(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

export default function App() {
  const { status, loading, fetchStatus, fetchIdentity } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => { fetchStatus() }, [])
  // Resolve "who am I" for share/ownership UI (best-effort, independent of auth
  // gating). Re-runs when the authenticated status flips (e.g. after login).
  useEffect(() => {
    if (status?.authenticated !== false) fetchIdentity()
  }, [status?.authenticated])

  // ── Protocol handler + deep-link ?goto= param ─────────────────────────────
  useEffect(() => {
    // Register vulos-office:// protocol handler (web+ prefix required by browsers)
    try {
      navigator.registerProtocolHandler('web+vulosoffice', window.location.origin + '/?goto=%s', 'Vulos Office')
    } catch { /* unsupported browser */ }

    // Handle incoming deep-link ?goto= param
    // e.g. OS rewrites web+vulosoffice://docs/abc123 → https://app.vulos.org/?goto=docs%2Fabc123
    const params = new URLSearchParams(window.location.search)
    const goto = params.get('goto')
    if (goto) {
      const clean = goto.replace(/^\/+/, '')
      window.history.replaceState({}, '', window.location.pathname) // remove ?goto from URL
      if (clean) navigate('/' + clean, { replace: true })
    }
  }, []) // eslint-disable-line

  // seam-C handoff: chat/Spaces deep-links live in the Talk product, and
  // meeting/call deep-links in the Meet product. Redirect the browser there
  // (carrying the sub-path) rather than 404-ing on a route Office no longer owns.
  if (TALK_URL && /^\/spaces(\/|$)/.test(location.pathname)) {
    window.location.href = TALK_URL + location.pathname + location.search
    return null
  }
  if (MEET_URL && /^\/(meetings|room)(\/|$)/.test(location.pathname)) {
    window.location.href = MEET_URL + location.pathname + location.search
    return null
  }
  // seam-C handoff: Calendar + Contacts are now the Vulos Mail/PIM product.
  // Redirect their deep-links (carrying the sub-path) to the Mail surface.
  if (MAIL_URL && /^\/(calendar|contacts)(\/|$)/.test(location.pathname)) {
    window.location.href = MAIL_URL + location.pathname + location.search
    return null
  }

  // Render public routes immediately — no auth check, no Layout shell.
  if (isPublicRoute(location.pathname)) {
    return (
      <Routes>
        <Route path="/sign/:token" element={<SignView />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/view/:token" element={<AnonDocView />} />
      </Routes>
    )
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg">
        <LoadingState label="Loading Vulos Office…" />
      </div>
    )
  }

  if (status?.enabled && !status?.authenticated) {
    return <LoginScreen />
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/docs" element={<AppHome type="doc" />} />
        <Route path="/sheets" element={<AppHome type="sheet" />} />
        <Route path="/slides" element={<AppHome type="slide" />} />
        <Route path="/docs/:id" element={<DocsEditor />} />
        <Route path="/sheets/:id" element={<SheetsEditor />} />
        <Route path="/slides/:id" element={<SlidesEditor />} />
        <Route path="/pdf" element={<AppHome type="pdf" />} />
        <Route path="/pdf-editor" element={<PDFEditor />} />
        <Route path="/signing-setup" element={<SigningSetup />} />
        <Route path="/envelopes" element={<EnvelopeDashboard />} />
        <Route path="/pdf/:id" element={<PDFEditor />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
