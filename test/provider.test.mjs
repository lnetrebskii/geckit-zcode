import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { create } from '../index.mjs'
import { calls, endings, listen, until, within, world } from './helpers.mjs'

const NEW_ID = /^plugin:zcode:new-[0-9a-f-]{36}$/
const SESSION = /^plugin:zcode:sess_[0-9a-f-]+$/

async function opened(place, mode = 'manual') {
  const provider = create(place.context)
  const id = await provider.create({ root: place.root, mode })
  assert.match(id, NEW_ID)
  return { provider, id, ...listen(provider, { id, root: place.root, mode, resume: false }) }
}

test('a conversation: started with its session, streamed answer, one ending per turn, resume on the next', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('hello', [], ['$ ls\nREADME'])
    await until(() => endings(heard).length === 1, 'the first ending')
    const started = heard.signals.find((signal) => signal.kind === 'started')
    assert.match(started.session, SESSION)
    assert.equal(started.mode, 'manual', 'the mode is said in GeckIt\'s own word')
    assert.equal(started.key, false)
    assert.deepEqual(endings(heard)[0], { kind: 'ended', how: 'done' })
    assert.ok([...heard.items.values()].some((item) => item.kind === 'theirs' && item.text === 'echo: $ ls\nREADME\n\nhello'))
    assert.ok(![...heard.items.values()].some((item) => item.kind === 'mine'), 'the person\'s message is not echoed back')
    assert.ok(heard.signals.some((signal) => signal.kind === 'model' && signal.model === 'account:zai-individual-coding-plan/GLM-5.3'))
    assert.ok(heard.signals.some((signal) => signal.kind === 'spend' && signal.window === 200000))

    driver.send('again')
    await until(() => endings(heard).length === 2, 'the second ending')
    assert.equal(heard.signals.filter((signal) => signal.kind === 'started').length, 1)
    const [first, second] = await calls(place)
    assert.equal(first.args.includes('--resume'), false)
    assert.equal(second.args[second.args.indexOf('--resume') + 1], started.session.slice('plugin:zcode:'.length))
    assert.equal(first.cwd.endsWith('project'), true)

    await driver.end()
    assert.equal(heard.left, true)
    provider.dispose()
  })
})

test('Manual asks through a card and writes only when allowed; a refusal reaches zcode', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('write allowed.txt')
    const ask = await until(() => heard.signals.find((signal) => signal.kind === 'asks'), 'a card')
    assert.deepEqual(ask.wanted, { kind: 'write', paths: [join(place.root, 'allowed.txt')] })
    assert.match(ask.line, /^zcode:call_/)
    driver.answer(ask.ask, 'once')
    await until(() => endings(heard).length === 1, 'the ending')
    assert.ok(heard.signals.some((signal) => signal.kind === 'resolved' && signal.ask === ask.ask))
    assert.equal(existsSync(join(place.root, 'allowed.txt')), true)
    assert.ok([...heard.items.values()].some((item) => item.kind === 'wrote'))

    driver.send('write refused.txt')
    const second = await until(() => heard.signals.filter((signal) => signal.kind === 'asks')[1], 'a second card')
    driver.answer(second.ask, 'no')
    await until(() => endings(heard).length === 2, 'the second ending')
    assert.equal(existsSync(join(place.root, 'refused.txt')), false)
    await driver.end()
    provider.dispose()
  })
})

test('Auto allows tool requests without cards, and switching to Auto answers a waiting card', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place, 'auto')
    driver.send('write auto.txt')
    await until(() => endings(heard).length === 1, 'the ending')
    assert.equal(heard.signals.some((signal) => signal.kind === 'asks'), false)
    assert.equal(existsSync(join(place.root, 'auto.txt')), true)
    await driver.end()

    const manual = await opened(place, 'manual')
    manual.driver.send('write switched.txt')
    await until(() => manual.heard.signals.find((signal) => signal.kind === 'asks'), 'a card')
    manual.driver.permit('auto', [])
    await until(() => endings(manual.heard).length === 1, 'the ending')
    assert.equal(existsSync(join(place.root, 'switched.txt')), true)
    await manual.driver.end()
    provider.dispose()
  })
})

test('Stop interrupts the run and the turn ends as stopped', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('wait')
    await until(() => [...heard.items.values()].some((item) => item.kind === 'theirs'), 'the run to start')
    driver.stop()
    await until(() => endings(heard).length === 1, 'the ending')
    assert.equal(endings(heard)[0].how, 'stopped')
    await driver.end()
    provider.dispose()
  })
})

test('a refused turn ends as signedOut or limit and never hangs', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('fail auth')
    await until(() => endings(heard).length === 1, 'the first ending')
    assert.equal(endings(heard)[0].how, 'signedOut')
    driver.send('fail quota')
    await until(() => endings(heard).length === 2, 'the second ending')
    assert.equal(endings(heard)[1].how, 'limit')
    assert.match(endings(heard)[1].text, /429/)
    await driver.end()
    provider.dispose()
  })
})

test('a goal runs as its own turn: begun, the answer, one ending', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('hello')
    await until(() => endings(heard).length === 1, 'the first ending')
    const session = heard.signals.find((signal) => signal.kind === 'started').session
    const goal = await provider.setGoal(session, 'tests pass')
    assert.deepEqual(goal, { goal: { condition: 'tests pass', checks: 0 }, status: 'active' })
    await until(() => endings(heard).length === 2, 'the goal ending')
    assert.ok(heard.signals.some((signal) => signal.kind === 'begun'))
    assert.ok([...heard.items.values()].some((item) => item.kind === 'theirs' && item.text === 'goal reached: tests pass'))
    assert.deepEqual(await provider.goal(place.root, session), { goal: { condition: 'tests pass', checks: 0 } })
    await provider.clearGoal(session)
    await driver.end()
    provider.dispose()
  })
})

test('the journal answers list, read, search, links, rename and delete', async () => {
  const place = await world()
  await within(place, async () => {
    const { provider, driver, heard } = await opened(place)
    driver.send('see https://example.com/docs please')
    await until(() => endings(heard).length === 1, 'the ending')
    await driver.end()
    const session = heard.signals.find((signal) => signal.kind === 'started').session
    const [row] = await provider.list([place.root])
    assert.equal(row.id, session)
    assert.equal(row.title, 'see https://example.com/docs please')
    assert.equal(await provider.has(place.root, session), true)
    const read = await provider.read(place.root, session)
    assert.deepEqual(read.items.filter((item) => item.kind === 'mine').map((item) => item.text), ['see https://example.com/docs please'])
    assert.equal((await provider.search([place.root], 'example docs'))[0].id, session)
    assert.deepEqual(await provider.links(place.root, session), [{ url: 'https://example.com/docs' }])
    await provider.rename(session, 'Docs')
    assert.equal((await provider.list([place.root]))[0].title, 'Docs')
    assert.equal(await provider.delete(place.root, session), true)
    assert.deepEqual(await provider.list([place.root]), [])
    provider.dispose()
  })
})

test('zcode gets nothing of GeckIt\'s, and the person\'s settings are only read', async () => {
  const place = await world()
  await within(place, async () => {
    const before = await readFile(place.userSettings, 'utf8')
    const { provider, driver, heard } = await opened(place)
    driver.send('private words', [{ media: 'image/png', data: 'iVBORw0KGgo=' }])
    await until(() => endings(heard).length === 1, 'the ending')
    const [call] = await calls(place)
    assert.deepEqual(call.geckitVariables, [])
    assert.ok(call.settings !== null && !call.settings.startsWith(place.home))
    assert.equal(call.args.filter((arg) => arg === '--attach').length, 1)
    assert.ok([...heard.items.values()].some((item) => item.kind === 'theirs' && item.text.endsWith('(+1 image)')))
    assert.equal(await readFile(place.userSettings, 'utf8'), before)
    await driver.end()
    assert.equal(existsSync(call.settings), false, 'the private settings copy is removed with the driver')
    assert.equal(JSON.stringify(place.logs).includes('private words'), false)
    provider.dispose()
  })
})

test('account and program describe the zcode that answers', async () => {
  const place = await world()
  await within(place, async () => {
    const provider = create(place.context)
    const account = await provider.account()
    assert.equal(account.here, true)
    assert.equal(account.signedIn, undefined)
    assert.equal(account.program.version, '9.9.9-1')
    assert.equal(account.program.from, 'GECKIT_ZCODE_COMMAND')
    assert.match(account.usage.unavailableReason, /quota/)
    const limits = await provider.limits(['m'])
    assert.equal(limits.windows.get('m'), undefined)
    assert.ok(limits.unavailableReason)
    provider.dispose()
  })
})
