import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { promisify } from 'util';
import {
  ManagedInstanceRegistry,
  type ManagedProcessObservation,
  type ManagedInstanceLifecycleState,
  type ManagedInstanceRegistryRecord,
  type RegistrySweepOptions,
  persistedStateKey,
} from './managed-instance-registry.js';
import { packageRoot } from './daemon-control.js';
import { dataDirectory, windowsLocalAppData } from './paths.js';

export type StudioLaunchSource = 'baseplate' | 'local_file' | 'published_place' | 'place_revision';

export interface StudioProcessEnvironmentPatch {
  set?: Record<string, string>;
  remove?: string[];
}

export interface StudioLaunchOptions {
  source: StudioLaunchSource;
  localPlaceFile?: string;
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  connectionTimeoutMs?: number;
  studioExecutable?: string;
  processEnvironment?: StudioProcessEnvironmentPatch;
  studioWorkingDirectory?: string;
}

export type StudioLaunchState = ManagedInstanceLifecycleState;

export interface ManagedStudioInstance {
  recordId?: string;
  source: StudioLaunchSource;
  instanceId?: string;
  nativeProcessId?: number;
  nativeProcessStartedAt?: string;
  spawnPid?: number;
  exe: string;
  args: string[];
  placeId?: number;
  universeId?: number;
  placeVersion?: number;
  localPlaceFile?: string;
  studioWorkingDirectory?: string;
  launchedAt: number;
  connectionDeadlineAt?: number;
  state: StudioLaunchState;
  connectedAt?: number;
  failedAt?: number;
  exitedAt?: number;
  exitCode?: number;
  failureReason?: string;
  closedAt?: number;
  ownerPid?: number;
  bootId?: string;
  deleteLocalPlaceFileOnClose?: boolean;
  processObservationStatus?: "running" | "not_running" | "unknown";
  lastProcessObservationAt?: number;
  lastSuccessfulProcessObservationAt?: number;
  lastProcessObservationError?: string;
  consecutiveConfirmedMisses?: number;
  firstConfirmedMissAt?: number;
}

export interface StudioProcessInfo {
  Id: number;
  Name?: string;
  Path?: string;
  MainWindowTitle?: string;
  CommandLine?: string;
  StartTimeUtcFileTime?: string;
}

export type StudioProcessSnapshot =
  | { status: 'ok'; observedAt: number; processes: StudioProcessInfo[] }
  | { status: 'error'; observedAt: number; error: string };

const BASEPLATE_TEMP_NAME = /^Baseplate-\d+-\d+\.lua$/;
const BASEPLATE_BOOTSTRAP_SOURCE = '-- roblox-cli opens the built-in empty baseplate.\n';
const DEFAULT_CLOSE_GRACE_MS = 5000;
const DEFAULT_CLOSE_POLL_MS = 100;

function baseplateTempDirectory(): string {
  return path.join(dataDirectory(), 'baseplates');
}

export interface ConnectedStudioInstance {
  instanceId: string;
  role: string;
  placeId: number;
  placeName: string;
  dataModelName: string;
}

type StudioChildProcess = {
  pid?: number;
  nativePid?: number;
  nativeStartedAt?: string;
  unref: () => void;
  onExit?: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  onError?: (listener: (error: Error) => void) => void;
};

export interface StudioProcessAdapter {
  observeStudioProcesses?: () => StudioProcessSnapshot | Promise<StudioProcessSnapshot>;
  listStudioProcesses?: () => StudioProcessInfo[] | Promise<StudioProcessInfo[]>;
  stopProcess?: (processId: number, startedAt?: string) => unknown | Promise<unknown>;
  forceStopProcess?: (processId: number, startedAt?: string) => unknown | Promise<unknown>;
  resolveStudioExe?: () => string | Promise<string>;
  spawnStudio?: (exe: string, args: string[], options: Parameters<typeof spawn>[2]) => StudioChildProcess | Promise<StudioChildProcess>;
  currentBootId?: () => string | Promise<string>;
  /** Undefined when window information is unavailable. */
  listStudioWindows?: () => StudioWindow[] | undefined | Promise<StudioWindow[] | undefined>;
}

export interface StudioInstanceManagerOptions {
  registryDir?: string;
  registry?: ManagedInstanceRegistry;
  processAdapter?: StudioProcessAdapter;
  confirmedExitMisses?: number;
  confirmedExitGraceMs?: number;
  snapshotCacheMs?: number;
  closeGraceMs?: number;
  closePollMs?: number;
}

export interface StudioLifecycleCapabilities {
  hostPlatform: 'macos' | 'windows';
  launcher: 'built-in' | 'custom-adapter';
}

export type ManagedStudioCloseResult =
  | { status: 'closed'; launchId?: string; instanceId?: string }
  | { status: 'already_closed'; launchId?: string; instanceId?: string }
  | { status: 'not_found'; launchId?: string; instanceId?: string };


const execFileAsync = promisify(execFile);

async function runAsync(command: string, args: string[], options: Record<string, unknown> = {}): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
    killSignal: 'SIGKILL',
    windowsHide: true,
    ...options,
  });
  return String(result.stdout).trim();
}

const POWERSHELL_COMMAND = ['-NoProfile', '-NonInteractive', '-Command'];

// Get-Process exposes the window title and creation time. The creation FILETIME
// is the process identity that close verifies before stopping anything. The
// command line (Win32_Process, queried only when Studio runs) lets a launch
// follow Studio's self-update relaunch.
const WINDOWS_STUDIO_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  // Get-Process reports a missing name as an error, not a successful empty set.
  '$studio = @(); try { $studio = @(Get-Process RobloxStudioBeta -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenName,*") { throw } }',
  '$commandLines = @{}; if ($studio.Count -gt 0) { Get-CimInstance Win32_Process -Filter "Name = \'RobloxStudioBeta.exe\'" | ForEach-Object { $commandLines[[int]$_.ProcessId] = [string]$_.CommandLine } }',
  '$processes = @($studio | ForEach-Object { [PSCustomObject]@{ Id = $_.Id; Name = $_.Name; Path = [string]$_.Path; ' +
    'MainWindowTitle = [string]$_.MainWindowTitle; CommandLine = [string]$commandLines[[int]$_.Id]; ' +
    'StartTimeUtcFileTime = $_.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() } })',
  'ConvertTo-Json -InputObject $processes -Compress',
].join('; ');

function parseWindowsStudioProcesses(output: string): StudioProcessInfo[] {
  const parsed: unknown = JSON.parse(output);
  const processes: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (!processes.every((value): value is StudioProcessInfo =>
    value !== null && typeof value === 'object' &&
    'Id' in value && typeof value.Id === 'number' && Number.isSafeInteger(value.Id) && value.Id > 0 &&
    'Name' in value && typeof value.Name === 'string' &&
    'Path' in value && typeof value.Path === 'string' &&
    'MainWindowTitle' in value && typeof value.MainWindowTitle === 'string' &&
    'CommandLine' in value && typeof value.CommandLine === 'string' &&
    'StartTimeUtcFileTime' in value && typeof value.StartTimeUtcFileTime === 'string' &&
    /^[1-9]\d*$/u.test(value.StartTimeUtcFileTime)
  )) {
    throw new Error('Malformed Roblox Studio process enumeration result.');
  }
  return processes;
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function parseStudioProcessEnvironmentPatch(value: unknown): StudioProcessEnvironmentPatch | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('process_environment must be an object when provided.');
  }

  const raw = value as Record<string, unknown>;
  const unsupported = Object.keys(raw).filter((key) => key !== 'set' && key !== 'remove');
  if (unsupported.length > 0) {
    throw new Error(`process_environment contains unsupported field(s): ${unsupported.join(', ')}.`);
  }

  let set: Record<string, string> | undefined;
  if (raw.set !== undefined) {
    if (raw.set === null || typeof raw.set !== 'object' || Array.isArray(raw.set)) {
      throw new Error('process_environment.set must be an object mapping names to string values.');
    }
    set = {};
    for (const [name, setting] of Object.entries(raw.set as Record<string, unknown>)) {
      if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
        throw new Error(`Invalid process environment variable name "${name}".`);
      }
      if (typeof setting !== 'string') {
        throw new Error(`process_environment.set.${name} must be a string.`);
      }
      if (setting.includes('\0')) {
        throw new Error(`process_environment.set.${name} must not contain a null character.`);
      }
      set[name] = setting;
    }
  }

  let remove: string[] | undefined;
  if (raw.remove !== undefined) {
    if (!Array.isArray(raw.remove) || raw.remove.some((name) => typeof name !== 'string')) {
      throw new Error('process_environment.remove must be an array of environment variable names.');
    }
    remove = [...new Set(raw.remove as string[])];
    for (const name of remove) {
      if (!ENVIRONMENT_VARIABLE_NAME.test(name)) {
        throw new Error(`Invalid process environment variable name "${name}".`);
      }
    }
  }

  return { set, remove };
}

export function parseStudioWorkingDirectory(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error('studio_working_directory must be a non-empty string without null characters.');
  }
  return value;
}

function patchedProcessEnvironment(patch: StudioProcessEnvironmentPatch): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of patch.remove ?? []) delete environment[name];
  for (const [name, value] of Object.entries(patch.set ?? {})) environment[name] = value;
  return environment;
}

function resolveStudioExeFromEnvironment(): string | undefined {
  const configured = process.env.ROBLOX_CLI_STUDIO_EXE;
  if (configured === undefined) return undefined;
  if (configured.trim() === '' || configured.includes('\0')) {
    throw new Error('ROBLOX_CLI_STUDIO_EXE must be a non-empty path without null characters.');
  }
  return configured;
}

export function resolveStudioExe(): string {
  if (process.platform === 'win32') return resolveStudioExeFromEnvironment() ?? newestWindowsStudioExe();
  if (process.platform !== 'darwin') {
    throw new Error('roblox-cli supports Studio lifecycle control on macOS and Windows only.');
  }
  return resolveStudioExeFromEnvironment()
    ?? '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio';
}

/** Studio installs per user under %LOCALAPPDATA%\Roblox\Versions; the newest install is current. */
function newestWindowsStudioExe(): string {
  const root = path.join(windowsLocalAppData(), 'Roblox', 'Versions');
  const candidates = existsSync(root)
    ? readdirSync(root)
      .filter((name) => name.startsWith('version-'))
      .map((name) => path.join(root, name, 'RobloxStudioBeta.exe'))
      .filter((candidate) => existsSync(candidate))
    : [];
  if (candidates.length === 0) {
    throw new Error(`RobloxStudioBeta.exe was not found under ${root}. Install Roblox Studio or set ROBLOX_CLI_STUDIO_EXE.`);
  }
  return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function resolveStudioExeAsync(): Promise<string> {
  return resolveStudioExe();
}

const PS_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PS_LINE = /^\s*(\d+)\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/u;
// argv[0] must be the bundle's main executable. Bundle helpers (StudioMCP,
// RobloxCrashHandler, the installer app) and commands that merely mention the
// path in a later argument are not Studio.
const STUDIO_MAIN_EXECUTABLE = /^\/(?:(?!\s\/).)*?\.app\/Contents\/MacOS\/RobloxStudio(?=\s|$)/u;

/**
 * Parse one line of `ps -axo pid=,lstart=,command=` run with TZ=UTC and
 * LC_ALL=C. The start time is the process identity's second half: it lets a
 * retained PID be told apart from a later process that reused it.
 */
export function parseStudioProcessLine(line: string): StudioProcessInfo | undefined {
  const match = PS_LINE.exec(line);
  if (!match) return undefined;
  const [, rawPid, month, day, hours, minutes, seconds, year, commandLine] = match;
  const executable = STUDIO_MAIN_EXECUTABLE.exec(commandLine);
  const monthIndex = PS_MONTHS.indexOf(month);
  const pid = Number(rawPid);
  if (!executable || monthIndex < 0 || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const startedAt = Date.UTC(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds));
  return {
    Id: pid,
    Name: 'RobloxStudio',
    Path: executable[0],
    CommandLine: commandLine,
    StartTimeUtcFileTime: String(startedAt),
  };
}


export async function observeStudioProcesses(): Promise<StudioProcessSnapshot> {
  const observedAt = Date.now();
  if (process.platform === 'win32') {
    try {
      const output = await runAsync('powershell.exe', [...POWERSHELL_COMMAND, WINDOWS_STUDIO_PROCESS_QUERY]);
      return { status: 'ok', observedAt, processes: parseWindowsStudioProcesses(output) };
    } catch (error) {
      return { status: 'error', observedAt, error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (process.platform !== 'darwin') return { status: 'ok', observedAt, processes: [] };
  try {
    const output = await runAsync('/bin/ps', ['-axo', 'pid=,lstart=,command='], {
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    return {
      status: 'ok',
      observedAt,
      processes: output
        .split('\n')
        .map(parseStudioProcessLine)
        .filter((value): value is StudioProcessInfo => value !== undefined),
    };
  } catch (error) {
    return {
      status: 'error',
      observedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let bootId: Promise<string> | undefined;

/**
 * Identity of the current boot. It cannot change while this process runs, so it
 * is read once: the macOS boot session UUID (unlike kern.boottime it ignores time
 * zone and clock steps), or Windows' LastBootUpTime.
 */
export function currentBootId(): Promise<string> {
  bootId ??= (process.platform === 'win32'
    ? runAsync('powershell.exe', [...POWERSHELL_COMMAND,
      '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("o")'])
    : runAsync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']))
    .catch(() => `${process.platform}:${process.pid}:unknown-boot`);
  return bootId;
}

export interface StudioWindow {
  id: number;
  pid: number;
  title: string;
  bounds: { X: number; Y: number; Width: number; Height: number };
  layer: number;
}

/** On-screen Studio windows from the native helper, or undefined when it is not built. */
async function listStudioWindows(): Promise<StudioWindow[] | undefined> {
  const helper = path.join(packageRoot(), 'dist', 'native', 'studio-windows');
  if (process.platform !== 'darwin' || !existsSync(helper)) return undefined;
  return JSON.parse(await runAsync(helper, [])) as StudioWindow[];
}

export function buildStudioLaunchArgs(options: StudioLaunchOptions): string[] {
  switch (options.source) {
    case 'baseplate':
      return ['--task', 'RunScript', '--runScriptFile', options.localPlaceFile ?? createBaseplatePlaceFile()];
    case 'local_file':
      if (!options.localPlaceFile) throw new Error('local_place_file is required when source="local_file".');
      return ['--task', 'EditFile', '--localPlaceFile', options.localPlaceFile];
    case 'published_place':
      if (!options.placeId) throw new Error('place_id is required when source="published_place".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="published_place".');
      return ['--task', 'EditPlace', '--placeId', String(options.placeId), '--universeId', String(options.universeId)];
    case 'place_revision':
      if (!options.placeId) throw new Error('place_id is required when source="place_revision".');
      if (!options.universeId) throw new Error('Derived universe id is required when source="place_revision".');
      if (!options.placeVersion) throw new Error('place_version is required when source="place_revision".');
      return [
        '--task', 'EditPlaceRevision',
        '--placeId', String(options.placeId),
        '--universeId', String(options.universeId),
        '--placeVersion', String(options.placeVersion),
      ];
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const STALE_BASEPLATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BASEPLATE_TEMP_SWEEP_NAME = /^Baseplate-(\d+)-\d+\.lua(\.lock)?$/;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Close-time deletion is best-effort. If the daemon dies while Studio still
// has a generated place open, sweep the dedicated directory on a later run.
export function sweepStaleBaseplateFiles(): void {
  let entries: string[];
  try {
    entries = readdirSync(baseplateTempDirectory());
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_BASEPLATE_MAX_AGE_MS;
  for (const entry of entries) {
    const match = BASEPLATE_TEMP_SWEEP_NAME.exec(entry);
    if (!match) continue;
    // Owner server still running → its instance may still have the file open
    // The file may still be held briefly by a Studio process.
    if (Number(match[1]) !== process.pid && isProcessAlive(Number(match[1]))) continue;
    const file = path.join(baseplateTempDirectory(), entry);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Still locked or already gone; retry on a future sweep.
    }
  }
}

function createBaseplatePlaceFile(): string {
  const directory = baseplateTempDirectory();
  mkdirSync(directory, { recursive: true });
  sweepStaleBaseplateFiles();
  const file = path.join(directory, `Baseplate-${process.pid}-${Date.now()}.lua`);
  writeFileSync(file, BASEPLATE_BOOTSTRAP_SOURCE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}

function isGeneratedBaseplatePlaceFile(file: string): boolean {
  const resolvedFile = path.resolve(file);
  return (
    path.dirname(resolvedFile) === path.resolve(baseplateTempDirectory()) &&
    BASEPLATE_TEMP_NAME.test(path.basename(resolvedFile))
  );
}

export function cleanupManagedBaseplateFiles(record: Pick<ManagedStudioInstance, 'source' | 'localPlaceFile'>): void {
  if (record.source !== 'baseplate' || !record.localPlaceFile) return;
  if (!isGeneratedBaseplatePlaceFile(record.localPlaceFile)) return;

  // A leftover file in the dedicated temp dir is harmless and must not fail
  // the close itself.
  for (const file of [record.localPlaceFile, `${record.localPlaceFile}.lock`]) {
    try {
      rmSync(file, { force: true });
    } catch {
      // Locked by a lingering Studio handle; leave it for the OS temp cleanup.
    }
  }
}

function prepareStudioLaunchOptions(options: StudioLaunchOptions): StudioLaunchOptions {
  if (options.source !== 'baseplate' || options.localPlaceFile) return options;
  return {
    ...options,
    localPlaceFile: createBaseplatePlaceFile(),
  };
}

function basenameAny(filePath: string): string {
  return path.basename(filePath.replace(/\\/g, '/'));
}

function isRobloxStudioProcess(processInfo: StudioProcessInfo): boolean {
  const identity = `${processInfo.Name ?? ''} ${processInfo.Path ?? ''} ${processInfo.CommandLine ?? ''}`.toLowerCase();
  return identity.includes('robloxstudio') && !identity.includes('robloxcrashhandler');
}

export class StudioInstanceManager {
  private managedByInstanceId = new Map<string, ManagedStudioInstance>();
  private pending = new Set<ManagedStudioInstance>();
  private connectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Launches whose first Studio process exited cleanly while Studio relaunches itself. */
  private awaitingRelaunch = new Set<ManagedStudioInstance>();
  private readonly registry: ManagedInstanceRegistry;
  private readonly processAdapter: StudioProcessAdapter;
  private readonly confirmedExitMisses: number;
  private readonly confirmedExitGraceMs: number;
  private readonly snapshotCacheMs: number;
  private readonly closeGraceMs: number;
  private readonly closePollMs: number;
  private coordinatorTimer?: ReturnType<typeof setInterval>;
  private coordinatorRefresh?: Promise<void>;
  private cachedSnapshot?: StudioProcessSnapshot;
  private snapshotInFlight?: Promise<StudioProcessSnapshot>;
  private launchQueue: Promise<void> = Promise.resolve();
  /** Last persisted content of each record, keyed by record id. */
  private readonly persistedState = new Map<string, string>();

  constructor(options: StudioInstanceManagerOptions = {}) {
    this.registry = options.registry ?? new ManagedInstanceRegistry(options.registryDir);
    this.processAdapter = options.processAdapter ?? {};
    this.confirmedExitMisses = options.confirmedExitMisses ?? 2;
    this.confirmedExitGraceMs = options.confirmedExitGraceMs ?? 5000;
    this.snapshotCacheMs = options.snapshotCacheMs ?? 0;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.closePollMs = options.closePollMs ?? DEFAULT_CLOSE_POLL_MS;
  }

  getLifecycleCapabilities(): StudioLifecycleCapabilities {
    return {
      hostPlatform: process.platform === 'win32' ? 'windows' : 'macos',
      launcher: this.processAdapter.spawnStudio ? 'custom-adapter' : 'built-in',
    };
  }

  async list(): Promise<ManagedStudioInstance[]> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    for (const record of [...this.managedByInstanceId.values(), ...this.pending]) {
      await this.refresh(record, snapshot);
    }
    const records = [...this.managedByInstanceId.values(), ...this.pending];
    for (const registryRecord of await this.registry.listOpenUnchecked()) {
      const record = this.fromRegistryRecord(registryRecord);
      if (records.some((existing) =>
        (record.recordId && existing.recordId === record.recordId) ||
        (record.instanceId && existing.instanceId === record.instanceId)
      )) {
        continue;
      }
      records.push(await this.refresh(record, snapshot));
    }
    return records
      .filter((record) => record.closedAt === undefined)
      .filter((instance, index, all) => all.indexOf(instance) === index);
  }

  async get(instanceId: string): Promise<ManagedStudioInstance | undefined> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return this.refresh(memoryRecord, snapshot);
    const registryRecord = await this.registry.findAnyByInstanceId(instanceId);
    return registryRecord ? this.refresh(this.fromRegistryRecord(registryRecord), snapshot) : undefined;
  }

  async getByLaunchId(launchId: string): Promise<ManagedStudioInstance | undefined> {
    const snapshot = await this.getProcessSnapshot();
    await this.sweepRegistry(snapshot);
    const memoryRecord = [...this.managedByInstanceId.values(), ...this.pending]
      .find((record) => record.recordId === launchId);
    if (memoryRecord) return this.refresh(memoryRecord, snapshot);
    const registryRecord = await this.registry.findAnyByRecordId(launchId);
    return registryRecord ? this.refresh(this.fromRegistryRecord(registryRecord), snapshot) : undefined;
  }

  async pendingLaunches(): Promise<ManagedStudioInstance[]> {
    const now = Date.now();
    const bootId = await this.getCurrentBootId();
    const records = [...this.pending];
    for (const registryRecord of await this.registry.listOpenUnchecked()) {
      if (registryRecord.bootId !== bootId) continue;
      if (records.some((record) => record.recordId === registryRecord.recordId)) continue;
      records.push(this.fromRegistryRecord(registryRecord));
    }
    return records
      .filter((record) => record.instanceId === undefined)
      .filter((record) => record.state === 'launching')
      .filter((record) => record.connectionDeadlineAt === undefined || record.connectionDeadlineAt > now);
  }

  async attachInstanceId(record: ManagedStudioInstance, instanceId: string): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.reconcileFromPositiveEvidence(record, snapshot);
    if (record.closedAt !== undefined || record.state === 'failed' || record.state === 'exited') return;
    if (record.instanceId && record.instanceId !== instanceId) return;
    record.instanceId = instanceId;
    record.state = 'connected';
    record.connectedAt = record.connectedAt ?? Date.now();
    this.clearConnectionTimer(record);
    this.pending.delete(record);
    this.managedByInstanceId.set(instanceId, record);
    await this.persist(record);
  }

  async markFailed(record: ManagedStudioInstance, reason: string): Promise<ManagedStudioInstance> {
    if (
      record.closedAt !== undefined ||
      record.state === 'failed' ||
      record.state === 'exited'
    ) return record;
    record.state = 'failed';
    record.failedAt = Date.now();
    record.failureReason = reason;
    this.clearConnectionTimer(record);
    await this.persist(record);
    return record;
  }

  async refresh(
    record: ManagedStudioInstance,
    providedSnapshot?: StudioProcessSnapshot,
  ): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const snapshot = providedSnapshot ?? (await this.getProcessSnapshot());
    await this.applyProcessObservation(
      record,
      this.observeRecord(record, snapshot),
    );
    if (record.closedAt !== undefined) return record;

    if (
      record.state === "launching" &&
      record.connectionDeadlineAt !== undefined &&
      Date.now() >= record.connectionDeadlineAt
    ) {
      return this.markFailed(
        record,
      "Studio launched, but the Roblox CLI plugin did not connect before timeout.",
      );
    }
    return record;
  }

  async launch(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    const previous = this.launchQueue;
    let release!: () => void;
    this.launchQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.launchSerialized(options);
    } finally {
      release();
    }
  }

  private async launchSerialized(options: StudioLaunchOptions): Promise<ManagedStudioInstance> {
    const initialSnapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(initialSnapshot);
    const processEnvironment = parseStudioProcessEnvironmentPatch(options.processEnvironment);
    const studioWorkingDirectory = parseStudioWorkingDirectory(options.studioWorkingDirectory);
    if (
      options.studioExecutable !== undefined &&
      (typeof options.studioExecutable !== 'string' ||
        options.studioExecutable.length === 0 ||
        options.studioExecutable.includes('\0'))
    ) {
      throw new Error('studio_executable must be a non-empty string without null characters.');
    }
    const preparedOptions = prepareStudioLaunchOptions(options);
    const bootId = await this.getCurrentBootId();
    const before = new Set(initialSnapshot.status === 'ok' ? initialSnapshot.processes.map((proc) => proc.Id) : []);
    const exe = preparedOptions.studioExecutable ??
      (this.processAdapter.resolveStudioExe ? await this.processAdapter.resolveStudioExe() : await resolveStudioExeAsync());
    const args = buildStudioLaunchArgs(preparedOptions);
    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd: studioWorkingDirectory ?? process.cwd(),
      detached: true,
      stdio: 'ignore',
      ...(processEnvironment ? { env: patchedProcessEnvironment(processEnvironment) } : {}),
    };
    let proc: StudioChildProcess;
    try {
      if (this.processAdapter.spawnStudio) {
        proc = await this.processAdapter.spawnStudio(exe, args, spawnOptions);
      } else {
        const child = spawn(exe, args, spawnOptions);
        proc = {
          pid: child.pid,
          nativePid: child.pid,
          unref: () => child.unref(),
          onExit: (listener) => { child.once('exit', listener); },
          onError: (listener) => { child.once('error', listener); },
        };
      }
    } catch (error) {
      cleanupManagedBaseplateFiles({ source: preparedOptions.source, localPlaceFile: preparedOptions.localPlaceFile });
      throw error;
    }

    const launchedAt = Date.now();
    const record: ManagedStudioInstance = {
      recordId: randomUUID(),
      source: options.source,
      nativeProcessId: proc.nativePid,
      nativeProcessStartedAt: proc.nativeStartedAt,
      spawnPid: proc.pid,
      exe,
      args,
      placeId: preparedOptions.placeId,
      universeId: preparedOptions.universeId,
      placeVersion: preparedOptions.placeVersion,
      localPlaceFile: preparedOptions.localPlaceFile,
      studioWorkingDirectory,
      launchedAt,
      connectionDeadlineAt: launchedAt + (options.connectionTimeoutMs ?? 120000),
      state: 'launching',
      ownerPid: process.pid,
      bootId,
      deleteLocalPlaceFileOnClose: options.source === 'baseplate',
      processObservationStatus: 'running',
      lastProcessObservationAt: launchedAt,
      lastSuccessfulProcessObservationAt: launchedAt,
      consecutiveConfirmedMisses: 0,
    };
    this.pending.add(record);
    try {
      // Persist before returning control to the child-process lifecycle. Once
      // Studio exists, callers must always have a durable launch_id with which
      // to inspect or close it.
      await this.persist(record);
    } catch (error) {
      this.pending.delete(record);
      const processId = record.nativeProcessId ?? record.spawnPid;
      let stopError: unknown;
      try {
        if (processId) {
          await this.closeProcess(processId, record.nativeProcessStartedAt);
        }
      } catch (caught) {
        stopError = caught;
      }
      cleanupManagedBaseplateFiles(record);
      const detail = error instanceof Error ? error.message : String(error);
      const cleanupDetail = stopError
        ? ` The newly launched process could not be stopped: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        : '';
      throw new Error(`Studio launched, but its managed-instance record could not be persisted: ${detail}.${cleanupDetail}`);
    }
    proc.unref();

    proc.onExit?.((code, signal) => {
      this.runInBackground('persisting a Studio process exit', (async () => {
        if (code === 0 && record.instanceId === undefined && proc.pid !== undefined
          && await this.followSelfRelaunch(record, proc.pid)) return;
        await this.markProcessExited(
          record,
          code ?? undefined,
          signal
            ? `Studio process exited from signal ${signal}.`
            : record.instanceId
              ? 'Studio process exited.'
              : 'Studio process exited before the Roblox CLI plugin connected.',
        );
      })());
    });
    proc.onError?.((error) => {
      this.runInBackground(
        'persisting a Studio process launch failure',
        this.markFailed(record, `Studio process failed to start: ${error.message}`),
      );
    });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && record.nativeProcessId === undefined) {
      const snapshot = await this.getProcessSnapshot(true);
      const created = snapshot.status === 'ok'
        ? snapshot.processes.find((candidate) => !before.has(candidate.Id))
        : undefined;
      if (created) {
        record.nativeProcessId = created.Id;
        record.nativeProcessStartedAt = created.StartTimeUtcFileTime;
        await this.persist(record);
        break;
      }
      await delay(250);
    }

    if (record.nativeProcessId === undefined && proc.pid !== undefined) {
      record.nativeProcessId = proc.pid;
      await this.persist(record);
    }

    if (record.nativeProcessId !== undefined && record.nativeProcessStartedAt === undefined) {
      const snapshot = await this.getProcessSnapshot(true);
      const nativeProcess = snapshot.status === 'ok'
        ? snapshot.processes.find((candidate) => candidate.Id === record.nativeProcessId)
        : undefined;
      if (nativeProcess?.StartTimeUtcFileTime !== undefined) {
        record.nativeProcessStartedAt = nativeProcess.StartTimeUtcFileTime;
        await this.persist(record);
      }
    }

    this.startCoordinator(record);

    return record;
  }

  async closeByLaunchId(launchId: string): Promise<ManagedStudioCloseResult> {
    const record = await this.getByLaunchId(launchId);
    if (!record) return { status: 'not_found', launchId };
    return this.close(record);
  }

  async closeByInstanceId(instanceId: string): Promise<ManagedStudioCloseResult> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(snapshot);
    const memoryRecord = this.managedByInstanceId.get(instanceId);
    if (memoryRecord) return this.close(memoryRecord);

    const registryRecord = await this.registry.findAnyByInstanceId(instanceId);
    if (!registryRecord) {
      return { status: 'not_found', instanceId };
    }

    return this.close(this.fromRegistryRecord(registryRecord));
  }

  async close(
    record: ManagedStudioInstance,
  ): Promise<ManagedStudioCloseResult> {
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) {
      if (record.closedAt !== undefined) {
        return {
          status: "already_closed",
          launchId: record.recordId,
          instanceId: record.instanceId,
        };
      }
      throw new Error(
        `Cannot close ${record.instanceId ?? "Studio launch"} because its process id was not detected.`,
      );
    }
    const snapshot = await this.getProcessSnapshot(true);
    const observation = this.observeRecord(record, snapshot);
    if (observation.status === "unknown") {
      await this.applyProcessObservation(record, observation);
      throw new Error(
        `Cannot verify the managed Studio process because process observation failed: ${observation.error}`,
      );
    }
    if (observation.status === "not_running") {
      await this.markProcessExited(
        record,
        undefined,
        observation.reason === "identity_mismatch"
          ? "Studio process identity changed; the retained PID was not reused."
          : record.failureReason,
      );
      await this.registry.logEvent({
        event: "registry_close_already_stopped",
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason:
          observation.reason === "identity_mismatch"
            ? "identity_mismatch"
            : "pid_not_running",
        action: "marked_closed_and_cleaned_baseplate",
      });
      return {
        status: "already_closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }

    try {
      await this.closeProcess(
        processId,
        record.nativeProcessStartedAt,
        (process) => this.verifyProcessForRecord(record, process),
      );
    } catch (error) {
      const retry = await this.getProcessSnapshot(true);
      const retryObservation = this.observeRecord(record, retry);
      if (
        retryObservation.status === "running" ||
        retryObservation.status === "unknown"
      )
        throw error;
      await this.registry.logEvent({
        event: "registry_close_already_stopped",
        recordId: record.recordId,
        instanceId: record.instanceId,
        source: record.source,
        reason: "stop_raced_with_exit",
        action: "marked_closed_and_cleaned_baseplate",
      });
      await this.markProcessExited(record, undefined, record.failureReason);
      return {
        status: "already_closed",
        launchId: record.recordId,
        instanceId: record.instanceId,
      };
    }

    const closedAt = Date.now();
    record.closedAt = closedAt;
    record.exitedAt = record.exitedAt ?? closedAt;
    if (record.state !== "failed") record.state = "exited";
    record.processObservationStatus = "not_running";
    record.lastProcessObservationAt = closedAt;
    record.lastSuccessfulProcessObservationAt = closedAt;
    record.lastProcessObservationError = undefined;
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    await this.persist(record);
    return {
      status: "closed",
      launchId: record.recordId,
      instanceId: record.instanceId,
    };
  }

  async closeConnectedInstance(instance: ConnectedStudioInstance): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    if (snapshot.status === 'error') {
      throw new Error(`Could not enumerate Studio processes: ${snapshot.error}`);
    }
    const processes = snapshot.processes.length > 1
      ? await this.withMainWindowTitles(snapshot.processes)
      : snapshot.processes;
    const process = this.findProcessForConnectedInstance(instance, processes);
    if (!process) {
      throw new Error(`Could not find a Studio process for connected instance "${instance.instanceId}".`);
    }
    await this.closeProcess(
      process.Id,
      process.StartTimeUtcFileTime,
      (candidate) => candidate.Id === process.Id && isRobloxStudioProcess(candidate),
    );
  }

  /** Name each process by its largest on-screen window, so connected
   * instances can be told apart when several Studios run. */
  private async withMainWindowTitles(processes: StudioProcessInfo[]): Promise<StudioProcessInfo[]> {
    const windows = await (this.processAdapter.listStudioWindows ?? listStudioWindows)();
    if (!windows) return processes;
    const mainWindows = new Map<number, StudioWindow>();
    const area = (window: StudioWindow) => window.bounds.Width * window.bounds.Height;
    for (const window of windows) {
      const current = mainWindows.get(window.pid);
      if (!current || area(window) > area(current)) mainWindows.set(window.pid, window);
    }
    return processes.map((candidate) => {
      const title = mainWindows.get(candidate.Id)?.title;
      return candidate.MainWindowTitle || title === undefined ? candidate : { ...candidate, MainWindowTitle: title };
    });
  }

  private async closeProcess(
    processId: number,
    startedAt?: string,
    verifyProcess: (process: StudioProcessInfo) => boolean = (process) =>
      process.Id === processId &&
      isRobloxStudioProcess(process) &&
      (startedAt === undefined || process.StartTimeUtcFileTime === undefined || process.StartTimeUtcFileTime === startedAt),
  ): Promise<void> {
    if (this.processAdapter.stopProcess) {
      await this.processAdapter.stopProcess(processId, startedAt);
    } else {
      try {
        process.kill(processId, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }

    const gracefulExit = await this.waitForProcessExit(processId, startedAt, verifyProcess, this.closeGraceMs);
    if (gracefulExit === 'exited' || gracefulExit === 'identity_mismatch') return;
    if (gracefulExit === 'unknown') {
      throw new Error(`Could not verify that Studio process ${processId} exited after requesting close.`);
    }

    if (this.processAdapter.forceStopProcess) {
      await this.processAdapter.forceStopProcess(processId, startedAt);
    } else {
      try {
        process.kill(processId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }

    const forcedExit = await this.waitForProcessExit(processId, startedAt, verifyProcess, this.closeGraceMs);
    if (forcedExit === 'exited' || forcedExit === 'identity_mismatch') return;
    if (forcedExit === 'unknown') {
      throw new Error(`Could not verify that Studio process ${processId} exited after forced close.`);
    }
    throw new Error(`Studio process ${processId} did not exit after close was requested.`);
  }

  private async waitForProcessExit(
    processId: number,
    startedAt: string | undefined,
    verifyProcess: (process: StudioProcessInfo) => boolean,
    timeoutMs: number,
  ): Promise<'exited' | 'identity_mismatch' | 'timeout' | 'unknown'> {
    const deadline = Date.now() + timeoutMs;
    let sawUnknown = false;
    while (Date.now() <= deadline) {
      const snapshot = await this.getProcessSnapshot(true);
      if (snapshot.status === 'error') {
        sawUnknown = true;
      } else {
        const candidate = snapshot.processes.find((candidateProcess) => candidateProcess.Id === processId);
        if (candidate === undefined) return 'exited';
        if (!verifyProcess(candidate)) return 'identity_mismatch';
        if (
          startedAt !== undefined &&
          candidate.StartTimeUtcFileTime !== undefined &&
          candidate.StartTimeUtcFileTime !== startedAt
        ) {
          return 'identity_mismatch';
        }
      }
      await delay(Math.min(this.closePollMs, Math.max(1, deadline - Date.now())));
    }
    return sawUnknown ? 'unknown' : 'timeout';
  }

  private findProcessForConnectedInstance(
    instance: ConnectedStudioInstance,
    processes: StudioProcessInfo[],
  ): StudioProcessInfo | undefined {
    if (processes.length === 0) return undefined;
    if (processes.length === 1) return processes[0];

    const names = [instance.dataModelName, instance.placeName]
      .map((name) => name.trim())
      .filter((name, index, all) => name.length > 0 && all.indexOf(name) === index);

    const candidates = processes.filter((proc) => {
      const title = (proc.MainWindowTitle ?? '').trim();
      if (!title) return false;
      return names.some((name) =>
        title === `${name} - Roblox Studio` ||
        title.startsWith(`${name} - `) ||
        title.startsWith(`${name} (`),
      );
    });

    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      throw new Error(`Multiple Studio processes matched connected instance "${instance.instanceId}".`);
    }
    return undefined;
  }

  private async getProcessSnapshot(force = false): Promise<StudioProcessSnapshot> {
    const now = Date.now();
    if (!force && this.snapshotCacheMs > 0 && this.cachedSnapshot && now - this.cachedSnapshot.observedAt <= this.snapshotCacheMs) {
      return this.cachedSnapshot;
    }
    if (this.snapshotInFlight) return this.snapshotInFlight;
    this.snapshotInFlight = (async () => {
      try {
        let snapshot: StudioProcessSnapshot;
        if (this.processAdapter.observeStudioProcesses) {
          snapshot = await this.processAdapter.observeStudioProcesses();
        } else if (this.processAdapter.listStudioProcesses) {
          const observedAt = Date.now();
          const processes = await this.processAdapter.listStudioProcesses();
          snapshot = { status: 'ok', observedAt, processes };
        } else {
          snapshot = await observeStudioProcesses();
        }
        this.cachedSnapshot = snapshot;
        return snapshot;
      } catch (error) {
        const snapshot: StudioProcessSnapshot = {
          status: 'error',
          observedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        };
        this.cachedSnapshot = snapshot;
        return snapshot;
      } finally {
        this.snapshotInFlight = undefined;
      }
    })();
    return this.snapshotInFlight;
  }

  private async getCurrentBootId(): Promise<string> {
    return this.processAdapter.currentBootId
      ? await this.processAdapter.currentBootId()
      : currentBootId();
  }

  private async registrySweepOptions(
    snapshot: StudioProcessSnapshot,
  ): Promise<RegistrySweepOptions> {
    return {
      currentBootId: await this.getCurrentBootId(),
      observeProcess: (record) =>
        this.observeRecord(this.fromRegistryRecord(record), snapshot),
      cleanupRecord: (record) => this.cleanupManagedRecord(record),
      confirmedExitMisses: this.confirmedExitMisses,
      confirmedExitGraceMs: this.confirmedExitGraceMs,
    };
  }

  private async sweepRegistry(snapshot: StudioProcessSnapshot): Promise<void> {
    const sweepOptions = await this.registrySweepOptions(snapshot);
    await this.registry.sweep(sweepOptions);
  }

  private observeRecord(record: ManagedStudioInstance, snapshot: StudioProcessSnapshot): ManagedProcessObservation {
    if (snapshot.status === 'error') {
      return { status: 'unknown', observedAt: snapshot.observedAt, error: snapshot.error };
    }
    const processId = record.nativeProcessId ?? record.spawnPid;
    if (!processId) return { status: 'running', observedAt: snapshot.observedAt };
    const studioProcess = snapshot.processes.find((candidate) => candidate.Id === processId);
    if (!studioProcess) return { status: 'not_running', observedAt: snapshot.observedAt, reason: 'missing' };
    return this.verifyProcessForRecord(record, studioProcess)
      ? { status: 'running', observedAt: snapshot.observedAt }
      : { status: 'not_running', observedAt: snapshot.observedAt, reason: 'identity_mismatch' };
  }

  private verifyProcessForRecord(record: ManagedStudioInstance, studioProcess: StudioProcessInfo): boolean {
    const processName = `${studioProcess.Name ?? ''} ${studioProcess.Path ?? ''}`.toLowerCase();
    if (!processName.includes('robloxstudio')) return false;

    if (
      record.nativeProcessStartedAt !== undefined &&
      studioProcess.StartTimeUtcFileTime !== record.nativeProcessStartedAt
    ) {
      return false;
    }

    const processId = record.nativeProcessId ?? record.spawnPid;
    if (record.spawnPid && record.spawnPid === processId && studioProcess.Id === processId) return true;

    const processPath = studioProcess.Path ? path.normalize(studioProcess.Path).toLowerCase() : '';
    const exePath = record.exe ? path.normalize(record.exe).toLowerCase() : '';
    if (processPath && exePath && (processPath === exePath || basenameAny(processPath) === basenameAny(exePath))) {
      return true;
    }

    const commandLine = studioProcess.CommandLine ?? '';
    if (record.localPlaceFile && commandLine.includes(path.basename(record.localPlaceFile))) return true;
    if (record.placeId !== undefined && commandLine.includes(String(record.placeId))) return true;

    return false;
  }

  private cleanupManagedRecord(record: {
    source: string;
    localPlaceFile?: string;
  }) {
    if (record.source !== "baseplate") return;
    cleanupManagedBaseplateFiles({
      source: "baseplate",
      localPlaceFile: record.localPlaceFile,
    });
  }

  private markClosedInMemory(record: ManagedStudioInstance) {
    record.closedAt = record.closedAt ?? Date.now();
    if (record.instanceId) this.managedByInstanceId.delete(record.instanceId);
    this.pending.delete(record);
    this.clearConnectionTimer(record);
  }

  private async markProcessExited(
    record: ManagedStudioInstance,
    exitCode?: number,
    reason?: string,
  ): Promise<ManagedStudioInstance> {
    if (record.closedAt !== undefined) return record;
    const exitedAt = Date.now();
    record.exitedAt = exitedAt;
    record.closedAt = exitedAt;
    if (record.state !== "failed") record.state = "exited";
    record.processObservationStatus = "not_running";
    record.lastProcessObservationAt = exitedAt;
    record.lastSuccessfulProcessObservationAt = exitedAt;
    record.lastProcessObservationError = undefined;
    if (exitCode !== undefined) record.exitCode = exitCode;
    if (reason) record.failureReason = reason;
    this.cleanupManagedRecord(record);
    this.markClosedInMemory(record);
    await this.persist(record);
    return record;
  }

  /**
   * Studio updates itself by starting its installer and exiting 0; the installer
   * relaunches Studio with `-parentPid <exited pid>`. Until the plugin connection
   * deadline, adopt that relaunch instead of reporting the launch as exited.
   */
  private async followSelfRelaunch(record: ManagedStudioInstance, exitedPid: number): Promise<boolean> {
    const relaunchedFrom = new RegExp(`(?:^|\\s)-parentPid\\s+${exitedPid}(?=\\s|$)`, 'u');
    const deadline = record.connectionDeadlineAt ?? Date.now() + 120_000;
    this.awaitingRelaunch.add(record);
    try {
      while (Date.now() < deadline && record.closedAt === undefined) {
        const snapshot = await this.getProcessSnapshot(true);
        const relaunched = snapshot.status === 'ok'
          ? snapshot.processes.find((candidate) => relaunchedFrom.test(candidate.CommandLine ?? ''))
          : undefined;
        if (relaunched) {
          record.nativeProcessId = relaunched.Id;
          record.nativeProcessStartedAt = relaunched.StartTimeUtcFileTime;
          record.processObservationStatus = 'running';
          record.consecutiveConfirmedMisses = 0;
          record.firstConfirmedMissAt = undefined;
          await this.persist(record);
          return true;
        }
        await delay(500);
      }
      return false;
    } finally {
      this.awaitingRelaunch.delete(record);
    }
  }

  private startCoordinator(record: ManagedStudioInstance) {
    if (!record.recordId || record.closedAt !== undefined) return;
    if (record.state === 'launching' && record.connectionDeadlineAt !== undefined) {
      const timeout = setTimeout(() => {
        this.runInBackground(
          'persisting a Studio plugin connection timeout',
          this.markFailed(record, 'Studio launched, but the Roblox CLI plugin did not connect before timeout.'),
        );
      }, Math.max(0, record.connectionDeadlineAt - Date.now()));
      if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
      this.connectionTimers.set(record.recordId, timeout);
    }
    if (this.coordinatorTimer) return;
    this.coordinatorTimer = setInterval(() => {
      if (this.coordinatorRefresh) return;
      this.coordinatorRefresh = this.refreshOwnedRecords()
        .catch((error) => {
          this.reportBackgroundFailure('refreshing managed Studio records', error);
        })
        .finally(() => {
          this.coordinatorRefresh = undefined;
        });
    }, 5000);
    if (typeof this.coordinatorTimer === 'object' && 'unref' in this.coordinatorTimer) {
      this.coordinatorTimer.unref();
    }
  }

  private clearConnectionTimer(record: ManagedStudioInstance) {
    if (!record.recordId) return;
    const timer = this.connectionTimers.get(record.recordId);
    if (timer) clearTimeout(timer);
    this.connectionTimers.delete(record.recordId);
  }

  private async refreshOwnedRecords(): Promise<void> {
    const snapshot = await this.getProcessSnapshot(true);
    await this.sweepRegistry(snapshot);
    for (const record of [...this.managedByInstanceId.values(), ...this.pending]) {
      await this.refresh(record, snapshot);
    }
  }

  private runInBackground(context: string, operation: Promise<unknown>): void {
    void operation.catch((error) => this.reportBackgroundFailure(context, error));
  }

  private reportBackgroundFailure(context: string, error: unknown): void {
    console.warn(
      `[roblox-cli] failed while ${context}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private async applyProcessObservation(
    record: ManagedStudioInstance,
    observation: ManagedProcessObservation,
  ): Promise<void> {
    if (record.closedAt !== undefined) return;
    const previousObservationAt = record.lastProcessObservationAt;
    record.lastProcessObservationAt = observation.observedAt;

    if (observation.status === 'unknown') {
      record.processObservationStatus = 'unknown';
      record.lastProcessObservationError = observation.error;
      record.consecutiveConfirmedMisses = 0;
      record.firstConfirmedMissAt = undefined;
      await this.persistObservation(record);
      return;
    }

    record.lastSuccessfulProcessObservationAt = observation.observedAt;
    record.lastProcessObservationError = undefined;
    if (observation.status === 'running') {
      record.processObservationStatus = 'running';
      record.consecutiveConfirmedMisses = 0;
      record.firstConfirmedMissAt = undefined;
      await this.persistObservation(record);
      return;
    }

    record.processObservationStatus = 'not_running';
    // The first process of a self-relaunching launch is gone on purpose.
    if (this.awaitingRelaunch.has(record)) {
      await this.persistObservation(record);
      return;
    }
    if (previousObservationAt !== observation.observedAt) {
      record.consecutiveConfirmedMisses = (record.consecutiveConfirmedMisses ?? 0) + 1;
      record.firstConfirmedMissAt ??= observation.observedAt;
    }
    const confirmedAbsent = observation.reason === 'identity_mismatch' || (
      (record.consecutiveConfirmedMisses ?? 0) >= this.confirmedExitMisses &&
      observation.observedAt - (record.firstConfirmedMissAt ?? observation.observedAt) >= this.confirmedExitGraceMs
    );
    if (!confirmedAbsent) {
      await this.persistObservation(record);
      return;
    }
    await this.markProcessExited(
      record,
      undefined,
      observation.reason === 'identity_mismatch'
        ? 'Studio process identity changed; the retained PID was not reused.'
        : record.instanceId
          ? 'Studio process exited.'
          : 'Studio process exited before the Roblox CLI plugin connected.',
    );
  }

  private async reconcileFromPositiveEvidence(
    record: ManagedStudioInstance,
    snapshot: StudioProcessSnapshot,
  ): Promise<void> {
    if (record.closedAt === undefined) return;
    if (
      record.failureReason !== 'Studio process exited.' &&
      record.failureReason !== 'Studio process exited before the Roblox CLI plugin connected.'
    ) return;
    if (snapshot.status !== 'ok') return;
    const processId = record.nativeProcessId ?? record.spawnPid;
    const studioProcess = processId
      ? snapshot.processes.find((candidate) => candidate.Id === processId)
      : undefined;
    if (!studioProcess || !this.verifyProcessForRecord(record, studioProcess)) return;
    if (record.exitCode !== undefined) return;
    record.closedAt = undefined;
    record.exitedAt = undefined;
    record.failureReason = undefined;
    record.state = record.instanceId ? 'connected' : 'launching';
    record.processObservationStatus = 'running';
    record.lastProcessObservationAt = snapshot.observedAt;
    record.lastSuccessfulProcessObservationAt = snapshot.observedAt;
    record.lastProcessObservationError = undefined;
    record.consecutiveConfirmedMisses = 0;
    record.firstConfirmedMissAt = undefined;
    await this.persist(record);
  }

  private async persist(record: ManagedStudioInstance): Promise<void> {
    const registryRecord = this.toRegistryRecord(record);
    await this.registry.upsert(registryRecord);
    this.persistedState.set(registryRecord.recordId, persistedStateKey(registryRecord));
  }

  /**
   * Persist an observation only when it changes something a later reader acts
   * on. Observation timestamps alone stay in memory; rewriting every record on
   * every poll costs an fsync per Studio and contends on the registry lock.
   */
  private async persistObservation(record: ManagedStudioInstance): Promise<void> {
    if (this.persistedState.get(record.recordId ?? '') === persistedStateKey(this.toRegistryRecord(record))) return;
    await this.persist(record);
  }

  private toRegistryRecord(record: ManagedStudioInstance): ManagedInstanceRegistryRecord {
    if (!record.recordId) throw new Error('Managed Studio record is missing recordId.');
    if (!record.bootId) throw new Error('Managed Studio record is missing bootId.');
    return {
      version: 1,
      recordId: record.recordId,
      instanceId: record.instanceId,
      source: record.source,
      nativeProcessId: record.nativeProcessId,
      nativeProcessStartedAt: record.nativeProcessStartedAt,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
      studioWorkingDirectory: record.studioWorkingDirectory,
      launchedAt: record.launchedAt,
      attachedAt: record.connectedAt,
      connectionDeadlineAt: record.connectionDeadlineAt,
      state: record.state,
      failedAt: record.failedAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      failureReason: record.failureReason,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
      processObservationStatus: record.processObservationStatus,
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt: record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }

  private fromRegistryRecord(
    record: ManagedInstanceRegistryRecord,
  ): ManagedStudioInstance {
    this.persistedState.set(record.recordId, persistedStateKey(record));
    const state =
      record.state ??
      (record.closedAt !== undefined
        ? "exited"
        : record.instanceId
          ? "connected"
          : "launching");
    return {
      recordId: record.recordId,
      source: record.source as StudioLaunchSource,
      instanceId: record.instanceId,
      nativeProcessId: record.nativeProcessId,
      nativeProcessStartedAt: record.nativeProcessStartedAt,
      spawnPid: record.spawnPid,
      exe: record.exe,
      args: record.args,
      placeId: record.placeId,
      universeId: record.universeId,
      placeVersion: record.placeVersion,
      localPlaceFile: record.localPlaceFile,
      studioWorkingDirectory: record.studioWorkingDirectory,
      launchedAt: record.launchedAt,
      connectionDeadlineAt:
        record.connectionDeadlineAt ??
        (state === "launching" ? record.launchedAt + 120000 : undefined),
      state,
      connectedAt: record.attachedAt,
      failedAt: record.failedAt,
      exitedAt: record.exitedAt,
      exitCode: record.exitCode,
      failureReason: record.failureReason,
      closedAt: record.closedAt,
      ownerPid: record.ownerPid,
      bootId: record.bootId,
      deleteLocalPlaceFileOnClose: record.deleteLocalPlaceFileOnClose,
      processObservationStatus: record.processObservationStatus,
      lastProcessObservationAt: record.lastProcessObservationAt,
      lastSuccessfulProcessObservationAt:
        record.lastSuccessfulProcessObservationAt,
      lastProcessObservationError: record.lastProcessObservationError,
      consecutiveConfirmedMisses: record.consecutiveConfirmedMisses,
      firstConfirmedMissAt: record.firstConfirmedMissAt,
    };
  }
}
