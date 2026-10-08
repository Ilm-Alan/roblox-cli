import { readdirSync, rmSync } from 'node:fs';
import { setImmediate as nextTurn } from 'node:timers/promises';

/**
 * Remove a test's temporary home once the work still writing into it has
 * landed. Durable job records, recording state and the instance registry
 * write on real I/O and can outlive the call a test awaited: a playtest
 * returns its result while its job is still persisting. On Windows a write
 * landing mid-removal fails the delete with ENOTEMPTY, so yield one I/O turn,
 * then remove with Node's retry (linear backoff, about 2.75 s in all). If it
 * still fails, say what is left, since that names the writer.
 */
export async function removeHome(directory: string): Promise<void> {
  await nextTurn();
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch (error) {
    let left: string[] = [];
    try { left = readdirSync(directory, { recursive: true }).map(String); } catch { /* already gone */ }
    throw new Error(`Could not remove test home ${directory} (${String(error)}); still there: ${left.join(', ') || 'nothing'}`);
  }
}
