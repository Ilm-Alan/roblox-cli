import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

class FakeCaffeinate extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 777_001;
  unref = jest.fn();
  kill = jest.fn();
}

const children: FakeCaffeinate[] = [];

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn(() => {
    const child = new FakeCaffeinate();
    children.push(child);
    return child;
  }),
}));
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  return { ...actual, existsSync: (path: string) => path.endsWith('record-studio') || actual.existsSync(path) };
});

import { RECORDER_ACK_TIMEOUT_MS, spawnRecorder } from '../native-recording.js';

describe('recorder start', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rc-spawn-'));
    process.env.ROBLOX_CLI_HOME = home;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test('releases the recorder pipes once capture is acknowledged', async () => {
    const started = spawnRecorder({ file: join(home, 'a.mp4'), window: { id: 1, pid: 2 } });
    const child = children[children.length - 1];
    child.stdout.write(`${JSON.stringify({ started: true, pid: 4242, started_at: new Date().toISOString() })}\n`);
    await expect(started).resolves.toMatchObject({ started: true, pid: 4242 });
    expect(child.unref).toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  test('an unacknowledged start kills the whole recorder process group', async () => {
    jest.useFakeTimers();
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const started = spawnRecorder({ file: join(home, 'b.mp4'), window: { id: 1, pid: 2 } });
    const child = children[children.length - 1];
    const rejected = expect(started).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(RECORDER_ACK_TIMEOUT_MS);
    await rejected;
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(child.stdout.destroyed).toBe(true);
  });
});
