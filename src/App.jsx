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
import CalendarApp from './apps/calendar/CalendarApp'
import ContactsApp from './apps/contacts/ContactsApp'

// Chat + huddles ("Spaces"/Talk) is now the standalone Vulos Talk product.
// seam-C handoff: chat/meeting deep-links redirect to the Talk app instead of
// being served in-process. See backend/seam for the integration contract.
const TALK_URL = import.meta.env.VITE_TALK_URL || 'https://talk.vulos.org'

// Public routes that bypass Vulos auth entirely.
// External signers and external verifiers have no Vulos account.
const PUBLIC_PREFIXES = ['/sign/', '/verify']

function isPublicRoute(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
}

export default function App() {
  const { status, loading, fetchStatus } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => { fetchStatus() }, [])

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

  // seam-C handoff: chat/huddle deep-links live in the Talk product now.
  // Redirect the browser there (carrying the sub-path) rather than 404-ing.
  if (/^\/(spaces|meetings|room)(\/|$)/.test(location.pathname)) {
    window.location.href = TALK_URL + location.pathname + location.search
    return null
  }

  // Render public routes immediately — no auth check, no Layout shell.
  if (isPublicRoute(location.pathname)) {
    return (
      <Routes>
        <Route path="/sign/:token" element={<SignView />} />
        <Route path="/verify" element={<Verify />} />
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
        <Route path="/calendar" element={<CalendarApp />} />
        <Route path="/contacts" element={<ContactsApp />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
