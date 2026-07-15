import { useMemo, useState } from "react";
import { Archive, Search, Star } from "lucide-react";
import type { Slide } from "../lib/types";
import { useAssayCatalog, useExtraSlideMutations } from "../hooks/useData";

export function ExtraSlideInventory({ slides }: { slides: Slide[] }) {
  const { data: catalog = [] } = useAssayCatalog();
  const { assign } = useExtraSlideMutations();
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return slides;
    return slides.filter((slide) =>
      [slide.slide_code, slide.parent_code, slide.sample_description, slide.project_code]
        .some((value) => value?.toLowerCase().includes(query)),
    );
  }, [search, slides]);

  return (
    <>
      <label className="mb-1 flex items-center gap-1 rounded-md border border-line bg-panel px-2 py-1">
        <Search size={11} className="text-ink-faint" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find extra slide…"
          className="min-w-0 flex-1 bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
        />
      </label>
      {error && <p className="mb-1 rounded bg-red-50 px-2 py-1 text-[10px] text-red-700">{error}</p>}
      {visible.map((slide) => (
        <div key={slide.id} className="rounded-md border border-line bg-white px-2 py-1.5">
          <div className="flex items-center gap-1">
            <Archive size={11} className="shrink-0 text-ink-faint" />
            <span className="truncate text-[11px] font-semibold text-ink">{slide.slide_code}</span>
            {slide.is_priority === 1 && <Star size={9} className="fill-amber-400 text-amber-500" />}
            <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{slide.depth_um}µm</span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-ink-soft">
            {slide.project_code} · {slide.parent_code}{slide.sample_description ? ` · ${slide.sample_description}` : ""}
          </p>
          <select
            value=""
            disabled={assign.isPending}
            onChange={(event) => {
              const [assayType, ...parts] = event.target.value.split(":");
              if (!assayType) return;
              setError(null);
              assign.mutate(
                { slideId: slide.id, assayType: assayType as "stain" | "ihc", assayName: parts.join(":") },
                { onError: (cause) => setError(String(cause)) },
              );
            }}
            className="mt-1 w-full rounded border border-line bg-panel px-1.5 py-1 text-[10px] text-ink outline-none focus:border-brand"
            aria-label={`Assign assay to ${slide.slide_code}`}
          >
            <option value="">Assign stain or IHC…</option>
            <optgroup label="Stains">
              {catalog.filter((entry) => entry.assay_type === "stain").map((entry) => (
                <option key={`stain-${entry.id}`} value={`stain:${entry.name}`}>{entry.name}</option>
              ))}
            </optgroup>
            <optgroup label="IHC">
              {catalog.filter((entry) => entry.assay_type === "ihc").map((entry) => (
                <option key={`ihc-${entry.id}`} value={`ihc:${entry.name}`}>{entry.name}</option>
              ))}
            </optgroup>
          </select>
        </div>
      ))}
      {visible.length === 0 && slides.length > 0 && (
        <p className="px-1 py-3 text-center text-[11px] text-ink-faint">
          {slides.length ? "No matching extra slides" : "No extra slides in inventory"}
        </p>
      )}
    </>
  );
}
