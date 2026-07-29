import { beforeEach, describe, expect, it } from "vitest";
import {
  addPendingRequest,
  listPendingRequests,
  mergePendingRequests,
  prunePendingRequests,
} from "./pendingRequests";
import type { StainRequest } from "./types";

function synced(uuid: string, overrides: Partial<StainRequest> = {}): StainRequest {
  return {
    id: 1,
    uuid,
    sample_code: "EE-0001",
    slide_code: "",
    requested_assay: "H&E",
    requester_name: "Laptop",
    note: "",
    status: "requested",
    created_at: "2026-07-28 10:00",
    ingested_at: "2026-07-28 10:01",
    resolved_by: "",
    resolved_at: null,
    ...overrides,
  };
}

const pending = {
  uuid: "abc",
  sample_code: "EE-0001",
  slide_code: "",
  requested_assay: "H&E",
  requester_name: "Laptop",
  note: "",
  created_at: "2026-07-28 10:00",
};

describe("pending viewer requests (#71)", () => {
  beforeEach(() => window.localStorage.clear());

  it("a submitted request is visible before the round-trip completes", () => {
    addPendingRequest(pending);
    const merged = mergePendingRequests([]);
    expect(merged).toHaveLength(1);
    expect(merged[0].uuid).toBe("abc");
    expect(merged[0].requester_name).toBe("Laptop");
    // Surfaced as an ordinary "requested" row so the inbox needs no special case.
    expect(merged[0].status).toBe("requested");
  });

  it("does not duplicate once the snapshot carries the same request", () => {
    addPendingRequest(pending);
    const merged = mergePendingRequests([synced("abc")]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(1); // the real row won, not the local echo
  });

  it("keeps a pending request that the snapshot has not caught up with", () => {
    addPendingRequest(pending);
    const merged = mergePendingRequests([synced("other-uuid")]);
    expect(merged.map((r) => r.uuid).sort()).toEqual(["abc", "other-uuid"]);
  });

  it("pruning drops only the entries the snapshot now has", () => {
    addPendingRequest(pending);
    addPendingRequest({ ...pending, uuid: "def" });
    prunePendingRequests([synced("abc")]);
    expect(listPendingRequests().map((p) => p.uuid)).toEqual(["def"]);
  });

  it("re-adding the same uuid does not stack duplicates", () => {
    addPendingRequest(pending);
    addPendingRequest(pending);
    expect(listPendingRequests()).toHaveLength(1);
  });

  it("survives corrupt storage rather than throwing", () => {
    window.localStorage.setItem("histometer-pending-requests", "{not json");
    expect(listPendingRequests()).toEqual([]);
    expect(mergePendingRequests([])).toEqual([]);
  });

  it("pending rows carry negative ids so they cannot collide with real ones", () => {
    addPendingRequest(pending);
    expect(mergePendingRequests([])[0].id).toBeLessThan(0);
  });
});
