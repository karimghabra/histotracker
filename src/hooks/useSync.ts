import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SyncConfigPublic } from "../lib/syncConfig";
import { drainRequests, publishSnapshot, pullSnapshotIfNewer } from "../lib/githubSync";

const SYNC_INTERVAL_MS = 120_000; // 2 minutes

// Query keys refreshed after a sync brings in new data.
const REFRESH_KEYS = [
  "projects",
  "open-samples",
  "open-sections",
  "processing-batches",
  "section-slides",
  "sample-timeline",
  "extra-slides",
  "stain-requests",
];

export interface SyncState {
  syncing: boolean;
  error: string | null;
  lastSyncedAt: Date | null;
  lastMessage: string | null;
  /** Manual "Sync now" — runs the same cycle as the interval. */
  syncNow: () => Promise<void>;
}

/**
 * Drives the periodic + manual sync loop. The workstation drains incoming
 * requests and republishes the snapshot; the viewer pulls a newer snapshot when
 * one exists. React Query is invalidated whenever new data actually arrives.
 */
export function useSync(config: SyncConfigPublic | null): SyncState {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  // Guard against overlapping runs (interval firing while a manual sync runs).
  const running = useRef(false);

  const invalidateAll = useCallback(() => {
    for (const key of REFRESH_KEYS) qc.invalidateQueries({ queryKey: [key] });
  }, [qc]);

  const runCycle = useCallback(async () => {
    if (!config?.configured) return;
    if (running.current) return;
    running.current = true;
    setSyncing(true);
    setError(null);
    try {
      if (config.role === "workstation") {
        const ingested = await drainRequests();
        if (ingested > 0) invalidateAll();
        await publishSnapshot();
        setLastMessage(
          ingested > 0
            ? `Imported ${ingested} request${ingested === 1 ? "" : "s"}, published snapshot`
            : "Published snapshot",
        );
      } else if (config.role === "viewer") {
        const result = await pullSnapshotIfNewer();
        if (result.updated) {
          invalidateAll();
          setLastMessage("Pulled latest snapshot");
        } else {
          setLastMessage("Up to date");
        }
      }
      setLastSyncedAt(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      running.current = false;
      setSyncing(false);
    }
  }, [config, invalidateAll]);

  // Sync on mount / config change, then on a fixed interval.
  useEffect(() => {
    if (!config?.configured) return;
    void runCycle();
    const id = setInterval(() => void runCycle(), SYNC_INTERVAL_MS);
    return () => clearInterval(id);
  }, [config, runCycle]);

  return { syncing, error, lastSyncedAt, lastMessage, syncNow: runCycle };
}
