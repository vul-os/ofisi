/**
 * Docs live co-editing gate (VITE_DOCS_COLLAB) — the honesty contract.
 *
 * Live co-editing is the one feature whose failure mode is SILENT: a sync path
 * that mis-maps a remote change corrupts the document, and a sync path that is
 * off but still SHOWS collaboration affordances lets a user believe their
 * co-editing works when nothing is being sent at all. This suite pins both
 * halves of the gate:
 *
 *   • OFF  → the editor opens NO sync transport (zero /collab/* traffic, in or
 *            out), typing never publishes an op, and the UI SAYS co-editing is
 *            off (pill + share-dialog notice). No silent degradation.
 *   • ON   → the transport is opened (the bootstrap is fetched) and the "off"
 *            copy is gone.
 *
 * The editor itself must be perfectly usable in both states.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { server, resetMock, mockState } from '../../../__tests__/msw/server.js'

// The gate under test. Each case sets the return value before mounting.
const collabEnabled = vi.fn(() => false)
vi.mock('../../../lib/flags.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, docsCollabEnabled: () => collabEnabled() }
})

import DocsEditor from '../DocsEditor.jsx'

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => { server.resetHandlers(); vi.restoreAllMocks() })
afterAll(() => server.close())

function mountEditor() {
  return render(
    <MemoryRouter initialEntries={['/docs/doc1']}>
      <Routes>
        <Route path="/docs/:id" element={<DocsEditor />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** Every /collab/* call the app made (in or out) since the mock was reset. */
function collabCalls() {
  return mockState.calls.filter((c) => c.includes('/collab/'))
}

describe('Docs live co-editing gate — OFF (default)', () => {
  beforeEach(() => {
    resetMock({ role: 'owner' })
    collabEnabled.mockReturnValue(false)
  })

  it('opens no sync transport at all — zero /collab traffic', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    // Give any deferred join/bootstrap a chance to fire.
    await new Promise((r) => setTimeout(r, 150))
    expect(collabCalls()).toEqual([])
  })

  it('typing publishes no ops (nothing leaves the tab)', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    const pm = document.querySelector('.ProseMirror')
    await userEvent.click(pm)
    await userEvent.keyboard('hello collab')
    await new Promise((r) => setTimeout(r, 400)) // past the publish debounce
    expect(collabCalls()).toEqual([])
    expect(mockState.collab.doc1.ops).toHaveLength(0)
  })

  it('SAYS co-editing is off rather than showing an empty roster', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    expect(screen.getByTestId('collab-off-pill')).toHaveTextContent(/live co-editing off/i)
  })

  it('the share dialog states plainly that edits will not sync live, and offers no P2P invite link', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /Share — with people/i }))
    const notice = await screen.findByTestId('live-collab-notice')
    expect(notice).toHaveTextContent(/not appear in real time/i)
    // An invite link that can never sync must not be offered.
    expect(screen.queryByRole('button', { name: /Share via link \(P2P\)/i })).toBeNull()
  })

  it('the editor still works as a single-user editor', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    const pm = document.querySelector('.ProseMirror')
    await userEvent.click(pm)
    await userEvent.keyboard('solo editing works')
    expect(pm.textContent).toContain('solo editing works')
  })
})

describe('Docs live co-editing gate — ON', () => {
  beforeEach(() => {
    resetMock({ role: 'owner' })
    collabEnabled.mockReturnValue(true)
  })

  it('opens the sync transport (bootstraps from the server) and drops the "off" copy', async () => {
    mountEditor()
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy())
    await waitFor(
      () => expect(collabCalls().some((c) => c.includes('/collab/state'))).toBe(true),
      { timeout: 3000 },
    )
    expect(screen.queryByTestId('collab-off-pill')).toBeNull()
  })
})
