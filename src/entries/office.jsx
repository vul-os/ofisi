/**
 * src/entries/office.jsx — entry point for office.vulos.org (dist-office/)
 *
 * Mounts OfficeShell with BrowserRouter for history-API deep linking.
 * The backend must serve index.html for all unmatched paths (SPA fallback).
 * On fly.io: configure [[http_service]] with force_https = true and the
 * app's 404 handler returning index.html (see DEPLOY.md TODO).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import OfficeShell from '../shells/OfficeShell.jsx'
import '../index.css'
// RELAY-CLIENT-02: configure relay-client seams BEFORE bootstrap touches LS.
import { configure } from '@vulos/relay-client/endpoints'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
import { bootstrapOffline } from '@vulos/relay-client/offlineBootstrap'

bootstrapOffline()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <OfficeShell />
    </BrowserRouter>
  </StrictMode>
)
