import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

class FakeHelper extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4321;
  kill = jest.fn();
}

const helpers: FakeHelper[] = [];
const spawned: string[] = [];

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn((command: string) => {
    spawned.push(command);
    const child = new FakeHelper();
    if (command !== '/usr/bin/caffeinate') helpers.push(child);
    return child;
  }),
}));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), existsSync: () => true }));

import { acquireFocus, FOREGROUND_REFUSED, type FocusLease } from '../focus-session.js';

/** Acquire a lease through the fake helper and return it with the helper. */
async function acquire(): Promise<{ helper: FakeHelper; lease: FocusLease }> {
  const pending = acquireFocus(true);
  const helper = helpers[helpers.length - 1];
  helper.stdout.write(`${JSON.stringify({ acquired: true, activated: true })}\n`);
  return { helper, lease: await pending };
}

describe('background by default', () => {
  test('without --foreground nothing is spawned: no focus helper, no caffeinate', async () => {
    spawned.length = 0;
    const lease = await acquireFocus(false);
    expect(lease.receipt).toEqual({ foreground: false });
    await expect(lease.release()).resolves.toEqual({ foreground: false });
    expect(spawned).toEqual([]);
  });

  const onDarwin = process.platform === 'darwin' ? test : test.skip;
  onDarwin('a refused activation fails fast with the click-Studio message', async () => {
    const pending = acquireFocus(true);
    const helper = helpers[helpers.length - 1];
    helper.stdout.write(`${JSON.stringify({ error: 'Studio activation was refused', refused: true })}\n`);
    await expect(pending).rejects.toMatchObject({ code: 'foreground_unavailable', message: FOREGROUND_REFUSED });
    expect(FOREGROUND_REFUSED).toMatch(/click Studio or rerun without --foreground/);
  });
});

describe('focus lease release', () => {
  const onDarwin = process.platform === 'darwin' ? test : test.skip;

  onDarwin('reports the helper\'s released line even when exit precedes its output', async () => {
    const { helper, lease } = await acquire();
    const released = lease.release();
    helper.emit('exit', 0, null);
    helper.stdout.end(`${JSON.stringify({ released: true, restored: true, owner_switched: false })}\n`);
    helper.stdout.once('end', () => helper.emit('close', 0, null));
    helper.stdout.resume();
    await expect(released).resolves.toEqual({ released: true, restored: true, owner_switched: false });
  });

  onDarwin('falls back to an exit receipt when the helper never reported release', async () => {
    const { helper, lease } = await acquire();
    const released = lease.release();
    helper.emit('exit', 1, null);
    helper.emit('close', 1, null);
    await expect(released).resolves.toEqual({ restored: false, helper_exited: true });
  });
});
