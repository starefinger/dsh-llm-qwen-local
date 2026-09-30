/**
 * Live-config unwrapping for the DSH >= 0.2.0 volatile-config contract.
 *
 * On DSH >= 0.2.0 the loader hands `apply()` a config whose volatile fields
 * (per the frozen envelope's `meta.volatile` marks in {@link Config}) are
 * LIVE REFERENCES: frozen objects with a `get()` that the runtime updates in
 * place when a settings write commits, branded with the cosmokit volatile
 * symbol. The 0.1.2 `settings.installSection` seam that pushed a replacement
 * configuration source into a plugin no longer exists, so a plugin re-reads
 * its live facts through the references on every request. Pre-0.2
 * compositions (and plain test harnesses) pass ordinary values, which the
 * unwrapper returns unchanged — the same code path serves both runtimes.
 *
 * @module dsh-llm-qwen-local/live-config
 */

/**
 * The cosmokit volatile-reference brand. Cosmokit's `isVolatile` treats a
 * value as a live reference when this symbol is a member of it; the DSH 0.2.0
 * loader stamps its volatile references with it. Using the well-known symbol
 * keeps the brand check dependency-free.
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * Whether a value is a 0.2.0 volatile reference. The brand check is primary;
 * the frozen-`get` shape is the structural fallback for a runtime that
 * constructs the references without stamping the symbol.
 */
export function isVolatileRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<PropertyKey, unknown>
  if (VOLATILE_WRITE in obj) return true
  return typeof obj.get === 'function' && Object.isFrozen(obj)
}

/**
 * Re-read a configuration value through any volatile references it contains,
 * returning an equivalent plain value: volatile references are replaced by
 * their current (`.get()`) value, arrays are mapped, and plain objects (and
 * objects frozen without a `get` shape) are re-materialized field by field.
 * Everything else — primitives, class instances, and the config root's own
 * identity — passes through untouched. Called once per request, so the cost
 * is one shallow walk over the route fields.
 */
export function liveValue(value: unknown): unknown {
  if (isVolatileRef(value)) return liveValue((value as { get(): unknown }).get())
  if (Array.isArray(value)) return value.map(liveValue)
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, liveValue(child)]))
  }
  return value
}
