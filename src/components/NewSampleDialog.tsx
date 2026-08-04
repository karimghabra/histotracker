import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { useActions } from "../hooks/useActions";
import { useAssayCatalog } from "../hooks/useData";
import { FIXATIVE_OPTIONS, PROCESSING_OPTIONS } from "../lib/stages";
import { nextSampleCode } from "../lib/db";
import { normalizePastedLines } from "../lib/utils";
import type { Project, ProcessingType } from "../lib/types";

/**
 * The i-th code in the batch, given the first ("EE-22" → i=2 → "EE-24").
 * Preserves whatever width the first code has, so this keeps working on a
 * database that still holds zero-padded codes (#87).
 */
function codeAt(first: string, index: number): string {
  const match = first.match(/^(.*-)(\d+)$/);
  if (!match) return first;
  const width = match[2].length;
  const n = Number(match[2]) + index;
  return `${match[1]}${String(n).padStart(width, "0")}`;
}

/** Expand a single next code ("EE-22") into a range label for quantity > 1. */
function codeRange(first: string, quantity: number): string {
  if (quantity <= 1) return first;
  return `${first} – ${codeAt(first, quantity - 1)}`;
}

export function NewSampleDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const { createSamples } = useActions();
  const { data: catalog = [] } = useAssayCatalog();
  const [saving, setSaving] = useState(false);
  const [previewCode, setPreviewCode] = useState("…");
  const [description, setDescription] = useState("");
  const [fixative, setFixative] = useState(FIXATIVE_OPTIONS[0]);
  const [processing, setProcessing] = useState<ProcessingType>("Short");
  const [needsDecalc, setNeedsDecalc] = useState(false);
  const [quantity, setQuantity] = useState(1);
  // #86 — a batch normally shares one description; tick this to give each sample
  // in the batch its own. Off by default, so existing behaviour is unchanged.
  const [perSample, setPerSample] = useState(false);
  const [descriptions, setDescriptions] = useState<string[]>([]);
  const [pasted, setPasted] = useState("");

  // ONE normalisation, shared by the rows below and by the mismatch warning.
  //
  // They used to disagree: the splitter mapped positionally (blank lines
  // included) while the warning counted only non-empty lines. A leading or
  // interior blank — routine when copying a spreadsheet column — therefore
  // shifted every description down by one and dropped the tail, and the warning
  // stayed silent because the non-empty count still matched. Trailing blanks are
  // stripped rather than counted, because an Excel column copy ends in a newline
  // and counting it would fire a warning on the commonest paste there is.
  const pastedLines = normalizePastedLines(pasted);

  useEffect(() => {
    if (pastedLines.length === 0) return;
    setDescriptions(Array.from({ length: quantity }, (_, i) => pastedLines[i] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasted, quantity]);
  // Agents ticked for this sample (issue #1). Keyed "type::name".
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cutNotes, setCutNotes] = useState("");
  const [slideNotes, setSlideNotes] = useState("");
  const [overallNotes, setOverallNotes] = useState("");

  useEffect(() => {
    nextSampleCode(project.id, project.code).then(setPreviewCode);
  }, [project.id, project.code]);

  // For quantity > 1, preview the full "EE-0022 – EE-0026" range.
  const previewLabel = codeRange(previewCode, quantity);

  const preselectedStains = catalog
    .filter((a) => picked.has(`${a.assay_type}::${a.name}`))
    .map((a) => ({ assay_type: a.assay_type, assay_name: a.name }));

  function toggle(key: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
        stains: preselectedStains.map((a) => a.assay_name).join(", "),
        preselected_stains: preselectedStains,
        overall_notes: overallNotes,
      },
      project.code,
      quantity,
      // Gate on the SAME condition that renders the per-sample UI (#86). Gating
      // on `perSample` alone meant that ticking the box, filling the rows, then
      // correcting Quantity back to 1 hid the whole UI but still wrote
      // descriptions[0] — silently ignoring the Description field the user could
      // actually see. Same "state nothing renders" shape as #77.
      perSample && quantity > 1 ? descriptions.slice(0, quantity) : undefined,
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
        <div className="-mt-2 mb-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={perSample}
              onChange={(e) => setPerSample(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-brand)]"
            />
            Give each sample its own description
          </label>
          {!perSample && (
            <p className="mt-1 text-xs text-ink-faint">
              Creates {quantity} samples with identical details, each with its own ID.
            </p>
          )}
          {perSample && (
            <div className="mt-2">
              {/* Typing 20 fields one at a time is the thing a technician will
                  refuse to do — they already have the column in a spreadsheet. */}
              {/* Controlled, and re-split whenever Quantity changes. Left
                  uncontrolled, raising the quantity after pasting kept showing
                  every pasted line while silently leaving the new rows blank. */}
              <textarea
                aria-label="Paste one description per line"
                rows={2}
                value={pasted}
                placeholder="Optional: paste one description per line to fill the list below"
                onChange={(e) => setPasted(e.target.value)}
                className="mb-2 w-full resize-y rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
              />
              {pastedLines.length > 0 && pastedLines.length !== quantity && (
                <p className="mb-2 text-[11px] text-amber-700">
                  {pastedLines.length} line(s) pasted for {quantity} sample(s)
                  {pastedLines.length > quantity
                    ? " — the extra lines are ignored."
                    : " — the rest fall back to the shared description."}
                </p>
              )}
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-2 thin-scroll">
                {Array.from({ length: quantity }, (_, i) => {
                  const code = codeAt(previewCode, i);
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 text-[11px] font-medium text-ink-soft">{code}</span>
                      <TextInput
                        aria-label={`Description for ${code}`}
                        value={descriptions[i] ?? ""}
                        placeholder={description || "Same as above"}
                        onChange={(e) =>
                          setDescriptions((prev) => {
                            const next = [...prev];
                            while (next.length < quantity) next.push("");
                            next[i] = e.target.value;
                            return next;
                          })
                        }
                        className="py-1 text-[11px]"
                      />
                    </div>
                  );
                })}
              </div>
              <p className="mt-1 text-[11px] text-ink-faint">
                Blank rows fall back to the description above. IDs shown are a preview.
              </p>
            </div>
          )}
        </div>
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
      <Field label={`Stains / IHC${picked.size ? ` · ${picked.size} selected` : ""}`}>
        {catalog.length === 0 ? (
          <p className="text-xs text-ink-faint">No active agents in the catalog.</p>
        ) : (
          <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-2 thin-scroll">
            {catalog.map((a) => {
              const key = `${a.assay_type}::${a.name}`;
              return (
                <label key={key} className="flex items-center gap-2 text-sm text-ink-soft">
                  <input
                    type="checkbox"
                    checked={picked.has(key)}
                    onChange={() => toggle(key)}
                    className="h-3.5 w-3.5 accent-[var(--color-brand)]"
                  />
                  <span className="flex-1">{a.name}</span>
                  <span className="text-[10px] uppercase text-ink-faint">{a.assay_type}</span>
                </label>
              );
            })}
          </div>
        )}
        <p className="mt-1 text-[11px] text-ink-faint">
          Each ticked agent is preassigned a slide; the block auto-plans {Math.max(2, 4 - picked.size)} extra
          {Math.max(2, 4 - picked.size) === 1 ? "" : "s"} at embedding.
        </p>
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
