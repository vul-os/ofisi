#!/usr/bin/env node
/**
 * Vulos Office — demo data seeder
 *
 * Writes static JSON files for docs/sheets/slides into a temp data directory,
 * then POSTs seed data to a running backend for Calendar and Contacts
 * via the REST API.
 *
 * Usage (standalone):
 *   node scripts/seed-demo.mjs [--base-url http://localhost:8080]
 *
 * The screenshotter calls this automatically — no need to run it manually.
 *
 * Data dir: /tmp/vulos-demo-data  (never touches ./data)
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEMO_DATA_DIR = '/tmp/vulos-demo-data'

const BASE_URL = process.env.BASE_URL ?? process.argv.find(a => a.startsWith('http')) ?? 'http://localhost:8080'

// ── helpers ──────────────────────────────────────────────────────────────────

function ensureDir(p) {
  mkdirSync(p, { recursive: true })
}

function writeJSON(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
}

async function post(baseURL, path, body) {
  const r = await fetch(`${baseURL}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`POST ${path} → ${r.status}: ${t}`)
  }
  return r.json()
}

async function tryPost(baseURL, path, body) {
  try { return await post(baseURL, path, body) }
  catch (e) { console.warn(`  [warn] seed: ${e.message}`) ; return null }
}

// ── 1. Static JSON files (docs / sheets / slides) ────────────────────────────
// These are read directly from disk by the Go backend — no API call needed.
// Place them in DEMO_DATA_DIR; the backend is started with DATA_DIR pointing there.

export function seedStaticFiles() {
  ensureDir(DEMO_DATA_DIR)
  ensureDir(path.join(DEMO_DATA_DIR, 'versions'))
  ensureDir(path.join(DEMO_DATA_DIR, 'comments'))
  ensureDir(path.join(DEMO_DATA_DIR, 'replies'))
  ensureDir(path.join(DEMO_DATA_DIR, 'suggestions'))
  ensureDir(path.join(DEMO_DATA_DIR, 'envelopes'))
  ensureDir(path.join(DEMO_DATA_DIR, 'signers'))
  ensureDir(path.join(DEMO_DATA_DIR, 'audit'))
  ensureDir(path.join(DEMO_DATA_DIR, 'sealed'))
  ensureDir(path.join(DEMO_DATA_DIR, 'tokens'))

  const now = new Date().toISOString()
  const yesterday = new Date(Date.now() - 86400000).toISOString()
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString()

  // ── Doc ──────────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'demo.json'), {
    id: 'demo',
    name: 'Q2 2026 Product Update',
    type: 'doc',
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Q2 2026 Product Update' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'This document summarises the key milestones, shipped features, and upcoming priorities for Vulos Office during the second quarter of 2026. It is intended for internal distribution and review before the all-hands on Friday.' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'What we shipped' }],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Calendar reminders with email dispatch and in-app toasts (OFFICE-CAL-3)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PDF multi-party signing with Ed25519 audit trail (OFFICE-40–47)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Track-changes (suggestion mode) for Docs (OFFICE-27)' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'XLSX import/export for Sheets (OFFICE-SHEETS-5)' }] }] },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'In progress' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The team is currently finishing the ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'offline-first sync layer' },
            { type: 'text', text: ' for Docs — CRDT-based merging so two people editing the same file from different network partitions converge without conflicts when they reconnect.' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Metrics (week ending 2026-06-13)' }],
        },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Metric' }] }] },
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'This week' }] }] },
                { type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: 'Last week' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Active users' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1 247' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '1 091' }] }] },
              ],
            },
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Docs saved' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '3 842' }] }] },
                { type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: [{ type: 'text', text: '3 210' }] }] },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Full data in the analytics dashboard. Questions? Leave a comment on this doc.' },
          ],
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: yesterday,
  })

  // ── Second doc ────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'doc-arch.json'), {
    id: 'doc-arch',
    name: 'Architecture Decision Record — Sync Layer',
    type: 'doc',
    content: {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'ADR-014: Sync Layer for Offline-First Docs' }],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', marks: [{ type: 'bold' }], text: 'Status:' },
            { type: 'text', text: ' Accepted · ' },
            { type: 'text', marks: [{ type: 'bold' }], text: 'Date:' },
            { type: 'text', text: ' 2026-06-10' },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Context' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Vulos Office currently uses last-write-wins (LWW) for concurrent edits. This is adequate for single-user deployments but causes silent data loss when two users edit the same document simultaneously on a slow or partitioned network.' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Decision' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'We will adopt a CRDT (Conflict-free Replicated Data Type) approach using Yjs for rich-text documents. The server acts as a passive relay and durable snapshot store; clients hold the authoritative CRDT state and reconcile via the Y-protocol websocket.' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Consequences' }],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Offline edits merge correctly on reconnect — no data loss.' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Initial bundle size increases by ~60 KB (Yjs + y-prosemirror).' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Server stores binary Yjs snapshots alongside the JSON content blob.' }] }] },
          ],
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: now,
  })

  // ── Sheet ─────────────────────────────────────────────────────────────────
  // FortuneSheet cell format: { r: row, c: col, v: { v: value, m: display, t: type, f: formula } }
  const sheetCells = [
    // Header row
    { r: 0, c: 0, v: { v: 'Month', m: 'Month', t: 's', bl: 1 } },
    { r: 0, c: 1, v: { v: 'Revenue (ZAR)', m: 'Revenue (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 2, v: { v: 'Expenses (ZAR)', m: 'Expenses (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 3, v: { v: 'Profit (ZAR)', m: 'Profit (ZAR)', t: 's', bl: 1 } },
    { r: 0, c: 4, v: { v: 'Margin %', m: 'Margin %', t: 's', bl: 1 } },
    // Data rows
    { r: 1, c: 0, v: { v: 'Jan 2026', m: 'Jan 2026', t: 's' } },
    { r: 1, c: 1, v: { v: 48200, m: '48200', t: 'n' } },
    { r: 1, c: 2, v: { v: 31400, m: '31400', t: 'n' } },
    { r: 1, c: 3, v: { f: '=B2-C2', v: 16800, m: '16800', t: 'n' } },
    { r: 1, c: 4, v: { f: '=D2/B2*100', v: 34.85, m: '34.85', t: 'n' } },

    { r: 2, c: 0, v: { v: 'Feb 2026', m: 'Feb 2026', t: 's' } },
    { r: 2, c: 1, v: { v: 52800, m: '52800', t: 'n' } },
    { r: 2, c: 2, v: { v: 33100, m: '33100', t: 'n' } },
    { r: 2, c: 3, v: { f: '=B3-C3', v: 19700, m: '19700', t: 'n' } },
    { r: 2, c: 4, v: { f: '=D3/B3*100', v: 37.31, m: '37.31', t: 'n' } },

    { r: 3, c: 0, v: { v: 'Mar 2026', m: 'Mar 2026', t: 's' } },
    { r: 3, c: 1, v: { v: 61500, m: '61500', t: 'n' } },
    { r: 3, c: 2, v: { v: 35700, m: '35700', t: 'n' } },
    { r: 3, c: 3, v: { f: '=B4-C4', v: 25800, m: '25800', t: 'n' } },
    { r: 3, c: 4, v: { f: '=D4/B4*100', v: 41.95, m: '41.95', t: 'n' } },

    { r: 4, c: 0, v: { v: 'Apr 2026', m: 'Apr 2026', t: 's' } },
    { r: 4, c: 1, v: { v: 67200, m: '67200', t: 'n' } },
    { r: 4, c: 2, v: { v: 38900, m: '38900', t: 'n' } },
    { r: 4, c: 3, v: { f: '=B5-C5', v: 28300, m: '28300', t: 'n' } },
    { r: 4, c: 4, v: { f: '=D5/B5*100', v: 42.11, m: '42.11', t: 'n' } },

    { r: 5, c: 0, v: { v: 'May 2026', m: 'May 2026', t: 's' } },
    { r: 5, c: 1, v: { v: 73400, m: '73400', t: 'n' } },
    { r: 5, c: 2, v: { v: 41200, m: '41200', t: 'n' } },
    { r: 5, c: 3, v: { f: '=B6-C6', v: 32200, m: '32200', t: 'n' } },
    { r: 5, c: 4, v: { f: '=D6/B6*100', v: 43.87, m: '43.87', t: 'n' } },

    { r: 6, c: 0, v: { v: 'Jun 2026', m: 'Jun 2026', t: 's' } },
    { r: 6, c: 1, v: { v: 79100, m: '79100', t: 'n' } },
    { r: 6, c: 2, v: { v: 43600, m: '43600', t: 'n' } },
    { r: 6, c: 3, v: { f: '=B7-C7', v: 35500, m: '35500', t: 'n' } },
    { r: 6, c: 4, v: { f: '=D7/B7*100', v: 44.88, m: '44.88', t: 'n' } },

    // Total row
    { r: 7, c: 0, v: { v: 'TOTAL', m: 'TOTAL', t: 's', bl: 1 } },
    { r: 7, c: 1, v: { f: '=SUM(B2:B7)', v: 382200, m: '382200', t: 'n', bl: 1 } },
    { r: 7, c: 2, v: { f: '=SUM(C2:C7)', v: 223900, m: '223900', t: 'n', bl: 1 } },
    { r: 7, c: 3, v: { f: '=SUM(D2:D7)', v: 158300, m: '158300', t: 'n', bl: 1 } },
    { r: 7, c: 4, v: { f: '=D8/B8*100', v: 41.42, m: '41.42', t: 'n', bl: 1 } },
  ]

  writeJSON(path.join(DEMO_DATA_DIR, 'demo-sheet.json'), {
    id: 'demo-sheet',
    name: 'Revenue Tracker H1 2026',
    type: 'sheet',
    content: [
      {
        name: 'Revenue',
        celldata: sheetCells,
        config: {
          columnlen: { 0: 110, 1: 140, 2: 150, 3: 140, 4: 110 },
        },
        row: 10,
        column: 6,
      },
      {
        name: 'Notes',
        celldata: [
          { r: 0, c: 0, v: { v: 'All figures in South African Rand (ZAR)', m: 'All figures in South African Rand (ZAR)', t: 's' } },
          { r: 1, c: 0, v: { v: 'Exchange rate used: 1 USD = 18.4 ZAR (as of 2026-06-01)', m: 'Exchange rate used: 1 USD = 18.4 ZAR (as of 2026-06-01)', t: 's' } },
        ],
        config: {},
        row: 5,
        column: 4,
      },
    ],
    created_at: twoDaysAgo,
    updated_at: yesterday,
  })

  // ── Slide deck ────────────────────────────────────────────────────────────
  writeJSON(path.join(DEMO_DATA_DIR, 'demo-slides.json'), {
    id: 'demo-slides',
    name: 'Vulos Office — Product Overview',
    type: 'slide',
    content: {
      themeId: 'obsidian',
      theme: 'black',
      transition: 'slide',
      masters: null,
      customTheme: null,
      slides: [
        {
          id: 'slide-1',
          master: 'title',
          title: 'Vulos Office',
          content: '<p><strong>Open-source productivity suite</strong><br>Documents · Sheets · Slides · Calendar</p>',
          notes: 'Welcome! This deck gives a 5-minute overview of what Vulos Office is and why we built it.',
          bg: '',
        },
        {
          id: 'slide-2',
          master: 'content',
          title: 'The Problem',
          content: '<ul><li>Google Workspace and Microsoft 365 lock your data in the cloud</li><li>Most open-source suites are desktop-only or feel dated</li><li>No single tool combines docs, sheets, slides, and calendar without a vendor account</li></ul>',
          notes: 'Emphasise that this is about sovereignty — knowing where your data lives.',
          bg: '',
        },
        {
          id: 'slide-3',
          master: 'content',
          title: 'Our Answer: One Binary',
          content: '<ul><li>Single Go binary — run it anywhere in seconds</li><li>Zero telemetry, no cloud account required</li><li>SQLite by default, PostgreSQL when you scale</li><li>PWA-installable on any device</li></ul>',
          notes: 'The single binary story is the killer differentiator for self-hosters.',
          bg: '',
        },
        {
          id: 'slide-4',
          master: 'content',
          title: 'What\'s Inside',
          content: '<table><tr><th>Surface</th><th>Engine</th></tr><tr><td>Documents</td><td>TipTap (ProseMirror)</td></tr><tr><td>Sheets</td><td>Fortune Sheet</td></tr><tr><td>Slides</td><td>Reveal.js</td></tr><tr><td>Calendar</td><td>FullCalendar + rrule</td></tr></table>',
          notes: 'Each surface is also available as an importable npm component via @vulos/office-client.',
          bg: '',
        },
        {
          id: 'slide-5',
          master: 'content',
          title: 'Roadmap Highlights',
          content: '<ul><li>Q3 2026 — offline-first CRDT sync for Docs</li><li>Q3 2026 — S3/Tigris object store integration</li><li>Q4 2026 — AI writing assistant (local model, opt-in)</li><li>Q4 2026 — Mobile-native PWA install flow</li></ul>',
          notes: 'These are the items the team voted as highest value in the last planning session.',
          bg: '',
        },
      ],
    },
    created_at: twoDaysAgo,
    updated_at: now,
  })

  console.log(`  wrote static seed files → ${DEMO_DATA_DIR}`)
}

// ── 2. Seed via REST API (Calendar, Contacts) ─────────────────────────────────
// Only called once the backend is running on BASE_URL.

export async function seedViaAPI(baseURL = BASE_URL) {
  console.log(`\n  seeding via API → ${baseURL}`)
  // Bind baseURL into a local shorthand
  const tp = (path, body) => tryPost(baseURL, path, body)

  // ── Calendar events ───────────────────────────────────────────────────────
  const weekStart = new Date()
  weekStart.setHours(0, 0, 0, 0)
  // Move to Monday of current week
  const day = weekStart.getDay()
  weekStart.setDate(weekStart.getDate() - (day === 0 ? 6 : day - 1))

  function dayAt(daysOffset, h, m = 0) {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + daysOffset)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }

  const calEvents = [
    {
      title: 'Team Standup',
      calendar_id: 'personal',
      start: dayAt(0, 9, 0),
      end: dayAt(0, 9, 30),
      recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      color: '#6366f1',
      description: 'Daily 30-minute sync. Agenda: progress, blockers, announcements.',
    },
    {
      title: 'Architecture Review — CRDT Sync Layer',
      calendar_id: 'work',
      start: dayAt(3, 14, 0),
      end: dayAt(3, 15, 30),
      location: 'Engineering Room',
      color: '#f59e0b',
      description: 'Review ADR-014 and decide on Yjs vs Automerge for the offline sync layer.',
    },
    {
      title: 'Q2 All-Hands',
      calendar_id: 'work',
      start: dayAt(4, 15, 0),
      end: dayAt(4, 16, 30),
      location: 'Main conference room',
      color: '#10b981',
      description: 'Full team review of Q2 results, roadmap for Q3, open Q&A.',
    },
    {
      title: 'Design Sync',
      calendar_id: 'work',
      start: dayAt(1, 11, 0),
      end: dayAt(1, 11, 45),
      color: '#8b5cf6',
      description: 'Sidebar redesign, dark-mode palette review, mobile responsive pass.',
    },
    {
      title: 'Sprint Planning',
      calendar_id: 'work',
      start: dayAt(0, 10, 0),
      end: dayAt(0, 11, 30),
      color: '#ec4899',
      description: 'Kick off the Q3-W1 sprint. Estimate stories, assign owners.',
    },
    {
      title: '1:1 — Engineering Lead',
      calendar_id: 'personal',
      start: dayAt(2, 13, 0),
      end: dayAt(2, 13, 30),
      color: '#06b6d4',
      description: 'Fortnightly 1:1. Topics: career growth, project blockers, team morale.',
    },
  ]

  for (const ev of calEvents) {
    await tp('/calendar/events', ev)
  }

  // ── Contacts ──────────────────────────────────────────────────────────────
  const contacts = [
    { full_name: 'Amara Diallo', emails: [{ address: 'amara@vulos.org', label: 'work' }], phones: [{ number: '+27 11 555 0100', label: 'work' }], notes: 'Engineering lead. Timezone: Africa/Johannesburg' },
    { full_name: 'Sipho Ndlovu', emails: [{ address: 'sipho@vulos.org', label: 'work' }], phones: [{ number: '+27 21 555 0201', label: 'mobile' }], notes: 'Product manager. Focuses on calendar and contacts surfaces.' },
    { full_name: 'Kefilwe Mthembu', emails: [{ address: 'kefilwe@vulos.org', label: 'work' }], phones: [{ number: '+27 31 555 0342', label: 'work' }], notes: 'Design lead. Figma access required.' },
    { full_name: 'Yaw Asante', emails: [{ address: 'yaw@example.org', label: 'work' }], phones: [{ number: '+233 30 255 0412', label: 'mobile' }], notes: 'External partner — Accra office.' },
    { full_name: 'Zanele Khumalo', emails: [{ address: 'zanele@vulos.org', label: 'work' }, { address: 'zanele@personal.co.za', label: 'personal' }], phones: [{ number: '+27 11 555 0567', label: 'mobile' }], notes: 'Backend engineer. On call this week.' },
    { full_name: 'Tendai Moyo', emails: [{ address: 'tendai@vulos.org', label: 'work' }], notes: 'DevOps. Manages fly.io + Tigris deployments.' },
  ]

  for (const c of contacts) {
    await tp('/contacts', c)
  }

  console.log('  API seed complete')
}

// ── Main (standalone) ─────────────────────────────────────────────────────────
async function main() {
  console.log('\nVulos Office — demo seeder')
  console.log(`  data dir : ${DEMO_DATA_DIR}`)
  console.log(`  api base : ${BASE_URL}`)

  seedStaticFiles()
  await seedViaAPI(BASE_URL)

  console.log('\nSeed done.\n')
}

// Only run main() when invoked directly, not when imported.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1) })
}
