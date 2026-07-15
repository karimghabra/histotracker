import { Microscope, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { useState } from "react";
import type { Project } from "../lib/types";
import { cn } from "../lib/utils";

export function Sidebar({
  projects,
  selectedProjectId,
  onSelectProject,
  onAddProject,
}: {
  projects: Project[];
  selectedProjectId: number | null;
  onSelectProject: (id: number) => void;
  onAddProject: () => void;
}) {
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem("histometer-sidebar-collapsed") === "true",
  );
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

      <div className={cn("flex items-center pb-2 pt-3", collapsed ? "flex-col gap-1 px-2" : "justify-between px-5")}>
        {!collapsed && <span className="text-xs font-semibold uppercase tracking-wider text-ink-soft">Active Projects</span>}
        <div className="flex items-center gap-1">
        <button
          onClick={onAddProject}
          title="Add project"
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
              className={cn(
                "mb-1 flex w-full items-center justify-between rounded-lg py-2 text-left transition",
                collapsed ? "justify-center px-1" : "px-3",
                active ? "bg-brand/15 text-ink" : "hover:bg-brand/8",
              )}
            >
              {collapsed ? (
                <span className="text-xs font-semibold">{p.code.slice(0, 3).toUpperCase()}</span>
              ) : <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="block text-xs text-ink-faint">{p.code}</span>
              </span>}
              {!collapsed && <span className="ml-2 shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] text-brand-strong">
                {p.sample_count ?? 0}
              </span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
