import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { useActions } from "../hooks/useActions";
import { FIXATIVE_OPTIONS, PROCESSING_OPTIONS } from "../lib/stages";
import { nextSampleCode } from "../lib/db";
import type { Project, ProcessingType } from "../lib/types";

/** Expand a single next code ("EE-0022") into a range label for quantity > 1. */
function codeRange(first: string, quantity: number): string {
  if (quantity <= 1) return first;
  const match = first.match(/^(.*-)(\d+)$/);
  if (!match) return first;
  const width = match[2].length;
  const start = Number(match[2]);
  const last = `${match[1]}${String(start + quantity - 1).padStart(width, "0")}`;
  return `${first} – ${last}`;
}

export function NewSampleDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { createSamples } = useActions();
  const [saving, setSaving] = useState(false);
  const [previewCode, setPreviewCode] = useState("…");
  const [description, setDescription] = useState("");
  const [fixative, setFixative] = useState(FIXATIVE_OPTIONS[0]);
  const [processing, setProcessing] = useState<ProcessingType>("Short");
  const [needsDecalc, setNeedsDecalc] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [stains, setStains] = useState("");
  const [cutNotes, setCutNotes] = useState("");
  const [slideNotes, setSlideNotes] = useState("");
  const [overallNotes, setOverallNotes] = useState("");

  useEffect(() => {
    nextSampleCode(project.id, project.code).then(setPreviewCode);
  }, [project.id, project.code]);

  // For quantity > 1, preview the full "EE-0022 – EE-0026" range.
  const previewLabel = codeRange(previewCode, quantity);

  async function save() {
    setSaving(true);
    await createSamples(
      {
        project_id: project.id,
        sample_description: description,
        processing_type: processing,
        fixative_agent: fixative,
        needs_decalcification: needsDecalc,
        cut_notes: cutNotes,
        slide_notes: slideNotes,
        stains,
        overall_notes: overallNotes,
      },
      project.code,
      quantity,
    );
    setSaving(false);
    onClose();
  }

  return (
    <Modal title={`New Sample · ${project.code}`} onClose={onClose} width="max-w-lg">
      <div className="grid grid-cols-[1fr_6rem] gap-x-4">
        <Field label={quantity > 1 ? "Sample IDs" : "Next Sample ID"}>
          <TextInput value={previewLabel} readOnly className="bg-surface font-semibold" />
        </Field>
        <Field label="Quantity">
          <TextInput
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
          />
        </Field>
      </div>
      <Field label="Description">
        <TextInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          placeholder="e.g. 2 week Stretch PLA"
        />
      </Field>
      {quantity > 1 && (
        <p className="-mt-2 mb-3 text-xs text-ink-faint">
          Creates {quantity} samples with identical details, each with its own ID.
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Fixative">
          <Select value={fixative} onChange={(e) => setFixative(e.target.value)}>
            {FIXATIVE_OPTIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </Field>
        <Field label="Processing">
          <Select
            value={processing}
            onChange={(e) => setProcessing(e.target.value as ProcessingType)}
          >
            {PROCESSING_OPTIONS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
        </Field>
      </div>
      <label className="mb-3.5 flex items-center gap-2 text-sm text-ink-soft">
        <input
          type="checkbox"
          checked={needsDecalc}
          onChange={(e) => setNeedsDecalc(e.target.checked)}
        />
        Decalcification needed after fixation
      </label>
      <Field label="Requested Stains / IHC">
        <TextInput value={stains} onChange={(e) => setStains(e.target.value)} />
      </Field>
      <Field label="Sectioning / Cut Notes">
        <TextArea rows={2} value={cutNotes} onChange={(e) => setCutNotes(e.target.value)} />
      </Field>
      <Field label="Slide Notes">
        <TextArea rows={2} value={slideNotes} onChange={(e) => setSlideNotes(e.target.value)} />
      </Field>
      <Field label="General Notes">
        <TextArea rows={2} value={overallNotes} onChange={(e) => setOverallNotes(e.target.value)} />
      </Field>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={saving}>
          Create {quantity > 1 ? `${quantity} Samples` : "Sample"}
        </Button>
      </div>
    </Modal>
  );
}
