import type {
  ComparisonSource,
  ComparisonPage,
  PageProblem,
  SourceEntry,
} from "../../src/evaluations/index.js";
import { pageFileName } from "../../src/evaluations/index.js";
import { ComparisonPageView, EvaluationsPage } from "../../src/server/pages/evaluations.js";
import { render, type Chrome } from "../../src/server/pages/index.js";
import { createEvaluationService, type EvaluationQuery } from "../../src/services/evaluations.js";
import type { ComparisonView, EvaluationListView } from "../../src/services/views.js";
import { buildChrome } from "../pages/support.js";
import { PRINCIPALS } from "./fixtures.js";

/**
 * The comparison page rendered from documents made by hand, through the real service. The page
 * test, the page fixtures and the style test all use these, so each page they see is one the
 * service could have built for a legal engineer.
 */

export const PUBLISHED_AT = "2026-11-05T09:30:00.000Z";

/** A source over pages in memory, newest first as given, and over files that cannot be used. */
export function memorySource(
  pages: readonly ComparisonPage[],
  unusable: readonly { name: string; problem: PageProblem }[] = [],
): ComparisonSource {
  const entries: SourceEntry[] = [
    ...pages.map((page): SourceEntry => ({
      ok: true,
      id: page.id,
      publishedAt: PUBLISHED_AT,
      page,
    })),
    ...unusable.map((u): SourceEntry => ({ ok: false, name: u.name, problem: u.problem })),
  ];
  return {
    list: () => ({ entries, truncated: false }),
    get: (id) => {
      const found = pages.find((page) => page.id === id);
      return found === undefined ? null : { page: found, publishedAt: PUBLISHED_AT };
    },
  };
}

export const chrome = (overrides: Partial<Chrome> = {}): Chrome =>
  buildChrome({
    userName: PRINCIPALS.engineer.displayName,
    globalRole: "legal_engineer",
    ...overrides,
  });

export function listView(source: ComparisonSource): EvaluationListView {
  return createEvaluationService(source).list(PRINCIPALS.engineer);
}

export function comparisonView(
  page: ComparisonPage,
  query: Omit<EvaluationQuery, "id"> = {},
): ComparisonView {
  return createEvaluationService(memorySource([page])).comparison(PRINCIPALS.engineer, {
    id: page.id,
    ...query,
  });
}

export const listHtml = (source: ComparisonSource, c: Chrome = chrome()): string =>
  render(EvaluationsPage({ chrome: c, list: listView(source) }));

export const comparisonHtml = (
  page: ComparisonPage,
  query: Omit<EvaluationQuery, "id"> = {},
  c: Chrome = chrome(),
): string => render(ComparisonPageView({ chrome: c, view: comparisonView(page, query) }));

/** The file name a page is published under; here for the tests that write files. */
export const fileNameOf = (page: ComparisonPage): string => pageFileName(page.id);
