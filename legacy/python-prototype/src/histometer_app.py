from __future__ import annotations

import json
import sqlite3
import tkinter as tk
from datetime import date, datetime, timedelta
from pathlib import Path
from tkinter import messagebox, ttk
from typing import Callable


APP_TITLE = "Histometer"
ROOT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = ROOT_DIR / "data" / "histometer.db"
TIMESTAMP_FORMAT = "%Y-%m-%d %H:%M"

STAGES = [
    ("received", "Logged"),
    ("decalcified", "Decalcification Complete"),
    ("in_fixative", "Placed in Fixative"),
    ("fixative_removed", "Removed from Fixative"),
    ("in_ethanol", "Placed in Ethanol"),
    ("processing_started", "Processing Started"),
    ("processed", "Processed"),
    ("needs_embedding", "Needs Embedding"),
    ("embedded", "Embedded"),
    ("needs_sectioning", "Needs Sectioning"),
    ("sectioned", "Sectioned / Slides Ready"),
    ("stain_requested", "Needs Stains / IHC"),
    ("stained", "Stained"),
    ("deparaffinized", "Deparaffinized"),
    ("ihc_complete", "IHC Complete"),
    ("pictures_taken", "Pictures Taken"),
    ("analyzed", "Analyzed"),
]

STAGE_ORDER = {key: index for index, (key, _label) in enumerate(STAGES)}
STAGE_LABELS = {key: label for key, label in STAGES}
STAGE_BY_LABEL = {label: key for key, label in STAGES}
STAGE_COLUMNS = {
    "received": "stage_received_at",
    "decalcified": "decalc_completed_at",
    "in_fixative": "fixative_placed_at",
    "fixative_removed": "fixative_removed_at",
    "in_ethanol": "ethanol_placed_at",
    "processing_started": "processing_started_at",
    "processed": "stage_processed_at",
    "needs_embedding": "stage_needs_embedding_at",
    "embedded": "stage_embedded_at",
    "needs_sectioning": "stage_needs_sectioning_at",
    "sectioned": "stage_sectioned_at",
    "stain_requested": "stage_stain_requested_at",
    "stained": "stage_stained_at",
    "deparaffinized": "stage_deparaffinized_at",
    "ihc_complete": "stage_ihc_at",
    "pictures_taken": "stage_pictures_taken_at",
    "analyzed": "stage_analyzed_at",
}

FIXATIVE_OPTIONS = ["PFA", "Z-Fix", "Other"]
PROCESSING_OPTIONS = ["Short", "Long"]
PREPROCESSING_STEPS = [
    ("decalcified", "Decalcification complete", "decalc_completed_at"),
    ("in_fixative", "Placed in fixative", "fixative_placed_at"),
    ("fixative_removed", "Removed from fixative", "fixative_removed_at"),
    ("in_ethanol", "Placed in ethanol", "ethanol_placed_at"),
    ("processing_started", "Begun processing", "processing_started_at"),
]

BOARD_QUEUES = [
    ("preprocessing", "Pre-processing", ("received", "decalcified", "in_fixative", "fixative_removed", "in_ethanol"), "in_fixative"),
    ("processing", "Processing", ("processing_started",), "processing_started"),
    ("processor_pickup", "Processor Pickup", ("processed",), "processed"),
    ("needs_embedding", "Needs Embedding", ("needs_embedding",), "needs_embedding"),
    ("embedded_inventory", "Embedded Inventory", ("embedded",), "embedded"),
    ("needs_sectioning", "Needs Sectioning", ("needs_sectioning",), "needs_sectioning"),
    ("staining", "Staining / IHC", ("sectioned", "stain_requested", "stained", "deparaffinized", "ihc_complete"), "sectioned"),
    ("analysis_pending", "Pictures / Analysis Pending", ("pictures_taken",), "pictures_taken"),
]

BOARD_QUEUE_ROWS = [
    ("Processing & Embedding", ("preprocessing", "processing", "processor_pickup", "needs_embedding")),
    ("Embedded Inventory & Analysis", ("embedded_inventory", "needs_sectioning", "staining", "analysis_pending")),
]

BOARD_QUEUE_KEYS = [queue_key for queue_key, _title, _stages, _entry_stage in BOARD_QUEUES]
BOARD_QUEUE_TITLES = {queue_key: title for queue_key, title, _stages, _entry_stage in BOARD_QUEUES}
BOARD_QUEUE_ENTRY_STAGES = {
    queue_key: entry_stage for queue_key, _title, _stages, entry_stage in BOARD_QUEUES
}
BOARD_STAGE_TO_QUEUE = {
    stage: queue_key
    for queue_key, _title, stages, _entry_stage in BOARD_QUEUES
    for stage in stages
}

PROJECT_COLORS = [
    "#3572a5", "#2a9d8f", "#c0553a", "#7b5ea7",
    "#b07d2e", "#1d7ea0", "#b5476b", "#4a7c59",
]
LANE_COLORS = ["#3572a5", "#2a9d8f"]

PREPROCESSING_COMPACT_LABELS: dict[str, str] = {
    "decalcified": "Decalc done",
    "in_fixative": "In fixative",
    "fixative_removed": "Fix. removed",
    "in_ethanol": "In ethanol",
    "processing_started": "Start proc.",
}
SECTION_DEPTH_OPTIONS = ["50", "100", "150", "200", "250", "500"]


def now_timestamp() -> str:
    return datetime.now().strftime(TIMESTAMP_FORMAT)


def display_value(value: str | None) -> str:
    return value if value else "Not recorded"


def processing_duration_hours(processing_type: str) -> int:
    return 52 if processing_type.lower() == "long" else 18


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, TIMESTAMP_FORMAT)
    except ValueError:
        return None


class HistometerDB:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.db_path)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                team_lead TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                project_sample_number INTEGER,
                sample_code TEXT NOT NULL,
                sample_description TEXT NOT NULL DEFAULT '',
                date_added TEXT NOT NULL,
                processing_type TEXT NOT NULL CHECK (processing_type IN ('Short', 'Long')),
                fixative_agent TEXT NOT NULL DEFAULT 'PFA',
                needs_decalcification INTEGER NOT NULL DEFAULT 0 CHECK (needs_decalcification IN (0, 1)),
                cut_notes TEXT NOT NULL DEFAULT '',
                slide_notes TEXT NOT NULL DEFAULT '',
                stains TEXT NOT NULL DEFAULT '',
                overall_notes TEXT NOT NULL DEFAULT '',
                current_stage TEXT NOT NULL DEFAULT 'received',
                stage_received_at TEXT,
                decalc_completed_at TEXT,
                fixative_placed_at TEXT,
                fixative_removed_at TEXT,
                ethanol_placed_at TEXT,
                processing_started_at TEXT,
                stage_processed_at TEXT,
                stage_needs_embedding_at TEXT,
                stage_embedded_at TEXT,
                stage_needs_sectioning_at TEXT,
                stage_sectioned_at TEXT,
                stage_stain_requested_at TEXT,
                stage_stained_at TEXT,
                stage_deparaffinized_at TEXT,
                stage_ihc_at TEXT,
                stage_pictures_taken_at TEXT,
                stage_analyzed_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_project_code
                ON samples(project_id, sample_code);
            """
        )
        self._ensure_columns(
            "samples",
            {
                "project_sample_number": "INTEGER",
                "sample_description": "TEXT NOT NULL DEFAULT ''",
                "fixative_agent": "TEXT NOT NULL DEFAULT 'PFA'",
                "needs_decalcification": "INTEGER NOT NULL DEFAULT 0",
                "decalc_completed_at": "TEXT",
                "fixative_placed_at": "TEXT",
                "fixative_removed_at": "TEXT",
                "ethanol_placed_at": "TEXT",
                "processing_started_at": "TEXT",
                "stage_needs_embedding_at": "TEXT",
                "stage_embedded_at": "TEXT",
                "stage_needs_sectioning_at": "TEXT",
                "stage_sectioned_at": "TEXT",
                "stage_stain_requested_at": "TEXT",
                "stage_pictures_taken_at": "TEXT",
                "sectioning_plan": "TEXT NOT NULL DEFAULT ''",
            },
        )
        self.connection.commit()

    def _ensure_columns(self, table: str, columns: dict[str, str]) -> None:
        existing = {
            row["name"]
            for row in self.connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
        for column_name, column_definition in columns.items():
            if column_name not in existing:
                self.connection.execute(
                    f"ALTER TABLE {table} ADD COLUMN {column_name} {column_definition}"
                )

    def add_project(self, code: str, name: str, team_lead: str, is_active: bool) -> int:
        cursor = self.connection.execute(
            """
            INSERT INTO projects (code, name, team_lead, is_active)
            VALUES (?, ?, ?, ?)
            """,
            (code.strip().upper(), name.strip(), team_lead.strip(), 1 if is_active else 0),
        )
        self.connection.commit()
        return int(cursor.lastrowid)

    def list_projects(self, active_only: bool = False) -> list[sqlite3.Row]:
        query = """
            SELECT
                p.*,
                COUNT(s.id) AS sample_count
            FROM projects p
            LEFT JOIN samples s ON s.project_id = p.id
        """
        params: tuple[object, ...] = ()
        if active_only:
            query += " WHERE p.is_active = ?"
            params = (1,)
        query += """
            GROUP BY p.id
            ORDER BY p.is_active DESC, p.code COLLATE NOCASE, p.name COLLATE NOCASE
        """
        return list(self.connection.execute(query, params).fetchall())

    def get_project(self, project_id: int) -> sqlite3.Row | None:
        return self.connection.execute(
            """
            SELECT
                p.*,
                COUNT(s.id) AS sample_count
            FROM projects p
            LEFT JOIN samples s ON s.project_id = p.id
            WHERE p.id = ?
            GROUP BY p.id
            """,
            (project_id,),
        ).fetchone()

    def set_project_active(self, project_id: int, is_active: bool) -> None:
        self.connection.execute(
            "UPDATE projects SET is_active = ? WHERE id = ?",
            (1 if is_active else 0, project_id),
        )
        self.connection.commit()

    def next_project_sample_number(self, project_id: int) -> int:
        row = self.connection.execute(
            """
            SELECT COALESCE(MAX(project_sample_number), 0) + 1 AS next_number
            FROM samples
            WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        return int(row["next_number"])

    def next_sample_code(self, project_id: int) -> str:
        project = self.get_project(project_id)
        if not project:
            return ""
        next_number = self.next_project_sample_number(project_id)
        return f"{project['code'].strip().upper()}-{next_number:04d}"

    def add_sample(
        self,
        project_id: int,
        sample_description: str,
        processing_type: str,
        fixative_agent: str,
        needs_decalcification: bool,
        cut_notes: str,
        slide_notes: str,
        stains: str,
        overall_notes: str,
    ) -> int:
        project = self.get_project(project_id)
        if not project:
            raise ValueError("Project does not exist.")

        timestamp = now_timestamp()
        project_sample_number = self.next_project_sample_number(project_id)
        sample_code = f"{project['code'].strip().upper()}-{project_sample_number:04d}"
        cursor = self.connection.execute(
            """
            INSERT INTO samples (
                project_id,
                project_sample_number,
                sample_code,
                sample_description,
                date_added,
                processing_type,
                fixative_agent,
                needs_decalcification,
                cut_notes,
                slide_notes,
                stains,
                overall_notes,
                current_stage,
                stage_received_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                project_sample_number,
                sample_code,
                sample_description.strip(),
                date.today().isoformat(),
                processing_type,
                fixative_agent,
                1 if needs_decalcification else 0,
                cut_notes.strip(),
                slide_notes.strip(),
                stains.strip(),
                overall_notes.strip(),
                "received",
                timestamp,
            ),
        )
        self.connection.commit()
        return int(cursor.lastrowid)

    def list_samples(self, project_id: int) -> list[sqlite3.Row]:
        return list(
            self.connection.execute(
                """
                SELECT *
                FROM samples
                WHERE project_id = ?
                ORDER BY date_added DESC, id DESC
                """,
                (project_id,),
            ).fetchall()
        )

    def list_open_samples(self) -> list[sqlite3.Row]:
        return list(
            self.connection.execute(
                """
                SELECT
                    s.*,
                    p.code AS project_code,
                    p.name AS project_name,
                    p.team_lead AS team_lead
                FROM samples s
                JOIN projects p ON p.id = s.project_id
                WHERE p.is_active = 1
                  AND s.current_stage != 'analyzed'
                ORDER BY
                    s.date_added ASC,
                    s.id ASC
                """
            ).fetchall()
        )

    def auto_advance_processing_runs(self, current_time: datetime | None = None) -> int:
        current_time = current_time or datetime.now()
        moved_count = 0
        samples = self.connection.execute(
            """
            SELECT id, processing_type, processing_started_at
            FROM samples
            WHERE current_stage = 'processing_started'
            """
        ).fetchall()

        for sample in samples:
            started_at = parse_timestamp(sample["processing_started_at"])
            if not started_at:
                continue

            ready_at = started_at + timedelta(
                hours=processing_duration_hours(sample["processing_type"])
            )
            if current_time < ready_at:
                continue

            self.connection.execute(
                """
                UPDATE samples
                SET current_stage = 'processed',
                    stage_processed_at = COALESCE(stage_processed_at, ?)
                WHERE id = ?
                """,
                (ready_at.strftime(TIMESTAMP_FORMAT), sample["id"]),
            )
            moved_count += 1

        if moved_count:
            self.connection.commit()
        return moved_count

    def get_sample(self, sample_id: int) -> sqlite3.Row | None:
        return self.connection.execute(
            "SELECT * FROM samples WHERE id = ?",
            (sample_id,),
        ).fetchone()

    def snapshot_sample(self, sample_id: int) -> dict[str, object] | None:
        sample = self.get_sample(sample_id)
        if not sample:
            return None
        return dict(sample)

    def restore_sample_snapshot(self, snapshot: dict[str, object]) -> None:
        sample_id = int(snapshot["id"])
        mutable_columns = [
            "project_sample_number",
            "sample_code",
            "sample_description",
            "date_added",
            "processing_type",
            "fixative_agent",
            "needs_decalcification",
            "cut_notes",
            "slide_notes",
            "stains",
            "overall_notes",
            "current_stage",
            "stage_received_at",
            "fixative_placed_at",
            "fixative_removed_at",
            "ethanol_placed_at",
            "processing_started_at",
            "stage_processed_at",
            "stage_needs_embedding_at",
            "stage_embedded_at",
            "stage_needs_sectioning_at",
            "stage_sectioned_at",
            "stage_stain_requested_at",
            "stage_stained_at",
            "stage_deparaffinized_at",
            "stage_ihc_at",
            "stage_pictures_taken_at",
            "stage_analyzed_at",
        ]
        assignments = ", ".join(f"{column} = ?" for column in mutable_columns)
        values = [snapshot[column] for column in mutable_columns]
        self.connection.execute(
            f"UPDATE samples SET {assignments} WHERE id = ?",
            (*values, sample_id),
        )
        self.connection.commit()

    def delete_sample(self, sample_id: int) -> None:
        self.connection.execute("DELETE FROM samples WHERE id = ?", (sample_id,))
        self.connection.commit()

    def update_sectioning_plan(self, sample_id: int, plan: list[dict]) -> None:
        self.connection.execute(
            "UPDATE samples SET sectioning_plan = ? WHERE id = ?",
            (json.dumps(plan), sample_id),
        )
        self.connection.commit()

    def get_sectioning_plan(self, sample_id: int) -> list[dict]:
        row = self.connection.execute(
            "SELECT sectioning_plan FROM samples WHERE id = ?", (sample_id,)
        ).fetchone()
        if not row or not row["sectioning_plan"]:
            return []
        try:
            return json.loads(row["sectioning_plan"])
        except (json.JSONDecodeError, TypeError):
            return []

    def update_sample_details(
        self,
        sample_id: int,
        sample_description: str,
        processing_type: str,
        fixative_agent: str,
        needs_decalcification: bool,
        cut_notes: str,
        slide_notes: str,
        stains: str,
        overall_notes: str,
    ) -> None:
        self.connection.execute(
            """
            UPDATE samples
            SET sample_description = ?,
                processing_type = ?,
                fixative_agent = ?,
                needs_decalcification = ?,
                cut_notes = ?,
                slide_notes = ?,
                stains = ?,
                overall_notes = ?
            WHERE id = ?
            """,
            (
                sample_description.strip(),
                processing_type,
                fixative_agent,
                1 if needs_decalcification else 0,
                cut_notes.strip(),
                slide_notes.strip(),
                stains.strip(),
                overall_notes.strip(),
                sample_id,
            ),
        )
        self.connection.commit()

    def mark_preprocessing_step(self, sample_id: int, stage_key: str) -> None:
        stage_column = STAGE_COLUMNS[stage_key]
        timestamp = now_timestamp()
        self.connection.execute(
            f"""
            UPDATE samples
            SET current_stage = ?,
                {stage_column} = COALESCE({stage_column}, ?)
            WHERE id = ?
            """,
            (stage_key, timestamp, sample_id),
        )
        self.connection.commit()

    def update_sample_stage(self, sample_id: int, stage_key: str) -> None:
        stage_column = STAGE_COLUMNS[stage_key]
        timestamp = now_timestamp()
        self.connection.execute(
            f"""
            UPDATE samples
            SET current_stage = ?,
                {stage_column} = COALESCE({stage_column}, ?)
            WHERE id = ?
            """,
            (stage_key, timestamp, sample_id),
        )
        self.connection.commit()


class ProjectDialog(tk.Toplevel):
    def __init__(
        self,
        master: "HistometerApp",
        on_save: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(master)
        self.master = master
        self.on_save = on_save
        self.title("Add Project")
        self.resizable(False, False)
        self.transient(master)
        self.grab_set()

        self.code_var = tk.StringVar()
        self.name_var = tk.StringVar()
        self.team_lead_var = tk.StringVar()
        self.is_active_var = tk.BooleanVar(value=True)

        container = ttk.Frame(self, padding=16)
        container.grid(sticky="nsew")
        self.columnconfigure(0, weight=1)

        ttk.Label(container, text="Project Code").grid(row=0, column=0, sticky="w")
        ttk.Entry(container, textvariable=self.code_var, width=36).grid(
            row=1, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(container, text="Project Name").grid(row=2, column=0, sticky="w")
        ttk.Entry(container, textvariable=self.name_var, width=36).grid(
            row=3, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(container, text="Team Lead").grid(row=4, column=0, sticky="w")
        ttk.Entry(container, textvariable=self.team_lead_var, width=36).grid(
            row=5, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Checkbutton(
            container,
            text="Show in active project sidebar",
            variable=self.is_active_var,
        ).grid(row=6, column=0, sticky="w", pady=(0, 14))

        button_row = ttk.Frame(container)
        button_row.grid(row=7, column=0, sticky="e")
        ttk.Button(button_row, text="Cancel", command=self.destroy).grid(
            row=0, column=0, padx=(0, 8)
        )
        ttk.Button(button_row, text="Save Project", command=self.save_project).grid(
            row=0, column=1
        )

        self.bind("<Return>", lambda _event: self.save_project())
        self.bind("<Escape>", lambda _event: self.destroy())

    def save_project(self) -> None:
        code = self.code_var.get().strip()
        name = self.name_var.get().strip()
        team_lead = self.team_lead_var.get().strip()
        if not code or not name or not team_lead:
            messagebox.showwarning("Missing information", "Please fill in all project fields.")
            return

        try:
            project_id = self.master.db.add_project(
                code=code,
                name=name,
                team_lead=team_lead,
                is_active=self.is_active_var.get(),
            )
        except sqlite3.IntegrityError:
            messagebox.showerror(
                "Duplicate project code",
                f"A project with code '{code}' already exists.",
            )
            return

        self.master.refresh_projects(select_project_id=project_id)
        if self.on_save:
            self.on_save()
        self.destroy()


class ProjectManagerDialog(tk.Toplevel):
    def __init__(self, master: "HistometerApp") -> None:
        super().__init__(master)
        self.master = master
        self.title("Manage Projects")
        self.geometry("760x420")
        self.minsize(700, 360)
        self.transient(master)

        container = ttk.Frame(self, padding=16)
        container.grid(sticky="nsew")
        container.columnconfigure(0, weight=1)
        container.rowconfigure(1, weight=1)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)

        ttk.Label(
            container,
            text="Project Manager",
            font=("Segoe UI Semibold", 14),
        ).grid(row=0, column=0, sticky="w", pady=(0, 12))

        self.tree = ttk.Treeview(
            container,
            columns=("code", "name", "lead", "status", "samples"),
            show="headings",
            selectmode="browse",
        )
        headings = [
            ("code", "Code", 110),
            ("name", "Project Name", 240),
            ("lead", "Team Lead", 150),
            ("status", "Status", 90),
            ("samples", "Samples", 90),
        ]
        for key, label, width in headings:
            self.tree.heading(key, text=label)
            self.tree.column(key, width=width, anchor="w")
        self.tree.grid(row=1, column=0, sticky="nsew")

        scrollbar = ttk.Scrollbar(container, orient="vertical", command=self.tree.yview)
        scrollbar.grid(row=1, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=scrollbar.set)

        button_row = ttk.Frame(container)
        button_row.grid(row=2, column=0, sticky="e", pady=(12, 0))
        ttk.Button(button_row, text="Add Project", command=self.open_add_project_dialog).grid(
            row=0, column=0, padx=(0, 8)
        )
        ttk.Button(button_row, text="Activate", command=lambda: self.set_status(True)).grid(
            row=0, column=1, padx=(0, 8)
        )
        ttk.Button(button_row, text="Deactivate", command=lambda: self.set_status(False)).grid(
            row=0, column=2, padx=(0, 8)
        )
        ttk.Button(button_row, text="Refresh", command=self.refresh).grid(row=0, column=3)

        self.refresh()

    def refresh(self) -> None:
        self.tree.delete(*self.tree.get_children())
        for project in self.master.db.list_projects(active_only=False):
            status = "Active" if project["is_active"] else "Inactive"
            self.tree.insert(
                "",
                "end",
                iid=str(project["id"]),
                values=(
                    project["code"],
                    project["name"],
                    project["team_lead"],
                    status,
                    project["sample_count"],
                ),
            )

    def set_status(self, is_active: bool) -> None:
        selection = self.tree.selection()
        if not selection:
            messagebox.showinfo("No project selected", "Choose a project first.")
            return

        project_id = int(selection[0])
        self.master.db.set_project_active(project_id, is_active)
        self.master.refresh_projects(select_project_id=project_id if is_active else None)
        self.refresh()

    def open_add_project_dialog(self) -> None:
        ProjectDialog(self.master, on_save=self.refresh)


class NewSampleDialog(tk.Toplevel):
    def __init__(self, master: "HistometerApp") -> None:
        super().__init__(master)
        self.master = master
        self.title("New Sample")
        self.geometry("460x660")
        self.minsize(420, 560)
        self.transient(master)
        self.grab_set()

        self.sample_code_var = tk.StringVar(value=master.current_next_sample_code())
        self.description_var = tk.StringVar()
        self.processing_var = tk.StringVar(value="Short")
        self.fixative_var = tk.StringVar(value=FIXATIVE_OPTIONS[0])
        self.decalc_var = tk.BooleanVar(value=False)

        container = ttk.Frame(self, padding=18)
        container.grid(sticky="nsew")
        container.columnconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)

        ttk.Label(
            container,
            text="Create Sample",
            font=("Segoe UI Semibold", 16),
        ).grid(row=0, column=0, sticky="w", pady=(0, 12))

        ttk.Label(container, text="Next Sample ID").grid(row=1, column=0, sticky="w")
        ttk.Entry(container, textvariable=self.sample_code_var, state="readonly").grid(
            row=2, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(container, text="Description").grid(row=3, column=0, sticky="w")
        ttk.Entry(container, textvariable=self.description_var).grid(
            row=4, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(container, text="Fixative").grid(row=5, column=0, sticky="w")
        ttk.Combobox(
            container,
            textvariable=self.fixative_var,
            values=FIXATIVE_OPTIONS,
            state="readonly",
        ).grid(row=6, column=0, sticky="ew", pady=(0, 10))

        ttk.Checkbutton(
            container,
            text="Decalcification needed before fixation",
            variable=self.decalc_var,
        ).grid(row=7, column=0, sticky="w", pady=(0, 10))

        ttk.Label(container, text="Processing").grid(row=8, column=0, sticky="w")
        ttk.Combobox(
            container,
            textvariable=self.processing_var,
            values=PROCESSING_OPTIONS,
            state="readonly",
        ).grid(row=9, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(container, text="Sectioning / Cut Notes").grid(row=10, column=0, sticky="w")
        self.cut_notes_text = tk.Text(container, height=4, wrap="word")
        self.cut_notes_text.grid(row=11, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(container, text="Slide Notes").grid(row=12, column=0, sticky="w")
        self.slide_notes_text = tk.Text(container, height=4, wrap="word")
        self.slide_notes_text.grid(row=13, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(container, text="General Notes").grid(row=14, column=0, sticky="w")
        self.overall_notes_text = tk.Text(container, height=4, wrap="word")
        self.overall_notes_text.grid(row=15, column=0, sticky="ew", pady=(0, 14))

        button_row = ttk.Frame(container)
        button_row.grid(row=16, column=0, sticky="e")
        ttk.Button(button_row, text="Cancel", command=self.destroy).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(button_row, text="Create Sample", style="Accent.TButton", command=self.create_sample).grid(
            row=0, column=1
        )

        self.bind("<Escape>", lambda _event: self.destroy())

    def create_sample(self) -> None:
        sample_id = self.master.create_sample(
            sample_description=self.description_var.get(),
            processing_type=self.processing_var.get(),
            fixative_agent=self.fixative_var.get(),
            needs_decalcification=self.decalc_var.get(),
            cut_notes=self._text_value(self.cut_notes_text),
            slide_notes=self._text_value(self.slide_notes_text),
            stains="",
            overall_notes=self._text_value(self.overall_notes_text),
        )
        if sample_id:
            self.destroy()

    @staticmethod
    def _text_value(widget: tk.Text) -> str:
        return widget.get("1.0", "end").strip()


class SectioningPlanDialog(tk.Toplevel):
    def __init__(self, master: "HistometerApp", sample_id: int) -> None:
        super().__init__(master)
        self.master = master
        self.sample_id = sample_id
        self.section_rows: list[dict] = []

        sample = master.db.get_sample(sample_id)
        if not sample:
            self.destroy()
            return

        self.title(f"Sectioning Plan — {sample['sample_code']}")
        self.geometry("440x460")
        self.minsize(380, 340)
        self.resizable(True, True)
        self.transient(master)
        self.grab_set()

        container = ttk.Frame(self, padding=18)
        container.grid(sticky="nsew")
        container.columnconfigure(0, weight=1)
        container.rowconfigure(2, weight=1)
        self.columnconfigure(0, weight=1)
        self.rowconfigure(0, weight=1)

        ttk.Label(container, text="Sectioning Plan", font=("Segoe UI Semibold", 14)).grid(
            row=0, column=0, sticky="w"
        )
        desc = sample["sample_description"] or ""
        ttk.Label(
            container,
            text=f"{sample['sample_code']}  {desc}".strip(),
            style="Muted.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(2, 14))

        col_header = ttk.Frame(container)
        col_header.grid(row=2, column=0, sticky="ew")
        col_header.columnconfigure(1, weight=1)
        ttk.Label(col_header, text="#", font=("Segoe UI Semibold", 9), width=2).grid(row=0, column=0)
        ttk.Label(col_header, text="Depth (µm)", font=("Segoe UI Semibold", 9)).grid(row=0, column=1, sticky="w", padx=(6, 0))
        ttk.Label(col_header, text="Duplicates", font=("Segoe UI Semibold", 9)).grid(row=0, column=2, sticky="w", padx=(12, 0))

        self.rows_frame = ttk.Frame(container)
        self.rows_frame.grid(row=3, column=0, sticky="nsew", pady=(4, 0))
        self.rows_frame.columnconfigure(1, weight=1)
        container.rowconfigure(3, weight=1)

        for entry in master.db.get_sectioning_plan(sample_id):
            self._add_row(
                depth=str(entry.get("depth_um", "100")),
                duplicates=int(entry.get("duplicates", 1)),
            )
        if not self.section_rows:
            self._add_row()

        ttk.Button(container, text="+ Add Section", command=self._add_row).grid(
            row=4, column=0, sticky="w", pady=(10, 0)
        )

        self.total_var = tk.StringVar()
        ttk.Label(container, textvariable=self.total_var, style="Muted.TLabel").grid(
            row=5, column=0, sticky="w", pady=(8, 0)
        )
        self._update_total()

        btn_row = ttk.Frame(container)
        btn_row.grid(row=6, column=0, sticky="e", pady=(14, 0))
        ttk.Button(btn_row, text="Cancel", command=self.destroy).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(btn_row, text="Save Plan", style="Accent.TButton", command=self._save).grid(row=0, column=1)

        self.bind("<Escape>", lambda _: self.destroy())

    def _add_row(self, depth: str = "100", duplicates: int = 1) -> None:
        row_index = len(self.section_rows)
        depth_var = tk.StringVar(value=depth)
        duplicates_var = tk.IntVar(value=duplicates)

        frame = ttk.Frame(self.rows_frame)
        frame.grid(row=row_index, column=0, columnspan=4, sticky="ew", pady=(0, 5))
        frame.columnconfigure(1, weight=1)

        ttk.Label(frame, text=f"{row_index + 1}.", width=2).grid(row=0, column=0, sticky="w")

        combo = ttk.Combobox(
            frame,
            textvariable=depth_var,
            values=SECTION_DEPTH_OPTIONS,
            width=8,
        )
        combo.grid(row=0, column=1, sticky="w", padx=(6, 0))
        combo.bind("<<ComboboxSelected>>", lambda _: self._update_total())
        depth_var.trace_add("write", lambda *_: self._update_total())

        ttk.Label(frame, text="×").grid(row=0, column=2, padx=(12, 4))

        spin = ttk.Spinbox(frame, textvariable=duplicates_var, from_=1, to=99, width=5)
        spin.grid(row=0, column=3)
        duplicates_var.trace_add("write", lambda *_: self._update_total())

        entry_data = {"frame": frame, "depth_var": depth_var, "duplicates_var": duplicates_var}
        remove_btn = ttk.Button(
            frame, text="×", width=2,
            command=lambda e=entry_data: self._remove_row(e),
        )
        remove_btn.grid(row=0, column=4, padx=(8, 0))

        self.section_rows.append(entry_data)
        self._update_total()

    def _remove_row(self, entry: dict) -> None:
        if entry in self.section_rows:
            self.section_rows.remove(entry)
        entry["frame"].destroy()
        self._update_total()

    def _update_total(self) -> None:
        n = len(self.section_rows)
        total = 0
        for row_data in self.section_rows:
            try:
                total += max(1, int(row_data["duplicates_var"].get()))
            except (tk.TclError, ValueError):
                total += 1
        sec = "section" if n == 1 else "sections"
        sld = "slide" if total == 1 else "slides"
        self.total_var.set(f"{n} {sec} · {total} planned {sld}")

    def _save(self) -> None:
        plan = []
        for row_data in self.section_rows:
            depth_str = row_data["depth_var"].get().strip()
            try:
                depth_um = int(depth_str)
            except ValueError:
                depth_um = 0
            try:
                dups = max(1, int(row_data["duplicates_var"].get()))
            except (tk.TclError, ValueError):
                dups = 1
            plan.append({"depth_um": depth_um, "duplicates": dups})
        self.master.db.update_sectioning_plan(self.sample_id, plan)
        self.master.refresh_samples()
        self.destroy()


class HistometerApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("1480x920")
        self.minsize(1260, 760)
        self.configure(bg="#f0f2f5")

        self.db = HistometerDB(DB_PATH)
        self.selected_project_id: int | None = None
        self.selected_sample_id: int | None = None
        self.selected_queue_key: str | None = None
        self.undo_stack: list[dict[str, object]] = []
        self.detail_card: ttk.Frame | None = None
        self.board_canvases: dict[str, tk.Canvas] = {}
        self.board_card_frames: dict[str, tk.Frame] = {}
        self.board_card_widgets: dict[int, tk.Frame] = {}
        self.queue_widget_map: dict[tk.Widget, str] = {}
        self.drag_sample_id: int | None = None
        self.drag_source_queue_key: str | None = None
        self.drag_ghost: tk.Toplevel | None = None
        self.scroll_targets: dict[str, float] = {}
        self.scroll_jobs: dict[str, str] = {}
        self.board_items: dict[str, list[int]] = {queue_key: [] for queue_key in BOARD_QUEUE_KEYS}
        self.board_count_vars = {
            queue_key: tk.StringVar(value="0 samples") for queue_key in BOARD_QUEUE_KEYS
        }

        self.project_name_var = tk.StringVar(value="Select an active project")
        self.project_meta_var = tk.StringVar(
            value="Use the left sidebar to pick a project or add a new one."
        )
        self.project_count_var = tk.StringVar(value="Samples tracked: 0")
        self.status_var = tk.StringVar(value="Saved")
        self.embedded_project_filter_var = tk.StringVar(value="All Projects")
        self.embedded_project_filter_lookup: dict[str, int | None] = {"All Projects": None}
        self.embedded_filter_combo: ttk.Combobox | None = None

        self.new_sample_code_var = tk.StringVar()
        self.new_processing_var = tk.StringVar(value="Short")
        self.new_fixative_var = tk.StringVar(value=FIXATIVE_OPTIONS[0])
        self.new_decalc_var = tk.BooleanVar(value=False)
        self.new_stains_var = tk.StringVar()

        self.detail_sample_code_var = tk.StringVar(value="No sample selected")
        self.detail_description_var = tk.StringVar()
        self.detail_processing_var = tk.StringVar(value="Short")
        self.detail_fixative_var = tk.StringVar(value=FIXATIVE_OPTIONS[0])
        self.detail_decalc_var = tk.BooleanVar(value=False)
        self.detail_stains_var = tk.StringVar()
        self.detail_stage_var = tk.StringVar(value=STAGES[0][1])
        self.preprocessing_vars = {
            key: tk.BooleanVar(value=False) for key, _label, _column in PREPROCESSING_STEPS
        }
        self.preprocessing_time_vars = {
            key: tk.StringVar(value=f"{label}: Not recorded")
            for key, label, _column in PREPROCESSING_STEPS
        }
        self.timeline_vars = {
            key: tk.StringVar(value=f"{label}: Not recorded") for key, label in STAGES
        }

        self._configure_style()
        self._build_layout()
        self.bind_all("<Control-z>", lambda _event: self.undo_last_action())
        self.bind_all("<Control-s>", lambda _event: self.save_database())
        self.refresh_projects()

    def _configure_style(self) -> None:
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(".", font=("Segoe UI", 10), background="#f0f2f5")
        style.configure("Card.TFrame", background="#ffffff")
        style.configure("Sidebar.TFrame", background="#1b2e3c")
        style.configure("SidebarTitle.TLabel", background="#1b2e3c", foreground="#ffffff", font=("Segoe UI Semibold", 14))
        style.configure("SidebarNote.TLabel", background="#1b2e3c", foreground="#8eb8cc")
        style.configure("Surface.TFrame", background="#f0f2f5")
        style.configure("CardTitle.TLabel", background="#ffffff", foreground="#1a2535")
        style.configure("Muted.TLabel", background="#ffffff", foreground="#6b7a86")
        style.configure("SurfaceMuted.TLabel", background="#f0f2f5", foreground="#6b7a86")
        style.configure("Accent.TButton", font=("Segoe UI Semibold", 10), padding=(10, 5))
        style.configure("TButton", padding=(8, 5))
        style.configure("Queue.TFrame", background="#f8f9fb", relief="flat", borderwidth=0)
        style.configure("QueueTitle.TLabel", background="#f8f9fb", foreground="#1a2535", font=("Segoe UI Semibold", 10))
        style.configure("QueueMuted.TLabel", background="#f8f9fb", foreground="#8a96a0", font=("Segoe UI", 9))
        style.configure(
            "Treeview",
            rowheight=28,
            fieldbackground="#ffffff",
            background="#ffffff",
        )
        style.configure("Treeview.Heading", font=("Segoe UI Semibold", 10))
        style.configure(
            "Sidebar.Treeview",
            rowheight=30,
            fieldbackground="#1b2e3c",
            background="#1b2e3c",
            foreground="#c5dce8",
            borderwidth=0,
            relief="flat",
            font=("Segoe UI", 10),
        )
        style.map(
            "Sidebar.Treeview",
            background=[("selected", "#2e5068")],
            foreground=[("selected", "#ffffff")],
        )

    def _build_layout(self) -> None:
        self.columnconfigure(1, weight=1)
        self.rowconfigure(0, weight=1)

        sidebar = ttk.Frame(self, style="Sidebar.TFrame", padding=(12, 16))
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.columnconfigure(0, weight=1)
        sidebar.rowconfigure(1, weight=1)

        sidebar_header = ttk.Frame(sidebar, style="Sidebar.TFrame")
        sidebar_header.grid(row=0, column=0, sticky="ew", pady=(0, 12))
        sidebar_header.columnconfigure(0, weight=1)
        ttk.Label(
            sidebar_header,
            text="Projects",
            style="SidebarTitle.TLabel",
            font=("Segoe UI Semibold", 14),
        ).grid(row=0, column=0, sticky="w")
        ttk.Button(sidebar_header, text="+", width=3, command=self.open_add_project_dialog).grid(
            row=0, column=1, sticky="e", padx=(8, 0)
        )

        project_frame = ttk.Frame(sidebar)
        project_frame.grid(row=1, column=0, sticky="nsew")
        project_frame.columnconfigure(0, weight=1)
        project_frame.rowconfigure(0, weight=1)

        self.project_tree = ttk.Treeview(
            project_frame,
            show="tree",
            selectmode="browse",
            height=18,
            style="Sidebar.Treeview",
        )
        self.project_tree.column("#0", width=188, anchor="w", stretch=True)
        self.project_tree.grid(row=0, column=0, sticky="nsew")
        self.project_tree.bind("<<TreeviewSelect>>", self._on_project_selected)
        self.project_tree.bind("<MouseWheel>", self._scroll_projects)

        sidebar_buttons = ttk.Frame(sidebar, style="Sidebar.TFrame")
        sidebar_buttons.grid(row=2, column=0, sticky="ew", pady=(12, 0))
        sidebar_buttons.columnconfigure(0, weight=1)
        ttk.Button(sidebar_buttons, text="Manage Projects", command=self.open_project_manager).grid(
            row=0, column=0, sticky="ew"
        )

        content = ttk.Frame(self, style="Surface.TFrame", padding=18)
        content.grid(row=0, column=1, sticky="nsew")
        content.columnconfigure(0, weight=1)
        content.columnconfigure(1, weight=0)
        content.rowconfigure(1, weight=1)

        header_card = ttk.Frame(content, style="Card.TFrame", padding=(20, 12))
        header_card.grid(row=0, column=0, sticky="ew", pady=(0, 14))
        header_card.columnconfigure(0, weight=1)
        ttk.Label(
            header_card,
            textvariable=self.project_name_var,
            style="CardTitle.TLabel",
            font=("Segoe UI Semibold", 17),
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            header_card,
            textvariable=self.project_meta_var,
            style="Muted.TLabel",
            wraplength=760,
        ).grid(row=1, column=0, sticky="w", pady=(6, 4))
        ttk.Label(
            header_card,
            textvariable=self.project_count_var,
            style="Muted.TLabel",
        ).grid(row=2, column=0, sticky="w")
        ttk.Label(
            header_card,
            textvariable=self.status_var,
            style="Muted.TLabel",
        ).grid(row=0, column=1, sticky="e")

        upper_split = ttk.Frame(content, style="Surface.TFrame")
        upper_split.grid(row=1, column=0, sticky="nsew", pady=(0, 8))
        upper_split.columnconfigure(0, weight=1)
        upper_split.columnconfigure(1, weight=0)
        upper_split.rowconfigure(0, weight=1)

        board_card = ttk.Frame(upper_split, style="Card.TFrame", padding=18)
        board_card.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        board_card.columnconfigure(0, weight=1)
        board_card.rowconfigure(1, weight=1)

        board_header = ttk.Frame(board_card, style="Card.TFrame")
        board_header.grid(row=0, column=0, sticky="ew", pady=(0, 10))
        board_header.columnconfigure(0, weight=1)
        ttk.Label(
            board_header,
            text="Open Histology Workflow",
            style="CardTitle.TLabel",
            font=("Segoe UI Semibold", 13),
        ).grid(row=0, column=0, sticky="w")

        board_actions = ttk.Frame(board_header, style="Card.TFrame")
        board_actions.grid(row=0, column=1, sticky="e")
        ttk.Button(
            board_actions,
            text="+ New Sample",
            style="Accent.TButton",
            command=self.open_new_sample_dialog,
        ).grid(row=0, column=0, padx=(0, 10))
        ttk.Button(board_actions, text="Undo", command=self.undo_last_action).grid(
            row=0, column=1, padx=(0, 6)
        )
        ttk.Button(board_actions, text="Save", command=self.save_database).grid(
            row=0, column=2, padx=(0, 6)
        )
        ttk.Button(board_actions, text="Details", command=self.show_details_panel).grid(
            row=0, column=3, padx=(0, 6)
        )
        ttk.Button(board_actions, text="Mark Analyzed", command=self.mark_selected_analyzed).grid(
            row=0, column=4, padx=(0, 6)
        )
        ttk.Button(board_actions, text="Refresh", command=self.refresh_samples).grid(row=0, column=5)

        board_frame = ttk.Frame(board_card, style="Card.TFrame")
        board_frame.grid(row=1, column=0, sticky="nsew")
        board_frame.columnconfigure(0, weight=1)

        for row_index, (lane_title, queue_keys) in enumerate(BOARD_QUEUE_ROWS):
            board_frame.rowconfigure(row_index * 2 + 1, weight=1)
            lane_header = ttk.Frame(board_frame, style="Card.TFrame")
            lane_header.grid(row=row_index * 2, column=0, sticky="ew", pady=(0 if row_index == 0 else 16, 8))
            tk.Frame(lane_header, background=LANE_COLORS[row_index], width=4).pack(side="left", fill="y", padx=(0, 8))
            ttk.Label(
                lane_header,
                text=lane_title,
                style="CardTitle.TLabel",
                font=("Segoe UI Semibold", 12),
            ).pack(side="left", anchor="w")

            lane_frame = ttk.Frame(board_frame, style="Card.TFrame")
            lane_frame.grid(row=row_index * 2 + 1, column=0, sticky="nsew")
            lane_frame.rowconfigure(0, weight=1)
            for column_index, queue_key in enumerate(queue_keys):
                lane_frame.columnconfigure(column_index, weight=1, uniform=f"lane_{row_index}")
                title = BOARD_QUEUE_TITLES[queue_key]

                queue_outer = tk.Frame(lane_frame, background=LANE_COLORS[row_index])
                queue_outer.grid(row=0, column=column_index, sticky="nsew", padx=(0, 8))
                queue_outer.columnconfigure(0, weight=1)
                queue_outer.rowconfigure(0, weight=1)
                self.queue_widget_map[queue_outer] = queue_key

                queue_frame = ttk.Frame(queue_outer, style="Queue.TFrame", padding=(8, 8))
                queue_frame.pack(fill="both", expand=True, padx=1, pady=(4, 1))
                queue_frame.columnconfigure(0, weight=1)
                content_row = 3 if queue_key == "embedded_inventory" else 2
                queue_frame.rowconfigure(content_row, weight=1)
                self.queue_widget_map[queue_frame] = queue_key

                ttk.Label(
                    queue_frame,
                    text=title,
                    style="QueueTitle.TLabel",
                    font=("Segoe UI Semibold", 10),
                ).grid(row=0, column=0, sticky="w", pady=(0, 2))
                ttk.Label(
                    queue_frame,
                    textvariable=self.board_count_vars[queue_key],
                    style="QueueMuted.TLabel",
                ).grid(row=1, column=0, sticky="w", pady=(0, 6))

                if queue_key == "embedded_inventory":
                    self.embedded_filter_combo = ttk.Combobox(
                        queue_frame,
                        textvariable=self.embedded_project_filter_var,
                        values=("All Projects",),
                        state="readonly",
                        width=18,
                    )
                    self.embedded_filter_combo.grid(row=2, column=0, sticky="ew", pady=(0, 6))
                    self.embedded_filter_combo.bind(
                        "<<ComboboxSelected>>",
                        self._on_embedded_filter_changed,
                    )

                canvas = tk.Canvas(
                    queue_frame,
                    background="#f8f9fb",
                    borderwidth=0,
                    highlightthickness=0,
                )
                canvas.grid(row=content_row, column=0, sticky="nsew")
                self.queue_widget_map[canvas] = queue_key

                card_frame = tk.Frame(canvas, background="#f8f9fb")
                card_frame.columnconfigure(0, weight=1, uniform=f"{queue_key}_cards")
                card_frame.columnconfigure(1, weight=1, uniform=f"{queue_key}_cards")
                self.queue_widget_map[card_frame] = queue_key
                window_id = canvas.create_window((0, 0), window=card_frame, anchor="nw")
                card_frame.bind(
                    "<Configure>",
                    lambda _event, c=canvas: c.configure(scrollregion=c.bbox("all")),
                )
                canvas.bind(
                    "<Configure>",
                    lambda event, c=canvas, window=window_id: c.itemconfigure(window, width=event.width),
                )
                canvas.bind(
                    "<MouseWheel>",
                    lambda event, c=canvas: self._scroll_queue(c, event),
                )

                self.board_canvases[queue_key] = canvas
                self.board_card_frames[queue_key] = card_frame

        add_sample_card = ttk.Frame(upper_split, style="Card.TFrame", padding=18)
        add_sample_card.grid(row=0, column=1, sticky="nsew")
        add_sample_card.columnconfigure(0, weight=1)

        ttk.Label(
            add_sample_card,
            text="Add Sample",
            style="CardTitle.TLabel",
            font=("Segoe UI Semibold", 13),
        ).grid(row=0, column=0, sticky="w")
        ttk.Label(
            add_sample_card,
            text=f"Date added is recorded automatically as {date.today().isoformat()}",
            style="Muted.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(4, 12))

        ttk.Label(add_sample_card, text="Next Sample ID").grid(row=2, column=0, sticky="w")
        ttk.Entry(add_sample_card, textvariable=self.new_sample_code_var, state="readonly").grid(
            row=3, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(add_sample_card, text="Fixative").grid(row=4, column=0, sticky="w")
        ttk.Combobox(
            add_sample_card,
            textvariable=self.new_fixative_var,
            values=FIXATIVE_OPTIONS,
            state="readonly",
        ).grid(row=5, column=0, sticky="ew", pady=(0, 10))

        ttk.Checkbutton(
            add_sample_card,
            text="Decalcification needed before fixation",
            variable=self.new_decalc_var,
        ).grid(row=6, column=0, sticky="w", pady=(0, 10))

        ttk.Label(add_sample_card, text="Processing").grid(row=7, column=0, sticky="w")
        ttk.Combobox(
            add_sample_card,
            textvariable=self.new_processing_var,
            values=PROCESSING_OPTIONS,
            state="readonly",
        ).grid(row=8, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(add_sample_card, text="Requested Stains / IHC").grid(row=9, column=0, sticky="w")
        ttk.Entry(add_sample_card, textvariable=self.new_stains_var).grid(
            row=10, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(add_sample_card, text="Sectioning / Cut Notes").grid(row=11, column=0, sticky="w")
        self.new_cut_notes_text = tk.Text(add_sample_card, height=3, wrap="word")
        self.new_cut_notes_text.grid(row=12, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(add_sample_card, text="Slide Notes").grid(row=13, column=0, sticky="w")
        self.new_slide_notes_text = tk.Text(add_sample_card, height=3, wrap="word")
        self.new_slide_notes_text.grid(row=14, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(add_sample_card, text="General Notes").grid(row=15, column=0, sticky="w")
        self.new_overall_notes_text = tk.Text(add_sample_card, height=3, wrap="word")
        self.new_overall_notes_text.grid(row=16, column=0, sticky="ew", pady=(0, 12))

        ttk.Button(
            add_sample_card,
            text="Create Sample",
            style="Accent.TButton",
            command=self.open_new_sample_dialog,
        ).grid(row=17, column=0, sticky="ew")
        add_sample_card.grid_remove()

        detail_card = ttk.Frame(content, style="Card.TFrame", padding=18, width=380)
        self.detail_card = detail_card
        detail_card.grid(row=0, column=1, rowspan=2, sticky="nsew", padx=(12, 0))
        detail_card.columnconfigure(0, weight=1)
        detail_card.columnconfigure(1, weight=0)
        detail_card.rowconfigure(2, weight=1)

        ttk.Label(
            detail_card,
            text="Selected Sample Details",
            style="CardTitle.TLabel",
            font=("Segoe UI Semibold", 13),
        ).grid(row=0, column=0, sticky="w", pady=(0, 10))
        ttk.Button(detail_card, text="Hide Details", command=self.hide_details_panel).grid(
            row=0, column=1, sticky="e", pady=(0, 10)
        )

        detail_form = ttk.Frame(detail_card)
        detail_form.grid(row=1, column=0, columnspan=2, sticky="ew")
        detail_form.columnconfigure(0, weight=1)

        ttk.Label(detail_form, textvariable=self.detail_sample_code_var).grid(
            row=0, column=0, sticky="w", pady=(0, 10)
        )

        ttk.Label(detail_form, text="Description").grid(row=1, column=0, sticky="w")
        ttk.Entry(detail_form, textvariable=self.detail_description_var).grid(
            row=2, column=0, sticky="ew", pady=(0, 10)
        )

        ttk.Label(detail_form, text="Fixative").grid(row=3, column=0, sticky="w")
        self.detail_fixative_combo = ttk.Combobox(
            detail_form,
            textvariable=self.detail_fixative_var,
            values=FIXATIVE_OPTIONS,
            state="readonly",
        )
        self.detail_fixative_combo.grid(row=4, column=0, sticky="ew", pady=(0, 10))

        ttk.Checkbutton(
            detail_form,
            text="Decalcification needed before fixation",
            variable=self.detail_decalc_var,
        ).grid(row=5, column=0, sticky="w", pady=(0, 10))

        ttk.Label(detail_form, text="Processing").grid(row=6, column=0, sticky="w")
        self.detail_processing_combo = ttk.Combobox(
            detail_form,
            textvariable=self.detail_processing_var,
            values=PROCESSING_OPTIONS,
            state="readonly",
        )
        self.detail_processing_combo.grid(row=7, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(detail_form, text="Requested Stains / IHC").grid(row=8, column=0, sticky="w")
        self.detail_stains_entry = ttk.Entry(detail_form, textvariable=self.detail_stains_var)
        self.detail_stains_entry.grid(row=9, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(detail_form, text="Sectioning / Cut Notes").grid(row=10, column=0, sticky="w")
        self.detail_cut_notes_text = tk.Text(detail_form, height=3, wrap="word")
        self.detail_cut_notes_text.grid(row=11, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(detail_form, text="Slide Notes").grid(row=12, column=0, sticky="w")
        self.detail_slide_notes_text = tk.Text(detail_form, height=3, wrap="word")
        self.detail_slide_notes_text.grid(row=13, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(detail_form, text="General Notes").grid(row=14, column=0, sticky="w")
        self.detail_overall_notes_text = tk.Text(detail_form, height=3, wrap="word")
        self.detail_overall_notes_text.grid(row=15, column=0, sticky="ew", pady=(0, 10))

        detail_button_row = ttk.Frame(detail_form)
        detail_button_row.grid(row=16, column=0, sticky="ew")
        detail_button_row.columnconfigure(0, weight=1)
        detail_button_row.columnconfigure(1, weight=1)
        ttk.Button(detail_button_row, text="Save Notes", command=self.save_selected_sample).grid(
            row=0, column=0, sticky="ew", padx=(0, 6)
        )
        ttk.Button(detail_button_row, text="Clear Selection", command=self.clear_sample_selection).grid(
            row=0, column=1, sticky="ew", padx=(6, 0)
        )

        timeline_card = ttk.Frame(detail_card)
        timeline_card.grid(row=2, column=0, columnspan=2, sticky="nsew", pady=(16, 0))
        timeline_card.columnconfigure(0, weight=1)

        ttk.Label(
            timeline_card,
            text="Workflow Timeline",
            style="CardTitle.TLabel",
            font=("Segoe UI Semibold", 13),
        ).grid(row=0, column=0, sticky="w", pady=(0, 10))

        ttk.Label(timeline_card, text="Set Current Stage").grid(row=1, column=0, sticky="w")
        self.detail_stage_combo = ttk.Combobox(
            timeline_card,
            textvariable=self.detail_stage_var,
            values=[label for _, label in STAGES],
            state="readonly",
        )
        self.detail_stage_combo.grid(row=2, column=0, sticky="ew", pady=(0, 10))
        ttk.Button(timeline_card, text="Update Stage", command=self.update_selected_stage).grid(
            row=3, column=0, sticky="ew", pady=(0, 14)
        )

        preprocessing_frame = ttk.LabelFrame(timeline_card, text="Pre-processing Checklist", padding=10)
        preprocessing_frame.grid(row=4, column=0, sticky="ew", pady=(0, 14))
        preprocessing_frame.columnconfigure(0, weight=1)
        for row_index, (stage_key, label, _column) in enumerate(PREPROCESSING_STEPS):
            ttk.Checkbutton(
                preprocessing_frame,
                text=label,
                variable=self.preprocessing_vars[stage_key],
                command=lambda key=stage_key: self.toggle_preprocessing_step(key),
            ).grid(row=row_index * 2, column=0, sticky="w")
            ttk.Label(
                preprocessing_frame,
                textvariable=self.preprocessing_time_vars[stage_key],
                style="Muted.TLabel",
                wraplength=320,
                justify="left",
            ).grid(row=row_index * 2 + 1, column=0, sticky="w", pady=(0, 6))

        timeline_frame = ttk.Frame(timeline_card)
        timeline_frame.grid(row=5, column=0, sticky="nsew")
        timeline_frame.columnconfigure(0, weight=1)
        for row_index, (stage_key, _label) in enumerate(STAGES):
            ttk.Label(
                timeline_frame,
                textvariable=self.timeline_vars[stage_key],
                style="Muted.TLabel",
                wraplength=320,
                justify="left",
            ).grid(row=row_index, column=0, sticky="w", pady=2)
        detail_card.grid_remove()

    def open_add_project_dialog(self) -> None:
        ProjectDialog(self)

    def open_project_manager(self) -> None:
        ProjectManagerDialog(self)

    def show_details_panel(self) -> None:
        if not self.selected_sample_id:
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return
        if self.detail_card:
            self.detail_card.grid()

    def hide_details_panel(self) -> None:
        if self.detail_card:
            self.detail_card.grid_remove()

    def save_database(self) -> None:
        self.db.connection.commit()
        self.status_var.set(f"Saved {now_timestamp()}")

    def _push_sample_undo(self, sample_id: int) -> None:
        snapshot = self.db.snapshot_sample(sample_id)
        if snapshot:
            self.undo_stack.append({"kind": "restore_sample", "snapshot": snapshot})

    def undo_last_action(self) -> None:
        if not self.undo_stack:
            self.status_var.set("Nothing to undo")
            return

        action = self.undo_stack.pop()
        if action["kind"] == "restore_sample":
            snapshot = action["snapshot"]
            self.db.restore_sample_snapshot(snapshot)
            sample_id = int(snapshot["id"])
            self.refresh_samples()
            self.select_sample_on_board(sample_id)
            self.status_var.set(f"Undo restored {snapshot['sample_code']}")
            return

        if action["kind"] == "delete_created_sample":
            sample_id = int(action["sample_id"])
            sample = self.db.get_sample(sample_id)
            sample_code = sample["sample_code"] if sample else "sample"
            self.db.delete_sample(sample_id)
            self.refresh_samples()
            self.clear_sample_selection()
            self.status_var.set(f"Undo removed {sample_code}")

    def refresh_projects(self, select_project_id: int | None = None) -> None:
        self.project_tree.delete(*self.project_tree.get_children())
        projects = self.db.list_projects(active_only=True)
        self._refresh_embedded_filter_choices(projects)

        for project in projects:
            self.project_tree.insert(
                "",
                "end",
                iid=str(project["id"]),
                text=f"{project['code']}  {project['name']}",
            )

        if select_project_id and str(select_project_id) in self.project_tree.get_children():
            self.project_tree.selection_set(str(select_project_id))
            self.project_tree.focus(str(select_project_id))
            self._select_project(select_project_id)
            return

        if self.selected_project_id and str(self.selected_project_id) in self.project_tree.get_children():
            self.project_tree.selection_set(str(self.selected_project_id))
            self.project_tree.focus(str(self.selected_project_id))
            self._select_project(self.selected_project_id)
            return

        if projects:
            first_project_id = int(projects[0]["id"])
            self.project_tree.selection_set(str(first_project_id))
            self.project_tree.focus(str(first_project_id))
            self._select_project(first_project_id)
            return

        self.selected_project_id = None
        self.refresh_next_sample_code()
        self.project_name_var.set("Select an active project")
        self.project_meta_var.set("Use the left sidebar to pick a project or add a new one.")
        self.project_count_var.set("Samples tracked: 0")
        self.refresh_samples()
        self.clear_sample_selection()

    def _refresh_embedded_filter_choices(self, projects: list[sqlite3.Row]) -> None:
        previous_choice = self.embedded_project_filter_var.get()
        lookup: dict[str, int | None] = {"All Projects": None}
        choices = ["All Projects"]
        for project in projects:
            label = f"{project['code']} - {project['name']}"
            choices.append(label)
            lookup[label] = int(project["id"])

        self.embedded_project_filter_lookup = lookup
        if previous_choice not in lookup:
            self.embedded_project_filter_var.set("All Projects")

        if self.embedded_filter_combo is not None:
            self.embedded_filter_combo.configure(values=choices)

    def _on_embedded_filter_changed(self, _event: tk.Event) -> None:
        self.refresh_samples()

    def _on_project_selected(self, _event: tk.Event) -> None:
        selection = self.project_tree.selection()
        if not selection:
            return
        self._select_project(int(selection[0]))

    def _select_project(self, project_id: int) -> None:
        project = self.db.get_project(project_id)
        if not project:
            return
        self.selected_project_id = project_id
        status = "Active" if project["is_active"] else "Inactive"
        self.project_name_var.set(f"{project['code']} - {project['name']}")
        self.project_meta_var.set(f"Team lead: {project['team_lead']} | Status: {status}")
        self.project_count_var.set(f"Samples tracked: {project['sample_count']}")
        self.refresh_next_sample_code()
        self.refresh_samples()

    def refresh_next_sample_code(self) -> None:
        if not self.selected_project_id:
            self.new_sample_code_var.set("")
            return
        self.new_sample_code_var.set(self.db.next_sample_code(self.selected_project_id))

    def current_next_sample_code(self) -> str:
        self.refresh_next_sample_code()
        return self.new_sample_code_var.get()

    def open_new_sample_dialog(self) -> None:
        if not self.selected_project_id:
            messagebox.showinfo(
                "Choose a project",
                "Select an active project on the left before creating a sample.",
            )
            return
        NewSampleDialog(self)

    def refresh_samples(self) -> None:
        moved_count = self.db.auto_advance_processing_runs()
        if moved_count:
            label = "sample" if moved_count == 1 else "samples"
            self.status_var.set(f"{moved_count} {label} moved to Processor Pickup")

        self.selected_sample_id = None
        self.clear_sample_selection(reset_tree=False)
        self.refresh_next_sample_code()

        self.board_card_widgets = {}
        for queue_key, card_frame in self.board_card_frames.items():
            for child in card_frame.winfo_children():
                child.destroy()
            self.board_items[queue_key] = []

        samples = self.db.list_open_samples()
        embedded_filter_project_id = self.embedded_project_filter_lookup.get(
            self.embedded_project_filter_var.get()
        )
        for sample in samples:
            queue_key = self._queue_key_for_stage(sample["current_stage"])
            if (
                queue_key == "embedded_inventory"
                and embedded_filter_project_id is not None
                and int(sample["project_id"]) != embedded_filter_project_id
            ):
                continue
            self.board_items[queue_key].append(int(sample["id"]))
            self._create_sample_card(queue_key, sample)

        for queue_key, sample_ids in self.board_items.items():
            sample_count = len(sample_ids)
            label = "sample" if sample_count == 1 else "samples"
            self.board_count_vars[queue_key].set(f"{sample_count} {label}")

        project = self.db.get_project(self.selected_project_id)
        if project:
            self.project_count_var.set(
                f"Samples tracked: {project['sample_count']} | Open on board: {len(samples)}"
            )
        else:
            self.project_count_var.set(f"Open samples on board: {len(samples)}")
        self.refresh_next_sample_code()

    @staticmethod
    def _queue_key_for_stage(stage_key: str) -> str:
        return BOARD_STAGE_TO_QUEUE.get(stage_key, "received")

    def _place_queue_item(self, queue_key: str, widget: tk.Widget, *, compact: bool = False) -> None:
        item_index = max(0, len(self.board_items[queue_key]) - 1)
        if compact:
            widget.grid(
                row=item_index,
                column=0,
                columnspan=2,
                sticky="ew",
                pady=(0, 5),
            )
            return

        row_index = item_index // 2
        column_index = item_index % 2
        horizontal_padding = (0, 4) if column_index == 0 else (4, 0)
        widget.grid(
            row=row_index,
            column=column_index,
            sticky="nsew",
            padx=horizontal_padding,
            pady=(0, 8),
        )

    def _create_sample_card(self, queue_key: str, sample: sqlite3.Row) -> None:
        if queue_key == "embedded_inventory":
            self._create_embedded_inventory_row(queue_key, sample)
            return

        sample_id = int(sample["id"])
        parent = self.board_card_frames[queue_key]
        card_bg = "#ffffff"
        card_accent_color = PROJECT_COLORS[int(sample["project_id"]) % len(PROJECT_COLORS)]
        card = tk.Frame(
            parent,
            background=card_bg,
            highlightbackground="#dde4ea",
            highlightthickness=1,
            padx=0,
            pady=0,
            cursor="hand2",
        )
        self._place_queue_item(queue_key, card)
        self.board_card_widgets[sample_id] = card

        accent = tk.Frame(card, background=card_accent_color, width=4)
        accent.pack(side="left", fill="y")

        body = tk.Frame(card, background=card_bg, padx=9, pady=6)
        body.pack(side="left", fill="both", expand=True)
        body.columnconfigure(0, weight=1)

        header = tk.Frame(body, background=card_bg)
        header.grid(row=0, column=0, sticky="ew")
        header.columnconfigure(0, weight=1)

        tk.Label(
            header,
            text=sample["sample_code"],
            background=card_bg,
            foreground="#1a2535",
            font=("Segoe UI Semibold", 10),
        ).grid(row=0, column=0, sticky="w")

        badge_text = sample["processing_type"][0].upper()
        badge_bg = "#2e5f78" if badge_text == "S" else "#7a4f1a"
        tk.Label(
            header,
            text=badge_text,
            background=badge_bg,
            foreground="#ffffff",
            font=("Segoe UI Semibold", 9),
            width=2,
            padx=4,
            pady=2,
        ).grid(row=0, column=1, sticky="e")

        details = self._board_sample_detail(sample)
        tk.Label(
            body,
            text=details,
            background=card_bg,
            foreground="#5e6e7a",
            font=("Segoe UI", 8),
            justify="left",
            anchor="w",
            wraplength=160,
        ).grid(row=1, column=0, sticky="w", pady=(2, 0))

        if queue_key == "preprocessing":
            self._add_tile_checklist(body, sample, sample_id, card_bg)

        self._bind_card_events(card, queue_key, sample_id)

    def _create_embedded_inventory_row(self, queue_key: str, sample: sqlite3.Row) -> None:
        sample_id = int(sample["id"])
        parent = self.board_card_frames[queue_key]
        row_bg = "#ffffff"
        row_accent = PROJECT_COLORS[int(sample["project_id"]) % len(PROJECT_COLORS)]
        row = tk.Frame(
            parent,
            background=row_bg,
            highlightbackground="#dde4ea",
            highlightthickness=1,
            padx=0,
            pady=0,
            cursor="hand2",
        )
        self._place_queue_item(queue_key, row, compact=True)
        self.board_card_widgets[sample_id] = row

        tk.Frame(row, background=row_accent, width=4).pack(side="left", fill="y")
        body = tk.Frame(row, background=row_bg, padx=8, pady=5)
        body.pack(side="left", fill="both", expand=True)

        description = sample["sample_description"] or "No description"
        cut_notes = sample["cut_notes"].strip()

        header_row = tk.Frame(body, background=row_bg)
        header_row.pack(fill="x")

        tk.Label(
            header_row,
            text=f"{sample['sample_code']}  {description}",
            background=row_bg,
            foreground="#1a2535",
            font=("Segoe UI Semibold", 9),
            anchor="w",
        ).pack(side="left", fill="x", expand=True)

        plan_btn = tk.Label(
            header_row,
            text="›",
            background=row_bg,
            foreground=row_accent,
            font=("Segoe UI", 14),
            cursor="hand2",
        )
        plan_btn.pack(side="right")

        plan = self.db.get_sectioning_plan(sample_id)
        if plan:
            total_slides = sum(e.get("duplicates", 1) for e in plan)
            n = len(plan)
            plan_text = f"↓ {n} {'section' if n == 1 else 'sections'} · {total_slides} {'slide' if total_slides == 1 else 'slides'}"
            sub_text = f"{cut_notes}  {plan_text}" if cut_notes else plan_text
        else:
            sub_text = cut_notes

        if sub_text:
            tk.Label(
                body,
                text=sub_text,
                background=row_bg,
                foreground="#6b7a86",
                font=("Segoe UI", 8),
                anchor="w",
                justify="left",
                wraplength=220,
            ).pack(fill="x", pady=(2, 0))

        self._bind_card_events(row, queue_key, sample_id)
        plan_btn.bind("<ButtonPress-1>", lambda _e, sid=sample_id: self._open_sectioning_plan(sid))

    def _add_tile_checklist(
        self, parent: tk.Frame, sample: sqlite3.Row, sample_id: int, bg: str
    ) -> None:
        pending = [
            (stage_key, PREPROCESSING_COMPACT_LABELS[stage_key], column)
            for stage_key, _label, column in PREPROCESSING_STEPS
            if not (stage_key == "decalcified" and not sample["needs_decalcification"])
            and not sample[column]
        ]
        if not pending:
            return
        check_frame = tk.Frame(parent, background=bg)
        check_frame.grid(row=2, column=0, sticky="w", pady=(5, 2))
        for stage_key, compact_label, _col in pending:
            var = tk.BooleanVar(value=False)
            cb = tk.Checkbutton(
                check_frame,
                text=compact_label,
                variable=var,
                background=bg,
                activebackground=bg,
                foreground="#3a4a58",
                activeforeground="#1a2535",
                selectcolor=bg,
                font=("Segoe UI", 8),
                bd=0,
                highlightthickness=0,
                cursor="hand2",
                command=lambda sk=stage_key, v=var, sid=sample_id: (
                    self._mark_preprocessing_from_tile(sid, sk, v)
                ),
            )
            cb.pack(side="left", padx=(0, 6))

    def _bind_card_events(self, widget: tk.Widget, queue_key: str, sample_id: int) -> None:
        self.queue_widget_map[widget] = queue_key
        if not isinstance(widget, (tk.Checkbutton, ttk.Checkbutton)):
            widget.bind("<ButtonPress-1>", lambda event, key=queue_key, sid=sample_id: self._begin_card_drag(event, key, sid))
            widget.bind("<B1-Motion>", self._move_drag_ghost)
            widget.bind("<ButtonRelease-1>", self._finish_card_drag)
        widget.bind("<MouseWheel>", lambda event: self._scroll_queue_for_widget(widget, event))
        for child in widget.winfo_children():
            self._bind_card_events(child, queue_key, sample_id)

    def _begin_card_drag(self, event: tk.Event, queue_key: str, sample_id: int) -> None:
        self.drag_sample_id = sample_id
        self.drag_source_queue_key = queue_key
        self.selected_queue_key = queue_key
        self._select_sample(sample_id)
        self._highlight_selected_card(sample_id)
        self._show_drag_ghost(sample_id, event)

    def _show_drag_ghost(self, sample_id: int, event: tk.Event) -> None:
        self._destroy_drag_ghost()
        sample = self.db.get_sample(sample_id)
        if not sample:
            return

        ghost_accent = PROJECT_COLORS[int(sample["project_id"]) % len(PROJECT_COLORS)]
        ghost = tk.Toplevel(self)
        ghost.overrideredirect(True)
        ghost.configure(background=ghost_accent)
        try:
            ghost.attributes("-topmost", True)
            ghost.attributes("-alpha", 0.90)
        except tk.TclError:
            pass

        card = tk.Frame(
            ghost,
            background="#ffffff",
            highlightbackground=ghost_accent,
            highlightthickness=2,
            padx=10,
            pady=8,
        )
        card.pack()
        header = tk.Frame(card, background="#ffffff")
        header.pack(fill="x")
        tk.Label(
            header,
            text=sample["sample_code"],
            background="#ffffff",
            foreground="#1a2535",
            font=("Segoe UI Semibold", 10),
        ).pack(side="left")

        badge_text = sample["processing_type"][0].upper()
        badge_bg = "#2e5f78" if badge_text == "S" else "#7a4f1a"
        tk.Label(
            header,
            text=badge_text,
            background=badge_bg,
            foreground="#ffffff",
            font=("Segoe UI Semibold", 9),
            width=2,
            padx=4,
            pady=2,
        ).pack(side="right", padx=(12, 0))
        tk.Label(
            card,
            text=self._board_sample_detail(sample),
            background="#ffffff",
            foreground="#5e6a72",
            font=("Segoe UI", 8),
            justify="left",
            wraplength=190,
        ).pack(fill="x", pady=(4, 0))

        self.drag_ghost = ghost
        self._move_drag_ghost(event)

    def _move_drag_ghost(self, event: tk.Event) -> None:
        if self.drag_ghost is None:
            return
        try:
            self.drag_ghost.geometry(f"+{event.x_root + 14}+{event.y_root + 14}")
        except tk.TclError:
            self.drag_ghost = None

    def _destroy_drag_ghost(self) -> None:
        if self.drag_ghost is None:
            return
        try:
            if self.drag_ghost.winfo_exists():
                self.drag_ghost.destroy()
        except tk.TclError:
            pass
        self.drag_ghost = None

    def _finish_card_drag(self, event: tk.Event) -> None:
        if self.drag_sample_id is None:
            self._destroy_drag_ghost()
            return

        self._destroy_drag_ghost()
        self.update_idletasks()
        target_widget = self.winfo_containing(event.x_root, event.y_root)
        target_queue_key = self._queue_key_for_widget(target_widget)
        sample_id = self.drag_sample_id
        source_queue_key = self.drag_source_queue_key
        self.drag_sample_id = None
        self.drag_source_queue_key = None

        if not target_queue_key or target_queue_key == source_queue_key:
            self.select_sample_on_board(sample_id)
            return

        self.move_sample_to_queue(sample_id, target_queue_key)

    def _queue_key_for_widget(self, widget: tk.Widget | None) -> str | None:
        current = widget
        while current is not None:
            if current in self.queue_widget_map:
                return self.queue_widget_map[current]
            parent_name = current.winfo_parent()
            current = current._nametowidget(parent_name) if parent_name else None
        return None

    def _scroll_queue_for_widget(self, widget: tk.Widget, event: tk.Event) -> str:
        queue_key = self._queue_key_for_widget(widget)
        if queue_key:
            self._scroll_queue(self.board_canvases[queue_key], event)
        return "break"

    def _scroll_queue(self, canvas: tk.Canvas, event: tk.Event) -> str:
        canvas.update_idletasks()
        scroll_region = canvas.bbox("all")
        if not scroll_region:
            return "break"

        content_height = max(1, scroll_region[3] - scroll_region[1])
        visible_height = max(1, canvas.winfo_height())
        if content_height <= visible_height:
            return "break"

        max_fraction = max(0.0, 1.0 - (visible_height / content_height))
        key = str(canvas)
        current_target = self.scroll_targets.get(key, canvas.yview()[0])
        direction = -1 if event.delta > 0 else 1
        target = current_target + ((direction * 150) / content_height)
        self.scroll_targets[key] = min(max(target, 0.0), max_fraction)

        if key not in self.scroll_jobs:
            self._animate_scroll(canvas)
        return "break"

    def _animate_scroll(self, canvas: tk.Canvas) -> None:
        key = str(canvas)
        target = self.scroll_targets.get(key)
        if target is None:
            self.scroll_jobs.pop(key, None)
            return

        current = canvas.yview()[0]
        distance = target - current
        if abs(distance) < 0.001:
            canvas.yview_moveto(target)
            self.scroll_jobs.pop(key, None)
            return

        canvas.yview_moveto(current + (distance * 0.28))
        self.scroll_jobs[key] = self.after(12, lambda: self._animate_scroll(canvas))

    def _scroll_projects(self, event: tk.Event) -> str:
        direction = -1 if event.delta > 0 else 1
        self.project_tree.yview_scroll(direction * 3, "units")
        return "break"

    @staticmethod
    def _board_sample_detail(sample: sqlite3.Row) -> str:
        description = sample["sample_description"] or "—"
        parts: list[str] = [sample["fixative_agent"]]
        if sample["needs_decalcification"] and not sample["decalc_completed_at"]:
            parts.append("needs decalc")
        if sample["current_stage"] == "processing_started":
            started_at = parse_timestamp(sample["processing_started_at"])
            if started_at:
                ready_at = started_at + timedelta(
                    hours=processing_duration_hours(sample["processing_type"])
                )
                remaining = ready_at - datetime.now()
                if remaining.total_seconds() > 0:
                    hours_remaining = max(1, int(remaining.total_seconds() // 3600))
                    parts.append(f"{hours_remaining}h left")
                else:
                    parts.append("ready")
        elif sample["current_stage"] == "processed":
            parts.append("ready")
        if sample["stains"]:
            parts.append(sample["stains"])
        return f"{description}  ·  {' · '.join(parts)}"

    @staticmethod
    def _preprocessing_status(sample: sqlite3.Row) -> str:
        for _stage_key, label, column in reversed(PREPROCESSING_STEPS):
            if sample[column]:
                return label
        return "Not started"

    def add_sample(self) -> None:
        self.open_new_sample_dialog()

    def create_sample(
        self,
        sample_description: str,
        processing_type: str,
        fixative_agent: str,
        needs_decalcification: bool,
        cut_notes: str,
        slide_notes: str,
        stains: str,
        overall_notes: str,
    ) -> int | None:
        if not self.selected_project_id:
            messagebox.showinfo(
                "Choose a project",
                "Select an active project on the left before adding a sample.",
            )
            return None

        try:
            sample_id = self.db.add_sample(
                project_id=self.selected_project_id,
                sample_description=sample_description,
                processing_type=processing_type,
                fixative_agent=fixative_agent,
                needs_decalcification=needs_decalcification,
                cut_notes=cut_notes,
                slide_notes=slide_notes,
                stains=stains,
                overall_notes=overall_notes,
            )
        except sqlite3.IntegrityError:
            messagebox.showerror(
                "Duplicate sample ID",
                "The generated sample ID already exists for this project.",
            )
            return None

        self.undo_stack.append({"kind": "delete_created_sample", "sample_id": sample_id})
        self.status_var.set(f"Created sample {self.db.get_sample(sample_id)['sample_code']}")
        self.refresh_next_sample_code()
        self.new_processing_var.set("Short")
        self.new_fixative_var.set(FIXATIVE_OPTIONS[0])
        self.new_decalc_var.set(False)
        self.new_stains_var.set("")
        self._replace_text(self.new_cut_notes_text, "")
        self._replace_text(self.new_slide_notes_text, "")
        self._replace_text(self.new_overall_notes_text, "")

        self.refresh_samples()
        self.select_sample_on_board(sample_id)
        return sample_id

    def _on_card_selected(self, queue_key: str, sample_id: int) -> None:
        self.selected_queue_key = queue_key
        self._select_sample(sample_id)
        self._highlight_selected_card(sample_id)

    def select_sample_on_board(self, sample_id: int) -> bool:
        for queue_key, sample_ids in self.board_items.items():
            if sample_id not in sample_ids:
                continue
            self.selected_queue_key = queue_key
            self._select_sample(sample_id)
            self._highlight_selected_card(sample_id)
            return True

        self.clear_sample_selection()
        return False

    def _highlight_selected_card(self, sample_id: int | None) -> None:
        for card_sample_id, card in self.board_card_widgets.items():
            card.configure(
                highlightbackground="#2f6f8f" if card_sample_id == sample_id else "#cad3da",
                highlightthickness=2 if card_sample_id == sample_id else 1,
            )

    def _select_sample(self, sample_id: int) -> None:
        sample = self.db.get_sample(sample_id)
        if not sample:
            return

        self.selected_sample_id = sample_id
        self.detail_sample_code_var.set(
            f"{sample['sample_code']} | Added {sample['date_added']}"
        )
        self.detail_description_var.set(sample["sample_description"])
        self.detail_processing_var.set(sample["processing_type"])
        self.detail_fixative_var.set(sample["fixative_agent"])
        self.detail_decalc_var.set(bool(sample["needs_decalcification"]))
        self.detail_stains_var.set(sample["stains"])
        self.detail_stage_var.set(
            STAGE_LABELS.get(sample["current_stage"], STAGES[0][1])
        )
        self._replace_text(self.detail_cut_notes_text, sample["cut_notes"])
        self._replace_text(self.detail_slide_notes_text, sample["slide_notes"])
        self._replace_text(self.detail_overall_notes_text, sample["overall_notes"])

        for stage_key, label, column in PREPROCESSING_STEPS:
            stage_value = sample[column]
            self.preprocessing_vars[stage_key].set(bool(stage_value))
            self.preprocessing_time_vars[stage_key].set(
                f"{label}: {display_value(stage_value)}"
            )

        for stage_key, label in STAGES:
            stage_value = sample[STAGE_COLUMNS[stage_key]]
            self.timeline_vars[stage_key].set(f"{label}: {display_value(stage_value)}")

    def clear_sample_selection(self, reset_tree: bool = True) -> None:
        self.selected_sample_id = None
        self.detail_sample_code_var.set("No sample selected")
        self.detail_description_var.set("")
        self.detail_processing_var.set("Short")
        self.detail_fixative_var.set(FIXATIVE_OPTIONS[0])
        self.detail_decalc_var.set(False)
        self.detail_stains_var.set("")
        self.detail_stage_var.set(STAGES[0][1])
        self._replace_text(self.detail_cut_notes_text, "")
        self._replace_text(self.detail_slide_notes_text, "")
        self._replace_text(self.detail_overall_notes_text, "")
        for stage_key, label, _column in PREPROCESSING_STEPS:
            self.preprocessing_vars[stage_key].set(False)
            self.preprocessing_time_vars[stage_key].set(f"{label}: Not recorded")
        for stage_key, label in STAGES:
            self.timeline_vars[stage_key].set(f"{label}: Not recorded")
        if reset_tree:
            self._highlight_selected_card(None)
            self.selected_queue_key = None

    def save_selected_sample(self) -> None:
        if not self.selected_sample_id:
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return

        sample_id = self.selected_sample_id
        self._push_sample_undo(sample_id)
        self.db.update_sample_details(
            sample_id=sample_id,
            sample_description=self.detail_description_var.get(),
            processing_type=self.detail_processing_var.get(),
            fixative_agent=self.detail_fixative_var.get(),
            needs_decalcification=self.detail_decalc_var.get(),
            cut_notes=self._text_value(self.detail_cut_notes_text),
            slide_notes=self._text_value(self.detail_slide_notes_text),
            stains=self.detail_stains_var.get(),
            overall_notes=self._text_value(self.detail_overall_notes_text),
        )
        self.refresh_samples()
        self.select_sample_on_board(sample_id)
        self.status_var.set("Sample details saved")

    def move_selected_sample(self, direction: int) -> None:
        if not self.selected_sample_id:
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return

        sample = self.db.get_sample(self.selected_sample_id)
        if not sample:
            self.clear_sample_selection()
            return

        queue_key = self._queue_key_for_stage(sample["current_stage"])
        queue_index = BOARD_QUEUE_KEYS.index(queue_key)
        target_index = queue_index + direction

        if target_index < 0:
            messagebox.showinfo("Already first queue", "This sample is already in the first queue.")
            return

        if target_index >= len(BOARD_QUEUE_KEYS):
            self.mark_selected_analyzed()
            return

        target_queue_key = BOARD_QUEUE_KEYS[target_index]
        self.move_sample_to_queue(self.selected_sample_id, target_queue_key)

    def move_sample_to_queue(self, sample_id: int, target_queue_key: str) -> None:
        if target_queue_key not in BOARD_QUEUE_ENTRY_STAGES:
            return

        sample = self.db.get_sample(sample_id)
        if not sample:
            return

        current_queue_key = self._queue_key_for_stage(sample["current_stage"])
        if current_queue_key == target_queue_key:
            self.select_sample_on_board(sample_id)
            return

        target_stage = BOARD_QUEUE_ENTRY_STAGES[target_queue_key]
        if self._blocks_required_decalc(sample, target_stage):
            self._show_required_decalc_message()
            self.select_sample_on_board(sample_id)
            return

        self._push_sample_undo(sample_id)
        self.db.update_sample_stage(sample_id, target_stage)
        self.refresh_samples()
        self.select_sample_on_board(sample_id)
        self.status_var.set(f"Moved to {BOARD_QUEUE_TITLES[target_queue_key]}")

    @staticmethod
    def _blocks_required_decalc(sample: sqlite3.Row, target_stage: str) -> bool:
        if not sample["needs_decalcification"] or sample["decalc_completed_at"]:
            return False
        return STAGE_ORDER.get(target_stage, 0) >= STAGE_ORDER["in_fixative"]

    @staticmethod
    def _show_required_decalc_message() -> None:
        messagebox.showinfo(
            "Decalcification required",
            "This sample is marked for decalcification. Record Decalcification Complete before moving it into fixation or later stages.",
        )

    @staticmethod
    def _processing_not_ready_message(sample: sqlite3.Row) -> str:
        started_at = parse_timestamp(sample["processing_started_at"])
        if not started_at:
            return "This sample does not have a processing start time yet."
        ready_at = started_at + timedelta(hours=processing_duration_hours(sample["processing_type"]))
        remaining = ready_at - datetime.now()
        if remaining.total_seconds() <= 0:
            return "Processing is ready; refresh the board to move it to Processor Pickup."
        hours = int(remaining.total_seconds() // 3600)
        minutes = int((remaining.total_seconds() % 3600) // 60)
        return f"This {sample['processing_type'].lower()} run is ready at {ready_at.strftime('%Y-%m-%d %H:%M')} ({hours}h {minutes}m remaining)."

    def mark_selected_analyzed(self) -> None:
        if not self.selected_sample_id:
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return

        sample_id = self.selected_sample_id
        self._push_sample_undo(sample_id)
        self.db.update_sample_stage(sample_id, "analyzed")
        self.refresh_samples()
        self.clear_sample_selection()
        self.status_var.set("Marked analyzed")

    def _mark_preprocessing_from_tile(self, sample_id: int, stage_key: str, var: tk.BooleanVar) -> None:
        if not var.get():
            return
        sample = self.db.get_sample(sample_id)
        if not sample:
            return
        if self._blocks_required_decalc(sample, stage_key):
            var.set(False)
            self._show_required_decalc_message()
            return
        self._push_sample_undo(sample_id)
        self.db.mark_preprocessing_step(sample_id, stage_key)
        self.status_var.set(f"Timestamped {STAGE_LABELS[stage_key]}")
        self.refresh_samples()
        self.select_sample_on_board(sample_id)

    def _open_sectioning_plan(self, sample_id: int) -> None:
        self._select_sample(sample_id)
        self._highlight_selected_card(sample_id)
        SectioningPlanDialog(self, sample_id)

    def toggle_preprocessing_step(self, stage_key: str) -> None:
        if not self.selected_sample_id:
            self.preprocessing_vars[stage_key].set(False)
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return

        if not self.preprocessing_vars[stage_key].get():
            self.preprocessing_vars[stage_key].set(True)
            messagebox.showinfo(
                "Timestamp preserved",
                "Recorded pre-processing timestamps are preserved in this prototype.",
            )
            return

        sample_id = self.selected_sample_id
        sample = self.db.get_sample(sample_id)
        if sample and self._blocks_required_decalc(sample, stage_key):
            self.preprocessing_vars[stage_key].set(False)
            self._show_required_decalc_message()
            return

        self._push_sample_undo(sample_id)
        self.db.mark_preprocessing_step(sample_id, stage_key)
        self.refresh_samples()
        self.select_sample_on_board(sample_id)
        self.status_var.set(f"Timestamped {STAGE_LABELS[stage_key]}")

    def update_selected_stage(self) -> None:
        if not self.selected_sample_id:
            messagebox.showinfo("No sample selected", "Choose a sample from the board first.")
            return

        sample_id = self.selected_sample_id
        stage_label = self.detail_stage_var.get()
        stage_key = STAGE_BY_LABEL[stage_label]
        sample = self.db.get_sample(sample_id)
        if sample and self._blocks_required_decalc(sample, stage_key):
            self._show_required_decalc_message()
            self.detail_stage_var.set(
                STAGE_LABELS.get(sample["current_stage"], STAGES[0][1])
            )
            return

        self._push_sample_undo(sample_id)
        self.db.update_sample_stage(sample_id, stage_key)
        self.refresh_samples()
        self.select_sample_on_board(sample_id)
        self.status_var.set(f"Stage set to {stage_label}")

    @staticmethod
    def _text_value(widget: tk.Text) -> str:
        return widget.get("1.0", "end").strip()

    @staticmethod
    def _replace_text(widget: tk.Text, value: str) -> None:
        widget.delete("1.0", "end")
        widget.insert("1.0", value)


if __name__ == "__main__":
    app = HistometerApp()
    app.mainloop()
