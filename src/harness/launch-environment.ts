/**
 * Local, dependency-free copy of the harness launch-environment resolver.
 *
 * Reproduced from `@deepseek-ai/dsh-launch-environment`'s
 * `launchEnvironmentOf` / `createLaunchEnvironmentSnapshot`. The published
 * plugin carries no runtime dependency on the package, so the minimal
 * snapshot contract is reproduced here: a `get(name)` that answers from the
 * launcher-provided snapshot (`ctx.get('launchEnvironment')`) when present,
 * else from the inherited process environment as the sole layer.
 *
 * Only the single-source `get(name)` the plugin uses is reproduced; the
 * launcher's richer `getFrom(name, sources)` is not needed here.
 *
 * @module dsh-llm-qwen-local/harness/launch-environment
 */

/** The context slot the launcher fills with this run's snapshot. */
export const DSH_LAUNCH_ENVIRONMENT_KEY = 'launchEnvironment'

/** One resolved launch-environment value with its provenance. */
export interface LaunchEnvironmentHit {
  value: string
  source: string
  path?: string
}

/** The minimal snapshot surface the plugin consumes. */
export interface LaunchEnvironmentSnapshot {
  get(name: string): LaunchEnvironmentHit | undefined
}

/**
 * A context carrying the launcher's optional snapshot. Cordis `Context`
 * provides `get(name)`; the structural type keeps this module free of any
 * runtime dependency on cordis.
 */
export interface HasLaunchEnvironment {
  get(name: string): unknown
}

/**
 * The map key one variable name resolves under. Windows treats environment
 * names case-insensitively; every other platform does not.
 */
function lookupKey(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name
}

/**
 * Build a process-only snapshot (the fallback when the host provided none).
 */
function processSnapshot(): LaunchEnvironmentSnapshot {
  const values = new Map(
    Object.entries(process.env).map(([name, value]) => [lookupKey(name), value]),
  )
  return {
    get(name) {
      const value = values.get(lookupKey(name))
      if (value === undefined) return undefined
      return { value, source: 'process' }
    },
  }
}

/**
 * Return the launcher's snapshot, or the inherited environment as the sole
 * layer when the host provided none.
 * @param ctx - the consuming plugin's context (provides `get`).
 * @returns the snapshot to resolve user-facing values against.
 */
export function launchEnvironmentOf(ctx: HasLaunchEnvironment): LaunchEnvironmentSnapshot {
  const provided = ctx.get(DSH_LAUNCH_ENVIRONMENT_KEY) as LaunchEnvironmentSnapshot | undefined
  return provided ?? processSnapshot()
}
