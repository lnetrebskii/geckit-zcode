// One ZCode conversation held for GeckIt. Every message is one headless run:
// `zcode -p <text> [--resume <sess_id>] --mode … --output-format stream-json`.
// The process ends with the turn, so a turn ends exactly once, when its
// process has exited, and Stop is SIGINT to that process.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openApprovals } from './zcode-approval.mjs'
import { zcodeEnvironment } from './zcode-cli.mjs'
import { turnReader, wantedOf } from './zcode-events.mjs'
import { NATIVE_ID } from './zcode-journal.mjs'

/** GeckIt's modes in zcode's words. Auto runs as build with every tool request allowed by the hook. */
const ZCODE_MODE = { manual: 'build', auto: 'build', plan: 'plan' }
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const STOP_GRACE_MS = 5_000

const joined = (text, before = []) => [...before, text].filter((part) => part !== '').join('\n\n')

/** Images as private files zcode attaches with `--attach`. */
async function imageFiles(images) {
  if (images.length === 0) return { paths: [], folder: undefined }
  const folder = await mkdtemp(join(tmpdir(), 'gz-img-'))
  const paths = []
  for (const [index, image] of images.entries()) {
    const extension = IMAGE_TYPES[image.media]
    if (extension === undefined) throw new Error(`ZCode cannot attach ${image.media}.`)
    const data = Buffer.from(image.data, 'base64')
    if (data.byteLength === 0) throw new Error('An attached image is empty.')
    const path = join(folder, `image-${index + 1}.${extension}`)
    await writeFile(path, data, { mode: 0o600 })
    paths.push(path)
  }
  return { paths, folder }
}

/** Items folded by id, so one batch carries each item once, as it now stands. */
function batch() {
  const items = new Map()
  const signals = []
  return {
    add(out) {
      for (const item of out.items) items.set(item.id, item)
      signals.push(...out.signals)
    },
    take() {
      const taken = { items: [...items.values()], gone: [], signals: signals.splice(0) }
      items.clear()
      return taken
    },
  }
}

/** One held conversation: its runs, their queue, and the cards waiting on the person. */
class ZcodeConversation {
  constructor(options, deps, hear, left) {
    this.options = options
    this.root = options.root
    this.deps = deps
    this.hear = hear
    this.left = left
    this.native = options.resume === true && NATIVE_ID.test(options.id) ? options.id : undefined
    this.mode = options.mode ?? 'manual'
    this.run = undefined
    this.queue = []
    this.asks = new Map()
    this.approvals = undefined
    this.record = undefined
    this.knowing = undefined
    this.model = undefined
    this.started = false
    this.ended = false
  }

  log(level, event, fields = {}) {
    this.deps.log(level, event, { session: this.native ?? this.options.id, ...fields })
  }

  say(heard) {
    if (heard.items.length > 0 || heard.gone.length > 0 || heard.signals.length > 0) this.hear(heard)
  }

  signal(signal) {
    this.say({ items: [], gone: [], signals: [signal] })
  }

  /** The native session, once zcode has named it: recorded, and said once as `started`. */
  known(session) {
    if (this.native === undefined) this.native = session
    this.knowing ??= (async () => {
      this.record ??= await this.deps.journal.open(this.native, this.root, this.run?.prompt)
      if (this.started) return
      this.started = true
      this.signal({ kind: 'started', session: this.native, key: false, mode: this.mode })
    })()
    return this.knowing
  }

  decide(request) {
    if (this.mode === 'auto') return { decision: 'allow', reason: 'Allowed in Auto mode.' }
    return new Promise((resolvePromise) => {
      this.asks.set(request.ask, resolvePromise)
      const wanted = wantedOf(request.toolName, request.toolInput ?? {})
      this.log('info', 'approval.asked', { tool: String(request.toolName ?? '') })
      this.signal({ kind: 'asks', ask: request.ask, wanted, ...(request.toolCallId === undefined ? {} : { line: `zcode:${request.toolCallId}` }) })
    })
  }

  settle(ask, decided) {
    const resolvePromise = this.asks.get(ask)
    if (resolvePromise === undefined) return
    this.asks.delete(ask)
    resolvePromise(decided)
    this.signal({ kind: 'resolved', ask })
  }

  settleAll(decided) {
    for (const ask of [...this.asks.keys()]) this.settle(ask, decided)
  }

  async launch(run) {
    this.approvals ??= await openApprovals({ decide: (request) => this.decide(request), node: this.deps.found.node, environment: this.deps.environment, log: this.deps.log })
    const extra = await this.approvals.prepare()
    const files = await imageFiles(run.images)
    run.imageFolder = files.folder
    const model = this.options.model
    const args = [
      '-p', run.prompt,
      ...(this.native === undefined ? [] : ['--resume', this.native]),
      '--mode', ZCODE_MODE[this.mode] ?? 'build',
      ...(model === undefined || model === '' ? [] : ['--model', model]),
      ...files.paths.flatMap((path) => ['--attach', path]),
      '--output-format', 'stream-json',
    ]
    return (this.deps.spawnProcess ?? spawn)(this.deps.found.command, args, {
      cwd: this.root,
      env: zcodeEnvironment(this.deps.found, this.deps.environment, extra),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  read(run, child) {
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const pending = batch()
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        this.line(run, buffer.slice(0, newline), pending)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      this.say(pending.take())
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { run.stderr = `${run.stderr}${chunk}`.slice(-4_000) })
    child.once('error', (error) => { run.stderr = `${run.stderr}\n${error.message}`; void this.finish(run, { code: null, signal: null }) })
    child.once('close', (code, signal) => {
      if (buffer.trim() !== '') run.unparsed += buffer
      void this.finish(run, { code, signal })
    })
  }

  line(run, text, pending) {
    let event
    try { event = JSON.parse(text) } catch { run.unparsed += `${text}\n`; return }
    if (event?.type === 'turn.started' && typeof event.payload?.input === 'string') {
      run.mine.push({ kind: 'mine', id: `zcode:${event.payload.messageId}`, text: event.payload.input, at: event.timestamp })
    }
    const out = run.reader.feed(event)
    const session = this.native ?? run.reader.state.session
    if (session !== undefined) void this.known(session).catch((error) => this.log('warn', 'journal.failed', { errorKind: error?.name ?? 'Error' }))
    const model = run.reader.state.model
    if (model !== undefined && model !== this.model) {
      this.model = model
      out.signals.push({ kind: 'model', model })
    }
    run.seen.push(...out.items)
    for (const signal of out.signals) if (signal.kind === 'spend') run.spend = signal
    pending.add(out)
  }

  async finish(run, exit) {
    if (run.finished) return
    run.finished = true
    this.settleAll({ decision: 'deny', reason: 'The turn ended before this was answered.' })
    const late = []
    if (run.reader.state.result === undefined && run.unparsed.trim() !== '') {
      try { late.push(...run.reader.finalAnswer(JSON.parse(run.unparsed))) } catch { /* not the final record */ }
    }
    const session = this.native ?? run.reader.state.session
    if (session !== undefined) await this.known(session).catch(() => {})
    run.seen.push(...late)
    const ended = run.reader.finish({ ...exit, stopped: run.stopped, stderr: run.stderr })
    this.log(ended.how === 'done' || ended.how === 'stopped' ? 'info' : 'warn', 'turn.ended', { outcome: ended.how, kind: run.kind })
    await this.remember(run).catch((error) => this.log('warn', 'journal.failed', { errorKind: error?.name ?? 'Error' }))
    if (run.imageFolder !== undefined) await rm(run.imageFolder, { recursive: true, force: true })
    this.say({ items: late, gone: [], signals: [ended] })
    this.run = undefined
    run.resolveDone()
    this.next()
  }

  async remember(run) {
    const record = this.record
    if (record === undefined) return
    this.deps.journal.note(record, [...run.mine, ...run.seen])
    if (run.reader.state.model !== undefined) record.model = run.reader.state.model
    if (run.spend !== undefined) Object.assign(record, { used: run.spend.used, window: run.spend.window })
    await this.deps.journal.save(record)
  }

  start(run) {
    let resolveDone
    const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })
    const current = { ...run, reader: turnReader(this.root), stderr: '', unparsed: '', seen: [], mine: [], stopped: false, finished: false, done, resolveDone }
    this.run = current
    this.log('info', 'turn.started', { kind: run.kind })
    if (run.kind === 'goal') this.signal({ kind: 'begun' })
    this.launch(current).then((child) => {
      current.child = child
      if (current.stopped) child.kill('SIGINT')
      this.read(current, child)
    }, (error) => {
      current.stderr = error?.message ?? 'zcode could not be started.'
      void this.finish(current, { code: null, signal: null })
    })
  }

  /** A run now, or after the one in progress. */
  enqueue(run) {
    if (this.run !== undefined) this.queue.push(run)
    else this.start(run)
  }

  next() {
    if (this.run !== undefined || this.ended) return
    const queued = this.queue.shift()
    if (queued !== undefined) this.start(queued)
  }

  stopRun(run) {
    run.stopped = true
    this.settleAll({ decision: 'deny', reason: 'Stopped.' })
    if (run.child === undefined) return
    run.child.kill('SIGINT')
    const term = setTimeout(() => { if (!run.finished) run.child.kill('SIGTERM') }, STOP_GRACE_MS)
    const kill = setTimeout(() => { if (!run.finished) run.child.kill('SIGKILL') }, STOP_GRACE_MS * 2)
    term.unref?.()
    kill.unref?.()
  }

  async end() {
    if (this.ended) return
    this.ended = true
    this.queue.length = 0
    const run = this.run
    if (run !== undefined) {
      this.stopRun(run)
      await run.done
    }
    await this.approvals?.close().catch(() => {})
    this.left()
  }
}

/** The GeckIt Driver for one conversation. */
export function holdZcode(options, deps, hear, left) {
  const held = new ZcodeConversation(options, deps, hear, left)
  const driver = {
    send: (text, images = [], before = []) => held.enqueue({ kind: 'message', prompt: joined(text, before), images }),
    answer(ask, answer) {
      if (answer === 'once' || answer === 'session') held.settle(ask, { decision: 'allow', reason: 'Allowed in GeckIt.' })
      else if (answer === 'no') held.settle(ask, { decision: 'deny', reason: 'The person declined this in GeckIt.' })
      else held.settle(ask, { decision: 'deny', reason: `The person answered instead: ${answer}` })
    },
    permit(mode) {
      held.mode = mode
      if (mode === 'auto') held.settleAll({ decision: 'allow', reason: 'Allowed in Auto mode.' })
    },
    stop() {
      held.queue.length = 0
      if (held.run !== undefined) held.stopRun(held.run)
    },
    startGoal(objective) {
      if (held.record !== undefined) held.record.goal = { condition: objective }
      held.enqueue({ kind: 'goal', prompt: `/goal ${objective}`, images: [] })
    },
    sessionId: () => held.native,
    end: () => held.end(),
    leave: () => { void held.end() },
  }
  return driver
}
