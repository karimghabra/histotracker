import { useMemo, useState } from "react";
import { Archive, Search, Star } from "lucide-react";
import type { Slide } from "../lib/types";

export interface ExtraSlideGroup {
  sampleId: number;
  parentCode: string;
  sampleDescription: string;
  projectCode: string;
  isPriority: boolean;
  slides: Slide[];
}

export function groupExtraSlides(slides: Slide[]): ExtraSlideGroup[] {
  const groups = new Map<number, ExtraSlideGroup>();
  for (const slide of slides) {
    if (slide.sample_id == null) continue;
    const existing = groups.get(slide.sample_id);
    if (existing) {
      existing.slides.push(slide);
      continue;
    }
    groups.set(slide.sample_id, {
      sampleId: slide.sample_id,
      parentCode: slide.parent_code ?? slide.slide_code,
      sampleDescription: slide.sample_description ?? "",
      projectCode: slide.project_code ?? "",
      isPriority: slide.is_priority === 1,
      slides: [slide],
    });
  }
  return [...groups.values()];
}

export function ExtraSlideInventory({
  slides,
  onSelectSample,
}: {
  slides: Slide[];
  onSelectSample: (sampleId: number) => void;
}) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => groupExtraSlides(slides), [slides]);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groups;
    return groups.filter((group) =>
      [group.parentCode, group.sampleDescription, group.projectCode]
        .some((value) => value.toLowerCase().includes(query)) ||
      group.slides.some((slide) => slide.slide_code.toLowerCase().includes(query)),
    );
  }, [groups, search]);

  return (
    <>
      <label className="mb-1 flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1">
        <Search size={11} className="text-ink-faint" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find sample or extra slide..."
          className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
      {visible.map((group) => {
        const depths = [...new Set(group.slides.map((slide) => slide.depth_um).filter((depth) => depth != null))];
        return (
          <button
            type="button"
            key={group.sampleId}
            onClick={() => onSelectSample(group.sampleId)}
            className="group flex w-full items-center gap-2 rounded-md border border-line bg-white px-2 py-1.5 text-left transition hover:border-brand/40"
          >
            <Archive size={13} className="shrink-0 text-ink-faint" />
            <span className="shrink-0 text-xs font-semibold text-ink">{group.parentCode}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-soft">
              {group.sampleDescription || group.projectCode}
            </span>
            {depths.length > 0 && (
              <span className="shrink-0 text-[10px] text-ink-faint">
                {depths.length === 1 ? `${depths[0]} um` : `${depths.length} depths`}
              </span>
            )}
            <span
              className="shrink-0 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand"
              title={`${group.slides.length} extra slide${group.slides.length === 1 ? "" : "s"}`}
            >
              {group.slides.length}
            </span>
            {group.isPriority && <Star size={11} className="shrink-0 fill-amber-400 text-amber-500" />}
          </button>
        );
      })}
      {visible.length === 0 && (
        <p className="px-1 py-3 text-center text-[11px] text-ink-faint">
          {slides.length ? "No matching samples" : "No extra slides in inventory"}
        </p>
      )}
    </>
  );
}
