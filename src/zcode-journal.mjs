// What this plugin has seen of each ZCode conversation it held. zcode offers
// no public command that lists sessions or prints a transcript, so GeckIt's
// lists and re-reads are answered from here: one private JSON file per native
// session, written when a turn ends. Nothing here is read back into zcode.

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const NATIVE_ID = /^sess_[A-Za-z0-9-]+$/
const KEEP_ITEMS = 4_000

/** The journal's folder: beside GeckIt's provider logs where GeckIt says where they are. */
export function journalFolder(logPath) {
  if (typeof logPath === 'string' && logPath !== '') return join(dirname(dirname(logPath)), 'provider-data', 'plugin-zcode')
  return join(homedir(), '.geckit-zcode')
}

const titleOf = (text) => {
  const line = String(text ?? '').split('\n').find((one) => one.trim() !== '') ?? ''
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

const lastSaid = (items) => {
  const said = items.findLast((item) => item.kind === 'theirs' || item.kind === 'mine')
  return said === undefined ? '' : titleOf(said.text)
}

export class Journal {
  constructor(folder) {
    this.folder = folder
    this.records = new Map()
    this.ready = undefined
  }

  async prepare() {
    this.ready ??= mkdir(this.folder, { recursive: true, mode: 0o700 }).then(() => chmod(this.folder, 0o700))
    return this.ready
  }

  fileOf(id) {
    if (!NATIVE_ID.test(id)) throw new Error('Not a ZCode session id.')
    return join(this.folder, `${id}.json`)
  }

  async get(id) {
    if (!NATIVE_ID.test(id)) return undefined
    const kept = this.records.get(id)
    if (kept !== undefined) return kept
    try {
      const record = JSON.parse(await readFile(this.fileOf(id), 'utf8'))
      this.records.set(id, record)
      return record
    } catch {
      return undefined
    }
  }

  /** The record for a session, made on first sight. */
  async open(id, root, firstText) {
    const had = await this.get(id)
    if (had !== undefined) return had
    const now = Date.now()
    const record = { id, root, title: titleOf(firstText) || 'ZCode conversation', created: now, at: now, items: [] }
    this.records.set(id, record)
    return record
  }

  /** Items upserted by id, in the order they were first seen. */
  note(record, items) {
    for (const item of items) {
      const at = record.items.findIndex((one) => one.id === item.id)
      if (at >= 0) record.items[at] = item
      else record.items.push(item)
    }
    if (record.items.length > KEEP_ITEMS) record.items.splice(0, record.items.length - KEEP_ITEMS)
    record.at = Date.now()
  }

  async save(record) {
    await this.prepare()
    const file = this.fileOf(record.id)
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
    await rename(temporary, file)
  }

  async all() {
    await this.prepare()
    const names = await readdir(this.folder).catch(() => [])
    const records = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const record = await this.get(name.slice(0, -5))
      if (record !== undefined) records.push(record)
    }
    return records
  }

  async list(roots) {
    const wanted = new Set(roots)
    return (await this.all())
      .filter((record) => wanted.has(record.root))
      .map((record) => ({
        id: record.id,
        root: record.root,
        title: record.title,
        stands: lastSaid(record.items),
        at: record.at,
        created: record.created,
        driven: true,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.used === undefined ? {} : { used: record.used }),
        ...(record.window === undefined ? {} : { window: record.window }),
      }))
  }

  async search(roots, asked) {
    const words = asked.toLowerCase().split(/\s+/).filter((word) => word !== '')
    if (words.length === 0) return []
    const wanted = new Set(roots)
    const found = []
    for (const record of await this.all()) {
      if (!wanted.has(record.root)) continue
      const said = record.items.filter((item) => (item.kind === 'mine' || item.kind === 'theirs') && words.every((word) => item.text.toLowerCase().includes(word)))
      const titled = words.every((word) => record.title.toLowerCase().includes(word))
      if (said.length === 0 && !titled) continue
      found.push({ id: record.id, root: record.root, title: record.title, said: titleOf(said.at(-1)?.text ?? record.title), at: record.at, count: Math.max(1, said.length) })
    }
    return found
  }

  async forget(id) {
    this.records.delete(id)
    await rm(this.fileOf(id), { force: true })
  }
}
