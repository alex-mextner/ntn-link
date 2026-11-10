/**
 * Bundles the CLI into one Node-compatible ESM file with a shebang.
 * Not minified so the published artifact stays auditable; `package.json` (version)
 * is inlined by the bundler, so there is no runtime file read.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const outDir = join(root, 'dist');
const outFile = join(outDir, 'ntn-link.js');

const result = await Bun.build({
  entrypoints: [join(root, 'src', 'bin.ts')],
  target: 'node',
  format: 'esm',
  minify: false,
  sourcemap: 'none',
});
if (!result.success) {
  for (const message of result.logs) console.error(String(message));
  process.exit(1);
}
const output = result.outputs[0];
if (output === undefined) throw new Error('bundler produced no output');

mkdirSync(outDir, { recursive: true });
// Bun keeps the entry's shebang; strip and re-add so there is exactly one.
const code = (await output.text()).replace(/^#!.*\n/, '');
writeFileSync(outFile, `#!/usr/bin/env node\n${code}`);
chmodSync(outFile, 0o755);
console.log(`built ${outFile} (${readFileSync(outFile).length} bytes)`);
