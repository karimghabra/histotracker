# Histometer

Histometer is a local-first desktop application for tracking histology samples through
the lab workflow — intake, fixation, processing, embedding, sectioning, staining/IHC,
imaging, and analysis. It replaces a manual multi-spreadsheet process with a single
drag-and-drop workflow board backed by a local database.

This is the **Tauri + React** rewrite of the original Python/Tkinter prototype (preserved
under [`legacy/`](legacy/) for reference).

## Tech stack

| Layer | Choice |
| --- | --- |
| Shell | [Tauri 2](https://tauri.app) (Rust) — small native Windows `.exe` |
| UI | React 19 + TypeScript + [Tailwind CSS v4](https://tailwindcss.com) |
| Drag & drop | [dnd-kit](https://dndkit.com) |
| Data fetching | [TanStack Query](https://tanstack.com/query) |
| Database | SQLite via [`tauri-plugin-sql`](https://github.com/tauri-apps/plugins-workspace) |

The SQLite database lives in the OS app-data directory (`sqlite:histometer.db`) and is the
operational source of truth. Schema is created via Rust migrations in
[`src-tauri/migrations/`](src-tauri/migrations/).

## Prerequisites

- Node.js 18+ and npm
- Rust (stable) with the MSVC toolchain
- Microsoft C++ Build Tools + WebView2 (already present on most Windows 11 machines)

## Develop

```powershell
npm install
npm run tauri dev
```

This launches the app with hot-reload for the React frontend.

## Build a Windows executable

```powershell
npm run tauri build
```

Installers are written under `src-tauri/target/release/bundle/` (normally MSI and
NSIS `.exe` packages on Windows). Copy one of those installers to another machine;
the target machine does not need Node.js or Rust.

## Project layout

```
src/                 React frontend
  components/         UI components (board, cards, dialogs, drawer, sidebar)
  hooks/              TanStack Query hooks
  lib/                types, workflow-stage config, SQLite data access, utils
src-tauri/           Rust/Tauri shell
  migrations/         SQL schema migrations
  src/lib.rs          plugin + migration registration
docs/                product design document
legacy/              original Python prototype (operational CSV exports are ignored)
```

## Status

Implemented:

- Projects with auto-generated per-project sample IDs (`EE-0001`)
- Sample intake and the two-lane, compact-list drag-and-drop workflow board
- Shift/Ctrl multi-selection and persistent processing batches with a batch-start checklist
- Stage timestamping and timed processing auto-advance (18h short / 52h long)
- Sample details drawer with a full stage timeline
- Pre-processing checklist with automatic timestamps and a decalcification gate
  (decalc-required samples cannot enter fixation until decalcification is recorded)
- Sectioning-plan editor with depth and duplicate-slide rows, individual slide records,
  and an explicit stain/Extra assignment checkpoint
- Versioned embedding, sectioning, staining, and processing checklists
- User directory, sign-in/sign-out, user-selected project leads, and attributed audit history
- Twenty-five light and dark themes with a theme-aware project sidebar
- Depth-indexed slide IDs (`D01-a`, `D01-b`, etc.) and cumulative section-depth history
- Separate searchable extra-slide inventory with reassignment into stain/IHC workflows
- Undo for create / move / edit / sectioning / delete (toolbar button or `Ctrl+Z`)
- Export to a normalized Excel workbook (Projects, Samples, Cut Orders, Slides, and
  Processing Batches sheets) or samples CSV,
  saved via a native file dialog
- Mark-analyzed and delete

The current operational workflow is defined in
[docs/phase_zero_spec.md](docs/phase_zero_spec.md). Planned work also includes richer
stain/IHC and imaging request tracking, and SharePoint sync.
