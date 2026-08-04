import { History, LayoutGrid, Microscope, PanelLeftClose, PanelLeftOpen, Plus, Table2 } from "lucide-react";
import { useState } from "react";
import type { Project } from "../lib/types";
import { cn } from "../lib/utils";
import { useReadOnly } from "../lib/readOnly";
import { APP_VERSION } from "../lib/version";

export type AppView = "board" | "logs" | "manifest";

export function Sidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onAddProject,
  view,
  onSelectView,
}: {
  projects: Project[];
  selectedProjectId: number | null;
  onSelectProject: (id: number) => void;
  onAddProject: () => void;
  view: AppView;
  onSelectView: (view: AppView) => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("histometer-sidebar-collapsed") === "true",
  );
  const readOnly = useReadOnly();
  function toggleCollapsed() {
    setCollapsed((current) => {
      window.localStorage.setItem("histometer-sidebar-collapsed", String(!current));
      return !current;
    });
  }
  return (
    <aside className={cn("sidebar-themed flex h-full shrink-0 flex-col transition-[width]", collapsed ? "w-14" : "w-64")}>
      <div className={cn("flex items-center gap-2 pb-3 pt-5", collapsed ? "justify-center px-2" : "px-5")}>
        <Microscope size={21} className="text-brand-strong" />
        {!collapsed && <span className="text-lg font-semibold tracking-tight">Histometer</span>}
      </div>

      <nav className={cn("flex gap-1 pb-1", collapsed ? "flex-col px-1.5" : "px-3")}>
        {([
          { key: "board", label: "Board", icon: LayoutGrid },
          { key: "logs", label: "Logs", icon: Table2 },
          { key: "manifest", label: "Manifest", icon: History },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onSelectView(key)}
            title={collapsed ? label : undefined}
            className={cn(
              "flex flex-1 items-center gap-2 rounded-lg py-2 text-sm font-medium transition",
              collapsed ? "justify-center px-1" : "px-3",
              view === key ? "bg-brand/15 text-ink" : "text-ink-soft hover:bg-brand/8",
            )}
          >
            <Icon size={16} className="shrink-0" />
            {!collapsed && label}
          </button>
        ))}
      </nav>

      <div className={cn("flex items-center pb-2 pt-3", collapsed ? "flex-col gap-1 px-2" : "justify-between px-5")}>
        {!collapsed && <span className="text-xs font-semibold uppercase tracking-wider text-ink-soft">Active Projects</span>}
        <div className="flex items-center gap-1">
        <button
          onClick={onAddProject}
          // A viewer cannot create a project; the dialog's Save was rejected
          // downstream with no feedback (#72).
          disabled={readOnly}
          title={readOnly ? "Read-only viewer — projects are created on the workstation" : "Add project"}
          className="rounded-md p-1 text-ink-soft transition hover:bg-brand/10 hover:text-ink"
        >
          <Plus size={16} />
        </button>
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand active projects" : "Collapse active projects"}
          className="rounded-md p-1 text-ink-soft transition hover:bg-brand/10 hover:text-ink"
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        </div>
      </div>

      <div className={cn("flex-1 overflow-y-auto thin-scroll", collapsed ? "px-1.5" : "px-3")}>
        {projects.length === 0 && !collapsed && (
          <p className="px-2 py-4 text-sm text-ink-faint">
            No active projects yet. Add one to begin.
          </p>
        )}
        {projects.map((p) => {
          const active = p.id === selectedProjectId;
          return (
            <button
              key={p.id}
              onClick={() => onSelectProject(p.id)}
              title={collapsed ? `${p.name} (${p.code})` : undefined}
              aria-current={active ? "true" : undefined}
              // The active project decides which project a new sample lands in,
              // so it has to be unmistakable at a glance — a dim tint was being
              // missed and samples were created under the wrong project (#84).
              // Solid brand fill + a left accent bar + weight, not tint alone.
              className={cn(
                "relative mb-1 flex w-full items-center justify-between rounded-lg py-2 text-left transition",
                collapsed ? "justify-center pl-2 pr-1" : "pl-4 pr-3",
                active
                  ? "bg-brand/45 text-ink ring-2 ring-brand shadow-sm before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1.5 before:rounded-l-lg before:bg-brand-strong"
                  : "opacity-80 hover:opacity-100 hover:bg-brand/8",
              )}
            >
              {collapsed ? (
                // Collapsed, the only cue used to be a 3-letter code with no
                // active marker at all — so the sidebar gave no answer to "which
                // project will this sample go into?" (#84). Show a dot.
                <span className="flex items-center gap-1">
                  {active && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-strong" />}
                  <span className={cn("text-xs", active ? "font-bold text-ink" : "font-semibold")}>
                    {p.code.slice(0, 3).toUpperCase()}
                  </span>
                </span>
              ) : <span className="min-w-0">
                <span className={cn("block truncate text-sm", active ? "font-bold" : "font-medium")}>
                  {p.name}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span className={cn("text-xs", active ? "font-semibold text-ink" : "text-ink-faint")}>
                    {p.code}
                  </span>
                  {active && (
                    // text-surface, not text-white: brand-strong is a LIGHT tone
                    // in the dark themes, where white would wash out.
                    <span className="rounded-sm bg-brand-strong px-1 py-px text-[9px] font-bold uppercase tracking-wider text-surface">
                      Active
                    </span>
                  )}
                </span>
              </span>}
              {!collapsed && <span className={cn(
                "ml-2 shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                active ? "bg-brand-strong font-semibold text-surface" : "bg-brand/10 text-brand-strong",
              )}>
                {p.sample_count ?? 0}
              </span>}
            </button>
          );
        })}
      </div>

      <div className={cn("shrink-0 border-t border-line/60 py-2 text-ink-faint", collapsed ? "px-1 text-center" : "px-5")}>
        <span className="text-[10px] font-medium tabular-nums" title="Histometer version">
          {collapsed ? APP_VERSION : `Histometer v${APP_VERSION}`}
        </span>
      </div>
    </aside>
  );
}
