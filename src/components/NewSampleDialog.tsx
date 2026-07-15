import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { useActions } from "../hooks/useActions";
import { FIXATIVE_OPTIONS, PROCESSING_OPTIONS } from "../lib/stages";
import { nextSampleCode } from "../lib/db";
import type { Project, ProcessingType } from "../lib/types";

export function NewSampleDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { createSample } = useActions();
  const [saving, setSaving] = useState(false);
  const [previewCode, setPreviewCode] = useState("…");
  const [description, setDescription] = useState("");
  const [fixative, setFixative] = useState(FIXATIVE_OPTIONS[0]);
  const [processing, setProcessing] = useState<ProcessingType>("Short");
  const [needsDecalc, setNeedsDecalc] = useState(false);
  const [stains, setStains] = useState("");
  const [cutNotes, setCutNotes] = useState("");
  const [slideNotes, setSlideNotes] = useState("");
  const [overallNotes, setOverallNotes] = useState("");

  useEffect(() => {
    nextSampleCode(project.id, project.code).then(setPreviewCode);
  }, [project.id, project.code]);

  async function save() {
    setSaving(true);
    await createSample(
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
    );
    setSaving(false);
    onClose();
  }

  return (
    <Modal title={`New Sample · ${project.code}`} onClose={onClose} width="max-w-lg">
      <Field label="Next Sample ID">
        <TextInput value={previewCode} readOnly className="bg-surface font-semibold" />
      </Field>
      <Field label="Description">
        <TextInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          placeholder="e.g. 2 week Stretch PLA"
        />
      </Field>
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
        Decalcification needed before fixation
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
          Create Sample
        </Button>
      </div>
    </Modal>
  );
}
