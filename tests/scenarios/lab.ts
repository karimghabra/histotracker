// A lab to run a scenario in: this tree's own data layer, launched the way the app
// launches it (migrations, runtime schema, a signed-in user), on its own SQLite file.
import { currentBuild, type Build } from "../compat/builds";
import { launch, newMachine, quit, type App } from "../compat/app";
import { DatabaseSync } from "../compat/sqlite";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type Row = Record<string, Any>;
type NoteField = "embedding_notes" | "cut_notes" | "slide_notes" | "overall_notes";

let build: Build | null = null;
let seq = 0;

export interface Lab {
  app: App;
  db: Any;
  /** Read the file directly, with no application code in the way. */
  rows(sql: string, params?: Array<string | number | null>): Row[];
  sample(description: string, upTo?: "in_ethanol" | "embedded", notes?: Partial<Record<NoteField, string>>): Promise<number>;
  close(): Promise<void>;
}

const TO_ETHANOL = ["in_fixative", "fixative_removed", "in_ethanol"];
const TO_EMBEDDED = [...TO_ETHANOL, "processing_started", "processed", "picked_up", "needs_embedding", "embedded"];

export async function openLab(): Promise<Lab> {
  build ??= currentBuild();
  const machine = newMachine(`scenario-${process.pid}-${(seq += 1)}`);
  const app = await launch(build, machine);
  const db = app.db;
  const user = await db.addUser({ name: "Karim Ghabra", initials: "KG" });
  await db.setActiveUser(user);
  await db.addProject({ code: "EE", name: "Enthesis", team_lead: "", is_active: true, lead_user_id: 0 });

  const rows = (sql: string, params: Array<string | number | null> = []) => {
    const file = new DatabaseSync(machine.dbFile, { readOnly: true });
    try {
      return file.prepare(sql).all(...params) as Row[];
    } finally {
      file.close();
    }
  };

  return {
    app,
    db,
    rows,
    async sample(description, upTo = "embedded", notes = {}) {
      const project = ((await db.listProjects()) as Row[]).find((p) => p.code === "EE")!;
      const id: number = await db.addSample(
        {
          project_id: project.id,
          sample_description: description,
          processing_type: "Short",
          fixative_agent: "Z-Fix",
          needs_decalcification: false,
          cut_notes: "",
          slide_notes: "",
          embedding_notes: "",
          stains: "",
          preselected_stains: [],
          overall_notes: "",
          ...notes,
        },
        "EE",
      );
      for (const stage of upTo === "embedded" ? TO_EMBEDDED : TO_ETHANOL) await db.updateSampleStage(id, stage);
      return id;
    },
    close: () => quit(app),
  };
}
