import { chmodSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc writes dist/ without execute bits, and `npm link` only sets them when it
// creates the link, so every rebuild of an already linked checkout would leave
// `roblox` unrunnable from the shell.
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { bin } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));

for (const relativePath of Object.values(bin)) {
  chmodSync(join(repositoryRoot, relativePath), 0o755);
}
