import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { checkManifest, checkProvider } from './fixtures/geckit-loader.mjs'

test('GeckIt accepts the manifest and the built entry as a provider library', async () => {
  const manifest = checkManifest(JSON.parse(await readFile(new URL('../geckit-plugin.json', import.meta.url), 'utf8')))
  assert.equal(manifest.provider.id, 'plugin:zcode')
  assert.equal('transport' in manifest.provider, false, 'an independent plugin never names a transport')
  const entry = await import(`${pathToFileURL(new URL('../index.mjs', import.meta.url).pathname).href}?install=${Date.now()}`)
  assert.equal(typeof entry.create, 'function')
  const provider = entry.create({ log: { path: '/nonexistent/provider-logs/plugin-zcode.jsonl', write: () => {} } })
  try {
    checkProvider(provider, manifest)
    for (const key of ['resumeCommand', 'loginCommand', 'planName', 'name']) assert.equal(provider[key], manifest.provider[key], key)
  } finally {
    provider.dispose()
  }
})
