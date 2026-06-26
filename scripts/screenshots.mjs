#!/usr/bin/env node
/**
 * Vulos Office — Playwright screenshotter
 *
 * Captures every major app surface at 1440×900 into docs/screenshots/.
 *
 * Default (local) mode:
 *   1. Writes static seed files to /tmp/vulos-demo-data
 *   2. Builds the Go binary (which embeds the compiled frontend via //go:embed)
 *   3. Starts it on port 8083 pointed at the demo data dir
 *   4. Calls the seed REST API for Calendar / Contacts
 *   5. Captures all screenshots
 *   6. Stops the server
 *
 * Usage:
 *   npm run screenshots
 *   BASE_URL=https://office.example.com npm run screenshots
 *   BASE_URL=https://office.example.com npm run screenshots -- --seed
 *
 * Prerequisites:
 *   npm install && npm run build     (builds the frontend into dist/)
 *   npx playwright install chromium
 */

import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'

import { seedStaticFiles, seedViaAPI, DEMO_DATA_DIR } from './seed-demo.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT       = path.resolve(__dirname, '..')
const OUT        = path.join(ROOT, 'docs', 'screenshots')

const EXTERNAL_URL = process.env.BASE_URL
const FORCE_SEED   = process.argv.includes('--seed')

// Use port 8083 so we don't collide with a running dev server on :8080/:8082
const LOCAL_PORT   = 8083
const LOCAL_BASE   = `http://localhost:${LOCAL_PORT}`

const SCREENSHOT_BASE = EXTERNAL_URL ?? LOCAL_BASE
const API_SEED_BASE   = EXTERNAL_URL ?? LOCAL_BASE

// ── Routes to capture ─────────────────────────────────────────────────────────
const ROUTES = [
  { name: 'hero',          path: '/',               description: 'Home (hero shot)' },
  { name: 'home',          path: '/',               description: 'Home / file list' },
  {
    name: 'docs-editor',
    path: '/docs/demo',
    description: 'Documents editor — Q2 Product Update',
    waitFor: '.ProseMirror, [data-testid="docs-editor"], .tiptap',
  },
  {
    name: 'sheets-editor',
    path: '/sheets/demo-sheet',
    description: 'Spreadsheets editor — Revenue Tracker',
    waitFor: '.fortune-sheet-container, [data-testid="sheets-editor"], canvas',
  },
  {
    name: 'slides-editor',
    path: '/slides/demo-slides',
    description: 'Presentations editor — Product Overview',
    waitFor: '.reveal, [data-testid="slides-editor"]',
  },
  {
    name: 'pdf-editor',
    path: '/pdf/demo',
    description: 'PDF viewer / annotator',
    waitFor: '[data-testid="pdf-editor"], .pdf-viewer, canvas',
  },
  {
    name: 'calendar',
    path: '/calendar',
    description: 'Calendar — weekly view with events',
    waitFor: '[data-testid="calendar-app"], .calendar-grid, [class*="calendar"], .fc',
  },
  {
    name: 'contacts',
    path: '/contacts',
    description: 'Contacts — populated list',
    waitFor: '[data-testid="contacts-app"], [class*="contacts"]',
  },
]

// ── Local server management ───────────────────────────────────────────────────

let serverProc = null

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitForHTTP(url, maxMs = 45_000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (r.status < 600) return
    } catch { /* not yet */ }
    await sleep(500)
  }
  throw new Error(`${url} did not become ready within ${maxMs}ms`)
}

async function startLocalServer() {
  console.log('\n  setting up demo environment …')

  // 1. Write static JSON seed files (docs / sheets / slides)
  seedStaticFiles()

  // 2. Ensure the frontend is built (dist/ must exist with index.html)
  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('  building frontend (dist/) …')
    execSync('npm run build:frontend', { cwd: ROOT, stdio: 'pipe' })
    console.log('  frontend built')
  }

  // 3. Build Go binary
  const binPath = '/tmp/vulos-office-screenshots-bin'
  console.log('  building Go binary …')
  execSync(`go build -o "${binPath}" .`, { cwd: ROOT, stdio: 'pipe' })
  console.log('  Go binary built')

  // 4. Write a minimal config.yaml into a temp workdir
  const tmpWD = '/tmp/vulos-office-ss-wd'
  mkdirSync(tmpWD, { recursive: true })
  mkdirSync(`${DEMO_DATA_DIR}/uploads`, { recursive: true })
  writeFileSync(`${tmpWD}/config.yaml`, [
    'server:',
    `  addr: ":${LOCAL_PORT}"`,
    `  data_dir: "${DEMO_DATA_DIR}"`,
    `  uploads_dir: "${DEMO_DATA_DIR}/uploads"`,
    'auth:',
    '  enabled: false',
    'storage:',
    '  type: "local"',
  ].join('\n') + '\n')

  // 5. Start the Go server (it serves both API + embedded frontend)
  serverProc = spawn(binPath, [], {
    cwd: tmpWD,
    env: {
      ...process.env,
      VULOS_CALSTORE_DB:     `${DEMO_DATA_DIR}/cal.db`,
      VULOS_CONTACTSTORE_DB: `${DEMO_DATA_DIR}/contacts.db`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', d => process.stdout.write(`  [go] ${d}`))
  serverProc.stderr.on('data', d => process.stdout.write(`  [go] ${d}`))
  serverProc.on('exit', code => { if (code !== null && code > 0) console.warn(`  [go] exited with code ${code}`) })

  // 6. Wait for the server to be ready
  await waitForHTTP(`${LOCAL_BASE}/version`)
  console.log(`  server ready at ${LOCAL_BASE}`)

  // 7. Seed Calendar / Contacts via API
  await seedViaAPI(LOCAL_BASE)

  // Brief pause for SQLite writes to flush
  await sleep(1_000)
}

function stopLocalServer() {
  if (serverProc) { try { serverProc.kill() } catch {} ; serverProc = null }
}

// ── Screenshot capture ────────────────────────────────────────────────────────

async function capture(page, route) {
  const url = `${SCREENSHOT_BASE}${route.path}`
  console.log(`  → ${route.description}`)

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })

    if (route.waitFor) {
      try {
        await page.waitForSelector(route.waitFor, { timeout: 10_000 })
      } catch {
        // Element not present — still capture what's visible
        await page.waitForTimeout(3_000)
      }
    } else {
      try {
        await page.waitForLoadState('networkidle', { timeout: 8_000 })
      } catch {
        await page.waitForTimeout(2_000)
      }
    }

    // Extra pause for CSS transitions / async renders
    await page.waitForTimeout(800)

    const outPath = path.join(OUT, `${route.name}.png`)
    await page.screenshot({ path: outPath, fullPage: false })
    console.log(`     saved ${path.relative(ROOT, outPath)}`)
    return { name: route.name, status: 'ok', path: outPath }
  } catch (err) {
    console.warn(`     FAILED: ${err.message}`)
    return { name: route.name, status: 'failed', error: err.message }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(OUT, { recursive: true })

  const usingExternal = Boolean(EXTERNAL_URL)

  console.log('\nVulos Office screenshotter')
  console.log(`  screenshots → ${SCREENSHOT_BASE}`)
  console.log(`  output      : ${path.relative(ROOT, OUT)}/`)
  console.log(`  viewport    : 1440×900`)
  console.log(`  seed mode   : ${usingExternal ? (FORCE_SEED ? 'forced (--seed)' : 'skipped') : 'auto (local server)'}`)

  if (!usingExternal) {
    await startLocalServer()
  } else if (FORCE_SEED) {
    seedStaticFiles()
    await seedViaAPI(EXTERNAL_URL)
  }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
    locale: 'en-US',
  })
  const page = await context.newPage()
  page.on('console', () => {})
  page.on('pageerror', () => {})

  const results = []
  for (const route of ROUTES) {
    const result = await capture(page, route)
    results.push(result)
  }

  // ── LIGHT-mode spot captures (temporary; for design review) ───────────────
  // A second context that forces the app's light theme via localStorage before
  // any page script runs, so we can eyeball light mode for `home`/`docs-editor`.
  if (process.env.CAPTURE_LIGHT === '1') {
    const lightCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'en-US',
    })
    await lightCtx.addInitScript(() => {
      try { localStorage.setItem('vulos.theme', 'light') } catch {}
    })
    const lightPage = await lightCtx.newPage()
    const lightRoutes = ROUTES.filter(r => ['home', 'docs-editor'].includes(r.name))
    for (const route of lightRoutes) {
      const url = `${SCREENSHOT_BASE}${route.path}`
      console.log(`  → [light] ${route.description}`)
      try {
        await lightPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
        if (route.waitFor) {
          try { await lightPage.waitForSelector(route.waitFor, { timeout: 10_000 }) }
          catch { await lightPage.waitForTimeout(3_000) }
        }
        await lightPage.waitForTimeout(900)
        const outPath = path.join(OUT, `${route.name}-light.png`)
        await lightPage.screenshot({ path: outPath, fullPage: false })
        console.log(`     saved ${path.relative(ROOT, outPath)}`)
      } catch (err) {
        console.warn(`     [light] FAILED: ${err.message}`)
      }
    }
    await lightCtx.close()
  }

  await browser.close()
  stopLocalServer()

  const ok     = results.filter(r => r.status === 'ok')
  const failed = results.filter(r => r.status === 'failed')

  console.log(`\nDone — ${ok.length} captured, ${failed.length} failed`)
  if (failed.length > 0) {
    console.log('\nFailed routes:')
    for (const r of failed) console.log(`  ${r.name}: ${r.error}`)
  }

  // Write per-directory README
  const notes = [
    '# docs/screenshots',
    '',
    'Generated by `npm run screenshots` (scripts/screenshots.mjs).',
    'Populated with realistic demo data from `scripts/seed-demo.mjs`.',
    '',
    '| File | Surface | Status |',
    '|------|---------|--------|',
    ...results.map(r =>
      `| ${r.name}.png | ${ROUTES.find(rt => rt.name === r.name)?.description ?? r.name} | ${r.status === 'ok' ? 'populated' : 'needs live instance'} |`
    ),
    '',
    'To regenerate: `npm run screenshots`',
    'Against a live instance: `BASE_URL=https://... npm run screenshots`',
    '',
    '## Seed data',
    '',
    '- **Docs** `demo`: "Q2 2026 Product Update" — prose, table, bullet lists',
    '- **Sheets** `demo-sheet`: "Revenue Tracker H1 2026" — 6 months, SUM + margin formulas, 2 sheets',
    '- **Slides** `demo-slides`: "Vulos Office Product Overview" — 5 slides, Reveal.js obsidian theme',
    '- **Calendar**: 6 events this week (standup, all-hands, design sync, sprint planning, 1:1, arch review)',
    '- **Contacts**: 6 contacts with emails, phones, and notes',
  ].join('\n')

  writeFileSync(path.join(OUT, 'README.md'), notes + '\n')
  console.log('  wrote docs/screenshots/README.md\n')

  if (failed.length > 0) process.exit(1)
}

main().catch(err => {
  stopLocalServer()
  console.error('Fatal:', err)
  process.exit(1)
})
