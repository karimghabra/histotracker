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
 */
export const SAMPLE_NOTE_FIELDS = [
  "embedding_notes",
  "cut_notes",
  "slide_notes",
  "overall_notes",
] as const;

export type SampleNoteField = (typeof SAMPLE_NOTE_FIELDS)[number];

// Every field must be a real text column on Sample; this fails the typecheck if
// one is renamed out from under the list.
type AssertSampleColumns = SampleNoteField extends keyof Sample ? true : never;
const _fieldsAreSampleColumns: AssertSampleColumns = true;
void _fieldsAreSampleColumns;

/**
 * How each note is named to the user. The wording follows the intake form,
 * which is where the user typed the note in the first place — a correction
 * surface that renamed them would read as a different field.
 */
export const SAMPLE_NOTES: Array<{
  field: SampleNoteField;
  label: string;
  placeholder: string;
}> = [
  {
    field: "embedding_notes",
    label: "Embedding notes",
    placeholder: "Orientation and handling for whoever embeds this block…",
  },
  {
    field: "cut_notes",
    label: "Cut notes",
    placeholder: "Instructions for the microtome…",
  },
  {
    field: "slide_notes",
    label: "Slide notes",
    placeholder: "How this sample's slides should be prepared…",
  },
  {
    field: "overall_notes",
    label: "Sample notes",
    placeholder: "Notes about this sample…",
  },
];

export function sampleNoteLabel(field: SampleNoteField): string {
  return SAMPLE_NOTES.find((n) => n.field === field)?.label ?? field;
}
