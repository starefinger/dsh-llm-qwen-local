// Disposable: print the live schemastery envelope from scripts/envelope-source.ts
// so the frozen ENVELOPE in src/config.ts can be regenerated to match it.
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(join(tmpdir(), 'dsh-env-dump-'))
try {
  const out = join(dir, 'env.bundle.mjs')
  await build({
    entryPoints: [join(root, 'scripts/envelope-source.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    outfile: out,
    logLevel: 'silent',
  })
  const mod = await import(pathToFileURL(out).href)
  process.stdout.write(JSON.stringify(mod.Config.toJSON(), null, 2) + '\n')
} finally {
  await rm(dir, { recursive: true, force: true })
}
