import { captureWithWorker as captureNativeStudioWindow } from './capture-worker.js';
import { calibratedViewportCapture } from './viewport-capture.js';
import { CliCommandError } from './cli-errors.js';
import type { Json } from './scenario.js';
interface CaptureRequest {
  instance_id: string;
  target: string;
  place_name?: string;
  /** Resolves the native Studio process id when the daemon manages it; binds
   * the window more strongly than the place name. Called only for native capture. */
  nativePid?: () => Promise<number | undefined>;
  format?: 'png' | 'jpeg';
  quality?: number;
  backend?: string;
  crop?: string;
}
export async function captureFrame(request: CaptureRequest, engine: () => Promise<Json>, viewport: () => Promise<unknown>, evaluate?: (code: string) => Promise<Json>): Promise<Json> {
  const backend = request.backend ?? 'auto';
  if (!['auto', 'engine', 'native'].includes(backend))
    throw new CliCommandError('invalid_capture_backend', 'backend must be auto, engine or native');
  const order = backend === 'auto' ? (request.target.startsWith('client-') && process.platform === 'darwin' ? ['native', 'engine'] : ['engine', 'native']) : [backend];
  if (request.crop !== undefined && request.crop !== 'viewport')
    throw new CliCommandError('invalid_crop', 'crop must be viewport');
  if (request.crop && request.backend === 'engine')
    throw new CliCommandError('invalid_crop', 'Verified viewport cropping requires the native backend');
  const attempts: Json[] = [];
  for (const candidate of order) {
    try {
      let image: Json;
      let window: unknown;
      if (candidate === 'native') {
        const identity = { placeName: request.place_name, pid: await request.nativePid?.() };
        if (request.target !== 'edit' && request.target !== 'client-1')
          throw new Error('Native window capture cannot prove which multiplayer client is visible; use engine capture for this target.');
        if (request.crop === 'viewport') {
          if (request.target !== 'client-1' || !evaluate)
            throw new Error('Viewport calibration requires the visible play client');
          const calibrated = await calibratedViewportCapture(identity, evaluate);
          return { ...calibrated, instance_id: request.instance_id, target: request.target, captured_at: new Date().toISOString(), capture_backend: 'native', capture_source: 'macOS screencapture', backend_attempts: attempts.length + 1, capture_fallbacks: attempts };
        }
        const capture = await captureNativeStudioWindow(request.format, request.quality, identity);
        window = capture.window;
        image = { width: capture.width, height: capture.height, mime_type: capture.encodedMimeType, image: { data: capture.encodedData, mime_type: capture.encodedMimeType } };
      }
      else {
        if (request.crop)
          throw new Error('Engine capture cannot provide the requested calibrated crop');
        image = await engine();
      }
      let measurements: unknown;
      try {
        measurements = await viewport();
      }
      catch (error) {
        measurements = { unavailable: String(error) };
      }
      return {
        ...image, instance_id: request.instance_id, target: request.target,
        captured_at: new Date().toISOString(), capture_backend: candidate, capture_source: candidate === 'native' ? 'macOS screencapture' : 'Roblox',
        ...(window ? { window } : {}), viewport: measurements,
        coordinate_mapping: candidate === 'native'
          ? { verified: false, reason: 'Full window includes Studio chrome. No image-to-input conversion is implied.' }
          : { verified: false, reason: 'Engine capture dimensions alone do not prove input scaling.' },
        backend_attempts: attempts.length + 1, ...(attempts.length ? { capture_fallbacks: attempts } : {}),
      };
    }
    catch (error) {
      attempts.push({ backend: candidate, error: error instanceof Error ? error.message : String(error) });
    }
  }
  throw new CliCommandError('screenshot_failed', 'No capture backend produced usable pixels.', { outcome: 'error', details: { attempts, instance_id: request.instance_id, target: request.target } });
}
