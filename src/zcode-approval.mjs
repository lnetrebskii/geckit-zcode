// Tool approvals for headless zcode, through ZCode's own `PreToolUse` hook.
//
// Headless zcode denies every tool that needs approval ("No permission client
// configured"), but runs the hooks in its CLI settings first, and a hook's
// `permissionDecision` decides. Each driver therefore starts zcode with
// `ZCODE_CLI_SETTINGS_FILE` pointing at a private copy of the person's own
// settings with one hook added. The hook asks this driver over a private Unix
// socket and prints the answer. The person's files are only read.

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const SOCKET_VARIABLE = 'GECKIT_ZCODE_APPROVAL_SOCKET'
/** How long a card may wait for the person before zcode is told no. */
export const HOOK_TIMEOUT_MS = 60 * 60_000

/**
 * The hook, written next to the socket for each driver. It stays out of the
 * way anywhere else: without the socket variable it says nothing, and zcode
 * decides as it always would. Plan mode and read-only tools are zcode's own.
 */
export const HOOK_SOURCE = `import { connect } from 'node:net'
const socket = process.env.${SOCKET_VARIABLE}
let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
const say = (decision, reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }))
}
let asked
try { asked = JSON.parse(input) } catch { process.exit(0) }
if (!socket || asked.hookEventName !== 'PreToolUse' || asked.mode === 'plan' || asked.sideEffectScope === 'none') process.exit(0)
const request = { toolName: asked.toolName, toolInput: asked.toolInput, toolCallId: asked.toolCallId, riskLevel: asked.riskLevel, sessionId: asked.sessionId }
await new Promise((done) => {
  let answer = ''
  const client = connect(socket, () => client.write(JSON.stringify(request) + '\\n'))
  client.setEncoding('utf8')
  client.on('data', (chunk) => { answer += chunk })
  client.on('end', () => {
    try {
      const parsed = JSON.parse(answer)
      say(parsed.decision === 'allow' ? 'allow' : 'deny', String(parsed.reason ?? ''))
    } catch { say('deny', 'GeckIt did not answer the approval.') }
    done()
  })
  client.on('error', () => { say('deny', 'GeckIt is not reachable for approvals, so this was not allowed.'); done() })
})
`

/** The person's CLI settings, as zcode itself would read them. */
export async function personSettings(environment = process.env) {
  const own = environment.ZCODE_CLI_SETTINGS_FILE?.trim()
  const path = own || join(homedir(), '.zcode', 'cli', 'setting.json')
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * The person's settings with the approval hook added. Their own hooks stay
 * as they were: kept when enabled, left off when they had switched hooks off.
 */
export function settingsWithHook(settings, hookCommand) {
  const hooks = settings.hooks ?? {}
  const theirs = hooks.enabled === false ? {} : (hooks.events ?? {})
  const ours = { hooks: [{ type: 'command', command: hookCommand, timeoutMs: HOOK_TIMEOUT_MS, onError: 'deny' }] }
  return {
    ...settings,
    hooks: {
      ...hooks,
      enabled: true,
      events: { ...theirs, PreToolUse: [...(theirs.PreToolUse ?? []), ours] },
    },
  }
}

const quoted = (path) => `'${path.replaceAll("'", "'\\''")}'`

/**
 * One driver's approval channel: a private folder holding the socket, the hook
 * and the settings copy. `decide(request)` answers each request with
 * `{decision: 'allow' | 'deny', reason}`.
 */
export async function openApprovals({ decide, node, environment = process.env, log = () => {} }) {
  const folder = await mkdtemp(join(tmpdir(), 'gz-'))
  await chmod(folder, 0o700)
  const socket = join(folder, 'ask.sock')
  const hook = join(folder, 'pretooluse.mjs')
  await writeFile(hook, HOOK_SOURCE, { mode: 0o600 })
  const server = createServer((connection) => answer(connection, decide, log))
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(socket, () => { server.off('error', rejectPromise); resolvePromise() })
  })
  await chmod(socket, 0o600)
  const settingsFolder = join(folder, 'settings')
  await mkdir(settingsFolder, { mode: 0o700 })
  const settingsFile = join(settingsFolder, 'setting.json')
  const hookCommand = `${node === 'node' ? 'node' : quoted(node)} ${quoted(hook)}`

  return {
    /** Rewritten before every turn, so a change the person made since is in. */
    async prepare() {
      const settings = settingsWithHook(await personSettings(environment), hookCommand)
      await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 })
      return { ZCODE_CLI_SETTINGS_FILE: settingsFile, [SOCKET_VARIABLE]: socket }
    },
    async close() {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
      await rm(folder, { recursive: true, force: true })
    },
  }
}

function answer(connection, decide, log) {
  let received = ''
  connection.setEncoding('utf8')
  connection.on('data', async (chunk) => {
    received += chunk
    const newline = received.indexOf('\n')
    if (newline < 0) return
    let request
    try { request = JSON.parse(received.slice(0, newline)) } catch { connection.end(JSON.stringify({ decision: 'deny', reason: 'Unreadable approval request.' })); return }
    const decided = await Promise.resolve(decide({ ...request, ask: `zcode-ask:${request.toolCallId ?? randomUUID()}` }))
      .catch(() => ({ decision: 'deny', reason: 'GeckIt could not decide.' }))
    log('info', 'approval.decided', { decision: decided.decision })
    connection.end(JSON.stringify(decided))
  })
  connection.on('error', () => {})
}
