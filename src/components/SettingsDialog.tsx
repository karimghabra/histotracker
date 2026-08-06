import { DatabaseBackup, Palette, Users } from "lucide-react";
import { useState } from "react";
import { Button, Modal } from "./ui";
import { useAppSettings, useSettingsMutations } from "../hooks/useData";
import { DEFAULT_SETTINGS, SETTING_LIMITS, clampSetting, type AppSettings } from "../lib/settings";
import { THEME_OPTIONS } from "../lib/themes";
import { useReadOnly } from "../lib/readOnly";

/**
 * Workstation settings (#92), reached from the cog at the bottom of the left
 * panel.
 *
 * It also absorbs three controls that used to live in the header (#94) —
 * Manage, Backups and the theme picker. They are all "set this up once" things
 * competing for space with the ones used every few minutes (New Sample, Export,
 * Requests, undo/redo), which is what made the top bar cluttered.
 *
 * The theme applies live because a theme you cannot see while choosing is not
 * choosable; the numbers are staged and saved, because a half-typed "1" in a
 * slide count would otherwise be written and immediately used.
 */
export function SettingsDialog({
  theme,
  onThemeChange,
  onOpenManage,
  onOpenBackups,
  onClose,
}: {
  theme: string;
  onThemeChange: (theme: string) => void;
  onOpenManage: () => void;
  onOpenBackups: () => void;
  onClose: () => void;
}) {
  const readOnly = useReadOnly();
  const { data: saved = DEFAULT_SETTINGS } = useAppSettings();
  const save = useSettingsMutations();
  const [draft, setDraft] = useState<AppSettings>(saved);
  const [savedNote, setSavedNote] = useState(false);

  function setNumber(key: keyof typeof SETTING_LIMITS, raw: string) {
    // Clamp on SAVE, not on keystroke: clamping as you type makes the field
    // fight the user when they clear it to retype.
    const parsed = Number(raw);
    setDraft((d) => ({ ...d, [key]: Number.isFinite(parsed) ? parsed : d[key] }));
  }

  function commit() {
    const next: AppSettings = {
      defaultTotalSlides: clampSetting("defaultTotalSlides", draft.defaultTotalSlides),
      defaultExtraSlides: clampSetting("defaultExtraSlides", draft.defaultExtraSlides),
      idleLogoutMinutes: clampSetting("idleLogoutMinutes", draft.idleLogoutMinutes),
      manifestVisible: draft.manifestVisible,
    };
    setDraft(next);
    save.mutate(next, {
      onSuccess: () => {
        setSavedNote(true);
        window.setTimeout(() => setSavedNote(false), 2500);
      },
    });
  }

  return (
    <Modal title="Settings" onClose={onClose} width="max-w-lg">
      <Section title="Cutting defaults">
        <p className="mb-2 text-[11px] text-ink-faint">
          Applied when a newly embedded block is auto-planned, and as the starting
          point in the sectioning plan dialog. Existing plans are not touched.
        </p>
        <NumberRow
          label="Slides per block"
          hint="Total slides a block is planned for, stains included."
          value={draft.defaultTotalSlides}
          limits={SETTING_LIMITS.defaultTotalSlides}
          disabled={readOnly}
          onChange={(raw) => setNumber("defaultTotalSlides", raw)}
        />
        <NumberRow
          label="Minimum extras"
          hint="Extras a block always gets, however many stains are preselected."
          value={draft.defaultExtraSlides}
          limits={SETTING_LIMITS.defaultExtraSlides}
          disabled={readOnly}
          onChange={(raw) => setNumber("defaultExtraSlides", raw)}
        />
      </Section>

      <Section title="Session">
        <NumberRow
          label="Sign out after (minutes idle)"
          hint="A shared bench machine should not keep attributing work to whoever signed in last."
          value={draft.idleLogoutMinutes}
          limits={SETTING_LIMITS.idleLogoutMinutes}
          disabled={readOnly}
          onChange={(raw) => setNumber("idleLogoutMinutes", raw)}
        />
      </Section>

      <Section title="Views">
        <label className="flex items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={draft.manifestVisible}
            disabled={readOnly}
            onChange={(e) => setDraft((d) => ({ ...d, manifestVisible: e.target.checked }))}
            className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-brand)]"
          />
          <span>
            Show the Manifest
            <span className="block text-[11px] text-ink-faint">
              The signed record of who changed what. Hiding it does not stop it
              being recorded.
            </span>
          </span>
        </label>
      </Section>

      {!readOnly && (
        <div className="mb-4 flex items-center justify-end gap-2">
          {savedNote && <span className="text-[11px] text-ink-faint">Saved.</span>}
          <Button variant="primary" onClick={commit} disabled={save.isPending}>
            Save settings
          </Button>
        </div>
      )}

      <Section title="Appearance">
        <label className="flex items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink-soft">
          <Palette size={14} />
          <select
            aria-label="Visual theme"
            value={theme}
            onChange={(event) => onThemeChange(event.target.value)}
            className="theme-select flex-1 bg-transparent text-xs text-ink outline-none"
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </Section>

      {!readOnly && (
        <Section title="Data">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onOpenManage}>
              <Users size={15} /> Manage users, projects &amp; stains
            </Button>
            <Button onClick={onOpenBackups}>
              <DatabaseBackup size={15} /> Backups &amp; revert
            </Button>
          </div>
        </Section>
      )}
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 border-b border-line/60 pb-4 last:border-b-0 last:pb-0">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
      {children}
    </div>
  );
}

function NumberRow({
  label,
  hint,
  value,
  limits,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  limits: { min: number; max: number };
  disabled?: boolean;
  onChange: (raw: string) => void;
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink">{label}</span>
        <span className="block text-[11px] text-ink-faint">{hint}</span>
      </span>
      <input
        type="number"
        aria-label={label}
        min={limits.min}
        max={limits.max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-20 shrink-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand disabled:opacity-50"
      />
    </div>
  );
}
