import { describe, it, expect } from "vitest";
import { planSignature } from "./SectioningPlanDialog";

// Divergence detection: two blocks are "different" iff their plan signatures
// differ. Signatures ignore group order and normalize duplicates.
describe("planSignature — batch divergence detection", () => {
  const heE = JSON.stringify([
    { duplicates: 1, assay_type: "stain", assay_name: "H&E", stains: "H&E" },
    { duplicates: 3, stains: "" },
  ]);
  const masson = JSON.stringify([
    { duplicates: 1, assay_type: "stain", assay_name: "Masson", stains: "Masson" },
    { duplicates: 3, stains: "" },
  ]);
  const heEReordered = JSON.stringify([
    { duplicates: 3, stains: "" },
    { duplicates: 1, assay_type: "stain", assay_name: "H&E", stains: "H&E" },
  ]);

  it("treats different stains as divergent", () => {
    expect(planSignature(heE)).not.toBe(planSignature(masson));
  });

  it("is order-independent for identical plans", () => {
    expect(planSignature(heE)).toBe(planSignature(heEReordered));
  });

  it("treats an empty/cleared plan as its own signature", () => {
    expect(planSignature("")).toBe("");
    expect(planSignature("[]")).toBe("");
    expect(planSignature("")).not.toBe(planSignature(heE));
  });

  it("a set of identical signatures collapses to one (not divergent)", () => {
    const sigs = new Set([heE, heEReordered].map(planSignature));
    expect(sigs.size).toBe(1);
  });
});
