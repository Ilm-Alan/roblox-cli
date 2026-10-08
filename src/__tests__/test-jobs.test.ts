import { mkdtempSync, readFileSync } from 'node:fs';
import { removeHome } from './remove-home.js';
import { tmpdir } from 'node:os';
import { TestJobs, childRequestId } from '../test-jobs.js';
import { compileScenario, type Json } from '../scenario.js';
import { CliCommandError } from '../cli-errors.js';
import type { ToolInvocationContext } from '../command-results.js';
const session = () => ({ session_id: 'session-one', instance_id: 'studio-one' });
const runtime = () => ['client-1:original', 'server:original'];
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
/** An execute that runs until its job is cancelled, as a long `wait` does. */
const untilCancelled = async (_body: Json, context: ToolInvocationContext) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  context.job!.cancelSignal.addEventListener('abort', () => resolve());
  await promise;
  return { passed: false, cancelled: true };
};
describe('persistent native scenario jobs', () => {
  test('long request IDs retain distinct child identities with room for recovery suffixes', () => {
    const prefix = 'x'.repeat(127);
    const first = childRequestId(prefix + 'a', 9999);
    expect(first).not.toBe(childRequestId(prefix + 'b', 9999));
    expect(first.length + ':expect'.length).toBeLessThanOrEqual(128);
  });
  let home: string;
  beforeEach(() => { home = mkdtempSync(`${tmpdir()}/roblox-jobs-test-`); });
  afterEach(async () => { await removeHome(home); });
  test('admission is durable before work starts; complete receipts survive daemon replacement without a size cap', async () => {
    let mutations = 0;
    const deps = {
      session, runtime, check: async () => true, execute: async (_body: Json, context: ToolInvocationContext) => {
        mutations++;
        context.job!.ready(runtime());
        context.job!.stepStarted(0, { name: 'purchase' });
        context.job!.stepFinished(0, { index: 0, name: 'purchase', passed: true, result: { large: 'x'.repeat(300000) } });
        return { passed: true, steps: [] };
      }
    };
    const jobs = new TestJobs(deps, home);
    const job = jobs.submit({}, compileScenario({ steps: [{ name: 'purchase', type: 'eval', code: 'return true' }] }), 'durable');
    expect(mutations).toBe(0);
    expect(JSON.parse(readFileSync(`${home}/durable/job.json`, 'utf8')).state).toBe('queued');
    await jobs.settled(job.job_id);
    const replacement = new TestJobs(deps, home);
    expect(replacement.status(job.job_id)).toMatchObject({ state: 'completed', next_step: 1 });
    expect(JSON.stringify(replacement.result(job.job_id)).length).toBeGreaterThan(300000);
    expect(mutations).toBe(1);
    expect(() => replacement.submit({}, compileScenario({ steps: [] }), 'durable')).toThrow(/already exists/);
  });
  test('cancelling during a native action waits for its receipt and never dispatches another action', async () => {
    let finish!: () => void;
    const received = new Promise<void>(resolve => { finish = resolve; });
    let nextAction = false;
    const jobs = new TestJobs({
      session, runtime, check: async () => true, execute: async (_body, context) => {
        context.job!.ready(runtime());
        context.job!.stepStarted(0, { name: 'feed' });
        await received;
        context.job!.stepFinished(0, { index: 0, name: 'feed', passed: true });
        if (!context.job!.cancelled())
          nextAction = true;
        return { passed: !context.job!.cancelled(), cancelled: context.job!.cancelled() };
      }
    }, home);
    jobs.submit({}, compileScenario({ steps: [{ type: 'eval', code: 'return true' }] }), 'cancel');
    await nextTurn();
    const cancelling = jobs.cancel('cancel');
    expect(jobs.status('cancel')).toMatchObject({ state: 'cancelling', in_flight: { name: 'feed' }, cancellation: { reason: 'requested' } });
    finish();
    // The cancel answers once the run has settled, not merely once it was flagged.
    expect(await cancelling).toMatchObject({ state: 'cancelled', next_step: 1, phase: 'settled' });
    expect(nextAction).toBe(false);
  });
  test('a cancel aborts the job cancel signal at once and answers within its bound when teardown is slow', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const jobs = new TestJobs({
        session, runtime, check: async () => true, execute: async (_body, context) => {
          context.job!.cancelSignal.addEventListener('abort', () => { aborted = true; });
          return new Promise(() => { });
        },
      }, home, { leaseMs: 60_000, cancelSettleMs: 5_000 });
      jobs.submit({ detach: true }, compileScenario({ steps: [] }), 'slow-teardown');
      await jest.advanceTimersByTimeAsync(0);
      const cancelling = jobs.cancel('slow-teardown');
      expect(aborted).toBe(true);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await cancelling).toMatchObject({ state: 'cancelling', cancel_requested: true });
    } finally {
      jest.useRealTimers();
    }
  });
  test('an attended job whose follower stops reading its status is cancelled; a detached job is not', async () => {
    jest.useFakeTimers();
    try {
      const jobs = new TestJobs({ session, runtime, check: async () => true, execute: untilCancelled }, home, { leaseMs: 1_000, cancelSettleMs: 5_000 });
      jobs.submit({}, compileScenario({ steps: [] }), 'attended');
      // Status reads renew the lease while the follower is alive.
      for (let i = 0; i < 5; i++) { await jest.advanceTimersByTimeAsync(600); jobs.observe('attended'); }
      expect(jobs.status('attended')).toMatchObject({ state: 'running', attended: true });
      await jest.advanceTimersByTimeAsync(1_000);
      await jobs.settled('attended');
      expect(jobs.status('attended')).toMatchObject({ state: 'cancelled', phase: 'settled', cancellation: { reason: 'follower_lost' } });
      expect(jobs.hasActive('studio-one')).toBe(false);
      jobs.submit({ detach: true }, compileScenario({ steps: [] }), 'detached');
      await jest.advanceTimersByTimeAsync(10_000);
      expect(jobs.status('detached')).toMatchObject({ state: 'running', attended: false });
      const cancelled = jobs.cancel('detached');
      await jest.advanceTimersByTimeAsync(0);
      expect(await cancelled).toMatchObject({ state: 'cancelled', cancellation: { reason: 'requested' } });
    } finally {
      jest.useRealTimers();
    }
  });
  test('a run that throws after reaching its runtime is recovered, settles and frees the session', async () => {
    const recover = jest.fn(async () => ({ released: true, runtime: 'stopped' }));
    const jobs = new TestJobs({
      session, runtime, check: async () => true, recover, execute: async (_body, context) => {
        context.job!.ready(runtime());
        throw new Error('transport lost mid-run');
      },
    }, home);
    jobs.submit({ keep_open: false }, compileScenario({ steps: [] }), 'thrown');
    await jobs.settled('thrown');
    expect(recover).toHaveBeenCalledWith(expect.objectContaining({ keep_open: false }), runtime());
    expect(jobs.status('thrown')).toMatchObject({ state: 'failed', execution: 'unknown', phase: 'settled' });
    expect(jobs.result('thrown')).toMatchObject({ passed: false, recovery: { runtime: 'stopped' }, error: { message: expect.stringContaining('transport lost') } });
    expect(jobs.hasActive('studio-one')).toBe(false);
  });
  test('a run that fails before play settles as not started without recovery', async () => {
    const recover = jest.fn();
    const jobs = new TestJobs({
      session, runtime, check: async () => true, recover, execute: async () => { throw new CliCommandError('invalid_scenario', 'preflight rejected'); },
    }, home);
    jobs.submit({}, compileScenario({ steps: [] }), 'preflight');
    await jobs.settled('preflight');
    expect(recover).not.toHaveBeenCalled();
    expect(jobs.status('preflight')).toMatchObject({ state: 'failed', execution: 'not_started' });
    expect(jobs.hasActive('studio-one')).toBe(false);
  });
  test('cancelling queued work sends no input and retains a final result', async () => {
    const execute = jest.fn();
    const jobs = new TestJobs({ session, runtime, check: async () => true, execute }, home);
    jobs.submit({}, compileScenario({ steps: [] }), 'cancel-queued');
    await jobs.cancel('cancel-queued');
    await jobs.settled('cancel-queued');
    expect(execute).not.toHaveBeenCalled();
    expect(jobs.result('cancel-queued')).toMatchObject({ cancelled: true, execution: 'not_started' });
  });
  test('interrupted work remains unknown; recovery requires the same runtime and a satisfied postcondition', async () => {
    let dispatched = false;
    const original = new TestJobs({
      session, runtime, check: async () => true, execute: async (_body, context) => {
        context.job!.ready(runtime());
        context.job!.stepStarted(0, { name: 'purchase' });
        dispatched = true;
        return new Promise(() => { });
      }
    }, home);
    const scenario = compileScenario({ resume_when: { code: 'return sameFarm' }, steps: [{ name: 'purchase', type: 'eval', code: 'buy()', expect: { code: 'return bought' } }, { name: 'inspect', type: 'eval', code: 'return true' }] });
    original.submit({}, scenario, 'interrupted');
    await nextTurn();
    expect(dispatched).toBe(true);
    const check = jest.fn(async () => true);
    const execute = jest.fn(async (_body: Json, context: ToolInvocationContext) => ({ passed: true, startIndex: context.job!.startIndex }));
    const replacement = new TestJobs({ session, runtime, check, execute }, home);
    expect(replacement.status('interrupted')).toMatchObject({ state: 'unknown', in_flight: { index: 0 } });
    await replacement.resume('interrupted');
    await replacement.settled('interrupted');
    expect(check).toHaveBeenCalledTimes(2);
    expect(replacement.result('interrupted')).toMatchObject({ startIndex: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('does not resume into a different play session or infer completion from a false condition', async () => {
    const original = new TestJobs({
      session, runtime, check: async () => true, execute: async (_b, c) => {
        c.job!.ready(runtime());
        c.job!.stepStarted(0, { name: 'mutate' });
        return new Promise(() => { });
      }
    }, home);
    original.submit({}, compileScenario({ resume_when: { code: 'return true' }, steps: [{ type: 'eval', code: 'mutate()' }] }), 'unknown');
    await nextTurn();
    const execute = jest.fn();
    const different = new TestJobs({ session, runtime: () => ['new-runtime'], check: async () => true, execute }, home);
    await expect(different.resume('unknown')).rejects.toMatchObject({ code: 'resume_session_mismatch' });
    const same = new TestJobs({ session, runtime, check: async () => false, execute }, home);
    await expect(same.resume('unknown')).rejects.toMatchObject({ code: 'resume_precondition_failed' });
    expect(execute).not.toHaveBeenCalled();
    // A failed validation restores the job exactly as it was.
    expect(same.status('unknown')).toMatchObject({ state: 'unknown', execution: 'unknown', phase: 'daemon_interrupted', in_flight: { index: 0 } });
  });
  test('rejects overlapping jobs for one instance and unsafe filesystem IDs', async () => {
    const jobs = new TestJobs({ session, runtime, check: async () => true, execute: async () => new Promise(() => { }) }, home);
    jobs.submit({}, compileScenario({ steps: [] }), 'first');
    expect(() => jobs.submit({}, compileScenario({ steps: [] }), 'second')).toThrow(/still owns/);
    expect(() => jobs.status('../escape')).toThrow(/Invalid job/);
    expect(() => jobs.status('..')).toThrow(/Invalid job/);
  });
  test('an uncertain run settles as failed with execution unknown and frees the session', async () => {
    const jobs = new TestJobs({
      session, runtime, check: async () => true, execute: async (_b, c) => {
        c.job!.ready(runtime());
        c.job!.stepStarted(0, { name: 'done' });
        c.job!.stepFinished(0, { name: 'done', passed: true });
        return { passed: false, execution: 'unknown' };
      }
    }, home);
    jobs.submit({}, compileScenario({ steps: [{ type: 'eval', code: 'return true' }] }), 'cleanup-unknown');
    await jobs.settled('cleanup-unknown');
    expect(jobs.status('cleanup-unknown')).toMatchObject({ state: 'failed', execution: 'unknown', next_step: 1 });
    expect(jobs.hasActive('studio-one')).toBe(false);
  });
  test('read-only cancellation resumes only the remaining wait and retains previous receipts', async () => {
    let runs = 0;
    const execute = jest.fn(async (body: Json, c: ToolInvocationContext) => {
      c.job!.ready(runtime());
      if (runs++ === 0) {
        expect(c.requestId).toBe('wait-resume');
        c.job!.stepStarted(0, { name: 'pause' });
        c.job!.stepFinished(0, { name: 'pause', passed: false, result: { requested_ms: 1000, waited_ms: 600 } });
        return { passed: false, steps: [] };
      }
      expect((body.scenario as {
        steps: Json[];
      }).steps[0].duration_ms).toBe(400);
      expect(body.foreground).toBe(false);
      // A resumed attempt gets its own operation ids, so re-running step 0
      // cannot collide with the first attempt's retained operations.
      expect(c.requestId).toBe('wait-resume:attempt-2');
      c.job!.stepStarted(0, { name: 'pause' });
      c.job!.stepFinished(0, { name: 'pause', passed: true });
      return { passed: true, steps: [] };
    });
    const jobs = new TestJobs({ session, runtime, execute, check: async () => true, cleanup: async () => ({ released: true }) }, home);
    jobs.submit({}, compileScenario({ resume_when: { code: 'return true' }, steps: [{ name: 'pause', type: 'wait', duration_ms: 1000 }] }), 'wait-resume');
    await jobs.settled('wait-resume');
    await jobs.resume('wait-resume', { foreground: false });
    await jobs.settled('wait-resume');
    expect(jobs.status('wait-resume')).toMatchObject({ state: 'completed', attempt: 2 });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(`${home}/wait-resume`).filter(x => x.includes('.previous-'))).toHaveLength(2);
  });
  test('overlapping resume checks cannot schedule a second run', async () => {
    let finish!: () => void;
    const jobs = new TestJobs({ session, runtime, check: async () => { await new Promise<void>(r => { finish = r; }); return true; }, execute: async (_b, c) => { c.job!.ready(runtime()); return { passed: false }; } }, home);
    jobs.submit({}, compileScenario({ resume_when: { code: 'return true' }, steps: [] }), 'resume-race');
    await jobs.settled('resume-race');
    const first = jobs.resume('resume-race');
    await expect(jobs.resume('resume-race')).rejects.toMatchObject({ code: 'job_conflict' });
    finish();
    await first;
    await jobs.settled('resume-race');
  });
  const interrupt = async (id: string, ready: boolean) => {
    const original = new TestJobs({
      session, runtime, check: async () => true, execute: async (_b, c) => {
        if (ready) c.job!.ready(runtime());
        c.job!.stepStarted(0, { name: 'hold' });
        return new Promise(() => { });
      }
    }, home);
    original.submit({}, compileScenario({ resume_when: { code: 'return true' }, steps: [{ type: 'eval', code: 'hold()' }] }), id);
    await nextTurn();
    return original;
  };
  test.each([
    ['its playtest ended', true],
    ['it never reached its runtime', false],
  ])('cancelling an interrupted job settles it and frees the session when %s', async (_case, ready) => {
    await interrupt('interrupted', ready);
    const cleanup = jest.fn(async () => ({ released: true }));
    const execute = jest.fn(async () => ({ passed: true }));
    const jobs = new TestJobs({ session, runtime: () => ['server:next-playtest'], check: async () => true, execute, cleanup }, home);
    expect(await jobs.cancel('interrupted')).toMatchObject({
      state: 'cancelled', execution: 'stopped', phase: 'cleanup_runtime_gone',
      cancellation_cleanup: { released: false, reason: 'original_runtime_gone' },
    });
    expect(cleanup).not.toHaveBeenCalled();
    jobs.submit({}, compileScenario({ steps: [] }), 'next');
    await jobs.settled('next');
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('an interrupted job keeps its session while its original peers are live and cleanup fails', async () => {
    await interrupt('held', true);
    const jobs = new TestJobs({ session, runtime, check: async () => true, execute: jest.fn(), cleanup: async () => ({ released: false }) }, home);
    expect(await jobs.cancel('held')).toMatchObject({ state: 'unknown', cancel_requested: true });
    expect(() => jobs.submit({}, compileScenario({ steps: [] }), 'next')).toThrow(/still owns/);
  });
  test('a restored cancellation of a job that never reached its runtime no longer owns the session', async () => {
    const original = await interrupt('restored', false);
    // The daemon dies while this cancel waits for a run that never settles;
    // the request is already on disk.
    void original.cancel('restored');
    const jobs = new TestJobs({ session, runtime, check: async () => true, execute: async () => ({ passed: true }) }, home);
    expect(jobs.status('restored')).toMatchObject({ state: 'cancelled', execution: 'stopped', cancellation_cleanup: { reason: 'original_runtime_gone' } });
    jobs.submit({}, compileScenario({ steps: [] }), 'next');
    await jobs.settled('next');
  });
  const failedJob = async (check: () => Promise<boolean>) => {
    const execute = jest.fn(async (_b: Json, c: ToolInvocationContext) => { c.job!.ready(runtime()); return { passed: false }; });
    const jobs = new TestJobs({ session, runtime, check, execute, cleanup: async () => ({ released: true }) }, home);
    jobs.submit({}, compileScenario({ resume_when: { code: 'return true' }, steps: [] }), 'failed');
    await jobs.settled('failed');
    return { jobs, execute };
  };
  test('resume owns the session while it validates, so no other job is admitted', async () => {
    const checking = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<boolean>();
    const { jobs, execute } = await failedJob(() => { checking.resolve(); return verdict.promise; });
    const resumed = jobs.resume('failed');
    await checking.promise;
    expect(jobs.status('failed')).toMatchObject({ state: 'queued', phase: 'resume_validating' });
    expect(() => jobs.submit({}, compileScenario({ steps: [] }), 'intruder')).toThrow(/still owns/);
    verdict.resolve(true);
    await resumed;
    await jobs.settled('failed');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(jobs.status('intruder')).toBeUndefined();
  });
  test('a cancel during resume validation stops the resume without scheduling a run', async () => {
    const checking = Promise.withResolvers<void>();
    const verdict = Promise.withResolvers<boolean>();
    const { jobs, execute } = await failedJob(() => { checking.resolve(); return verdict.promise; });
    const resumed = jobs.resume('failed');
    await checking.promise;
    await jobs.cancel('failed');
    verdict.resolve(true);
    await expect(resumed).rejects.toMatchObject({ code: 'job_cancelled' });
    await jobs.settled('failed');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(jobs.status('failed')).toMatchObject({ state: 'failed', phase: 'settled' });
    expect(jobs.hasActive('studio-one')).toBe(false);
  });
});
