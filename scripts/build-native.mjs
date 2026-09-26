import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));

if (process.platform === 'darwin') {
  const output = path('../dist/native/');
  mkdirSync(output, { recursive: true });
  const compile = (source, binary, flags = []) => execFileSync('swiftc',
    [...flags, '-O', path(`./${source}`), '-o', `${output}${binary}`], { stdio: 'inherit' });
  compile('record-studio.swift', 'record-studio',
    ['-parse-as-library', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos15.0`]);
  compile('focus-session.swift', 'focus-session');
  compile('viewport-image.swift', 'viewport-image');
  compile('studio-windows.swift', 'studio-windows');
}
