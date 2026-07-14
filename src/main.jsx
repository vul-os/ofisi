import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
// RELAY-CLIENT-02: relay-client shared package, with office-specific seams.
// configure() MUST run before any other relay-client import touches localStorage
// so existing user state under 'vulos.office.endpoints.v1' survives the
// migration (do NOT change the key — that would wipe office users' cached
// endpoints).
import { configure } from '@vulos/relay-client/endpoints'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
// OFFICE-11: import/export fidelity round-trip checks (self-executes in dev mode).
// Loaded lazily so it stays OUT of the production graph: the checker imports
// `xlsx`, which @vulos/relay-client declares only as an (uninstalled) optional
// peer. Rollup tolerated that; Vite 8's rolldown resolves the bare import from
// the relay-client package, fails, and emits a module that throws on load — which
// blanked the entire app. Dev-only means production never pulls that edge.
if (import.meta.env.DEV) {
  import('@vulos/relay-client/roundTripCheck')
}
// OFFICE-OFFLINE-01: register SW for app-shell caching + prime cloud↔LAN failover.
import { bootstrapOffline } from '@vulos/relay-client/offlineBootstrap'

bootstrapOffline()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
