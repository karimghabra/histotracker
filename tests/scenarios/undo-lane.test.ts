// Undo and the save it is meant to cancel, called in the same tick (ht-undo-snapshot-on-write-path).
//
// A textarea's blur fires its save and does not wait for it; the toolbar Undo's click follows. So
// the save is CALLED first and is still in its opening read (every note editor reads the sample
// before deciding to commit) when Undo is called. Undo must take back that save, not the entry
// before it. On the real db.ts, through the real useActions, with no await between the two calls:
// an await there would let the save finish first and stop this test reproducing anything.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

it("undo called while a save is still reading takes back that save", async () => {
  lab = await openLab();
  const id = await lab.sample("DESC-0", "in_ethanol", { cut_notes: "CUT-0" });
  // Imported after the lab has launched, so the hook binds to the db.ts instance the lab opened.
  const { useActions } = await import("../../src/hooks/useActions");
  // One render is enough to take the hook's actions out; they are closures over the real db.ts.
  let actions!: ReturnType<typeof useActions>;
  const Probe = () => ((actions = useActions()), null);
  renderToString(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Probe)));
  const result = { current: actions };
  const stored = () => lab!.rows(`SELECT sample_description AS description, cut_notes AS cut FROM samples WHERE id = ?`, [id])[0];

  await result.current.editSampleNote(id, "cut_notes", "CUT-A");
  expect(stored()).toEqual({ description: "DESC-0", cut: "CUT-A" });

  const save = result.current.editSampleDescription(id, "DESC-B"); // the blur
  const undone = result.current.undo(); // the click
  await Promise.allSettled([save, undone]);

  expect(await undone).toBe("Edit EE-1 description");
  expect(stored()).toEqual({ description: "DESC-0", cut: "CUT-A" });
});
