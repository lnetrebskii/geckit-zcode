// A zcode installed through fnm lives where only an interactive shell would
// look; GeckIt starts from the minimal launchd PATH, so the plugin has to find
// these layouts itself. `homedir()` reads `HOME`, so a temporary HOME gives us
// a private fnm tree to point the finder at.

import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { findZcode } from '../src/zcode-cli.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/** A runnable fake `zcode` with a modern `node` beside it, as the finder needs. */
async function fakeZcode(folder) {
  await mkdir(folder, { recursive: true })
  await symlink(process.execPath, join(folder, 'node'))
  await writeFile(join(folder, 'zcode'), `#!/bin/sh\nexec "$(dirname "$0")/node" '${join(here, 'fake-zcode.mjs')}' "$@"\n`)
  await chmod(join(folder, 'zcode'), 0o755)
}

/** Runs `work` with `HOME` set to `home`, restoring it afterwards. */
async function withHome(home, work) {
  const before = process.env.HOME
  process.env.HOME = home
  try {
    return await work()
  } finally {
    if (before === undefined) delete process.env.HOME
    else process.env.HOME = before
  }
}

test('finds a zcode installed through fnm, which a GUI PATH would hide', async () => {
  const home = join(await realpath(await mkdtemp(join(tmpdir(), 'gz-fnm-'))), 'home')
  const bin = join(home, '.local', 'share', 'fnm', 'node-versions', 'v24.15.0', 'installation', 'bin')
  await fakeZcode(bin)
  const found = await withHome(home, () => findZcode({ PATH: '' }))
  assert.equal(found.unusable, undefined, found.unusable)
  assert.equal(found.command, join(bin, 'zcode'))
  assert.equal(found.from, 'npm (fnm)')
})

test('finds a zcode through the fnm default alias', async () => {
  const home = join(await realpath(await mkdtemp(join(tmpdir(), 'gz-fnm-'))), 'home')
  const fnm = join(home, '.local', 'share', 'fnm')
  const installation = join(fnm, 'node-versions', 'v24.15.0', 'installation')
  await fakeZcode(join(installation, 'bin'))
  await mkdir(join(fnm, 'aliases'), { recursive: true })
  await symlink(installation, join(fnm, 'aliases', 'default'))
  const found = await withHome(home, () => findZcode({ PATH: '' }))
  assert.equal(found.unusable, undefined, found.unusable)
  assert.equal(found.command, join(fnm, 'aliases', 'default', 'bin', 'zcode'))
  assert.equal(found.from, 'npm (fnm default)')
})

test('honours FNM_DIR when fnm keeps its Nodes elsewhere', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'gz-fnm-')))
  const home = join(base, 'home')
  await mkdir(home, { recursive: true })
  const fnm = join(base, 'custom-fnm')
  const bin = join(fnm, 'node-versions', 'v24.15.0', 'installation', 'bin')
  await fakeZcode(bin)
  const found = await withHome(home, () => findZcode({ PATH: '', FNM_DIR: fnm }))
  assert.equal(found.unusable, undefined, found.unusable)
  assert.equal(found.command, join(bin, 'zcode'))
  assert.equal(found.from, 'npm (fnm)')
})
