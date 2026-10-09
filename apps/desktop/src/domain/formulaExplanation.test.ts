import { describe, expect, it } from "vitest";
import { explainFormulaStructure } from "./formulaExplanation";

describe("formula explanation", () => {
  it("recognizes attention-style structure without inventing symbol meanings", () => {
    const result = explainFormulaStructure("softmax(QKᵀ / √d_k)V");
    expect(result.intuition).toContain("权重");
    expect(result.observations.join(" ")).toContain("转置");
    expect(result.symbols).toEqual(expect.arrayContaining(["QK", "d", "k", "V"]));
  });
});
