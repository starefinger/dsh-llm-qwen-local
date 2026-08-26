/**
 * Build the client half: bundle src/client/index.tsx as a CJS closure and
 * wrap it in the web shell's module-table shell
 * (`window.__ModuleLoader__.load({id, factory})`). The factory's `require`
 * resolves through the loader's module table — platform modules (seeded at
 * boot) plus registered client packages — so every @deepseek-ai/* and react
 * import is external by construction. A post-build gate lists every
 * require() the bundle emits and refuses a specifier outside the table.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

// The web shell's shared platform modules (packages/client/web PLATFORM_MODULES,
// 0.1.1-rc.2): the list shrank with the client refactor — web-react,
// ui-attachment, and schema-form are no longer table entries.
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]
// Client packages this plugin is linked against (declared in dsh.client.inject).
const CLIENT_EDGES = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-api-remotes',
]
const TABLE = new Set([...PLATFORM_MODULES, ...CLIENT_EDGES])

const result = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [...PLATFORM_MODULES, ...CLIENT_EDGES],
  write: false,
  logLevel: 'warning',
})
const cjs = result.outputFiles[0].text

// Purity gate: every require() the bundle emits must be a module-table entry.
const required = new Set()
for (const match of cjs.matchAll(/require\((["'])([^"']+)\1\)/g)) {
  required.add(match[2])
}
const unknown = [...required].filter(specifier => !TABLE.has(specifier))
if (unknown.length > 0) {
  console.error(`build-client: bundle requires modules outside the module table: ${unknown.join(', ')}`)
  process.exit(1)
}

const wrapped = [
  `// dsh-llm-qwen-local client bundle — module-table consumer for the web shell.`,
  `// Built by scripts/build-client.mjs (esbuild CJS + __ModuleLoader__ shell).`,
  `// Required module-table entries: ${[...required].sort().join(', ') || '(none)'}`,
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(pkg.name)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  cjs,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n')

const outPath = join(root, 'lib/client.js')
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, wrapped)
console.log(`build-client: ${outPath} (${Buffer.byteLength(wrapped)} bytes, requires: ${[...required].sort().join(', ') || 'none'})`)
