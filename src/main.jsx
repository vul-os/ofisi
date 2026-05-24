import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
// OFFICE-11: import/export fidelity round-trip checks (self-executes in dev mode)
import './lib/roundTripCheck.js'
// OFFICE-OFFLINE-01: register SW for app-shell caching + prime cloud↔LAN failover.
import { bootstrapOffline } from './lib/offlineBootstrap.js'

bootstrapOffline()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
