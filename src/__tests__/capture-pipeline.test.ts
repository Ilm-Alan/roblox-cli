jest.mock('../capture-worker.js', () => ({
  captureWithWorker: jest.fn(async () => ({
    width: 2, height: 2, encodedData: 'AA==', encodedMimeType: 'image/png',
    window: { id: 7, pid: 4242, title: 'Place - Roblox Studio', bounds: {} },
  })),
}));
jest.mock('../viewport-capture.js', () => ({ calibratedViewportCapture: jest.fn() }));
import { captureFrame } from '../capture-pipeline.js';
import { captureWithWorker } from '../capture-worker.js';

const engine = async () => ({ width: 1, height: 1 });
const viewport = async () => ({ kind: 'edit' });

describe('native capture window binding', () => {
  afterEach(() => jest.clearAllMocks());

  test('an engine capture never looks up the Studio process', async () => {
    const nativePid = jest.fn(async () => 4242);
    await captureFrame({ instance_id: 'i', target: 'edit', place_name: 'Place', nativePid }, engine, viewport);
    expect(nativePid).not.toHaveBeenCalled();
    expect(captureWithWorker).not.toHaveBeenCalled();
  });

  test('a native capture binds the window to the managed Studio process', async () => {
    const nativePid = jest.fn(async () => 4242);
    await captureFrame({ instance_id: 'i', target: 'edit', place_name: 'Place', backend: 'native', nativePid }, engine, viewport);
    expect(captureWithWorker).toHaveBeenCalledWith(undefined, undefined, { placeName: 'Place', pid: 4242 });
  });
});
