import { CliUsageError, commandNeedsForeground, commandTimeoutMs, parseCli, run } from '../cli.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PROTOCOL_HEADER, AGENT_PROTOCOL_VERSION, CLI_TEST_MODES, REQUEST_ID_HEADER } from '../agent-protocol.js';

const home = mkdtempSync(join(tmpdir(), 'roblox-cli-home-'));
const previousHome = process.env.ROBLOX_CLI_HOME;
process.env.ROBLOX_CLI_HOME = home;
afterAll(() => {
  if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
  else process.env.ROBLOX_CLI_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const agentHeaders = { [AGENT_PROTOCOL_HEADER]: String(AGENT_PROTOCOL_VERSION) };

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: agentHeaders });
}

function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function sentHeader(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string>)[name];
}

function usageError(argv: string[]): CliUsageError {
  try {
    parseCli(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    return error as CliUsageError;
  }
  throw new Error(`expected ${argv.join(' ')} to be a usage error`);
}

describe('CLI artifact failures', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each(['--out', '--output'])('rejects an existing %s before sending any Studio command', async (option) => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-artifact-'));
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const command = option === '--output' ? ['screenshot'] : ['eval', 'return true'];
      const result = await run(parseCli([...command, '--token', 'test-token', option, directory]));
      expect(result.code).toBe(2);
      expect(result.response).toMatchObject({ error: { code: 'artifact_failed', execution: 'not_started' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a late retention failure preserves completed-command status and forbids replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-artifact-'));
    const destination = join(directory, 'evidence');
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      mkdirSync(destination); // Destination appears while the command is executing.
      return new Response(JSON.stringify({ target: 'edit', result: true }), {
        status: 200,
        headers: { ...agentHeaders, [REQUEST_ID_HEADER]: 'completed-request' },
      });
    });
    try {
      const result = await run(parseCli(['eval', 'return true', '--token', 'test-token', '--out', destination]));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.code).toBe(4);
      expect(result.response).toMatchObject({ error: {
        code: 'artifact_failed', execution: 'unknown', retry: 'never', request_id: 'completed-request',
        details: { command_completed: true, command_passed: true },
      } });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('roblox CLI parser', () => {
  test('inspection leaves desktop focus alone; interactive play may activate Studio', () => {
    for (const args of [
      ['screenshot'], ['screenshot', '--target', 'edit'],
      ['screenshot', '--target', 'client-1'], ['screenshot', '--native'],
      ['eval', 'return true'], ['eval', 'return true', '--target', 'client-1'],
      ['test', 'status'], ['test', 'run', 'return true'],
    ]) expect(commandNeedsForeground(parseCli(args))).toBe(false);
    expect(commandNeedsForeground(parseCli(['test', 'play', '--keep-open']))).toBe(false);
    expect(commandNeedsForeground(parseCli(['test', 'play', '--foreground', 'required', '--keep-open']))).toBe(true);
  });
  test('a scenario deadline includes its waits, duration and lifecycle work', () => {
    const parsed = parseCli(['test', 'play', '--keep-open']);
    expect(commandTimeoutMs(parsed, { duration_ms: 90_000, scenario: { steps: [
      { type: 'wait_until', timeout_ms: 120_000 }, { type: 'keyboard', duration: 4 },
    ] } })).toBe(424_000);
    expect(commandTimeoutMs(parseCli(['test', 'play', '--timeout', '20']), {})).toBe(20_000);
    expect(commandTimeoutMs(parseCli(['open', 'baseplate']), {})).toBe(150_000);
  });
  test('parses the five workflow commands without a generic call escape hatch', () => {
    expect(parseCli(['open', 'baseplate']).command).toBe('open');
    expect(parseCli(['eval', 'return game.Name', '--target', 'client-1']).options.target).toBe('client-1');
    expect(parseCli(['logs', '--follow', '--tail', '20']).options.follow).toBe(true);
    expect(parseCli(['screenshot', '--format', 'png']).options.format).toBe('png');
    expect(parseCli(['test', 'play', '--players', '2']).subcommand).toBe('play');
    expect(parseCli(['record', '--duration', '5', '--output', 'clip.mp4']).command).toBe('record');
    usageError(['record', 'unexpected', '--duration', '5', '--output', 'clip.mp4']);
    usageError(['record', '--duration', '0', '--output', 'clip.mp4']);
    usageError(['record', '--duration', '601', '--output', 'clip.mp4']);
    expect(parseCli(['schema']).command).toBe('schema');
    usageError(['call', 'execute_luau']);
  });

  test('parses source, target, artifact, and test options', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-'));
    const codeFile = join(directory, 'smoke.luau');
    const scenarioFile = join(directory, 'scenario.json');
    writeFileSync(codeFile, 'return game.Name\n');
    writeFileSync(scenarioFile, '{"steps":[]}\n');
    const parsed = parseCli([
      'test', 'play', '--scenario', scenarioFile, '--duration', '8', '--players', '2',
      '--keep-open', '--test-args', '{"seed":1}', '--out', 'evidence/run', '--ready-timeout', '120',
    ]);
    expect(parsed.options.scenario).toBe(scenarioFile);
    expect(parsed.options.durationMs).toBe(8000);
    expect(parsed.options.players).toBe(2);
    expect(parsed.options.keepOpen).toBe(true);
    expect(parsed.options.testArgs).toEqual({ seed: 1 });
    expect(parsed.options.readyTimeoutSeconds).toBe(120);
    expect(parseCli(['test', 'status', '--readiness-attribute', 'OpeningReady']).options.readinessAttribute).toBe('OpeningReady');
    expect(parseCli(['eval', '--file', codeFile]).options.file).toBe(codeFile);
    expect(parseCli(['close', '--instance-id', 'instance:stale']).options.instanceId).toBe('instance:stale');
    expect(parseCli(['screenshot', '--native']).options.nativeCapture).toBe(true);
    expect(parseCli(['status', '--capture-probe']).options.captureProbe).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });

  test('rejects ambiguous sources, invalid numbers and misplaced options', () => {
    for (const argv of [
      ['eval', '--file', 'one.luau', '--stdin'],
      ['test', 'play', '--players', '9'],
      ['screenshot', '--quality', '0'],
      ['test', 'status', '--native'],
      ['test', 'play', '--ready-timeout', '301'],
      ['test', 'status', '--ready-timeout', '10'],
      ['eval', 'return 1', '--timeout', '3601'],
      ['logs', '--duration', '5'],
      ['logs', '--until', 'ready'],
      ['logs', '--follow', '--until', '('],
      ['logs', '--follow', '--request-id', 'r1'],
      ['doctor', '--request-id', 'r1'],
      ['eval', 'return 1', '--capture-probe'],
      ['status', '--capture-probe', '--request-id', 'r1'],
      ['test', 'bogus'],
    ]) usageError(argv);
  });

  test('free-text option values may start with "-" and -- ends option parsing', () => {
    expect(parseCli(['eval', '--code', '-- setup\nreturn 1']).options.code).toBe('-- setup\nreturn 1');
    expect(parseCli(['eval', '--code=--!strict\nreturn 1']).options.code).toBe('--!strict\nreturn 1');
    expect(parseCli(['logs', '--filter', '-x']).options.filter).toBe('-x');
    expect(parseCli(['logs', '--follow', '--until', '--ready--']).options.until).toBe('--ready--');
    expect(parseCli(['eval', '--', '--[[probe]] return 1']).positional).toEqual(['--[[probe]] return 1']);
    expect(parseCli(['test', 'run', '--', '--x', '--target']).positional).toEqual(['--x', '--target']);
    expect(parseCli(['eval', '-']).positional).toEqual(['-']);
    // Structured values keep rejecting a following option, which is almost always a missing value.
    usageError(['eval', 'return 1', '--target', '--code']);
    // Code that looks like an option names both escape forms.
    const error = usageError(['eval', '--[[probe]] return 1']);
    expect(error.message).toContain('--code=');
    expect(error.message).toContain(' -- ');
  });

  test('--request-id is validated and allowed on daemon commands', () => {
    expect(parseCli(['eval', 'return 1', '--request-id', 'agent:run-1.a_b']).options.requestId).toBe('agent:run-1.a_b');
    expect(parseCli(['test', 'play', '--keep-open', '--request-id', 'p1', '--follow']).options.requestId).toBe('p1');
    for (const id of ['has space', 'x'.repeat(129), 'slash/id']) {
      expect(usageError(['eval', 'return 1', '--request-id', id]).code).toBe('invalid_request_id');
    }
  });

  test('test without a mode lists every mode the parser accepts', async () => {
    const result = await run(parseCli(['test']));
    expect(result.code).toBe(2);
    expect(result.response).toMatchObject({ error: { code: 'test_mode_required', details: { modes: [...CLI_TEST_MODES] } } });
    for (const mode of CLI_TEST_MODES) expect(parseCli(['test', mode]).subcommand).toBe(mode);
  });
});

describe('code sources', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([[['eval']], [['test', 'run']]])('%p without code is a usage error, never an implicit stdin read', async (argv) => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const result = await run(parseCli([...argv, '--token', 'test-token']));
    expect(result.code).toBe(2);
    expect(result.response).toMatchObject({ error: { code: 'usage_error', execution: 'not_started' } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('daemon request options', () => {
  afterEach(() => jest.restoreAllMocks());

  test('--request-id becomes the X-Request-ID of the command', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply({ target: 'edit', duration_ms: 1 }));
    expect((await run(parseCli(['eval', 'return 1', '--token', 't', '--request-id', 'retry-7']))).code).toBe(0);
    expect(sentHeader(fetchSpy.mock.calls[0][1], REQUEST_ID_HEADER)).toBe('retry-7');
    await run(parseCli(['logs', '--token', 't', '--request-id', 'logs-1']));
    expect(sentHeader(fetchSpy.mock.calls[1][1], REQUEST_ID_HEADER)).toBe('logs-1');
  });

  test('an explicit --timeout becomes the Studio deadline and the HTTP wait outlasts it', async () => {
    const eval90 = parseCli(['eval', 'return 1', '--timeout', '90']);
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply({ target: 'edit', duration_ms: 1 }));
    await run(parseCli(['eval', 'return 1', '--token', 't', '--timeout', '90']));
    expect(sentBody(fetchSpy.mock.calls[0][1])).toMatchObject({ timeout_ms: 90_000 });
    expect(commandTimeoutMs(eval90, { timeout_ms: 90_000 })).toBe(105_000);
    await run(parseCli(['test', 'run', 'return 1', '--token', 't', '--timeout', '1.5']));
    expect(sentBody(fetchSpy.mock.calls[1][1])).toMatchObject({ action: 'run', timeout_ms: 1500 });
    expect(commandTimeoutMs(parseCli(['test', 'run', 'return 1', '--timeout', '1.5']), {})).toBe(16_500);
    await run(parseCli(['eval', 'return 1', '--token', 't']));
    expect(sentBody(fetchSpy.mock.calls[2][1])).not.toHaveProperty('timeout_ms');
    expect(commandTimeoutMs(parseCli(['eval', 'return 1']), {})).toBe(45_000);
  });

  test('--ready-timeout is the playtest start and readiness timeout', async () => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply({ job_id: 'job-1', state: 'queued' }, 202));
    const result = await run(parseCli(['test', 'play', '--keep-open', '--detach', '--ready-timeout', '240', '--token', 't']));
    expect(result.code).toBe(0);
    expect(sentBody(fetchSpy.mock.calls[0][1])).toMatchObject({ action: 'play', timeout: 240 });
  });

  test('status --capture-probe asks the daemon to run the capture probe', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch')
      .mockImplementation(async () => reply({ connected: false, connector_active: true, instances: [] }));
    expect((await run(parseCli(['status', '--capture-probe', '--token', 't']))).code).toBe(0);
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/v2\/status\?capture_probe=1$/u);
    await run(parseCli(['status', '--token', 't']));
    expect(String(fetchSpy.mock.calls[1][0])).toMatch(/\/v2\/status$/u);
  });
});

describe('exit status follows the agent error body', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['invalid_argument', 400, 'not_started', 2],
    ['request_too_large', 413, 'not_started', 2],
    ['invalid_scenario', 400, 'not_started', 2],
    ['session_disconnected', 400, 'not_started', 3],
    ['plugin_build_mismatch', 426, 'not_started', 3],
    ['target_role_not_present', 400, 'not_started', 3],
    ['workflow_capacity', 503, 'not_started', 3],
    ['request_disconnected', 503, 'not_started', 3],
    ['request_timeout', 503, 'not_started', 3],
    ['request_timeout', 504, 'unknown', 4],
    ['multiple_sessions', 400, 'not_started', 2],
    ['evaluation_failed', 422, 'failed', 1],
    ['job_not_found', 404, 'not_started', 1],
    ['studio_not_connected', 400, 'unknown', 4],
    ['command_failed', 500, 'unknown', 4],
  ])('%s (HTTP %i, execution %s) exits %i', async (code, status, execution, exit) => {
    const body = { error: { code, message: 'daemon said no', execution, retry: execution === 'unknown' ? 'never' : 'after_fix' } };
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(body, status));
    const result = await run(parseCli(['eval', 'return 1', '--token', 't']));
    expect(result.code).toBe(exit);
    expect(result.response).toEqual(body);
  });

  test('an error carried in a successful response still sets the exit status', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply({ error: {
      code: 'session_required', message: 'open first', execution: 'not_started', retry: 'after_fix',
    } }));
    expect((await run(parseCli(['screenshot', '--token', 't']))).code).toBe(3);
  });

  test('status --request-id for an unknown id is an unknown outcome', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply({ error: {
      code: 'unknown_request', message: 'no such request', execution: 'unknown', retry: 'never',
    } }, 404));
    const result = await run(parseCli(['status', '--request-id', 'gone', '--token', 't']));
    expect(result.code).toBe(4);
    expect(result.response).toMatchObject({ error: { code: 'unknown_request' } });
  });
});

describe('logs --follow', () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output.push(String(chunk)); return true; });
  });
  afterEach(() => jest.restoreAllMocks());

  test('a scope change replaces the cursor kind instead of sending both', async () => {
    const batches = [
      { scope: 'instance', instance_id: 'a', entries: [{ message: 'one' }], next_cursor: 'c1' },
      { scope: 'group', instances: [{ instance_id: 'a', entries: [{ message: 'two' }] }], next_cursor_by_instance: { a: 'g1' } },
      { scope: 'instance', instance_id: 'a', entries: [{ message: 'server READY' }], next_cursor: 'c2' },
    ];
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply(batches.shift()));
    const result = await run(parseCli(['logs', '--follow', '--cursor', 'c0', '--until', 'READY$', '--token', 't']));
    const bodies = fetchSpy.mock.calls.map(([, init]) => sentBody(init));
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ cursor: 'c0' });
    expect(bodies[1]).toMatchObject({ cursor: 'c1' });
    expect(bodies[2]).toMatchObject({ cursor_by_instance: { a: 'g1' } });
    expect(bodies[0]).not.toHaveProperty('cursor_by_instance');
    expect(bodies[1]).not.toHaveProperty('cursor_by_instance');
    expect(bodies[2]).not.toHaveProperty('cursor');
    expect(result).toEqual({ code: 0, response: { done: true, reason: 'until', next_cursor: 'c2' } });
    expect(output).toHaveLength(3);
  });

  test.each([
    [[], 0],
    [['--until', 'never matches'], 1],
  ])('--duration ends with a done line carrying the cursor (%p exits %i)', async (extra, exit) => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      now += 2_000; // Each poll outlasts the whole one-second follow.
      return reply({ scope: 'group', instances: [{ instance_id: 'a', entries: [{ message: 'tick' }] }], next_cursor_by_instance: { a: 'g9' } });
    });
    const result = await run(parseCli(['logs', '--follow', '--duration', '1', ...extra, '--token', 't']));
    expect(result).toEqual({ code: exit, response: { done: true, reason: 'duration', next_cursor_by_instance: { a: 'g9' } } });
  });

  test('SIGINT ends the follow with a done line and exit 130', async () => {
    const existing = new Set(process.listeners('SIGINT'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      for (const listener of process.listeners('SIGINT')) if (!existing.has(listener)) listener('SIGINT');
      return reply({ scope: 'instance', instance_id: 'a', entries: [], next_cursor: 'c5' });
    });
    const result = await run(parseCli(['logs', '--follow', '--token', 't']));
    expect(result).toEqual({ code: 130, response: { done: true, reason: 'interrupted', next_cursor: 'c5' } });
    expect(process.listeners('SIGINT').filter((listener) => !existing.has(listener))).toHaveLength(0);
  });
});

describe('uncertain HTTP delivery', () => {
  afterEach(()=>jest.restoreAllMocks());
  test('a dropped transport after dispatch retains the original ID and forbids replay', async () => {
    let mutations=0;
    let requestId: unknown;
    jest.spyOn(globalThis,'fetch').mockImplementation(async (_url,init)=>{
      requestId=(init!.headers as Record<string,string>)[REQUEST_ID_HEADER]; mutations++;
      throw new TypeError('fetch failed after dispatch');
    });
    const result=await run(parseCli(['eval','return true','--token','test-token']));
    expect(result.code).toBe(4);
    expect(result.response).toMatchObject({error:{execution:'unknown',retry:'never',request_id:requestId}});
    expect(mutations).toBe(1);
  });
  test('a response body disconnect does not lose the operation ID', async () => {
    let requestId:unknown;
    jest.spyOn(globalThis,'fetch').mockImplementation(async (_url,init)=>{
      requestId=(init!.headers as Record<string,string>)[REQUEST_ID_HEADER];
      const response=new Response('{}',{status:200,headers:{[AGENT_PROTOCOL_HEADER]:String(AGENT_PROTOCOL_VERSION)}});
      jest.spyOn(response,'text').mockRejectedValue(new Error('body disconnected'));
      return response;
    });
    const result=await run(parseCli(['eval','return true','--token','test-token']));
    expect(result.code).toBe(4);
    expect(result.response).toMatchObject({error:{execution:'unknown',request_id:requestId}});
  });
  test('failed final result retrieval retains the job ID rather than the read request ID', async () => {
    const header={ [AGENT_PROTOCOL_HEADER]:'2' };
    const fetchSpy=jest.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({job_id:'original-job',state:'queued'}),{status:202,headers:header}))
      .mockResolvedValueOnce(new Response(JSON.stringify({job_id:'original-job',state:'completed'}),{status:200,headers:header}))
      .mockRejectedValueOnce(new Error('result response lost'));
    const result=await run(parseCli(['test','play','--keep-open','--token','test-token']));
    expect(result.code).toBe(4);
    expect(result.response).toMatchObject({error:{execution:'unknown',request_id:'original-job'}});
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
  test('a refused connection proves the command never left and points at daemon start', async () => {
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const { port } = listener.address() as AddressInfo;
    listener.close();
    await once(listener, 'close');
    const result = await run(parseCli(['eval', 'return true', '--token', 'test-token', '--port', String(port)]));
    expect(result.code).toBe(3);
    expect(result.response).toMatchObject({ error: {
      code: 'daemon_unavailable', execution: 'not_started', retry: 'after_fix', next: 'roblox daemon start',
    } });
  });

});
jest.mock('../capture-worker.js', () => ({ ensureCaptureWorker: jest.fn(async () => {}) }));

describe('explicit start/stop recording', () => {
  test('record-studio start is not capped by the fixed-duration ceiling while record is', () => {
    // `record --duration` documents a 600 s ceiling; the start/stop form exists
    // precisely so a workflow owns the length of its own video.
    usageError(['record', '--duration', '601', '--output', 'clip.mp4']);
    const started = parseCli(['record-studio', 'start', '--out', 'long.mp4', '--duration', '3600']);
    expect(started.command).toBe('record-studio');
    expect(started.subcommand).toBe('start');
    expect(started.options.durationMs).toBe(3_600_000);
    expect(parseCli(['record-studio', 'stop']).subcommand).toBe('stop');
  });

  test('record-studio rejects an unusable form before touching the machine', () => {
    usageError(['record-studio']);
    usageError(['record-studio', 'start']);
    usageError(['record-studio', 'start', '--out', 'clip.mov']);
    usageError(['record-studio', 'stop', '--out', 'clip.mp4']);
    usageError(['record-studio', 'stop', '--duration', '10']);
  });

  test('a record usage error inside the local command still exits 2', async () => {
    const result = await run(parseCli(['record', '--duration', '5']));
    expect(result.code).toBe(2);
    expect(result.response).toMatchObject({ error: { code: 'usage_error', execution: 'not_started' } });
  });
});

describe('scenario recording options', () => {
  test('--record is a test play option that must name an mp4', () => {
    const parsed = parseCli(['test', 'play', '--scenario', 'qa.json', '--record', 'evidence/gameplay.mp4']);
    expect(parsed.options.record).toBe('evidence/gameplay.mp4');
    usageError(['test', 'play', '--keep-open', '--record', 'clip.mov']);
    usageError(['screenshot', '--record', 'clip.mp4']);
  });

  test('test calibrate measures the visible play client without a --target', () => {
    const parsed = parseCli(['test', 'calibrate']);
    expect(parsed.subcommand).toBe('calibrate');
    usageError(['test', 'calibrate', '--target', 'edit']);
  });
});
