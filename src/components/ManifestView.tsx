import { useMemo, useState } from "react";
import { Search, UserRound } from "lucide-react";
import { useAuditEvents, useUsers } from "../hooks/useData";
import { displayCodesInText } from "../lib/utils";

// #77 — "Manifest should show who made what changes".
//
// audit_events has been written by database triggers since migration 0010, with
// user_id on every row, but nothing in the app ever read it — so the product
// could not answer the question at all. This is that reader.

const ACTION_TONE: Record<string, string> = {
  create: "bg-emerald-100 text-emerald-700",
  update: "bg-brand/15 text-brand-strong",
  delete: "bg-red-100 text-red-700",
};

function when(at: string): string {
  return (at ?? "").replace("T", " ").slice(0, 16) || "—";
}

export function ManifestView() {
  const { data: events = [], isLoading } = useAuditEvents();
  const { data: users = [] } = useUsers();
  const [who, setWho] = useState<string>("all");
  const [action, setAction] = useState<string>("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      if (who !== "all") {
        // "" is the unsigned bucket — changes made with nobody signed in.
        if (who === "__unsigned__" ? event.user_name !== "" : event.user_name !== who) return false;
      }
      if (action !== "all" && event.action !== action) return false;
      if (query) {
        const hay = [event.summary, event.entity_type, event.sample_code, event.project_code, event.user_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [events, who, action, search]);

  const unsignedCount = events.filter((event) => event.user_name === "").length;

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-sm font-semibold text-ink">Manifest</h2>
        <span className="text-xs text-ink-faint">
          {rows.length} of {events.length} change{events.length === 1 ? "" : "s"}
        </span>

        <label className="ml-auto flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-xs">
          <Search size={12} className="text-ink-faint" />
          <input
            aria-label="Search the manifest"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search changes…"
            className="w-44 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
          />
        </label>

        <select
          aria-label="Filter manifest by user"
          value={who}
          onChange={(event) => setWho(event.target.value)}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none"
        >
          <option value="all">Everyone</option>
          {users.map((user) => (
            <option key={user.id} value={user.name}>{user.name}</option>
          ))}
          {unsignedCount > 0 && <option value="__unsigned__">Unsigned ({unsignedCount})</option>}
        </select>

        <select
          aria-label="Filter manifest by action"
          value={action}
          onChange={(event) => setAction(event.target.value)}
          className="rounded-md border border-line bg-white px-2 py-1 text-xs text-ink outline-none"
        >
          <option value="all">All actions</option>
          <option value="create">Created</option>
          <option value="update">Updated</option>
          <option value="delete">Deleted</option>
        </select>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-panel thin-scroll">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface text-[11px] uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="px-2 py-1.5 font-semibold">When</th>
              <th className="px-2 py-1.5 font-semibold">Who</th>
              <th className="px-2 py-1.5 font-semibold">Action</th>
              <th className="px-2 py-1.5 font-semibold">Sample</th>
              <th className="px-2 py-1.5 font-semibold">Change</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-ink-faint">Loading…</td></tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-ink-faint">No changes match.</td></tr>
            )}
            {rows.map((event) => (
              <tr key={event.id} className="border-t border-line/60 align-top">
                <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-ink-faint">
                  {when(event.created_at)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {event.user_name ? (
                    <span className="inline-flex items-center gap-1 font-medium text-ink">
                      <UserRound size={11} className="text-ink-faint" /> {event.user_name}
                    </span>
                  ) : (
                    // Honest about gaps rather than implying attribution the
                    // record does not have.
                    <span className="text-ink-faint" title="No one was signed in when this change was made">
                      Unsigned
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    ACTION_TONE[event.action] ?? "bg-ink/10 text-ink-soft"
                  }`}>
                    {event.action}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1.5 text-ink-soft">
                  {event.sample_code ? displayCodesInText(event.sample_code) : "—"}
                </td>
                <td className="px-2 py-1.5 text-ink-soft">{displayCodesInText(event.summary)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
