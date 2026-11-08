import type { ResultKind } from "./types.js";

/** Where a review's contract is kept in the contract store. */
export const contractKey = (reviewId: string): string => `${reviewId}/contract.docx`;

const RESULT_FILES: Record<ResultKind, string> = {
  redlined: "redlined.docx",
  report: "report.json",
  summary: "summary.md",
};

/** Where one result of a review is kept in the result store. */
export const resultKey = (reviewId: string, kind: ResultKind): string =>
  `${reviewId}/${RESULT_FILES[kind]}`;
