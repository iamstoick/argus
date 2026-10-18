/** Background audit worker: periodic dead-code + duplicate + secret reports per project. Never fatal. */
import type { ArgusDb } from './db.js';
import type { IndexManager } from './projects.js';
import { scanProjectSecrets } from './secrets.js';
import { deadCodeData, duplicateGroupsData } from './tools.js';

export type AuditKind = 'dead-code' | 'duplicates' | 'secrets';

/** Report limits: the worker precomputes what the admin UI shows (top entries). */
const AUDIT_LIMIT = 50;

export interface AuditWorkerHandle {
  stop: () => void;
}

/**
 * Compute and store one round of audit reports for a project. Each kind is
 * independent: a failure in one still stores the others. Returns stored
 * kinds. The secret scan needs the workspace root to read files; without it
 * only the structural kinds run.
 */
export function runAuditOnce(db: ArgusDb, root?: string): AuditKind[] {
  const stored: AuditKind[] = [];
  try {
    db.storeAuditReport('dead-code', deadCodeData(db, false, AUDIT_LIMIT));
    stored.push('dead-code');
  } catch {
    // Best effort: a broken analysis must not wedge the worker.
  }
  try {
    db.storeAuditReport('duplicates', duplicateGroupsData(db, AUDIT_LIMIT));
    stored.push('duplicates');
  } catch {
    // Best effort: a broken analysis must not wedge the worker.
  }
  if (root !== undefined) {
    try {
      db.storeAuditReport('secrets', scanProjectSecrets(db, root));
      stored.push('secrets');
    } catch {
      // Best effort: a broken scan must not wedge the worker.
    }
  }
  return stored;
}

/**
 * Run an immediate audit, then repeat every intervalMs across all projects.
 * The timer is unref'd so it never holds the process open; stop() ends it.
 */
export function startAuditWorker(
  manager: IndexManager,
  intervalMs: number,
  onError: (msg: string) => void,
): AuditWorkerHandle {
  const tick = (): void => {
    for (const name of manager.names()) {
      try {
        const entry = manager.get(name);
        if (entry !== undefined) runAuditOnce(entry.db, entry.root);
      } catch (err) {
        onError(`audit worker for '${name}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop: () => clearInterval(timer),
  };
}
