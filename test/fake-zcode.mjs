// A stand-in for the published `zcode` bin, speaking the stream-json shapes
// recorded from zcode-app-cli 3.18.2-47 (test/fixtures/live). It runs the
// PreToolUse hooks from ZCODE_CLI_SETTINGS_FILE the way zcode does, so the
// approval path is exercised through a real hook process.
//
// Prompts choose the scenario: "write <name>" asks to write a file, "wait"
// runs until SIGINT, "fail auth" / "fail quota" fail the turn, "/goal …" is a
// goal run, anything else is answered with "echo: <prompt>".

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const all = (name) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []))
const state = process.env.FAKE_ZCODE_STATE
if (process.env.FAKE_ZCODE_LOG) {
  appendFileSync(process.env.FAKE_ZCODE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), geckitVariables: Object.keys(process.env).filter((key) => key.startsWith('GECKIT_') && key !== 'GECKIT_ZCODE_APPROVAL_SOCKET'), settings: process.env.ZCODE_CLI_SETTINGS_FILE ?? null })}\n`)
}

if (args.includes('--version')) {
  process.stdout.write('zcode-app-cli 9.9.9-1\nzcode-runtime 0.17.1\n')
  process.exit(0)
}

const prompt = option('-p')
if (prompt === undefined) { process.stderr.write('fake zcode: only -p is supported\n'); process.exit(2) }

let session = option('--resume')
if (session !== undefined && !existsSync(join(state, session))) {
  process.stderr.write(`Error: Session not found: ${session}\n`)
  process.exit(1)
}
session ??= `sess_${randomUUID()}`
mkdirSync(state, { recursive: true })
writeFileSync(join(state, session), 'kept')

const turnId = `turn_${randomUUID()}`
const message = `msg_${randomUUID()}`
let seq = 0
const emit = (type, payload) => process.stdout.write(`${JSON.stringify({ eventId: randomUUID(), payload, seq: ++seq, sessionId: session, timestamp: Date.now(), traceId: 't', turnId, type })}\n`)
const stream = (kind, extra = {}) => emit('model.streaming', { assistantMessageId: message, delta: '', done: kind === 'finish', kind, ...extra })
const say = (text) => {
  stream('text_start')
  for (const part of text.match(/.{1,4}/gs) ?? []) stream('text_delta', { delta: part })
  stream('text_end')
}
const finish = (text) => {
  stream('finish')
  emit('session.updated', { content: text, contextWindow: 200000, usage: { inputTokens: 1000, outputTokens: 20, totalTokens: 1020 } })
  emit('turn.completed', { response: text, resultType: 'success' })
  process.stdout.write(`${JSON.stringify({ type: 'result', sessionId: session, traceId: 't', turnId, response: text, usage: { totalTokens: 1020 }, projection: { status: 'idle', contextUsed: 1020, contextWindow: 200000 } })}\n`)
  process.exit(0)
}

if (prompt.startsWith('/goal ')) {
  process.stdout.write(`${JSON.stringify({ sessionId: session, traceId: 'goal', response: `goal reached: ${prompt.slice(6)}` }, null, 2)}\n`)
  process.exit(0)
}

emit('turn.started', { input: prompt, messageId: `msg_user_${seq}`, inputId: `query_${seq}` })
emit('session.updated', { messageCount: 1, providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3', iteration: 0 })
stream('start')
stream('reasoning_start')
stream('reasoning_delta', { delta: 'Thinking.' })
stream('reasoning_end')

/** The settings' PreToolUse hooks, run as zcode runs them; the last decision wins. */
async function preToolUse(toolName, toolInput, toolCallId) {
  const settings = JSON.parse(readFileSync(process.env.ZCODE_CLI_SETTINGS_FILE, 'utf8'))
  if (settings.hooks?.enabled !== true) return undefined
  let decision
  for (const matcher of settings.hooks.events?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      const output = await new Promise((done) => {
        const child = spawn('/bin/sh', ['-c', hook.command], { stdio: ['pipe', 'pipe', 'inherit'] })
        let out = ''
        child.stdout.on('data', (chunk) => { out += chunk })
        child.on('close', () => done(out))
        child.stdin.end(JSON.stringify({ hookEventName: 'PreToolUse', mode: option('--mode') ?? 'yolo', riskLevel: 'medium', sessionId: session, sideEffectScope: 'workspace', toolCallId, toolInput, toolName, turnId }))
      })
      if (output.trim() !== '') decision = JSON.parse(output).hookSpecificOutput?.permissionDecision ?? decision
    }
  }
  return decision
}

async function write(name) {
  const toolCallId = `call_${randomUUID().slice(0, 8)}`
  const input = { file_path: join(process.cwd(), name), content: 'hi' }
  stream('tool_call', { toolCallId, toolName: 'Write', input })
  emit('session.updated', { toolCallId, toolName: 'Write', status: 'tool_started', input, sideEffectScope: 'workspace' })
  const decision = await preToolUse('Write', input, toolCallId)
  if (decision === 'allow') {
    writeFileSync(input.file_path, 'hi')
    emit('tool.updated', { toolCallId, result: { success: true, content: `File created successfully at: ${input.file_path}` }, kind: 'result' })
    say(`Wrote ${name}.`)
    finish(`Wrote ${name}.`)
  } else {
    emit('permission.requested', { requestId: 'perm_1', toolCallId, toolName: 'Write', input })
    emit('permission.resolved', { requestId: 'perm_1', toolCallId, decision: 'deny', reason: 'No permission client configured for Write' })
    emit('tool.updated', { toolCallId, result: { success: false, content: 'denied' }, kind: 'result' })
    say('I could not write it.')
    finish('I could not write it.')
  }
}

if (prompt.startsWith('write ')) await write(prompt.slice(6).trim())
else if (prompt === 'wait') {
  say('Working')
  process.on('SIGINT', () => process.exit(130))
  setInterval(() => {}, 1_000)
} else if (prompt.startsWith('fail ')) {
  const quota = prompt.includes('quota')
  emit('turn.failed', { error: { type: 'ProviderError', message: quota ? 'HTTP 429: usage limit reached for this plan' : 'HTTP 401: token expired, please log in again' } })
  process.stderr.write('turn failed\n')
  process.exit(1)
} else {
  const attached = all('--attach')
  const text = `echo: ${prompt}${attached.length === 0 ? '' : ` (+${attached.length} image)`}`
  say(text)
  finish(text)
}
