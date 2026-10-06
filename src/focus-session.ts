import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { packageRoot } from './daemon-control.js';
import { CliCommandError } from './cli-errors.js';
export interface FocusLease {
  receipt: Record<string, unknown>;
  release(): Promise<Record<string, unknown>>;
}

/** The message a refused activation fails with, before any playtest starts. */
export const FOREGROUND_REFUSED = 'macOS refused to bring Studio forward while another app is in use; click Studio or rerun without --foreground.';

/**
 * Studio runs in the background unless the caller explicitly opts in with
 * `--foreground`. Every input path is engine-side virtual input, and capture
 * and recording work with Studio behind another app; the only thing the
 * foreground buys is Studio's full render rate (it throttles itself to about
 * 15 fps when it is not the frontmost app), so it is an opt-in for full-rate
 * video, never a requirement.
 *
 * Without the opt-in this spawns nothing: no focus helper, no caffeinate, no
 * display wake. With it, the helper activates Studio once, fails fast when
 * macOS refuses, keeps the display awake for the lease only, and restores the
 * previous app on release unless the owner switched apps meanwhile.
 */
export async function acquireFocus(foreground: boolean): Promise<FocusLease> {
  if (!foreground)
    return { receipt: { foreground: false }, release: async () => ({ foreground: false }) };
  const helper = join(packageRoot(), 'dist/native/focus-session');
  if (process.platform !== 'darwin' || !existsSync(helper))
    throw new CliCommandError('foreground_unavailable', '--foreground needs the native focus helper; run npm run build in roblox-cli, or rerun without --foreground.');
  const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let settled = false;
  let releasedLine: Record<string, unknown> | undefined;
  const { promise: released, resolve: releaseResult } = Promise.withResolvers<Record<string, unknown>>();
  const { promise: acquired, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const timeout = setTimeout(() => { child.kill(); reject(new CliCommandError('foreground_unavailable', 'Focus helper did not acknowledge acquisition.')); }, 10000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  // 'exit' can precede the last stdout data, so the receipt is decided only
  // once stdio has drained: the helper's own `released` line wins, and the
  // exit fallback applies only when it never wrote one.
  child.once('close', () => {
    clearTimeout(timeout);
    if (!settled)
      reject(new CliCommandError('foreground_unavailable', 'Focus helper exited before acquisition.'));
    releaseResult(releasedLine ?? { restored: false, helper_exited: true });
  });
  child.stdout.on('data', data => {
    buffer += data.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.error) {
          clearTimeout(timeout);
          reject(new CliCommandError('foreground_unavailable', value.refused === true ? FOREGROUND_REFUSED : String(value.error)));
        }
        else if (value.acquired) {
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        }
        else if (value.released)
          releasedLine = value;
      }
      catch { /* Keep stderr and protocol separate. */ }
    }
  });
  const receipt = { foreground: true, ...await acquired };
  // Keep the display awake only for this opted-in lease, never otherwise.
  const awake = child.pid ? spawn('/usr/bin/caffeinate', ['-d', '-i', '-u', '-w', String(child.pid)], { stdio: 'ignore' }) : undefined;
  awake?.on('error', () => { });
  child.once('exit', () => awake?.kill());
  let closing = false;
  return {
    receipt, release: async () => {
      if (!closing) {
        closing = true;
        child.stdin.end('\n');
      }
      return Promise.race([released, new Promise<Record<string, unknown>>(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve({ restored: false, release_timeout: true }); }, 3000);
        timer.unref();
        void released.then(() => clearTimeout(timer));
      })]);
    }
  };
}
