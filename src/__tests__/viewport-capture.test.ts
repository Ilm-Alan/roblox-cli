// Two captures of one unmoved window: the native helper's JSON gives the
// bounds' keys in no fixed order, which used to discard every calibration.
const captures = [
  { X: 0, Y: 32, Width: 1512, Height: 930 },
  { Width: 1512, Y: 32, X: 0, Height: 930 },
];
let captureIndex = 0;
jest.mock('../capture-worker.js', () => ({
  captureWithWorker: jest.fn(async () => ({
    width: 1512, height: 930, encodedData: 'AA==', encodedMimeType: 'image/png',
    window: { id: 7, pid: 4242, title: 'Place - Roblox Studio', bounds: captures[captureIndex++ % captures.length] },
  })),
}));
jest.mock('node:child_process', () => ({
  execFile: jest.fn((_file: string, _args: string[], _options: unknown, callback: (error: unknown, result: unknown) => void) => {
    callback(null, { stdout: JSON.stringify({ x: 0, y: 60, width: 1280, height: 720 }), stderr: '' });
  }),
}));
import { calibratedViewportRect } from '../viewport-capture.js';

const viewport = { width: 1280, height: 720, input_width: 1280, input_height: 720 };

describe('viewport calibration', () => {
  beforeEach(() => { captureIndex = 0; });

  test('an unmoved window whose bounds serialize in another key order keeps its mapping', async () => {
    const evaluate = jest.fn(async (code: string) => code.includes('ScreenGui') ? viewport : code.includes('ViewportSize') ? { width: 1280, height: 720 } : { cleaned: true });
    const measured = await calibratedViewportRect({ placeName: 'Place', pid: 4242 }, evaluate);
    expect(measured.crop).toEqual({ x: 0, y: 60, width: 1280, height: 720 });
  });

  test('a viewport that moves a pixel while the playtest settles is measured again', async () => {
    let checks = 0;
    const evaluate = jest.fn(async (code: string) => {
      if (code.includes('ScreenGui')) return viewport;
      if (code.includes('ViewportSize')) return checks++ === 0 ? { width: 1279, height: 721 } : { width: 1280, height: 720 };
      return { cleaned: true };
    });
    const measured = await calibratedViewportRect({ placeName: 'Place', pid: 4242 }, evaluate);
    expect(measured.crop).toEqual({ x: 0, y: 60, width: 1280, height: 720 });
    expect(checks).toBe(2);
  });

  test('a window that really moved discards the mapping and says what changed', async () => {
    captures[1] = { X: 40, Y: 32, Width: 1512, Height: 930 };
    const evaluate = jest.fn(async (code: string) => code.includes('ScreenGui') ? viewport : code.includes('ViewportSize') ? { width: 1280, height: 720 } : { cleaned: true });
    await expect(calibratedViewportRect({ placeName: 'Place', pid: 4242 }, evaluate)).rejects.toThrow(/window bounds .*"X":0.* -> .*"X":40/);
  });
});
