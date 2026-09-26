import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const pluginArtifact = 'studio-plugin/RobloxCliStudio.rbxmx';

// `npm run` provides npm's own entry point; invoking it through Node avoids
// Windows' npm.cmd shim, which child_process cannot run without a shell.
const npm = process.env.npm_execpath;
const output = execFileSync(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'pack', '--dry-run', '--json'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const report = JSON.parse(output);
const files = new Set(report[0]?.files?.map((entry) => entry.path) ?? []);

const required = [
  'README.md',
  'LICENSE',
  'dist/cli-main.js',
  'dist/daemon.js',
  'dist/capture-worker-main.js',
  'dist/install-plugin-helpers.js',
  // The Swift helpers are built only on macOS.
  ...(process.platform === 'darwin'
    ? ['dist/native/record-studio', 'dist/native/focus-session', 'dist/native/viewport-image', 'dist/native/studio-windows']
    : []),
  pluginArtifact,
];
const missing = required.filter((path) => !files.has(path));
if (missing.length > 0) {
  throw new Error(`Package is missing required files: ${missing.join(', ')}`);
}

const developmentOnly = [...files].filter((path) =>
  path === 'AGENTS.md' || path.startsWith('src/') || path.startsWith('studio-plugin/src/'));
if (developmentOnly.length > 0) {
  throw new Error(`Package contains development-only files: ${developmentOnly.join(', ')}`);
}

// Install the shipped plugin bytes with the shipped installer, on a non-default
// port, so XML shape, embedded identity and port rewriting fail here rather
// than at a user's `roblox setup`.
const { installPluginAsset } = await import(new URL('../dist/install-plugin-helpers.js', import.meta.url).href);
const { version } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const checkPort = '58742';
const pluginsFolder = mkdtempSync(join(tmpdir(), 'roblox-cli-check-package-'));
const warnings = [];
try {
  const { destination, installed } = installPluginAsset({
    pluginsFolder,
    assetName: 'RobloxCliStudio.rbxmx',
    source: readFileSync(join(repositoryRoot, pluginArtifact)),
    expectedVersion: version,
    rawPort: checkPort,
    log: () => undefined,
    warn: (message) => warnings.push(message),
  });
  if (warnings.length > 0) throw new Error(`Installer warned: ${warnings.join('; ')}`);
  if (!installed) throw new Error(`Installer did not write ${destination}`);
  const configured = readFileSync(destination, 'utf8');
  if (!configured.includes(`http://127.0.0.1:${checkPort}`) || !configured.includes(`BASE_PORT = ${checkPort}`)) {
    throw new Error(`Installed plugin does not use port ${checkPort}`);
  }
  if (configured.includes('58741')) {
    throw new Error('Installed plugin still references the default port 58741');
  }
} finally {
  rmSync(pluginsFolder, { recursive: true, force: true });
}

console.log(`Package contents verified (${files.size} files); plugin ${version} installs on port ${checkPort}.`);
