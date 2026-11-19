// What one `zcode -p … --output-format stream-json` run says, as GeckIt's
// items and signals. Pure: no process, no clock beyond the events' own times.
//
// Event shapes were recorded from zcode-app-cli 3.18.2-47 (runtime 0.17.1);
// see test/fixtures/live. Every line is `{type, sessionId, turnId, payload}`
// except the last, `{type: "result", sessionId, response, usage, projection}`.

import { isAbsolute, relative } from 'node:path'

const DETAIL_LIMIT = 8_000
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'Shell', 'BashOutput'])

const shorten = (text, limit = DETAIL_LIMIT) => (text.length > limit ? `${text.slice(0, limit)}\n…` : text)
const firstLine = (text) => String(text ?? '').split('\n')[0].slice(0, 200)

/** A path as the project names it where it is inside the project. */
export function shownPath(root, path) {
  if (typeof path !== 'string' || path === '') return undefined
  if (!isAbsolute(path)) return path
  const inside = relative(root, path)
  return inside === '' || inside.startsWith('..') || isAbsolute(inside) ? path : inside
}

const fileOf = (input) => (typeof input?.file_path === 'string' ? input.file_path : typeof input?.path === 'string' ? input.path : undefined)

/** "Write src/a.ts", "Bash npm test": one line saying what a tool call does. */
export function describeTool(root, name, input = {}) {
  if (SHELL_TOOLS.has(name) && typeof input.command === 'string') return `${name} ${firstLine(input.command)}`
  const file = fileOf(input)
  if (file !== undefined) return `${name} ${shownPath(root, file)}`
  if (typeof input.url === 'string') return `${name} ${input.url}`
  for (const key of ['pattern', 'query', 'description', 'prompt']) {
    if (typeof input[key] === 'string') return `${name} ${firstLine(input[key])}`
  }
  return name
}

/** What a tool wants, as a GeckIt permission card asks it. */
export function wantedOf(name, input = {}) {
  if (SHELL_TOOLS.has(name) && typeof input.command === 'string') return { kind: 'command', command: input.command }
  const file = fileOf(input)
  if (WRITE_TOOLS.has(name) && file !== undefined) return { kind: 'write', paths: [file] }
  if (name === 'Read' && file !== undefined) return { kind: 'read', path: file }
  if (typeof input.url === 'string' && /^https?:\/\//.test(input.url)) return { kind: 'web', url: input.url }
  return { kind: 'other', tool: name, detail: shorten(JSON.stringify(input, null, 2), 4_000) }
}

/** How a turn ended, from what zcode said about why. Unknown stays `failed`. */
export function endingOf(text) {
  const said = String(text ?? '')
  if (/\b(401|403)\b|unauthori[sz]ed|not (signed|logged) in|sign in|log ?in again|credential|token (expired|invalid)/i.test(said)) return 'signedOut'
  if (/\b429\b|rate.?limit|quota|usage limit|too many requests|insufficient (balance|credit)/i.test(said)) return 'limit'
  return 'failed'
}

const errorText = (error) => [error?.message, error?.detail, error?.code, error?.type].filter((part) => typeof part === 'string' && part !== '').join(' · ')

/**
 * One turn being read. `feed` takes one parsed line and answers with what
 * changed; `finish` says how the turn ended once the process has exited.
 */
export function turnReader(root) {
  const texts = new Map()
  const thoughts = new Map()
  const tools = new Map()
  const state = { session: undefined, model: undefined, completed: false, failure: undefined, result: undefined, denied: [], askedUser: false }

  const theirs = (id, at) => ({ kind: 'theirs', id: `zcode:${id}`, text: texts.get(id), ...(at === undefined ? {} : { at }) })

  function streamed(payload, at, out) {
    const id = payload.assistantMessageId
    if (payload.kind === 'text_delta' && typeof payload.delta === 'string' && payload.delta !== '') {
      texts.set(id, `${texts.get(id) ?? ''}${payload.delta}`)
      out.items.push(theirs(id, at))
    } else if (payload.kind === 'reasoning_delta' && typeof payload.delta === 'string' && payload.delta !== '') {
      thoughts.set(id, `${thoughts.get(id) ?? ''}${payload.delta}`)
      out.items.push({ kind: 'thought', id: `zcode:${id}:thinking`, text: thoughts.get(id) })
    } else if (payload.kind === 'tool_call') {
      const file = fileOf(payload.input)
      const tool = { name: payload.toolName, input: payload.input ?? {} }
      tools.set(payload.toolCallId, tool)
      out.items.push(didItem(payload.toolCallId, tool, true))
      if (WRITE_TOOLS.has(tool.name) && file !== undefined) out.signals.push({ kind: 'writing', paths: [file] })
    }
  }

  function didItem(id, tool, live, detail) {
    const file = fileOf(tool.input)
    const path = file === undefined ? undefined : shownPath(root, file)
    return {
      kind: 'did',
      id: `zcode:${id}`,
      what: describeTool(root, tool.name, tool.input),
      live,
      ...(detail === undefined ? {} : { detail }),
      ...(path === undefined || isAbsolute(path) ? {} : { path }),
    }
  }

  function toolResult(payload, out) {
    const tool = tools.get(payload.toolCallId)
    if (tool === undefined) return
    const result = payload.result ?? {}
    const content = typeof result.content === 'string' ? result.content : typeof result.error === 'string' ? result.error : undefined
    out.items.push(didItem(payload.toolCallId, tool, false, content === undefined ? undefined : shorten(content)))
    const file = fileOf(tool.input)
    if (result.success === true && WRITE_TOOLS.has(tool.name) && file !== undefined) {
      out.items.push({ kind: 'wrote', id: `zcode:${payload.toolCallId}:wrote`, paths: [file] })
    }
  }

  function sessionUpdated(payload, out) {
    if (typeof payload.providerId === 'string' && typeof payload.modelId === 'string' && state.model === undefined) {
      state.model = `${payload.providerId}/${payload.modelId}`
    }
    if (payload.status === 'tool_started' && typeof payload.toolName === 'string') {
      out.signals.push({ kind: 'doing', what: describeTool(root, payload.toolName, payload.input) })
    }
    const usage = payload.usage
    if (Number.isFinite(payload.contextWindow) && Number.isFinite(usage?.inputTokens) && Number.isFinite(usage?.outputTokens)) {
      out.signals.push({ kind: 'spend', used: usage.inputTokens + usage.outputTokens, window: payload.contextWindow })
    }
  }

  function feed(event) {
    const out = { items: [], signals: [] }
    if (event === null || typeof event !== 'object') return out
    if (typeof event.sessionId === 'string' && event.sessionId.startsWith('sess_')) state.session ??= event.sessionId
    const payload = event.payload ?? {}
    const at = Number.isFinite(event.timestamp) ? event.timestamp : undefined
    switch (event.type) {
      case 'model.streaming': streamed(payload, at, out); break
      case 'tool.updated': if (payload.kind === 'result') toolResult(payload, out); break
      case 'session.updated': sessionUpdated(payload, out); break
      case 'permission.resolved': if (payload.decision === 'deny') state.denied.push(payload.reason ?? ''); break
      case 'userInput.requested': state.askedUser = true; break
      case 'turn.completed': state.completed = true; break
      case 'turn.failed': state.failure = errorText(payload.error) || 'ZCode reported a failed turn.'; break
      case 'result': state.result = event; resultSpend(event, out); break
      default: break
    }
    return out
  }

  function resultSpend(event, out) {
    const projection = event.projection ?? {}
    if (Number.isFinite(projection.contextUsed) && Number.isFinite(projection.contextWindow)) {
      out.signals.push({ kind: 'spend', used: projection.contextUsed, window: projection.contextWindow })
    }
  }

  /** The ending signal, from what was read and how the process exited. */
  function finish({ code, signal, stopped, stderr }) {
    if (stopped || code === 130 || code === 143 || signal === 'SIGINT' || signal === 'SIGTERM') {
      return { kind: 'ended', how: 'stopped' }
    }
    if (code === 0 && state.result !== undefined && state.failure === undefined) return { kind: 'ended', how: 'done' }
    const said = state.failure ?? firstLine(stderr).trim() ?? ''
    const text = said !== '' ? said : `zcode exited with ${code ?? signal} before finishing the turn.`
    return { kind: 'ended', how: endingOf(text), text }
  }

  /** The answer, for a goal run whose only output is its final JSON. */
  function finalAnswer(record) {
    if (typeof record?.sessionId === 'string') state.session ??= record.sessionId
    state.result = record
    if (typeof record?.response !== 'string' || record.response === '') return []
    texts.set('final', record.response)
    return [{ kind: 'theirs', id: `zcode:${record.traceId ?? 'final'}`, text: record.response }]
  }

  return { feed, finish, finalAnswer, state }
}
