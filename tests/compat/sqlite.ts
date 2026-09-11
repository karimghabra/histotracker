// node:sqlite, loaded in a way vite accepts. Vite's resolver predates it, does
// not know it is a builtin, and tries to load a file called "sqlite" instead.
const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
