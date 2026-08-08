// rowsOf — the envelope unwrapper every list surface goes through.
//
// This is the highest-leverage pure function in the frontend and the one with
// the worst failure mode: it never throws. When it gets a shape it does not
// recognise it returns [], the page renders its empty state, and the reader is
// told there are no leads rather than told something broke. A page rendering
// "No leads yet" over a full database is indistinguishable from the truth.
//
// So every envelope shape the codebase actually produces is pinned here, and so
// is the junk case — because "returns [] for junk" is only acceptable behaviour
// if it is deliberate, and the only way it stays deliberate is a test.

import { describe, it, expect } from 'vitest'
import { rowsOf } from '../parity-ui.jsx'

describe('rowsOf', () => {
  it('passes a bare array straight through', () => {
    // GET /api/leads answers with a bare array of rows (see the `leads` source
    // in CommandPalette.jsx, which notes the same).
    const rows = [{ id: 1 }, { id: 2 }]
    expect(rowsOf(rows)).toBe(rows)
  })

  it('unwraps the { items, nextCursor, hasMore } envelope', () => {
    expect(rowsOf({ items: [{ id: 1 }], nextCursor: 'c1', hasMore: true })).toEqual([{ id: 1 }])
  })

  it('unwraps the { ok, data } envelope', () => {
    expect(rowsOf({ ok: true, data: [{ id: 9 }] })).toEqual([{ id: 9 }])
  })

  it('unwraps the { rows } envelope', () => {
    expect(rowsOf({ rows: [{ id: 3 }] })).toEqual([{ id: 3 }])
  })

  it('falls back to the first array-valued property for named collections', () => {
    // /api/campaign-list answers `{ campaigns: [...] }`. Before the fallback
    // existed this returned [] and the campaign picker rendered empty against a
    // populated workspace.
    expect(rowsOf({ campaigns: [{ id: 4 }], total: 1 })).toEqual([{ id: 4 }])
    expect(rowsOf({ tasks: [{ id: 5 }] })).toEqual([{ id: 5 }])
  })

  it('prefers the known keys over the positional fallback', () => {
    // Ordering matters: an envelope that happens to carry another array must
    // not beat the real collection just by appearing first in the object.
    expect(rowsOf({ warnings: ['slow'], items: [{ id: 7 }] })).toEqual([{ id: 7 }])
    expect(rowsOf({ items: [{ id: 1 }], data: [{ id: 2 }] })).toEqual([{ id: 1 }])
  })

  it('returns [] — not a throw — for everything it does not recognise', () => {
    // The callers (`usePagedList`, `TagPicker`, `ClientLens`) all call .map on
    // the result immediately, so a non-array return would be a runtime crash on
    // whatever page happened to be open.
    for (const junk of [null, undefined, 0, 42, '', 'nope', true, {}, { items: 'nope' }, { data: null }]) {
      expect(rowsOf(junk)).toEqual([])
    }
  })

  it('does not dig into a nested envelope', () => {
    // Pinned as *known* behaviour, not endorsed: `{ ok, data: { items } }` is a
    // shape the fallback cannot see, and if a route ever starts answering that
    // way this test is where the silence gets caught.
    expect(rowsOf({ ok: true, data: { items: [{ id: 1 }] } })).toEqual([])
  })
})
