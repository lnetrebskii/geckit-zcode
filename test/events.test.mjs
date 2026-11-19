import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { describeTool, endingOf, turnReader, wantedOf } from '../src/zcode-events.mjs'

const fixture = async (name) => (await readFile(new URL(`./fixtures/live/${name}.jsonl`, import.meta.url), 'utf8'))
  .trim().split('\n').map((line) => JSON.parse(line))

function replay(events) {
  const reader = turnReader('/work')
  const items = new Map()
  const signals = []
  for (const event of events) {
    const out = reader.feed(event)
    for (const item of out.items) items.set(item.id, item)
    signals.push(...out.signals)
  }
  return { reader, items: [...items.values()], signals }
}

test('a recorded plain reply becomes thought, answer, spend and a done ending', async () => {
  const { reader, items, signals } = replay(await fixture('reply-ok'))
  assert.equal(reader.state.session, 'sess_4af27962-06e9-407c-954a-4da374215a21')
  assert.equal(reader.state.model, 'account:zai-individual-coding-plan/GLM-5.3')
  assert.deepEqual(items.filter((item) => item.kind === 'theirs').map((item) => item.text), ['ok'])
  assert.ok(items.some((item) => item.kind === 'thought' && item.text.includes('The user wants me')))
  assert.ok(signals.some((signal) => signal.kind === 'spend' && signal.window === 1_000_000 && signal.used > 0))
  assert.deepEqual(reader.finish({ code: 0, signal: null, stopped: false, stderr: '' }), { kind: 'ended', how: 'done' })
})

test('a recorded allowed write becomes a finished tool line and a wrote item', async () => {
  const { items, signals } = replay(await fixture('build-hook-allowed'))
  const did = items.find((item) => item.kind === 'did')
  assert.equal(did.what, 'Write hello.txt')
  assert.equal(did.path, 'hello.txt')
  assert.equal(did.live, false)
  assert.match(did.detail, /File created successfully/)
  assert.ok(items.some((item) => item.kind === 'wrote' && item.paths[0] === '/work/hello.txt'))
  assert.ok(signals.some((signal) => signal.kind === 'writing'))
  assert.ok(signals.some((signal) => signal.kind === 'doing' && signal.what === 'Write hello.txt'))
})

test('a recorded headless denial is seen as one', async () => {
  const { reader } = replay(await fixture('build-denied'))
  assert.equal(reader.state.denied.length, 2)
  assert.match(reader.state.denied[0], /No permission client configured/)
})

test('a goal run, which prints only its final record, still gives the answer', async () => {
  const reader = turnReader('/work')
  const record = JSON.parse((await readFile(new URL('./fixtures/live/goal-final.jsonl', import.meta.url), 'utf8')))
  assert.deepEqual(reader.finalAnswer(record).map((item) => item.text), ['ok'])
  assert.equal(reader.state.session, 'sess_23c56cef-78e0-4c15-9c1c-08de89535459')
})

test('endings: cancelled, missing result, auth and quota stay distinct', () => {
  assert.equal(turnReader('/w').finish({ code: 130, signal: null, stopped: false, stderr: '' }).how, 'stopped')
  assert.equal(turnReader('/w').finish({ code: 0, signal: null, stopped: false, stderr: '' }).how, 'failed', 'exit 0 without a result is incomplete')
  assert.equal(endingOf('HTTP 401: token expired'), 'signedOut')
  assert.equal(endingOf('HTTP 429: usage limit reached'), 'limit')
  assert.equal(endingOf('Error: Session not found: sess_x'), 'failed')
})

test('tool requests become the cards GeckIt draws', () => {
  assert.deepEqual(wantedOf('Bash', { command: 'npm test' }), { kind: 'command', command: 'npm test' })
  assert.deepEqual(wantedOf('Write', { file_path: '/w/a.txt' }), { kind: 'write', paths: ['/w/a.txt'] })
  assert.deepEqual(wantedOf('WebFetch', { url: 'https://example.com/x' }), { kind: 'web', url: 'https://example.com/x' })
  assert.equal(wantedOf('Mystery', { a: 1 }).kind, 'other')
  assert.equal(describeTool('/w', 'Bash', { command: 'ls -la\nmore' }), 'Bash ls -la')
})
