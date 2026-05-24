/**
 * src/entries/meet.jsx — entry point for meet.vulos.org (dist-meet/)
 *
 * Mounts MeetShell with BrowserRouter for history-API deep linking.
 * The backend must serve index.html for all unmatched paths (SPA fallback).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import MeetShell from '../shells/MeetShell.jsx'
import '../index.css'
// RELAY-CLIENT-02: configure relay-client seams BEFORE bootstrap touches LS.
import { configure } from '@vulos/relay-client/endpoints'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
import { bootstrapOffline } from '@vulos/relay-client/offlineBootstrap'

bootstrapOffline()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <MeetShell />
    </BrowserRouter>
  </StrictMode>
)
