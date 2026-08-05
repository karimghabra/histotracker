import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Field, Modal, TextArea } from "./ui";

/**
 * Ask why something is being removed, and refuse to proceed without an answer
 * (#83).
 *
 * Removal is not deletion here — the slides keep their rows and stay in the
 * Logs, flagged, with whatever is typed below shown against them. That makes the
 * reason part of the permanent record rather than a throwaway confirmation, so
 * it is required rather than optional: "why is this slide gone" is the question
 * the log exists to answer, and a blank answer is the one thing a log cannot
 * recover later.
 *
 * Replaces a `confirm()` whose whole content was a warning about letter
 * sequencing — true, but not the thing the technician needed to record.
 */
export function RemovalReasonDialog({
  title,
  what,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  /** What is being removed, e.g. "EE-1-C" or "3 slides" — shown in the prompt. */
  what: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const ready = reason.trim().length > 0;
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3 text-sm text-ink-soft">
        Removing <strong className="text-ink">{what}</strong>.
      </p>
      <div className="mb-3.5 flex gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-soft">
        <AlertTriangle size={14} className="mt-px shrink-0 text-amber-600" />
        <span>
          Nothing is deleted — this stays in the Logs, flagged as removed, with the
          reason below. Slide letters are not reused, so the next slide cut
          continues the sequence rather than taking this one's letter.
        </span>
      </div>
      <Field label="Reason for removal (required)">
        <TextArea
          rows={3}
          value={reason}
          autoFocus
          aria-label="Reason for removal"
          placeholder="e.g. broken during coverslipping; section folded; entered in error"
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={!ready}
          title={ready ? undefined : "Enter a reason first"}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
