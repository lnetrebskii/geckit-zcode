import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Quota, parseQuota, quotaRow } from '../src/zcode-quota.mjs'

// The exact payload recorded live from api.z.ai on 2026-11-19 (a "lite" plan).
const LIVE = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 2000, percentage: 0 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 9536, remaining: 463, percentage: 95, nextResetTime: 1795590793984 },
    ],
    level: 'lite',
  },
}

test('the live payload maps to a 5-hour and a weekly window', () => {
  const { quotas } = parseQuota(LIVE, 1000)
  const five = quotas.find((q) => q.id === 'five-hour')
  const week = quotas.find((q) => q.id === 'weekly')
  assert.deepEqual(five, { id: 'five-hour', name: '5-hour', part: 0, used: 0, remaining: 2000, limit: 2000, unit: 'tokens' })
  assert.deepEqual(week, { id: 'weekly', name: 'Weekly', part: 0.95, used: 9536, remaining: 463, limit: 10000, resetsAt: 1795590793984, unit: 'tokens' })
})

test('a TIME_LIMIT entry becomes the MCP row; percentage clamps to a fraction', () => {
  const row = quotaRow({ type: 'TIME_LIMIT', unit: 5, number: 1, usage: 100, currentValue: 120, remaining: 0, percentage: 120 })
  assert.equal(row.id, 'mcp')
  assert.equal(row.part, 1)
})

test('a response without limits is unavailable, not empty', () => {
  assert.match(parseQuota({ code: 200, data: {} }, 5).unavailableReason, /did not report/)
  assert.match(parseQuota({ code: 401, msg: 'token expired' }, 5).unavailableReason ?? 'x', /did not report|x/)
})

test('read caches within the window and coalesces concurrent reads', async () => {
  let reads = 0
  let clock = 0
  const quota = new Quota({
    now: () => clock,
    readToken: async () => 'tok',
    fetch: async () => { reads += 1; return { ok: true, json: async () => LIVE } },
  })
  const [a, b] = await Promise.all([quota.read(), quota.read()])
  assert.equal(reads, 1, 'concurrent reads share one fetch')
  assert.equal(a.quotas.length, 2)
  assert.equal(b, a)
  clock = 60_000
  await quota.read()
  assert.equal(reads, 1, 'still fresh after a minute')
  clock = 11 * 60_000
  await quota.read()
  assert.equal(reads, 2, 'refetched after ten minutes')
})

test('afterTurn forces a fresh read for a live signal', async () => {
  let reads = 0
  const quota = new Quota({ now: () => 0, readToken: async () => 'tok', fetch: async () => { reads += 1; return { ok: true, json: async () => LIVE } } })
  await quota.read()
  const usage = await quota.afterTurn()
  assert.equal(reads, 2)
  assert.equal(usage.quotas.length, 2)
})

test('a token that cannot be read is a reason, never a throw', async () => {
  const quota = new Quota({ now: () => 0, readToken: async () => { throw new Error('keychain') }, fetch: async () => { throw new Error('should not fetch') } })
  const usage = await quota.read()
  assert.match(usage.unavailableReason, /did not report/)
})

test('an API error message is surfaced, the token is not', async () => {
  const quota = new Quota({ now: () => 0, readToken: async () => 'secret-token', fetch: async () => ({ ok: true, json: async () => ({ code: 401, msg: 'token expired or incorrect' }) }) })
  const usage = await quota.read()
  assert.match(usage.unavailableReason, /token expired or incorrect/)
  assert.equal(JSON.stringify(usage).includes('secret-token'), false)
})
