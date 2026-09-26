import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { authTokenPath, dataDirectory } from './paths.js';

// Shared-secret auth for the local HTTP surface. The token gates the CLI
// workflow, status, and recovery endpoints so that local malware cannot
// drive Studio blind. Plugin bootstrap begins at /ready because a Studio
// plugin cannot read the daemon's file token; after the first session,
// refresh/disconnect operations must present the peer's transport credential.
//
// Resolution order:
//   1. ROBLOX_CLI_AUTH_TOKEN        -> use that value
//   2. ~/Library/Application Support/roblox-cli/auth-token (created on first
//      run, mode 0600)
//
// Every roblox-cli process on the machine resolves the same token, so
// explicitly delegated sessions authenticate to the primary automatically.
// A process that cannot resolve that shared token fails instead of inventing
// a private one that no other process could present.

export interface ResolvedAuthToken {
  token: string;
  source: 'env' | 'file';
  filePath?: string;
}

/** The shared token cannot be read or persisted; nothing can authenticate. */
export class AuthTokenUnavailableError extends Error {
  constructor(readonly filePath: string, cause: unknown) {
    super(
      `Cannot read or create the roblox-cli auth token at ${filePath}: ` +
      `${cause instanceof Error ? cause.message : String(cause)}. ` +
      'Fix the permissions of that file and its directory, or set ROBLOX_CLI_AUTH_TOKEN.',
      { cause },
    );
    this.name = 'AuthTokenUnavailableError';
  }
}

// Duck-typed: fs errors can come from another realm, where `instanceof Error` is false.
function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

/** Trimmed file contents, or undefined when the file does not exist. */
function readToken(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

// The token file only ever appears under its final name fully written: a new
// token is staged in a private temp file and published with link(2), which
// fails with EEXIST when another process published first. An empty file left
// by an older build or a manual edit is replaced with rename(2).
function persistToken(filePath: string, replaceEmpty: boolean): string {
  const fresh = randomBytes(32).toString('hex');
  const staged = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(staged, fresh + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (replaceEmpty) {
      renameSync(staged, filePath);
    } else {
      try {
        linkSync(staged, filePath);
        return fresh;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
    // Another process may have published concurrently; the file is the truth.
    const published = readToken(filePath);
    if (!published) throw new Error('the token file is empty after publishing');
    return published;
  } finally {
    try { unlinkSync(staged); } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

export function resolveAuthToken(): ResolvedAuthToken {
  const envToken = process.env.ROBLOX_CLI_AUTH_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: 'env' };
  }

  const filePath = authTokenPath();
  try {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best-effort on filesystems without POSIX permissions.
    }
    const existing = readToken(filePath);
    const token = existing || persistToken(filePath, existing !== undefined);
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on filesystems without POSIX permissions.
    }
    return { token, source: 'file', filePath };
  } catch (error) {
    throw new AuthTokenUnavailableError(filePath, error);
  }
}

/** Constant-time token comparison (hashes both sides to hide length). */
export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
