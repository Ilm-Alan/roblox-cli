jest.mock('../focus-session.js', () => ({ acquireFocus: jest.fn(async () => ({ receipt: { activated: false }, release: async () => ({ restored: false }) })) }));
jest.mock('../viewport-capture.js', () => ({ calibratedViewportRect: jest.fn(), calibratedViewportCapture: jest.fn() }));
jest.mock('../capture-worker.js', () => ({ ensureCaptureWorker: jest.fn(), recordWithWorker: jest.fn(), captureWithWorker: jest.fn(), activeWorkerSocket: jest.fn(() => true) }));
jest.mock('../native-screen-capture.js', () => ({
  captureNativeStudioWindow: jest.fn(async () => { throw new Error('Native capture unavailable in unit tests'); }),
  resolveStudioWindow: jest.fn(async () => ({ id: 4242, pid: 99, title: 'place - Roblox Studio', bounds: { X: 0, Y: 0, Width: 1512, Height: 930 } })),
}));
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as viewport from '../viewport-capture.js';
import * as recording from '../native-recording.js';
import * as worker from '../capture-worker.js';
import { acquireFocus } from '../focus-session.js';
import { tmpdir } from 'node:os';
import { BridgeService, RequestFailure } from '../bridge-service.js';
import { CliCommandService } from '../cli-command-service.js';
import { publicRequestStatus, publicToolErrorBody } from '../command-results.js';
import { CLI_COMMANDS } from '../commands.js';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';

function parseResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object command result');
  return value as Record<string, unknown>;
}

function registerEdit(bridge: BridgeService, instanceId = 'instance:test'): string {
  const peerId = `${instanceId}/edit`;
  const result = bridge.registerPeer({
    peerId,
    transportPeerId: peerId,
    instanceId,
    role: 'edit',
    placeId: 123,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: false,
    pluginVersion: 'test',
    pluginVariant: 'main',
  });
  if (!result.ok) throw new Error(result.error.message);
  return peerId;
}

function registerPeer(bridge: BridgeService, role: string, instanceId = 'instance:test'): string {
  const peerId = `${instanceId}/${role}`;
  const result = bridge.registerPeer({
    peerId,
    transportPeerId: peerId,
    instanceId,
    role,
    placeId: 123,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: role !== 'edit',
    pluginVersion: 'test',
    pluginVariant: 'main',
  });
  if (!result.ok) throw new Error(result.error.message);
  return peerId;
}

async function waitForRequest(
  bridge: BridgeService,
  transportPeerId: string,
): Promise<NonNullable<ReturnType<BridgeService['claimNextRequestForTransport']>>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const request = bridge.claimNextRequestForTransport(transportPeerId, transportPeerId);
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for request on ${transportPeerId}`);
}

async function attachedService() {
  const bridge = new BridgeService();
  const peerId = registerEdit(bridge);
  const tools = new RobloxStudioTools(bridge);
  const service = new CliCommandService(tools, bridge);
  await service.open({ source: 'attach' });
  return { bridge, peerId, tools, service };
}

/** Answer the next request queued for a Peer, then settle the work that queued it. */
async function answered<T>(work: Promise<T>, bridge: BridgeService, peerId: string, response: unknown): Promise<T> {
  const request = await waitForRequest(bridge, peerId);
  bridge.resolveRequest(request.requestId, response);
  return work;
}

describe('roblox-cli command contract', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(`${tmpdir()}/roblox-cli-test-`);
    process.env.ROBLOX_CLI_HOME = testHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
  });

  test('keeps exactly the five public workflow names', () => {
    expect([...CLI_COMMANDS]).toEqual(['open', 'eval', 'logs', 'screenshot', 'test']);
  });

  test('attaches one Studio session and rejects a second target', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);

    const opened = parseResult(await service.open({ source: 'attach' }));
    const session = opened.session as Record<string, unknown>;
    expect(session).toMatchObject({ instance_id: 'instance:test', ownership: 'attached', connected: true });

    await expect(service.open({ source: 'baseplate' })).rejects.toMatchObject({
      code: 'single_session',
    });
  });

  test('passes eval to the requested peer and returns only useful result data', async () => {
    const bridge = new BridgeService();
    const peerId = registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const evaluation = service.evaluate({ code: 'return 7', target: 'edit' }, {
      signal: new AbortController().signal,
      requestId: 'cli-test-request',
    });
    const request = bridge.claimNextRequestForTransport(peerId, peerId);
    expect(request?.endpoint).toBe('/api/execute-luau');
    if (!request) throw new Error('expected an eval request');
    expect(request.requestId).toBe('cli-test-request');
    expect(bridge.resolveRequest(request.requestId, { success: true, values: [7], valueTypes: ['number'], output: [] })).toBe('accepted');

    await expect(evaluation).resolves.toMatchObject({
      target: 'edit',
      result: 7,
      result_type: 'number',
    });
    await expect(evaluation).resolves.not.toHaveProperty('outcome');
    await expect(evaluation).resolves.not.toHaveProperty('result.success');
    await expect(evaluation).resolves.not.toHaveProperty('values');
  });

  test('requires an active session before eval', async () => {
    const bridge = new BridgeService();
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await expect(service.evaluate({ code: 'return true' })).rejects.toMatchObject({
      code: 'session_required',
    });
  });

  test('a session whose Studio disconnected fails before dispatch and names the recovery', async () => {
    const { bridge, peerId, service } = await attachedService();
    bridge.unregisterPeer(peerId);
    const failure = await service.evaluate({ code: 'return 1' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'session_disconnected', outcome: 'not_executed' });
    expect(publicToolErrorBody('eval', failure)).toMatchObject({
      error: { code: 'session_disconnected', execution: 'not_started', retry: 'after_fix', next: 'roblox open' },
    });
    expect(bridge.getPendingRequestCount()).toBe(0);
  });

  test('open re-attaches a disconnected session to exactly one edit Peer', async () => {
    const { bridge, peerId, service } = await attachedService();
    const previous = service.sessionSnapshot()?.session_id;
    bridge.unregisterPeer(peerId);
    registerEdit(bridge, 'instance:restarted');
    await expect(service.open({ source: 'attach' })).resolves.toMatchObject({
      reattached: true,
      session: { instance_id: 'instance:restarted', connected: true },
      previous_session: { session_id: previous, instance_id: 'instance:test' },
    });
    expect(service.sessionSnapshot()).toMatchObject({ instance_id: 'instance:restarted', connected: true });
  });

  test('open refuses to guess when a disconnected session has zero or several edit Peers', async () => {
    const { bridge, peerId, service } = await attachedService();
    bridge.unregisterPeer(peerId);
    await expect(service.open({})).rejects.toMatchObject({ code: 'studio_not_connected', outcome: 'not_executed' });
    registerEdit(bridge, 'instance:a');
    registerEdit(bridge, 'instance:b');
    const several = await service.open({}).catch((error: unknown) => error) as { code: string; details: { instance_ids: string[]; next: string } };
    expect(several.code).toBe('multiple_sessions');
    expect([...several.details.instance_ids].sort()).toEqual(['instance:a', 'instance:b']);
    expect(several.details.next).toBe('roblox open --instance-id ID');
    await expect(service.open({ instance_id: 'instance:b' })).resolves.toMatchObject({
      reattached: true, session: { instance_id: 'instance:b', connected: true },
    });
  });

  test('eval reports no, one, or every returned value with typed markers intact', async () => {
    const { bridge, peerId, service } = await attachedService();
    const none = parseResult(await answered(service.evaluate({ code: 'print("hi")' }), bridge, peerId, {
      success: true, values: [], valueTypes: [], output: ['hi'],
    }));
    expect(none).toMatchObject({ target: 'edit', output: ['hi'] });
    expect(none).not.toHaveProperty('result');
    expect(none).not.toHaveProperty('results');

    const part = { $type: 'Instance', class: 'Part', name: 'Door', path: 'Workspace.House.Door' };
    const one = parseResult(await answered(service.evaluate({ code: 'return workspace.House.Door' }), bridge, peerId, {
      success: true, values: [part], valueTypes: ['Instance'], output: [], undo: 'recorded',
    }));
    expect(one).toMatchObject({ result: part, result_type: 'Instance', undo: 'recorded' });
    expect(one).not.toHaveProperty('results');

    const many = parseResult(await answered(service.evaluate({ code: 'return 1, nil, "x"' }), bridge, peerId, {
      success: true, values: [1, { $type: 'nil' }, 'x'], valueTypes: ['number', 'nil', 'string'], output: [],
    }));
    expect(many).toMatchObject({ results: [1, null, 'x'], result_types: ['number', 'nil', 'string'] });
    expect(many).not.toHaveProperty('result');
  });

  test('test run fails on a false first value and passes on a truthy one', async () => {
    const { bridge, peerId, service } = await attachedService();
    const failed = parseResult(await answered(service.test({ action: 'run', code: 'return false, "door closed"' }), bridge, peerId, {
      success: true, values: [false, 'door closed'], valueTypes: ['boolean', 'string'], output: [],
    }));
    expect(failed).toMatchObject({ passed: false, results: [false, 'door closed'], failure: { code: 'assertion_failed' } });
    const passed = parseResult(await answered(service.test({ action: 'run', code: 'return true' }), bridge, peerId, {
      success: true, values: [true], valueTypes: ['boolean'], output: [],
    }));
    expect(passed).toMatchObject({ passed: true, result: true });
    expect(passed).not.toHaveProperty('failure');
  });

  test('eval timeout_ms becomes the bridge deadline and is validated before dispatch', async () => {
    const { bridge, peerId, service } = await attachedService();
    const send = jest.spyOn(bridge, 'sendRequest');
    const empty = { success: true, values: [], valueTypes: [], output: [] };
    try {
      await answered(service.evaluate({ code: 'task.wait(60)', timeout_ms: 120_000 }), bridge, peerId, empty);
      await answered(service.test({ action: 'run', code: 'task.wait(40)', timeout_ms: 45_000 }), bridge, peerId, empty);
      await answered(service.evaluate({ code: 'return' }), bridge, peerId, empty);
      expect(send.mock.calls.map((call) => call[3])).toEqual([120_000, 45_000, 30_000]);
      await expect(service.evaluate({ code: 'return', timeout_ms: 999 })).rejects.toMatchObject({ code: 'invalid_argument' });
      await expect(service.evaluate({ code: 'return', timeout_ms: 3_600_001 })).rejects.toMatchObject({ code: 'invalid_argument' });
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      send.mockRestore();
    }
  });

  test('request status for an eval returns the payload the live eval returned', async () => {
    const { bridge, peerId, service } = await attachedService();
    const live = parseResult(await answered(
      service.evaluate({ code: 'return 1, "two"' }, { signal: new AbortController().signal, requestId: 'eval-recover' }),
      bridge, peerId, { success: true, values: [1, 'two'], valueTypes: ['number', 'string'], output: ['printed'] },
    ));
    const status = service.requestStatus('eval-recover');
    expect(status).toMatchObject({ state: 'settled', execution: 'success' });
    expect({ ...parseResult(status?.result), duration_ms: 0 }).toEqual({ ...live, duration_ms: 0 });

    await expect(answered(
      service.evaluate({ code: 'print("before") error("boom")' }, { signal: new AbortController().signal, requestId: 'eval-failed' }),
      bridge, peerId, { success: false, error: 'boom', output: ['before'], message: 'Code execution failed' },
    )).rejects.toMatchObject({ code: 'evaluation_failed' });
    expect(service.requestStatus('eval-failed')).toMatchObject({
      execution: 'failed',
      error: { code: 'evaluation_failed', message: 'boom', details: { target: 'edit', output: ['before'] } },
    });
    expect(service.requestStatus('never-issued')).toBeUndefined();
  });

  test('a Studio handler error is a completed failure, not an unknown outcome', () => {
    const details = { requestId: 'r-1', targetPeerId: 'instance:test/edit', stage: 'response_delivery' as const, outcome: 'unknown' as const };
    const failed = publicToolErrorBody('eval', new RequestFailure('handler threw', 'studio_response_error', { ...details, executionOutcome: 'error' }));
    expect(failed).toMatchObject({ error: { execution: 'failed', retry: 'after_fix' } });
    expect(failed).not.toHaveProperty('error.next');
    expect(publicToolErrorBody('eval', new RequestFailure('no answer', 'request_timeout', { ...details, executionOutcome: 'unknown' }))).toMatchObject({
      error: { execution: 'unknown', retry: 'never', next: 'roblox status --request-id r-1' },
    });
  });

  test('logs report evictions since the cursor and tail omissions', async () => {
    const { bridge, peerId, service } = await attachedService();
    const logs = parseResult(await answered(service.logs({ tail: 1 }), bridge, peerId, {
      entries: [{ seq: 9, ts: 9, level: 'INFO', message: 'm' }], nextSince: 9, totalDropped: 50, oldestSeq: 5, droppedSinceCursor: 4, omittedByTail: 2,
    }));
    expect(logs).toMatchObject({ scope: 'instance', dropped: 4, omitted_by_tail: 2, gaps: [{ role: 'edit', instance_id: 'instance:test', dropped: 4 }] });
    expect(logs).not.toHaveProperty('total_dropped');
  });

  test('test status reports how the last solo playtest ended', async () => {
    const { bridge, peerId, tools, service } = await attachedService();
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const status = parseResult(await answered(service.test({ action: 'status' }), bridge, peerId, {
      session: { phase: 'idle' },
      soloOutcome: { phase: 'completed', mode: 'play', ok: true, result: 'victory', startedAt: 10, completedAt: 12 },
    }));
    expect(status).toMatchObject({
      mode: 'solo', running: false,
      solo_outcome: { phase: 'completed', mode: 'play', ok: true, result: 'victory', started_at: 10, completed_at: 12 },
    });
    expect(status.solo_outcome).not.toHaveProperty('completedAt');
  });

  test('turns a failed Luau execution into an actionable command error', async () => {
    const bridge = new BridgeService();
    const peerId = registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const evaluation = service.evaluate({ code: 'error("boom")', target: 'edit' }, {
      signal: new AbortController().signal,
      requestId: 'failed-eval',
    });
    const request = bridge.claimNextRequestForTransport(peerId, peerId);
    if (!request) throw new Error('expected an eval request');
    bridge.resolveRequest(request.requestId, { success: false, error: 'boom' });

    await expect(evaluation).rejects.toMatchObject({
      code: 'evaluation_failed',
      statusCode: 422,
      details: { target: 'edit' },
    });
  });

  test('returns a plain image payload without MCP content blocks', async () => {
    const bridge = new BridgeService();
    const peerId = registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const screenshot = service.screenshot({});
    const request = bridge.claimNextRequestForTransport(peerId, peerId);
    if (!request) throw new Error('expected a screenshot request');
    bridge.resolveRequest(request.requestId, {
      success: true,
      width: 1,
      height: 1,
      data: Buffer.from([255, 0, 0, 255]).toString('base64'),
    });

    const result = parseResult(await screenshot);
    expect(result).toMatchObject({
      width: 1,
      height: 1,
      format: 'jpeg',
      mime_type: 'image/jpeg',
      image: { mime_type: 'image/jpeg' },
    });
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('message');
    expect(result).not.toHaveProperty('image.type');
  });

  test('rejects Roblox solid-magenta CaptureService placeholders', async () => {
    const bridge = new BridgeService();
    const peerId = registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const screenshot = service.screenshot({});
    const request = bridge.claimNextRequestForTransport(peerId, peerId);
    if (!request) throw new Error('expected a screenshot request');
    const magenta = {
      success: true,
      width: 2,
      height: 2,
      data: Buffer.from([
        255, 0, 255, 255,
        255, 0, 255, 255,
        255, 0, 255, 255,
        255, 0, 255, 255,
      ]).toString('base64'),
    };
    bridge.resolveRequest(request.requestId, magenta);

    const settleRetries = (async () => {
      // Each retry may first ask the refreshed plugin for a direct Studio
      // viewport capture before the legacy CaptureService request is retried.
      for (let requestNumber = 0; requestNumber < 5; requestNumber++) {
        const retry = await waitForRequest(bridge, peerId);
        bridge.resolveRequest(retry.requestId, magenta);
      }
    })();

    await expect(screenshot).rejects.toMatchObject({
      code: 'screenshot_failed',
      message: expect.stringContaining('No capture backend'),
    });
    await settleRetries;
  });

  test('retries a suspicious screenshot and returns the first trustworthy frame', async () => {
    const bridge = new BridgeService();
    const peerId = registerEdit(bridge);
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const screenshot = service.screenshot({});
    const first = await waitForRequest(bridge, peerId);
    bridge.resolveRequest(first.requestId, {
      success: true,
      width: 1,
      height: 1,
      data: Buffer.from([255, 0, 255, 255]).toString('base64'),
    });
    const studioFallback = await waitForRequest(bridge, peerId);
    expect(studioFallback.endpoint).toBe('/api/capture-studio-screenshot');
    bridge.resolveRequest(studioFallback.requestId, {
      success: true,
      width: 1,
      height: 1,
      data: Buffer.from([255, 0, 255, 255]).toString('base64'),
    });
    const second = await waitForRequest(bridge, peerId);
    expect(second.endpoint).toBe('/api/capture-screenshot');
    bridge.resolveRequest(second.requestId, {
      success: true,
      width: 1,
      height: 1,
      data: Buffer.from([255, 0, 0, 255]).toString('base64'),
    });

    await expect(screenshot).resolves.toMatchObject({
      width: 1,
      height: 1,
      capture_attempts: 2,
      image: { mime_type: 'image/jpeg' },
    });
  });

  test('continues an existing scenario without restarting or stopping its playtest', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    const lifecycle = jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    await service.open({ source: 'attach' });
    const result = await service.test({ action: 'play', scenario: { steps: [{ type: 'wait', duration_ms: 0 }] } });
    expect(result).toMatchObject({ passed: true, reused_playtest: true, kept_open: true, validation: 'scenario' });
    expect(lifecycle.mock.calls.map((call) => call[0])).toEqual(['status']);
  });

  test('a timed keyboard step releases the key and rejects ambiguous key-down durations', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const input = jest.spyOn(tools, 'simulateKeyboardInput').mockResolvedValue({ success: true } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
    await service.open({ source: 'attach' });
    const tapped = await service.test({ action: 'play', scenario: { steps: [{ type: 'keyboard', key_code: 'W', duration: 0.4 }] } });
    expect(tapped).toMatchObject({ passed: true });
    expect(input).toHaveBeenCalledWith('W', 'tap', 0.4, undefined, undefined, 'instance:test');
    input.mockClear();
    await expect(service.test({ action: 'play', scenario: { steps: [{ type: 'keyboard', key_code: 'W', action: 'press', duration: 0.4 }] } })).rejects.toMatchObject({ code: 'invalid_scenario', message: expect.stringContaining('duration requires action=tap') });
    expect(input).not.toHaveBeenCalled();
  });

  test('an input scenario never asks for the foreground unless the caller opts in', async () => {
    const acquire = acquireFocus as jest.Mock;
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    jest.spyOn(tools, 'simulateKeyboardInput').mockResolvedValue({ success: true } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
    await service.open({ source: 'attach' });
    acquire.mockClear();
    await service.test({ action: 'play', scenario: { steps: [{ type: 'keyboard', key_code: 'E' }] } });
    expect(acquire.mock.calls).toEqual([[false]]);
    await service.test({ action: 'play', foreground: true, scenario: { steps: [{ type: 'keyboard', key_code: 'E' }] } });
    expect(acquire.mock.calls).toEqual([[false], [true]]);
    expect(() => service.submitTest({ action: 'play', foreground: 'auto', keep_open: true })).toThrow(expect.objectContaining({ code: 'invalid_argument', message: 'foreground must be a boolean.' }));
  });

  test('the receipt reports the rate Studio rendered at and warns below full rate', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
    const client = (frames: number, at: number) => ({ peers: { 'client-1': { role: 'client-1', render: { available: true, rendering: true, frame_count: frames, sampled_at: at } } } });
    jest.spyOn(tools, 'getRuntimeHealth')
      .mockResolvedValueOnce(client(100, 10) as never)
      .mockResolvedValueOnce(client(250, 20) as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    await service.open({ source: 'attach' });
    const result = await service.test({ action: 'play', duration_ms: 0 }) as Record<string, unknown>;
    expect(result.render_fps).toBe(15);
    expect(result.warnings).toEqual(['Studio renders at ~15 fps while it is not the frontmost window; pass --foreground for a full-rate video.']);
  });

  test('readiness must become true before a playtest can pass', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
    const evaluate = jest.spyOn(service, 'evaluate').mockResolvedValue({ result: false });
    await service.open({ source: 'attach' });
    const failed = await service.test({ action: 'play', keep_open: true, timeout: 1, readiness_attribute: 'GameReady' });
    expect(failed).toMatchObject({ passed: false, evidence: { readiness: { passed: false } } });
    evaluate.mockResolvedValue({ result: true });
    const ready = await service.test({ action: 'play', keep_open: true, timeout: 1, readiness_attribute: 'GameReady' });
    expect(ready).toMatchObject({ passed: true, validation: 'readiness', evidence: { readiness: { attempts: 2 } } });
  });

  test('refuses a different player count without disturbing the running game', async () => {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    const lifecycle = jest.spyOn(tools, 'soloPlaytest');
    const service = new CliCommandService(tools, bridge);
    await service.open({ source: 'attach' });
    await expect(service.test({ action: 'play', players: 2, keep_open: true })).rejects.toMatchObject({ code: 'active_test_mismatch' });
    expect(lifecycle).not.toHaveBeenCalled();
  });

  test('wait_until polls with fresh operation ids until a condition is stable', async () => {
    const bridge = new BridgeService();
    const editPeerId = registerEdit(bridge);
    const clientPeerId = registerPeer(bridge, 'client-1');
    const service = new CliCommandService(new RobloxStudioTools(bridge), bridge);
    await service.open({ source: 'attach' });

    const runScenarioStep = (service as unknown as {
      runScenarioStep(step: unknown, context: { signal: AbortSignal; requestId: string }): Promise<unknown>;
    }).runScenarioStep.bind(service);
    const stepPromise = runScenarioStep({
      type: 'wait_until',
      target: 'client-1',
      code: "return workspace:GetAttribute('OpeningReady') == true",
      timeout_ms: 2_000,
      stable_frames: 2,
      instance_id: 'instance:test',
    }, { signal: new AbortController().signal, requestId: 'wait-until-test' });

    const first = await waitForRequest(bridge, clientPeerId);
    expect(first.endpoint).toBe('/api/eval-runtime');
    bridge.resolveRequest(first.requestId, { bridge: 'ok', ok: true, values: [false], valueTypes: ['boolean'], output: [] });
    const second = await waitForRequest(bridge, clientPeerId);
    bridge.resolveRequest(second.requestId, { bridge: 'ok', ok: true, values: [true], valueTypes: ['boolean'], output: [] });
    const third = await waitForRequest(bridge, clientPeerId);
    bridge.resolveRequest(third.requestId, { bridge: 'ok', ok: true, values: [true], valueTypes: ['boolean'], output: [] });

    const result = parseResult(await stepPromise);
    expect(result).toMatchObject({
      passed: true,
      condition: true,
      stable_frames: 2,
      required_stable_frames: 2,
      attempts: 3,
      target: 'client-1',
    });
    expect(new Set([first.requestId, second.requestId, third.requestId]).size).toBe(3);
    expect(bridge.getPeerById(editPeerId)).toBeDefined();
  });

  test('runtime health exposes render, capture, and readiness diagnostics per peer', async () => {
    const bridge = new BridgeService();
    const editPeerId = registerEdit(bridge);
    const serverPeerId = registerPeer(bridge, 'server');
    const clientPeerId = registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    const healthPromise = tools.getRuntimeHealth('instance:test', undefined, true);

    for (const peerId of [editPeerId, serverPeerId, clientPeerId]) {
      const request = await waitForRequest(bridge, peerId);
      expect(request.endpoint).toBe('/api/runtime-health');
      bridge.resolveRequest(request.requestId, {
        success: true,
        render: { available: true, rendering: true, state: 'rendering', frameCount: 42, secondsSinceFrame: 0.02 },
        capture: { serviceAvailable: true, callbackFired: true, pixelsReadable: true, usable: true },
        readiness: { attribute: 'OpeningReady', present: true, value: true, fired: true },
      });
    }

    await expect(healthPromise).resolves.toMatchObject({
      instance_id: 'instance:test',
      peers: {
        edit: {
          render: { available: true, rendering: true, frame_count: 42 },
          capture: { service_available: true, pixels_readable: true, usable: true },
          readiness: { attribute: 'OpeningReady', fired: true },
        },
        server: { render: { available: true } },
        'client-1': { render: { state: 'rendering' } },
      },
    });
  });

  test('presents recovery status in the public vocabulary', () => {
    const status = publicRequestStatus({
      requestId: 'recover-me',
      targetPeerId: 'instance:test/edit',
      queuedAt: 100,
      dispatchedAt: 101,
      executionStartedAt: 102,
      executionCompletedAt: 103,
      settledAt: 104,
      stage: 'response_delivery',
      state: 'settled',
      outcome: 'success',
      executionOutcome: 'success',
      response: { content: [{ type: 'text', text: '{"value":7}' }] },
    });

    expect(status).toEqual({
      state: 'settled',
      stage: 'response_delivery',
      execution: 'success',
      dispatched_at: 101,
      execution_started_at: 102,
      execution_completed_at: 103,
      settled_at: 104,
      result: { value: 7 },
    });
    expect(status).not.toHaveProperty('requestId');
    expect(status).not.toHaveProperty('targetPeerId');
  });

  test('does not register the private bridge handler as a public route', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge, undefined, { name: 'test', version: '0.1.0' }, { authToken: 'test-token' });
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');

    try {
      const privateRoute = await fetch(`http://127.0.0.1:${address.port}/v2/commands/get_runtime_logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Auth': 'test-token' },
        body: JSON.stringify({ instance_id: 'instance:test' }),
      });
      expect(privateRoute.status).toBe(404);

      const missingAuth = await fetch(`http://127.0.0.1:${address.port}/v2/commands/eval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'return true' }),
      });
      expect(missingAuth.status).toBe(401);
      expect(missingAuth.headers.get('X-Roblox-Agent-Protocol')).toBe('2');
      await expect(missingAuth.json()).resolves.toMatchObject({ error: { code: 'unauthorized' } });

      const command = await fetch(`http://127.0.0.1:${address.port}/v2/commands/eval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Studio-Auth': 'test-token',
          'X-Request-ID': 'agent-protocol-test',
        },
        body: JSON.stringify({ code: 'return true' }),
      });
      expect(command.status).toBe(400);
      await expect(command.json()).resolves.toMatchObject({
        error: { code: 'session_required', execution: 'not_started', retry: 'after_fix' },
      });
      expect(command.headers.get('X-Roblox-Agent-Protocol')).toBe('2');
      expect(command.headers.get('X-Request-ID')).toBe('agent-protocol-test');

      const invalidRequestId = await fetch(`http://127.0.0.1:${address.port}/v2/commands/eval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Studio-Auth': 'test-token',
          'X-Request-ID': 'not safe',
        },
        body: JSON.stringify({ code: 'return true' }),
      });
      expect(invalidRequestId.status).toBe(400);
      await expect(invalidRequestId.json()).resolves.toMatchObject({ error: { code: 'invalid_request_id' } });

      registerEdit(bridge);
      const open = await fetch(`http://127.0.0.1:${address.port}/v2/commands/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Auth': 'test-token' },
        body: JSON.stringify({ source: 'attach' }),
      });
      expect(open.status).toBe(200);
      const openBody = await open.json() as Record<string, unknown>;
      expect(openBody).toMatchObject({ session: { instance_id: 'instance:test' } });
      expect(openBody).not.toHaveProperty('ok');
      expect(openBody).not.toHaveProperty('command');
      expect(openBody).not.toHaveProperty('request_id');
      expect(openBody).not.toHaveProperty('data');

      const operationId = open.headers.get('X-Request-ID');
      const recovery = await fetch(`http://127.0.0.1:${address.port}/v2/requests/${operationId}`, {
        headers: { 'X-Studio-Auth': 'test-token' },
      });
      await expect(recovery.json()).resolves.toMatchObject({
        state: 'settled', execution: 'success', command: 'open', result: openBody,
      });
      const duplicate = await fetch(`http://127.0.0.1:${address.port}/v2/commands/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Auth': 'test-token', 'X-Request-ID': operationId! },
        body: JSON.stringify({ source: 'attach' }),
      });
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toMatchObject({ error: { code: 'duplicate_request' } });

      const statusRequest = fetch(`http://127.0.0.1:${address.port}/v2/status`, {
        headers: { 'X-Studio-Auth': 'test-token' },
      });
      const healthRequest = await waitForRequest(bridge, 'instance:test/edit');
      expect(healthRequest.endpoint).toBe('/api/runtime-health');
      bridge.resolveRequest(healthRequest.requestId, {
        success: true,
        render: { available: true, rendering: true, state: 'rendering', frameCount: 12 },
        capture: { serviceAvailable: true, callbackFired: true, pixelsReadable: true, usable: true },
        readiness: { attribute: 'OpeningReady', present: false, fired: false },
      });
      const status = await statusRequest;
      expect(status.status).toBe(200);
      const statusBody = await status.json() as Record<string, unknown>;
      expect(statusBody).toMatchObject({
        connected: true,
        instances: [{ instance_id: 'instance:test', roles: ['edit'], running: false }],
        session: { instance_id: 'instance:test', ownership: 'attached', source: 'attach' },
      });
      expect(statusBody.instances).toMatchObject([{
        runtime_health: {
          edit: {
            render: { available: true, rendering: true, frame_count: 12 },
            capture: { service_available: true, pixels_readable: true, usable: true },
            readiness: { attribute: 'OpeningReady', fired: false },
          },
        },
      }]);
      expect(statusBody).not.toHaveProperty('peers');
      expect(statusBody).not.toHaveProperty('instanceCount');
      expect(statusBody.session).not.toHaveProperty('roles');
      expect(statusBody.session).not.toHaveProperty('place_name');

      const schema = await fetch(`http://127.0.0.1:${address.port}/v2/schema`, {
        headers: { 'X-Studio-Auth': 'test-token' },
      });
      expect(schema.status).toBe(200);
      await expect(schema.json()).resolves.toMatchObject({
        protocol: { name: 'roblox-cli-agent', version: 2 },
        commands: { open: expect.any(Object), eval: expect.any(Object) },
      });
    } finally {
      await app.cleanup();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test('daemon stop requires the auth token and shuts down only after answering', async () => {
    const bridge = new BridgeService();
    const stopped = Promise.withResolvers<void>();
    const stop = jest.fn(() => stopped.resolve());
    const app = createHttpServer(new RobloxStudioTools(bridge), bridge, undefined, { name: 'test', version: '1', stop }, { authToken: 'test-token' });
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    try {
      const anonymous = await fetch(`http://127.0.0.1:${port}/v2/daemon/stop`, { method: 'POST' });
      expect(anonymous.status).toBe(401);
      expect(stop).not.toHaveBeenCalled();

      const accepted = await fetch(`http://127.0.0.1:${port}/v2/daemon/stop`, { method: 'POST', headers: { 'X-Studio-Auth': 'test-token' } });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toEqual({ stopping: true, pid: process.pid });
      await stopped.promise;
      expect(stop).toHaveBeenCalledTimes(1);
    } finally {
      await app.cleanup();
      server.close();
      await once(server, 'close');
    }
  });
  test('HTTP admission survives a disconnected caller and retains its complete durable result', async () => {
    const bridge=new BridgeService();registerEdit(bridge);
    let finish!:()=>void;
    const barrier=new Promise<void>(r=>{finish=r});
    let dispatched=0;
    const execute=jest.spyOn(CliCommandService.prototype as unknown as {testPlay: (...args:any[])=>Promise<unknown>},'testPlay').mockImplementation(async(_body,context)=>{
      dispatched++;context.job.ready(['client-1:original']);context.job.stepStarted(0,{name:'native action'});
      await barrier;context.job.stepFinished(0,{name:'native action',passed:true,result:'x'.repeat(300_000)});return {passed:true,steps:[]};
    });
    const app=createHttpServer(new RobloxStudioTools(bridge),bridge,undefined,{name:'test',version:'1'},{authToken:'test-token'});
    const server=http.createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    const port=(server.address() as import('node:net').AddressInfo).port;
    const headers={'Content-Type':'application/json','X-Studio-Auth':'test-token'};
    const post=(body:unknown,extra={})=>fetch(`http://127.0.0.1:${port}/v2/commands/test`,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
    try {
      await fetch(`http://127.0.0.1:${port}/v2/commands/open`,{method:'POST',headers,body:JSON.stringify({source:'attach'})});
      const controller=new AbortController();
      const accepted=await fetch(`http://127.0.0.1:${port}/v2/commands/test`,{method:'POST',headers:{...headers,'X-Request-ID':'http-durable'},body:JSON.stringify({action:'play',scenario:{steps:[{type:'eval',code:'return true'}]}}),signal:controller.signal});
      expect(accepted.status).toBe(202);controller.abort();finish();
      let status:any;
      for(let i=0;i<100;i++){
        status=await (await fetch(`http://127.0.0.1:${port}/v2/requests/http-durable`,{headers})).json();
        if(status.state==='completed')break;await new Promise(r=>setTimeout(r,5));
      }
      expect(status.state).toBe('completed');expect(dispatched).toBe(1);
      const result=await(await post({action:'result',job_id:'http-durable'})).json() as {steps:unknown[]};
      expect(JSON.stringify(result.steps).length).toBeGreaterThan(300_000);
      expect((await post({action:'play',scenario:{steps:[]}}, {'X-Request-ID':'http-durable'})).status).toBe(409);
    } finally {finish();execute.mockRestore();await app.cleanup();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  });

});

describe('scenario recording under a playtest job', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(`${tmpdir()}/roblox-cli-record-`);
    process.env.ROBLOX_CLI_HOME = testHome;
    // These are module-mock jest.fn()s, whose implementations survive
    // restoreAllMocks. Reset them so each test's own arrangement is the only
    // thing that decides whether calibration succeeds.
    (viewport.calibratedViewportRect as jest.Mock).mockReset();
    (worker.recordWithWorker as jest.Mock).mockReset();
    (worker.ensureCaptureWorker as jest.Mock).mockReset();
    (worker.activeWorkerSocket as jest.Mock).mockReset();
    // Defaults a test overrides when it is the behaviour under test.
    (worker.ensureCaptureWorker as jest.Mock).mockResolvedValue(undefined);
    (worker.activeWorkerSocket as jest.Mock).mockReturnValue(true);
    (worker.recordWithWorker as jest.Mock).mockImplementation(async (request: { file: string }) => ({
      started: true, file: request.file, recording_id: 'default',
      state_file: join(testHome, 'rec.state.json'),
      started_at: new Date(Date.now() - 1000).toISOString(),
      width: 1920, height: 1180,
      viewport: { mode: 'full_window' },
    }));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // The recording is started by the terminal-owned worker, not by the daemon:
  // Screen Recording permission attaches to the responsible application, so a
  // daemon whose starter lacked it is refused by ScreenCaptureKit. Asserting the
  // route is asserting the fix, not an implementation detail.
  function recordedService(evaluate: (code: string) => Promise<unknown>) {
    const bridge = new BridgeService();
    registerEdit(bridge);
    registerPeer(bridge, 'client-1');
    const tools = new RobloxStudioTools(bridge);
    const lifecycle = jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true, running: true, roles: ['edit', 'server', 'client-1'] } as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
    jest.spyOn(service, 'evaluate').mockImplementation((async (body: { code: string }) => (
      body.code.includes('RobloxCliCalibration')
        ? { result: { width: 100, height: 50, input_width: 100, input_height: 50 } }
        : evaluate(body.code)
    )) as never);
    return { service, tools, bridge, lifecycle };
  }

  test('records the calibrated viewport, stops before teardown, and writes timeline offsets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-record-out-'));
    const file = join(directory, 'gameplay.mp4');
    jest.spyOn(viewport, 'calibratedViewportRect').mockResolvedValue({
      crop: { x: 4, y: 6, width: 100, height: 50 },
      window: { id: 4242, pid: 99, title: 'place - Roblox Studio', bounds: {} },
      capture_width: 200, capture_height: 100,
      viewport: { width: 100, height: 50 },
      capture: { encodedData: '', encodedMimeType: 'image/png' },
    } as never);
    const start = jest.spyOn(worker, 'recordWithWorker').mockImplementation(async (request) => ({
      started: true, file: request.file, recording_id: 'rec-1',
      state_file: join(directory, 'rec.state.json'),
      started_at: new Date(Date.now() - 1000).toISOString(),
      width: 100, height: 50,
      viewport: { mode: 'calibrated_crop', crop_in_capture_pixels: { x: 4, y: 6, width: 100, height: 50 } },
    }));
    const stop = jest.spyOn(recording, 'stopNativeRecording').mockImplementation(async (partial = '') => {
      writeFileSync(partial, 'video');
      return { file: partial, duration_seconds: 12.5, width: 100, height: 50, audio_tracks: 1, stop_reason: 'scenario_completed' };
    });
    const captureWorker = jest.spyOn(worker, 'ensureCaptureWorker').mockResolvedValue(undefined);
    try {
      const { service, lifecycle } = recordedService(async () => ({ result: true }));
      await service.open({ source: 'attach' });
      const result = parseResult(await service.test({
        action: 'play',
        record: file,
        scenario: { steps: [
          { type: 'wait', name: 'hold', duration_ms: 5 },
          { type: 'eval', name: 'check', code: 'return true' },
        ] },
      })) as Record<string, unknown>;

      // The recording must go through a worker the terminal already owns; the
      // daemon must never create one (a worker it spawned would inherit its
      // missing Screen Recording permission).
      expect(worker.activeWorkerSocket).toHaveBeenCalled();
      expect(captureWorker).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      // The recorder writes a fresh sibling, moved onto the requested path once finalized.
      const partial = start.mock.calls[0][0].file;
      expect(partial).toMatch(/gameplay\.recording-[0-9a-f]{8}\.mp4$/);
      // The calibrated crop is what the worker is asked to apply.
      expect(start.mock.calls[0][0].crop).toMatchObject({ x: 4, y: 6, width: 100, height: 50, capture_width: 200 });

      // Top-level recording receipt plus the sidecar a reviewer seeks into.
      expect(result.recording).toMatchObject({ file, duration_seconds: 12.5, width: 100, height: 50, audio_tracks: 1 });
      expect(result.timeline).toMatchObject({ file: join(directory, 'timeline.json'), steps: 2 });
      const timeline = JSON.parse(readFileSync(join(directory, 'timeline.json'), 'utf8')) as Record<string, unknown>;
      expect(timeline).toMatchObject({ video: file, viewport_calibration: { verified: true } });
      const entries = timeline.steps as Array<Record<string, unknown>>;
      expect(entries.map(entry => entry.name)).toEqual(['hold', 'check']);
      for (const entry of entries) {
        expect(typeof entry.started_at_ms).toBe('number');
        expect(typeof entry.ended_at_ms).toBe('number');
        expect(entry.ended_at_ms as number).toBeGreaterThanOrEqual(entry.started_at_ms as number);
      }
      // Every retained step receipt carries the same clock.
      for (const step of result.steps as Array<Record<string, unknown>>) {
        expect(typeof step.started_at_ms).toBe('number');
        expect(typeof step.ended_at_ms).toBe('number');
      }
      // The recorder stops before the playtest is torn down.
      expect(stop).toHaveBeenCalledWith(partial);
      expect(lifecycle.mock.calls.map(call => call[0])).toEqual(['status']);
      expect(readFileSync(file, 'utf8')).toBe('video');
      expect(existsSync(partial)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports a full-window fallback instead of a silently mis-cropped video', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-record-fallback-'));
    const file = join(directory, 'gameplay.mp4');
    jest.spyOn(viewport, 'calibratedViewportRect').mockRejectedValue(new Error('Calibration markers were not all visible'));
    const start = jest.spyOn(worker, 'recordWithWorker').mockResolvedValue({
      started: true, file, recording_id: 'r', state_file: join(directory, 'state.json'),
      started_at: new Date().toISOString(), width: 1920, height: 1180,
      viewport: { mode: 'full_window', reason: 'no calibrated crop was requested' },
    });
    jest.spyOn(recording, 'stopNativeRecording').mockImplementation(async (partial = '') => {
      writeFileSync(partial, 'video');
      return { file: partial, duration_seconds: 3, width: 1920, height: 1180, audio_tracks: 1 };
    });
    jest.spyOn(worker, 'ensureCaptureWorker').mockResolvedValue(undefined);
    try {
      const { service } = recordedService(async () => ({ result: true }));
      await service.open({ source: 'attach' });
      const result = parseResult(await service.test({
        action: 'play', record: file,
        scenario: { steps: [{ type: 'wait', name: 'hold', duration_ms: 5 }] },
      }));
      // No crop is passed, and the fallback is stated explicitly.
      expect(start.mock.calls[0][0].crop).toBeUndefined();
      const evidence = result.evidence as Record<string, unknown>;
      const recording = evidence.recording as Record<string, unknown>;
      expect(recording.calibration).toMatchObject({ verified: false, reason: expect.stringContaining('Calibration markers') });
      expect((result.recording as Record<string, unknown>).calibration).toMatchObject({ verified: false });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a recording that cannot start fails the run, skips the steps and still settles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-record-fail-'));
    const file = join(directory, 'gameplay.mp4');
    jest.spyOn(viewport, 'calibratedViewportRect').mockRejectedValue(new Error('no visible client'));
    jest.spyOn(worker, 'recordWithWorker').mockRejectedValue(new Error('The user declined TCCs for application, window, display capture'));
    jest.spyOn(worker, 'ensureCaptureWorker').mockResolvedValue(undefined);
    try {
      const { service } = recordedService(async () => ({ result: true }));
      await service.open({ source: 'attach' });
      const result = parseResult(await service.test({
        action: 'play', record: file,
        scenario: { steps: [{ type: 'wait', name: 'hold', duration_ms: 5 }] },
      }));
      expect(result).toMatchObject({
        passed: false, execution: 'failed',
        outcome: { passed: false, steps_passed: 0, steps_total: 1 },
        evidence: { recording: { started: false, failure: expect.stringContaining('declined TCCs') } },
        failure: { code: 'playtest_failed' },
      });
      expect(result.steps).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an existing --record file is refused at admission, before any job exists, unless overwrite is set', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-record-exists-'));
    const file = join(directory, 'gameplay.mp4');
    writeFileSync(file, 'previous');
    try {
      const { service } = recordedService(async () => ({ result: true }));
      await service.open({ source: 'attach' });
      const scenario = { steps: [{ type: 'wait', name: 'hold', duration_ms: 5 }] };
      expect(() => service.submitTest({ action: 'play', record: file, scenario }, 'refused')).toThrow(expect.objectContaining({ code: 'output_exists' }));
      expect(service.jobs.status('refused')).toBeUndefined();
      expect(() => service.submitTest({ action: 'play', record: 'relative.mp4', scenario }, 'relative')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
      expect(() => service.submitTest({ action: 'play', overwrite: true, scenario }, 'no-record')).toThrow(expect.objectContaining({ code: 'invalid_argument' }));
      expect(service.submitTest({ action: 'play', record: file, overwrite: true, detach: true, scenario }, 'admitted')).toMatchObject({ state: 'queued' });
      await service.jobs.cancel('admitted');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('--overwrite replaces the file only with a finalized video of a passing run', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-record-overwrite-'));
    const file = join(directory, 'gameplay.mp4');
    writeFileSync(file, 'previous');
    let take = 0;
    jest.spyOn(recording, 'stopNativeRecording').mockImplementation(async (partial = '') => {
      writeFileSync(partial, `take-${++take}`);
      return { file: partial, duration_seconds: 1, width: 100, height: 50, audio_tracks: 1 };
    });
    try {
      let verdict = false;
      const { service } = recordedService(async () => ({ result: verdict }));
      await service.open({ source: 'attach' });
      const play = () => service.test({ action: 'play', record: file, overwrite: true, scenario: { steps: [{ type: 'eval', name: 'check', code: 'return ok' }] } });
      const failed = parseResult(await play());
      // A failed run keeps the previous video and says where the new one is.
      expect(readFileSync(file, 'utf8')).toBe('previous');
      const kept = (failed.recording as Record<string, unknown>).file as string;
      expect(kept).toMatch(/gameplay\.recording-[0-9a-f]{8}\.mp4$/);
      expect(readFileSync(kept, 'utf8')).toBe('take-1');
      expect((failed.cleanup as Record<string, unknown>).warnings).toEqual([expect.stringContaining('was kept because this run did not pass')]);
      verdict = true;
      const passed = parseResult(await play());
      expect(passed).toMatchObject({ passed: true, recording: { file } });
      expect(readFileSync(file, 'utf8')).toBe('take-2');
      expect(readdirSync(directory).filter(name => name.endsWith('.mp4')).sort()).toEqual(['gameplay.mp4', kept.slice(directory.length + 1)].sort());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('test calibrate reports the play viewport crop for a running client', async () => {
    const { service } = recordedService(async () => ({ result: true }));
    jest.spyOn(viewport, 'calibratedViewportRect').mockResolvedValue({
      crop: { x: 4, y: 6, width: 100, height: 50 },
      window: { id: 1, pid: 2, title: 'place - Roblox Studio', bounds: {} },
      capture_width: 200, capture_height: 100,
      viewport: { width: 100, height: 50 },
      capture: { encodedData: '', encodedMimeType: 'image/png' },
    } as never);
    await service.open({ source: 'attach' });
    const result = parseResult(await service.test({ action: 'calibrate' }));
    expect(result).toMatchObject({
      verified: true, method: 'four_native_gui_markers',
      crop_in_capture: { x: 4, y: 6, width: 100, height: 50 },
      capture_width: 200, capture_height: 100,
    });
  });

  test('calibration measures the returned viewport value, not the eval envelope', async () => {
    const { service } = recordedService(async () => ({ result: true }));
    let measured: unknown;
    jest.spyOn(viewport, 'calibratedViewportRect').mockImplementation((async (_identity: unknown, evaluate: (code: string) => Promise<unknown>) => {
      measured = await evaluate('-- RobloxCliCalibration marker');
      return {
        crop: { x: 0, y: 0, width: 100, height: 50 },
        window: { id: 1, pid: 2, title: 'place - Roblox Studio', bounds: {} },
        capture_width: 100, capture_height: 50,
        viewport: measured,
        capture: { encodedData: '', encodedMimeType: 'image/png' },
      };
    }) as never);
    await service.open({ source: 'attach' });
    await service.test({ action: 'calibrate' });
    expect(measured).toEqual({ width: 100, height: 50, input_width: 100, input_height: 50 });
  });

  test('test status reports whether a recording is active', async () => {
    const { service } = recordedService(async () => ({ result: true }));
    await service.open({ source: 'attach' });
    const result = parseResult(await service.test({ action: 'status' }));
    expect(result.recording).toMatchObject({ active: false });
  });
});

/** Advance fake timers until the work settles, or fail if it never does. */
async function settleWithTimers<T>(work: Promise<T>, budgetMs = 600_000): Promise<T> {
  let settled = false;
  const tracked = work.then(value => { settled = true; return value; });
  for (let advanced = 0; advanced < budgetMs && !settled; advanced += 5_000) {
    await jest.advanceTimersByTimeAsync(5_000);
  }
  if (!settled) throw new Error(`teardown did not settle within ${budgetMs}ms of fake time`);
  return tracked;
}

describe('teardown cannot wedge a job', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(`${tmpdir()}/roblox-cli-wedge-`);
    process.env.ROBLOX_CLI_HOME = testHome;
    (worker.activeWorkerSocket as jest.Mock).mockReset();
    (worker.activeWorkerSocket as jest.Mock).mockReturnValue(true);
    (worker.recordWithWorker as jest.Mock).mockReset();
    (viewport.calibratedViewportRect as jest.Mock).mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  // A teardown await that never settles used to leave the job in `cleanup`
  // forever, keeping the session owned and refusing every later playtest. The
  // deadline is not a nicety: it is what makes cancellation terminate.
  test('a recorder that never finalizes still lets the playtest settle, failing on cleanup only', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-wedge-out-'));
    const file = join(directory, 'gameplay.mp4');
    jest.useFakeTimers();
    try {
      (viewport.calibratedViewportRect as jest.Mock).mockRejectedValue(new Error('no visible client'));
      (worker.recordWithWorker as jest.Mock).mockResolvedValue({
        started: true, file, recording_id: 'wedged', state_file: join(directory, 's.json'),
        started_at: new Date().toISOString(), width: 1920, height: 1180,
        viewport: { mode: 'full_window' },
      });
      // The recorder accepts the stop but never reports a finalized file.
      jest.spyOn(recording, 'stopNativeRecording').mockImplementation(() => new Promise(() => { }));

      const bridge = new BridgeService();
      registerEdit(bridge);
      registerPeer(bridge, 'client-1');
      const tools = new RobloxStudioTools(bridge);
      jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
      jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
      const service = new CliCommandService(tools, bridge);
      jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
      jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
      jest.spyOn(service, 'evaluate').mockResolvedValue({ target: 'client-1', duration_ms: 1, result: true });
      await service.open({ source: 'attach' });

      // Each deadline timer is created only once teardown reaches it, so time
      // is advanced repeatedly rather than once: the point is that the command
      // settles at all, not that it settles on a particular tick.
      const result = parseResult(await settleWithTimers(
        service.test({ action: 'play', record: file, scenario: { steps: [{ type: 'eval', name: 'trivial', target: 'client-1', code: 'return true' }] } }),
      )) as Record<string, unknown>;

      expect(result.recording).toBeUndefined();
      const evidence = result.evidence as Record<string, unknown>;
      expect((evidence.recording as Record<string, unknown>).finalize_failure).toContain('did not finalize');
      // The scenario passed; the missing video is a cleanup failure.
      expect(result).toMatchObject({
        passed: false,
        outcome: { passed: true, steps_passed: 1 },
        cleanup: { passed: false, failures: [expect.stringContaining('recording_not_finalized')], deadlines: [{ step: 'recording_finalize', deadline_ms: 90_000 }] },
        failure: { code: 'cleanup_failed' },
      });
    } finally {
      jest.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a focus helper that never releases still lets the playtest settle', async () => {
    jest.useFakeTimers();
    const focusModule = await import('../focus-session.js');
    // A helper that accepted the lease but never acknowledges its release is
    // the realistic failure: the CLI must not wait on it forever.
    (focusModule.acquireFocus as jest.Mock).mockResolvedValueOnce({
      receipt: { activated: false },
      release: () => new Promise(() => { }),
    });
    try {
      const bridge = new BridgeService();
      registerEdit(bridge);
      registerPeer(bridge, 'client-1');
      const tools = new RobloxStudioTools(bridge);
      jest.spyOn(tools, 'soloPlaytest').mockResolvedValue({ success: true } as never);
      jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
      const service = new CliCommandService(tools, bridge);
      jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
      jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
      jest.spyOn(service, 'evaluate').mockResolvedValue({ target: 'client-1', duration_ms: 1, result: true });
      await service.open({ source: 'attach' });

      const result = parseResult(await settleWithTimers(
        service.test({ action: 'play', scenario: { steps: [{ type: 'eval', name: 'trivial', target: 'client-1', code: 'return true' }] } }),
      )) as Record<string, unknown>;
      const evidence = result.evidence as Record<string, unknown>;
      expect(evidence.focus_release).toBeUndefined();
      expect(result.cleanup).toMatchObject({ deadlines: [{ step: 'focus_release', deadline_ms: 10_000 }] });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('teardown stops the playtest and proves it', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = mkdtempSync(`${tmpdir()}/roblox-cli-stop-`);
    process.env.ROBLOX_CLI_HOME = testHome;
    (worker.activeWorkerSocket as jest.Mock).mockReset();
    (worker.activeWorkerSocket as jest.Mock).mockReturnValue(true);
    (worker.recordWithWorker as jest.Mock).mockReset();
    (viewport.calibratedViewportRect as jest.Mock).mockReset();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  /**
   * A playtest the job starts itself: `start` connects a server and client,
   * and `stop` does whatever the test says, including leaving them connected.
   */
  function freshPlaytest(stop: (bridge: BridgeService) => unknown) {
    const bridge = new BridgeService();
    registerEdit(bridge);
    const tools = new RobloxStudioTools(bridge);
    const lifecycle = jest.spyOn(tools, 'soloPlaytest').mockImplementation((async (action: string) => {
      if (action === 'start') {
        registerPeer(bridge, 'server');
        registerPeer(bridge, 'client-1');
        return { success: true };
      }
      return action === 'stop' ? stop(bridge) : { success: true };
    }) as never);
    jest.spyOn(tools, 'getRuntimeHealth').mockResolvedValue({ peers: {} } as never);
    const service = new CliCommandService(tools, bridge);
    jest.spyOn(service, 'logs').mockResolvedValue({ entries: [] });
    jest.spyOn(service, 'screenshot').mockResolvedValue({ width: 2, height: 2 });
    // Preflight compiles every snippet; `return false` is the one condition that never holds.
    jest.spyOn(service, 'evaluate').mockImplementation((async (body: { code: string }) => (
      body.code.includes('loadstring') ? { result: { passed: true, failures: [] } } : { result: !body.code.includes('return false') }
    )) as never);
    return { bridge, service, lifecycle };
  }

  const disconnectRuntime = (bridge: BridgeService) => {
    bridge.unregisterPeer('instance:test/server');
    bridge.unregisterPeer('instance:test/client-1');
  };

  test('a stop request that times out after the runtime ended passes, with a cleanup warning', async () => {
    const { service, lifecycle } = freshPlaytest((bridge) => {
      // EndTest ran, the runtime is gone, but the edit peer's reply was lost.
      disconnectRuntime(bridge);
      return { success: false, error: 'Edit stop request failed.', detail: 'Request timeout: r-1; executing; unknown; waiter ended, execution is not cancelled or rolled back' };
    });
    await service.open({ source: 'attach' });
    const result = parseResult(await service.test({ action: 'play', scenario: { steps: [{ type: 'eval', name: 'check', target: 'client-1', code: 'return true' }] } }));
    expect(result).toMatchObject({
      passed: true, execution: 'success',
      outcome: { passed: true, steps_passed: 1, steps_total: 1 },
      cleanup: {
        passed: true, runtime: 'stopped', failures: [],
        stop: { confirmed: true, attempts: [{ method: 'playtest_stop', ok: false, error: expect.stringContaining('Request timeout') }] },
        warnings: [expect.stringContaining('confirmed gone')],
      },
    });
    expect(result.failure).toBeUndefined();
    expect(lifecycle.mock.calls.map(call => call[0])).toEqual(['start', 'status', 'stop']);
  });

  test('a runtime that will not stop is retried, escalated to the play server, and fails cleanup, not the scenario', async () => {
    jest.useFakeTimers();
    try {
      const { bridge, service, lifecycle } = freshPlaytest(() => ({ success: false, error: 'Playtest teardown did not complete.' }));
      const endTest = jest.spyOn(bridge, 'sendRequest').mockResolvedValue({ error: 'EndTest failed' });
      await service.open({ source: 'attach' });
      const result = parseResult(await settleWithTimers(
        service.test({ action: 'play', scenario: { steps: [{ type: 'eval', name: 'check', target: 'client-1', code: 'return true' }] } }),
      ));
      expect(result).toMatchObject({
        passed: false, execution: 'failed',
        outcome: { passed: true },
        cleanup: {
          passed: false, runtime: 'still_running',
          stop: { confirmed: false, attempts: [{ method: 'playtest_stop', ok: false }, { method: 'playtest_stop', ok: false }, { method: 'server_end_test', ok: false, error: 'EndTest failed' }] },
          failures: [expect.stringContaining('runtime_not_confirmed_stopped')],
        },
        failure: { code: 'cleanup_failed' },
      });
      expect(((result.cleanup as Record<string, unknown>).stop as Record<string, unknown>).remaining).toEqual(expect.arrayContaining(['server', 'client-1']));
      expect(lifecycle.mock.calls.filter(call => call[0] === 'stop')).toHaveLength(2);
      expect(endTest).toHaveBeenCalledWith('/api/multiplayer-test-end', expect.anything(), 'instance:test/server', expect.any(Number));
    } finally {
      jest.useRealTimers();
    }
  });

  test('a recording that cannot start under a job stops the playtest, settles the job and releases the session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-stop-record-'));
    (worker.recordWithWorker as jest.Mock).mockRejectedValue(new Error('Recording output already exists'));
    try {
      const { service, lifecycle } = freshPlaytest((bridge) => { disconnectRuntime(bridge); return { success: true }; });
      await service.open({ source: 'attach' });
      service.submitTest({ action: 'play', record: join(directory, 'gameplay.mp4'), scenario: { steps: [{ type: 'eval', name: 'check', target: 'client-1', code: 'return true' }] } }, 'record-fails');
      await service.jobs.settled('record-fails');
      expect(service.jobs.status('record-fails')).toMatchObject({ state: 'failed', execution: 'failed', phase: 'settled' });
      expect(service.jobs.hasActive('instance:test')).toBe(false);
      expect(service.jobs.result('record-fails')).toMatchObject({ outcome: { passed: false }, cleanup: { runtime: 'stopped' }, steps: [] });
      expect(lifecycle.mock.calls.map(call => call[0])).toEqual(['start', 'status', 'stop']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ['wait', { type: 'wait', name: 'long', duration_ms: 600_000 }],
    ['wait_until', { type: 'wait_until', name: 'long', target: 'client-1', code: 'return false', timeout_ms: 300_000 }],
  ])('cancel interrupts a long %s promptly and still stops the playtest', async (_type, step) => {
    const { service, lifecycle } = freshPlaytest((bridge) => { disconnectRuntime(bridge); return { success: true }; });
    await service.open({ source: 'attach' });
    service.submitTest({ action: 'play', scenario: { steps: [step] } }, 'long-wait');
    for (let turn = 0; turn < 1000 && service.jobs.status('long-wait')?.phase !== 'step'; turn++) await new Promise(resolve => setImmediate(resolve));
    expect(service.jobs.status('long-wait')).toMatchObject({ state: 'running', in_flight: { index: 0 } });
    const began = Date.now();
    const settled = await service.jobs.cancel('long-wait');
    // The cancel answers once teardown is done, in far less than one poll of a human's patience.
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(settled).toMatchObject({ state: 'cancelled', phase: 'settled' });
    expect(service.jobs.hasActive('instance:test')).toBe(false);
    const result = service.jobs.result('long-wait') as Record<string, unknown>;
    expect(result).toMatchObject({ passed: false, cancelled: true, cleanup: { runtime: 'stopped' }, steps: [{ passed: false, result: { cancelled: true } }] });
    expect(lifecycle.mock.calls.map(call => call[0])).toContain('stop');
  });
});
