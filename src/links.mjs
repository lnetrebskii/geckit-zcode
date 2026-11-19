// Web links in a conversation the way GeckIt's renderer lists them: the
// newest first, each once, with the label it was written under.

const NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g
const BARE = /https?:\/\/[^\s<>"'`)\]]+/g
const TRAILING = /[.,;:!?]+$/

export function linksIn(items) {
  const found = new Map()
  for (const said of [...items].reverse()) {
    if (said.kind !== 'mine' && said.kind !== 'theirs') continue
    for (const [, text = '', url = ''] of said.text.matchAll(NAMED)) {
      const had = found.get(url)
      if (had === undefined || had.text === undefined) found.set(url, text === url ? { url } : { url, text })
    }
    for (const [bare] of said.text.matchAll(BARE)) {
      const url = bare.replace(TRAILING, '')
      if (!found.has(url)) found.set(url, { url })
    }
  }
  return [...found.values()]
}
