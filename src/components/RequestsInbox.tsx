import { useMemo, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import type { StainRequest, StainRequestStatus } from "../lib/types";
import { Button, Modal } from "./ui";

const STATUS_STYLES: Record<StainRequestStatus, string> = {
  requested: "bg-amber-100 text-amber-800",
  acknowledged: "bg-sky-100 text-sky-800",
  done: "bg-emerald-100 text-emerald-800",
  rejected: "bg-gray-200 text-gray-600",
};

const STATUS_LABEL: Record<StainRequestStatus, string> = {
  requested: "Requested",
  acknowledged: "Acknowledged",
  done: "Done",
  rejected: "Rejected",
};

export function RequestsInbox({
  title,
  requests,
  onSetStatus,
  mineFilterName,
  onClose,
}: {
  title: string;
  requests: StainRequest[];
  /** Provided for the workstation inbox; omit for the viewer's read-only list. */
  onSetStatus?: (id: number, status: StainRequestStatus) => void;
  /** When set (viewer), shows a Mine/All toggle filtering by requester name. */
  mineFilterName?: string;
  onClose: () => void;
}) {
  const readOnly = !onSetStatus;
  const [scope, setScope] = useState<"mine" | "all">("mine");

  const displayed = useMemo(() => {
    if (!mineFilterName || scope === "all") return requests;
    return requests.filter(
      (r) => r.requester_name.toLowerCase() === mineFilterName.toLowerCase(),
    );
  }, [requests, mineFilterName, scope]);

  return (
    <Modal title={title} onClose={onClose} width="max-w-2xl">
      {mineFilterName && (
        <div className="mb-3 grid w-40 grid-cols-2 rounded-md border border-line bg-panel p-0.5 text-xs">
          <button
            onClick={() => setScope("mine")}
            className={`rounded px-2 py-1 ${scope === "mine" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
          >
            Mine
          </button>
          <button
            onClick={() => setScope("all")}
            className={`rounded px-2 py-1 ${scope === "all" ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
          >
            All
          </button>
        </div>
      )}
      {displayed.length === 0 && (
        <p className="py-8 text-center text-sm text-ink-faint">No requests.</p>
      )}
      <div className="space-y-2">
        {displayed.map((request) => {
          const status = request.status as StainRequestStatus;
          return (
            <div key={request.id} className="rounded-xl border border-line bg-panel px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    <span>{request.requested_assay || "Stain"}</span>
                    <span className="text-ink-faint">·</span>
                    <span className="font-mono text-xs text-ink-soft">{request.sample_code}</span>
                    {request.slide_code && (
                      <span className="font-mono text-[11px] text-ink-faint">({request.slide_code})</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-faint">
                    {request.requester_name || "Unknown"} · {request.created_at}
                    {request.resolved_by && ` · resolved by ${request.resolved_by}`}
                  </p>
                  {request.note && <p className="mt-1 text-xs text-ink-soft">{request.note}</p>}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_STYLES[status] ?? ""}`}>
                  {STATUS_LABEL[status] ?? status}
                </span>
              </div>

              {!readOnly && (
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {status === "requested" && (
                    <Button variant="subtle" className="px-2 py-1 text-xs" onClick={() => onSetStatus!(request.id, "acknowledged")}>
                      Acknowledge
                    </Button>
                  )}
                  {(status === "requested" || status === "acknowledged") && (
                    <>
                      <Button variant="primary" className="px-2 py-1 text-xs" onClick={() => onSetStatus!(request.id, "done")}>
                        <Check size={13} /> Mark done
                      </Button>
                      <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => onSetStatus!(request.id, "rejected")}>
                        <X size={13} /> Reject
                      </Button>
                    </>
                  )}
                  {(status === "done" || status === "rejected") && (
                    <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => onSetStatus!(request.id, "acknowledged")}>
                      <RotateCcw size={13} /> Reopen
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
