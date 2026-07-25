import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Component/UI test runner. Separate from the data-layer harness
// (scripts/workflow-test.mjs); this renders the REAL React components in jsdom
// so render/interaction bugs can't slip past a type-check any more.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
