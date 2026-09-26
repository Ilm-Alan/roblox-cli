import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const generatedPaths = [
  'dist',
  'studio-plugin/out',
  'studio-plugin/RobloxCliStudio.rbxmx',
];

for (const relativePath of generatedPaths) {
  rmSync(join(repositoryRoot, relativePath), { recursive: true, force: true });
}
