import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join } from 'node:path';
import { resolveAuthToken } from './auth.js';
import { AGENT_DAEMON_STOP_PATH, AGENT_HEALTH_PATH, AGENT_PROTOCOL_HEADER, AGENT_PROTOCOL_VERSION } from './agent-protocol.js';
import { getPluginsFolder, installPluginAsset } from './install-plugin-helpers.js';
import {
  CLI_NAME,
  DEFAULT_PORT,
  daemonErrorLogPath,
  daemonLogPath,
  logsDirectory,
  pluginAssetName,
} from './paths.js';

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;

export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('roblox-cli supports macOS and Windows only.');
  }
}

export function packageRoot(): string {
  const configured = process.env.ROBLOX_CLI_PACKAGE_ROOT?.trim();
  if (configured) return configured;
  const executable = process.argv[1];
  if (executable) {
    try {
      const executableDirectory = dirname(realpathSync(executable));
      if (basename(executableDirectory) === 'dist') return dirname(executableDirectory);
    } catch {
      // Fall through to the working directory for test runners and wrappers.
    }
  }
  return process.cwd();
}

export function daemonEntry(): string {
  return join(packageRoot(), 'dist', 'daemon.js');
}

export function packageJsonPath(): string {
  return join(packageRoot(), 'package.json');
}

function pluginSourcePath(): string {
  return join(packageRoot(), 'studio-plugin', pluginAssetName());
}

/** Whether a fetch failed because nothing listens on the port: the request never left this process. */
export function isConnectionRefused(error: unknown): boolean {
  // Duck-typed: fetch errors can come from another realm, where `instanceof Error` is false.
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : undefined;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ECONNREFUSED';
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function daemonRequest(port: number, path: string, method: 'GET' | 'POST'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'X-Studio-Auth': resolveAuthToken().token ?? '', [AGENT_PROTOCOL_HEADER]: String(AGENT_PROTOCOL_VERSION) },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

type DaemonProbe =
  | { state: 'stopped' }
  | { state: 'running'; pid: number; version: unknown; uptime_ms: unknown }
  | { state: 'unreachable'; detail: string };

/** Identify the daemon on `port` through its authenticated health endpoint. */
async function probeDaemon(port: number): Promise<DaemonProbe> {
  let response: Response;
  try {
    response = await daemonRequest(port, AGENT_HEALTH_PATH, 'GET');
  } catch (error) {
    if (isConnectionRefused(error)) return { state: 'stopped' };
    return { state: 'unreachable', detail: `Port ${port} accepted a connection but no roblox-cli health response arrived: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (response.ok && body?.service === 'roblox-cli-daemon' && typeof body.pid === 'number') {
    return { state: 'running', pid: body.pid, version: body.version, uptime_ms: body.uptime };
  }
  const code = (body?.error as Record<string, unknown> | undefined)?.code;
  return {
    state: 'unreachable',
    detail: `Port ${port} is held by a process this CLI cannot manage (HTTP ${response.status}${typeof code === 'string' ? ` ${code}` : ''}). ` +
      'It is not a roblox-cli daemon that accepts this auth token and reports its pid; stop it with whatever started it, or choose another --port.',
  };
}

function runningReport(port: number, daemon: Extract<DaemonProbe, { state: 'running' }>): JsonObject {
  return {
    state: 'running', pid: daemon.pid, port, version: daemon.version, uptime_ms: daemon.uptime_ms,
    log: daemonLogPath(), error_log: daemonErrorLogPath(),
  };
}

/**
 * Start the persistent daemon in the background. It is detached with
 * file-backed stdio so it outlives the invoking terminal and never holds that
 * terminal's pipes open. Nothing else starts it: not login, not other commands.
 */
export async function startDaemon(port = DEFAULT_PORT): Promise<JsonObject> {
  assertSupportedPlatform();
  const { daemon } = verifyBuildArtifacts();
  const current = await probeDaemon(port);
  if (current.state === 'running') return { started: false, ...runningReport(port, current) };
  if (current.state === 'unreachable') throw new Error(current.detail);
  mkdirSync(logsDirectory(), { recursive: true, mode: 0o700 });
  const stdout = openSync(daemonLogPath(), 'a', 0o600);
  const stderr = openSync(daemonErrorLogPath(), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [daemon], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', stdout, stderr],
      env: { ...process.env, ROBLOX_CLI_PORT: String(port) },
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  let exit: string | undefined;
  child.once('exit', (code, signal) => { exit = signal ? `signal ${signal}` : `exit code ${code}`; });
  child.once('error', (error) => { exit = error.message; });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(100);
    const probe = await probeDaemon(port);
    // A concurrent start may win the port; report whichever daemon now answers.
    if (probe.state === 'running') return { started: probe.pid === child.pid, ...runningReport(port, probe) };
    if (exit !== undefined) throw new Error(`roblox-cli daemon exited during startup (${exit}). See ${daemonErrorLogPath()}.`);
  }
  child.kill();
  throw new Error(`roblox-cli daemon did not answer on port ${port} within ${START_TIMEOUT_MS / 1000}s. See ${daemonErrorLogPath()}.`);
}

/** Ask the daemon to shut down gracefully, then wait until its process is gone. */
export async function stopDaemon(port = DEFAULT_PORT): Promise<JsonObject> {
  const current = await probeDaemon(port);
  if (current.state === 'stopped') return { stopped: false, state: 'stopped', port };
  if (current.state === 'unreachable') throw new Error(current.detail);
  const response = await daemonRequest(port, AGENT_DAEMON_STOP_PATH, 'POST');
  if (response.status !== 202) throw new Error(`roblox-cli daemon ${current.pid} refused to stop (HTTP ${response.status}).`);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (processExists(current.pid)) {
    if (Date.now() >= deadline) throw new Error(`roblox-cli daemon ${current.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s.`);
    await delay(100);
  }
  return { stopped: true, state: 'stopped', pid: current.pid, port };
}

export async function daemonStatus(port = DEFAULT_PORT): Promise<JsonObject> {
  const current = await probeDaemon(port);
  if (current.state === 'running') return runningReport(port, current);
  if (current.state === 'stopped') return { state: 'stopped', port, next: 'roblox daemon start' };
  return { state: 'unreachable', port, error: current.detail };
}

export function verifyBuildArtifacts(): { daemon: string; plugin: string } {
  const daemon = daemonEntry();
  const plugin = pluginSourcePath();
  if (!existsSync(daemon)) throw new Error(`Built daemon not found at ${daemon}. Run npm run build first.`);
  if (!existsSync(plugin)) throw new Error(`Built Studio plugin not found at ${plugin}. Run npm run build first.`);
  return { daemon, plugin };
}

export function installBuiltPlugin(port = DEFAULT_PORT): JsonObject {
  assertSupportedPlatform();
  const { plugin } = verifyBuildArtifacts();
  const packageJson = JSON.parse(readFileSync(packageJsonPath(), 'utf8')) as { version: string };
  const pluginsFolder = getPluginsFolder();
  const result = installPluginAsset({
    pluginsFolder,
    assetName: pluginAssetName(),
    source: readFileSync(plugin),
    expectedVersion: packageJson.version,
    rawPort: String(port),
    log: () => undefined,
    warn: () => undefined,
  });
  return { plugin: result.destination, installed: result.installed, plugins_folder: pluginsFolder };
}

export function setupRobloxCli(port = DEFAULT_PORT): JsonObject {
  return {
    cli: CLI_NAME,
    platform: process.platform,
    plugin: installBuiltPlugin(port),
    next: 'roblox daemon start',
  };
}

type JsonObject = Record<string, unknown>;
