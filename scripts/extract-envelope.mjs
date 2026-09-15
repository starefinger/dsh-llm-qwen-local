/**
 * Frozen-ENVELOPE extractor and drift checker.
 *
 * The settings service exposes the `llm-qwen-local` namespace to the web form
 * renderer through `schema.toJSON()`. Post zero-dependency refactor,
 * `src/config.ts` no longer builds a live schemastery schema — it ships a
 * hand-owned callable plus a frozen `ENVELOPE` constant. This script
 * guarantees that constant still matches what the schemastery schema produces.
 *
 * Usage:
 *   node scripts/extract-envelope.mjs            # print the CURRENT frozen
 *                                                #   ENVELOPE (src/config.ts) to stdout
 *   node scripts/extract-envelope.mjs --check    # diff the frozen ENVELOPE
 *                                                #   against the reference
 *                                                #   schemastery schema in
 *                                                #   scripts/envelope-source.ts
 *                                                #   (exit 1 on drift)
 *
 * To regenerate after a Config-shape change: update the schema in
 * scripts/envelope-source.ts AND the frozen ENVELOPE in src/config.ts
 * (e.g. run the plain mode against a pre-refactor checkout, or edit both by
 * hand), then re-run --check.
 */
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Bundle an entry to a temp ESM module and import it. */
async function importBundled(entry) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-env-'))
  try {
    const out = join(dir, 'config.bundle.mjs')
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      outfile: out,
      logLevel: 'silent',
    })
    return await import(pathToFileURL(out).href)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const check = process.argv.includes('--check')

if (!check) {
  const mod = await importBundled(join(root, 'src/config.ts'))
  process.stdout.write(JSON.stringify(mod.Config.toJSON(), null, 2) + '\n')
} else {
  const [frozenMod, derivedMod] = await Promise.all([
    importBundled(join(root, 'src/config.ts')),
    importBundled(join(root, 'scripts/envelope-source.ts')),
  ])
  const frozen = JSON.stringify(frozenMod.Config.toJSON())
  const derived = JSON.stringify(derivedMod.Config.toJSON())
  if (frozen === derived) {
    console.log('ENVELOPE in sync with the reference schemastery schema.')
  } else {
    console.error('ENVELOPE DRIFT: frozen constant in src/config.ts no longer matches')
    console.error('the reference schemastery schema in scripts/envelope-source.ts.')
    console.error('--- derived (reference schemastery) ---')
    console.error(JSON.stringify(derivedMod.Config.toJSON(), null, 2))
    console.error('--- frozen (src/config.ts) ---')
    console.error(JSON.stringify(frozenMod.Config.toJSON(), null, 2))
    process.exit(1)
  }
}
