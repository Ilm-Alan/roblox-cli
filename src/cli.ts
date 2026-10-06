#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveAuthToken } from './auth.js';
import { CliCommandError } from './cli-errors.js';
import {
  assertMacOS,
  daemonStatus,
  daemonEntry,
  isConnectionRefused,
  packageJsonPath,
  setupRobloxCli,
  startDaemon,
  stopDaemon,
  verifyBuildArtifacts,
} from './daemon-control.js';
import {
  AGENT_COMMAND_PREFIX,
  AGENT_HEALTH_PATH,
  AGENT_PROTOCOL_HEADER,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUESTS_PREFIX,
  AGENT_SCHEMA_PATH,
  AGENT_STATUS_PATH,
  AVAILABILITY_ERROR_CODES,
  CLI_TEST_MODES,
  REQUEST_ID_HEADER,
  USAGE_ERROR_CODES,
  agentSchema,
} from './agent-protocol.js';
import {
  MAX_FIXED_RECORDING_SECONDS,
  recordNativeStudio,
  recordingStatus,
  startNativeRecording,
  stopNativeRecording,
  type RecordingCrop,
} from './native-recording.js';
import { artifactsDirectory, DEFAULT_PORT, dataDirectory } from './paths.js';
import { compileScenario } from './scenario.js';
import { ensureCaptureWorker } from './capture-worker.js';
import { renderSample } from './render-rate.js';

type JsonObject = Record<string, unknown>;

const FOREGROUND_NOTICE = '--foreground: Studio will be brought to the front for a full-rate capture; the previous app is restored afterwards unless you switch apps meanwhile.\n';

export interface CliOptions {
  port: number;
  timeoutMs: number;
  timeoutExplicit?: boolean;
  token?: string;
  out?: string;
  output?: string;
  instanceId?: string;
  target?: string;
  file?: string;
  stdin: boolean;
  code?: string;
  durationMs?: number;
  players?: number;
  mode?: string;
  scenario?: string;
  readinessAttribute?: string;
  record?: string;
  testArgs?: JsonObject;
  keepOpen: boolean;
  focus?: string;
  format?: string;
  quality?: number;
  cursor?: string;
  cursorByInstance?: JsonObject;
  tail?: number;
  filter?: string;
  until?: string;
  follow: boolean;
  scope?: string;
  revision?: number;
  requestId?: string;
  nativeCapture: boolean;
  captureProbe: boolean;
  readyTimeoutSeconds?: number;
  help: boolean;
  detach?: boolean;
  overwrite?: boolean;
  jobId?: string;
  foreground?: boolean;
  checks?: string;
  backend?: string;
  crop?: string;
}

export interface ParsedCli {
  command: string;
  subcommand?: string;
  positional: string[];
  options: CliOptions;
}

interface RequestFailure extends Error {
  response?: unknown;
  outcome: 'unknown' | 'not_executed';
  status?: number;
  requestId?: string;
}

const COMMANDS = new Set([
  'open', 'eval', 'logs', 'screenshot', 'test', 'close', 'status', 'doctor',
  'setup', 'daemon', 'version', 'schema', 'help', 'record', 'record-studio',
]);

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
/** Options whose value is arbitrary text, so a value starting with '-' is still the value. */
const FREE_TEXT_OPTIONS: readonly string[] = ['--code', '--filter', '--until', '--cursor', '--token', '--request-id'];
/** Eval and test run send an execution deadline; the HTTP wait covers it plus this margin. */
const EXECUTION_RESPONSE_MARGIN_MS = 15_000;

export class CliUsageError extends Error {
  constructor(message: string, readonly code = 'usage_error') {
    super(message);
    this.name = 'CliUsageError';
  }
}

function invalid(message: string, code?: string): CliUsageError {
  return new CliUsageError(message, code);
}

function cliError(
  code: string,
  message: string,
  options: {
    execution?: 'not_started' | 'unknown' | 'failed';
    retry?: 'after_fix' | 'never';
    request_id?: string;
    next?: string;
    details?: JsonObject;
  } = {},
): { error: JsonObject } {
  return {
    error: {
      code,
      message,
      ...options,
    },
  };
}

function optionValue(argv: string[], index: number, name: string): [string, number] {
  const token = argv[index];
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) return [token.slice(prefix.length), index];
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith('-') && value !== '-' && !FREE_TEXT_OPTIONS.includes(name))) throw invalid(`${name} requires a value`);
  return [value, index + 1];
}

function positiveNumber(raw: string, name: string, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw invalid(`${name} must be a positive${integer ? ' integer' : ''}`);
  }
  return value;
}

function boundedNumber(raw: string, name: string, min: number, max: number, integer = false): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw invalid(`${name} must be between ${min} and ${max}${integer ? ' and an integer' : ''}`);
  }
  return value;
}

function jsonObject(raw: string, name: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid(`${name} must be a JSON object`);
  return parsed as JsonObject;
}

function defaultOptions(): CliOptions {
  const configuredPort = process.env.ROBLOX_CLI_PORT?.trim();
  const port = configuredPort === undefined
    ? DEFAULT_PORT
    : boundedNumber(configuredPort, 'ROBLOX_CLI_PORT', 1, 65535, true);
  return { port, timeoutMs: 45_000, stdin: false, keepOpen: false, follow: false, nativeCapture: false, captureProbe: false, help: false };
}

export function parseCli(argv: string[]): ParsedCli {
  if (argv.length === 0) return { command: 'help', positional: [], options: defaultOptions() };
  const command = argv[0] === '-h' || argv[0] === '--help' ? 'help' : argv[0];
  if (!COMMANDS.has(command)) throw invalid(`unknown command "${command}"`);

  const options = defaultOptions();
  const positional: string[] = [];
  let index = 1;
  let subcommand: string | undefined;
  if ((command === 'test' || command === 'daemon' || command === 'open' || command === 'record-studio') && argv[index] && !argv[index].startsWith('-') &&
    (command !== 'open' || argv[index] === 'status' || argv[index] === 'close')) {
    subcommand = argv[index++];
  }
  if (command === 'test' && subcommand !== undefined && !(CLI_TEST_MODES as readonly string[]).includes(subcommand)) {
    throw invalid(`unknown test mode "${subcommand}"; use one of ${CLI_TEST_MODES.join(', ')}`);
  }
  const codeCommand = command === 'eval' || (command === 'test' && subcommand === 'run');
  let positionalOnly = false;
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (positionalOnly) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--stdin') {
      options.stdin = true;
      continue;
    }
    if (token === '--follow') {
      options.follow = true;
      continue;
    }
    if (token === '--keep-open') {
      options.keepOpen = true;
      continue;
    }
    if (token === '--detach') { options.detach = true; continue; }
    if (token === '--overwrite') { options.overwrite = true; continue; }
    if (token === '--foreground') { options.foreground = true; continue; }
    if (token === '--native') {
      options.nativeCapture = true;
      continue;
    }
    if (token === '--capture-probe') {
      options.captureProbe = true;
      continue;
    }
    if (token === '-') {
      positional.push(token);
      continue;
    }

    const stringOptions: Array<[string, keyof CliOptions]> = [
      ['--token', 'token'], ['--out', 'out'], ['--output', 'output'],
      ['--instance-id', 'instanceId'], ['--target', 'target'], ['--file', 'file'],
      ['--code', 'code'], ['--mode', 'mode'], ['--scenario', 'scenario'],
      ['--focus', 'focus'], ['--format', 'format'], ['--cursor', 'cursor'],
      ['--filter', 'filter'], ['--until', 'until'], ['--scope', 'scope'], ['--request-id', 'requestId'],
      ['--readiness-attribute', 'readinessAttribute'], ['--record', 'record'],
      ['--job', 'jobId'], ['--checks', 'checks'], ['--backend', 'backend'], ['--crop', 'crop'],
    ];
    const stringOption = stringOptions.find(([name]) => token === name || token.startsWith(`${name}=`));
    if (stringOption) {
      const [raw, next] = optionValue(argv, index, stringOption[0]);
      if (!raw) throw invalid(`${stringOption[0]} must not be empty`);
      (options[stringOption[1]] as string | undefined) = raw;
      index = next;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const [raw, next] = optionValue(argv, index, '--port');
      options.port = boundedNumber(raw, '--port', 1, 65535, true);
      index = next;
      continue;
    }
    if (token === '--timeout' || token.startsWith('--timeout=')) {
      const [raw, next] = optionValue(argv, index, '--timeout');
      options.timeoutMs = Math.round(positiveNumber(raw, '--timeout') * 1000);
      options.timeoutExplicit = true;
      index = next;
      continue;
    }
    if (token === '--duration' || token.startsWith('--duration=')) {
      const [raw, next] = optionValue(argv, index, '--duration');
      const maximumSeconds = command === 'record' ? MAX_FIXED_RECORDING_SECONDS : 86_400;
      options.durationMs = boundedNumber(raw, '--duration', 0, maximumSeconds, false) * 1000;
      if (command === 'record' && options.durationMs <= 0) throw invalid('--duration must be positive for record');
      index = next;
      continue;
    }
    if (token === '--players' || token.startsWith('--players=')) {
      const [raw, next] = optionValue(argv, index, '--players');
      options.players = boundedNumber(raw, '--players', 1, 8, true);
      index = next;
      continue;
    }
    if (token === '--ready-timeout' || token.startsWith('--ready-timeout=')) {
      const [raw, next] = optionValue(argv, index, '--ready-timeout');
      options.readyTimeoutSeconds = boundedNumber(raw, '--ready-timeout', 1, 300, true);
      index = next;
      continue;
    }
    if (token === '--quality' || token.startsWith('--quality=')) {
      const [raw, next] = optionValue(argv, index, '--quality');
      options.quality = boundedNumber(raw, '--quality', 1, 100, true);
      index = next;
      continue;
    }
    if (token === '--tail' || token.startsWith('--tail=')) {
      const [raw, next] = optionValue(argv, index, '--tail');
      options.tail = boundedNumber(raw, '--tail', 0, 10_000, true);
      index = next;
      continue;
    }
    if (token === '--revision' || token.startsWith('--revision=')) {
      const [raw, next] = optionValue(argv, index, '--revision');
      options.revision = positiveNumber(raw, '--revision', true);
      index = next;
      continue;
    }
    if (token === '--cursor-by-instance' || token.startsWith('--cursor-by-instance=')) {
      const [raw, next] = optionValue(argv, index, '--cursor-by-instance');
      options.cursorByInstance = jsonObject(raw, '--cursor-by-instance');
      index = next;
      continue;
    }
    if (token === '--test-args' || token.startsWith('--test-args=')) {
      const [raw, next] = optionValue(argv, index, '--test-args');
      options.testArgs = jsonObject(raw, '--test-args');
      index = next;
      continue;
    }
    if (token.startsWith('-')) {
      throw invalid(codeCommand
        ? `unknown option: ${token}; to pass code that starts with "-", use --code=CODE or put it after --: roblox ${command === 'eval' ? 'eval' : 'test run'} -- CODE`
        : `unknown option: ${token}`);
    }
    positional.push(token);
  }

  if (options.file && options.stdin) throw invalid('use only one of --file and --stdin');
  if (options.code && (options.file || options.stdin)) throw invalid('use only one of positional code, --code, --file, and --stdin');
  if (positional.length > 0 && (options.file || options.stdin || options.code)) {
    throw invalid('use only one of positional code, --code, --file, and --stdin');
  }
  if (options.stdin && !codeCommand) throw invalid('--stdin is only valid for eval or test run');
  if (options.code !== undefined && !codeCommand) throw invalid('--code is only valid for eval or test run');
  if (options.file !== undefined && command !== 'open' && !codeCommand) {
    throw invalid('--file is only valid for open, eval, or test run');
  }
  if (command === 'test' && subcommand === 'calibrate' && options.target !== undefined) {
    throw invalid('test calibrate always measures the visible play client; --target is not accepted');
  }
  if (options.target !== undefined && !(codeCommand || command === 'screenshot' || (command === 'test' && subcommand === 'diagnose'))) {
    throw invalid('--target is only valid for eval, screenshot, or test run');
  }
  const testPlay = command === 'test' && subcommand === 'play';
  for (const [value, name] of [
    [options.durationMs, '--duration'], [options.players, '--players'],
    [options.mode, '--mode'], [options.scenario, '--scenario'],
    [options.testArgs, '--test-args'],
  ] as const) {
    if (value !== undefined && !testPlay
      && !(name === '--duration' && (command === 'record' || (command === 'record-studio' && subcommand === 'start') || (command === 'logs' && options.follow)))
      && !(command === 'test' && ((subcommand === 'validate' && name === '--scenario') || (subcommand === 'diagnose' && name === '--duration')))) throw invalid(`${name} is only valid for test play`);
  }
  if (options.until !== undefined) {
    if (!(command === 'logs' && options.follow)) throw invalid('--until is only valid for logs --follow');
    try { new RegExp(options.until); }
    catch (error) { throw invalid(`--until is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (options.readyTimeoutSeconds !== undefined && !testPlay) throw invalid('--ready-timeout is only valid for test play');
  if (codeCommand && options.timeoutExplicit && (options.timeoutMs < 1000 || options.timeoutMs > 3_600_000)) {
    throw invalid('--timeout must be between 1 and 3600 seconds for eval and test run');
  }
  if (options.readinessAttribute !== undefined && command !== 'test') {
    throw invalid('--readiness-attribute is only valid for test status or test play');
  }
  if (options.readinessAttribute !== undefined && command === 'test' && subcommand !== 'play' && subcommand !== 'status' && subcommand !== 'diagnose') {
    throw invalid('--readiness-attribute is only valid for test status or test play');
  }
  if (options.keepOpen && !testPlay) throw invalid('--keep-open is only valid for test play');
  if (options.record !== undefined && !testPlay) throw invalid('--record is only valid for test play');
  if (options.record !== undefined && !options.record.endsWith('.mp4')) throw invalid('--record must name a .mp4 file');
  if (options.overwrite && (!testPlay || options.record === undefined)) throw invalid('--overwrite requires test play --record FILE.mp4');
  for (const [value, name] of [
    [options.focus, '--focus'], [options.format, '--format'], [options.quality, '--quality'],
    [options.output, '--output'],
  ] as const) {
    if (value !== undefined && command !== 'screenshot' && !(command === 'record' && name === '--output')) throw invalid(`${name} is only valid for screenshot`);
  }
  for (const [value, name] of [
    [options.cursor, '--cursor'], [options.cursorByInstance, '--cursor-by-instance'],
    [options.tail, '--tail'], [options.filter, '--filter'], [options.scope, '--scope'],
  ] as const) {
    if (value !== undefined && command !== 'logs') throw invalid(`${name} is only valid for logs`);
  }
  if (options.instanceId !== undefined && !['open', 'eval', 'logs', 'screenshot', 'test', 'close'].includes(command)) {
    throw invalid('--instance-id is only valid for open, eval, logs, screenshot, test, or close');
  }
  if (options.out !== undefined && !['open', 'eval', 'logs', 'screenshot', 'test', 'close', 'record-studio'].includes(command)) {
    throw invalid('--out is only valid for a workflow command');
  }
  if (options.follow && options.out !== undefined && command !== 'test') throw invalid('--out cannot be used with --follow');
  if (options.cursor !== undefined && options.cursorByInstance !== undefined) {
    throw invalid('use only one of --cursor and --cursor-by-instance');
  }
  if (['logs', 'screenshot', 'close', 'status', 'doctor', 'setup', 'version', 'schema', 'help', 'record'].includes(command) && positional.length > 0) {
    throw invalid(`${command} does not accept positional arguments`);
  }
  if (command === 'record-studio' && !['start', 'stop'].includes(subcommand ?? '')) {
    throw invalid('record-studio requires start or stop');
  }
  if (command === 'record-studio' && subcommand === 'start') {
    const file = options.out ?? options.output;
    if (!file) throw invalid('record-studio start requires --out FILE.mp4');
    if (!file.endsWith('.mp4')) throw invalid('record-studio start --out must name a .mp4 file');
    if (options.output !== undefined && options.out !== undefined) throw invalid('use only one of --out and --output');
  }
  if (command === 'record-studio' && subcommand === 'stop' && (positional.length > 0 || options.out !== undefined)) {
    throw invalid('record-studio stop accepts no positional arguments or --out');
  }
  if (command === 'daemon' && positional.length > 0) throw invalid('daemon does not accept positional arguments');
  if (command === 'test' && subcommand !== 'run' && positional.length > 0) {
    throw invalid(`test ${subcommand ?? ''} does not accept positional arguments`.trim());
  }
  if (options.output !== undefined && command !== 'screenshot' && command !== 'record') throw invalid('--output is only valid for screenshot or record');
  if (options.follow && command !== 'logs' && !(command === 'test' && ['job', 'play', 'resume'].includes(subcommand ?? ''))) throw invalid('--follow is only valid for logs');
  if (options.nativeCapture && command !== 'screenshot') throw invalid('--native is only valid for screenshot');
  if (options.requestId !== undefined) {
    if (!REQUEST_ID_PATTERN.test(options.requestId)) {
      throw invalid('--request-id must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-"', 'invalid_request_id');
    }
    if (!['open', 'eval', 'logs', 'screenshot', 'test', 'close', 'status'].includes(command) || (command === 'test' && ['validate', 'job'].includes(subcommand ?? ''))) {
      throw invalid('--request-id is only valid for status and commands sent to the daemon');
    }
    if (command === 'logs' && options.follow) throw invalid('--request-id cannot be used with logs --follow, which sends many requests');
  }
  if (options.captureProbe && (command !== 'status' || options.requestId !== undefined)) {
    throw invalid('--capture-probe is only valid for status without --request-id');
  }
  if (options.revision !== undefined && command !== 'open') throw invalid('--revision is only valid for open');
  if (options.detach && !(command === 'test' && ['play', 'resume'].includes(subcommand ?? ''))) throw invalid('--detach requires test play or resume');
  if (options.jobId && !(command === 'test' && ['job', 'cancel', 'resume'].includes(subcommand ?? ''))) throw invalid('--job requires test job, cancel or resume');
  if (options.foreground && !(command === 'record' || (command === 'test' && ['play', 'resume'].includes(subcommand ?? '')))) throw invalid('--foreground is only valid for test play, test resume or record');
  if (options.checks && !(command === 'test' && subcommand === 'diagnose')) throw invalid('--checks requires test diagnose');
  if (options.crop && options.crop !== 'viewport') throw invalid('--crop must be viewport');
  if (options.crop && command !== 'screenshot' && !(command === 'record-studio' && subcommand === 'start')) {
    throw invalid('--crop viewport requires screenshot or record-studio start');
  }
  if (options.backend && (command !== 'screenshot' || !['auto', 'engine', 'native'].includes(options.backend))) throw invalid('--backend requires screenshot and auto, engine or native');
  return { command, subcommand, positional, options };
}

function failure(error: unknown, response?: unknown, status?: number, outcome?: RequestFailure['outcome']): RequestFailure {
  const result = error instanceof Error ? error : new Error(String(error));
  const requestFailure = result as RequestFailure;
  requestFailure.outcome = outcome ?? requestFailure.outcome ?? 'unknown';
  if (response !== undefined) requestFailure.response = response;
  if (status !== undefined) requestFailure.status = status;
  return requestFailure;
}

async function requestJson(
  path: string,
  options: CliOptions,
  body?: JsonObject,
  requestId: string = randomUUID(),
  /** Stops waiting for the reply (the request may already have been delivered). */
  abandon?: AbortSignal,
): Promise<{ response: unknown; requestId: string }> {
  let token = options.token;
  let tokenProblem = 'the token is empty';
  if (token === undefined) {
    try { token = resolveAuthToken().token; }
    catch (error) { tokenProblem = error instanceof Error ? error.message : String(error); }
  }
  if (!token) {
    const message = `roblox-cli authentication token is unavailable: ${tokenProblem}`;
    throw failure(new Error(message), cliError('auth_unavailable', message, {
      execution: 'not_started', retry: 'after_fix',
    }), 401, 'not_executed');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${options.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined
          ? { 'X-Studio-Auth': token, [AGENT_PROTOCOL_HEADER]: String(AGENT_PROTOCOL_VERSION), [REQUEST_ID_HEADER]: requestId }
          : {
            'Content-Type': 'application/json',
            'X-Studio-Auth': token,
            [AGENT_PROTOCOL_HEADER]: String(AGENT_PROTOCOL_VERSION),
            [REQUEST_ID_HEADER]: requestId,
          },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: abandon === undefined ? controller.signal : AbortSignal.any([controller.signal, abandon]),
      });
    } catch (error) {
      if (isConnectionRefused(error)) {
        const message = `roblox-cli daemon is not running on port ${options.port}.`;
        throw failure(new Error(message), cliError('daemon_unavailable', message, {
          execution: 'not_started', retry: 'after_fix', next: 'roblox daemon start',
        }), undefined, 'not_executed');
      }
      const message = abandon?.aborted
        ? 'stopped waiting for the reply; outcome unknown'
        : error instanceof Error && error.name === 'AbortError'
          ? `request exceeded ${options.timeoutMs / 1000}s; outcome unknown`
          : `roblox-cli transport failed; outcome unknown: ${error instanceof Error ? error.message : String(error)}`;
      const requestError = failure(new Error(message), undefined, undefined, 'unknown');
      requestError.requestId = requestId;
      throw requestError;
    }
    let text: string;
    try { text = await response.text(); }
    catch (error) {
      const lost = failure(new Error(`response delivery failed; outcome unknown: ${String(error)}`), undefined, undefined, 'unknown');
      lost.requestId = requestId;
      throw lost;
    }
    let parsed: unknown = text;
    try { parsed = text === '' ? null : JSON.parse(text); } catch { /* preserve diagnostics */ }
    const responseRequestId = response.headers.get(REQUEST_ID_HEADER) ?? requestId;
    const advertisedProtocol = response.headers.get(AGENT_PROTOCOL_HEADER);
    const pathname = path.split('?', 1)[0];
    const isAgentEndpoint = pathname === AGENT_HEALTH_PATH || pathname === AGENT_STATUS_PATH
      || pathname === '/health' || pathname === '/status' || pathname === '/request-status'
      || pathname.startsWith(AGENT_COMMAND_PREFIX)
      || pathname === AGENT_SCHEMA_PATH
      || pathname.startsWith(`${AGENT_REQUESTS_PREFIX}/`);
    if (isAgentEndpoint && advertisedProtocol !== String(AGENT_PROTOCOL_VERSION)) {
      const protocolError = failure(
        new Error(`daemon does not speak Agent Protocol v${AGENT_PROTOCOL_VERSION}`),
        undefined,
        426,
        'not_executed',
      );
      protocolError.requestId = responseRequestId;
      throw protocolError;
    }
    if (!response.ok) {
      const requestError = failure(
        new Error(`HTTP ${response.status}`),
        parsed,
        response.status,
        response.status >= 500 && response.status !== 503 ? 'unknown' : 'not_executed',
      );
      requestError.requestId = responseRequestId;
      throw requestError;
    }
    return { response: parsed, requestId: responseRequestId };
  } finally {
    clearTimeout(timer);
  }
}

function readCode(parsed: ParsedCli): { code: string; source: 'argument' | 'file' | 'stdin' } {
  const { options, positional } = parsed;
  if (options.code !== undefined) return { code: options.code, source: 'argument' };
  if (options.file !== undefined) {
    try { return { code: readFileSync(resolve(options.file), 'utf8'), source: 'file' }; }
    catch (error) { throw invalid(`cannot read --file ${options.file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (options.stdin || (positional.length === 1 && positional[0] === '-')) {
    try { return { code: readFileSync(0, 'utf8'), source: 'stdin' }; }
    catch (error) { throw invalid(`cannot read stdin: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (positional.length !== 1) throw invalid('eval/test run requires exactly one of CODE, --code CODE, --file PATH, or --stdin (or - for stdin)');
  return { code: positional[0], source: 'argument' };
}

function buildOpenBody(parsed: ParsedCli): JsonObject {
  const { options, positional } = parsed;
  if (parsed.subcommand === 'status') return { action: 'status' };
  if (parsed.subcommand === 'close') return { action: 'close' };
  if (positional.length > 1) throw invalid('open accepts at most one target');
  const target = options.file ?? positional[0];
  if (options.instanceId !== undefined && target !== undefined) {
    throw invalid('--instance-id selects an existing Studio for attach; do not combine it with a launch target');
  }
  const body: JsonObject = { action: 'open', instance_id: options.instanceId };
  if (!target) body.source = 'attach';
  else if (target === 'baseplate') body.source = 'baseplate';
  else if (/^\d+$/u.test(target)) {
    body.source = options.revision === undefined ? 'place' : 'revision';
    body.place_id = Number(target);
  } else {
    if (options.revision !== undefined) throw invalid('open revision syntax is: roblox open PLACE_ID --revision VERSION');
    body.source = 'file';
    body.path = resolve(target);
  }
  if (options.revision !== undefined) body.revision = options.revision;
  if (options.timeoutMs !== 45_000) body.timeout_ms = options.timeoutMs;
  return body;
}

function commandBody(parsed: ParsedCli): JsonObject {
  const { command, options } = parsed;
  if (command === 'open') return buildOpenBody(parsed);
  if (command === 'eval') {
    const code = readCode(parsed);
    return {
      code: code.code, source: code.source, target: options.target, instance_id: options.instanceId,
      timeout_ms: options.timeoutExplicit ? options.timeoutMs : undefined,
    };
  }
  if (command === 'logs') {
    return {
      instance_id: options.instanceId, tail: options.tail, cursor: options.cursor,
      cursor_by_instance: options.cursorByInstance, filter: options.filter, scope: options.scope,
    };
  }
  if (command === 'screenshot') {
    return {
      instance_id: options.instanceId, target: options.target, focus: options.focus,
      format: options.format, quality: options.quality, backend: options.nativeCapture ? 'native' : options.backend, crop: options.crop,
    };
  }
  if (command === 'close') return { action: 'close', instance_id: options.instanceId };
  if (command === 'test') {
    if (!parsed.subcommand) return {};
    if (parsed.subcommand === 'run') {
      const code = readCode(parsed);
      return {
        action: 'run', code: code.code, source: code.source, target: options.target, instance_id: options.instanceId,
        timeout_ms: options.timeoutExplicit ? options.timeoutMs : undefined,
      };
    }
    if (parsed.subcommand === 'play' || parsed.subcommand === 'validate') {
      let scenario: unknown;
      if (options.scenario) {
        try { scenario = JSON.parse(readFileSync(resolve(options.scenario), 'utf8')); }
        catch (error) { throw invalid(`cannot read --scenario ${options.scenario}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (scenario !== undefined) compileScenario(scenario);
      if (parsed.subcommand === 'validate') return { action: 'validate', scenario };
      return {
        action: 'play', detach: options.detach === true, foreground: options.foreground, mode: options.mode, players: options.players, duration_ms: options.durationMs,
        scenario, test_args: options.testArgs, keep_open: options.keepOpen,
        readiness_attribute: options.readinessAttribute, instance_id: options.instanceId,
        timeout: options.readyTimeoutSeconds,
        record: options.record === undefined ? undefined : resolve(options.record),
        overwrite: options.overwrite,
      };
    }
    if (['job', 'cancel', 'resume'].includes(parsed.subcommand)) {
      if (!options.jobId) throw invalid('--job ID is required');
      return { action: parsed.subcommand === 'job' ? 'result' : parsed.subcommand, job_id: options.jobId, foreground: options.foreground, detach: parsed.subcommand === 'resume' ? options.detach === true : undefined };
    }
    if (parsed.subcommand === 'diagnose') return { action: 'diagnose', target: options.target ?? 'client-1', checks: options.checks?.split(','), duration_ms: options.durationMs, readiness_attribute: options.readinessAttribute };
    if (parsed.subcommand === 'calibrate') return { action: 'calibrate', instance_id: options.instanceId };
    return {
      action: parsed.subcommand,
      ...(parsed.subcommand === 'status' && options.readinessAttribute !== undefined
        ? { readiness_attribute: options.readinessAttribute } : {}),
      instance_id: options.instanceId,
    };
  }
  return {};
}

function responseOk(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const body = value as JsonObject;
  return body.ok !== false && body.success !== false && body.passed !== false
    && body.stopped !== false && body.error === undefined;
}

function hasLogActivity(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as JsonObject;
  if (Array.isArray(body.entries)) return body.entries.length > 0 || (Array.isArray(body.peer_errors) && body.peer_errors.length > 0);
  if (body.error !== undefined) return true;
  return Array.isArray(body.instances) && body.instances.some((instance) => {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) return false;
    const instanceBody = instance as JsonObject;
    const entries = instanceBody.entries;
    return (Array.isArray(entries) && entries.length > 0)
      || instanceBody.error !== undefined
      || (Array.isArray(instanceBody.peer_errors) && instanceBody.peer_errors.length > 0);
  });
}

function isAgentError(value: unknown): value is { error: JsonObject } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as JsonObject;
  const error = body.error;
  return Boolean(error && typeof error === 'object' && !Array.isArray(error)
    && typeof (error as JsonObject).code === 'string'
    && typeof (error as JsonObject).message === 'string');
}

/** Exit status of an agent error body, whether the daemon or the CLI produced it. */
export function exitCodeForError(error: JsonObject): number {
  if (error.execution === 'unknown') return 4;
  const code = String(error.code);
  if ((USAGE_ERROR_CODES as readonly string[]).includes(code)) return 2;
  if ((AVAILABILITY_ERROR_CODES as readonly string[]).includes(code)) return 3;
  return 1;
}

function responseExitCode(response: unknown): number {
  if (isAgentError(response)) return exitCodeForError(response.error);
  return responseOk(response) ? 0 : 1;
}

function cloneAndExtractArtifacts(value: unknown, root: string, directOutput?: string): { value: unknown; files: Array<{ file: string; sha256: string }> } {
  const files: Array<{ file: string; sha256: string }> = [];
  let imageNumber = 0;
  const writeImageArtifact = (data: string, mimeType: string): JsonObject => {
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/jpeg' ? 'jpg' : undefined;
    if (!extension) throw invalid(`unsupported image MIME type: ${mimeType}`);
    const bytes = Buffer.from(data, 'base64');
    const file = directOutput && imageNumber === 0 ? resolve(directOutput) : resolve(root, `image-${imageNumber}.${extension}`);
    if (existsSync(file)) throw invalid(`artifact already exists: ${file}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    files.push({ file, sha256 });
    imageNumber += 1;
    return { file, mime_type: mimeType, bytes: bytes.length, sha256 };
  };
  const clone = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map((entry) => clone(entry));
    if (!item || typeof item !== 'object') return item;
    const object = item as JsonObject;
    if (object.type === 'image' && typeof object.data === 'string' && typeof object.mimeType === 'string') {
      return writeImageArtifact(object.data, object.mimeType);
    }
    const result = Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, clone(entry)]));
    const image = result.image;
    if (image && typeof image === 'object' && !Array.isArray(image)) {
      const artifact = image as JsonObject;
      if (typeof artifact.data === 'string' && typeof (artifact.mime_type ?? artifact.mimeType) === 'string') {
        const written = writeImageArtifact(artifact.data, String(artifact.mime_type ?? artifact.mimeType));
        delete result.image;
        Object.assign(result, written);
      } else if (typeof artifact.file === 'string' && typeof artifact.sha256 === 'string') {
        delete result.image;
        result.file = artifact.file;
        result.mime_type = artifact.mime_type;
        result.bytes = artifact.bytes;
        result.sha256 = artifact.sha256;
      }
    }
    return result;
  };
  return { value: clone(value), files };
}

function containsInlineArtifact(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsInlineArtifact(entry));
  if (!value || typeof value !== 'object') return false;
  const object = value as JsonObject;
  if (object.type === 'image' && typeof object.data === 'string') return true;
  const image = object.image;
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    const imageObject = image as JsonObject;
    if (typeof imageObject.data === 'string') return true;
  }
  return Object.values(object).some((entry) => containsInlineArtifact(entry));
}

function shouldAutomaticallyRetainPlaytestEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as JsonObject;
  return body.mode === 'play' && (body.passed === false || body.suspicious === true);
}

function retain(outDir: string, request: JsonObject, response: unknown, directOutput?: string): unknown {
  if (existsSync(outDir)) throw invalid(`--out already exists: ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  const extracted = cloneAndExtractArtifacts(response, outDir, directOutput);
  const retainedFiles = [...extracted.files];
  const extractedObject = extracted.value && typeof extracted.value === 'object' && !Array.isArray(extracted.value)
    ? extracted.value as JsonObject
    : undefined;
  const evidence = extractedObject?.evidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const evidenceText = `${JSON.stringify(evidence)}\n`;
    const evidenceFile = resolve(outDir, 'evidence.json');
    writeFileSync(evidenceFile, evidenceText);
    retainedFiles.push({
      file: evidenceFile,
      sha256: createHash('sha256').update(evidenceText).digest('hex'),
    });
  }
  const requestText = `${JSON.stringify(request)}\n`;
  const responseText = `${JSON.stringify(extracted.value)}\n`;
  writeFileSync(resolve(outDir, 'request.json'), requestText);
  writeFileSync(resolve(outDir, 'response.json'), responseText);
  writeFileSync(resolve(outDir, 'hashes.json'), `${JSON.stringify({
    request: { file: 'request.json', sha256: createHash('sha256').update(requestText).digest('hex') },
    response: { file: 'response.json', sha256: createHash('sha256').update(responseText).digest('hex') },
    artifacts: retainedFiles,
  })}\n`);
  return extracted.value;
}

function artifactDirectory(command: string, requestId: string): string {
  return resolve(artifactsDirectory(), `${new Date().toISOString().replaceAll(':', '-')}-${command}-${requestId}`);
}

/** Exit status from the HTTP status alone, for failures whose body is not an agent error. */
function httpFailureExitCode(requestFailure: RequestFailure): number {
  if (requestFailure.status === 413) return 2;
  if (requestFailure.status === 400 || requestFailure.status === 409 || requestFailure.status === 422) return 1;
  if (requestFailure.status === 401 || requestFailure.status === 404 || requestFailure.status === 426 || requestFailure.status === 503) return 3;
  return requestFailure.outcome === 'not_executed' ? 3 : 4;
}

function requestFailureResult(error: unknown, fallbackRequestId: string = randomUUID()): { code: number; response: unknown } {
  const requestFailure = failure(error);
  if (isAgentError(requestFailure.response)) {
    return { code: exitCodeForError(requestFailure.response.error), response: requestFailure.response };
  }
  const requestId = requestFailure.requestId ?? fallbackRequestId;
  const protocolUnavailable = requestFailure.status === 404 || requestFailure.status === 426;
  const response = cliError(
    protocolUnavailable ? 'protocol_unavailable' : 'daemon_unavailable',
    protocolUnavailable
      ? 'The daemon does not expose Agent Protocol v2. Run "roblox daemon restart".'
      : requestFailure.message,
    requestFailure.outcome === 'unknown'
      ? { execution: 'unknown', retry: 'never', request_id: requestId, next: `roblox status --request-id ${requestId}` }
      : { execution: 'not_started', retry: 'after_fix' },
  );
  return { code: httpFailureExitCode(requestFailure), response };
}

/** Result for an error thrown by the CLI itself before or instead of a daemon request. */
function thrownErrorResult(error: unknown): { code: number; response: { error: JsonObject } } {
  const unknownOutcome = error instanceof CliCommandError && error.outcome === 'unknown';
  const response = cliError(
    error instanceof CliUsageError || error instanceof CliCommandError ? error.code : 'usage_error',
    error instanceof Error ? error.message : String(error),
    {
      execution: unknownOutcome ? 'unknown' : 'not_started',
      retry: unknownOutcome ? 'never' : 'after_fix',
      ...(error instanceof CliCommandError && error.details !== undefined ? { details: error.details } : {}),
    },
  );
  return { code: exitCodeForError(response.error), response };
}

/**
 * HTTP deadline of one command request. A playtest is never one long request:
 * it is admitted in one short call and followed by short status reads, so its
 * explicit `--timeout` bounds the whole followed run instead (see followJob).
 */
export function commandTimeoutMs(parsed: ParsedCli): number {
  if (parsed.options.timeoutExplicit) {
    // Eval and test run send --timeout as the Studio execution deadline, so
    // the HTTP wait must outlast it for the daemon to report the outcome.
    const codeCommand = parsed.command === 'eval' || (parsed.command === 'test' && parsed.subcommand === 'run');
    return codeCommand ? parsed.options.timeoutMs + EXECUTION_RESPONSE_MARGIN_MS : parsed.options.timeoutMs;
  }
  if (parsed.command === 'open') return 150_000;
  // The daemon answers a cancel once the job's teardown settles, or after 30 s.
  if (parsed.command === 'test' && parsed.subcommand === 'cancel') return CANCEL_REQUEST_MS;
  return parsed.options.timeoutMs;
}

async function remoteCommand(parsed: ParsedCli): Promise<{ code: number; response: unknown }> {
  const options = parsed.options;
  if (parsed.command === 'logs' && options.follow) return followLogs(parsed);
  // Reject known destination conflicts before Studio receives a mutation.
  // Retention still checks again, because another process can win the race.
  for (const [option, destination] of [['--out', options.out], ['--output', options.output]]) {
    if (destination && existsSync(resolve(destination))) {
      const response = cliError('artifact_failed', `${option} already exists: ${resolve(destination)}`, {
        execution: 'not_started', retry: 'after_fix',
      });
      return { code: exitCodeForError(response.error), response };
    }
  }
  // An existing video is refused before any job exists or play starts; the
  // daemon checks again at admission for callers that skip the CLI.
  if (options.record !== undefined && !options.overwrite && existsSync(resolve(options.record))) {
    const file = resolve(options.record);
    const response = cliError('output_exists', `--record already exists: ${file}. Choose another path, or pass --overwrite to replace it when the run passes.`, {
      execution: 'not_started', retry: 'after_fix', details: { file },
    });
    return { code: exitCodeForError(response.error), response };
  }
  if (parsed.command === 'open' && !options.timeoutExplicit) options.timeoutMs = 120_000;
  const request = commandBody(parsed);
  if (parsed.command === 'test' && parsed.subcommand === 'validate') {
    const compiled = compileScenario(request.scenario);
    return { code: 0, response: { valid: true, steps: compiled.steps, warnings: compiled.warnings, fingerprint: compiled.fingerprint } };
  }
  if (options.foreground) process.stderr.write(FOREGROUND_NOTICE);
  options.timeoutMs = commandTimeoutMs(parsed);
  // Native capture runs only in the terminal-owned worker, which holds this
  // terminal's Screen Recording permission; calibration captures too.
  if (parsed.command === 'screenshot' || (parsed.command === 'test' && ['play', 'resume', 'calibrate'].includes(parsed.subcommand ?? ''))) {
    try { await ensureCaptureWorker(); } catch (error) { process.stderr.write(`Native capture worker unavailable: ${String(error)}\n`); }
  }
  // A CLI that follows a job it started owns that job: a termination signal
  // cancels it, with its full teardown, before the CLI exits. The handlers go
  // in before admission, so a signal that lands mid-request is not lost.
  const owner = parsed.command === 'test' && ['play', 'resume'].includes(parsed.subcommand ?? '') && options.detach !== true;
  const following = owner || (parsed.command === 'test' && parsed.subcommand === 'job' && options.follow);
  const signals = following ? watchSignals() : undefined;
  try {
    let response: unknown;
    let code: number | undefined;
    let requestId: string = options.requestId ?? randomUUID();
    try {
      const endpoint = parsed.command === 'close' ? 'open' : parsed.command;
      const result = parsed.command === 'test' && parsed.subcommand === 'job'
        ? await requestJson(`${AGENT_REQUESTS_PREFIX}/${encodeURIComponent(options.jobId!)}`, options)
        : await requestJson(
          `${AGENT_COMMAND_PREFIX}/${endpoint}`,
          parsed.command === 'test' && parsed.subcommand === 'play' ? { ...options, timeoutMs: 15000 } : options,
          request,
          requestId,
        );
      response = result.response;
      requestId = result.requestId;
    } catch (error) {
      return requestFailureResult(error, requestId);
    }
    if (parsed.command === 'test' && response && typeof response === 'object' && 'job_id' in response) {
      const jobId = String((response as JsonObject).job_id);
      if (parsed.subcommand !== 'job' && parsed.subcommand !== 'cancel') process.stderr.write(JSON.stringify({ job_id: jobId, state: (response as JsonObject).state, next: `roblox test job --job ${jobId} --follow` }) + '\n');
      if (signals === undefined) return { code: 0, response };
      try { ({ response, code } = await followJob(jobId, options, owner, signals)); }
      catch (error) { return requestFailureResult(error, jobId); }
    }

    const shouldRetain = options.out !== undefined || parsed.command === 'screenshot'
      || options.output !== undefined || containsInlineArtifact(response)
      || (parsed.command === 'test' && parsed.subcommand === 'play' && shouldAutomaticallyRetainPlaytestEvidence(response));
    if (shouldRetain) {
      const out = options.out ? resolve(options.out) : artifactDirectory(parsed.command, requestId);
      const automaticEvidence = options.out === undefined
        && parsed.command === 'test'
        && parsed.subcommand === 'play'
        && shouldAutomaticallyRetainPlaytestEvidence(response);
      try {
        response = retain(out, {
          protocol: AGENT_PROTOCOL_VERSION,
          command: parsed.command, subcommand: parsed.subcommand, request,
          request_id: requestId, created_at: new Date().toISOString(),
        }, response, options.output);
        if (automaticEvidence && response && typeof response === 'object' && !Array.isArray(response)) {
          response = { ...(response as JsonObject), evidence_directory: out };
        }
      } catch (error) {
        const commandPassed = responseOk(response);
        response = cliError('artifact_failed', error instanceof Error ? error.message : String(error), {
          execution: 'unknown', retry: 'never', request_id: requestId,
          next: `The command already completed. Recover its receipt with roblox status --request-id ${requestId}; do not replay it.`,
          details: { command_completed: true, command_passed: commandPassed },
        });
        return { code: responseExitCode(response), response };
      }
    }
    return { code: code ?? responseExitCode(response), response };
  } finally {
    signals?.dispose();
  }
}

/** The daemon answers a cancel once the job's teardown settles, or after 30 s. */
const CANCEL_REQUEST_MS = 45_000;
/** Exit status of a CLI ended by a termination signal: 128 + the signal number. */
const FOLLOW_SIGNALS: Record<'SIGHUP' | 'SIGINT' | 'SIGTERM', number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
type FollowSignal = keyof typeof FOLLOW_SIGNALS;

interface SignalWatch {
  /** Aborted by the first termination signal: stop following. */
  readonly stop: AbortSignal;
  /** Aborted by a second signal: stop waiting, even for the cancel. */
  readonly abandon: AbortSignal;
  received(): FollowSignal | undefined;
  dispose(): void;
}

/**
 * Turn SIGINT, SIGTERM and SIGHUP into a request to stop following instead of
 * an immediate exit, so the CLI can cancel the job it started first.
 */
function watchSignals(): SignalWatch {
  const stop = new AbortController();
  const abandon = new AbortController();
  let received: FollowSignal | undefined;
  const listeners = (Object.keys(FOLLOW_SIGNALS) as FollowSignal[]).map((name) => {
    const listener = () => {
      if (received === undefined) { received = name; stop.abort(); }
      else abandon.abort();
    };
    process.on(name, listener);
    return [name, listener] as const;
  });
  // A closed terminal turns stdio writes into EPIPE/EIO errors, which must not
  // kill the process before it has cancelled its job.
  const ignore = () => undefined;
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  return {
    stop: stop.signal,
    abandon: abandon.signal,
    received: () => received,
    dispose: () => {
      for (const [name, listener] of listeners) process.removeListener(name, listener);
      process.stdout.removeListener('error', ignore);
      process.stderr.removeListener('error', ignore);
    },
  };
}

/**
 * Follow a job with short status reads until it settles. Every read renews an
 * attended job's lease on the daemon. When `own` (this CLI started the job), a
 * termination signal or the explicit `--timeout` cancels the job and reports
 * how it settled; otherwise the CLI only stops following.
 */
async function followJob(id: string, options: CliOptions, own: boolean, signals: SignalWatch): Promise<{ response: unknown; code?: number }> {
  const deadline = options.timeoutExplicit ? Date.now() + options.timeoutMs : Infinity;
  const short = { ...options, timeoutMs: 15_000 };
  let prior = '';
  for (;;) {
    const signal = signals.received();
    if (signal !== undefined || Date.now() >= deadline) {
      if (own) return cancelFollowedJob(id, options, signals, signal ?? 'timeout');
      if (signal !== undefined) return { code: FOLLOW_SIGNALS[signal], response: { job_id: id, following: false, reason: signal, next: `roblox test job --job ${id} --follow` } };
      const timeout = failure(new Error(`Stopped following job ${id}; the job continues. Inspect its status before taking another action.`), undefined, undefined, 'unknown');
      timeout.requestId = id; throw timeout;
    }
    let status: JsonObject;
    try {
      const reply = await requestJson(`${AGENT_REQUESTS_PREFIX}/${encodeURIComponent(id)}`, short);
      if (!reply.response || typeof reply.response !== 'object') throw new Error('Job status is unavailable');
      status = reply.response as JsonObject;
    } catch (error) {
      const fate = own ? 'the daemon cancels it once 30 s pass without a status read' : 'its execution may continue';
      const lost = failure(new Error(`Lost contact with job ${id}; ${fate}: ${String(error)}`), undefined, undefined, 'unknown');
      lost.requestId = id; throw lost;
    }
    const progress = JSON.stringify({ job_id: id, state: status.state, next_step: status.next_step, total_steps: status.total_steps, in_flight: status.in_flight });
    if (options.follow && progress !== prior) { process.stderr.write(progress + '\n'); prior = progress; }
    if (!['queued', 'running', 'cancelling'].includes(String(status.state))) {
      if (status.state === 'unknown') return { response: { ...status, error: { code: 'job_interrupted', execution: 'unknown', retry: 'never', message: 'Inspect the retained job and its live session before resuming.', request_id: id } } };
      try {
        const result = await requestJson(`${AGENT_COMMAND_PREFIX}/test`, short, { action: 'result', job_id: id });
        return { response: { ...result.response as JsonObject, job_id: id, job_directory: status.directory } };
      } catch (error) {
        const lost = failure(new Error(`Could not retrieve the result for job ${id}: ${String(error)}`), undefined, undefined, 'unknown');
        lost.requestId = id; throw lost;
      }
    }
    await delay(Math.max(0, Math.min(250, deadline - Date.now())), undefined, { signal: signals.stop }).catch(() => undefined);
  }
}

/**
 * Cancel the job this CLI started and wait (bounded by the daemon) for it to
 * settle, so an interrupted CLI never leaves a session owned by a job nobody
 * follows. The receipt is the settled result when there is one.
 */
async function cancelFollowedJob(id: string, options: CliOptions, signals: SignalWatch, reason: FollowSignal | 'timeout'): Promise<{ response: unknown; code: number }> {
  process.stderr.write(JSON.stringify({ job_id: id, cancelling: true, reason }) + '\n');
  let status: JsonObject;
  try {
    const reply = await requestJson(`${AGENT_COMMAND_PREFIX}/test`, { ...options, timeoutMs: CANCEL_REQUEST_MS }, { action: 'cancel', job_id: id }, undefined, signals.abandon);
    status = reply.response && typeof reply.response === 'object' ? reply.response as JsonObject : {};
  } catch (error) {
    const response = cliError('job_cancel_unconfirmed', `Stopped by ${reason}; the cancel of job ${id} was not confirmed: ${error instanceof Error ? error.message : String(error)}`, {
      execution: 'unknown', retry: 'never', request_id: id,
      next: `roblox test cancel --job ${id} (an attended job is also cancelled once 30 s pass without a status read)`,
    });
    return { code: reason === 'timeout' ? exitCodeForError(response.error) : FOLLOW_SIGNALS[reason], response };
  }
  let response: JsonObject = { ...status, interrupted: reason, next: `roblox test job --job ${id} --follow` };
  if (!['queued', 'running', 'cancelling', 'unknown'].includes(String(status.state))) {
    try {
      const result = await requestJson(`${AGENT_COMMAND_PREFIX}/test`, { ...options, timeoutMs: 15_000 }, { action: 'result', job_id: id }, undefined, signals.abandon);
      response = { ...result.response as JsonObject, job_id: id, job_directory: status.directory, interrupted: reason };
    } catch { /* The settled status above is still the honest answer. */ }
  }
  return { code: reason === 'timeout' ? responseExitCode(response) : FOLLOW_SIGNALS[reason], response };
}

/** Every log entry message in an instance- or group-scope logs response. */
function logMessages(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const body = value as JsonObject;
  const batches = [body.entries, ...(Array.isArray(body.instances) ? body.instances.map((instance) =>
    instance && typeof instance === 'object' ? (instance as JsonObject).entries : undefined) : [])];
  return batches.flatMap((entries) => Array.isArray(entries) ? entries : [])
    .flatMap((entry) => entry && typeof entry === 'object' && typeof (entry as JsonObject).message === 'string'
      ? [(entry as JsonObject).message as string] : []);
}

async function followLogs(parsed: ParsedCli): Promise<{ code: number; response: unknown }> {
  const options = parsed.options;
  // A response carries the cursor kind for its scope; sending both kinds is an
  // error, so the latest kind replaces the other when the scope changes.
  let position: JsonObject = options.cursor !== undefined ? { cursor: options.cursor }
    : options.cursorByInstance !== undefined ? { cursor_by_instance: options.cursorByInstance } : {};
  const until = options.until === undefined ? undefined : new RegExp(options.until);
  const deadline = options.durationMs === undefined ? Infinity : Date.now() + options.durationMs;
  const interrupt = new AbortController();
  const onInterrupt = () => interrupt.abort();
  process.once('SIGINT', onInterrupt);
  let reason: 'duration' | 'until' | 'interrupted';
  try {
    for (;;) {
      if (interrupt.signal.aborted) { reason = 'interrupted'; break; }
      let batch: unknown;
      try {
        batch = (await requestJson(`${AGENT_COMMAND_PREFIX}/logs`, options, {
          ...commandBody(parsed), cursor: undefined, cursor_by_instance: undefined, ...position,
        })).response;
      } catch (error) {
        return requestFailureResult(error);
      }
      const data = batch && typeof batch === 'object' && !Array.isArray(batch) ? batch as JsonObject : {};
      if (typeof data.next_cursor === 'string') position = { cursor: data.next_cursor };
      else if (data.next_cursor_by_instance && typeof data.next_cursor_by_instance === 'object' && !Array.isArray(data.next_cursor_by_instance)) {
        position = { cursor_by_instance: data.next_cursor_by_instance };
      }
      const active = hasLogActivity(batch);
      if (active) process.stdout.write(`${JSON.stringify(batch)}\n`);
      if (until !== undefined && logMessages(batch).some((message) => until.test(message))) { reason = 'until'; break; }
      if (interrupt.signal.aborted) { reason = 'interrupted'; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { reason = 'duration'; break; }
      if (!active) await delay(Math.min(250, remaining), undefined, { signal: interrupt.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
  const done = {
    done: true,
    reason,
    ...(typeof position.cursor === 'string' ? { next_cursor: position.cursor } : {}),
    ...(position.cursor_by_instance !== undefined ? { next_cursor_by_instance: position.cursor_by_instance } : {}),
  };
  // --until names what the caller waited for; running out of time first is a failure.
  return { code: reason === 'interrupted' ? 130 : reason === 'duration' && until !== undefined ? 1 : 0, response: done };
}

async function runDaemonForeground(port: number): Promise<number> {
  const daemon = daemonEntry();
  const child = spawn(process.execPath, [daemon], { stdio: 'inherit', env: { ...process.env, ROBLOX_CLI_PORT: String(port) } });
  return new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise(signal === 'SIGINT' ? 130 : code ?? 1));
    child.once('error', () => resolvePromise(3));
  });
}

async function localCommand(parsed: ParsedCli): Promise<{ code: number; response: unknown }> {
  const options = parsed.options;
  try {
    if (parsed.command === 'version') {
      const packageJson = JSON.parse(readFileSync(packageJsonPath(), 'utf8')) as JsonObject;
      return {
        code: 0,
        response: {
          name: packageJson.name,
          version: packageJson.version,
          protocol: { name: 'roblox-cli-agent', version: AGENT_PROTOCOL_VERSION },
          node: process.version,
        },
      };
    }
    if (parsed.command === 'schema') return { code: 0, response: agentSchema() };
    if (parsed.command === 'record') {
      if (options.durationMs === undefined || !options.output) throw invalid('record requires --duration SECONDS --output FILE.mp4');
      if (options.foreground) process.stderr.write(FOREGROUND_NOTICE);
      // The daemon, when one is attached, measures the rate Studio rendered at
      // over the capture; without it the receipt simply has no render_fps.
      const sampleRender = async () => {
        try {
          const status = (await requestJson(`${AGENT_COMMAND_PREFIX}/test`, { ...options, timeoutMs: 10_000 }, { action: 'status' })).response;
          return status && typeof status === 'object' && 'runtime_health' in status ? renderSample(status.runtime_health) : undefined;
        } catch {
          return undefined;
        }
      };
      return { code: 0, response: await recordNativeStudio(options.durationMs / 1000, options.output, { foreground: options.foreground, sampleRender }) };
    }
    // The explicit start/stop form exists so a workflow owns the length of its
    // own video instead of a fixed-duration ceiling. `stop` signals the helper
    // that is already recording, so nothing is capped by --duration here.
    if (parsed.command === 'record-studio') {
      if (parsed.subcommand === 'start') {
        const file = options.out ?? options.output;
        if (!file) throw invalid('record-studio start requires --out FILE.mp4');
        if (options.durationMs !== undefined) process.stderr.write(`Recording is capped at ${options.durationMs / 1000}s by --duration; omit it to record until stop.\n`);
        // `--crop viewport` reuses the same four-marker calibration as
        // screenshots; it needs the daemon because only the plugin can place
        // the markers in the live play client.
        let crop: RecordingCrop | undefined;
        if (options.crop === 'viewport') {
          await ensureCaptureWorker();
          const calibrated = await requestJson(`${AGENT_COMMAND_PREFIX}/test`, options, { action: 'calibrate' });
          const measured = calibrated.response && typeof calibrated.response === 'object' && !Array.isArray(calibrated.response)
            ? calibrated.response as JsonObject
            : {};
          const rect = measured.crop_in_capture as JsonObject | undefined;
          if (!rect || typeof rect.width !== 'number' || typeof rect.height !== 'number') {
            process.stderr.write('Viewport calibration was unavailable; recording the full Studio window.\n');
          }
          else {
            crop = {
              x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height),
              capture_width: Number(measured.capture_width), capture_height: Number(measured.capture_height),
            };
          }
        }
        return { code: 0, response: await startNativeRecording({
          file,
          ...(options.durationMs === undefined ? {} : { seconds: options.durationMs / 1000 }),
          ...(crop === undefined ? {} : { crop }),
        }) };
      }
      return { code: 0, response: await stopNativeRecording() };
    }
    if (parsed.command === 'setup') return { code: 0, response: setupRobloxCli(options.port) };
    if (parsed.command === 'daemon') {
      switch (parsed.subcommand) {
        case 'start': return { code: 0, response: await startDaemon(options.port) };
        case 'stop': return { code: 0, response: await stopDaemon(options.port) };
        case 'restart':
          await stopDaemon(options.port);
          return { code: 0, response: await startDaemon(options.port) };
        case 'status': return { code: 0, response: await daemonStatus(options.port) };
        case 'run': return { code: await runDaemonForeground(options.port), response: { foreground: true } };
        default: throw invalid('daemon requires start, stop, restart, status, or run');
      }
    }
    if (parsed.command === 'doctor') {
      assertMacOS();
      const checks: JsonObject = { platform: process.platform, node: process.version, data_directory: dataDirectory() };
      try { checks.artifacts = verifyBuildArtifacts(); } catch (error) { checks.artifacts = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      try { checks.daemon = await daemonStatus(options.port); } catch (error) { checks.daemon = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      const health = await requestJson(AGENT_HEALTH_PATH, options)
        .then((result) => result.response)
        .catch((error) => cliError('health_unavailable', error instanceof Error ? error.message : String(error), {
          execution: 'not_started', retry: 'after_fix',
        }));
      checks.health = health;
      const okay = Boolean((checks.artifacts as JsonObject)?.daemon) && responseOk(health);
      const studioConnected = typeof (health as JsonObject)?.instanceCount === 'number'
        && Number((health as JsonObject).instanceCount) > 0;
      return { code: okay ? 0 : 3, response: { healthy: okay, validation: 'connector_installation', studio_connected: studioConnected, game_readiness: 'not_checked', checks } };
    }
    if (parsed.command === 'status') {
      if (options.requestId) {
        const result = await requestJson(`${AGENT_REQUESTS_PREFIX}/${encodeURIComponent(options.requestId)}`, options);
        return { code: 0, response: result.response };
      }
      const result = await requestJson(options.captureProbe ? `${AGENT_STATUS_PATH}?capture_probe=1` : AGENT_STATUS_PATH, options);
      const status = result.response && typeof result.response === 'object' && !Array.isArray(result.response)
        ? result.response as JsonObject
        : { daemon_status: result.response };
      return { code: 0, response: { ...status, recording: recordingStatus() } };
    }
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof CliCommandError) throw error;
    if (error instanceof Error && 'outcome' in error) return requestFailureResult(error);
    const response = cliError('local_command_failed', error instanceof Error ? error.message : String(error), {
      execution: 'not_started', retry: 'after_fix',
    });
    return { code: exitCodeForError(response.error), response };
  }
  return remoteCommand(parsed);
}

export async function run(parsed: ParsedCli): Promise<{ code: number; response: unknown }> {
  if (parsed.options.help || parsed.command === 'help') return { code: 0, response: agentSchema() };
  if (parsed.command === 'test' && !parsed.subcommand) {
    const response = cliError('test_mode_required', `test requires a mode: ${CLI_TEST_MODES.join(', ')}.`, {
      execution: 'not_started', retry: 'after_fix', details: { modes: [...CLI_TEST_MODES] },
    });
    return { code: exitCodeForError(response.error), response };
  }
  try {
    return await localCommand(parsed);
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof CliCommandError) return thrownErrorResult(error);
    throw error;
  }
}

export async function main(): Promise<void> {
  let result: { code: number; response: unknown };
  try {
    result = await run(parseCli(process.argv.slice(2)));
  } catch (error) {
    result = thrownErrorResult(error);
  }
  process.stdout.write(`${JSON.stringify(result.response)}\n`);
  process.exitCode = result.code;
}
