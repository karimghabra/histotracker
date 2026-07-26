import { useState } from "react";
import { Send } from "lucide-react";
import { Button, Field, Modal, TextArea, TextInput } from "./ui";
import { submitRequest } from "../lib/githubSync";

export function RequestStainDialog({
  operatorName,
  sampleCodes,
  catalog,
  defaultSampleCode,
  onSubmitted,
  onClose,
}: {
  operatorName: string;
  sampleCodes: string[];
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

  async function submit() {
    if (!sampleCode.trim()) {
      setError("Choose the sample this request is for.");
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
      await submitRequest({
        sampleCode: sampleCode.trim(),
        slideCode: slideCode.trim(),
        requestedAssay: assayName,
        assayType: assayType === "ihc" ? "ihc" : "stain",
        note: note.trim(),
        requesterName: operatorName,
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
