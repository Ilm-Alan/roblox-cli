import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { packageRoot } from './daemon-control.js';

const execFileAsync = promisify(execFile);

export interface NativeScreenCapture {
  width: number;
  height: number;
  nativeWidth: number;
  nativeHeight: number;
  encodedData: string;
  encodedMimeType: 'image/jpeg' | 'image/png';
  captureSource: 'macOS screencapture';
  window: { id: number; pid: number; title: string; bounds: Record<string, number> };
}

export type StudioWindow = NativeScreenCapture['window'];

function clampQuality(quality: number | undefined): number {
  return quality === undefined ? 92 : Math.max(1, Math.min(100, Math.floor(quality)));
}

/** Bind to exactly one window. An explicit pid is the stronger identity: when
 * it names one window that window is used, and the place name only narrows a
 * process that shows several. A title names a place only as the whole title or
 * followed by Studio's own suffix (" - Roblox Studio", " (Play)"), so place
 * "Test" never binds a window titled "Test2 - Roblox Studio". */
export function selectStudioWindow(windows: StudioWindow[], identity?: { placeName?: string; pid?: number }): StudioWindow {
  let matches = windows;
  if (identity?.pid) matches = matches.filter(w => w.pid === identity.pid);
  const placeName = identity?.placeName;
  if (placeName && !(identity?.pid && matches.length === 1)) {
    matches = matches.filter(w => w.title === placeName || w.title.startsWith(`${placeName} - `) || w.title.startsWith(`${placeName} (`));
  }
  if (matches.length !== 1) throw new Error(`Cannot uniquely bind capture to the requested Studio window (${matches.length} matches). No arbitrary window was captured.`);
  return matches[0];
}

/** The on-screen, layer-0 Studio windows, listed by the precompiled
 * `studio-windows` helper. It only reads the window list and never activates
 * Studio. */
export async function listStudioWindows(): Promise<StudioWindow[]> {
  if (process.platform !== 'darwin') {
    throw new Error('Native Studio window capture is only available on macOS.');
  }
  const helper = join(packageRoot(), 'dist', 'native', 'studio-windows');
  if (!existsSync(helper))
    throw new Error('The Studio window helper is missing. Run npm run build in roblox-cli.');
  const result = await execFileAsync(helper, [], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  const parsed = JSON.parse(String(result.stdout)) as unknown;
  if (!Array.isArray(parsed))
    throw new Error('The Studio window helper did not return a window list.');
  return parsed.map(entry => {
    const window = entry as Partial<StudioWindow>;
    return { id: Number(window.id), pid: Number(window.pid), title: String(window.title ?? ''), bounds: window.bounds ?? {} };
  });
}

/** Resolve the one Studio window a native helper may bind to. Recording reuses
 * this so a second open Studio can never make it capture an arbitrary window. */
export async function resolveStudioWindow(identity?: { placeName?: string; pid?: number }): Promise<StudioWindow> {
  return selectStudioWindow(await listStudioWindows(), identity);
}

function imageDimensions(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.subarray(0, 8).compare(Buffer.from('\x89PNG\r\n\x1a\n', 'binary')) !== 0) {
    throw new Error('macOS screencapture returned an invalid PNG.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('macOS screencapture returned an empty image.');
  return { width, height };
}

/**
 * Capture the visible Roblox Studio window when Roblox's in-game capture
 * APIs cannot provide pixels from an embedded play client. The helper is
 * deliberately macOS-only and never selects an arbitrary application window.
 */
export async function captureNativeStudioWindow(
  format: 'jpeg' | 'png' = 'jpeg',
  quality?: number,
  identity?: { placeName?: string; pid?: number },
): Promise<NativeScreenCapture> {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'roblox-cli-capture-'));
  const pngPath = join(tempDirectory, 'window.png');
  const outputPath = format === 'png' ? pngPath : join(tempDirectory, 'window.jpg');

  try {
    const window = await resolveStudioWindow(identity);
    const windowId = window.id;
    await execFileAsync('screencapture', ['-x', '-o', '-l', String(windowId), pngPath], {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    const png = readFileSync(pngPath);
    const dimensions = imageDimensions(png);

    if (format === 'jpeg') {
      await execFileAsync('sips', [
        '-s', 'format', 'jpeg',
        '-s', 'formatOptions', String(clampQuality(quality)),
        pngPath,
        '--out', outputPath,
      ], {
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    }

    const encoded = readFileSync(outputPath).toString('base64');
    return {
      ...dimensions,
      nativeWidth: dimensions.width,
      nativeHeight: dimensions.height,
      encodedData: encoded,
      encodedMimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      captureSource: 'macOS screencapture',
      window,
    };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}
