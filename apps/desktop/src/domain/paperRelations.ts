import type { Paper } from "./paper";

export type PaperRelationKind = "references" | "citedBy" | "recommendations";

export type PaperRelationWarning = {
  relation: PaperRelationKind;
  message: string;
};

/**
 * A source-independent citation neighborhood. `references` are works cited by
 * the target, while `citedBy` are works that cite the target.
 */
export type PaperRelations = {
  target: Paper;
  references: Paper[];
  citedBy: Paper[];
  recommendations: Paper[];
  warnings: PaperRelationWarning[];
};
