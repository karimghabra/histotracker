import type { StainRequest } from "./types";

/**
 * A viewer's own just-submitted stain requests, held OUTSIDE the database
 * (issue #71).
 *
 * Two things make a viewer unable to remember its own request in SQLite:
 *   1. a viewer is read-only — `guardWrites` in db.ts rejects every write, and
 *   2. every pull REPLACES the whole SQLite image with the workstation's, so
 *      anything written locally would be discarded on the next sync anyway.
 *
 * So a submitted request lived only as a JSON file in the repo until the
 * workstation drained it (up to one sync interval), published a new snapshot,
 * and the viewer pulled it (another interval). Until that round-trip completed,
 * "My requests" was simply empty — and if any step failed the request vanished
 * with no trace on the requesting machine. That is the reported desync.
 *
 * localStorage survives the image swap, so the request is visible immediately
 * and stays visible until the real row comes back in a snapshot, at which point
 * it is pruned by uuid.
 */
const KEY = "histometer-pending-requests";

export interface PendingRequest {
  uuid: string;
  sample_code: string;
  slide_code: string;
  requested_assay: string;
  requester_name: string;
  note: string;
  created_at: string;
}

export function listPendingRequests(): PendingRequest[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingRequest[]) : [];
  } catch {
    // A corrupt entry must never take the app down — treat it as empty.
    return [];
  }
}

export function addPendingRequest(entry: PendingRequest): void {
  try {
    const next = [...listPendingRequests().filter((p) => p.uuid !== entry.uuid), entry];
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Out of quota / private mode: the request was still submitted, so losing
    // the local echo is a cosmetic failure, not a functional one.
  }
}

/** Drop entries the synced snapshot now carries, matched by uuid. */
export function prunePendingRequests(synced: StainRequest[]): void {
  if (synced.length === 0) return;
  const known = new Set(synced.map((r) => r.uuid));
  const remaining = listPendingRequests().filter((p) => !known.has(p.uuid));
  try {
    window.localStorage.setItem(KEY, JSON.stringify(remaining));
  } catch {
    // Ignore — the merge below de-duplicates by uuid regardless.
  }
}

/**
 * Synced requests plus any local ones the snapshot has not caught up with.
 * Pending entries are surfaced as ordinary "requested" rows with a negative id,
 * so the existing inbox renders them without special-casing; the negative id
 * also guarantees they can never collide with a real row.
 */
export function mergePendingRequests(synced: StainRequest[]): StainRequest[] {
  const known = new Set(synced.map((r) => r.uuid));
  const pending = listPendingRequests().filter((p) => !known.has(p.uuid));
  if (pending.length === 0) return synced;
  const asRequests: StainRequest[] = pending.map((p, index) => ({
    id: -(index + 1),
    uuid: p.uuid,
    sample_code: p.sample_code,
    slide_code: p.slide_code,
    requested_assay: p.requested_assay,
    requester_name: p.requester_name,
    note: p.note,
    status: "requested",
    created_at: p.created_at,
    ingested_at: "",
    resolved_by: "",
    resolved_at: null,
  }));
  return [...asRequests, ...synced];
}
