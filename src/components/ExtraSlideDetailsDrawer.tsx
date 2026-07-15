import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, Star, X } from "lucide-react";
import type { Slide } from "../lib/types";
import { useAssayCatalog, useExtraSlideMutations } from "../hooks/useData";
import { Button } from "./ui";

type AssaySelection = `${"stain" | "ihc"}:${string}`;

export function ExtraSlideDetailsDrawer({
  slides,
  width = 416,
  onClose,
}: {
  slides: Slide[];
  width?: number;
  onClose: () => void;
}) {
  const { data: catalog = [] } = useAssayCatalog();
  const { assign } = useExtraSlideMutations();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [assays, setAssays] = useState<Record<number, AssaySelection | "">>({});
  const [error, setError] = useState<string | null>(null);
  const parentCode = slides[0]?.parent_code ?? "Extra slides";
  const description = slides[0]?.sample_description ?? "";
  const projectCode = slides[0]?.project_code ?? "";
  const selectedSlides = useMemo(
    () => slides.filter((slide) => selected.has(slide.id)),
    [selected, slides],
  );
  const readyToAssign = selectedSlides.length > 0 && selectedSlides.every((slide) => assays[slide.id]);

  useEffect(() => {
    const available = new Set(slides.map((slide) => slide.id));
    setSelected((current) => new Set([...current].filter((id) => available.has(id))));
  }, [slides]);

  async function assignSelected() {
    if (!readyToAssign) return;
    setError(null);
    try {
      for (const slide of selectedSlides) {
        const [assayType, ...nameParts] = assays[slide.id].split(":");
        await assign.mutateAsync({
          slideId: slide.id,
          assayType: assayType as "stain" | "ihc",
          assayName: nameParts.join(":"),
        });
      }
      setSelected(new Set());
      setAssays({});
    } catch (cause) {
      setError(String(cause));
    }
  }

  return (
    <div className="flex h-full shrink-0 flex-col border-l border-line bg-panel" style={{ width }}>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-base font-semibold text-ink">{parentCode}</h2>
            {slides[0]?.is_priority === 1 && <Star size={13} className="fill-amber-400 text-amber-500" />}
          </div>
          <p className="truncate text-xs text-ink-faint">
            {projectCode}{description ? ` · ${description}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-faint hover:bg-black/5 hover:text-ink"
          aria-label="Close extra slide details"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 thin-scroll">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Extra slide inventory</h3>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Select only the slides needed for stain or IHC work.
            </p>
          </div>
          <span className="rounded-full bg-brand/10 px-2 py-1 text-xs font-semibold text-brand">
            {slides.length} available
          </span>
        </div>

        <div className="space-y-1.5">
          {slides.map((slide) => {
            const checked = selected.has(slide.id);
            return (
              <div
                key={slide.id}
                className={`rounded-md border p-2 transition ${checked ? "border-brand/50 bg-brand/5" : "border-line bg-surface"}`}
              >
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelected((current) => {
                      const next = new Set(current);
                      if (next.has(slide.id)) next.delete(slide.id);
                      else next.add(slide.id);
                      return next;
                    })}
                    className="h-3.5 w-3.5 accent-[var(--color-brand)]"
                  />
                  <Archive size={12} className="shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{slide.slide_code}</span>
                  <span className="shrink-0 text-[10px] text-ink-faint">{slide.depth_um} um</span>
                </label>
                {checked && (
                  <select
                    value={assays[slide.id] ?? ""}
                    onChange={(event) => setAssays((current) => ({
                      ...current,
                      [slide.id]: event.target.value as AssaySelection | "",
                    }))}
                    className="mt-2 w-full rounded border border-line bg-panel px-2 py-1.5 text-xs text-ink outline-none focus:border-brand"
                    aria-label={`Assay for ${slide.slide_code}`}
                  >
                    <option value="">Choose stain or IHC...</option>
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
                )}
              </div>
            );
          })}
        </div>
        {error && <p className="mt-3 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700">{error}</p>}
      </div>

      <div className="border-t border-line px-4 py-3">
        <p className="mb-2 text-xs text-ink-faint">
          Unselected slides remain available in Extra inventory.
        </p>
        <Button
          variant="primary"
          className="w-full"
          disabled={!readyToAssign || assign.isPending}
          onClick={() => void assignSelected()}
        >
          <CheckCircle2 size={15} />
          {selectedSlides.length > 0
            ? `Assign ${selectedSlides.length} selected slide${selectedSlides.length === 1 ? "" : "s"}`
            : "Select slides to assign"}
        </Button>
      </div>
    </div>
  );
}
