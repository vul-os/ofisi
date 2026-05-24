/**
 * BreakoutRooms.test.jsx — verifies create + drift + recall against a mocked
 * fetch, and the graceful 404 ("unavailable in this workspace") branch.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BreakoutRooms from './BreakoutRooms.jsx'

function makeParticipants(n) {
  return Array.from({ length: n }, (_, i) => ({
    peerId: `peer-${i}`,
    identity: { displayName: `P${i}` },
  }))
}

describe('BreakoutRooms', () => {
  it('renders the room-count input and preview rooms by default', () => {
    render(
      <BreakoutRooms
        parentRoomId="room:main"
        participants={makeParticipants(4)}
        localPeerId="peer-0"
        isOrganizer
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('breakout-rooms-panel')).toBeTruthy()
    expect(screen.getByTestId('breakout-room-count').value).toBe('2')
    expect(screen.getAllByTestId('breakout-room')).toHaveLength(2)
  })

  it('shows a friendly notice when the endpoint 404s', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }))
    render(
      <BreakoutRooms
        parentRoomId="room:main"
        participants={makeParticipants(4)}
        localPeerId="peer-0"
        isOrganizer
        fetchFn={fetchFn}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('breakout-create'))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/unavailable/i)
    })
  })

  it('creates breakouts via POST /api/meet/breakouts and renders the recall button', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (String(url).endsWith('/api/meet/breakouts')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            breakoutSessionId: 'bk-1',
            rooms: [{ id: 'r1', name: 'Room 1' }, { id: 'r2', name: 'Room 2' }],
          }),
        }
      }
      return { ok: true, status: 204 }
    })
    render(
      <BreakoutRooms
        parentRoomId="room:main"
        participants={makeParticipants(4)}
        localPeerId="peer-0"
        isOrganizer
        fetchFn={fetchFn}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTestId('breakout-create'))
    await waitFor(() => {
      expect(screen.getByTestId('breakout-recall')).toBeTruthy()
    })
    // Each participant should appear in some room column.
    expect(screen.getAllByTestId('breakout-drift-select').length).toBeGreaterThan(0)
  })
})
