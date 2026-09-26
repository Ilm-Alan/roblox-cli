import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthTokenUnavailableError, resolveAuthToken } from '../auth.js';

let home: string;
const saved = { home: process.env.ROBLOX_CLI_HOME, token: process.env.ROBLOX_CLI_AUTH_TOKEN };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'roblox-cli-auth-'));
  process.env.ROBLOX_CLI_HOME = home;
  delete process.env.ROBLOX_CLI_AUTH_TOKEN;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [['ROBLOX_CLI_HOME', saved.home], ['ROBLOX_CLI_AUTH_TOKEN', saved.token]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('creates one private token file that every later resolve shares', () => {
  const first = resolveAuthToken();
  expect(first).toEqual({ token: expect.stringMatching(/^[0-9a-f]{64}$/), source: 'file', filePath: join(home, 'auth-token') });
  expect(readFileSync(join(home, 'auth-token'), 'utf8').trim()).toBe(first.token);
  // Windows has no POSIX mode bits; the per-user %LOCALAPPDATA% ACL protects the file there.
  if (process.platform !== 'win32') expect(statSync(join(home, 'auth-token')).mode & 0o777).toBe(0o600);
  expect(resolveAuthToken().token).toBe(first.token);
  expect(readdirSync(home)).toEqual(['auth-token']);
});

test('keeps a pre-existing valid token', () => {
  writeFileSync(join(home, 'auth-token'), '  existing-token\n', { mode: 0o644 });
  expect(resolveAuthToken().token).toBe('existing-token');
  expect(readFileSync(join(home, 'auth-token'), 'utf8')).toBe('  existing-token\n');
  if (process.platform !== 'win32') expect(statSync(join(home, 'auth-token')).mode & 0o777).toBe(0o600);
});

test.each(['', ' \n\t'])('replaces an empty token file %j with a shared token', (contents) => {
  writeFileSync(join(home, 'auth-token'), contents);
  const { token } = resolveAuthToken();
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(readFileSync(join(home, 'auth-token'), 'utf8').trim()).toBe(token);
  expect(resolveAuthToken().token).toBe(token);
  expect(readdirSync(home)).toEqual(['auth-token']);
});

test('fails instead of inventing a private token when the file cannot be created', () => {
  const blocked = join(home, 'not-a-directory');
  writeFileSync(blocked, '');
  process.env.ROBLOX_CLI_HOME = blocked;
  expect(() => resolveAuthToken()).toThrow(AuthTokenUnavailableError);
});

test('the environment token wins without touching the file', () => {
  process.env.ROBLOX_CLI_AUTH_TOKEN = ' env-token ';
  expect(resolveAuthToken()).toEqual({ token: 'env-token', source: 'env' });
  expect(readdirSync(home)).toEqual([]);
});
