// #146: nobody can put an earlier state of the database back while signed out, and no restore
// changes who the database says is signed in. On the real db.ts and backup.ts, on a real SQLite file.
//
// The App mirrors "nobody is signed in" into the data layer with setSignedOutReadOnly; these
// scenarios do the same after setActiveUser(null), which is what signing out does.
import { afterEach, describe, expect, it } from "vitest";
import { openLab, type Lab } from "./lab";

let lab: Lab | null = null;
afterEach(async () => {
  await lab?.close();
  lab = null;
});

const REFUSAL = "Sign in before making modifications.";

const codes = (l: Lab) => l.rows(`SELECT sample_code FROM samples ORDER BY sample_code`).map((r) => r.sample_code);
const signedIn = (l: Lab) => l.rows(`SELECT value FROM app_settings WHERE key = 'active_user_id'`)[0]?.value ?? null;

async function signOut(l: Lab): Promise<void> {
  await l.db.setActiveUser(null);
  l.db.setSignedOutReadOnly(true);
}

describe("#146: restoring an earlier state", () => {
  it("is refused with nobody signed in, before the file is touched", async () => {
    lab = await openLab();
    await lab.sample("first block", "in_ethanol");
    const image = await lab.db.snapshotDb();
    await lab.sample("second block", "in_ethanol");
    const before = { samples: codes(lab), user: signedIn(lab) };
    expect(before.samples).toHaveLength(2);

    await signOut(lab);
    await expect(lab.db.restoreDbPreservingSession(image)).rejects.toThrow(REFUSAL);
    await expect(lab.db.swapInImageFromElsewhere(image, { keepSession: true })).rejects.toThrow(REFUSAL);

    expect(codes(lab)).toEqual(before.samples);
    expect(signedIn(lab), "signing out left the session empty; a refused restore leaves it so").toBe("");
  });

  it("a revert to a backup with nobody signed in is refused and takes no safety backup", async () => {
    lab = await openLab();
    await lab.sample("first block", "in_ethanol");
    const backup = await lab.app.backup.createBackup("manual", 10);
    await lab.sample("second block", "in_ethanol");
    const before = codes(lab);
    const backups = (await lab.app.backup.listBackups()).length;

    await signOut(lab);
    await expect(lab.app.backup.revertToBackup(backup.name)).rejects.toThrow(REFUSAL);

    expect(codes(lab)).toEqual(before);
    expect(signedIn(lab)).toBe("");
    expect((await lab.app.backup.listBackups()).length, "a refused revert leaves no prerestore backup").toBe(backups);
  });

  it("never changes who is signed in, whoever the snapshot says it was", async () => {
    lab = await openLab();
    const first = await lab.db.getActiveUser();
    await lab.sample("first block", "in_ethanol");
    const image = await lab.db.snapshotDb(); // taken while the first user is signed in
    const second = await lab.db.addUser({ name: "Second User", initials: "SU" });
    await lab.db.setActiveUser(second);
    await lab.sample("second block", "in_ethanol");
    expect(first.id).not.toBe(second);

    await lab.db.restoreDbPreservingSession(image);

    expect(codes(lab), "the earlier state is back").toHaveLength(1);
    expect(signedIn(lab), "the session is exactly what it was before the restore").toBe(String(second));
    expect((await lab.db.getActiveUser()).id).toBe(second);
  });

  it("a signed-in revert keeps the session and the users added since the backup", async () => {
    lab = await openLab();
    await lab.sample("first block", "in_ethanol");
    const backup = await lab.app.backup.createBackup("manual", 10);
    const later = await lab.db.addUser({ name: "Later User", initials: "LU" });
    await lab.db.setActiveUser(later);

    await lab.app.backup.revertToBackup(backup.name);

    expect(signedIn(lab)).toBe(String(later));
    expect(lab.rows(`SELECT name FROM users WHERE id = ?`, [later])).toHaveLength(1);
  });
});
