// GeckIt's install-time checks for a provider library, transcribed from
// anetrebskii/geckit client/src/main/sessions/plugins.ts at 9a3abda
// (v1.265, 2026-11-18): `manifestAt` and the contract check in `loadPlugin`.
// Refresh this file when GeckIt changes them.

export const METHODS = ['account', 'program', 'models', 'limits', 'list', 'search', 'hidden', 'create', 'fork', 'has', 'read', 'links', 'goal', 'setGoal', 'clearGoal', 'hold', 'rename', 'remote', 'mcp', 'browsers', 'correct', 'setInstructions', 'delete', 'dispose']
export const CAPABILITIES = ['available', 'localOnly', 'subscriptionOnly', 'images', 'remoteControl', 'nativeGoals', 'waitForExit']

const pluginId = (id) => id === 'claude-tmux' || /^plugin:[a-z][a-z0-9-]*$/.test(id)

export function checkManifest(parsed) {
  if (parsed?.apiVersion !== 1 || typeof parsed.entry !== 'string' || typeof parsed.provider !== 'object' || parsed.provider === null) throw new Error('Invalid GeckIt plugin manifest.')
  const provider = parsed.provider
  for (const key of ['family', 'name', 'shortName', 'icon', 'loginCommand', 'planName']) {
    if (typeof provider[key] !== 'string') throw new Error('Invalid provider metadata.')
  }
  if (typeof provider.id !== 'string' || !pluginId(provider.id) || !['none', 'claude', 'codex'].includes(String(provider.browser))) throw new Error('Invalid provider metadata.')
  if ('iconPath' in provider && (typeof provider.iconPath !== 'string' || provider.iconPath.length > 2048)) throw new Error('Invalid provider icon.')
  if ('resumeCommand' in provider && typeof provider.resumeCommand !== 'string') throw new Error('Invalid provider resume command.')
  if ('runtime' in provider && provider.runtime !== 'codex') throw new Error('Invalid provider runtime.')
  if ('instructions' in provider && !['claude', 'codex', 'own'].includes(provider.instructions)) throw new Error('Invalid provider instructions.')
  const transport = provider.transport
  const replaces = provider.replaces
  const mismatched = provider.id === 'claude-tmux'
    ? provider.family !== 'claude' || transport !== 'tmux' || replaces !== undefined
    : replaces === 'codex' ? provider.family !== 'codex' || transport !== undefined : replaces !== undefined || provider.family !== provider.id || transport !== undefined
  if (mismatched) throw new Error('Plugin provider ID does not match its family and transport.')
  if (parsed.entry !== 'index.mjs') throw new Error('Plugin entry must be index.mjs.')
  return parsed
}

export function checkProvider(provider, manifest) {
  const compatible = typeof provider === 'object' && provider !== null && typeof provider.setInstructions !== 'function' ? { ...provider, setInstructions: async () => {} } : provider
  if (typeof compatible !== 'object' || compatible === null || METHODS.some((method) => typeof compatible[method] !== 'function') || CAPABILITIES.some((field) => typeof compatible[field] !== 'boolean') || typeof compatible.idleMs !== 'number') throw new Error('Plugin does not implement LlmProvider.')
  if (provider.id !== manifest.provider.id) throw new Error('Plugin ID differs from its manifest.')
  return compatible
}
