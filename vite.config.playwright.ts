import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Browser-driveable build of the app for Playwright. Identical to the real
// frontend except `@tauri-apps/plugin-sql` is aliased to a sql.js-backed shim
// (src/test/browser-sql-shim.ts) so the app runs in plain Chromium. Nothing
// here affects `tauri dev` / production, which use vite.config.ts.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@tauri-apps/plugin-sql": fileURLToPath(
        new URL("./src/test/browser-sql-shim.ts", import.meta.url),
      ),
      "@tauri-apps/api/core": fileURLToPath(
        new URL("./src/test/browser-core-shim.ts", import.meta.url),
      ),
    },
  },
  optimizeDeps: {
    // sql.js ships as CJS; let Vite pre-bundle it for the browser.
    include: ["sql.js"],
  },
  server: {
    port: 5599,
    strictPort: true,
  },
});
