/**
 * text.ingress.test.js — WAVE-56 SECURITY regression.
 *
 * The recurring untrusted-CRDT-ingress class: a remote peer / the collab relay /
 * a persisted-then-replayed op-log delivers a CRDT op or snapshot node whose
 * fields are NOT what the applier expects. Historically TextCRDT.apply() called
 * String.fromCodePoint(op.v) with no validation, so a hostile `v` (non-finite,
 * negative, out-of-range, non-number, surrogate) threw RangeError *inside* apply.
 * On the server-SSE path (serverSession es.onmessage) and the restore() bootstrap
 * path that throw is UNCAUGHT → the remote-op handler / a late joiner crashes,
 * and because the op is persisted it re-crashes every future joiner (persistent
 * DoS). This mirrors the Board laser (non-finite coords) and Sheets chart_op
 * (peer descriptor merged without validation) findings.
 *
 * Contract now: every malformed op/node is dropped FAIL-CLOSED — apply() returns
 * false, restore() skips it, neither ever throws, and a valid op still applies.
 */
import { describe, it, expect } from 'vitest'
import { TextCRDT, TEXT_OP_INSERT, TEXT_OP_DELETE } from '../text.js'

const goodId = (c, r = 'peer') => ({ r, c })

describe('TextCRDT ingress hardening (WAVE-56)', () => {
  describe('hostile Insert `v` (String.fromCodePoint DoS) is dropped, never throws', () => {
    const hostileVs = [
      ['undefined', undefined],
      ['null', null],
      ['negative', -1],
      ['above max code point', 0x110000],
      ['non-integer', 1.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['string', 'abc'],
      ['object (React-child-crash shape)', { toString: () => 'x' }],
      ['array', [65]],
      ['low surrogate', 0xdc00],
      ['high surrogate', 0xd800],
    ]

    for (const [label, v] of hostileVs) {
      it(`drops v = ${label} without throwing`, () => {
        const crdt = new TextCRDT('victim')
        let changed
        expect(() => { changed = crdt.apply({ k: TEXT_OP_INSERT, id: goodId(1), p: null, v }) }).not.toThrow()
        expect(changed).toBe(false)
        expect(crdt.toString()).toBe('')
      })
    }
  })

  it('drops an Insert with a missing / malformed id (no TypeError)', () => {
    const crdt = new TextCRDT('victim')
    expect(() => crdt.apply({ k: TEXT_OP_INSERT, p: null, v: 65 })).not.toThrow()
    expect(crdt.apply({ k: TEXT_OP_INSERT, p: null, v: 65 })).toBe(false)
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: { c: 'x', r: 'p' }, p: null, v: 65 })).toBe(false)
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: { c: NaN, r: 'p' }, p: null, v: 65 })).toBe(false)
    expect(crdt.toString()).toBe('')
  })

  it('drops an Insert whose parent OpID is malformed (but keeps valid roots)', () => {
    const crdt = new TextCRDT('victim')
    // Malformed non-zero parent → dropped.
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: goodId(1), p: { c: 'nope' }, v: 65 })).toBe(false)
    // Absent parent (→ ROOT) is fine.
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: goodId(2), p: null, v: 66 })).toBe(true)
    expect(crdt.toString()).toBe('B')
  })

  it('drops a Delete with a missing / malformed target or id', () => {
    const crdt = new TextCRDT('victim')
    crdt.apply({ k: TEXT_OP_INSERT, id: goodId(1), p: null, v: 65 }) // "A"
    expect(() => crdt.apply({ k: TEXT_OP_DELETE, id: goodId(2) })).not.toThrow() // no `t`
    expect(crdt.apply({ k: TEXT_OP_DELETE, id: goodId(2) })).toBe(false)
    expect(crdt.apply({ k: TEXT_OP_DELETE, id: goodId(2), t: { c: 'x' } })).toBe(false)
    expect(crdt.apply({ k: TEXT_OP_DELETE, t: goodId(1) })).toBe(false) // no own id
    expect(crdt.toString()).toBe('A') // untouched
  })

  it('drops an op with an unknown / missing kind', () => {
    const crdt = new TextCRDT('victim')
    expect(crdt.apply({ k: 999, id: goodId(1), v: 65 })).toBe(false)
    expect(crdt.apply({ id: goodId(1), v: 65 })).toBe(false)
    expect(crdt.apply(null)).toBe(false)
    expect(crdt.apply('not-an-op')).toBe(false)
    expect(crdt.toString()).toBe('')
  })

  it('still applies a well-formed op and converges (fix does not break happy path)', () => {
    const crdt = new TextCRDT('victim')
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: goodId(1), p: null, v: 'H'.codePointAt(0) })).toBe(true)
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: goodId(2), p: goodId(1), v: 'i'.codePointAt(0) })).toBe(true)
    expect(crdt.toString()).toBe('Hi')
    // Emoji / astral plane (multi-unit code point) still round-trips.
    expect(crdt.apply({ k: TEXT_OP_INSERT, id: goodId(3), p: goodId(2), v: 0x1f600 })).toBe(true)
    expect(crdt.toString()).toBe('Hi\u{1f600}')
  })

  it('a poisoned op interleaved with valid ops does not corrupt convergence', () => {
    const crdt = new TextCRDT('victim')
    crdt.apply({ k: TEXT_OP_INSERT, id: goodId(1), p: null, v: 'A'.codePointAt(0) })
    // Hostile op from a malicious co-editor — dropped, no effect.
    crdt.apply({ k: TEXT_OP_INSERT, id: goodId(2), p: goodId(1), v: {} })
    crdt.apply({ k: TEXT_OP_INSERT, id: goodId(3), p: goodId(1), v: 'B'.codePointAt(0) })
    expect(crdt.toString()).toBe('AB')
  })

  describe('restore() (snapshot / bootstrap / persisted-op-log replay)', () => {
    it('skips malformed nodes without throwing, keeps the good ones', () => {
      const crdt = new TextCRDT('victim')
      expect(() => crdt.restore({
        nodes: [
          { id: goodId(1), p: null, v: 'H'.codePointAt(0), d: false },
          { id: goodId(2), p: goodId(1), v: {}, d: false },        // hostile → skip
          { id: goodId(3), p: goodId(1), v: 0x110000, d: false },  // out of range → skip
          { id: goodId(4), p: goodId(1), v: 'i'.codePointAt(0), d: false },
        ],
      })).not.toThrow()
      // Only the two valid characters survive.
      expect(crdt.toString()).toBe('Hi')
    })

    it('tolerates a completely garbage snapshot', () => {
      const crdt = new TextCRDT('victim')
      expect(() => crdt.restore({ nodes: [null, 'x', 42, { v: 65 }] })).not.toThrow()
      expect(crdt.toString()).toBe('')
      expect(() => crdt.restore(null)).not.toThrow()
      expect(() => crdt.restore({})).not.toThrow()
    })
  })
})
