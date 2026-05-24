/**
 * src/entries/talk.jsx — entry point for talk.vulos.org (dist-talk/)
 *
 * Mounts TalkShell with BrowserRouter for history-API deep linking.
 * The backend must serve index.html for all unmatched paths (SPA fallback).
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import TalkShell from '../shells/TalkShell.jsx'
import '../index.css'
// RELAY-CLIENT-02: configure relay-client seams BEFORE bootstrap touches LS.
import { configure } from '@vulos/relay-client/endpoints'
configure({ lsKeyPrefix: 'vulos.office.endpoints.v1', healthPath: '/api/auth/status' })
import { bootstrapOffline } from '@vulos/relay-client/offlineBootstrap'

bootstrapOffline()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <TalkShell />
    </BrowserRouter>
  </StrictMode>
)
