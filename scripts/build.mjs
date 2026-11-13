import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(join(root, 'lib', 'types'), { recursive: true })
// Emit only: no tests, type checking, dependency loading or CLI execution.
for (const name of await readdir(join(root, 'src'))) {
  if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue
  const source = await readFile(join(root, 'src', name), 'utf8')
  const emitted = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  await writeFile(join(root, 'lib', name.replace(/\.ts$/, '.js')), emitted, 'utf8')
}
await copyFile(join(root, 'types', 'index.d.ts'), join(root, 'lib', 'types', 'index.d.ts'))
console.log('Emitted JavaScript and public types. No tests were run.')

