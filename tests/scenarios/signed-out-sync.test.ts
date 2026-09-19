// #147: a signed-out workstation keeps publishing, and a viewer request that arrives meanwhile waits in
// the inbox, untouched, until someone signs in. On the real db.ts and githubSync.ts, a real SQLite file
// and the shared fake remote.
//
// The App mirrors "nobody is signed in" into the data layer with setSignedOutReadOnly; these scenarios do
// the same after setActiveUser(null), which is what signing out does.
import { afterEach, describe, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";
import { world } from "../compat/world";

let lab: Lab | null = null;
afterEach(async () => {
  world().remote.files.clear(); // the fake remote outlives a lab
  world().remote.assets.clear();
  await lab?.close();
  lab = null;
});

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const inbox = () => [...world().remote.files.keys()].filter((p) => p.startsWith("requests/"));
const requestRows = (l: Lab) => l.rows(`SELECT uuid, status FROM stain_requests`);
const preselected = (l: Lab) => l.rows(`SELECT preselected_stains FROM samples`)[0].preselected_stains as string;
const lastAudit = (l: Lab) => (l.rows(`SELECT MAX(id) AS id FROM audit_events`)[0].id as number | null) ?? 0;
const auditUsersAfter = (l: Lab, id: number) =>
  l.rows(`SELECT user_id FROM audit_events WHERE id > ?`, [id]).map((r) => r.user_id);

async function signOut(l: Lab): Promise<void> {
  await l.db.setActiveUser(null);
  l.db.setSignedOutReadOnly(true);
}
async function signIn(l: Lab, userId: number): Promise<void> {
  await l.db.setActiveUser(userId);
  l.db.setSignedOutReadOnly(false);
}

async function benchWithARequest(): Promise<{ user: Any; code: string }> {
  lab = await openLab();
  const user = await lab.db.getActiveUser();
  await lab.sample("a block", "embedded");
  const code = lab.rows(`SELECT sample_code FROM samples`)[0].sample_code as string;
  await lab.app.sync.submitRequest({
    sampleCode: code,
    requestedAssay: "H&E",
    assayType: "stain",
    requesterName: "Viewer V",
  });
  expect(inbox()).toHaveLength(1);
  return { user, code };
}

describe("#147: a signed-out workstation", () => {
  it("keeps publishing with a request waiting", async () => {
    await benchWithARequest();
    await signOut(lab!);
    const before = lab!.app.machine.syncConfig.last_synced_version;

    const cycle = await lab!.app.sync.syncWorkstation();

    expect(cycle.published, "the snapshot went out").toBeTruthy();
    expect(lab!.app.machine.syncConfig.last_synced_version).not.toBe(before);
  });

  it("leaves the request in the inbox, unapplied, and writes nothing", async () => {
    await benchWithARequest();
    const before = { preselected: preselected(lab!), audit: lab!.rows(`SELECT id FROM audit_events`).length };
    await signOut(lab!);
    const auditAfterSignOut = lab!.rows(`SELECT id FROM audit_events`).length;

    const cycle = await lab!.app.sync.syncWorkstation();

    expect(cycle.ingested).toBe(0);
    expect(cycle.waiting).toBe(1);
    expect(inbox(), "the file is its own pending marker").toHaveLength(1);
    expect(requestRows(lab!)).toEqual([]);
    expect(preselected(lab!)).toBe(before.preselected);
    expect(lab!.rows(`SELECT id FROM audit_events`).length).toBe(auditAfterSignOut);
  });

  it("applies the waiting request once someone signs in, attributed to them", async () => {
    const { user } = await benchWithARequest();
    await signOut(lab!);
    await lab!.app.sync.syncWorkstation();
    const second: number = await lab!.db.addUser({ name: "Second Tech", initials: "ST" });
    expect(second).not.toBe(user.id);
    await signIn(lab!, second);
    const mark = lastAudit(lab!);

    const cycle = await lab!.app.sync.syncWorkstation();

    expect(cycle.ingested).toBe(1);
    expect(cycle.waiting).toBe(0);
    expect(inbox()).toHaveLength(0);
    expect(requestRows(lab!)).toHaveLength(1);
    expect(preselected(lab!)).toContain("H&E");
    const users = auditUsersAfter(lab!, mark);
    expect(users.length, "the apply is audited").toBeGreaterThan(0);
    expect(new Set(users)).toEqual(new Set([second]));
  });

  it("applies a file drained twice once", async () => {
    await benchWithARequest();
    const [path] = inbox();
    const copy = { ...world().remote.files.get(path)! };

    expect((await lab!.app.sync.syncWorkstation()).ingested).toBe(1);
    const afterFirst = preselected(lab!);
    world().remote.files.set(path, copy); // the removal was lost: the same file is read again
    expect((await lab!.app.sync.syncWorkstation()).ingested).toBe(0);

    expect(preselected(lab!)).toBe(afterFirst);
    expect(requestRows(lab!)).toHaveLength(1);
    expect(inbox()).toHaveLength(0);
  });
});
