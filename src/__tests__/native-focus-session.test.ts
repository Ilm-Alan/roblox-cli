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

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  spawn: jest.fn((command: string) => {
    const child = new FakeHelper();
    if (command !== '/usr/bin/caffeinate') helpers.push(child);
    return child;
  }),
}));
jest.mock('node:fs', () => ({ ...jest.requireActual('node:fs'), existsSync: () => true }));

import { acquireFocus, type FocusLease } from '../focus-session.js';

/** Acquire a lease through the fake helper and return it with the helper. */
async function acquire(): Promise<{ helper: FakeHelper; lease: FocusLease }> {
  const pending = acquireFocus('auto', true);
  const helper = helpers[helpers.length - 1];
  helper.stdout.write(`${JSON.stringify({ acquired: true, activated: true })}\n`);
  return { helper, lease: await pending };
}

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
