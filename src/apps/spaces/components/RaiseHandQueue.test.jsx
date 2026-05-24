/**
 * RaiseHandQueue.test.jsx — verifies FIFO ordering, position badges, "you"
 * marker, and dismiss callback.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RaiseHandQueue from './RaiseHandQueue.jsx'

describe('RaiseHandQueue', () => {
  it('renders nothing when the queue is empty', () => {
    const { container } = render(<RaiseHandQueue queue={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders FIFO order with 1-based position badges', () => {
    const queue = [
      { peerId: 'a', displayName: 'Alice', raisedAt: 1000 },
      { peerId: 'b', displayName: 'Bob',   raisedAt: 2000 },
      { peerId: 'c', displayName: 'Carol', raisedAt: 3000 },
    ]
    render(<RaiseHandQueue queue={queue} localPeerId="b" />)
    const items = screen.getAllByTestId('raise-hand-queue-item')
    expect(items).toHaveLength(3)
    expect(items[0].textContent).toMatch(/1.*Alice/)
    expect(items[1].textContent).toMatch(/2.*Bob/)
    expect(items[2].textContent).toMatch(/3.*Carol/)
  })

  it('marks the local viewer with "you"', () => {
    const queue = [{ peerId: 'self', displayName: 'Me', raisedAt: 1000 }]
    render(<RaiseHandQueue queue={queue} localPeerId="self" />)
    expect(screen.getByText('you')).toBeTruthy()
  })

  it('fires onDismiss for the clicked peer', () => {
    const onDismiss = vi.fn()
    const queue = [
      { peerId: 'a', displayName: 'Alice', raisedAt: 1000 },
      { peerId: 'b', displayName: 'Bob',   raisedAt: 2000 },
    ]
    render(<RaiseHandQueue queue={queue} onDismiss={onDismiss} />)
    const dismissButtons = screen.getAllByTestId('raise-hand-dismiss')
    fireEvent.click(dismissButtons[1])
    expect(onDismiss).toHaveBeenCalledWith('b')
  })
})
