import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliCommandError } from './cli-errors.js';
import { publicToolErrorBody, type ToolInvocationContext } from './command-results.js';
import { dataDirectory } from './paths.js';
import type { Condition, Json, Scenario } from './scenario.js';
/** Whether a cancelled job's cleanup failure means the session it would have
 * released input into no longer exists. Those failures are terminal: there is
 * no input left to release and no session to release it into. */
function isSessionAbsent(cleanup: Json | undefined): boolean {
  if (!cleanup || cleanup.released !== false) return false;
  const error = String(cleanup.error ?? '');
  return /not connected|no active studio session|session_required|disconnected|no session/i.test(error);
}

export function childRequestId(parent: string, index: number): string {
  const suffix = `:step-${index}`;
  // Leave room for expectation/poll suffixes without losing parent uniqueness.
  const prefix = parent.length + suffix.length <= 100 ? parent
    : `${parent.slice(0, 24)}-${createHash('sha256').update(parent).digest('hex').slice(0, 40)}`;
  return prefix + suffix;
}
/**
 * How long an attended job survives without a status read from whoever is
 * following it. The CLI polls every 250 ms; a follower that stops polling
 * (killed, suspended, disconnected) loses its job instead of leaving the
 * session owned by work nobody is watching.
 */
export const FOLLOW_LEASE_MS = 30_000;
/** How long `cancel` waits for the run's teardown before answering with the current state. */
export const CANCEL_SETTLE_MS = 30_000;

export interface JobProgress {
  startIndex: number;
  cancelled(): boolean;
  /** Aborted when cancellation is requested; waits and polls race it, native actions do not. */
  cancelSignal: AbortSignal;
  phase(name: string): void;
  ready(identity: string[]): void;
  stepStarted(index: number, step: Json): void;
  stepFinished(index: number, receipt: Json): void;
}
export interface TestJob extends Json {
  job_id: string;
  state: 'queued' | 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'unknown';
  execution: string;
  phase: string;
  session_id: string;
  instance_id: string;
  created_at: string;
  updated_at: string;
  next_step: number;
  total_steps: number;
  scenario_hash: string;
  runtime_identity?: string[];
  in_flight?: {
    index: number;
    name: string;
    request_id: string;
  };
  completed_steps: {
    index: number;
    name: string;
    passed: boolean;
    file: string;
  }[];
  result_file?: string;
  cancel_requested?: boolean;
  /** Attended jobs are cancelled when their follower's lease lapses; detached jobs run unattended. */
  attended?: boolean;
  /** 1 for the first run; each resume starts the next attempt. */
  attempt?: number;
}
interface Dependencies {
  session(): {
    session_id: string;
    instance_id: string;
  };
  runtime(): string[];
  execute(body: Json, context: ToolInvocationContext): Promise<unknown>;
  check(condition: Condition): Promise<boolean>;
  cleanup?(body: Json): Promise<unknown>;
  /**
   * Teardown for a run that threw after reaching its runtime: release held
   * input, stop the job's runtime peers and confirm they are gone.
   */
  recover?(body: Json, runtime: string[]): Promise<unknown>;
}
interface Timing {
  leaseMs: number;
  cancelSettleMs: number;
}
/** Resolve when `work` settles or `ms` passes, whichever is first. */
async function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref();
  await Promise.race([work.catch(() => undefined), promise]);
  clearTimeout(timer);
}
export function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  }
  finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}
export class TestJobs {
  private readonly running = new Map<string, Promise<void>>();
  private readonly records = new Map<string, TestJob>();
  private readonly cancellers = new Map<string, AbortController>();
  private readonly leases = new Map<string, NodeJS.Timeout>();
  readonly directory: string;
  constructor(
    private readonly deps: Dependencies,
    directory = join(dataDirectory(), 'test-jobs'),
    private readonly timing: Timing = { leaseMs: FOLLOW_LEASE_MS, cancelSettleMs: CANCEL_SETTLE_MS },
  ) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const id of readdirSync(directory)) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id))
        continue;
      try {
        const job = JSON.parse(readFileSync(join(directory, id, 'job.json'), 'utf8')) as TestJob;
        if (job.job_id !== id)
          continue;
        if (['queued', 'running', 'cancelling'].includes(job.state)) {
          job.state = 'unknown';
          job.execution = 'unknown';
          job.phase = 'daemon_interrupted';
          this.save(job);
        }
        // A restored cancellation that already proved its session or original
        // runtime is gone must not be retained as the session's owner: there is
        // no held input left to release and no runtime to release it into.
        if (job.state === 'unknown' && job.cancel_requested === true) {
          if (isSessionAbsent(job.cancellation_cleanup as Json | undefined))
            this.settleCancelled(job, 'cleanup_session_absent');
          else if (this.originalRuntimeGone(job))
            this.settleRuntimeGone(job);
        }
        this.records.set(id, job);
      }
      catch { /* Incomplete admission has no executable job; retain its files for diagnosis. */ }
    }
  }
  /**
   * Whether nothing of the job's original runtime is left to release input
   * into: it never reached ready(), or none of its peers is still connected.
   * When the job's instance cannot be observed, that is not proof of absence.
   */
  private originalRuntimeGone(job: TestJob): boolean {
    if (!job.runtime_identity?.length) return true;
    let present: Set<string>;
    try {
      if (this.deps.session().instance_id !== job.instance_id) return false;
      present = new Set(this.deps.runtime());
    }
    catch {
      return false;
    }
    return !job.runtime_identity.some(peer => present.has(peer));
  }
  private settleCancelled(job: TestJob, phase: string) {
    job.state = 'cancelled';
    job.execution = 'stopped';
    job.phase = phase;
    this.save(job);
  }
  private settleRuntimeGone(job: TestJob) {
    job.cancellation_cleanup = { released: false, reason: 'original_runtime_gone' };
    this.settleCancelled(job, 'cleanup_runtime_gone');
  }
  private folder(id: string): string {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || id === '.' || id === '..')
      throw new CliCommandError('invalid_job_id', 'Invalid job ID.');
    return join(this.directory, id);
  }
  private save(job: TestJob) {
    job.updated_at = new Date().toISOString();
    atomicJson(join(this.folder(job.job_id), 'job.json'), job);
    this.records.set(job.job_id, job);
  }
  status(id: string): TestJob | undefined {
    this.folder(id);
    const job = this.records.get(id);
    return job ? structuredClone(job) : undefined;
  }
  private require(id: string): TestJob {
    const job = this.records.get(id);
    this.folder(id);
    if (!job)
      throw new CliCommandError('job_not_found', 'No retained job has this ID.');
    return job;
  }
  /**
   * A job owns its session while it can still send something to it.
   *
   * An `unknown` job whose cleanup could not release input because the session
   * is gone has nothing left to send: a session that does not exist cannot be
   * holding held input. Retaining ownership there is a livelock, because the
   * condition that stopped cleanup is also the condition that makes every
   * later playtest refuse with `job_conflict`. Cancelling a job whose original
   * runtime is gone settles it for the same reason.
   */
  private owns(job: TestJob): boolean {
    if (['queued', 'running', 'cancelling'].includes(job.state)) return true;
    if (job.state !== 'unknown') return false;
    if (job.cancel_requested !== true) return true;
    const cleanup = job.cancellation_cleanup as Json | undefined;
    if (cleanup?.released === true) return false;
    return !isSessionAbsent(cleanup);
  }

  hasActive(instance: string): boolean {
    return [...this.records.values()].some(j => j.instance_id === instance && this.owns(j));
  }
  private ensureAvailable(instance: string, except?: string) {
    const other = [...this.records.values()].find(j => j.job_id !== except && j.instance_id === instance && this.owns(j));
    if (other)
      throw new CliCommandError('job_conflict', `Job ${other.job_id} still owns this session. Inspect or cancel its remaining steps before starting another.`, { details: { job_id: other.job_id } });
  }
  submit(body: Json, scenario: Scenario, id: string = randomUUID()): TestJob {
    const session = this.deps.session();
    const dir = this.folder(id);
    if (existsSync(dir))
      throw new CliCommandError('duplicate_request', 'This job ID already exists; inspect its status. No work was replayed.', { statusCode: 409 });
    this.ensureAvailable(session.instance_id);
    mkdirSync(dir, { mode: 0o700 });
    const normalized = { ...body, scenario: { description: scenario.description, steps: scenario.steps, resume_when: scenario.resume_when } };
    atomicJson(join(dir, 'request.json'), normalized);
    const job: TestJob = {
      job_id: id, state: 'queued', execution: 'pending', phase: 'admitted', ...session,
      created_at: new Date().toISOString(), updated_at: '', next_step: 0, total_steps: scenario.steps.length,
      scenario_hash: scenario.fingerprint, completed_steps: [], warnings: scenario.warnings,
      directory: dir, foreground: body.foreground === true, attended: body.detach !== true,
    };
    this.save(job);
    this.schedule(job, normalized);
    return this.status(id)!;
  }
  private schedule(job: TestJob, body: Json) {
    // Admission and its receipt reach disk before any native action starts.
    const run = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.run(job, body));
    this.running.set(job.job_id, run);
    void run.finally(() => this.running.delete(job.job_id)).catch(() => { });
    this.renewLease(job.job_id);
  }
  /**
   * A status read renews an attended job's lease. Whoever reads its status is
   * following it; when nobody has for `leaseMs`, the job is cancelled with its
   * normal teardown rather than left owning the session.
   */
  observe(id: string): void {
    if (this.leases.has(id)) this.renewLease(id);
  }
  private renewLease(id: string) {
    clearTimeout(this.leases.get(id));
    this.leases.delete(id);
    const job = this.records.get(id);
    if (job?.attended !== true || job.cancel_requested === true || !['queued', 'running'].includes(job.state)) return;
    const timer = setTimeout(() => {
      this.leases.delete(id);
      void this.cancel(id, 'follower_lost').catch(() => { });
    }, this.timing.leaseMs);
    timer.unref();
    this.leases.set(id, timer);
  }
  private endLease(id: string) {
    clearTimeout(this.leases.get(id));
    this.leases.delete(id);
  }
  private artifact(id: string, label: string, value: unknown): unknown {
    const dir = this.folder(id);
    const destination = join(dir, `${label}.json`);
    if (existsSync(destination))
      renameSync(destination, join(dir, `${label}.previous-${randomUUID()}.json`));
    const visit = (v: unknown): unknown => {
      if (Array.isArray(v))
        return v.map(visit);
      if (!v || typeof v !== 'object')
        return v;
      const item = v as Json;
      if (typeof item.data === 'string' && (typeof item.mime_type === 'string' || typeof item.mimeType === 'string')) {
        const bytes = Buffer.from(item.data, 'base64');
        const hash = createHash('sha256').update(bytes).digest('hex');
        const mime = String(item.mime_type ?? item.mimeType);
        const file = join(dir, `${hash}.${mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'bin'}`);
        if (!existsSync(file))
          writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
        const { data: _data, ...metadata } = item;
        return { ...metadata, file, sha256: hash, bytes: bytes.length };
      }
      return Object.fromEntries(Object.entries(item).map(([k, x]) => [k, visit(x)]));
    };
    const result = visit(value);
    atomicJson(destination, result);
    return result;
  }
  private async run(job: TestJob, body: Json) {
    const canceller = new AbortController();
    this.cancellers.set(job.job_id, canceller);
    try {
      if (job.cancel_requested) {
        this.artifact(job.job_id, 'result', { passed: false, cancelled: true, execution: 'not_started', steps: [] });
        job.result_file = join(this.folder(job.job_id), 'result.json');
        job.state = 'cancelled';
        job.execution = 'not_started';
        return;
      }
      job.state = 'running';
      this.save(job);
      // Each resume is a new attempt with its own operation ids: re-running a
      // step index must not collide with the first attempt's retained ids.
      const requestId = (job.attempt ?? 1) > 1 ? `${job.job_id}:attempt-${job.attempt}` : job.job_id;
      const progress: JobProgress = {
        startIndex: job.next_step,
        cancelled: () => job.cancel_requested === true,
        cancelSignal: canceller.signal,
        phase: phase => { job.phase = phase; this.save(job); },
        ready: identity => { job.runtime_identity = identity; this.save(job); },
        stepStarted: (index, step) => {
          job.in_flight = { index, name: String(step.name), request_id: childRequestId(requestId, index) };
          job.phase = 'step';
          this.save(job);
        },
        stepFinished: (index, receipt) => {
          this.artifact(job.job_id, `step-${index}`, receipt);
          const entry = { index, name: String(receipt.name), passed: receipt.passed === true, file: join(this.folder(job.job_id), `step-${index}.json`) };
          job.completed_steps = [...job.completed_steps.filter(s => s.index !== index), entry];
          if (entry.passed) {
            job.next_step = index + 1;
            delete job.in_flight;
          }
          this.save(job);
        },
      };
      const value = await this.deps.execute(body, { signal: new AbortController().signal, requestId, job: progress });
      const finalValue = value && typeof value === 'object' ? { ...value as Json } : { result: value };
      if ('steps' in finalValue)
        finalValue.steps = [...job.completed_steps].sort((a, b) => a.index - b.index).map(step => JSON.parse(readFileSync(step.file, 'utf8')));
      const result = this.artifact(job.job_id, 'result', finalValue) as Json;
      job.result_file = join(this.folder(job.job_id), 'result.json');
      // A run that returned has already been through its own teardown, so it
      // settles: an uncertain step is reported as `execution: unknown` on a
      // failed job, never as a job that keeps owning the session.
      job.state = job.cancel_requested ? 'cancelled' : result.passed === false || result.error ? 'failed' : 'completed';
      job.execution = job.state === 'completed' ? 'success' : job.state === 'cancelled' ? 'stopped' : result.execution === 'unknown' ? 'unknown' : 'failed';
    }
    catch (error) {
      // A run that threw skipped its own teardown. If it had reached its
      // runtime, stop and verify that runtime before settling; either way the
      // job settles, so a startup failure never leaves the session owned.
      const failure = publicToolErrorBody('test', error);
      const execution = String((failure.error as Json)?.execution ?? 'unknown');
      let recovery: unknown;
      if (job.runtime_identity?.length && this.deps.recover) {
        try { recovery = await this.deps.recover(body, job.runtime_identity); }
        catch (recoverError) { recovery = { released: false, runtime: 'unverified', error: String(recoverError) }; }
      }
      this.artifact(job.job_id, 'result', { ...failure, passed: false, execution, ...(recovery === undefined ? {} : { recovery }) });
      job.result_file = join(this.folder(job.job_id), 'result.json');
      job.state = job.cancel_requested ? 'cancelled' : 'failed';
      job.execution = execution;
    }
    finally {
      job.phase = 'settled';
      this.cancellers.delete(job.job_id);
      this.endLease(job.job_id);
      this.save(job);
    }
  }
  /**
   * Request cancellation and wait, bounded, for the run to settle.
   *
   * Waits (`wait`, `wait_until`, `--duration`) end at once; an in-flight native
   * action is allowed to answer, because aborting it would leave its outcome
   * unknown. The run then takes its normal teardown: the recorder is
   * finalized, held input released and the playtest stopped and verified.
   * The returned status is settled unless teardown outlasts `cancelSettleMs`.
   */
  async cancel(id: string, reason: 'requested' | 'follower_lost' = 'requested'): Promise<TestJob> {
    const job = this.require(id);
    if (['completed', 'failed', 'cancelled'].includes(job.state))
      return this.status(id)!;
    this.endLease(id);
    if (job.cancel_requested !== true)
      job.cancellation = { reason, requested_at: new Date().toISOString(), policy: 'interrupt_waits_then_teardown', rollback: false, unresolved: job.in_flight ?? null };
    job.cancel_requested = true;
    if (job.state === 'running' || job.state === 'queued')
      job.state = 'cancelling';
    this.save(job);
    this.cancellers.get(id)?.abort();
    if (job.state === 'unknown') {
      if (this.originalRuntimeGone(job)) {
        this.settleRuntimeGone(job);
        return this.status(id)!;
      }
      try {
        const session = this.deps.session();
        if (session.instance_id !== job.instance_id || session.session_id !== job.session_id || JSON.stringify(this.deps.runtime()) !== JSON.stringify(job.runtime_identity))
          throw new Error('Original runtime cannot be verified; input cleanup was not sent to a different session');
        const body = JSON.parse(readFileSync(join(this.folder(id), 'request.json'), 'utf8'));
        job.cancellation_cleanup = this.deps.cleanup ? await this.deps.cleanup(body) : { released: true, inputs: [] };
      }
      catch (error) {
        job.cancellation_cleanup = { released: false, error: String(error) };
      }
      // Terminal-state immediately when the session is gone. Waiting for a
      // session that no longer exists would keep every later playtest out.
      if (isSessionAbsent(job.cancellation_cleanup as Json))
        this.settleCancelled(job, 'cleanup_session_absent');
      else
        this.save(job);
      return this.status(id)!;
    }
    const run = this.running.get(id);
    if (run) await settledWithin(run, this.timing.cancelSettleMs);
    return this.status(id)!;
  }
  private requireOriginalRuntime(job: TestJob) {
    const session = this.deps.session();
    if (session.session_id !== job.session_id || session.instance_id !== job.instance_id || !job.runtime_identity?.length || JSON.stringify(this.deps.runtime()) !== JSON.stringify(job.runtime_identity))
      throw new CliCommandError('resume_session_mismatch', 'The original live play session cannot be verified. No input was sent.');
  }
  async resume(id: string, options: { foreground?: unknown; detach?: unknown } = {}): Promise<TestJob> {
    if (options.foreground !== undefined && typeof options.foreground !== 'boolean')
      throw new CliCommandError('invalid_argument', 'foreground must be a boolean.');
    if (options.detach !== undefined && typeof options.detach !== 'boolean')
      throw new CliCommandError('invalid_argument', 'detach must be a boolean.');
    const job = this.require(id);
    if (job.phase === 'resume_validating')
      throw new CliCommandError('job_conflict', 'Resume validation is already running.');
    if (!['cancelled', 'failed', 'unknown'].includes(job.state))
      throw new CliCommandError('job_not_resumable', 'Only stopped or interrupted jobs can resume.');
    this.ensureAvailable(job.instance_id, id);
    this.requireOriginalRuntime(job);
    // Validation awaits live checks. Own the session for that whole window so
    // no other job is admitted and a cancel lands on this job, not a stale copy.
    const prior = structuredClone(job);
    delete job.cancel_requested;
    job.state = 'queued';
    job.execution = 'pending';
    job.phase = 'resume_validating';
    this.save(job);
    let body: Json;
    try {
      body = JSON.parse(readFileSync(join(this.folder(id), 'request.json'), 'utf8')) as Json;
      const scenario = body.scenario as Scenario;
      if (!scenario.resume_when || !await this.deps.check(scenario.resume_when))
        throw new CliCommandError('resume_precondition_failed', 'A declared resume_when condition must verify the current game state. No step was replayed.');
      if (job.in_flight) {
        const step = scenario.steps[job.in_flight.index];
        if (['wait', 'wait_until', 'logs', 'screenshot', 'diagnose'].includes(String(step.type))) {
          if (step.type === 'wait') {
            const entry = job.completed_steps.find(s => s.index === job.in_flight!.index);
            if (entry) {
              const result = JSON.parse(readFileSync(entry.file, 'utf8')).result;
              if (typeof result?.requested_ms === 'number' && typeof result?.waited_ms === 'number')
                step.duration_ms = Math.max(0, result.requested_ms - result.waited_ms);
            }
          }
          delete job.in_flight;
        }
        else {
          if (!step.expect || !await this.deps.check(step.expect as Condition))
            throw new CliCommandError('step_outcome_unresolved', 'The interrupted step has no satisfied expect condition. Inspect the game; the step will not be replayed.');
          const index = job.in_flight.index;
          const receipt = { index, name: step.name, passed: true, recovered_by: 'expect', input_replayed: false };
          this.artifact(id, `step-${index}`, receipt);
          job.completed_steps = [...job.completed_steps.filter(s => s.index !== index), { index, name: String(step.name), passed: true, file: join(this.folder(id), `step-${index}.json`) }];
          job.next_step = index + 1;
          delete job.in_flight;
        }
      }
      if (this.deps.cleanup) {
        const cleanup = await this.deps.cleanup(body);
        job.resume_input_cleanup = cleanup;
        if ((cleanup as Json)?.released !== true)
          throw new CliCommandError('input_cleanup_unverified', 'Held input cleanup could not be verified. Resume did not send another action.');
      }
      if (job.cancel_requested)
        throw new CliCommandError('job_cancelled', 'The job was cancelled while resume was validating. No step was replayed.');
      this.requireOriginalRuntime(job);
    }
    catch (error) {
      const cancelled = job.cancel_requested === true;
      this.save(prior);
      // A cancel that arrived during validation applies to the restored job.
      if (cancelled)
        await this.cancel(id);
      throw error;
    }
    job.phase = 'resuming';
    job.foreground = options.foreground ?? job.foreground === true;
    job.attended = options.detach !== true;
    job.attempt = (job.attempt ?? 1) + 1;
    delete job.result_file;
    this.save(job);
    this.schedule(job, { ...body, foreground: job.foreground, keep_open: true });
    return this.status(id)!;
  }
  result(id: string): unknown {
    const job = this.require(id);
    if (!job.result_file)
      throw new CliCommandError('job_pending', 'This run has no final result yet.', { statusCode: 409 });
    return JSON.parse(readFileSync(job.result_file, 'utf8'));
  }
  async settled(id: string): Promise<void> { await this.running.get(id); }
}
