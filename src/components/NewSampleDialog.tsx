import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextArea, TextInput } from "./ui";
import { useActions } from "../hooks/useActions";
import { useAppSettings, useAssayCatalog } from "../hooks/useData";
import { DEFAULT_SETTINGS, plannedExtras } from "../lib/settings";
import { FIXATIVE_OPTIONS, PROCESSING_OPTIONS } from "../lib/stages";
import { nextSampleCode } from "../lib/db";
import { cn, composeDescription, displayCode, normalizePastedLines } from "../lib/utils";
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
  const { data: settings = DEFAULT_SETTINGS } = useAppSettings();
  const [saving, setSaving] = useState(false);
  const [previewCode, setPreviewCode] = useState("…");
  const [description, setDescription] = useState("");
  const [fixative, setFixative] = useState(FIXATIVE_OPTIONS[0]);
  const [processing, setProcessing] = useState<ProcessingType>("Short");
  const [needsDecalc, setNeedsDecalc] = useState(false);
  const [quantity, setQuantity] = useState(1);
  // #86 — per-sample descriptions are no longer behind a checkbox. Typing one
  // description per sample is the PRIMARY way to fill a batch, so the rows are
  // always shown; the field above them is a shared fallback for the samples that
  // genuinely are identical.
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

  /**
   * #88 — no sample may be created without a description.
   *
   * A description was optional at every level: the field could be blank, a
   * per-sample row could be blank, and a blank row fell back to a blank shared
   * value. So "Same as above" resolved to nothing at all and the sample was
   * created with an empty description — permanently, since nobody goes back to
   * fill in a batch they entered last month. The fallback itself was always
   * correct; what was missing was anything requiring the chain to end somewhere.
   */
  //
  // #86 — and the shared field is a PREFIX, not a fallback. It used to be
  // discarded outright as soon as a row had anything in it, so filling in both
  // (the natural thing to do) made the shared description "do nothing".
  const shared = description.trim();
  const resolvedDescription = (index: number) =>
    composeDescription(shared, descriptions[index] ?? "");
  const missingCodes =
    quantity > 1
      ? Array.from({ length: quantity }, (_, i) => i)
          .filter((i) => !resolvedDescription(i))
          .map((i) => displayCode(codeAt(previewCode, i)))
      : shared
        ? []
        : [displayCode(previewCode)];

  const autoExtras = plannedExtras(settings, picked.size);

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
    // Belt and braces: the button is disabled, but a batch created with a blank
    // description is unrecoverable, so the guard does not rely on the UI alone.
    if (missingCodes.length > 0) return;
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
      // Gate on the SAME condition that renders the per-sample rows (#86).
      // Correcting Quantity back to 1 hides the rows, so their contents must
      // stop counting too — otherwise descriptions[0] silently overrode the
      // Description field the user could actually see.
      quantity > 1 ? descriptions.slice(0, quantity) : undefined,
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
      <Field label={quantity > 1 ? "Shared description (optional)" : "Description"}>
        <TextInput
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          placeholder={
            quantity > 1
              ? "e.g. 2 week Stretch PLA — added to every sample below"
              : "e.g. 2 week Stretch PLA"
          }
        />
      </Field>
      {quantity > 1 && (
        <div className="-mt-2 mb-3">
          {/* The per-sample list is the PRIMARY input, so it comes first and is
              always visible — it used to sit behind a checkbox, below a paste
              box, which made the shortcut look like the main event (#86). */}
          <p className="mb-1.5 text-xs text-ink-soft">
            {shared
              ? "Each row is added after the shared description. Leave a row blank to use the shared description on its own."
              : "Every sample needs a description. Fill a row, or type a shared description above to cover them all."}
          </p>
          <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface p-2 thin-scroll">
            {Array.from({ length: quantity }, (_, i) => {
              const code = codeAt(previewCode, i);
              const empty = !resolvedDescription(i);
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className={cn(
                    "w-20 shrink-0 text-[11px] font-medium",
                    empty ? "text-red-600" : "text-ink-soft",
                  )}>
                    {displayCode(code)}
                  </span>
                  {/* Show the shared half inline so the composed result is
                      visible while typing — it is what will be stored, and a
                      field whose effect you cannot see is the one that reads as
                      doing nothing (#86). */}
                  {shared && (
                    <span
                      className="max-w-40 shrink-0 truncate text-[11px] text-ink-faint"
                      title={shared}
                    >
                      {shared} |
                    </span>
                  )}
                  <TextInput
                    aria-label={`Description for ${displayCode(code)}`}
                    value={descriptions[i] ?? ""}
                    placeholder={shared ? "What tells this one apart" : "Required"}
                    onChange={(e) =>
                      setDescriptions((prev) => {
                        const next = [...prev];
                        while (next.length < quantity) next.push("");
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                    className={cn("py-1 text-[11px]", empty && "border-red-300")}
                  />
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-[11px] text-ink-faint">IDs shown are a preview.</p>

          {/* The spreadsheet shortcut, BELOW the list it fills (#86). Typing 20
              fields one at a time is the thing a technician will refuse to do —
              but it is the fallback, not the headline. */}
          {/* Controlled, and re-split whenever Quantity changes. Left
              uncontrolled, raising the quantity after pasting kept showing every
              pasted line while silently leaving the new rows blank. */}
          <textarea
            aria-label="Paste one description per line"
            rows={2}
            value={pasted}
            placeholder="Or paste one description per line to fill the list above"
            onChange={(e) => setPasted(e.target.value)}
            className="mt-2 w-full resize-y rounded-md border border-line bg-white px-2 py-1 text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-brand"
          />
          {pastedLines.length > 0 && pastedLines.length !== quantity && (
            <p className="mt-1 text-[11px] text-amber-700">
              {pastedLines.length} line(s) pasted for {quantity} sample(s)
              {pastedLines.length > quantity
                ? " — the extra lines are ignored."
                : " — the rest fall back to the shared description."}
            </p>
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
        {/* The same arithmetic the plan actually uses — this hint used to
            hard-code its own copy of "max(2, 4 − stains)" and could drift from
            it silently (#92). */}
        <p className="mt-1 text-[11px] text-ink-faint">
          Each ticked agent is preassigned a slide; the block auto-plans {autoExtras} extra
          {autoExtras === 1 ? "" : "s"} at embedding.
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
      {/* Name the samples that are still blank rather than just greying the
          button out — with 20 rows in a scroll box, "something is missing" is
          not an actionable message (#88). */}
      {missingCodes.length > 0 && (
        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          {missingCodes.length === 1
            ? `${missingCodes[0]} needs a description.`
            : `${missingCodes.length} samples need a description: ${missingCodes.slice(0, 6).join(", ")}${
                missingCodes.length > 6 ? `, +${missingCodes.length - 6} more` : ""
              }.`}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={saving || missingCodes.length > 0}
          title={missingCodes.length > 0 ? "Every sample needs a description" : undefined}
        >
          Create {quantity > 1 ? `${quantity} Samples` : "Sample"}
        </Button>
      </div>
    </Modal>
  );
}
