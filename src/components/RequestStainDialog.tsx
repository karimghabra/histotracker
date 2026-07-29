import { useState } from "react";
import { Send } from "lucide-react";
import { Button, Field, Modal, TextArea, TextInput } from "./ui";
import { submitRequest } from "../lib/githubSync";
import { addPendingRequest } from "../lib/pendingRequests";
import { nowTimestamp } from "../lib/utils";

export function RequestStainDialog({
  operatorName,
  sampleCodes,
  exhaustedSampleCodes = [],
  catalog,
  defaultSampleCode,
  onSubmitted,
  onClose,
}: {
  operatorName: string;
  sampleCodes: string[];
  /** Blocks marked exhausted — they cannot be cut again (#70). */
  exhaustedSampleCodes?: string[];
  catalog: Array<{ assay_type: string; name: string }>;
  defaultSampleCode?: string;
  onSubmitted: (message: string) => void;
  onClose: () => void;
}) {
  const [sampleCode, setSampleCode] = useState(defaultSampleCode ?? "");
  const [slideCode, setSlideCode] = useState("");
  // "assay_type::name" — the same encoding the bench "Request a Stain" control uses.
  const [agent, setAgent] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An exhausted block has no tissue left to cut, so a request against it could
  // never be fulfilled (#70). Catch it here, at the point of asking, rather than
  // letting it sit unactioned in the workstation inbox.
  const exhausted = new Set(exhaustedSampleCodes.map((c) => c.toUpperCase()));
  const chosenIsExhausted = Boolean(sampleCode.trim()) && exhausted.has(sampleCode.trim().toUpperCase());

  async function submit() {
    if (!sampleCode.trim()) {
      setError("Choose the sample this request is for.");
      return;
    }
    if (chosenIsExhausted) {
      setError(
        `${sampleCode.trim()} is marked exhausted — the block cannot be cut again, ` +
          `so this request could not be fulfilled.`,
      );
      return;
    }
    if (!agent) {
      setError("Choose the stain or IHC agent you're requesting.");
      return;
    }
    const [assayType, assayName] = agent.split("::");
    setBusy(true);
    setError(null);
    try {
      const uuid = await submitRequest({
        sampleCode: sampleCode.trim(),
        slideCode: slideCode.trim(),
        requestedAssay: assayName,
        assayType: assayType === "ihc" ? "ihc" : "stain",
        note: note.trim(),
        requesterName: operatorName,
      });
      // Remember it locally so "My requests" shows it straight away, instead of
      // staying empty until the workstation drains and republishes (#71).
      addPendingRequest({
        uuid,
        sample_code: sampleCode.trim(),
        slide_code: slideCode.trim(),
        requested_assay: assayName,
        requester_name: operatorName,
        note: note.trim(),
        created_at: nowTimestamp(),
      });
      onSubmitted(`Requested ${assayName} for ${sampleCode.trim()}`);
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Request a stain" onClose={onClose} width="max-w-md">
      <p className="mb-3 text-xs text-ink-faint">
        This raises a formal stain request on the workstation — the block is flagged for
        cutting (or an existing extra is pulled into staining), just as if requested at the
        bench. Track its status under “My requests”.
      </p>

      <Field label="Sample">
        {/* A dropdown, not free text — no need to type the code (#64). */}
        <select
          value={sampleCode}
          onChange={(e) => setSampleCode(e.target.value)}
          className="w-full rounded-lg border border-line bg-white px-2 py-2 text-sm text-ink outline-none focus:border-brand"
        >
          <option value="">Choose a sample…</option>
          {(defaultSampleCode && !sampleCodes.includes(defaultSampleCode)
            ? [defaultSampleCode, ...sampleCodes]
            : sampleCodes
          ).map((code) => (
            <option key={code} value={code}>
              {code}{exhausted.has(code.toUpperCase()) ? " — exhausted" : ""}
            </option>
          ))}
        </select>
        {chosenIsExhausted && (
          <p role="alert" className="mt-1 text-[11px] text-red-600">
            {sampleCode.trim()} is exhausted — the block cannot be cut again.
          </p>
        )}
      </Field>

      <Field label="Specific slide (optional)">
        <TextInput value={slideCode} onChange={(e) => setSlideCode(e.target.value)} placeholder="e.g. LIV-0007-D01-a" />
      </Field>

      <Field label="Requested stain / IHC">
        <select
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          className="w-full rounded-lg border border-line bg-white px-2 py-2 text-sm text-ink outline-none focus:border-brand"
        >
          <option value="">Choose an agent…</option>
          {catalog.map((a) => (
            <option key={`${a.assay_type}::${a.name}`} value={`${a.assay_type}::${a.name}`}>
              {a.name} ({a.assay_type})
            </option>
          ))}
        </select>
      </Field>

      <Field label="Note (optional)">
        <TextArea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Context for the bench…" />
      </Field>

      {error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          <Send size={15} /> {busy ? "Sending…" : "Send request"}
        </Button>
      </div>
    </Modal>
  );
}
