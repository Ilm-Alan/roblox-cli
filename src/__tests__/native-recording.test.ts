import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RECORDING_SECONDS, recorderArguments, requestStop, stopNativeRecording } from '../native-recording.js';
import { selectStudioWindow, type StudioWindow } from '../native-screen-capture.js';

const argumentValue = (arguments_: string[], name: string) => {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
};

describe('recorder arguments', () => {
  test('an uncapped recording still passes the runaway cap', () => {
    const arguments_ = recorderArguments('/helper', '/out.mp4', '/s.sock', '/s.json', 7, 42, { file: '/out.mp4' });
    expect(argumentValue(arguments_, '--seconds')).toBe(String(MAX_RECORDING_SECONDS));
    expect(argumentValue(arguments_, '--socket')).toBe('/s.sock');
    expect(argumentValue(arguments_, '--window-id')).toBe('7');
    expect(argumentValue(arguments_, '--owner-pid')).toBe('42');
    expect(Number(argumentValue(arguments_, '--start-timeout'))).toBeGreaterThan(0);
    expect(arguments_).not.toContain('--crop');
  });

  test('an explicit cap and crop are forwarded unchanged', () => {
    const arguments_ = recorderArguments('/helper', '/out.mp4', '/s.sock', '/s.json', 7, 42, {
      file: '/out.mp4', seconds: 12.5, fps: 24,
      crop: { x: 1, y: 2, width: 300, height: 200, capture_width: 800, capture_height: 600 },
    });
    expect(argumentValue(arguments_, '--seconds')).toBe('12.5');
    expect(argumentValue(arguments_, '--fps')).toBe('24');
    expect(argumentValue(arguments_, '--crop')).toBe('1,2,300,200');
    expect(argumentValue(arguments_, '--capture-width')).toBe('800');
  });
});

describe('studio window selection', () => {
  const window = (id: number, pid: number, title: string): StudioWindow => ({ id, pid, title, bounds: {} });

  test('a place name never binds a window of a longer place name', () => {
    const windows = [window(1, 10, 'Test2 - Roblox Studio'), window(2, 20, 'Test - Roblox Studio')];
    expect(selectStudioWindow(windows, { placeName: 'Test' }).id).toBe(2);
    expect(() => selectStudioWindow([window(1, 10, 'Test2 - Roblox Studio')], { placeName: 'Test' })).toThrow();
  });

  test('the whole title or a parenthesised suffix names the place', () => {
    expect(selectStudioWindow([window(1, 10, 'Test'), window(2, 20, 'Other')], { placeName: 'Test' }).id).toBe(1);
    expect(selectStudioWindow([window(1, 10, 'Test (Play)'), window(2, 20, 'Other')], { placeName: 'Test' }).id).toBe(1);
  });

  test('an explicit pid that shows one window binds it regardless of title', () => {
    const windows = [window(1, 10, 'Renamed - Roblox Studio'), window(2, 20, 'Test - Roblox Studio')];
    expect(selectStudioWindow(windows, { placeName: 'Test', pid: 10 }).id).toBe(1);
  });

  test('the place name narrows a pid that shows several windows', () => {
    const windows = [window(1, 10, 'Other - Roblox Studio'), window(2, 10, 'Test - Roblox Studio'), window(3, 20, 'Test - Roblox Studio')];
    expect(selectStudioWindow(windows, { placeName: 'Test', pid: 10 }).id).toBe(2);
  });

  test('an ambiguous or empty match refuses to bind', () => {
    expect(() => selectStudioWindow([window(1, 10, 'A'), window(2, 20, 'B')])).toThrow();
    expect(() => selectStudioWindow([window(1, 10, 'A')], { pid: 99 })).toThrow();
  });
});

/** A stand-in for the recorder's control socket that answers each connection
 * with the next scripted reply. */
async function controlServer(path: string, replies: string[], onStop?: () => void): Promise<{ server: Server; lines: string[] }> {
  const lines: string[] = [];
  const server = createServer((connection: Socket) => {
    let received = '';
    connection.on('data', chunk => {
      received += chunk.toString();
      if (!received.includes('\n')) return;
      lines.push(received.trim());
      const reply = replies[Math.min(lines.length - 1, replies.length - 1)];
      if (reply.includes('"stopping":true')) onStop?.();
      connection.end(reply);
    });
  });
  server.listen(path);
  await once(server, 'listening');
  return { server, lines };
}

// The recorder's control channel is a Unix socket path; recording is macOS-only.
(process.platform === 'win32' ? describe.skip : describe)('stop request', () => {
  let directory: string;
  let server: Server | undefined;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'rc-stop-'));
  });

  afterEach(async () => {
    if (server) {
      server.close();
      await once(server, 'close');
      server = undefined;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test('retries until the recorder confirms it is stopping', async () => {
    const socketPath = join(directory, 'c.sock');
    const control = await controlServer(socketPath, ['{"active":true}\n', '{"stopping":true}\n']);
    server = control.server;
    await expect(requestStop(socketPath, 5, 0)).resolves.toMatchObject({ stopping: true });
    expect(control.lines).toEqual(['stop', 'stop']);
  });

  test('reports a refusal after every attempt was answered without stopping', async () => {
    const socketPath = join(directory, 'c.sock');
    const control = await controlServer(socketPath, ['{"active":true}\n']);
    server = control.server;
    await expect(requestStop(socketPath, 3, 0)).resolves.toMatchObject({ stopping: false });
    expect(control.lines).toHaveLength(3);
  });

  test('a missing control socket is not a stop', async () => {
    await expect(requestStop(join(directory, 'missing.sock'), 2, 0)).resolves.toMatchObject({ stopping: false });
  });
});

// Recording is macOS-only: stopNativeRecording refuses other hosts before the protocol runs.
(process.platform === 'darwin' ? describe : describe.skip)('stopping a recording', () => {
  const previousHome = process.env.ROBLOX_CLI_HOME;
  let home: string;
  let server: Server | undefined;
  let recorder: ChildProcess | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'rc-rec-'));
    process.env.ROBLOX_CLI_HOME = home;
  });

  afterEach(async () => {
    recorder?.kill('SIGKILL');
    recorder = undefined;
    if (server) {
      server.close();
      await once(server, 'close');
      server = undefined;
    }
    if (previousHome === undefined) delete process.env.ROBLOX_CLI_HOME;
    else process.env.ROBLOX_CLI_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  /** Register a live stand-in recorder process in the recording index. */
  async function registerRecording(): Promise<{ socketPath: string; stateFile: string; file: string; pid: number }> {
    const directory = join(home, 'recordings');
    mkdirSync(directory, { recursive: true });
    recorder = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await once(recorder, 'spawn');
    const pid = recorder.pid!;
    const socketPath = join(directory, 'r.sock');
    const stateFile = join(directory, 'r.state.json');
    const file = join(home, 'out.mp4');
    writeFileSync(stateFile, JSON.stringify({ active: true, file, pid }));
    writeFileSync(join(directory, 'r.json'), JSON.stringify({
      id: 'r', file, socket: socketPath, state_file: stateFile, pid, started_at: new Date().toISOString(),
    }));
    return { socketPath, stateFile, file, pid };
  }

  test('returns the receipt the recorder finalized after accepting the stop', async () => {
    const { socketPath, stateFile, file } = await registerRecording();
    const control = await controlServer(socketPath, ['{"active":true}\n', '{"stopping":true}\n'], () => {
      writeFileSync(stateFile, JSON.stringify({ active: false, file, receipt: { file, stop_reason: 'stopped' } }));
    });
    server = control.server;
    await expect(stopNativeRecording(file)).resolves.toMatchObject({ file, stop_reason: 'stopped', bytes: 0 });
    expect(control.lines).toEqual(['stop', 'stop']);
  });

  test('fails at once when the recorder exits without finalizing', async () => {
    const { socketPath, file } = await registerRecording();
    const exited = once(recorder!, 'exit');
    const control = await controlServer(socketPath, ['{"stopping":true}\n'], () => recorder!.kill('SIGKILL'));
    server = control.server;
    // The finalization wait allows 30 s; a dead recorder must end it long before.
    await expect(stopNativeRecording(file)).rejects.toThrow(file);
    await exited;
  }, 10_000);
});
