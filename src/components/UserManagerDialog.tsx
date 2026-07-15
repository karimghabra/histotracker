import { useMemo, useState } from "react";
import { UserCheck, UserMinus, UserPlus } from "lucide-react";
import type { LabUser } from "../lib/types";
import { useUserMutations } from "../hooks/useData";
import { Button, Field, Modal, TextInput } from "./ui";

export function UserManagerDialog({
  users,
  activeUser,
  onClose,
}: {
  users: LabUser[];
  activeUser: LabUser | null;
  onClose: () => void;
}) {
  const { create, setEnabled } = useUserMutations();
  const [name, setName] = useState("");
  const [initials, setInitials] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suggestedInitials = useMemo(
    () => name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 4).toUpperCase(),
    [name],
  );

  async function add() {
    const cleanName = name.trim();
    const cleanInitials = (initials.trim() || suggestedInitials).toUpperCase();
    if (!cleanName || !cleanInitials) {
      setError("Enter a name and initials.");
      return;
    }
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
    <Modal title="Lab Users" onClose={onClose} width="max-w-lg">
      <div className="rounded-xl border border-line bg-surface p-3">
        <div className="grid grid-cols-[1fr_7rem_auto] items-end gap-2">
          <Field label="Full name">
            <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="Alex Rivera" />
          </Field>
          <Field label="Initials">
            <TextInput
              value={initials}
              onChange={(event) => setInitials(event.target.value.toUpperCase().slice(0, 4))}
              placeholder={suggestedInitials || "AR"}
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
            <div key={user.id} className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2.5">
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
    </Modal>
  );
}
