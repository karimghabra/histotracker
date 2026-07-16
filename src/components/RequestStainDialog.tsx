import { useState } from "react";
import { Send } from "lucide-react";
import { Button, Field, Modal, TextArea, TextInput } from "./ui";
import { submitRequest } from "../lib/githubSync";

export function RequestStainDialog({
  operatorName,
  sampleCodes,
  assayNames,
  defaultSampleCode,
  onSubmitted,
  onClose,
}: {
  operatorName: string;
  sampleCodes: string[];
  assayNames: string[];
  defaultSampleCode?: string;
  onSubmitted: (message: string) => void;
  onClose: () => void;
}) {
  const [sampleCode, setSampleCode] = useState(defaultSampleCode ?? "");
  const [slideCode, setSlideCode] = useState("");
  const [requestedAssay, setRequestedAssay] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!sampleCode.trim()) {
      setError("Enter the sample this request is for.");
      return;
    }
    if (!requestedAssay.trim()) {
      setError("Name the stain or IHC agent you're requesting.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await submitRequest({
        sampleCode: sampleCode.trim(),
        slideCode: slideCode.trim(),
        requestedAssay: requestedAssay.trim(),
        note: note.trim(),
        requesterName: operatorName,
      });
      onSubmitted(`Requested ${requestedAssay.trim()} for ${sampleCode.trim()}`);
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
        Your request is sent to the workstation, which will action it and publish the update
        back to you. You can track its status under “My requests”.
      </p>

      <Field label="Sample">
        <TextInput
          list="request-sample-codes"
          value={sampleCode}
          onChange={(e) => setSampleCode(e.target.value)}
          placeholder="e.g. LIV-0007"
        />
        <datalist id="request-sample-codes">
          {sampleCodes.map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      </Field>

      <Field label="Specific slide (optional)">
        <TextInput value={slideCode} onChange={(e) => setSlideCode(e.target.value)} placeholder="e.g. LIV-0007-D01-a" />
      </Field>

      <Field label="Requested stain / IHC">
        <TextInput
          list="request-assay-names"
          value={requestedAssay}
          onChange={(e) => setRequestedAssay(e.target.value)}
          placeholder="e.g. H&E, CD3, Ki-67"
        />
        <datalist id="request-assay-names">
          {assayNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
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
