import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as wait } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))

/** A private world: a fake `zcode` beside a Node that runs it, a HOME, a project. */
export async function world() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'gz-test-')))
  const bin = join(base, 'bin')
  const home = join(base, 'home')
  const root = join(base, 'project')
  for (const folder of [bin, home, join(home, '.zcode', 'cli'), root]) await mkdir(folder, { recursive: true })
  await symlink(process.execPath, join(bin, 'node'))
  await writeFile(join(bin, 'zcode'), `#!/bin/sh\nexec "$(dirname "$0")/node" '${join(here, 'fake-zcode.mjs')}' "$@"\n`)
  await chmod(join(bin, 'zcode'), 0o755)
  const userSettings = join(home, '.zcode', 'cli', 'setting.json')
  await writeFile(userSettings, JSON.stringify({ permission: { mode: 'build' }, hooks: { enabled: false, events: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } } }, null, 2))
  const logs = []
  const environment = {
    HOME: home,
    ZCODE_DATA_BASE_DIR: home,
    GECKIT_ZCODE_COMMAND: join(bin, 'zcode'),
    FAKE_ZCODE_STATE: join(base, 'state'),
    FAKE_ZCODE_LOG: join(base, 'calls.jsonl'),
    GECKIT_SECRET_FOR_TEST: 'must not reach zcode',
  }
  const context = { log: { path: join(base, 'userData', 'provider-logs', 'plugin-zcode.jsonl'), write: (level, event, fields) => logs.push({ level, event, fields }) } }
  return { base, bin, home, root, userSettings, logs, environment, context }
}

/** Runs `work` with the world's variables set, restoring them afterwards. */
export async function within(place, work) {
  const before = {}
  for (const [key, value] of Object.entries(place.environment)) {
    before[key] = process.env[key]
    process.env[key] = value
  }
  try {
    return await work()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** A held conversation and everything it has heard. */
export function listen(provider, options) {
  const heard = { items: new Map(), signals: [], left: false }
  const driver = provider.hold(options, (one) => {
    for (const item of one.items) heard.items.set(item.id, item)
    heard.signals.push(...one.signals)
  }, () => { heard.left = true })
  return { driver, heard }
}

export async function until(check, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const found = check()
    if (found) return found
    await wait(20)
  }
  throw new Error(`Timed out waiting for ${what}.`)
}

export const endings = (heard) => heard.signals.filter((signal) => signal.kind === 'ended')

export async function calls(place) {
  const text = await readFile(place.environment.FAKE_ZCODE_LOG, 'utf8').catch(() => '')
  return text.trim() === '' ? [] : text.trim().split('\n').map((line) => JSON.parse(line))
}
