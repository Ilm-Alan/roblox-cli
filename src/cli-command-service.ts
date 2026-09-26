import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeService, PublicStudioInstance } from './bridge-service.js';
import { evaluationError, normalizeCommandResult, publicEvaluation, publicRequestStatus } from './command-results.js';
import type { ToolInvocationContext } from './command-results.js';
import { CliCommandError } from './cli-errors.js';
import { dataDirectory } from './paths.js';
import { compileScenario, validateDiagnostics, scenarioNeedsInput, type Scenario, type Condition } from './scenario.js';
import { TestJobs, childRequestId } from './test-jobs.js';
import { targetingProbe, diagnosticProbe } from './native-probes.js';
import { acquireFocus } from './focus-session.js';
import { captureFrame } from './capture-pipeline.js';
import { recordingStatus } from './native-recording.js';
import { startScenarioRecording, writeTimeline, type ScenarioRecordingSession, type TimelineEntry } from './scenario-recording.js';
import { calibratedViewportRect } from './viewport-capture.js';
import type { RobloxStudioTools } from './tools/index.js';

type JsonObject = Record<string, unknown>;

function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return signal ? delay(ms, undefined, { signal }) : delay(ms);
}

export interface CliSession {
  session_id: string;
  instance_id: string;
  ownership: 'attached' | 'managed';
  source: string;
  place_id?: number;
  place_name?: string;
  multiplayer_group_id?: string;
  opened_at: string;
}

export type CliCommandHandler = (
  tools: RobloxStudioTools,
  body: JsonObject,
  context?: ToolInvocationContext,
) => Promise<unknown>;

function parseToolResult(raw: unknown): unknown {
  const normalized = normalizeCommandResult(raw);
  if (
    normalized &&
    typeof normalized === 'object' &&
    !Array.isArray(normalized) &&
    'content' in normalized &&
    Array.isArray((normalized as JsonObject).content)
  ) {
    const content = (normalized as JsonObject).content as unknown[];
    if (content.length > 1) {
      const textBlock = content.find((item) => item && typeof item === 'object' && !Array.isArray(item)
        && (item as JsonObject).type === 'text' && typeof (item as JsonObject).text === 'string');
      const imageBlocks = content.filter((item) => item && typeof item === 'object' && !Array.isArray(item)
        && (item as JsonObject).type === 'image');
      let metadata: JsonObject = {};
      if (textBlock) {
        try {
          const parsed = JSON.parse((textBlock as JsonObject).text as string);
          metadata = asObject(parsed);
        } catch {
          metadata = { message: (textBlock as JsonObject).text };
        }
      }
      if (imageBlocks.length > 0) {
        return {
          ...metadata,
          image: imageBlocks.length === 1 ? publicImage(imageBlocks[0]) : imageBlocks.map((block) => publicImage(block)),
        };
      }
      return metadata;
    }
    if (content.length !== 1) return normalized;
    const block = content[0];
    if (block && typeof block === 'object' && !Array.isArray(block) && 'text' in block) {
      const text = (block as JsonObject).text;
      if (typeof text === 'string') {
        try {
          return JSON.parse(text);
        } catch {
          return { text };
        }
      }
    }
  }
  return normalized;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function publicImage(value: unknown): JsonObject {
  const body = asObject(value);
  const { type: _type, mimeType, ...rest } = body;
  return {
    ...rest,
    ...(body.mime_type === undefined && mimeType !== undefined ? { mime_type: mimeType } : {}),
  };
}

function publicScreenshot(value: unknown): JsonObject {
  const body = asObject(value);
  const { success: _success, message: _message, mimeType, image, data, type: _type, ...rest } = body;
  const result: JsonObject = {
    ...rest,
    ...(body.mime_type === undefined && mimeType !== undefined ? { mime_type: mimeType } : {}),
  };
  if (image !== undefined) result.image = Array.isArray(image)
    ? image.map((entry) => publicImage(entry))
    : publicImage(image);
  else if (data !== undefined) result.image = publicImage({ data, mimeType });
  if (result.note === '') delete result.note;
  return result;
}

/**
 * Bound one teardown await.
 *
 * Teardown runs in a `finally`, so an await that never settles there leaves the
 * job in `cleanup` forever and keeps the session owned. Each step is given its
 * own deadline and its expiry is recorded as evidence, so a slow native helper
 * degrades into a reported timeout instead of a wedged job.
 */
async function withDeadline<T>(label: string, ms: number, work: Promise<T>, onTimeout: (label: string, ms: number) => void): Promise<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    onTimeout(label, ms);
    resolve(undefined as T);
  }, ms);
  timer.unref();
  void work.then(
    value => { clearTimeout(timer); resolve(value); },
    () => { clearTimeout(timer); resolve(undefined as T); },
  );
  return promise;
}

function isFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as JsonObject;
  return body.error !== undefined || body.isError === true || body.success === false || body.ok === false || body.passed === false;
}

function isSuspiciousRuntimeHealth(value: unknown): boolean {
  const body = asObject(value);
  const health = body.runtime_health ?? body.runtimeHealth;
  if (!health || typeof health !== 'object' || Array.isArray(health)) return false;
  for (const entry of Object.values(health as JsonObject)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const peer = entry as JsonObject;
    if (typeof peer.error === 'string') return true;
    const render = asObject(peer.render);
    const runtimePeer = peer.role !== 'server' && peer.role !== 'edit';
    if (runtimePeer && render.available === false) return true;
    if (runtimePeer && (render.rendering === false || render.state === 'stale')) return true;

  }
  return false;
}

const WAIT_UNTIL_POLL_MS = 50;
// The bridge retains at most 1024 operation results; a recovered eval without
// a retained result has no payload to shape, so older targets are not needed.
const EVALUATION_TARGET_LIMIT = 1024;
const TEST_MODES = ['run', 'play', 'status', 'stop', 'cancel', 'resume', 'result', 'validate', 'diagnose', 'calibrate'] as const;

function numberField(value: unknown, name: string, options: { integer?: boolean; min?: number; max?: number } = {}): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || (options.integer && !Number.isInteger(parsed)) ||
    (options.min !== undefined && parsed < options.min) || (options.max !== undefined && parsed > options.max)) {
    throw new CliCommandError('invalid_argument', `${name} is invalid.`);
  }
  return parsed;
}

function requiredNumberField(
  value: unknown,
  name: string,
  options: { integer?: boolean; min?: number; max?: number } = {},
): number {
  const parsed = numberField(value, name, options);
  if (parsed === undefined) throw new CliCommandError('invalid_argument', `${name} is required.`);
  return parsed;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliCommandError('invalid_argument', `${name} is required.`);
  }
  return value;
}

function publicInstance(instance: PublicStudioInstance): JsonObject {
  return {
    instance_id: instance.id,
    place_id: instance.placeId,
    place_name: instance.placeName,
    multiplayer_group_id: instance.multiplayerGroupId,
    roles: instance.peers.map((peer) => peer.role).sort(),
  };
}

function publicLaunch(value: unknown): JsonObject {
  const body = asObject(value);
  const fields = [
    'launch_id', 'instance_id', 'source', 'state', 'place_id', 'place_version',
    'connected', 'roles', 'failure_reason',
  ] as const;
  return Object.fromEntries(fields
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]]));
}

function publicClose(value: unknown): JsonObject {
  const body = publicLifecycle(value);
  const fields = ['launch_id', 'instance_id', 'close_status', 'state', 'connected', 'roles'] as const;
  return Object.fromEntries(fields
    .filter((key) => body[key] !== undefined)
    .map((key) => [key, body[key]]));
}

function publicLifecycle(value: unknown): JsonObject {
  const body = asObject(value);
  const { success: _success, ok: _ok, isError: _isError, action: _action, message: _message, outcome: _outcome, ...rest } = body;
  return rest;
}

function publicLogInstance(value: unknown): JsonObject {
  const body = asObject(value);
  return {
    ...(body.instanceId === undefined ? {} : { instance_id: body.instanceId }),
    ...(body.error === undefined ? {} : { error: body.error }),
    ...(body.entries === undefined ? {} : { entries: body.entries }),
    ...(body.dropped === undefined ? {} : { dropped: body.dropped }),
    ...(body.omittedByTail === undefined ? {} : { omitted_by_tail: body.omittedByTail }),
    ...(body.gaps === undefined ? {} : { gaps: body.gaps }),
    ...(body.nextCursor === undefined ? {} : { next_cursor: body.nextCursor }),
    ...(body.peerErrors === undefined ? {} : {
      peer_errors: Array.isArray(body.peerErrors)
        ? body.peerErrors.map((entry) => {
          const peer = asObject(entry);
          return {
            ...(peer.peerId === undefined ? {} : { peer_id: peer.peerId }),
            ...(peer.role === undefined ? {} : { role: peer.role }),
            ...(peer.error === undefined ? {} : { error: peer.error }),
          };
        })
        : body.peerErrors,
    }),
  };
}

function publicLogs(value: unknown, scope: string): JsonObject {
  const body = asObject(value);
  if (Array.isArray(body.instances)) {
    const instances = body.instances.map((instance) => publicLogInstance(instance));
    let dropped = 0;
    let omittedByTail = 0;
    for (const instance of instances) {
      if (typeof instance.dropped === 'number') dropped += instance.dropped;
      if (typeof instance.omitted_by_tail === 'number') omittedByTail += instance.omitted_by_tail;
    }
    return {
      scope,
      ...(body.multiplayerGroupId === undefined ? {} : { multiplayer_group_id: body.multiplayerGroupId }),
      dropped,
      omitted_by_tail: omittedByTail,
      gaps: instances.flatMap((instance) => Array.isArray(instance.gaps) ? instance.gaps : []),
      instances,
      ...(body.nextCursorByInstance === undefined ? {} : { next_cursor_by_instance: body.nextCursorByInstance }),
    };
  }
  return { scope, ...publicLogInstance(body) };
}

class CliSessionState {
  private active?: CliSession;
  private readonly filePath = join(dataDirectory(), 'session.json');

  constructor(private readonly bridge: BridgeService) {
    this.active = this.read();
  }

  snapshot(): JsonObject | undefined {
    if (!this.active) return undefined;
    const instance = this.bridge.getPublicInstances().find((candidate) => candidate.id === this.active?.instance_id);
    return {
      ...this.active,
      connected: instance !== undefined,
      roles: instance?.peers.map((peer) => peer.role).sort() ?? [],
      place_id: instance?.placeId ?? this.active.place_id,
      place_name: instance?.placeName ?? this.active.place_name,
      multiplayer_group_id: instance?.multiplayerGroupId ?? this.active.multiplayer_group_id,
    };
  }

  current(): CliSession | undefined {
    return this.active;
  }

  async set(session: CliSession): Promise<void> {
    this.active = session;
    mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
    this.persist({ ...session });
  }

  async clear(): Promise<void> {
    this.active = undefined;
    try {
      this.persist({});
    } catch {
      // A session is in-memory authoritative for the running daemon. The file
      // is only a convenience for reconciliation after a daemon restart.
    }
  }

  private persist(value: JsonObject): void {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filePath);
    } finally {
      try { unlinkSync(temporary); } catch { /* already renamed or unavailable */ }
    }
  }

  require(body: JsonObject): CliSession {
    const session = this.active;
    if (!session) {
      throw new CliCommandError(
        'session_required',
        'No active Studio session. Run "roblox open" first.',
        { details: { next: 'roblox open' } },
      );
    }
    if (body.session_id !== undefined && body.session_id !== session.session_id) {
      throw new CliCommandError('session_mismatch', 'The requested session is not the active session.', {
        details: { active_session_id: session.session_id },
      });
    }
    if (body.instance_id !== undefined && body.instance_id !== session.instance_id) {
      throw new CliCommandError('single_session', 'Only one active Studio session is supported; close it before switching.', {
        details: { active_instance_id: session.instance_id },
      });
    }
    if (!this.bridge.getPublicInstances().some((instance) => instance.id === session.instance_id)) {
      // Checked before any dispatch, so nothing ran. `roblox open` re-attaches
      // when exactly one Studio edit Peer is connected.
      throw new CliCommandError('session_disconnected', 'The active Studio session is no longer connected. Run "roblox open" to re-attach.', {
        details: { session_id: session.session_id, instance_id: session.instance_id, next: 'roblox open' },
      });
    }
    return session;
  }

  private read(): CliSession | undefined {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<CliSession>;
      if (
        typeof value.session_id === 'string' &&
        typeof value.instance_id === 'string' &&
        (value.ownership === 'attached' || value.ownership === 'managed') &&
        typeof value.source === 'string' &&
        typeof value.opened_at === 'string'
      ) {
        return value as CliSession;
      }
    } catch {
      // Ignore a torn or old session file and let `open` establish a fresh one.
    }
    return undefined;
  }
}

export class CliCommandService {
  readonly sessions: CliSessionState;
  readonly jobs: TestJobs;
  private sessionQueue: Promise<void> = Promise.resolve();
  /** Eval targets by operation id, so request recovery can return the live eval payload. */
  private readonly evaluationTargets = new Map<string, string>();

  constructor(
    private readonly tools: RobloxStudioTools,
    private readonly bridge: BridgeService,
  ) {
    this.sessions = new CliSessionState(bridge);
    this.jobs = new TestJobs({
      session: () => this.sessions.require({}),
      runtime: () => this.runtimeIdentity(),
      execute: (body, context) => this.testPlay(body, context),
      check: async (check) => (await this.runWaitUntil({ ...check, timeout_ms: Math.min(check.timeout_ms ?? 1000, 5000) })).passed === true,
      cleanup: body => this.releaseScenarioInput(body.scenario as Scenario),
    });
  }

  sessionSnapshot(): JsonObject | undefined {
    return this.sessions.snapshot();
  }

  /** Public status of a bridge operation; an eval reports the payload the live eval command returned. */
  requestStatus(requestId: string): JsonObject | undefined {
    const status = this.bridge.getRequestStatus(requestId);
    if (status === undefined) return undefined;
    const target = this.evaluationTargets.get(requestId);
    return publicRequestStatus(status, target === undefined ? undefined : { target });
  }

  private runtimeIdentity(): string[] {
    const session = this.sessions.require({});
    return this.bridge.getPeersInScope(session.instance_id)
      .filter(peer => peer.role !== 'edit' && peer.isRunning)
      .map(peer => `${peer.role}:${peer.peerId}`).sort();
  }

  submitTest(body: JsonObject, id?: string): unknown {
    this.sessions.require(body);
    if (body.mode !== undefined && !['play', 'run'].includes(String(body.mode))) throw new CliCommandError('invalid_argument', 'mode must be play or run.');
    const players = numberField(body.players, 'players', { integer: true, min: 1, max: 8 }) ?? 1;
    if (body.mode === 'run' && players > 1) throw new CliCommandError('invalid_argument', 'Run mode is solo only.');
    numberField(body.duration_ms, 'duration_ms', { integer: true, min: 0, max: 86_400_000 });
    if (body.foreground !== undefined && !['auto', 'never', 'required'].includes(String(body.foreground))) throw new CliCommandError('invalid_argument', 'foreground must be auto, never or required.');
    if (body.scenario === undefined && body.duration_ms === undefined && body.keep_open !== true) throw new CliCommandError('invalid_argument', 'test play requires duration, scenario or keep_open.');
    const scenario = compileScenario(body.scenario ?? { steps: [] });
    return this.jobs.submit(body, scenario, id);
  }

  async open(body: JsonObject): Promise<unknown> {
    return this.withSessionLock(() => this.openUnlocked(body));
  }

  private async withSessionLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueue;
    let release!: () => void;
    this.sessionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async openUnlocked(body: JsonObject): Promise<unknown> {
    const action = body.action ?? 'open';
    if (action === 'status') return { session: this.sessions.snapshot() ?? null };
    if (action === 'close') {
      const current = this.sessions.current();
      if (current && this.jobs.hasActive(current.instance_id)) throw new CliCommandError('job_active', 'Cancel the active job and wait for input cleanup before closing its Studio session.');
      return this.closeUnlocked(body);
    }
    if (action !== 'open') throw new CliCommandError('invalid_argument', 'open action must be open, status, or close.');

    const source = body.source === undefined ? 'attach' : requiredString(body.source, 'source');
    if (body.instance_id !== undefined && typeof body.instance_id !== 'string') {
      throw new CliCommandError('invalid_argument', 'instance_id must be a string when provided.');
    }
    if (!['attach', 'baseplate', 'file', 'place', 'revision'].includes(source)) {
      throw new CliCommandError('invalid_argument', 'open source must be attach, baseplate, file, place, or revision.');
    }

    const active = this.sessions.current();
    const activeConnected = active !== undefined
      && this.bridge.getPublicInstances().some((instance) => instance.id === active.instance_id);
    if (active && activeConnected) {
      if (source === 'attach' && (body.instance_id === undefined || body.instance_id === active.instance_id)) {
        return { session: this.sessions.snapshot(), idempotent: true };
      }
      throw new CliCommandError('single_session', 'Only one active Studio session is supported; run "roblox close" before opening another.', {
        details: { active_session_id: active.session_id, active_instance_id: active.instance_id },
      });
    }
    // A session whose Studio is gone is never reported as idempotent success:
    // this open replaces it, and an attach reports that it re-attached.
    const stale = active;
    if (stale && this.jobs.hasActive(stale.instance_id)) {
      throw new CliCommandError('job_active', 'Cancel the active job and wait for input cleanup before replacing its Studio session.');
    }

    if (source === 'attach') {
      const instances = this.bridge.getPublicInstances();
      const requested = typeof body.instance_id === 'string'
        ? instances.find((instance) => instance.id === body.instance_id)
        : undefined;
      if (body.instance_id !== undefined && !requested) {
        throw new CliCommandError('instance_not_found', `Studio instance "${String(body.instance_id)}" is not connected.`);
      }
      if (requested && !requested.peers.some((peer) => peer.role === 'edit')) {
        throw new CliCommandError('target_role_not_present', `Studio instance "${requested.id}" has no edit Peer; roblox open attaches to edit mode.`, {
          details: { instance: publicInstance(requested), required_role: 'edit' },
        });
      }
      const candidates = requested ? [requested] : instances.filter((instance) => instance.peers.some((peer) => peer.role === 'edit'));
      if (candidates.length === 0) {
        throw new CliCommandError('studio_not_connected', 'No Roblox Studio plugin is connected.', {
          details: {
            next: 'Open Roblox Studio with the Roblox CLI plugin installed.',
            ...(stale ? { disconnected_session_id: stale.session_id, disconnected_instance_id: stale.instance_id } : {}),
          },
        });
      }
      if (candidates.length > 1) {
        throw new CliCommandError('multiple_sessions', 'Multiple Studio instances are connected; pass --instance-id.', {
          details: {
            instance_ids: candidates.map((instance) => instance.id),
            instances: candidates.map(publicInstance),
            next: 'roblox open --instance-id ID',
          },
        });
      }
      const instance = candidates[0];
      const session: CliSession = {
        session_id: randomUUID(),
        instance_id: instance.id,
        ownership: 'attached',
        source,
        place_id: instance.placeId,
        place_name: instance.placeName,
        multiplayer_group_id: instance.multiplayerGroupId,
        opened_at: new Date().toISOString(),
      };
      await this.sessions.set(session);
      return {
        session: this.sessions.snapshot(),
        ...(stale ? { reattached: true, previous_session: { session_id: stale.session_id, instance_id: stale.instance_id } } : {}),
      };
    }

    const request: JsonObject = {
      action: 'launch',
      source: source === 'file'
        ? 'local_file'
        : source === 'place'
          ? 'published_place'
          : source === 'revision'
            ? 'place_revision'
            : source,
      timeout_ms: numberField(body.timeout_ms, 'timeout_ms', { integer: true, min: 1, max: 300_000 }) ?? 120_000,
    };
    if (source === 'file') {
      const localPath = requiredString(body.path, 'path');
      try {
        if (!statSync(localPath).isFile()) throw new Error('path is not a regular file');
      } catch (error) {
        throw new CliCommandError('invalid_argument', `path must point to a readable place file: ${error instanceof Error ? error.message : String(error)}`);
      }
      request.local_place_file = localPath;
    }
    if (source === 'place' || source === 'revision') {
      request.place_id = requiredNumberField(body.place_id, 'place_id', { integer: true, min: 1 });
    }
    if (source === 'revision') {
      request.place_version = requiredNumberField(body.revision, 'revision', { integer: true, min: 1 });
    }

    let launched: JsonObject;
    try {
      launched = asObject(parseToolResult(await this.tools.manageInstance(request)));
    } catch (error) {
      throw new CliCommandError(
        'open_failed',
        error instanceof Error ? error.message : String(error),
        { outcome: 'unknown' },
      );
    }
    if (isFailure(launched) || typeof launched.instance_id !== 'string') {
      throw new CliCommandError('open_failed', typeof launched.error === 'string' ? launched.error : 'Roblox Studio did not connect after launch.', {
        outcome: 'error',
        details: launched,
      });
    }
    const session: CliSession = {
      session_id: randomUUID(),
      instance_id: launched.instance_id,
      ownership: 'managed',
      source,
      place_id: typeof launched.place_id === 'number' ? launched.place_id : undefined,
      place_name: typeof launched.place_name === 'string' ? launched.place_name : undefined,
      opened_at: new Date().toISOString(),
    };
    const connected = this.bridge.getPublicInstances().find((instance) => instance.id === session.instance_id);
    session.multiplayer_group_id = connected?.multiplayerGroupId;
    await this.sessions.set(session);
    return { session: this.sessions.snapshot(), launch: publicLaunch(launched) };
  }

  async close(body: JsonObject): Promise<JsonObject> {
    return this.withSessionLock(() => this.closeUnlocked(body));
  }

  private async closeUnlocked(body: JsonObject): Promise<JsonObject> {
    const session = this.sessions.current();
    const requestedInstanceId = body.instance_id === undefined ? undefined : requiredString(body.instance_id, 'instance_id');
    if (!session) {
      if (requestedInstanceId === undefined) return { closed: false, message: 'No active Studio session.' };
      const closeResult = parseToolResult(await this.tools.manageInstance({ action: 'close', instance_id: requestedInstanceId }));
      if (isFailure(closeResult)) {
        throw new CliCommandError('close_failed', 'The requested Studio instance could not be closed.', {
          outcome: 'unknown',
          details: asObject(closeResult),
        });
      }
      return {
        closed: true,
        instance_id: requestedInstanceId,
        ...(closeResult === undefined ? {} : { close: publicClose(closeResult) }),
      };
    }
    if (body.session_id !== undefined && body.session_id !== session.session_id) {
      throw new CliCommandError('session_mismatch', 'The requested session is not the active session.', {
        details: { active_session_id: session.session_id },
      });
    }
    if (requestedInstanceId !== undefined && requestedInstanceId !== session.instance_id) {
      const closeResult = parseToolResult(await this.tools.manageInstance({ action: 'close', instance_id: requestedInstanceId }));
      if (isFailure(closeResult)) {
        throw new CliCommandError('close_failed', 'The requested Studio instance could not be closed.', {
          outcome: 'unknown',
          details: asObject(closeResult),
        });
      }
      return {
        closed: true,
        instance_id: requestedInstanceId,
        active_instance_id: session.instance_id,
        active_session_preserved: true,
        ...(closeResult === undefined ? {} : { close: publicClose(closeResult) }),
      };
    }
    let closeResult: unknown;
    if (session.ownership === 'managed') {
      closeResult = parseToolResult(await this.tools.manageInstance({ action: 'close', instance_id: session.instance_id }));
      if (isFailure(closeResult)) {
        throw new CliCommandError('close_failed', 'Managed Studio could not be closed.', {
          outcome: 'unknown',
          details: asObject(closeResult),
        });
      }
    }
    await this.sessions.clear();
    return {
      closed: true,
      ownership: session.ownership,
      instance_id: session.instance_id,
      ...(closeResult === undefined ? {} : { close: publicClose(closeResult) }),
    };
  }

  async evaluate(body: JsonObject, context?: ToolInvocationContext): Promise<unknown> {
    const session = this.sessions.require(body);
    const code = requiredString(body.code, 'code');
    const target = body.target === undefined ? 'edit' : requiredString(body.target, 'target');
    if (target !== 'edit' && target !== 'server' && !/^client-[1-9]\d*$/u.test(target)) {
      throw new CliCommandError('invalid_argument', 'target must be edit, server, or client-N.');
    }
    const timeoutMs = numberField(body.timeout_ms, 'timeout_ms', { integer: true, min: 1_000, max: 3_600_000 }) ?? 30_000;
    if (context?.requestId !== undefined) {
      this.evaluationTargets.delete(context.requestId);
      this.evaluationTargets.set(context.requestId, target);
      if (this.evaluationTargets.size > EVALUATION_TARGET_LIMIT) {
        this.evaluationTargets.delete(this.evaluationTargets.keys().next().value as string);
      }
    }
    const startedAt = Date.now();
    const raw = target === 'server'
      ? await this.tools.evalServerRuntime(code, session.instance_id, context?.requestId, timeoutMs)
      : target.startsWith('client-')
        ? await this.tools.evalClientRuntime(code, target, session.instance_id, context?.requestId, timeoutMs)
        : await this.tools.executeLuau(code, 'edit', session.instance_id, context?.requestId, timeoutMs);
    const result = parseToolResult(raw);
    const durationMs = Date.now() - startedAt;
    const failure = evaluationError(result);
    if (failure !== undefined) {
      throw new CliCommandError('evaluation_failed', failure, {
        statusCode: 422,
        outcome: 'error',
        details: { target, duration_ms: durationMs, ...publicEvaluation(result) },
      });
    }
    return {
      target,
      duration_ms: durationMs,
      ...publicEvaluation(result),
    };
  }

  async logs(body: JsonObject, context?: ToolInvocationContext): Promise<unknown> {
    const session = this.sessions.require(body);
    const connected = this.bridge.getPublicInstances().find((instance) => instance.id === session.instance_id);
    const scope = body.scope === undefined ? 'auto' : requiredString(body.scope, 'scope');
    if (scope !== 'auto' && scope !== 'instance' && scope !== 'group') {
      throw new CliCommandError('invalid_argument', 'scope must be auto, instance, or group.');
    }
    if (scope === 'group' && connected?.multiplayerGroupId === undefined) {
      throw new CliCommandError('invalid_argument', 'scope=group requires a multiplayer playtest.');
    }
    if (body.cursor !== undefined && typeof body.cursor !== 'string') {
      throw new CliCommandError('invalid_argument', 'cursor must be a string when provided.');
    }
    let cursorByInstance: Record<string, string> | undefined;
    if (body.cursor_by_instance !== undefined) {
      if (typeof body.cursor_by_instance !== 'object' || body.cursor_by_instance === null || Array.isArray(body.cursor_by_instance)) {
        throw new CliCommandError('invalid_argument', 'cursor_by_instance must be an object mapping instance ids to cursors.');
      }
      cursorByInstance = {};
      for (const [instanceId, cursor] of Object.entries(body.cursor_by_instance as JsonObject)) {
        if (typeof cursor !== 'string') throw new CliCommandError('invalid_argument', `cursor_by_instance.${instanceId} must be a string.`);
        cursorByInstance[instanceId] = cursor;
      }
    }
    if (body.cursor !== undefined && cursorByInstance !== undefined) {
      throw new CliCommandError('invalid_argument', 'use only one of cursor or cursor_by_instance.');
    }
    if (body.filter !== undefined && typeof body.filter !== 'string') {
      throw new CliCommandError('invalid_argument', 'filter must be a string when provided.');
    }
    const groupId = scope === 'instance' ? undefined : connected?.multiplayerGroupId;
    const raw = await this.tools.getRuntimeLogs(
      groupId ? undefined : session.instance_id,
      groupId,
      groupId ? undefined : body.cursor as string | undefined,
      groupId ? cursorByInstance : undefined,
      numberField(body.tail, 'tail', { integer: true, min: 0, max: 10_000 }) ?? 100,
      body.filter as string | undefined,
      context?.signal,
    );
    return publicLogs(parseToolResult(raw), groupId ? 'group' : 'instance');
  }

  async screenshot(body: JsonObject): Promise<unknown> {
    const session = this.sessions.require(body);
    if (body.focus !== undefined) {
      const focused = parseToolResult(await this.tools.focusViewport(requiredString(body.focus, 'focus'), undefined, undefined, undefined, session.instance_id));
      if (isFailure(focused)) {
        throw new CliCommandError('focus_failed', String(asObject(focused).error ?? 'Could not focus the requested instance.'), {
          outcome: 'error',
          details: asObject(focused),
        });
      }
    }
    const target = body.target === undefined ? undefined : requiredString(body.target, 'target');
    if (target !== undefined && target !== 'edit' && !/^client-[1-9]\d*$/u.test(target)) {
      throw new CliCommandError('invalid_argument', 'target must be edit or client-N.');
    }
    const format = body.format === undefined ? undefined : requiredString(body.format, 'format').toLowerCase();
    if (format !== undefined && format !== 'png' && format !== 'jpeg') {
      throw new CliCommandError('invalid_argument', 'format must be png or jpeg.');
    }
    const chosenTarget = target ?? (this.bridge.getPeersInScope(session.instance_id).some(p => p.role === 'client-1' && p.isRunning) ? 'client-1' : 'edit');
    return captureFrame({
      instance_id: session.instance_id, target: chosenTarget, place_name: session.place_name,
      // Only the edit window certainly belongs to the Studio process `roblox open` launched.
      ...(chosenTarget === 'edit' ? { nativePid: () => this.tools.managedStudioPid(session.instance_id) } : {}),
      format: format as 'png' | 'jpeg' | undefined,
      quality: numberField(body.quality, 'quality', { integer: true, min: 1, max: 100 }),
      backend: typeof body.backend === 'string' ? body.backend : undefined, crop: body.crop as string | undefined,
    }, async () => {
      const result = parseToolResult(await this.tools.captureScreenshot(session.instance_id, format, numberField(body.quality, 'quality', { integer: true, min: 1, max: 100 }), chosenTarget));
      if (isFailure(result)) throw new Error(String(asObject(result).error ?? 'Roblox capture failed'));
      return publicScreenshot(result);
    }, async () => {
      // Edit captures have no player viewport. Avoid an unnecessary client probe.
      if (chosenTarget === 'edit') return { kind: 'edit' };
      const measured = await this.evaluate({ target: chosenTarget, code: `local c=workspace.CurrentCamera; local g=game:GetService("GuiService");return {width=c.ViewportSize.X,height=c.ViewportSize.Y,screen_origin={x=g:GetInsetArea(Enum.ScreenInsets.None).Min.X,y=g:GetInsetArea(Enum.ScreenInsets.None).Min.Y},touch=game:GetService("UserInputService").TouchEnabled}` });
      return asObject(measured).result;
    }, async code => asObject(asObject(await this.evaluate({ target: chosenTarget, code })).result));
  }

  async test(body: JsonObject, context?: ToolInvocationContext): Promise<unknown> {
    if (body.action === 'diagnose') {
      const evaluation = asObject(await this.runScenarioStep({ ...body, type: 'diagnose' }, context));
      return { ...evaluation, passed: asObject(evaluation.result).passed === true };
    }
    const action = body.action === undefined ? undefined : requiredString(body.action, 'action');
    if (action === 'status') return this.testStatus(body, context);
    if (action === 'calibrate') return this.testCalibrate(body, context);
    if (action === 'stop') return this.testStop(body);
    if (action === 'run') return this.testRun(body, context);
    if (action === 'play') return this.testPlay(body, context);
    if (action === 'cancel') return this.jobs.cancel(requiredString(body.job_id, 'job_id'));
    if (action === 'resume') return this.jobs.resume(requiredString(body.job_id, 'job_id'), body.foreground === undefined ? undefined : requiredString(body.foreground, 'foreground'));
    if (action === 'result') return this.jobs.result(requiredString(body.job_id, 'job_id'));
    if (action === 'validate') {
      const compiled = compileScenario(body.scenario);
      return { valid: true, steps: compiled.steps, warnings: compiled.warnings, fingerprint: compiled.fingerprint };
    }
    throw new CliCommandError('test_mode_required', `test requires a mode: ${TEST_MODES.join(', ')}.`, {
      details: { modes: [...TEST_MODES] },
    });
  }

  private async testRun(body: JsonObject, context?: ToolInvocationContext): Promise<JsonObject> {
    let evaluation: JsonObject;
    try {
      evaluation = asObject(await this.evaluate(body, context));
    } catch (error) {
      if (!(error instanceof CliCommandError) || error.code !== 'evaluation_failed') throw error;
      const { target, duration_ms: durationMs, ...values } = error.details ?? {};
      return {
        passed: false,
        mode: 'run',
        ...(typeof target === 'string' ? { target } : {}),
        ...(typeof durationMs === 'number' ? { duration_ms: durationMs } : {}),
        ...values,
        failure: { code: error.code, message: error.message },
      };
    }
    const passed = !assertionFailed(evaluation);
    return {
      passed,
      mode: 'run',
      ...evaluation,
      ...(passed ? {} : { failure: { code: 'assertion_failed', message: 'Test assertion failed.' } }),
    };
  }

  private async testPlay(body: JsonObject, context?: ToolInvocationContext): Promise<JsonObject> {
    const session = this.sessions.require(body);
    const mode = body.mode === undefined ? 'play' : requiredString(body.mode, 'mode');
    if (mode !== 'play' && mode !== 'run') throw new CliCommandError('invalid_argument', 'mode must be play or run.');
    const players = numberField(body.players, 'players', { integer: true, min: 1, max: 8 }) ?? 1;
    if (mode === 'run' && players > 1) {
      throw new CliCommandError('invalid_argument', 'mode=run is only available for a solo playtest.');
    }
    const timeout = numberField(body.timeout, 'timeout', { integer: true, min: 1, max: 300 }) ?? 60;
    const keepOpen = body.keep_open === true;
    const scenario = body.scenario === undefined ? undefined : compileScenario(body.scenario);
    const durationMs = numberField(body.duration_ms, 'duration_ms', { integer: true, min: 0, max: 86_400_000 });
    if (!keepOpen && durationMs === undefined && !scenario) {
      throw new CliCommandError('invalid_argument', 'test play requires --duration, --scenario, or --keep-open.');
    }
    if (scenario !== undefined && (!scenario || typeof scenario !== 'object' || Array.isArray(scenario))) {
      throw new CliCommandError('invalid_argument', 'scenario must be a JSON object.');
    }
    if (scenario !== undefined && (scenario as JsonObject).steps !== undefined && !Array.isArray((scenario as JsonObject).steps)) {
      throw new CliCommandError('invalid_argument', 'scenario.steps must be an array when provided.');
    }

    const startedAt = Date.now();
    const multiplayer = players > 1;
    const runtimePeers = this.bridge.getPeersInScope(session.instance_id).filter((peer) => peer.isRunning && peer.role !== 'edit');
    const reusedPlaytest = runtimePeers.length > 0;
    if (reusedPlaytest) {
      const clients = runtimePeers.filter((peer) => /^client(?:-\d+)?$/u.test(peer.role)).length;
      if ((mode === 'play' && clients !== players) || (mode === 'run' && clients > 0)) {
        throw new CliCommandError('active_test_mismatch', 'The active playtest has a different mode or player count. Stop it explicitly before starting another.');
      }
    }
    const readinessAttribute = body.readiness_attribute === undefined ? undefined : requiredString(body.readiness_attribute, 'readiness_attribute');
    if (scenario && context?.job) {
      context.job.phase('preflight');
      const scripts: { name: string; code: string }[] = [];
      const keyNames: string[] = [];
      for (const step of scenario.steps) {
        const client = /^client-(\d+)$/.exec(String(step.target ?? ''));
        if (client && (mode === 'run' || Number(client[1]) > players)) throw new CliCommandError('invalid_scenario', `${String(step.name)} targets a client outside the requested playtest.`);
        if (typeof step.code === 'string') scripts.push({ name: String(step.name), code: this.codeWithArgs(step) });
        if (step.expect) scripts.push({ name: `${String(step.name)}.expect`, code: (step.expect as Condition).code });
        if (step.type === 'keyboard' && typeof step.key_code === 'string') keyNames.push(step.key_code);
      }
      if (scenario.resume_when) scripts.push({ name: 'resume_when', code: scenario.resume_when.code });
      if (scripts.length || keyNames.length) {
        const code = `local spec=game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify({ scripts, keys: keyNames }))})
local failures={}
for _,entry in spec.scripts do local fn,err=loadstring(entry.code);if not fn then table.insert(failures,entry.name..": "..tostring(err)) end end
for _,name in spec.keys do local ok,key=pcall(function() return Enum.KeyCode[name] end);if not ok or not key or key==Enum.KeyCode.Unknown then table.insert(failures,"Unknown keyboard key: "..name) end end
return {passed=#failures==0,failures=failures}`;
        const check = asObject(asObject(await this.evaluate({ target: 'edit', code })).result);
        if (check.passed !== true) throw new CliCommandError('invalid_scenario', 'Native preflight rejected the scenario before input or play control.', { details: check });
      }
    }
    const focus = await acquireFocus(String(body.foreground ?? 'auto'), scenarioNeedsInput(scenario));
    let start: unknown;
    let startAttempted = false;
    const steps: JsonObject[] = [];
    let executionUnknown = false;
    let passed = false;
    let suspicious = false;
    let evidence: JsonObject = { focus: focus.receipt };
    let lastProbe: JsonObject | undefined;
    let lastScreenshot: unknown;
    let statusBeforeTeardown: unknown;
    let stop: unknown;
    let recording: ScenarioRecordingSession | undefined;
    let recorded: JsonObject | undefined;
    let timelineFile: { file: string; entries: number } | undefined;
    const timeline: TimelineEntry[] = [];
    const recordFile = body.record === undefined ? undefined : requiredString(body.record, 'record');
    try {
      context?.job?.phase('starting');
      startAttempted = !reusedPlaytest;
      try {
        start = reusedPlaytest ? { success: true, reused: true } : multiplayer
          ? parseToolResult(await this.tools.multiplayerPlaytest('start', players, undefined, body.test_args, undefined, timeout, session.instance_id))
          : parseToolResult(await this.tools.soloPlaytest('start', mode, timeout, session.instance_id));
      } catch (error) {
        start = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      passed = start !== undefined && !isFailure(start);
      if (passed) context?.job?.ready(this.runtimeIdentity());
      if (passed && readinessAttribute) {
        const readiness = await this.runWaitUntil({
          type: 'wait_until',
          target: mode === 'run' ? 'server' : 'client-1',
          code: `return workspace:GetAttribute(${JSON.stringify(readinessAttribute)}) == true`,
          timeout_ms: timeout * 1000,
          stable_frames: 2,
          instance_id: session.instance_id,
        }, context);
        evidence.readiness = readiness;
        passed = readiness.passed === true;
      }
      // The video starts after readiness and before the first step, so it
      // covers the moment gameplay began through the end of the scenario.
      if (recordFile !== undefined) {
        if (!passed) {
          evidence.recording = { requested: true, started: false, reason: 'playtest did not reach a ready state' };
          passed = false;
        }
        else {
          context?.job?.phase('recording');
          try {
            recording = await startScenarioRecording(
              { file: recordFile },
              async code => asObject(asObject(await this.evaluate({ target: 'client-1', code, instance_id: session.instance_id }, context)).result),
              { ...(session.place_name === undefined ? {} : { placeName: session.place_name }) },
            );
            evidence.recording = {
              requested: true, started: true, file: recordFile,
              started_at: recording.clock.started_at,
              viewport: recording.viewport,
              calibration: recording.calibration,
            };
          }
          catch (error) {
            // A recording that never started must fail the command: a caller
            // asking for a video has not received one just because the
            // scenario steps succeeded.
            evidence.recording = {
              requested: true, started: false,
              failure: error instanceof Error ? error.message : String(error),
            };
            passed = false;
            throw error;
          }
        }
      }
      if (passed && scenario) {
        const rawScenarioSteps = (scenario as JsonObject).steps;
        const scenarioSteps: unknown[] = rawScenarioSteps as unknown[];
        for (let index = context?.job?.startIndex ?? 0; index < scenarioSteps.length; index++) {
          if (context?.job?.cancelled()) { passed = false; break; }
          const step = scenarioSteps[index];
          const stepStartedAt = Date.now();
          try {
            context?.job?.stepStarted(index, step as JsonObject);
            const stepContext = context?.requestId
              ? { ...context, requestId: childRequestId(context.requestId, index) }
              : context;
            let result: unknown;
            try { result = await this.runScenarioStep(step, stepContext); }
            catch (error) {
              if ((step as JsonObject).type !== 'screenshot') throw error;
              result = { capture_passed: false, capture_error: error instanceof Error ? error.message : String(error), ...(error instanceof CliCommandError ? { details: error.details } : {}) };
            }
            const stepType = step && typeof step === 'object' && !Array.isArray(step)
              ? (step as JsonObject).type
              : undefined;
            if (stepType === 'wait_until' || stepType === 'eval') {
              lastProbe = { type: stepType, result };
            } else if (stepType === 'screenshot') {
              lastScreenshot = result;
            }
            let stepPassed = !isFailure(result) && !assertionFailed(asObject(result));
            let expectation: unknown;
            const expected = (step as JsonObject).expect;
            if (stepPassed && expected) {
              expectation = await this.runWaitUntil({ ...expected as Condition }, { ...stepContext!, requestId: childRequestId(context?.requestId ?? randomUUID(), index) + ':expect' });
              stepPassed = asObject(expectation).passed === true;
            }
            const stepEndedAt = Date.now();
            // Wall-clock offsets are recorded whether or not a video was asked
            // for: a reviewer seeking into a video and a reviewer reading a
            // receipt should be able to agree on when a step happened.
            const offsets = recording === undefined ? {} : {
              started_at_ms: recording.clock.offset(stepStartedAt),
              ended_at_ms: recording.clock.offset(stepEndedAt),
            };
            const receipt = {
              index, name: (step as JsonObject).name, passed: stepPassed, result,
              ...(typeof stepType === 'string' ? { type: stepType } : {}),
              ...(offsets),
              ...(expectation === undefined ? {} : { expectation }),
            };
            steps.push(receipt);
            if (recording) {
              timeline.push({
                index, name: String((step as JsonObject).name), passed: stepPassed,
                started_at_ms: recording.clock.offset(stepStartedAt),
                ended_at_ms: recording.clock.offset(stepEndedAt),
                ...(typeof stepType === 'string' ? { type: stepType } : {}),
                ...(typeof (step as JsonObject).target === 'string' ? { target: String((step as JsonObject).target) } : {}),
              });
            }
            context?.job?.stepFinished(index, receipt);
            if (!stepPassed) {
              passed = false;
              break;
            }
          } catch (error) {
            passed = false;
            executionUnknown = !(error instanceof CliCommandError) || error.outcome === 'unknown';
            const offsets = recording === undefined ? {} : {
              started_at_ms: recording.clock.offset(stepStartedAt),
              ended_at_ms: recording.clock.offset(Date.now()),
            };
            const receipt = { index, name: (step as JsonObject).name, passed: false, error: error instanceof Error ? error.message : String(error), execution: executionUnknown ? 'unknown' : 'failed', ...offsets };
            steps.push(receipt);
            if (recording) {
              timeline.push({
                index, name: String((step as JsonObject).name), passed: false,
                started_at_ms: offsets.started_at_ms!, ended_at_ms: offsets.ended_at_ms!,
              });
            }
            context?.job?.stepFinished(index, receipt);
            break;
          }
        }
      }
      if (passed && durationMs !== undefined) await this.runScenarioStep({ type: 'wait', duration_ms: durationMs }, context);
      if (context?.job?.cancelled()) passed = false;

      // Read health before teardown. A test can have completed its assertions
      // while the renderer or CaptureService is already unhealthy; that is a
      // suspicious result, not trustworthy evidence of a good playtest.
      try {
        statusBeforeTeardown = await this.testStatus({
          instance_id: session.instance_id,
          ...(body.readiness_attribute === undefined ? {} : { readiness_attribute: body.readiness_attribute }),
        }, context);
        if (isSuspiciousRuntimeHealth(statusBeforeTeardown)) {
          suspicious = true;
          passed = false;
        }
        if (!passed || suspicious) evidence.status = statusBeforeTeardown;
      } catch (error) {
        suspicious = true;
        passed = false;
        evidence.status_error = error instanceof Error ? error.message : String(error);
      }

      try {
        const logResult = parseToolResult(await this.logs({ instance_id: session.instance_id, scope: 'auto', tail: 100 }, context));
        evidence.logs = asObject(logResult);
      } catch (error) {
        suspicious = true;
        passed = false;
        evidence.logs_error = error instanceof Error ? error.message : String(error);
      }

      if (!passed || suspicious) {
        if (evidence.status === undefined && statusBeforeTeardown !== undefined) {
          evidence.status = statusBeforeTeardown;
        }
        if (lastProbe !== undefined) {
          evidence.probe = lastProbe;
        } else if (statusBeforeTeardown !== undefined) {
          evidence.probe = {
            type: 'runtime_health',
            result: asObject(statusBeforeTeardown).runtime_health ?? null,
          };
        }

        if (lastScreenshot !== undefined && !isFailure(lastScreenshot)) {
          evidence.screenshot = lastScreenshot;
        } else {
          try {
            // Capture the final frame while the runtime peer still exists.
            // screenshot() applies its own solid-magenta validation and retry.
            evidence.screenshot = await this.screenshot({ instance_id: session.instance_id });
          } catch (error) {
            evidence.screenshot_error = error instanceof Error ? error.message : String(error);
          }
        }
      }
    } finally {
      // Every teardown await is bounded. Teardown runs in a `finally`, so one
      // await that never settles here would leave the job in `cleanup` forever
      // and keep the session owned - a wedged CI run. Expiry is recorded as
      // evidence, never as silent success.
      const expired: JsonObject[] = [];
      const onTimeout = (label: string, ms: number) => { expired.push({ step: label, deadline_ms: ms }); };
      const bounded = <T>(label: string, ms: number, work: Promise<T>) => withDeadline(label, ms, work, onTimeout);
      try {
      context?.job?.phase('cleanup');
      // Stop the recorder before tearing the playtest down. Teardown runs in a `finally`, so one
      // await that never settles here would leave the job in `cleanup` forever
      // and keep the session owned - a wedged CI run. Expiry is recorded as
      // evidence, never as silent success.
      // Stop the recorder before tearing the playtest down: the last thing the
      // video should show is the end of the scenario, not an empty edit view
      // after the client closed.
      if (recording !== undefined) {
        try {
          // Finalizing writes and fsyncs a whole MP4, so it gets the longest
          // deadline but still a deadline.
          const finished = await bounded('recording_finalize', 90_000, recording.finish(context?.job?.cancelled() ? 'cancelled' : 'scenario_completed'));
          if (finished === undefined) {
            evidence.recording = { ...asObject(evidence.recording), recorded: false, finalize_failure: 'the recorder did not finalize within 90s' };
          }
          else {
            recorded = asObject(finished);
            evidence.recording = { ...asObject(evidence.recording), recorded: true, receipt: recorded };
            // Persist the video's own evidence now, before any later teardown
            // step can fail: a caller must never lose a finalized recording
            // because stopping the playtest went wrong afterwards.
            if (recordFile !== undefined) {
              const written = writeTimeline({
                file: recordFile, clock: recording.clock, recorded, calibration: recording.calibration, steps: timeline,
                outcome: { passed, execution: passed ? 'success' : 'failed', steps_passed: timeline.filter(entry => entry.passed).length, steps_total: timeline.length },
              });
              timelineFile = written;
            }
          }
        }
        catch (error) {
          // A video that cannot be finalized is not evidence. Fail the command
          // rather than reporting a scenario that quietly produced no file.
          passed = false;
          evidence.recording = {
            ...asObject(evidence.recording), recorded: false,
            finalize_failure: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (scenario) {
        evidence.input_cleanup = await bounded('input_release', 45_000, this.releaseScenarioInput(scenario));
        if (asObject(evidence.input_cleanup).released !== true) { passed = false; executionUnknown = true; }
      }
      // Stop even after a partially successful start. Studio can have runtime
      // peers connected while the start helper reports a timeout or transport
      // error, and leaving those peers alive would violate the CLI's one-test
      // session semantics.
      if (!keepOpen && startAttempted && !context?.job?.cancelled() && !executionUnknown) {
        try {
          const ended = await bounded('playtest_stop', (timeout + 30) * 1000, multiplayer
            ? this.tools.multiplayerPlaytest('end', players, undefined, undefined, 'roblox-cli-test-finished', timeout, session.instance_id)
            : this.tools.soloPlaytest('stop', undefined, timeout, session.instance_id));
          stop = ended === undefined
            ? { error: `Stopping the playtest exceeded ${timeout + 30}s; the runtime may still be alive.` }
            : parseToolResult(ended);
          if (isFailure(stop)) {
            passed = false;
            if (evidence.status === undefined && statusBeforeTeardown !== undefined) evidence.status = statusBeforeTeardown;
            if (evidence.probe === undefined) {
              evidence.probe = lastProbe ?? {
                type: 'runtime_health',
                result: asObject(statusBeforeTeardown).runtime_health ?? null,
              };
            }
            if (evidence.screenshot === undefined) {
              try {
                // A failed stop can leave the runtime peers alive. Preserve a
                // final frame before returning the teardown failure.
                evidence.screenshot = await this.screenshot({ instance_id: session.instance_id });
              } catch (error) {
                evidence.screenshot_error = error instanceof Error ? error.message : String(error);
              }
            }
          }
        } catch (error) {
          passed = false;
          stop = { error: error instanceof Error ? error.message : String(error) };
          if (evidence.status === undefined && statusBeforeTeardown !== undefined) evidence.status = statusBeforeTeardown;
          if (evidence.probe === undefined) {
            evidence.probe = lastProbe ?? {
              type: 'runtime_health',
              result: asObject(statusBeforeTeardown).runtime_health ?? null,
            };
          }
          if (evidence.screenshot === undefined) {
            try {
              evidence.screenshot = await this.screenshot({ instance_id: session.instance_id });
            } catch (captureError) {
              evidence.screenshot_error = captureError instanceof Error ? captureError.message : String(captureError);
            }
          }
        }
      }
      } finally {
        evidence.focus_release = await bounded('focus_release', 10_000, focus.release());
        if (expired.length) evidence.cleanup_deadlines = expired;
      }
    }


    return {
      passed,
      mode: 'play',
      execution: executionUnknown ? 'unknown' : passed ? 'success' : 'failed',
      ...(context?.job?.cancelled() ? { cancelled: true } : {}),
      ...(scenario?.warnings.length ? { warnings: scenario.warnings } : {}),
      play_mode: mode,
      players,
      kept_open: keepOpen || reusedPlaytest,
      reused_playtest: reusedPlaytest,
      validation: scenario?.steps.length ? 'scenario' : readinessAttribute ? 'readiness' : 'startup_only',
      duration_ms: Date.now() - startedAt,
      start: publicLifecycle(start),
      steps,
      evidence,
      // The recording receipt is a top-level field, not a buried detail: a
      // reviewer should not have to know where the daemon stashed it.
      ...(recorded === undefined ? {} : {
        recording: recorded,
        ...(timelineFile === undefined ? {} : { timeline: { file: timelineFile.file, steps: timelineFile.entries } }),
      }),
      capture_requested: scenario?.steps.some(step => step.type === 'screenshot') === true || evidence.screenshot !== undefined || evidence.screenshot_error !== undefined,
      capture_passed: steps.every(step => asObject(step.result).capture_passed !== false) && evidence.screenshot_error === undefined,
      ...(suspicious ? { suspicious: true } : {}),
      ...(stop === undefined ? {} : { stop: publicLifecycle(stop) }),
      ...(passed ? {} : { failure: { code: 'playtest_failed', message: 'Playtest QA failed.' } }),
    };
  }

  private async runScenarioStep(step: unknown, context?: ToolInvocationContext): Promise<unknown> {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new CliCommandError('invalid_scenario', 'Each scenario step must be an object.');
    }
    const item = step as JsonObject;
    const type = requiredString(item.type, 'scenario step type');
    if (type === 'wait') {
      const ms = numberField(item.duration_ms ?? item.duration, 'duration_ms', { integer: true, min: 0, max: 86_400_000 }) ?? 0;
      const began = Date.now();
      const deadline = began + ms;
      while (Date.now() < deadline && !context?.job?.cancelled()) await waitFor(Math.min(100, deadline - Date.now()), context?.signal);
      return { waited_ms: Date.now() - began, requested_ms: ms, ...(context?.job?.cancelled() ? { passed: false, cancelled: true } : {}) };
    }
    if (type === 'wait_until') return this.runWaitUntil(item, context);
    if (type === 'eval') return this.evaluate({ ...item, code: this.codeWithArgs(item) }, context);
    const session = this.sessions.require(item);
    if (type === 'logs') return parseToolResult(await this.logs(item, context));
    if (type === 'screenshot') return parseToolResult(await this.screenshot(item));
    if (['click_gui', 'click_world', 'interact_prompt'].includes(type)) {
      return this.evaluate({ target: item.target ?? 'client-1', code: targetingProbe(item) }, context);
    }
    if (type === 'diagnose') {
      validateDiagnostics(item);
      const evaluation = asObject(await this.evaluate({ target: item.target ?? 'client-1', code: diagnosticProbe(item) }, context));
      return { ...evaluation, passed: asObject(evaluation.result).passed === true };
    }
    if (type === 'keyboard') {
      const action = typeof item.action === 'string' ? item.action : 'tap';
      if (item.duration !== undefined && action !== 'tap') {
        throw new CliCommandError('invalid_scenario', 'keyboard duration requires action=tap. press holds a key until an explicit release.');
      }
      return publicLifecycle(parseToolResult(await this.tools.simulateKeyboardInput(
        typeof item.key_code === 'string' ? item.key_code : undefined,
        action,
        numberField(item.duration_ms === undefined ? item.duration : Number(item.duration_ms) / 1000, 'duration', { min: 0, max: 60 }),
        typeof item.text === 'string' ? item.text : undefined,
        typeof item.target === 'string' ? item.target : undefined,
        session.instance_id,
      )));
    }
    if (type === 'mouse') {
      return publicLifecycle(parseToolResult(await this.tools.simulateMouseInput(
        requiredString(item.action, 'action'),
        numberField(item.x, 'x') ?? 0,
        numberField(item.y, 'y') ?? 0,
        typeof item.button === 'string' ? item.button : undefined,
        typeof item.scroll_direction === 'string' ? item.scroll_direction : undefined,
        typeof item.target === 'string' ? item.target : undefined,
        session.instance_id,
      )));
    }
    throw new CliCommandError('invalid_scenario', `Unsupported scenario step type "${type}".`);
  }

  private async runWaitUntil(item: JsonObject, context?: ToolInvocationContext): Promise<JsonObject> {
    const code = this.codeWithArgs(item);
    // timeout_ms bounds the whole wait; each poll keeps the default eval deadline.
    const { timeout_ms: _waitTimeout, ...probe } = item;
    const target = item.target === undefined ? 'edit' : requiredString(item.target, 'target');
    const timeoutMs = numberField(item.timeout_ms, 'timeout_ms', { integer: true, min: 1, max: 300_000 }) ?? 30_000;
    const requiredStableFrames = numberField(item.stable_samples ?? item.stable_frames, 'stable_samples', { integer: true, min: 1, max: 600 }) ?? 1;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let attempts = 0;
    let stableFrames = 0;
    let lastEvaluation: JsonObject | undefined;
    let lastError: string | undefined;

    while (Date.now() <= deadline && !context?.job?.cancelled()) {
      attempts += 1;
      try {
        const evaluationContext = context?.requestId
          ? { ...context, requestId: childRequestId(`${context.requestId}:poll`, attempts) }
          : context;
        const evaluation = asObject(await this.evaluate({ ...probe, code, target }, evaluationContext));
        lastEvaluation = evaluation;
        lastError = undefined;
        const value = Array.isArray(evaluation.results) ? evaluation.results[0] : evaluation.result;
        const condition = value !== undefined && value !== null && !assertionFailed(evaluation);
        if (!condition) {
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }

        if (stableFrames >= requiredStableFrames) {
          return {
            passed: true,
            condition: true,
            target,
            stable_samples: stableFrames,
            stable_frames: stableFrames,
            required_stable_frames: requiredStableFrames,
            attempts,
            elapsed_ms: Date.now() - startedAt,
            evaluation: lastEvaluation,
          };
        }
      } catch (error) {
        if (context?.signal.aborted) throw error;
        if (!(error instanceof CliCommandError) || error.code !== 'evaluation_failed') throw error;
        stableFrames = 0;
        lastError = error.message;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await waitFor(Math.min(Number(item.interval_ms ?? WAIT_UNTIL_POLL_MS), remainingMs), context?.signal);
    }

    return {
      passed: false,
      condition: false,
      timed_out: true,
      target,
      stable_samples: stableFrames,
      stable_frames: stableFrames,
      required_stable_frames: requiredStableFrames,
      attempts,
      elapsed_ms: Date.now() - startedAt,
      ...(lastEvaluation === undefined ? {} : { evaluation: lastEvaluation }),
      ...(lastError === undefined ? {} : { last_error: lastError }),
    };
  }

  private codeWithArgs(item: JsonObject): string {
    const code = requiredString(item.code, 'code');
    return item.args === undefined ? code : `local args = game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(item.args))})\n${code}`;
  }

  private async releaseScenarioInput(scenario: Scenario): Promise<unknown> {
    const session = this.sessions.require({});
    const keys = new Map<string, JsonObject>();
    for (const step of scenario.steps) {
      if (step.type === 'keyboard' && step.key_code && step.action === 'press') keys.set(`${step.target}:${step.key_code}`, step);
      if (step.type === 'mouse' && step.action === 'mouseDown') keys.set(`${step.target}:mouse:${step.button}`, step);
    }
    const results = [];
    for (const step of keys.values()) {
      try {
        const raw = step.type === 'keyboard'
          ? await this.tools.simulateKeyboardInput(String(step.key_code), 'release', undefined, undefined, step.target as string | undefined, session.instance_id)
          : await this.tools.simulateMouseInput('mouseUp', Number(step.x), Number(step.y), step.button as string | undefined, undefined, step.target as string | undefined, session.instance_id);
        results.push({ input: step.key_code ?? step.button ?? 'Left', released: !isFailure(parseToolResult(raw)) });
      } catch (error) { results.push({ input: step.key_code ?? step.button, released: false, error: String(error) }); }
    }
    return { released: results.every(r => r.released), inputs: results };
  }

  /**
   * Derive the play viewport crop without capturing a still. The recording
   * path uses this so a reviewer can see the calibration receipt that produced
   * a video's dimensions, and so a crop can be re-measured after a resize.
   */
  private async testCalibrate(body: JsonObject, context?: ToolInvocationContext): Promise<JsonObject> {
    const session = this.sessions.require(body);
    const running = this.bridge.getPeersInScope(session.instance_id).some(peer => peer.isRunning && /^client-1$/u.test(peer.role));
    if (!running)
      throw new CliCommandError('calibration_unavailable', 'Viewport calibration requires the visible play client. Start a playtest first.');
    const identity = { ...(session.place_name === undefined ? {} : { placeName: session.place_name }) };
    const measured = await calibratedViewportRect(
      identity,
      async code => asObject(asObject(await this.evaluate({ target: 'client-1', code, instance_id: session.instance_id }, context)).result),
    );
    return {
      verified: true,
      method: 'four_native_gui_markers',
      crop_in_capture: measured.crop,
      capture_width: measured.capture_width,
      capture_height: measured.capture_height,
      viewport: measured.viewport,
      window: measured.window,
      note: 'A crop is valid only while the window size and the camera viewport are unchanged.',
    };
  }

  private async testStatus(body: JsonObject, context?: ToolInvocationContext): Promise<unknown> {
    const session = this.sessions.require(body);
    const connected = this.bridge.getPublicInstances().find((instance) => instance.id === session.instance_id);
    const multiplayer = connected?.multiplayerGroupId !== undefined;
    const result = multiplayer
      ? parseToolResult(await this.tools.multiplayerPlaytest('status', undefined, undefined, undefined, undefined, undefined, session.instance_id))
      : parseToolResult(await this.tools.soloPlaytest('status', undefined, undefined, session.instance_id));
    const { soloOutcome, soloOutcomeError, ...lifecycle } = publicLifecycle(result);
    const { startedAt, completedAt, ...outcome } = asObject(soloOutcome);
    const status: JsonObject = {
      mode: multiplayer ? 'multiplayer' : 'solo',
      ...lifecycle,
      ...(soloOutcome === undefined ? {} : {
        solo_outcome: {
          ...outcome,
          ...(startedAt === undefined ? {} : { started_at: startedAt }),
          ...(completedAt === undefined ? {} : { completed_at: completedAt }),
        },
      }),
      ...(typeof soloOutcomeError === 'string' ? { solo_outcome_error: soloOutcomeError } : {}),
    };
    try {
      const health = await this.tools.getRuntimeHealth(
        session.instance_id,
        undefined,
        false,
        typeof body.readiness_attribute === 'string' ? body.readiness_attribute : undefined,
        context?.signal,
      );
      const peers = asObject(health).peers;
      if (peers && typeof peers === 'object' && !Array.isArray(peers) && Object.keys(peers).length > 0) {
        status.runtime_health = peers;
      }
    } catch (error) {
      // Status remains useful when a runtime peer is in the middle of joining
      // or leaving. The error is retained for diagnosis instead of turning a
      // read-only inspection into a command failure.
      status.runtime_health_error = error instanceof Error ? error.message : String(error);
    }
    // Recording state is process-independent, so it is reported even when the
    // playtest itself has no useful runtime health.
    status.recording = recordingStatus();
    return status;
  }

  private async testStop(body: JsonObject): Promise<unknown> {
    const session = this.sessions.require(body);
    if (this.jobs.hasActive(session.instance_id)) throw new CliCommandError('job_active', 'Cancel the active job and let input cleanup finish before stopping Studio.');
    const connected = this.bridge.getPublicInstances().find((instance) => instance.id === session.instance_id);
    const multiplayer = connected?.multiplayerGroupId !== undefined ||
      this.bridge.getPeersInScope(session.instance_id).some((peer) => peer.role === 'server' || /^client-\d+$/u.test(peer.role));
    const result = multiplayer
      ? parseToolResult(await this.tools.multiplayerPlaytest('end', undefined, undefined, undefined, 'roblox-cli-stop', undefined, session.instance_id))
      : parseToolResult(await this.tools.soloPlaytest('stop', undefined, undefined, session.instance_id));
    const failed = isFailure(result);
    const details = publicLifecycle(result);
    return {
      stopped: !failed,
      mode: multiplayer ? 'multiplayer' : 'solo',
      ...(failed ? {
        failure: {
          code: 'stop_failed',
          message: typeof details.error === 'string' ? details.error : 'Playtest did not stop.',
        },
        ...(Object.keys(details).length > 0 ? { details } : {}),
      } : {}),
    };
  }
}

/**
 * An eval assertion fails when its first returned value is `false` or a table
 * reporting passed/ok/success = false. Lua's `return false, "why"` idiom
 * therefore fails with the reason kept in `results`.
 */
function assertionFailed(evaluation: JsonObject): boolean {
  const value = Array.isArray(evaluation.results) ? evaluation.results[0] : evaluation.result;
  if (value === false) return true;
  const body = asObject(value);
  return body.passed === false || body.ok === false || body.success === false;
}

export function createCliCommandHandlers(
  tools: RobloxStudioTools,
  bridge: BridgeService,
): { handlers: Record<string, CliCommandHandler>; service: CliCommandService } {
  const service = new CliCommandService(tools, bridge);
  return {
    service,
    handlers: {
      open: (_tools, body) => service.open(body),
      eval: (_tools, body, context) => service.evaluate(body, context),
      logs: (_tools, body, context) => service.logs(body, context),
      screenshot: (_tools, body) => service.screenshot(body),
      test: (_tools, body, context) => service.test(body, context),
    },
  };
}
