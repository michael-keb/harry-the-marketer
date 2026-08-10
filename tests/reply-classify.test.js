// A reply that quoted the original email was classified as an unsubscribe.
//
// Every outbound email carries the "Don't want these? Unsubscribe here:" footer
// (tracking.js insists on it, correctly). Mail clients quote the original below
// the reply, so the stored body of every real-world reply contains the word
// "unsubscribe" — and heuristicClassify read the whole body. A lead who wrote
// "ok thanks" was opted out at 0.95 confidence without the model ever being
// asked, the enrolment stopped, and the address landed on the block list.
//
// These tests pin the fix: classification reads only the fresh text, with the
// quoted history cut off. AI_MODE=off keeps classifyReply on the heuristic
// path, which is the path that misfired.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'htm-classify-'))
process.env.AI_MODE = 'off'

const { classifyReply, freshReplyText, heuristicClassify, CORE_INTENTS } = await import('../server/ai.js')

const FOOTER = "--\nDon't want these? Unsubscribe here: https://harrythemarketer.com/u/abc123"

const GMAIL_QUOTED_REPLY =
  'ok thanks\n\nOn Mon, Aug 10, 2026 at 6:30 PM Michael Keb\n<michael@praxis-au.com> wrote:\n' +
  `> Hi Michael,\n> \n> I'm Harry — quick question about the overdue invoice.\n> \n> ${FOOTER}\n`

test('freshReplyText cuts Gmail attribution, even wrapped across lines', () => {
  assert.equal(freshReplyText(GMAIL_QUOTED_REPLY), 'ok thanks')
})

test('freshReplyText cuts Outlook original-message blocks', () => {
  const body = `Sounds good, send the details.\n\n-----Original Message-----\nFrom: Harry <michael@praxis-au.com>\n${FOOTER}`
  assert.equal(freshReplyText(body), 'Sounds good, send the details.')
})

test('freshReplyText cuts at the first quoted line', () => {
  const body = `Not interested, sorry.\n\n> Hi Michael,\n> Unsubscribe here: https://example.com/u/1`
  assert.equal(freshReplyText(body), 'Not interested, sorry.')
})

test('freshReplyText cuts a signature delimiter', () => {
  const body = `Call me tomorrow?\n--\nJane Smith\nCFO, Example Pty Ltd`
  assert.equal(freshReplyText(body), 'Call me tomorrow?')
})

test('freshReplyText falls back to the full body when everything is quoted', () => {
  const body = `> just the quote\n> nothing typed above it`
  assert.equal(freshReplyText(body), body)
})

test('a friendly reply quoting the unsubscribe footer is not an unsubscribe', async () => {
  const { intent } = await classifyReply({ intents: [], replyText: GMAIL_QUOTED_REPLY, thread: [] })
  assert.notEqual(intent, 'unsubscribe')
})

test('a genuine unsubscribe request still opts out', async () => {
  const { intent } = await classifyReply({
    intents: [],
    replyText: `Please unsubscribe me from these emails.\n\nOn Mon, Aug 10, 2026 Harry wrote:\n> Hi Michael,\n> ${FOOTER}`,
    thread: [],
  })
  assert.equal(intent, 'unsubscribe')
})

test('"take me off" phrasing in the fresh text still opts out', async () => {
  const { intent } = await classifyReply({ intents: [], replyText: 'Take me off your list.', thread: [] })
  assert.equal(intent, 'unsubscribe')
})

test('heuristicClassify itself still reads whatever it is given', () => {
  // The stripping lives in classifyReply; the raw heuristic stays honest so no
  // future caller mistakes it for being quote-aware.
  const { intent } = heuristicClassify(GMAIL_QUOTED_REPLY, CORE_INTENTS)
  assert.equal(intent, 'unsubscribe')
})
