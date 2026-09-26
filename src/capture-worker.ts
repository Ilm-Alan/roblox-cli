import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, daemonPidPath } from './paths.js';
import { packageRoot } from './daemon-control.js';
import { captureNativeStudioWindow, type NativeScreenCapture } from './native-screen-capture.js';
import { activeRecording, RECORDER_ACK_TIMEOUT_MS, spawnRecorder, type StartRecordingRequest } from './native-recording.js';
const socket = () => join(dataDirectory(), 'capture.sock');
const RECORDING_ROUTE = '/record';
/** Whether a terminal-owned worker is reachable. The daemon must never create
 * one: a worker spawned by the daemon inherits the Screen Recording permission
 * of whatever started the daemon, often none, and is refused by ScreenCaptureKit. */
export function activeWorkerSocket(): boolean {
  return existsSync(socket());
}

async function call(body?: unknown, path = '/capture'): Promise<NativeScreenCapture | {
  ready: true;
}> {
  // Starting a recording waits for the recorder's own acknowledgement, which
  // may legitimately take longer than a screenshot.
  const timeout = body === undefined ? 1000 : path === RECORDING_ROUTE ? RECORDER_ACK_TIMEOUT_MS + 5000 : 30000;
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket(), path: body ? path : '/health', method: body ? 'POST' : 'GET', timeout, headers: { 'Content-Type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode !== 200)
            reject(new Error(result.error));
          else
            resolve(result);
        }
        catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('Capture worker timed out')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
/** Spawn from the invoking terminal so macOS retains its Screen Recording permission.
 * This helper has no Studio input, evaluation, lifecycle, or TCP endpoint. */
export async function ensureCaptureWorker(): Promise<void> {
  if (process.platform !== 'darwin')
    return;
  try {
    await call();
    return;
  }
  catch { /* Start a worker only when none responds. */ }
  const worker = spawn(process.execPath, [join(packageRoot(), 'dist/capture-worker-main.js')], { detached: true, stdio: 'ignore' });
  worker.unref();
  worker.on('error', () => { });
  for (let attempt = 0;attempt < 30;attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      await call();
      return;
    }
    catch { /* Wait for the private socket. */ }
  }
  throw new Error('The native capture worker did not start');
}
export async function captureWithWorker(format?: 'png' | 'jpeg', quality?: number, identity?: {
  placeName?: string;
  pid?: number;
}): Promise<NativeScreenCapture> {
  if (existsSync(socket())) {
    try {
      return await call({ format, quality, identity }) as NativeScreenCapture;
    }
    catch (workerError) {
      try {
        return await captureNativeStudioWindow(format, quality, identity);
      }
      catch (directError) {
        throw new Error(`Capture worker: ${String(workerError)}; daemon capture: ${String(directError)}`);
      }
    }
  }
  return captureNativeStudioWindow(format, quality, identity);
}
/**
 * Ask the terminal-owned worker to start the native recorder.
 *
 * Screen Recording permission belongs to the responsible application. The
 * detached daemon has whatever its starter had, often nothing (SCK -3801),
 * while the worker started by the invoking terminal is allowed. Daemon-side
 * recording therefore goes through the worker, exactly like screenshot capture.
 */
export async function recordWithWorker(request: StartRecordingRequest & { window: { id: number; pid: number } }): Promise<Record<string, unknown>> {
  if (!existsSync(socket()))
    throw new Error('The terminal-owned capture worker is not running, so a recording started here would have no Screen Recording permission. Run one screenshot or the playtest from an interactive terminal first.');
  return await call(request, RECORDING_ROUTE) as unknown as Record<string, unknown>;
}

export async function runCaptureWorker(): Promise<void> {
  mkdirSync(dataDirectory(), { recursive: true, mode: 0o700 });
  try {
    await call();
    return;
  }
  catch { /* A dead worker may have left its socket. */ }
  const lock = join(dataDirectory(), 'capture-worker.pid');
  if (existsSync(lock)) {
    try {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (pid > 0) {
        process.kill(pid, 0);
        return;
      }
    }
    catch { /* Previous worker is gone. */ }
    try {
      unlinkSync(lock);
    }
    catch { /* Another invoker won the race. */ }
  }
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  catch {
    return;
  }
  try {
    unlinkSync(socket());
  }
  catch { /* No stale socket. */ }
  let lastUsed = Date.now(), pending = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/health') {
      lastUsed = Date.now();
      response.end('{"ready":true}');
      return;
    }
    if (request.method !== 'POST' || (request.url !== '/capture' && request.url !== RECORDING_ROUTE)) {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    const recordingRoute = request.url === RECORDING_ROUTE;
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length; if (bytes > 8192)
        request.destroy();
      else
        chunks.push(chunk);
    });
    request.on('end', async () => {
      pending++;
      lastUsed = Date.now();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (recordingRoute) {
          // The recorder inherits this process's Screen Recording permission.
          // The daemon cannot assume its starter granted one, which is why
          // recording is requested here rather than spawned from the daemon.
          response.end(JSON.stringify(await spawnRecorder(body)));
          return;
        }
        if (body.format !== undefined && !['png', 'jpeg'].includes(body.format))
          throw new Error('Invalid capture format');
        if (body.quality !== undefined && (typeof body.quality !== 'number' || !Number.isFinite(body.quality)))
          throw new Error('Invalid quality');
        if (body.identity !== undefined && (!body.identity || typeof body.identity !== 'object'
          || (body.identity.placeName !== undefined && typeof body.identity.placeName !== 'string')
          || (body.identity.pid !== undefined && !Number.isInteger(body.identity.pid))))
          throw new Error('Invalid window identity');
        const image = await captureNativeStudioWindow(body.format, body.quality, body.identity);
        response.end(JSON.stringify(image));
      }
      catch (error) {
        response.writeHead(422);
        response.end(JSON.stringify({ error: String(error) }));
      }
      finally {
        pending--;
        lastUsed = Date.now();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket(), () => { chmodSync(socket(), 0o600); resolve(); }); });
  // Keep detached scenario captures available while the owning daemon has work.
  const activeJobs = () => {
    try {
      const pid = Number(readFileSync(daemonPidPath(), 'utf8'));
      process.kill(pid, 0);
      const root = join(dataDirectory(), 'test-jobs');
      return readdirSync(root).some(id => {
        try {
          return ['queued', 'running', 'cancelling'].includes(JSON.parse(readFileSync(join(root, id, 'job.json'), 'utf8')).state);
        }
        catch {
          return false;
        }
      });
    }
    catch {
      return false;
    }
  };
  // A recording outlives the request that started it, so an idle worker must
  // not exit from under the recorder it spawned. Liveness is the recorder's
  // pid, so a recorder that died without rewriting its state cannot pin the
  // worker forever.
  const idle = setInterval(() => {
    if (!pending && Date.now() - lastUsed > 300000 && !activeJobs() && activeRecording() === undefined) {
      clearInterval(idle);
      server.close();
    }
  }, 30000);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const file of [socket(), lock]) {
      try {
        unlinkSync(file);
      }
      catch { /* Already removed. */ }
    }
  };
  server.on('close', cleanup);
  process.once('exit', cleanup);
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => { clearInterval(idle); server.close(); });
}
