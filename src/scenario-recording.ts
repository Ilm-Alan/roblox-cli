import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliCommandError } from './cli-errors.js';
import { stopNativeRecording, activeRecording, type RecordingCrop } from './native-recording.js';
import { activeWorkerSocket, recordWithWorker } from './capture-worker.js';
import { resolveStudioWindow } from './native-screen-capture.js';
import { calibratedViewportRect } from './viewport-capture.js';
import type { Json } from './scenario.js';

/**
 * One continuous video of the play client's viewport, driven by the same job
 * that runs the scenario steps.
 *
 * The recorder is started by the job and stopped by the job, so the video
 * covers play start through scenario end without either process inventing its
 * own timer. The shared clock is the daemon's: every step receipt carries
 * `started_at_ms`/`ended_at_ms` relative to the recording's own start, and the
 * sidecar `timeline.json` next to the video replays the same offsets.
 */

export interface ScenarioRecordingRequest {
  file: string;
  /** Record the whole window instead of the calibrated viewport crop. */
  fullWindow?: boolean;
  fps?: number;
}

export interface RecordingClock {
  /** Wall-clock milliseconds of the moment that is "zero" for offsets. */
  started_at_ms: number;
  started_at: string;
  offset(now: number): number;
}

export interface ScenarioRecordingSession {
  clock: RecordingClock;
  /** The crop the video is actually using, or the fallback reason. */
  viewport: Json;
  calibration: Json;
  /** Stop and finalize. Always safe to call exactly once. */
  finish(reason: string): Promise<Json>;
}

/**
 * Calibrate and start. Calibration failure is never fatal: the caller gets a
 * full-window recording plus an explicit receipt saying so, because a
 * mis-cropped video would be worse evidence than an uncropped one.
 */
export async function startScenarioRecording(
  request: ScenarioRecordingRequest,
  evaluate: (code: string) => Promise<Json>,
  identity: { placeName?: string; pid?: number },
): Promise<ScenarioRecordingSession> {
  if (activeRecording())
    throw new CliCommandError('recording_conflict', 'A recording is already active. Stop it before starting another.', { details: { file: activeRecording()!.file } });

  let calibration: Json = { verified: false, reason: 'not_attempted' };
  let crop: RecordingCrop | undefined;
  if (request.fullWindow) {
    calibration = { verified: false, reason: 'full_window_requested' };
  }
  else {
    try {
      const measured = await calibratedViewportRect(identity, evaluate);
      crop = {
        x: Number(measured.crop.x), y: Number(measured.crop.y),
        width: Number(measured.crop.width), height: Number(measured.crop.height),
        capture_width: measured.capture_width, capture_height: measured.capture_height,
      };
      calibration = {
        verified: true,
        method: 'four_native_gui_markers',
        crop_in_capture: measured.crop,
        capture_width: measured.capture_width,
        capture_height: measured.capture_height,
        viewport: measured.viewport,
        window: measured.window,
        note: 'The crop was measured once, before the first step, and applied to every recorded frame.',
      };
    }
    catch (error) {
      calibration = {
        verified: false,
        reason: error instanceof Error ? error.message : String(error),
        note: 'Calibration failed; the recording covers the whole Studio window. Input coordinates are still the live viewport, so the video is uncropped, not mis-cropped.',
      };
    }
  }

  // A playtest job runs inside the daemon, which cannot assume its starter
  // granted Screen Recording permission. The recorder is started by the
  // terminal-owned capture worker instead, which is the same reason
  // screenshots already take that route.
  //
  // The worker is deliberately NOT created here. A worker spawned by the
  // daemon inherits the daemon's lack of Screen Recording permission, so
  // creating one from this process would produce exactly the capture denial
  // this route exists to avoid. The invoking CLI already ensured a
  // terminal-owned worker; this only checks that one is there.
  // No capture worker exists on Windows, so this is also where Windows refuses.
  if (!activeWorkerSocket())
    throw new CliCommandError(
      'recording_unavailable',
      process.platform === 'darwin'
        ? 'No terminal-owned capture worker is running, so a playtest started here cannot record: Screen Recording permission belongs to the terminal, not to the daemon. Run one screenshot or the playtest from an interactive terminal first.'
        : 'Recording requires macOS 15 or later.',
    );
  const window = await resolveStudioWindow(identity);
  const started = await recordWithWorker({
    file: request.file,
    ...(request.fps === undefined ? {} : { fps: request.fps }),
    window,
    ...(crop === undefined ? {} : { crop }),
  });
  // Offsets are relative to the moment capture began, so a reviewer seeking to
  // a step offset lands on the frame that step produced.
  const startedAt = Date.parse(String(started.started_at));
  const clock: RecordingClock = {
    started_at_ms: startedAt,
    started_at: String(started.started_at),
    offset: now => Math.max(0, now - startedAt),
  };
  const viewport = (started.viewport ?? { mode: 'unknown' }) as Json;
  let finished = false;
  return {
    clock,
    viewport,
    calibration,
    finish: async (reason: string) => {
      if (finished)
        throw new CliCommandError('recording_finished', 'This recording was already finalized.');
      finished = true;
      const receipt = await stopNativeRecording(request.file);
      return { ...receipt, stop_reason: reason, viewport, calibration };
    },
  };
}

export interface TimelineEntry {
  index: number;
  name: string;
  type?: string;
  target?: string;
  passed: boolean;
  started_at_ms: number;
  ended_at_ms: number;
}

export interface TimelineInput {
  file: string;
  clock: RecordingClock;
  recorded: Json;
  calibration: Json;
  steps: TimelineEntry[];
  outcome: Record<string, unknown>;
}

/**
 * The sidecar a reviewer opens first: the recording receipt, the calibration
 * receipt, and one seekable row per scenario step.
 */
export function writeTimeline(input: TimelineInput): { file: string; entries: number } {
  const file = join(dirname(input.file), 'timeline.json');
  const timeline = {
    video: input.file,
    recording: input.recorded,
    viewport_calibration: input.calibration,
    clock: { started_at: input.clock.started_at, offsets_are_ms_from_recording_start: true },
    outcome: input.outcome,
    steps: input.steps,
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(timeline, null, 1)}\n`, { mode: 0o600 });
  return { file, entries: input.steps.length };
}
