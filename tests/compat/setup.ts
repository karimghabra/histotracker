// The browser globals the data layer touches, for a Node test run: `window`
// and a localStorage that belongs to whichever machine the app is running on
// (a backup schedule or a pending request is per workstation, not global).

import { world } from "./world";

const fallback = new Map<string, string>();
const store = () => world().process?.machine.storage ?? fallback;

const localStorage = {
  get length() {
    return store().size;
  },
  key: (i: number) => [...store().keys()][i] ?? null,
  getItem: (k: string) => store().get(k) ?? null,
  setItem: (k: string, v: string) => void store().set(k, String(v)),
  removeItem: (k: string) => void store().delete(k),
  clear: () => store().clear(),
};

const g = globalThis as unknown as Record<string, unknown>;
Object.defineProperty(g, "localStorage", { value: localStorage, configurable: true, writable: true });
if (!("window" in g)) g.window = globalThis;
