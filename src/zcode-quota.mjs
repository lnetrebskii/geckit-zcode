// The plan's remaining quota, read the way ZCode Desktop reads it: the account's
// own OAuth token against `GET /api/monitor/usage/quota/limit`. zcode-app-cli
// has no command for it, so the token is taken from the person's own ZCode
// credential store on this machine (macOS keychain, `enc:v2:os:` values) and
// used only against the official endpoint. The token is never logged or
// returned. Anything unexpected — another platform, a changed cipher, a bad
// response — becomes an `unavailableReason`, never a thrown turn.
//
// Credential scheme read from zcode-app-cli 3.18.2-47:
//   service "ZCode Credential Encryption", account sha256(credentialsPath) hex,
//   value enc:v2:os:<keyid>:<iv>.<tag>.<ct> (aes-256-gcm, base64url parts).

import { execFile } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SERVICE = 'ZCode Credential Encryption'
const TOKEN_KEY = 'oauth:zai:access_token'
const QUOTA_PATH = '/api/monitor/usage/quota/limit'
const FRESH_MS = 10 * 60_000
const UNAVAILABLE = 'ZCode did not report the plan quota.'

const credentialsPath = (environment) => join(environment.ZCODE_DATA_BASE_DIR?.trim() || homedir(), '.zcode', 'v2', 'credentials.json')
const quotaUrl = (environment) => `${(environment.ZCODE_BASE_URL?.trim() || 'https://api.z.ai').replace(/\/+$/, '')}${QUOTA_PATH}`

/** The keychain key for this machine's ZCode credentials, or throws. */
function readKey(path, run) {
  const account = createHash('sha256').update(path).digest('hex')
  return new Promise((resolvePromise, rejectPromise) => {
    run('security', ['find-generic-password', '-w', '-s', SERVICE, '-a', account], (error, stdout) => {
      if (error !== null) { rejectPromise(new Error('keychain')); return }
      const key = Buffer.from(String(stdout).trim(), 'base64url')
      if (key.length !== 32) { rejectPromise(new Error('key')); return }
      resolvePromise(key)
    })
  })
}

/** Decrypts one `enc:v2:os:<kid>:<iv>.<tag>.<ct>` value with the keychain key. */
export function decryptValue(value, key) {
  const parts = String(value).split(':')
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v2' || parts[2] !== 'os') throw new Error('shape')
  const [iv, tag, ct] = parts[4].split('.').map((part) => Buffer.from(part, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** One quota row as GeckIt shows it, or undefined where the entry is unreadable. */
export function quotaRow(limit) {
  if (limit === null || typeof limit !== 'object') return undefined
  const window = (Number.isFinite(limit.unit) && Number.isFinite(limit.number))
    ? (limit.unit === 3 && limit.number === 5 ? { id: 'five-hour', name: '5-hour' }
      : limit.unit === 6 && limit.number === 1 ? { id: 'weekly', name: 'Weekly' } : undefined)
    : undefined
  const named = window ?? (limit.type === 'TIME_LIMIT' ? { id: 'mcp', name: 'MCP' } : { id: `${limit.type ?? 'limit'}-${limit.unit ?? 0}-${limit.number ?? 0}`, name: String(limit.type ?? 'Limit') })
  // A spent fraction and a reset time, the way Claude's plan windows read. The
  // raw credit counts are left out on purpose: a percentage beside "463 left"
  // is two readings of one thing and only confuses.
  const part = Number.isFinite(limit.percentage) ? Math.max(0, Math.min(1, limit.percentage / 100))
    : Number.isFinite(limit.currentValue) && Number.isFinite(limit.usage) && limit.usage > 0 ? Math.max(0, Math.min(1, limit.currentValue / limit.usage)) : undefined
  if (part === undefined) return undefined
  return {
    ...named,
    part,
    ...(Number.isFinite(limit.nextResetTime) ? { resetsAt: limit.nextResetTime } : {}),
  }
}

/** The quota response body as a GeckIt usage object, or a reason it is missing. */
export function parseQuota(body, measuredAt) {
  const limits = body?.data?.limits ?? body?.limits
  if (!Array.isArray(limits)) return { unavailableReason: UNAVAILABLE, measuredAt }
  const quotas = limits.map(quotaRow).filter((row) => row !== undefined)
  if (quotas.length === 0) return { unavailableReason: UNAVAILABLE, measuredAt }
  return { quotas, measuredAt }
}

/**
 * Reads and caches the plan quota. One read is in flight at a time; a fresh
 * result is reused for ten minutes, and a turn's end refreshes it in the
 * background. Every failure is an `unavailableReason`, cached briefly so a
 * broken setup is not retried on every call.
 */
export class Quota {
  constructor({ environment = process.env, run = execFile, fetch: doFetch = fetch, now = Date.now, readToken, log = () => {} } = {}) {
    this.environment = environment
    this.run = run
    this.fetch = doFetch
    this.now = now
    this.readToken = readToken ?? (() => this.decryptToken())
    this.log = log
    this.cached = undefined
    this.flight = undefined
  }

  async decryptToken() {
    if (this.environment.GECKIT_ZCODE_NO_QUOTA === '1') throw new Error('disabled')
    if (process.platform !== 'darwin') throw new Error('platform')
    const path = credentialsPath(this.environment)
    const store = JSON.parse(await readFile(path, 'utf8'))
    if (typeof store[TOKEN_KEY] !== 'string') throw new Error('token')
    const key = await readKey(path, this.run)
    return decryptValue(store[TOKEN_KEY], key)
  }

  async fetchOnce() {
    const measuredAt = this.now()
    let token
    try { token = await this.readToken() } catch { return { unavailableReason: UNAVAILABLE, measuredAt } }
    try {
      const response = await this.fetch(quotaUrl(this.environment), { headers: { Authorization: token, 'X-ZCode-App-Version': '0.17.1', Accept: 'application/json' } })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || !(body?.code === 0 || body?.code === 200)) return { unavailableReason: body?.msg ? `ZCode quota: ${body.msg}` : UNAVAILABLE, measuredAt }
      return parseQuota(body, measuredAt)
    } catch {
      return { unavailableReason: UNAVAILABLE, measuredAt }
    } finally {
      token = undefined
    }
  }

  /** The quota, fresh within ten minutes, concurrent reads coalesced. */
  async read() {
    if (this.cached !== undefined && this.now() - this.cached.measuredAt < FRESH_MS) return this.cached
    this.flight ??= this.fetchOnce().then((usage) => { this.cached = usage; this.flight = undefined; return usage }, (error) => { this.flight = undefined; throw error })
    return this.flight
  }

  /** After a turn: refresh unless a read just happened, for a live usage signal. */
  async afterTurn() {
    this.cached = undefined
    return this.read().catch(() => undefined)
  }
}
