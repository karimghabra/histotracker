import type { Sample } from "./types";

/**
 * The four notes a user writes about a sample in their own words, in the order
 * the bench reads them: at the embedding station, at the microtome, at the
 * slide rack, and then anything about the block as a whole.
 *
 * They are named in one place because a note is typed once, at intake, and read
 * back much later in the log — so every correction surface has to offer all
 * four, and a fifth kind must not be able to appear in one surface only.
 * `samples` holds other text columns (description, stains) that are NOT notes;
 * this list is what separates the prose from the bookkeeping.
 *
 * The wording follows the intake form, which is where the user typed the note
 * in the first place — a correction surface that renamed them would read as a
 * different field. `satisfies` keeps every field a real column on `Sample`, so
 * the typecheck fails if one is renamed out from under the list.
 */
export const SAMPLE_NOTES = [
  {
    field: "embedding_notes",
    label: "Embedding Notes",
    placeholder: "Orientation and handling for whoever embeds this block…",
  },
  {
    field: "cut_notes",
    label: "Sectioning / Cut Notes",
    placeholder: "Instructions for the microtome…",
  },
  {
    field: "slide_notes",
    label: "Slide Notes",
    placeholder: "How this sample's slides should be prepared…",
  },
  {
    field: "overall_notes",
    label: "General Notes",
    placeholder: "Notes about this sample…",
  },
] as const satisfies ReadonlyArray<{
  field: keyof Sample;
  label: string;
  placeholder: string;
}>;

export type SampleNoteField = (typeof SAMPLE_NOTES)[number]["field"];

export const SAMPLE_NOTE_FIELDS: readonly SampleNoteField[] = SAMPLE_NOTES.map((n) => n.field);

export function sampleNoteLabel(field: SampleNoteField): string {
  return SAMPLE_NOTES.find((n) => n.field === field)?.label ?? field;
}
