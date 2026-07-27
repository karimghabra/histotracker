// Single source of the app version for the UI (#68). Pulled straight from
// package.json so it always matches the release; keep package.json,
// tauri.conf.json and Cargo.toml in lockstep at release time (see CLAUDE.md).
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;
