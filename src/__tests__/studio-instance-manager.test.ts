import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ManagedInstanceRegistry, reclaimStaleLock } from '../managed-instance-registry.js';
import {
  StudioInstanceManager,
  parseStudioProcessLine,
  type StudioProcessInfo,
} from '../studio-instance-manager.js';

function managedRecord(instanceId: string, closedAt?: number) {
  return {
    version: 1 as const,
    recordId: `record-${instanceId.replaceAll(':', '-')}`, // Record files must be valid Windows names.
    instanceId,
    source: 'local_file',
    nativeProcessId: 4242,
    spawnPid: 4242,
    exe: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
    args: ['--task', 'EditFile', '--localPlaceFile', '/tmp/Sample.rbxl'],
    localPlaceFile: '/tmp/Sample.rbxl',
    launchedAt: 1,
    attachedAt: 2,
    state: 'exited' as const,
    closedAt,
    bootId: 'test-boot',
    processObservationStatus: 'not_running' as const,
  };
}

const studioProcess: StudioProcessInfo = {
  Id: 4242,
  Name: 'RobloxStudio',
  Path: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
  CommandLine: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio --task EditFile --localPlaceFile /tmp/Sample.rbxl',
};

describe('Studio instance close lifecycle', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'roblox-cli-manager-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  test('closes a process that was incorrectly marked closed but is still alive', async () => {
    let running = true;
    const stopProcess = jest.fn(() => { running = false; });
    const registry = new ManagedInstanceRegistry(registryDir);
    await registry.upsert(managedRecord('instance:stale', Date.now() - 1000));
    const manager = new StudioInstanceManager({
      registry,
      closeGraceMs: 20,
      closePollMs: 1,
      processAdapter: {
        currentBootId: () => 'test-boot',
        listStudioProcesses: () => running ? [studioProcess] : [],
        stopProcess,
      },
    });

    await expect(manager.closeByInstanceId('instance:stale')).resolves.toMatchObject({
      status: 'closed',
      instanceId: 'instance:stale',
    });
    expect(stopProcess).toHaveBeenCalledWith(4242, undefined);
    expect(running).toBe(false);
  });

  test('forces a verified Studio process after graceful close times out', async () => {
    let running = true;
    const forceStopProcess = jest.fn(() => { running = false; });
    const registry = new ManagedInstanceRegistry(registryDir);
    await registry.upsert(managedRecord('instance:stuck'));
    const manager = new StudioInstanceManager({
      registry,
      closeGraceMs: 5,
      closePollMs: 1,
      processAdapter: {
        currentBootId: () => 'test-boot',
        listStudioProcesses: () => running ? [studioProcess] : [],
        stopProcess: jest.fn(),
        forceStopProcess,
      },
    });

    await expect(manager.closeByInstanceId('instance:stuck')).resolves.toMatchObject({
      status: 'closed',
      instanceId: 'instance:stuck',
    });
    expect(forceStopProcess).toHaveBeenCalledWith(4242, undefined);
    expect(running).toBe(false);
  });

  test('closes the connected instance whose main window names its place when several Studios run', async () => {
    const other: StudioProcessInfo = { ...studioProcess, Id: 4343, StartTimeUtcFileTime: '2000' };
    const target: StudioProcessInfo = { ...studioProcess, StartTimeUtcFileTime: '1000' };
    let running = [other, target];
    const stopProcess = jest.fn((pid: number) => { running = running.filter((candidate) => candidate.Id !== pid); });
    const bounds = (Width: number, Height: number) => ({ X: 0, Y: 0, Width, Height });
    const manager = new StudioInstanceManager({
      registry: new ManagedInstanceRegistry(registryDir),
      closeGraceMs: 20,
      closePollMs: 1,
      processAdapter: {
        currentBootId: () => 'test-boot',
        listStudioProcesses: () => running,
        listStudioWindows: () => [
          { id: 1, pid: 4343, title: 'Farmland - Roblox Studio', bounds: bounds(1600, 900), layer: 0 },
          { id: 2, pid: 4242, title: 'Output', bounds: bounds(300, 200), layer: 0 },
          { id: 3, pid: 4242, title: 'Sample - Roblox Studio', bounds: bounds(1600, 900), layer: 0 },
        ],
        stopProcess,
      },
    });
    const instance = { instanceId: 'instance:sample', role: 'edit', placeId: 1, placeName: 'Sample', dataModelName: 'Sample' };

    await manager.closeConnectedInstance(instance);
    expect(stopProcess).toHaveBeenCalledWith(4242, '1000');
    expect(running).toEqual([other]);
  });

  test('does not guess between several Studios when window titles are unavailable', async () => {
    const stopProcess = jest.fn();
    const manager = new StudioInstanceManager({
      registry: new ManagedInstanceRegistry(registryDir),
      processAdapter: {
        currentBootId: () => 'test-boot',
        listStudioProcesses: () => [studioProcess, { ...studioProcess, Id: 4343 }],
        listStudioWindows: () => undefined,
        stopProcess,
      },
    });
    await expect(manager.closeConnectedInstance({ instanceId: 'instance:sample', role: 'edit', placeId: 1, placeName: 'Sample', dataModelName: 'Sample' }))
      .rejects.toThrow(/Could not find a Studio process/);
    expect(stopProcess).not.toHaveBeenCalled();
  });
});

describe('Studio launch', () => {
  let registryDir: string;

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'roblox-cli-launch-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  function launcher() {
    const exited = Promise.withResolvers<(code: number | null, signal: NodeJS.Signals | null) => void>();
    const state = { processes: [] as StudioProcessInfo[] };
    const registry = new ManagedInstanceRegistry(registryDir);
    const manager = new StudioInstanceManager({
      registry,
      processAdapter: {
        currentBootId: () => 'test-boot',
        resolveStudioExe: () => studioProcess.Path!,
        listStudioProcesses: () => state.processes,
        // Never signal real pids: stopping only removes the fake process.
        stopProcess: (id) => { state.processes = state.processes.filter((entry) => entry.Id !== id); },
        spawnStudio: () => {
          state.processes = [{ ...studioProcess, Id: 5000, StartTimeUtcFileTime: '1000' }];
          return { pid: 5000, nativePid: 5000, unref: () => undefined, onExit: (listener) => exited.resolve(listener) };
        },
      },
    });
    return { manager, registry, state, exit: exited.promise };
  }

  async function settle(condition: () => boolean) {
    for (let turn = 0; turn < 200 && !condition(); turn++) await nextTurn();
  }

  test('follows Studio when it relaunches itself before the plugin connects', async () => {
    const { manager, state, exit } = launcher();
    const record = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/Sample.rbxl', connectionTimeoutMs: 60_000 });
    // The update installer relaunches Studio, naming the process that started it.
    state.processes = [{ ...studioProcess, Id: 5001, StartTimeUtcFileTime: '2000', CommandLine: `${studioProcess.Path} -isInstallerLaunch true -parentPid 5000 -parentSessionGuid x` }];
    (await exit)(0, null);
    await settle(() => record.nativeProcessId === 5001);
    expect(record).toMatchObject({ nativeProcessId: 5001, nativeProcessStartedAt: '2000', state: 'launching' });
    expect(record.closedAt).toBeUndefined();
    await manager.close(record);
  });

  test('a Studio that fails before the plugin connects is reported at once', async () => {
    const { manager, registry, state, exit } = launcher();
    const record = await manager.launch({ source: 'local_file', localPlaceFile: '/tmp/Sample.rbxl', connectionTimeoutMs: 60_000 });
    const exitPersisted = Promise.withResolvers<void>();
    const upsert = registry.upsert.bind(registry);
    jest.spyOn(registry, 'upsert').mockImplementation(async (entry) => {
      await upsert(entry);
      if (entry.state === 'exited') exitPersisted.resolve();
    });
    state.processes = [];
    (await exit)(1, null);
    await exitPersisted.promise;
    expect(record).toMatchObject({ state: 'exited', exitCode: 1 });
    await expect(manager.getByLaunchId(record.recordId!)).resolves.toMatchObject({ state: 'exited' });
  });
});

describe('macOS Studio process enumeration', () => {
  test('keeps only Studio main executables and reads their start time as UTC', () => {
    const lines = [
      '  4242 Tue Sep 15 14:19:56 2026 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio -task EditFile -localPlaceFile /tmp/Sample.rbxl',
      '  4244 Sun Sep  6 09:05:07 2026 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
      '  4250 Tue Sep 15 14:20:01 2026 /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP --stdio',
      '  4251 Tue Sep 15 14:20:02 2026 /Applications/RobloxStudio.app/Contents/MacOS/RobloxCrashHandler --pid 4242',
      '  4252 Tue Sep 15 14:20:03 2026 /Users/example/Downloads/RobloxStudioInstaller.app/Contents/MacOS/RobloxStudioInstaller',
      '  4253 Tue Sep 15 14:20:04 2026 /usr/bin/open -a /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
      '  4254 Tue Sep 15 14:20:05 2026 /bin/zsh -c pgrep -fl RobloxStudio',
      '',
    ];
    expect(lines.map(parseStudioProcessLine).filter((value) => value !== undefined)).toEqual([
      {
        Id: 4242,
        Name: 'RobloxStudio',
        Path: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
        CommandLine: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio -task EditFile -localPlaceFile /tmp/Sample.rbxl',
        StartTimeUtcFileTime: String(Date.parse('2026-09-15T14:19:56Z')),
      },
      {
        Id: 4244,
        Name: 'RobloxStudio',
        Path: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
        CommandLine: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
        StartTimeUtcFileTime: String(Date.parse('2026-09-06T09:05:07Z')),
      },
    ]);
  });
});

describe('managed instance registry', () => {
  let registryDir: string;
  const deadOwner = { pid: 99_999_999, token: 'dead-owner', createdAt: 1 };

  beforeEach(() => {
    registryDir = mkdtempSync(join(tmpdir(), 'roblox-cli-registry-'));
  });

  afterEach(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  function abandonLock(): string {
    const lockDir = join(registryDir, '.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(deadOwner));
    return lockDir;
  }

  test('two contenders reclaiming a dead owner\'s lock leave exactly one holder', async () => {
    const lockDir = abandonLock();
    const stale = { stat: statSync(lockDir), owner: deadOwner };

    const moved = await Promise.all([reclaimStaleLock(lockDir, stale), reclaimStaleLock(lockDir, stale)]);
    expect(moved.filter(Boolean)).toHaveLength(1);

    // The winner acquires. A contender still acting on its earlier judgement
    // of the dead owner's lock must leave the live lock alone.
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'winner', createdAt: Date.now() }));
    await expect(reclaimStaleLock(lockDir, stale)).resolves.toBe(false);
    expect(readdirSync(lockDir)).toEqual(['owner.json']);
    expect(JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')).token).toBe('winner');
  });

  test('registry users contending for a dead owner\'s lock never hold it together', async () => {
    await new ManagedInstanceRegistry(registryDir).upsert({ ...managedRecord('instance:live'), state: 'connected' });
    abandonLock();
    let holders = 0;
    let maxHolders = 0;
    const observeProcess = async () => {
      maxHolders = Math.max(maxHolders, ++holders);
      await nextTurn();
      holders--;
      return { status: 'running' as const, observedAt: Date.now() };
    };
    await Promise.all([1, 2, 3].map(() => new ManagedInstanceRegistry(registryDir).sweep({ currentBootId: 'test-boot', observeProcess })));
    expect(maxHolders).toBe(1);
    expect(readdirSync(registryDir).filter((name) => name.includes('.lock'))).toEqual([]);
  });

  test('an observation that changes nothing but timestamps does not rewrite the record', async () => {
    const registry = new ManagedInstanceRegistry(registryDir);
    await registry.upsert({ ...managedRecord('instance:live'), state: 'connected', processObservationStatus: 'running' });
    const file = join(registryDir, 'record-instance-live.json');
    const sweep = (observation: { status: 'running'; observedAt: number } | { status: 'unknown'; observedAt: number; error: string }) =>
      registry.sweep({ currentBootId: 'test-boot', observeProcess: () => observation });

    await sweep({ status: 'running', observedAt: 1000 });
    const persisted = readFileSync(file, 'utf8');
    await sweep({ status: 'running', observedAt: 2000 });
    expect(readFileSync(file, 'utf8')).toBe(persisted);

    await sweep({ status: 'unknown', observedAt: 3000, error: 'ps failed' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ processObservationStatus: 'unknown', lastProcessObservationAt: 3000 });
  });
});
