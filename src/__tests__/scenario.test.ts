import { compileScenario, scenarioNeedsInput } from '../scenario.js';
import { selectStudioWindow } from '../native-screen-capture.js';
describe('scenario preflight', () => {
  test('rejects a late invalid action before any part of the scenario can execute', () => {
    expect(() => compileScenario({ steps: [{ type: 'keyboard', key_code: 'E' }, { type: 'teleport', position: [1, 2, 3] }] })).toThrow(/unsupported step/);
    expect(() => compileScenario({ steps: [{ type: 'keyboard', key_code: 'E', duration_ms: 50, action: 'press' }] })).toThrow(/duration requires/);
    expect(() => compileScenario({ steps: [{ type: 'click_world', path: ['Workspace', 'Cow'], position: [0, 0, 0] }] })).toThrow(/choose path or position/);
    expect(() => compileScenario({ steps: [{ type: 'wait_until', code: 'return true', timout_ms: 5 }] })).toThrow(/unknown field/);
  });
  test('expands reusable named actions with typed data parameters and no code interpolation', () => {
    const result = compileScenario({ actions: { inspect: { parameters: ['target'], steps: [{ name: 'click', type: 'click_gui', path: { $param: 'target' } }] } }, steps: [{ type: 'use', name: 'sell', action: 'inspect', args: { target: ['Trade', 'Ship'] } }] });
    expect(result.steps).toEqual([{ type: 'click_gui', name: 'sell/click', path: ['Trade', 'Ship'] }]);
    expect(scenarioNeedsInput(result)).toBe(true);
    expect(() => compileScenario({ actions: { recur: { parameters: [], steps: [{ type: 'use', action: 'recur' }] } }, steps: [{ type: 'use', action: 'recur' }] })).toThrow(/recursive/);
  });
  test('normalizes duration units and truthfully names condition samples', () => {
    const result = compileScenario({ steps: [{ type: 'keyboard', key_code: 'E', duration: .08 }, { type: 'wait', duration: 80 }, { type: 'wait_until', code: 'return true', stable_frames: 2, interval_ms: 200 }] });
    expect(result.steps.map(s => s.duration_ms)).toEqual([80, 80, undefined]);
    expect(result.steps[2]).toMatchObject({ stable_samples: 2, interval_ms: 200 });
    expect(result.warnings).toHaveLength(2);
    expect(scenarioNeedsInput(compileScenario({ steps: [{ type: 'eval', code: 'return true' }] }))).toBe(false);
    expect(scenarioNeedsInput(compileScenario({ steps: [{ type: 'eval', code: 'sendInput()', interactive: true }] }))).toBe(true);
  });
  test('capture selects the requested Studio window instead of whichever window is first', () => {
    const windows = [{ id: 1, pid: 10, title: 'Other.rbxl', bounds: {} }, { id: 2, pid: 20, title: 'Sample.rbxl - Studio', bounds: {} }];
    expect(selectStudioWindow(windows, { placeName: 'Sample.rbxl' }).id).toBe(2);
    expect(() => selectStudioWindow(windows)).toThrow(/uniquely bind/);
    expect(() => selectStudioWindow(windows, { placeName: 'Missing.rbxl' })).toThrow(/uniquely bind/);
  });
});
