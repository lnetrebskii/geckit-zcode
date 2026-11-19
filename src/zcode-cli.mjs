// Finding the person's own `zcode` and starting it the way its host contract
// (zcode-app-cli docs/HOST_INTEGRATION.md, contract version 1) asks: the
// published bin only, the project as the working directory, nothing of
// GeckIt's in its environment.

import { execFile } from 'node:child_process'
import { access, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

export const COMMAND_VARIABLE = 'GECKIT_ZCODE_COMMAND'
/** The runtime refuses older Node (`node:sqlite`); its package says so in `engines`. */
const NODE_AT_LEAST = [22, 19, 0]

const runnable = (path) => access(path, constants.X_OK).then(() => true, () => false)

/** Every place a published `zcode` bin may be, the most deliberate first. */
async function candidates(environment) {
  const found = []
  const override = environment[COMMAND_VARIABLE]?.trim()
  if (override) found.push({ path: override, from: 'GECKIT_ZCODE_COMMAND' })
  for (const folder of (environment.PATH ?? '').split(delimiter)) {
    if (folder !== '') found.push({ path: join(folder, 'zcode'), from: 'PATH' })
  }
  const nvm = join(homedir(), '.nvm', 'versions', 'node')
  const versions = await readdir(nvm).catch(() => [])
  versions.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)))
  for (const version of versions) found.push({ path: join(nvm, version, 'bin', 'zcode'), from: 'npm (nvm)' })
  for (const folder of ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin')]) {
    found.push({ path: join(folder, 'zcode'), from: 'npm' })
  }
  return found
}

export const parseVersion = (text) => {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  return match === null ? undefined : match.slice(1, 4).map(Number)
}

export function compareVersions(a, b) {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/** Runs a short command and answers with what it printed, or throws. */
export function runOnce(command, args, { env, cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, { env, cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) rejectPromise(Object.assign(new Error(`${String(stderr).trim() || error.message}`), { code: error.code }))
      else resolvePromise(String(stdout))
    })
  })
}

/**
 * The Node the launcher will run under. Its shebang is `env node`, so the
 * Node beside the bin is put first on PATH; that is the one checked.
 */
async function nodeBeside(bin, environment) {
  const folder = dirname(bin)
  const node = join(folder, 'node')
  const command = await runnable(node) ? node : 'node'
  const env = { ...environment, PATH: `${folder}${delimiter}${environment.PATH ?? ''}` }
  const version = parseVersion(await runOnce(command, ['--version'], { env }).catch(() => ''))
  return { folder, version, command }
}

/**
 * The zcode GeckIt starts, or why there is none. A bin under a Node too old
 * for the runtime is skipped in favour of one that works, and said when it is
 * the only one.
 */
export async function findZcode(environment = process.env) {
  let tooOld
  const seen = new Set()
  for (const candidate of await candidates(environment)) {
    if (!await runnable(candidate.path)) continue
    const path = await realpath(candidate.path).catch(() => candidate.path)
    if (seen.has(path)) continue
    seen.add(path)
    const node = await nodeBeside(candidate.path, environment)
    if (compareVersions(node.version, NODE_AT_LEAST) < 0) {
      tooOld ??= { ...candidate, node: node.version?.join('.') }
      continue
    }
    return { command: candidate.path, path, from: candidate.from, nodeFolder: node.folder, node: node.command }
  }
  if (tooOld !== undefined) {
    return { unusable: `zcode at ${tooOld.path} runs under Node ${tooOld.node ?? 'unknown'}; it needs Node ${NODE_AT_LEAST.join('.')} or newer.` }
  }
  return { unusable: 'zcode is not installed. Install it with `npm install -g zcode-app-cli` and sign in with `zcode login`.' }
}

/**
 * What zcode is started with: GeckIt's own variables left out, so nothing of
 * GeckIt's reaches it unasked, and the Node beside the bin first on PATH.
 */
export function zcodeEnvironment(found, environment = process.env, extra = {}) {
  const clean = {}
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith('GECKIT_')) clean[key] = value
  }
  clean.PATH = `${found.nodeFolder}${delimiter}${clean.PATH ?? ''}`
  return { ...clean, ...extra }
}

/** `zcode --version` says both layers: `zcode-app-cli 3.18.2-47` and `zcode-runtime 0.17.1`. */
export function parseProgram(stdout) {
  const cli = /zcode-app-cli\s+(\S+)/.exec(stdout ?? '')
  const runtime = /zcode-runtime\s+(\S+)/.exec(stdout ?? '')
  if (cli === null && runtime === null) return undefined
  return { version: cli?.[1] ?? runtime[1], ...(runtime === null ? {} : { runtime: runtime[1] }) }
}

/** The zcode that answers, as it says for itself, with where it came from. */
export async function zcodeProgram(found, environment = process.env) {
  if (found.unusable !== undefined) return undefined
  const stdout = await runOnce(found.command, ['--version'], { env: zcodeEnvironment(found, environment) }).catch(() => undefined)
  const program = parseProgram(stdout)
  return program === undefined ? undefined : { version: program.version, from: found.from, path: found.path }
}
