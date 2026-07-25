import { useMemo, useState } from "react";
import { Check, Pencil, Plus, Trash2, UserCheck, UserMinus, UserPlus, X } from "lucide-react";
import type { AssayCatalogEntry, LabUser, Project } from "../lib/types";
import {
  useAssayCatalog,
  useAssayCatalogMutations,
  useProjectMutations,
  useProjects,
  useUserMutations,
  useUsers,
} from "../hooks/useData";
import { Button, Field, Modal, Select, TextInput } from "./ui";

type Tab = "users" | "projects" | "stains";
const rowClass = "flex items-center justify-between gap-2 rounded-lg border border-line bg-panel px-3 py-2.5";

// ---- Users -----------------------------------------------------------------

function UsersPanel({ users, activeUser }: { users: LabUser[]; activeUser: LabUser | null }) {
  const { create, setEnabled } = useUserMutations();
  const [name, setName] = useState("");
  const [initials, setInitials] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suggested = useMemo(
    () => name.trim().split(/\s+/).map((p) => p[0]).join("").slice(0, 4).toUpperCase(),
    [name],
  );

  async function add() {
    const cleanName = name.trim();
    const cleanInitials = (initials.trim() || suggested).toUpperCase();
    if (!cleanName || !cleanInitials) return setError("Enter a name and initials.");
    try {
      await create.mutateAsync({ name: cleanName, initials: cleanInitials });
      setName("");
      setInitials("");
      setError(null);
    } catch (cause) {
      setError(String(cause).includes("UNIQUE") ? "That user already exists." : String(cause));
    }
  }

  return (
    <>
      <div className="rounded-xl border border-line bg-surface p-3">
        <div className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
          <Field label="Full name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex Rivera" />
          </Field>
          <Field label="Initials">
            <TextInput
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 4))}
              placeholder={suggested || "AR"}
            />
          </Field>
          <Button className="mb-3.5" variant="primary" onClick={add} disabled={create.isPending}>
            <UserPlus size={15} /> Add
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <div className="mt-4 space-y-2">
        {users.length === 0 && <p className="py-5 text-center text-sm text-ink-faint">No users yet.</p>}
        {users.map((user) => {
          const signedIn = activeUser?.id === user.id;
          return (
            <div key={user.id} className={rowClass}>
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand-strong">
                  {user.initials}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">{user.name}</p>
                  <p className="text-[11px] text-ink-faint">
                    {signedIn ? "Signed in now" : user.is_active ? "Available" : "Inactive"}
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                className="px-2.5 py-1.5 text-xs"
                onClick={() => setEnabled.mutate({ id: user.id, isActive: !user.is_active })}
                disabled={setEnabled.isPending}
                title={signedIn ? "Deactivating this user will sign them out" : undefined}
              >
                {user.is_active ? <><UserMinus size={14} /> Deactivate</> : <><UserCheck size={14} /> Reactivate</>}
              </Button>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- Projects --------------------------------------------------------------

function ProjectsPanel() {
  const { data: projects = [] } = useProjects(false);
  const { data: users = [] } = useUsers(true);
  const { update, setActive, remove } = useProjectMutations();
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ code: "", name: "", lead_user_id: 0 });
  const [error, setError] = useState<string | null>(null);

  function beginEdit(project: Project) {
    setError(null);
    setEditing(project.id);
    setDraft({ code: project.code, name: project.name, lead_user_id: project.lead_user_id ?? 0 });
  }
  async function save(id: number) {
    const lead = users.find((u) => u.id === draft.lead_user_id);
    try {
      await update.mutateAsync({
        id,
        input: { code: draft.code, name: draft.name, team_lead: lead?.name ?? "", lead_user_id: draft.lead_user_id },
      });
      setEditing(null);
    } catch (cause) {
      setError(String(cause).includes("UNIQUE") ? "That project code is taken." : String(cause));
    }
  }
  async function del(project: Project) {
    setError(null);
    try {
      await remove.mutateAsync(project.id);
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-600">{error}</p>}
      {projects.length === 0 && <p className="py-5 text-center text-sm text-ink-faint">No projects yet.</p>}
      {projects.map((project) => {
        const count = project.sample_count ?? 0;
        if (editing === project.id) {
          return (
            <div key={project.id} className="rounded-lg border border-brand/40 bg-surface p-3">
              <div className="grid grid-cols-[6rem_1fr] gap-2">
                <Field label="Code">
                  <TextInput value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value.toUpperCase() }))} />
                </Field>
                <Field label="Name">
                  <TextInput value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
                </Field>
              </div>
              <Field label="Lead">
                <Select
                  value={draft.lead_user_id || ""}
                  onChange={(e) => setDraft((d) => ({ ...d, lead_user_id: Number(e.target.value) }))}
                >
                  <option value="">—</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </Select>
              </Field>
              <div className="mt-1 flex justify-end gap-2">
                <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => setEditing(null)}>Cancel</Button>
                <Button variant="primary" className="px-2.5 py-1.5 text-xs" onClick={() => save(project.id)} disabled={update.isPending}>
                  <Check size={14} /> Save
                </Button>
              </div>
            </div>
          );
        }
        return (
          <div key={project.id} className={rowClass}>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">
                <span className="font-semibold">{project.code}</span> · {project.name}
              </p>
              <p className="text-[11px] text-ink-faint">
                {project.team_lead || "No lead"} · {count} {count === 1 ? "sample" : "samples"}
                {project.is_active ? "" : " · inactive"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="ghost" className="px-2 py-1.5 text-xs" onClick={() => beginEdit(project)} title="Edit">
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                className="px-2 py-1.5 text-xs"
                onClick={() => setActive.mutate({ id: project.id, isActive: !project.is_active })}
              >
                {project.is_active ? "Deactivate" : "Reactivate"}
              </Button>
              <Button
                variant="danger"
                className="px-2 py-1.5 text-xs"
                onClick={() => del(project)}
                disabled={count > 0 || remove.isPending}
                title={count > 0 ? "Has samples — deactivate instead" : "Delete project"}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- Stains / IHC ----------------------------------------------------------

function StainsPanel() {
  const { data: catalog = [] } = useAssayCatalog(true);
  const { create, rename, setEnabled, remove } = useAssayCatalogMutations();
  const [name, setName] = useState("");
  const [type, setType] = useState<"stain" | "ihc">("stain");
  const [editing, setEditing] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!name.trim()) return setError("Enter an agent name.");
    try {
      await create.mutateAsync({ assay_type: type, name });
      setName("");
      setError(null);
    } catch (cause) {
      setError(String(cause).includes("UNIQUE") ? "That agent already exists." : String(cause));
    }
  }
  async function saveRename(id: number) {
    try {
      await rename.mutateAsync({ id, name: draftName });
      setEditing(null);
      setError(null);
    } catch (cause) {
      setError(String(cause).includes("UNIQUE") ? "That agent already exists." : String(cause));
    }
  }
  async function del(entry: AssayCatalogEntry) {
    setError(null);
    try {
      await remove.mutateAsync(entry.id);
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <>
      <div className="rounded-xl border border-line bg-surface p-3">
        <div className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
          <Field label="Agent name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="H&E" />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as "stain" | "ihc")}>
              <option value="stain">Stain</option>
              <option value="ihc">IHC</option>
            </Select>
          </Field>
          <Button className="mb-3.5" variant="primary" onClick={add} disabled={create.isPending}>
            <Plus size={15} /> Add
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <div className="mt-4 space-y-2">
        {catalog.length === 0 && <p className="py-5 text-center text-sm text-ink-faint">No agents yet.</p>}
        {catalog.map((entry) => {
          const used = entry.slide_count ?? 0;
          return (
            <div key={entry.id} className={rowClass}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand">
                  {entry.assay_type}
                </span>
                {editing === entry.id ? (
                  <TextInput
                    value={draftName}
                    autoFocus
                    onChange={(e) => setDraftName(e.target.value)}
                    className="h-7 py-0.5 text-sm"
                  />
                ) : (
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{entry.name}</p>
                    <p className="text-[11px] text-ink-faint">
                      {used} {used === 1 ? "slide" : "slides"}{entry.is_active ? "" : " · inactive"}
                    </p>
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {editing === entry.id ? (
                  <>
                    <Button variant="ghost" title="Cancel rename" className="px-2 py-1.5 text-xs" onClick={() => setEditing(null)}><X size={14} /></Button>
                    <Button variant="primary" title="Save name" className="px-2 py-1.5 text-xs" onClick={() => saveRename(entry.id)} disabled={rename.isPending}><Check size={14} /></Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      className="px-2 py-1.5 text-xs"
                      onClick={() => { setEditing(entry.id); setDraftName(entry.name); }}
                      title="Rename"
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      variant="ghost"
                      className="px-2 py-1.5 text-xs"
                      onClick={() => setEnabled.mutate({ id: entry.id, isActive: !entry.is_active })}
                    >
                      {entry.is_active ? "Deactivate" : "Reactivate"}
                    </Button>
                    <Button
                      variant="danger"
                      className="px-2 py-1.5 text-xs"
                      onClick={() => del(entry)}
                      disabled={used > 0 || remove.isPending}
                      title={used > 0 ? "Used on slides — deactivate instead" : "Delete agent"}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---- Dialog ----------------------------------------------------------------

export function ManageDialog({
  users,
  activeUser,
  onClose,
  initialTab = "users",
}: {
  users: LabUser[];
  activeUser: LabUser | null;
  onClose: () => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "users", label: "Users" },
    { key: "projects", label: "Projects" },
    { key: "stains", label: "Stains & IHC" },
  ];
  return (
    <Modal title="Manage" onClose={onClose} width="max-w-lg">
      <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg border border-line bg-panel p-0.5 text-xs">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-2 py-1.5 font-medium ${tab === t.key ? "bg-brand text-white" : "text-ink-soft hover:bg-surface"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "users" && <UsersPanel users={users} activeUser={activeUser} />}
      {tab === "projects" && <ProjectsPanel />}
      {tab === "stains" && <StainsPanel />}
    </Modal>
  );
}
