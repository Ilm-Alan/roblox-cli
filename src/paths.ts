import { homedir } from 'node:os';
import { join } from 'node:path';

/** Stable macOS paths owned by roblox-cli. */
export const CLI_NAME = 'roblox-cli';
export const CLI_VERSION = 1;
export const DEFAULT_PORT = 58741;

export function dataDirectory(): string {
  return process.env.ROBLOX_CLI_HOME?.trim() ||
    join(homedir(), 'Library', 'Application Support', CLI_NAME);
}

export function logsDirectory(): string {
  return process.env.ROBLOX_CLI_LOG_DIR?.trim() ||
    join(homedir(), 'Library', 'Logs', CLI_NAME);
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
