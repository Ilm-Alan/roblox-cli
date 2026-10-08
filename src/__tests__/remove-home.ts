import { rmSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';

/**
 * Remove a test's temporary home once the work still writing into it has
 * landed. Job records and the instance registry write on real I/O, which can
 * outlive a test (fake timers, a settled promise whose save is still queued).
 * On Windows a write landing mid-removal fails the delete with ENOTEMPTY, so
 * yield one I/O turn, then remove with Node's own retry for a directory that
 * is still filling.
 */
export async function removeHome(directory: string): Promise<void> {
  await nextTurn();
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
