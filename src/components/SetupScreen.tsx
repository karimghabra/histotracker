import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Monitor, ShieldCheck, Eye } from "lucide-react";
import { Button, Field, Select, TextInput } from "./ui";
import { githubValidate } from "../lib/githubSync";
import { getSyncConfig, setSyncConfig, type SyncConfigPublic, type SyncRole } from "../lib/syncConfig";

// Sensible defaults for this lab's private data repo.
const DEFAULT_OWNER = "karimghabra";
const DEFAULT_REPO = "Histoarchives";

export function SetupScreen({
  initial,
  onConfigured,
  onCancel,
}: {
  initial?: SyncConfigPublic | null;
  onConfigured: (config: SyncConfigPublic) => void;
  onCancel?: () => void;
}) {
  const [role, setRole] = useState<SyncRole>((initial?.role as SyncRole) || "workstation");
  const [repoOwner, setRepoOwner] = useState(initial?.repo_owner || DEFAULT_OWNER);
  const [repoName, setRepoName] = useState(initial?.repo_name || DEFAULT_REPO);
  const [token, setToken] = useState("");
  const [operatorName, setOperatorName] = useState(initial?.operator_name || "");
  const [operatorInitials, setOperatorInitials] = useState(initial?.operator_initials || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestedInitials = useMemo(
    () => operatorName.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(),
    [operatorName],
  );
  const hasStoredToken = Boolean(initial?.has_token);

  async function save() {
    const owner = repoOwner.trim();
    const name = repoName.trim();
    const operator = operatorName.trim();
    const initials = (operatorInitials.trim() || suggestedInitials).toUpperCase();
    if (!owner || !name) {
      setError("Enter the data repository owner and name.");
      return;
    }
    if (!operator) {
      setError("Enter your name so activity is attributed to you.");
      return;
    }
    if (!hasStoredToken && !token.trim()) {
      setError("Paste a fine-grained access token scoped to the data repository.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setSyncConfig({
        role,
        repo_owner: owner,
        repo_name: name,
        token: token.trim() || undefined,
        operator_name: operator,
        operator_initials: initials,
      });
      // Confirm the repo + token actually reach a real repository.
      await githubValidate();
      onConfigured(await getSyncConfig());
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-surface p-6">
      <div className="w-full max-w-xl rounded-2xl border border-line bg-panel shadow-2xl">
        <div className="border-b border-line px-6 py-5">
          <h1 className="text-lg font-semibold text-ink">Connect shared data sync</h1>
          <p className="mt-1 text-xs text-ink-faint">
            Histometer keeps every workstation and viewer in step through a private GitHub
            repository. Choose this install's role and point it at the shared repo.
          </p>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5 thin-scroll">
          <Field label="This install's role">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRole("workstation")}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition ${
                  role === "workstation"
                    ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                    : "border-line bg-white hover:bg-surface"
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Monitor size={15} /> Workstation
                </span>
                <span className="text-[11px] text-ink-faint">
                  The authoritative bench app. Publishes snapshots and resolves requests.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setRole("viewer")}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition ${
                  role === "viewer"
                    ? "border-brand bg-brand/5 ring-2 ring-brand/20"
                    : "border-line bg-white hover:bg-surface"
                }`}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <Eye size={15} /> Viewer
                </span>
                <span className="text-[11px] text-ink-faint">
                  Read-only mirror. Follows the workstation and can submit stain requests.
                </span>
              </button>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Data repo owner">
              <TextInput value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder={DEFAULT_OWNER} />
            </Field>
            <Field label="Data repo name">
              <TextInput value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder={DEFAULT_REPO} />
            </Field>
          </div>

          <Field label={hasStoredToken ? "Access token (leave blank to keep the saved one)" : "Fine-grained access token"}>
            <TextInput
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={hasStoredToken ? "•••••••• (saved)" : "github_pat_…"}
              autoComplete="off"
            />
            <span className="mt-1 flex items-center gap-1 text-[11px] text-ink-faint">
              <ShieldCheck size={12} /> Stored locally only — never written to the snapshot database or the repo.
            </span>
          </Field>

          <div className="grid grid-cols-[1fr_8rem] gap-3">
            <Field label="Your name">
              <TextInput value={operatorName} onChange={(e) => setOperatorName(e.target.value)} placeholder="Alex Rivera" />
            </Field>
            <Field label="Initials">
              <TextInput
                value={operatorInitials}
                onChange={(e) => setOperatorInitials(e.target.value.toUpperCase().slice(0, 4))}
                placeholder={suggestedInitials || "AR"}
              />
            </Field>
          </div>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
          <Select
            aria-label="Role (compact)"
            value={role}
            onChange={(e) => setRole(e.target.value as SyncRole)}
            className="w-40 sm:hidden"
          >
            <option value="workstation">Workstation</option>
            <option value="viewer">Viewer</option>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            {onCancel && (
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            )}
            <Button variant="primary" onClick={save} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 size={15} className="animate-spin" /> Verifying…
                </>
              ) : (
                <>
                  <CheckCircle2 size={15} /> Connect
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
