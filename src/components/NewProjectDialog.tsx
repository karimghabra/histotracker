import { useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "./ui";
import { useProjectMutations } from "../hooks/useData";
import type { LabUser } from "../lib/types";

export function NewProjectDialog({ users, onClose }: { users: LabUser[]; onClose: () => void }) {
  const { create } = useProjectMutations();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [leadUserId, setLeadUserId] = useState(() => users[0]?.id ?? 0);
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const lead = users.find((user) => user.id === leadUserId);
    if (!code.trim() || !name.trim() || !lead) {
      setError("Please fill in all fields.");
      return;
    }
    try {
      await create.mutateAsync({ code, name, team_lead: lead.name, lead_user_id: lead.id, is_active: isActive });
      onClose();
    } catch (e) {
      setError(String(e).includes("UNIQUE") ? `Project code "${code}" already exists.` : String(e));
    }
  }

  return (
    <Modal title="Add Project" onClose={onClose}>
      <Field label="Project Code">
        <TextInput
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="EE"
          autoFocus
        />
      </Field>
      <Field label="Project Name">
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Enthesis Engineering"
        />
      </Field>
      <Field label="Project Lead">
        <Select value={leadUserId || ""} onChange={(e) => setLeadUserId(Number(e.target.value))}>
          {users.length === 0 && <option value="">Add a user before creating a project</option>}
          {users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.initials})</option>)}
        </Select>
      </Field>
      <label className="mb-2 flex items-center gap-2 text-sm text-ink-soft">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Show in active project sidebar
      </label>
      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={create.isPending || users.length === 0}>
          Save Project
        </Button>
      </div>
    </Modal>
  );
}
