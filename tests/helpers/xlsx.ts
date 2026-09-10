import { inflateRawSync } from "node:zlib";

// An .xlsx is a shipped file format: a ZIP of SpreadsheetML parts. These
// helpers decode the bytes the app hands the user back into the grid Excel
// would show, so a spec can assert what the technician reads in the workbook.
// (write-excel-file accepts a wrong argument shape silently and emits a
// workbook with no cells at all — only reading the bytes catches that.)

/** Read a ZIP archive into { path -> bytes } via its central directory. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a ZIP archive: no end-of-central-directory record");

  const files = new Map<string, Uint8Array>();
  let entry = view.getUint32(eocd + 16, true);
  for (let i = view.getUint16(eocd + 10, true); i > 0; i--) {
    const method = view.getUint16(entry + 10, true);
    const compressedSize = view.getUint32(entry + 20, true);
    const nameLength = view.getUint16(entry + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(entry + 46, entry + 46 + nameLength));
    const local = view.getUint32(entry + 42, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);
    entry += 46 + nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
  }
  return files;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** "C" -> 2, "AB" -> 27: the 0-based column of a cell reference. */
const columnIndex = (ref: string) =>
  [...(ref.match(/^[A-Z]+/)?.[0] ?? "A")].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

function decodeSheet(xml: string, shared: string[]): string[][] {
  const rows = [...xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map(([, row]) => {
    const cells: string[] = [];
    for (const [, attrs, value] of row.matchAll(/<c([^>]*)(?:\/>|>(.*?)<\/c>)/gs)) {
      const at = columnIndex(attrs.match(/r="([A-Z]+\d+)"/)?.[1] ?? "A1");
      while (cells.length < at) cells.push("");
      const inline = value?.match(/<t[^>]*>(.*?)<\/t>/s)?.[1];
      const v = value?.match(/<v>(.*?)<\/v>/s)?.[1];
      cells[at] = / t="s"/.test(attrs) ? (shared[Number(v)] ?? "") : unescapeXml(inline ?? v ?? "");
    }
    return cells;
  });
  // A sheet is a rectangle: SpreadsheetML omits trailing empty cells, but the
  // grid Excel shows still has them, so pad every row out to the widest one.
  const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
  for (const row of rows) while (row.length < width) row.push("");
  return rows;
}

/** Every worksheet of a workbook, by its user-visible sheet name. */
export function readWorkbook(bytes: Uint8Array): Map<string, string[][]> {
  const files = unzip(bytes);
  const part = (name: string) => new TextDecoder().decode(files.get(name) ?? new Uint8Array());

  const shared = [...part("xl/sharedStrings.xml").matchAll(/<si>(.*?)<\/si>/gs)].map(([, si]) =>
    [...si.matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(([, t]) => unescapeXml(t)).join(""),
  );

  const rels = new Map(
    [...part("xl/_rels/workbook.xml.rels").matchAll(/<Relationship([^>]*)\/>/g)].map(([, a]) => [
      a.match(/Id="([^"]+)"/)?.[1] ?? "",
      (a.match(/Target="([^"]+)"/)?.[1] ?? "").replace(/^\/?(xl\/)?/, ""),
    ]),
  );

  const sheets = new Map<string, string[][]>();
  for (const [, attrs] of part("xl/workbook.xml").matchAll(/<sheet([^>]*)\/>/g)) {
    const name = unescapeXml(attrs.match(/name="([^"]+)"/)?.[1] ?? "");
    const target = rels.get(attrs.match(/r:id="([^"]+)"/)?.[1] ?? "") ?? "";
    sheets.set(name, decodeSheet(part(`xl/${target}`), shared));
  }
  return sheets;
}

/** The first (or only) worksheet, as rows of cell text. */
export function readSheet(bytes: Uint8Array): string[][] {
  return [...readWorkbook(bytes).values()][0] ?? [];
}
