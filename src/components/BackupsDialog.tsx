import { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseBackup, FolderOpen, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button, Modal } from "./ui";
import {
  backupsDirPath,
  createBackup,
  deleteBackup,
  listBackups,
  revertToBackup,
  type BackupEntry,
} from "../lib/backup";
import {
  loadBackupConfig,
  saveBackupConfig,
  type BackupConfig,
} from "../lib/backupConfig";

const REASON_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  manual: "Manual",
  startup: "On launch",
  prerestore: "Before revert",
  unknown: "Backup",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(d: Date): string {
  if (d.getTime() === 0) return "—";
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BackupsDialog({
  onClose,
  onReverted,
}: {
  onClose: () => void;
  onReverted: () => void;
}) {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<string>("");
  const [config, setConfig] = useState<BackupConfig>(() => loadBackupConfig());
  // Persist config as the user edits it (debounce-free — it's tiny localStorage).
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    saveBackupConfig(config);
  }, [config]);

  const refresh = useCallback(async () => {
    try {
      setBackups(await listBackups());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void backupsDirPath().then(setDir).catch(() => undefined);
  }, [refresh]);

  async function backUpNow() {
    setBusy("new");
    setError(null);
    try {
      await createBackup("manual", config.retention);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function revert(entry: BackupEntry) {
    const when = formatWhen(entry.createdAt);
    if (
      !window.confirm(
        `Revert the whole database to the backup from ${when}?\n\n` +
          "This replaces all current workflow data with the backup's contents. " +
          "A safety backup of the current state is taken first, so you can revert back.",
      )
    ) {
      return;
    }
    setBusy(entry.name);
    setError(null);
    try {
      await revertToBackup(entry.name);
      await refresh();
      onReverted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: BackupEntry) {
    if (!window.confirm(`Delete the backup from ${formatWhen(entry.createdAt)}?`)) return;
    setBusy(entry.name);
    try {
      await deleteBackup(entry.name);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const anyBusy = busy !== null;

  return (
    <Modal title="Database backups" onClose={onClose} width="max-w-2xl">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-ink-faint">
          Robust point-in-time copies of the whole database. Revert restores one wholesale.
        </p>
        <Button variant="primary" onClick={backUpNow} disabled={anyBusy}>
          {busy === "new" ? <Loader2 size={15} className="animate-spin" /> : <DatabaseBackup size={15} />}
          Back up now
        </Button>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </p>
      )}

      {/* ---- Schedule settings ---- */}
      <section className="mb-5 rounded-xl border border-line bg-surface/50 p-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Automatic schedule
          </h3>
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, enabled: e.target.checked }))}
            />
            Enabled
          </label>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs text-ink-soft sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-ink-faint">Every (hours)</span>
            <input
              type="number"
              min={1}
              max={24}
              value={config.intervalHours}
              disabled={!config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, intervalHours: clampInt(e.target.value, 1, 24, c.intervalHours) }))}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-ink outline-none focus:border-brand disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-ink-faint">Work starts (hour)</span>
            <input
              type="number"
              min={0}
              max={23}
              value={config.workStartHour}
              disabled={!config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, workStartHour: clampInt(e.target.value, 0, 23, c.workStartHour) }))}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-ink outline-none focus:border-brand disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-ink-faint">Work ends (hour)</span>
            <input
              type="number"
              min={1}
              max={24}
              value={config.workEndHour}
              disabled={!config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, workEndHour: clampInt(e.target.value, 1, 24, c.workEndHour) }))}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-ink outline-none focus:border-brand disabled:opacity-50"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-ink-faint">Keep newest</span>
            <input
              type="number"
              min={1}
              max={500}
              value={config.retention}
              onChange={(e) => setConfig((c) => ({ ...c, retention: clampInt(e.target.value, 1, 500, c.retention) }))}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-ink outline-none focus:border-brand"
            />
          </label>
          <label className="col-span-2 flex items-end gap-2 pb-1.5 sm:col-span-2">
            <input
              type="checkbox"
              checked={config.workdaysOnly}
              disabled={!config.enabled}
              onChange={(e) => setConfig((c) => ({ ...c, workdaysOnly: e.target.checked }))}
            />
            <span>Weekdays only (Mon–Fri)</span>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          {config.enabled
            ? `Backs up every ${config.intervalHours}h between ${config.workStartHour}:00 and ${config.workEndHour}:00${config.workdaysOnly ? ", Mon–Fri" : ""}, plus once on launch if overdue.`
            : "Automatic backups are off. You can still back up manually above."}
        </p>
      </section>

      {/* ---- Existing backups ---- */}
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Backups ({backups.length})
      </h3>
      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-ink-faint">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : backups.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-faint">
          No backups yet. One is taken automatically, or use “Back up now”.
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {backups.map((entry) => (
            <li key={entry.name} className="flex items-center gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{formatWhen(entry.createdAt)}</span>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                    {REASON_LABEL[entry.reason] ?? entry.reason}
                  </span>
                </div>
                <p className="truncate text-[11px] text-ink-faint">{formatBytes(entry.size)} · {entry.name}</p>
              </div>
              <Button
                variant="subtle"
                className="px-2 py-1.5"
                title="Revert the database to this backup"
                disabled={anyBusy}
                onClick={() => void revert(entry)}
              >
                {busy === entry.name ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
                Revert
              </Button>
              <Button
                variant="danger"
                className="px-2 py-1.5"
                title="Delete this backup"
                disabled={anyBusy}
                onClick={() => void remove(entry)}
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {dir && (
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <FolderOpen size={12} /> Stored in <span className="font-mono">{dir}</span>
        </p>
      )}
    </Modal>
  );
}

function clampInt(raw: string, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}
