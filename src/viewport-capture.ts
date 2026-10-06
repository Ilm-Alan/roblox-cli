import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { packageRoot } from './daemon-control.js';
import type { NativeScreenCapture } from './native-screen-capture.js';
import { captureWithWorker as captureNativeStudioWindow } from './capture-worker.js';
import type { Json } from './scenario.js';
const execute = promisify(execFile);
const start = (name: string) => `
local p=game.Players.LocalPlayer;local c=workspace.CurrentCamera
local gui=Instance.new("ScreenGui");gui.Name=${JSON.stringify(name)};gui.IgnoreGuiInset=true;gui.ScreenInsets=Enum.ScreenInsets.None;gui.ClipToDeviceSafeArea=false;gui.DisplayOrder=2147483647;gui.ResetOnSpawn=false
for i,color in {Color3.fromRGB(251,3,127),Color3.fromRGB(3,251,127),Color3.fromRGB(127,3,251),Color3.fromRGB(251,127,3)} do
 local f=Instance.new("Frame");f.BorderSizePixel=0;f.BackgroundColor3=color;f.Size=UDim2.fromOffset(8,8);f.AnchorPoint=Vector2.new((i-1)%2,if i>2 then 1 else 0);f.Position=UDim2.fromScale((i-1)%2,if i>2 then 1 else 0);f.Parent=gui
end
gui.Parent=p.PlayerGui;task.delay(8,function() gui:Destroy() end)
game:GetService("RunService").RenderStepped:Wait();game:GetService("RunService").RenderStepped:Wait()
return {width=gui.AbsoluteSize.X,height=gui.AbsoluteSize.Y,input_width=c.ViewportSize.X,input_height=c.ViewportSize.Y}
`;
// Recaptures allowed while the composited window catches up with the markers;
// the markers stay up for 8 s, far longer than these attempts take.
const MARKER_ATTEMPTS = 4;
const MARKER_RETRY_MS = 250;
/** Window bounds compared by value: the native helper's JSON object has no
 * stable key order, so two captures of an unmoved window can serialize apart. */
export function sameBounds(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}
// Whole measurements allowed while a just-started playtest's view settles.
const CALIBRATION_ATTEMPTS = 3;
const CALIBRATION_SETTLE_MS = 500;
/** A capture-to-viewport mapping, with the marker-free capture it was verified on. */
interface ViewportMeasure {
  crop: Json;
  window: NativeScreenCapture['window'];
  capture_width: number;
  capture_height: number;
  viewport: Json;
  capture: NativeScreenCapture;
}
/** The window or the live viewport moved while it was being measured. */
class ViewportChangedError extends Error { }
/** Derive the one crop rectangle that maps a native window capture onto the
 * live play viewport. The four-marker calibration is shared by still capture
 * and by recording, so a recording and a screenshot of the same session agree
 * on where the viewport is. The verification capture is returned with the crop
 * because it is already marker-free: callers that need clean pixels (the still
 * capture) get them for free, and recording takes only the rectangle.
 * A view still settling (a playtest's viewport moves a pixel or two right
 * after it starts) is measured again rather than discarded. */
export async function calibratedViewportRect(identity: {
  placeName?: string;
  pid?: number;
}, evaluate: (code: string) => Promise<Json>): Promise<ViewportMeasure> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await measureViewport(identity, evaluate);
    }
    catch (error) {
      if (!(error instanceof ViewportChangedError) || attempt >= CALIBRATION_ATTEMPTS) throw error;
      await sleep(CALIBRATION_SETTLE_MS);
    }
  }
}
async function measureViewport(identity: {
  placeName?: string;
  pid?: number;
}, evaluate: (code: string) => Promise<Json>): Promise<ViewportMeasure> {
  const marker = `RobloxCliCalibration_${randomUUID()}`;
  const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-viewport-'));
  try {
    let dimensions: Json;
    let calibration: NativeScreenCapture;
    try {
      dimensions = await evaluate(start(marker));
      if (dimensions.width !== dimensions.input_width || dimensions.height !== dimensions.input_height)
        throw new Error('Calibration canvas and input viewport dimensions differ');
      // A Studio window behind other apps renders slowly (~15 fps), so the
      // composited window can trail the frame the markers were drawn in.
      // Recapture briefly before calling the markers missing.
      const file = join(directory, 'calibration.png');
      let found: { stdout: string } | undefined;
      for (let attempt = 1; ; attempt++) {
        calibration = await captureNativeStudioWindow('png', 100, identity);
        writeFileSync(file, Buffer.from(calibration.encodedData, 'base64'), { mode: 0o600 });
        try {
          found = await execute(join(packageRoot(), 'dist/native/viewport-image'), ['locate', file, String(dimensions.width), String(dimensions.height)], { timeout: 20000, maxBuffer: 64 * 1024 });
          break;
        }
        catch (error) {
          const missing = error instanceof Error && error.message.includes('markers were not all visible');
          if (!missing || attempt >= MARKER_ATTEMPTS) throw error;
          await sleep(MARKER_RETRY_MS);
        }
      }
      // A crop is only usable while the window and the live viewport still
      // match the capture it was measured on. Resize invalidates the mapping.
      const full = await captureNativeStudioWindow('png', 100, identity);
      const current = await evaluate('return {width=workspace.CurrentCamera.ViewportSize.X,height=workspace.CurrentCamera.ViewportSize.Y}');
      const changed = [
        ...(full.window.id !== calibration.window.id ? [`window id ${calibration.window.id} -> ${full.window.id}`] : []),
        ...(!sameBounds(full.window.bounds, calibration.window.bounds) ? [`window bounds ${JSON.stringify(calibration.window.bounds)} -> ${JSON.stringify(full.window.bounds)}`] : []),
        ...(current.width !== dimensions.width || current.height !== dimensions.height ? [`viewport ${String(dimensions.width)}x${String(dimensions.height)} -> ${String(current.width)}x${String(current.height)}`] : []),
      ];
      if (changed.length)
        throw new ViewportChangedError(`Window or viewport changed during calibration (${changed.join('; ')}); mapping discarded`);
      return {
        crop: JSON.parse(found.stdout) as Json,
        window: full.window,
        capture_width: full.width,
        capture_height: full.height,
        viewport: dimensions,
        capture: full,
      };
    }
    finally {
      await evaluate(`local g=game.Players.LocalPlayer.PlayerGui:FindFirstChild(${JSON.stringify(marker)});if g then g:Destroy() end;game:GetService("RunService").RenderStepped:Wait();game:GetService("RunService").RenderStepped:Wait();return {cleaned=true}`);
    }
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function calibratedViewportCapture(identity: {
  placeName?: string;
  pid?: number;
}, evaluate: (code: string) => Promise<Json>): Promise<Json> {
  const measured = await calibratedViewportRect(identity, evaluate);
  const { crop, full } = { crop: measured.crop, full: measured.capture };
  const directory = mkdtempSync(join(tmpdir(), 'roblox-cli-viewport-'));
  try {
    const source = join(directory, 'full.png'), output = join(directory, 'viewport.png');
    writeFileSync(source, Buffer.from(full.encodedData, 'base64'), { mode: 0o600 });
    await execute(join(packageRoot(), 'dist/native/viewport-image'), ['crop', source, output, String(crop.x), String(crop.y), String(crop.width), String(crop.height)], { timeout: 10000, maxBuffer: 64 * 1024 });
    return {
      width: crop.width, height: crop.height, mime_type: 'image/png', image: { data: readFileSync(output).toString('base64'), mime_type: 'image/png' },
      original: { width: full.width, height: full.height, image: { data: full.encodedData, mime_type: 'image/png' } },
      window: full.window, viewport: measured.viewport,
      coordinate_mapping: { verified: true, method: 'four_native_gui_markers', crop_in_original: crop, input_scale: { x: Number(measured.viewport.width) / Number(crop.width), y: Number(measured.viewport.height) / Number(crop.height) }, input_origin: { x: 0, y: 0 }, note: 'Mapping applies to this capture only; recalibrate after resize or camera viewport changes.' },
    };
  }
  finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
