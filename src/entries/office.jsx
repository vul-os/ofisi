/**
 * src/entries/office.jsx — entry point for office.vulos.org (dist-office/)
 *
 * Mounts OfficeShell with BrowserRouter for history-API deep linking.
 * The backend must serve index.html for all unmatched paths (SPA fallback).
 * On Fly: configure the fly.toml `[[http_service]]` block with force_https,
 * returning index.html for unmatched routes (see DEPLOY.md for the fly.toml snippet).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import OfficeShell from '../shells/OfficeShell.jsx'
import '../index.css'
// RELAY-CLIENT-02: configure relay-client seams BEFORE bootstrap touches LS.
import { configure } from '@vulos/relay-client/endpoints'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
// PWA: register the app-shell service worker (+ prime cloud↔LAN failover +
// update detection) via the guarded PWA helper. No-op in dev, when embedded in
// the OS hub, or on unsupported browsers — see src/lib/pwa.js.
import { registerServiceWorker } from '../lib/pwa.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <OfficeShell />
    </BrowserRouter>
  </StrictMode>
)

registerServiceWorker()
