import { homedir } from 'node:os';
import { join } from 'node:path';

/** Stable per-user paths owned by roblox-cli on macOS and Windows. */
export const CLI_NAME = 'roblox-cli';
export const CLI_VERSION = 1;
export const DEFAULT_PORT = 58741;

/** %LOCALAPPDATA%: where Windows keeps per-user state, Roblox Studio, and its plugins. */
export function windowsLocalAppData(): string {
  return process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
}

export function dataDirectory(): string {
  return process.env.ROBLOX_CLI_HOME?.trim() || (process.platform === 'win32'
    ? join(windowsLocalAppData(), CLI_NAME)
    : join(homedir(), 'Library', 'Application Support', CLI_NAME));
}

export function logsDirectory(): string {
  return process.env.ROBLOX_CLI_LOG_DIR?.trim() || (process.platform === 'win32'
    ? join(windowsLocalAppData(), CLI_NAME, 'logs')
    : join(homedir(), 'Library', 'Logs', CLI_NAME));
}

export function daemonLogPath(): string {
  return join(logsDirectory(), 'daemon.log');
}

export function daemonErrorLogPath(): string {
  return join(logsDirectory(), 'daemon.error.log');
}

export function artifactsDirectory(): string {
  return join(dataDirectory(), 'artifacts');
}

export function authTokenPath(): string {
  return join(dataDirectory(), 'auth-token');
}

export function daemonPidPath(): string {
  return join(dataDirectory(), 'daemon.pid');
}

export function pluginAssetName(): string {
  return 'RobloxCliStudio.rbxmx';
}
