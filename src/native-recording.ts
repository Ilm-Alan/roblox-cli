import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory } from './paths.js';
import { packageRoot } from './daemon-control.js';
import { acquireFocus } from './focus-session.js';
import { renderReceipt, type RenderSample } from './render-rate.js';
import { resolveStudioWindow } from './native-screen-capture.js';

/** The 600 s ceiling belongs to `roblox record --duration`, not to the
 * recorder. The start/stop form exists so a workflow owns the length of its
 * own video, so a recording without its own cap is still passed this much
 * larger runaway cap: a lost stop or a dead owner cannot record forever. */
export const MAX_FIXED_RECORDING_SECONDS = 600;
export const MAX_RECORDING_SECONDS = 86_400;

/** The recorder abandons its own start after this long (display wake, window
 * binding, ScreenCaptureKit start). */
const RECORDER_START_SECONDS = 30;
/** Waiting for the start acknowledgement outlasts the recorder's own bound, so
 * a slow but healthy start is never abandoned while it can still succeed. */
export const RECORDER_ACK_TIMEOUT_MS = (RECORDER_START_SECONDS + 10) * 1000;

export interface RecordingCrop {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Pixel size of the capture the crop was measured on. The helper compares
   * this with the live window and refuses a stale crop rather than stretching
   * it, and the caller falls back to a full-window recording. */
  capture_width: number;
  capture_height: number;
}

export interface RecordingState {
  id: string;
  file: string;
  socket: string;
  state_file: string;
  pid: number;
  started_at: string;
  active: boolean;
  started?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  elapsed_seconds?: number;
  error?: string;
}

function recordingsDirectory(): string {
  return join(dataDirectory(), 'recordings');
}

function helperPath(): string {
  const helper = join(packageRoot(), 'dist', 'native', 'record-studio');
  if (!existsSync(helper))
    throw new Error('Native recorder is missing. Run npm run build in roblox-cli.');
  return helper;
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  }
  catch {
    return undefined;
  }
}

/** A stale state file must not keep reporting a recording as active, so
 * liveness is decided by the recorded pid, not by the flag alone. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  }
  catch {
    return false;
  }
}

/** Every recording this machine knows about, newest first. The index outlives
 * the process that started it, so `stop` and `status` work from any
 * roblox-cli invocation. */
export function recordingIndex(): RecordingState[] {
  const directory = recordingsDirectory();
  if (!existsSync(directory)) return [];
  const entries: RecordingState[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json') || name.endsWith('.state.json')) continue;
    const index = readJsonFile(join(directory, name)) as RecordingState | undefined;
    if (!index || typeof index.file !== 'string' || typeof index.state_file !== 'string') continue;
    const state = readJsonFile(index.state_file);
    const active = state?.active === true && processAlive(index.pid);
    entries.push({
      ...index,
      active,
      ...(state?.started === undefined ? {} : { started: state.started as Record<string, unknown> }),
      ...(state?.receipt === undefined ? {} : { receipt: state.receipt as Record<string, unknown> }),
      ...(state?.error === undefined ? {} : { error: String(state.error) }),
      ...(active ? { elapsed_seconds: Math.max(0, (Date.now() - Date.parse(index.started_at)) / 1000) } : {}),
    });
  }
  return entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
}

export function activeRecording(): RecordingState | undefined {
  return recordingIndex().find(entry => entry.active);
}

/** `roblox status` and `roblox test status` report whether a recording is
 * active, which file it is writing and how long it has been running. */
export function recordingStatus(): Record<string, unknown> {
  const recordings = recordingIndex();
  const active = recordings.find(entry => entry.active);
  return {
    active: active !== undefined,
    ...(active === undefined ? {} : {
      file: active.file,
      elapsed_seconds: active.elapsed_seconds,
      started_at: active.started_at,
      width: active.started?.width,
      height: active.started?.height,
      window_id: active.started?.window_id,
      viewport: active.started?.viewport,
    }),
  };
}

export interface StartRecordingRequest {
  file: string;
  seconds?: number;
  fps?: number;
  identity?: { placeName?: string; pid?: number };
  crop?: RecordingCrop;
}

function validateStartRequest(request: StartRecordingRequest): string {
  const file = resolve(request.file);
  if (!file.endsWith('.mp4'))
    throw new Error('Recording output must end in .mp4.');
  if (existsSync(file))
    throw new Error(`Recording output already exists: ${file}`);
  if (request.seconds !== undefined && (!Number.isFinite(request.seconds) || request.seconds <= 0 || request.seconds > MAX_RECORDING_SECONDS))
    throw new Error(`Recording seconds must be between 0 and ${MAX_RECORDING_SECONDS}.`);
  if (request.fps !== undefined && (!Number.isInteger(request.fps) || request.fps < 1 || request.fps > 60))
    throw new Error('Recording fps must be an integer between 1 and 60.');
  const running = activeRecording();
  if (running)
    throw new Error(`A recording is already active: ${running.file}. Stop it before starting another.`);
  return file;
}

export function recorderArguments(helper: string, file: string, socketPath: string, stateFile: string, windowId: number, ownerPid: number, request: StartRecordingRequest): string[] {
  // `-u` declares user activity, which both prevents idle display sleep and
  // wakes a display that is already asleep. Without it ScreenCaptureKit
  // accepts the stream and then fails its first sample buffer, which reads as
  // a capture bug rather than a power state.
  const arguments_ = ['-d', '-i', '-u', helper, 'run', file, '--socket', socketPath, '--state', stateFile,
    '--window-id', String(windowId), '--owner-pid', String(ownerPid),
    '--seconds', String(request.seconds ?? MAX_RECORDING_SECONDS),
    '--start-timeout', String(RECORDER_START_SECONDS)];
  if (request.fps !== undefined) arguments_.push('--fps', String(request.fps));
  if (request.crop) {
    arguments_.push('--crop',
      [request.crop.x, request.crop.y, request.crop.width, request.crop.height].join(','),
      '--capture-width', String(request.crop.capture_width));
  }
  return arguments_;
}

/**
 * Spawn the native recorder as a child of the calling process.
 *
 * This is the path the capture worker uses. Screen Recording permission
 * attaches to the responsible application, so a recorder spawned by a daemon
 * whose starter lacked it is denied with SCK -3801 while the same helper
 * spawned by the terminal-owned worker is allowed.
 */
export async function spawnRecorder(request: StartRecordingRequest & { window: { id: number; pid: number } }): Promise<Record<string, unknown>> {
  const helper = helperPath();
  const file = validateStartRequest(request);
  const id = randomUUID();
  const directory = recordingsDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = join(directory, `${id}.sock`);
  const stateFile = join(directory, `${id}.state.json`);
  const indexFile = join(directory, `${id}.json`);
  const startedAt = new Date().toISOString();
  const writeIndex = (pid: number) => writeFileSync(indexFile,
    `${JSON.stringify({ id, file, socket: socketPath, state_file: stateFile, pid, started_at: startedAt })}\n`,
    { mode: 0o600 });
  writeIndex(0);

  // The recorder outlives this call: an uncapped recording runs until `stop`,
  // so only the first stdout line — the start acknowledgement — is read here.
  // `detached` makes caffeinate lead its own process group, and the recorder
  // it runs belongs to that group.
  const child = spawn('caffeinate',
    recorderArguments(helper, file, socketPath, stateFile, request.window.id, request.window.pid, request),
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.unref();
  let stderr = '';
  let spawnError = '';
  child.once('error', error => { spawnError = error.message; });
  const collectStderr = (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2048); };
  child.stderr.on('data', collectStderr);
  const abandon = (reason: string): never => {
    // Killing caffeinate alone would orphan a recorder that goes on recording
    // with no index entry anyone could stop, so the whole group is killed.
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The group already exited. */ }
    }
    for (const path of [indexFile, stateFile, socketPath]) rmSync(path, { force: true });
    const detail = [spawnError, stderr.trim()].filter(Boolean).join(': ');
    throw new Error(`${reason}${detail ? `: ${detail}` : ''}`);
  };
  let acknowledged: Record<string, unknown>;
  try {
    acknowledged = await firstJsonLine(child.stdout, RECORDER_ACK_TIMEOUT_MS);
  }
  catch (error) {
    return abandon(`Recorder did not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  finally {
    // Open pipes keep the caller's event loop alive until the recorder exits,
    // which would hold `roblox record-studio start` open for the whole
    // recording. The recorder tolerates the closed pipes; its state file
    // carries the final receipt.
    child.stderr.off('data', collectStderr);
    child.stdout.destroy();
    child.stderr.destroy();
  }
  if (acknowledged.started !== true)
    return abandon('Recorder did not confirm that capture began.');
  writeIndex(Number(acknowledged.pid));
  // The caller needs the state file to wait for finalization; it is internal
  // bookkeeping rather than part of the recorder's own receipt.
  return { ...acknowledged, recording_id: id, state_file: stateFile };
}

/**
 * Start one continuous recording bound to one Studio window. The returned
 * receipt is the recorder's own acknowledgement, so a caller never reports a
 * video the recorder never began.
 *
 * Screen Recording permission decides which process may spawn the helper, so
 * a direct caller (the terminal) and the terminal-owned capture worker both
 * call {@link spawnRecorder}; only the window resolution differs.
 */
export async function startNativeRecording(request: StartRecordingRequest): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin')
    throw new Error('Recording requires macOS 15 or later.');
  const window = await resolveStudioWindow(request.identity);
  return { ...await spawnRecorder({ ...request, window }), window };
}

/** The recorder reports its start as one JSON line and its final receipt as
 * another, so only the first line is the acknowledgement. */
function firstJsonLine(stream: Readable, timeoutMs: number): Promise<Record<string, unknown>> {
  const { promise, resolve: resolved, reject } = Promise.withResolvers<Record<string, unknown>>();
  let buffer = '';
  const timer = setTimeout(() => reject(new Error(`the recorder did not acknowledge within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  const finish = (value: Record<string, unknown>) => {
    clearTimeout(timer);
    resolved(value);
  };
  const fail = (error: Error) => {
    clearTimeout(timer);
    reject(error);
  };
  stream.on('data', chunk => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    try {
      const parsed = JSON.parse(buffer.slice(0, newline)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      finish(parsed as Record<string, unknown>);
    }
    catch (error) {
      fail(new Error(`the recorder acknowledgement was not a JSON object: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  stream.on('error', error => fail(error));
  stream.on('close', () => fail(new Error('the recorder exited before acknowledging')));
  return promise;
}

/** Send one control command and collect the recorder's whole reply. */
function exchange(socketPath: string, command: string): Promise<string> {
  const { promise, resolve: resolved, reject } = Promise.withResolvers<string>();
  const connection = connect(socketPath);
  let reply = '';
  connection.setEncoding('utf8');
  connection.setTimeout(5_000, () => connection.destroy(new Error('the recorder did not answer within 5s')));
  connection.on('data', chunk => { reply += chunk; });
  connection.on('error', reject);
  connection.on('close', () => resolved(reply));
  connection.end(`${command}\n`);
  return promise;
}

/**
 * Ask the recorder to stop. Only a `{"stopping":true}` reply means it took the
 * command; any other reply (it answers `{"active":true}` to a line it could
 * not read) or no reply is retried, so a stop is never silently lost.
 */
export async function requestStop(socketPath: string, attempts = 5, retryDelayMs = 200): Promise<{ stopping: boolean; detail: string }> {
  let detail = 'no attempt was made';
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await delay(retryDelayMs);
    try {
      const reply = (await exchange(socketPath, 'stop')).trim();
      let parsed: unknown;
      try { parsed = JSON.parse(reply); } catch { /* Reported below as an unexpected reply. */ }
      if (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>).stopping === true)
        return { stopping: true, detail: reply };
      detail = reply ? `the recorder answered ${reply}` : 'the recorder closed the connection without answering';
    }
    catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
  }
  return { stopping: false, detail };
}

/** Wait for the recorder to report a finalized file. Finalization writes and
 * fsyncs the MP4 before the state file carries the receipt, so observing the
 * receipt also proves a readable file exists. A recorder that exits without a
 * receipt fails the wait at once instead of at the timeout. */
async function awaitFinalization(stateFile: string, file: string, pid: number, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Liveness is sampled before the state, so a recorder that wrote its
    // receipt and then exited is still seen finalized.
    const alive = processAlive(pid);
    const state = readJsonFile(stateFile);
    if (state?.active === false) {
      if (state.receipt && typeof state.receipt === 'object') {
        let bytes = 0;
        try { bytes = statSync(file).size; } catch { /* A vanished file is reported as zero bytes. */ }
        return { ...state.receipt as Record<string, unknown>, bytes };
      }
      throw new Error(`Recorder stopped without a receipt: ${String(state.error ?? 'unknown reason')}`);
    }
    if (!alive)
      throw new Error(`Recorder (pid ${pid}) exited without finalizing ${file}${state?.error === undefined ? '' : `: ${String(state.error)}`}`);
    await delay(100);
  }
  throw new Error(`Recorder did not finalize within ${Math.round(timeoutMs / 1000)}s: ${file}`);
}

/** Stop the active recording and return the recorder's final receipt. */
export async function stopNativeRecording(file?: string): Promise<Record<string, unknown>> {
  if (process.platform !== 'darwin')
    throw new Error('Recording requires macOS 15 or later.');
  const recordings = recordingIndex();
  const target = file === undefined
    ? recordings.find(entry => entry.active) ?? recordings[0]
    : recordings.find(entry => resolve(entry.file) === resolve(file));
  if (!target)
    throw new Error(file === undefined ? 'No recording is known to this machine.' : `No recording is known for ${resolve(file)}.`);
  if (!target.active) {
    if (target.receipt) return { ...target.receipt, already_stopped: true };
    throw new Error(`Recording ${target.file} is not active and has no finalized receipt.`);
  }
  const stop = await requestStop(target.socket);
  // A recorder that already removed its control socket is finalizing on its
  // own (its cap elapsed or capture ended), and a dead one fails the wait at
  // once; only a live recorder still listening refused the stop.
  if (!stop.stopping && existsSync(target.socket) && processAlive(target.pid))
    throw new Error(`Recorder did not accept the stop command: ${stop.detail}`);
  return awaitFinalization(target.state_file, target.file, target.pid, 30_000);
}

/**
 * The documented `roblox record --duration SECONDS --output FILE.mp4` contract.
 * Studio stays in the background unless `foreground` is set: the recorder
 * keeps the display awake itself, and the opt-in lease exists only for a
 * full-rate capture (Studio throttles its rendering when it is not frontmost).
 * `sampleRender` reads the plugin's render counters around the capture so the
 * receipt carries the rate Studio actually rendered at.
 */
export async function recordNativeStudio(seconds: number, output: string, options: {
  foreground?: boolean;
  sampleRender?: () => Promise<RenderSample | undefined>;
} = {}): Promise<Record<string, unknown>> {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_FIXED_RECORDING_SECONDS)
    throw new Error(`Recording duration must be between 0 and ${MAX_FIXED_RECORDING_SECONDS} seconds.`);
  const file = resolve(output);
  mkdirSync(dirname(file), { recursive: true });
  const foreground = options.foreground === true;
  const focus = await acquireFocus(foreground);
  try {
    const renderStart = await options.sampleRender?.();
    const started = await startNativeRecording({ file, seconds });
    const receipt = await awaitFinalization(String(started.state_file), file, Number(started.pid), (seconds + 60) * 1000);
    const render = renderReceipt(renderStart, await options.sampleRender?.(), foreground);
    return { ...receipt, ...(render ?? {}), focus: focus.receipt };
  }
  finally {
    await focus.release();
  }
}
