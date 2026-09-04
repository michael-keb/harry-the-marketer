import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDbTime } from '../server/engine.js'

test('parseDbTime: SQLite datetime string', () => {
  const ms = parseDbTime('2026-03-10 14:30:00')
  assert.equal(ms, Date.parse('2026-03-10T14:30:00Z'))
})

test('parseDbTime: ISO with Z', () => {
  const iso = '2026-03-10T14:30:00.123Z'
  assert.equal(parseDbTime(iso), Date.parse(iso))
})

test('parseDbTime: ISO with offset', () => {
  const iso = '2026-03-10T14:30:00+10:00'
  assert.equal(parseDbTime(iso), Date.parse(iso))
})

test('parseDbTime: empty and garbage return 0', () => {
  assert.equal(parseDbTime(''), 0)
  assert.equal(parseDbTime(null), 0)
  assert.equal(parseDbTime('not-a-date'), 0)
})
