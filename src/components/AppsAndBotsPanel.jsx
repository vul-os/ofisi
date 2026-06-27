/**
 * AppsAndBotsPanel — Office's "Apps & Bots" manage surface.
 *
 * A thin wrapper around the shared <AppsAndBots/> component from
 * @vulos/apps-ui, configured for THIS product (mode="product", product="office").
 * It is the same surface every Vulos product hosts and that Vulos Workspace
 * aggregates; here it lists/installs/manages the apps & bots that target Office.
 *
 * Auth: Office sessions live in an HttpOnly cookie (no JS-readable token), so we
 * inject a `fetcher` that sends credentials. The platform's management API
 * accepts Office's session via that cookie (middleware.SessionIdentity), so no
 * bearer token is passed. Requests go to {currentEndpoint()}/api/apps, routed
 * through the same endpoint-failover base the rest of the app uses.
 */

import AppsAndBots from '@vulos/apps-ui'
import '@vulos/apps-ui/styles.css'
import { currentEndpoint } from '@vulos/relay-client/endpoints'
import { useTheme } from './ui/useTheme'

// Send the HttpOnly session cookie on every management call (apps-ui defaults to
// a token-only client; Office authenticates the management API by session).
const cookieFetcher = (input, init = {}) =>
  fetch(input, { ...init, credentials: 'include' })

export default function AppsAndBotsPanel() {
  const { theme } = useTheme()
  // apps-ui understands 'dark' | 'light'; map Office's 'system' to the resolved
  // class on <html> so the embedded surface matches the shell.
  const resolved =
    theme === 'light' || theme === 'dark'
      ? theme
      : (typeof document !== 'undefined' &&
          document.documentElement.classList.contains('dark'))
        ? 'dark'
        : 'light'

  return (
    <AppsAndBots
      mode="product"
      product="office"
      baseUrl={currentEndpoint()}
      basePath="/api/apps"
      fetcher={cookieFetcher}
      theme={resolved}
      title="Apps & Bots"
      subtitle="Install and manage the apps & bots that automate your documents."
    />
  )
}
