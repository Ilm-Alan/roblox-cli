import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { isUtf8 } from 'node:buffer';
import { SaxesParser } from 'saxes';
import { windowsLocalAppData } from './paths.js';

// The daemon and its one generated Studio plugin are the only runtime
// integration. Installation is deliberately local and never fetches code.
const DEFAULT_PLUGIN_PORT = 58741;
const PLUGIN_VARIANT = 'main';
const SERVER_URL_SETTING_KEY_PATTERN =
  /ROBLOX_CLI_LAST_SUCCESSFUL_SERVER_URL_GLOBAL_V1|ROBLOX_CLI_LAST_SUCCESSFUL_SERVER_URL_/g;
const PLUGIN_INSTALL_LOCK_NAME = '.roblox-cli-plugin-install.lock';

/** Rewrite the embedded plugin port and namespace remembered URL settings. */
export function configurePluginAssetForPort(
  source: Buffer,
  rawPort: string | undefined = process.env.ROBLOX_CLI_PORT,
): Buffer {
  if (rawPort === undefined || rawPort === '') return source;
  if (!/^\d+$/u.test(rawPort)) {
    throw new Error(`ROBLOX_CLI_PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}`);
  }

  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ROBLOX_CLI_PORT must be an integer from 1 to 65535; received ${JSON.stringify(rawPort)}`);
  }
  if (port === DEFAULT_PLUGIN_PORT) return source;

  const defaultPort = String(DEFAULT_PLUGIN_PORT);
  const configuredPort = String(port);
  const defaultUrl = `http://127.0.0.1:${defaultPort}`;
  const defaultBasePort = `BASE_PORT = ${defaultPort}`;
  const original = source.toString('utf8');
  if (!original.includes(defaultUrl) || !original.includes(defaultBasePort)) {
    throw new Error(`Bundled Studio plugin does not contain the expected default port ${defaultPort}`);
  }

  const configured = original
    .replaceAll(defaultUrl, `http://127.0.0.1:${configuredPort}`)
    .replaceAll(defaultBasePort, `BASE_PORT = ${configuredPort}`)
    .replace(
      SERVER_URL_SETTING_KEY_PATTERN,
      (key) => key.endsWith('_')
        ? `${key}PORT_${configuredPort}_`
        : `${key}_PORT_${configuredPort}`,
    );
  return Buffer.from(configured, 'utf8');
}

/** Resolve the normal Roblox Studio plugin directory for this platform. */
export function getPluginsFolder(): string {
  const override = process.env.ROBLOX_CLI_PLUGINS_DIR?.trim();
  if (override) return override;
  return process.platform === 'win32'
    ? join(windowsLocalAppData(), 'Roblox', 'Plugins')
    : join(homedir(), 'Documents', 'Roblox', 'Plugins');
}

export interface InstallPluginAssetOptions {
  pluginsFolder: string;
  assetName: string;
  source: Buffer;
  expectedVersion: string;
  rawPort?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface PluginInstallResult {
  destination: string;
  installed: boolean;
}

interface PluginInstallLockOwner {
  pid: number;
  token: string;
  createdAt: number;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error &&
    typeof error.code === 'string' ? error.code : undefined;
}

function lockError(lockPath: string, reason: string): Error {
  return new Error(
    `${reason}: ${lockPath}. If no installer is running, remove that lock directory and retry.`,
  );
}

function readLockOwner(lockPath: string): PluginInstallLockOwner {
  const ownerPath = join(lockPath, 'owner.json');
  if (!lstatSync(lockPath).isDirectory() || !lstatSync(ownerPath).isFile()) {
    throw new Error('lock owner metadata is missing or is not a regular file');
  }
  const value: unknown = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (
    value === null || typeof value !== 'object' ||
    !('pid' in value) || typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
    !('token' in value) || typeof value.token !== 'string' || !/^[A-Za-z0-9-]{1,128}$/u.test(value.token) ||
    !('createdAt' in value) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
  ) {
    throw new Error('invalid plugin installer lock owner');
  }
  return { pid: value.pid, token: value.token, createdAt: value.createdAt };
}

function reclaimLock(lockPath: string, warn: (message: string) => void): void {
  let owner: PluginInstallLockOwner;
  try {
    owner = readLockOwner(lockPath);
  } catch (error) {
    throw lockError(lockPath, `cannot safely read plugin installer lock (${error})`);
  }

  if (owner.pid !== process.pid) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (errorCode(error) !== 'ESRCH') {
        throw lockError(lockPath, `cannot confirm installer PID ${owner.pid} has exited`);
      }
    }
  }
  if (owner.pid === process.pid || (() => {
    try { process.kill(owner.pid, 0); return true; } catch (error) { return errorCode(error) === 'EPERM'; }
  })()) {
    throw lockError(lockPath, `another plugin installation is active (PID ${owner.pid})`);
  }

  const claimPath = join(lockPath, `recovery-${owner.token}`);
  try {
    mkdirSync(claimPath);
  } catch (error) {
    throw lockError(lockPath, errorCode(error) === 'EEXIST'
      ? 'plugin installer lock recovery is already in progress'
      : `could not claim plugin installer lock recovery (${error})`);
  }

  const abandonedPath = `${lockPath}.${randomUUID()}.abandoned`;
  let moved = false;
  try {
    const current = readLockOwner(lockPath);
    if (current.pid !== owner.pid || current.token !== owner.token || current.createdAt !== owner.createdAt) {
      throw lockError(lockPath, 'plugin installer lock owner changed; retry installation');
    }
    renameSync(lockPath, abandonedPath);
    moved = true;
  } finally {
    if (!moved) {
      try { rmdirSync(claimPath); } catch (error) {
        if (errorCode(error) !== 'ENOENT') warn(`Could not release plugin lock recovery claim ${claimPath}: ${error}`);
      }
    }
  }
  try { rmSync(abandonedPath, { recursive: true, force: true }); } catch (error) {
    warn(`Could not clean abandoned plugin lock ${abandonedPath}: ${error}`);
  }
}

function acquireInstallLock(
  pluginsFolder: string,
  warn: (message: string) => void,
): () => void {
  const lockPath = join(pluginsFolder, PLUGIN_INSTALL_LOCK_NAME);
  const ownerPath = join(lockPath, 'owner.json');
  const owner: PluginInstallLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };

  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    reclaimLock(lockPath, warn);
    try { mkdirSync(lockPath); } catch (retryError) {
      if (errorCode(retryError) !== 'EEXIST') throw retryError;
      throw lockError(lockPath, 'another plugin installation is already in progress');
    }
  }

  try {
    writeFileSync(ownerPath, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    try { rmSync(lockPath, { recursive: true, force: true }); } catch (cleanupError) {
      warn(`Could not clean failed plugin install lock ${lockPath}: ${cleanupError}`);
    }
    throw error;
  }

  return () => {
    try {
      const current = readLockOwner(lockPath);
      if (current.pid === owner.pid && current.token === owner.token) {
        rmSync(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') warn(`Could not release plugin install lock ${lockPath}: ${error}`);
    }
  };
}

function assertAssetFileName(name: string): void {
  if (!name || basename(name) !== name || name !== 'RobloxCliStudio.rbxmx') {
    throw new Error(`assetName must be RobloxCliStudio.rbxmx, received ${JSON.stringify(name)}`);
  }
}

interface ParsedPluginElement {
  name: string;
  attributes: Record<string, string>;
}

function scriptSources(source: Buffer, assetName: string): string[] {
  if (!isUtf8(source)) throw new Error(`${assetName} is not valid UTF-8 Roblox XML.`);

  const stack: ParsedPluginElement[] = [];
  const sources: string[] = [];
  let rootName: string | undefined;
  let current: { depth: number; text: string } | undefined;
  const parser = new SaxesParser({ fragment: false, xmlns: false });
  parser.on('doctype', () => { throw new Error('DOCTYPE declarations are not allowed in plugin artifacts.'); });
  parser.on('opentag', (tag) => {
    if (stack.length === 0) rootName = tag.name;
    if (current === undefined && tag.name === 'string' && tag.attributes.name === 'Source') {
      const item = [...stack].reverse().find((element) => element.name === 'Item');
      if (item?.attributes.class === 'Script' || item?.attributes.class === 'ModuleScript' || item?.attributes.class === 'LocalScript') {
        current = { depth: stack.length, text: '' };
      }
    }
    stack.push({ name: tag.name, attributes: tag.attributes });
  });
  parser.on('text', (value) => { if (current) current.text += value; });
  parser.on('cdata', (value) => { if (current) current.text += value; });
  parser.on('closetag', (tag) => {
    if (current && tag.name === 'string' && stack.length === current.depth + 1) {
      sources.push(current.text);
      current = undefined;
    }
    stack.pop();
  });

  try {
    parser.write(source.toString('utf8')).close();
  } catch (error) {
    throw new Error(`${assetName} is not well-formed Roblox XML: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (rootName !== 'roblox' || sources.length === 0) {
    throw new Error(`${assetName} is not a Roblox XML model containing a Script source.`);
  }
  return sources;
}

function embedded(source: string, name: 'CURRENT_VERSION' | 'PLUGIN_VARIANT' | 'CURRENT_BUILD_ID', assetName: string): string {
  const matches = [...source.matchAll(new RegExp(`\\blocal\\s+${name}\\s*=\\s*"([^"]+)"\\s*;?`, 'g'))];
  if (matches.length !== 1) throw new Error(`${assetName} must contain exactly one embedded ${name}; found ${matches.length}.`);
  return matches[0][1];
}

function embeddedBuildId(pluginSource: string, assetName: string): string {
  const buildId = embedded(pluginSource, 'CURRENT_BUILD_ID', assetName);
  if (!/^[0-9a-f]{16}$/.test(buildId)) throw new Error(`${assetName} embeds build id ${buildId}; expected 16 lowercase hex characters.`);
  return buildId;
}

/** The build id a plugin artifact sends on /ready; the daemon accepts only its packaged build. */
export function pluginBuildId(source: Buffer, assetName: string): string {
  return embeddedBuildId(scriptSources(source, assetName).join('\n'), assetName);
}

function assertPluginIdentity(source: Buffer, assetName: string, expectedVersion: string): void {
  const pluginSource = scriptSources(source, assetName).join('\n');
  const version = embedded(pluginSource, 'CURRENT_VERSION', assetName);
  if (version !== expectedVersion) throw new Error(`${assetName} embeds version ${version}; expected ${expectedVersion}.`);
  const variant = embedded(pluginSource, 'PLUGIN_VARIANT', assetName);
  if (variant !== PLUGIN_VARIANT) throw new Error(`${assetName} embeds variant ${variant}; expected ${PLUGIN_VARIANT}.`);
  embeddedBuildId(pluginSource, assetName);
}

function fileMatches(source: Buffer, destination: string): boolean {
  if (!existsSync(destination) || !lstatSync(destination).isFile()) return false;
  const installed = readFileSync(destination);
  return installed.length === source.length && installed.equals(source);
}

/** Validate, configure, and atomically install the one owned plugin artifact. */
export function installPluginAsset({
  pluginsFolder,
  assetName,
  source,
  expectedVersion,
  rawPort,
  log = console.log,
  warn = console.warn,
}: InstallPluginAssetOptions): PluginInstallResult {
  assertAssetFileName(assetName);
  const configured = configurePluginAssetForPort(source, rawPort);
  assertPluginIdentity(configured, assetName, expectedVersion);

  mkdirSync(pluginsFolder, { recursive: true });
  const destination = join(pluginsFolder, assetName);
  const releaseLock = acquireInstallLock(pluginsFolder, warn);
  try {
    let installed = false;
    if (!fileMatches(configured, destination)) {
      const staged = join(pluginsFolder, `.${assetName}.${process.pid}.${randomUUID()}.tmp`);
      try {
        writeFileSync(staged, configured, { flag: 'wx' });
        renameSync(staged, destination);
        installed = true;
      } finally {
        try { unlinkSync(staged); } catch (error) {
          if (errorCode(error) !== 'ENOENT') warn(`Could not remove plugin staging file ${staged}: ${error}`);
        }
      }
    }
    log(installed ? `Installed ${assetName} in ${pluginsFolder}.` : `${assetName} is already current.`);
    return { destination, installed };
  } finally {
    releaseLock();
  }
}
