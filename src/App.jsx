import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
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
import SpacesApp from './apps/spaces/SpacesApp'
import Meetings from './apps/spaces/Meetings'
import Room from './apps/spaces/Room'
import Verify from './components/Verify'
import CalendarApp from './apps/calendar/CalendarApp'
import ContactsApp from './apps/contacts/ContactsApp'

// Public routes that bypass Vulos auth entirely.
// External signers, external meeting invitees, and external verifiers have no Vulos account.
const PUBLIC_PREFIXES = ['/sign/', '/room/', '/verify', '/meet/']

// ── MeetJoin — resolve a meeting ID to a session room ────────────────────────
function MeetJoin() {
  const { meetId } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    fetch(`/api/meetings/${meetId}/join`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : r.json().then(b => Promise.reject(new Error(b.error || `HTTP ${r.status}`))))
      .then(data => navigate(`/room/${encodeURIComponent(data.session_id)}`, { replace: true }))
      .catch(e => setError(e.message))
  }, [meetId]) // eslint-disable-line

  if (error) return (
    <div className="h-screen flex items-center justify-center bg-bg">
      <div className="text-center">
        <p className="text-danger mb-3 text-sm">{error}</p>
        <button onClick={() => navigate('/meetings')} className="px-4 h-8 rounded-md bg-accent text-white text-sm">Back to meetings</button>
      </div>
    </div>
  )
  return (
    <div className="h-screen flex items-center justify-center bg-bg">
      <LoadingState label="Joining meeting…" />
    </div>
  )
}

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

  // Render public routes immediately — no auth check, no Layout shell.
  if (isPublicRoute(location.pathname)) {
    return (
      <Routes>
        <Route path="/sign/:token" element={<SignView />} />
        <Route path="/room/:sessionId" element={<Room />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/meet/:meetId" element={<MeetJoin />} />
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
        <Route path="/spaces" element={<SpacesApp />} />
        <Route path="/spaces/:channelId" element={<SpacesApp />} />
        <Route path="/meetings" element={<Meetings />} />
        <Route path="/room/:sessionId" element={<Room />} />
        <Route path="/meet/:meetId" element={<MeetJoin />} />
        <Route path="/pdf/:id" element={<PDFEditor />} />
        <Route path="/calendar" element={<CalendarApp />} />
        <Route path="/contacts" element={<ContactsApp />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
