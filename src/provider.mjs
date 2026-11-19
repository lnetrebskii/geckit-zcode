// The GeckIt provider contract over the person's own headless `zcode`.
// GeckIt sees `plugin:zcode:<id>`; only the native part crosses into zcode.
// A new conversation starts as `new-<uuid>` and is renamed by GeckIt to the
// `sess_…` id zcode gives it, which the `started` signal says.

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

import { findZcode, zcodeProgram } from './zcode-cli.mjs'
import { holdZcode } from './zcode-driver.mjs'
import { linksIn } from './links.mjs'
import { Journal, NATIVE_ID, journalFolder } from './zcode-journal.mjs'
import { Quota } from './zcode-quota.mjs'
import { modelOverrides } from './model-overrides.mjs'

const FAMILY = 'plugin:zcode'
const PROVISIONAL = /^new-[0-9a-f-]{36}$/
const PLAN_UNAVAILABLE = 'ZCode does not report plan quota to other programs; check it in ZCode Desktop.'

const nativeId = (id) => {
  if (typeof id !== 'string' || !id.startsWith(`${FAMILY}:`)) throw new Error('This conversation does not belong to ZCode.')
  const native = id.slice(FAMILY.length + 1)
  if (!NATIVE_ID.test(native) && !PROVISIONAL.test(native)) throw new Error('Not a ZCode conversation id.')
  return native
}
const mine = (id) => `${FAMILY}:${id}`

const INFO = {
  id: FAMILY,
  family: FAMILY,
  name: 'ZCode',
  shortName: 'ZCode',
  icon: 'zcode',
  loginCommand: 'zcode login',
  planName: 'Z.ai Coding Plan',
  resumeCommand: 'zcode --resume {id}',
  available: true,
  localOnly: true,
  subscriptionOnly: true,
  images: true,
  remoteControl: false,
  nativeGoals: true,
  idleMs: 10 * 60_000,
  waitForExit: true,
}

/** What zcode is here, and what it says about the plan: nothing it does not report. */
function programMembers(zcode, quota) {
  return {
    account: async () => {
      const found = await zcode()
      if (found.unusable !== undefined) return { provider: FAMILY, here: false, signedIn: undefined, usage: { unavailableReason: found.unusable } }
      const program = await zcodeProgram(found)
      const usage = await quota.read().catch(() => ({ unavailableReason: PLAN_UNAVAILABLE }))
      return { provider: FAMILY, here: program !== undefined, signedIn: undefined, ...(program === undefined ? {} : { program }), usage }
    },
    program: async () => zcodeProgram(await zcode()),
    // zcode has no public command that lists its models; it runs the one the person chose in ZCode.
    models: async () => undefined,
    limits: async (models) => {
      const usage = await quota.read().catch(() => ({ unavailableReason: PLAN_UNAVAILABLE }))
      return {
        windows: new Map(models.map((model) => [model, modelOverrides.get(model)?.contextWindow])),
        ...(usage.quotas === undefined ? { unavailableReason: usage.unavailableReason ?? PLAN_UNAVAILABLE } : { quotas: usage.quotas }),
      }
    },
  }
}

/** Lists, reads and housekeeping, all from the journal of what this plugin saw. */
function journalMembers(journal, log) {
  return {
    list: async (roots) => (await journal.list(roots.filter((root) => isAbsolute(root)))).map((row) => ({ ...row, id: mine(row.id) })),
    search: async (roots, asked) => (await journal.search(roots, asked)).map((found) => ({ ...found, id: mine(found.id) })),
    hidden: async () => [],
    create: async () => mine(`new-${randomUUID()}`),
    fork: async () => { throw new Error('ZCode conversations cannot be forked from GeckIt.') },
    has: async (_root, id) => (await journal.get(nativeId(id))) !== undefined,
    read: async (_root, id) => {
      const record = await journal.get(nativeId(id))
      if (record === undefined) return undefined
      return {
        items: record.items,
        tasks: [],
        ...(record.window === undefined ? {} : { window: record.window }),
        ...(record.goal === undefined ? {} : { goal: { condition: record.goal.condition, checks: 0 } }),
      }
    },
    links: async (_root, id) => linksIn((await journal.get(nativeId(id)))?.items ?? []),
    rename: async (id, name) => {
      const record = await journal.get(nativeId(id))
      if (record === undefined) return
      record.title = name
      await journal.save(record)
    },
    delete: async (_root, id) => {
      const native = nativeId(id)
      if ((await journal.get(native)) === undefined) return false
      await journal.forget(native)
      log('info', 'session.forgotten', { session: native })
      return true
    },
  }
}

/** Goals as zcode runs them: `/goal <objective>` through the held conversation. */
function goalMembers(journal, drivers, log) {
  const goals = new Map()
  const heldFor = (native) => [...drivers.values()].find((driver) => driver.sessionId() === native) ?? drivers.get(native)
  return {
    goal: async (_root, id) => {
      const native = nativeId(id)
      const condition = goals.get(native) ?? (await journal.get(native))?.goal?.condition
      return condition === undefined ? undefined : { goal: { condition, checks: 0 } }
    },
    setGoal: async (id, objective) => {
      const native = nativeId(id)
      const held = heldFor(native)
      if (held === undefined) throw new Error('Open the ZCode conversation to give it a goal.')
      goals.set(native, objective)
      held.startGoal(objective)
      log('info', 'goal.started', { session: native })
      return { goal: { condition: objective, checks: 0 }, status: 'active' }
    },
    clearGoal: async (id) => {
      const native = nativeId(id)
      goals.delete(native)
      const record = await journal.get(native)
      if (record?.goal === undefined) return
      delete record.goal
      await journal.save(record)
    },
  }
}

/**
 * A Driver that exists at once, while zcode is found. Only a message turns a
 * missing zcode into an ended turn; anything else waits or is dropped.
 */
function holdMember({ zcode, journal, drivers, quota, log }) {
  return (options, hear, left) => {
    const native = nativeId(options.id)
    const forward = (heard) => hear({ ...heard, signals: heard.signals.map((signal) => (signal.kind === 'started' ? { ...signal, session: mine(signal.session) } : signal)) })
    const leave = () => { drivers.delete(native); log('info', 'session.closed', { session: native }); left() }
    const ready = zcode().then((found) => {
      if (found.unusable !== undefined) throw new Error(found.unusable)
      return holdZcode({ ...options, id: native }, { found, journal, quota, log }, forward, leave)
    })
    let held
    void ready.then((one) => { held = one }, () => {})
    const later = (use) => { void ready.then(use, () => {}) }
    const driver = {
      send: (...args) => {
        log('info', 'message.send.requested', { session: native })
        void ready.then((one) => one.send(...args), (error) => hear({ items: [], gone: [], signals: [{ kind: 'ended', how: 'failed', text: error.message }] }))
      },
      answer: (...args) => later((one) => one.answer(...args)),
      permit: (...args) => later((one) => one.permit(...args)),
      stop: () => later((one) => one.stop()),
      startGoal: (objective) => later((one) => one.startGoal(objective)),
      sessionId: () => held?.sessionId() ?? (NATIVE_ID.test(native) ? native : undefined),
      end: async () => { const one = await ready.catch(() => undefined); if (one === undefined) leave(); else await one.end() },
      leave: () => { void driver.end() },
    }
    drivers.set(native, driver)
    return driver
  }
}

export function create(context = {}) {
  const log = (level, event, fields) => { try { context.log?.write(level, event, fields) } catch { /* logging never breaks a turn */ } }
  const journal = new Journal(journalFolder(context.log?.path))
  const drivers = new Map()
  const quota = new Quota({ log: (level, event, fields) => log(level, event, fields) })
  let finding
  const zcode = () => {
    finding ??= findZcode().then((found) => {
      if (found.unusable !== undefined) finding = undefined
      return found
    })
    return finding
  }
  log('info', 'provider.created')
  return {
    ...INFO,
    ...programMembers(zcode, quota),
    ...journalMembers(journal, log),
    ...goalMembers(journal, drivers, log),
    hold: holdMember({ zcode, journal, drivers, quota, log }),
    remote: async () => { throw new Error('ZCode does not support Remote Control.') },
    mcp: async () => undefined,
    browsers: async () => undefined,
    correct: async () => ({ ok: false, error: 'ZCode has no isolated text correction.' }),
    // zcode takes no extra system prompt from the command line, and the person's own files are not edited.
    setInstructions: async () => {},
    dispose: () => {
      log('info', 'provider.disposed')
      for (const driver of drivers.values()) void driver.end()
      drivers.clear()
    },
  }
}
