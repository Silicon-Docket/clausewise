/**
 * What "perfect" means for the selftest. The selftest runs the real stages against an oracle that
 * answers every rule as the answer key says, so a correct runner, scorer, dataset and workflow
 * must give that oracle a perfect score on every measure that has a denominator. Anything less is
 * a defect in the plumbing, and the selftest fails (exit code 1) and says which measure fell short.
 *
 * A measure with a zero denominator is not tested: no flagged slot, no required escalation and so
 * on mean there was nothing to get wrong, which is not the same as a perfect result.
 *
 * Passing says the plumbing agrees with itself. It says nothing about any model.
 */
import type { Rate } from "./stats.js";
import type { SplitSection } from "./results.js";

export function selftestFailures(sections: readonly SplitSection[]): string[] {
  const failures: string[] = [];
  if (sections.length === 0) failures.push("no split was run");
  for (const section of sections) {
    if (section.metrics === null || section.completedRepeats === 0) {
      failures.push(`split ${section.split}: no repeat finished`);
      continue;
    }
    for (const m of section.metrics.repeats) {
      const at = `split ${section.split} repeat ${m.repeat}`;
      const perfect = (name: string, rate: Rate): void => {
        if (rate.denominator > 0 && rate.numerator !== rate.denominator) {
          failures.push(`${at}: ${name} is ${rate.numerator} of ${rate.denominator}, not all`);
        }
      };
      const none = (name: string, rate: Rate): void => {
        if (rate.numerator !== 0) {
          failures.push(`${at}: ${name} is ${rate.numerator} of ${rate.denominator}, not none`);
        }
      };
      perfect("status accuracy", m.statusAccuracy);
      perfect("strict issue recall", m.issues.recallStrict);
      perfect("strict issue precision", m.issues.precisionStrict);
      perfect("required escalation recall", m.escalation.requiredRecall);
      perfect("extraction span recall", m.extraction.recall);
      perfect("extraction span precision", m.extraction.precision);
      perfect("model citation validity", m.citations.model);
      perfect("displayed citation validity", m.citations.displayed);
      perfect("substantive support", m.support.substantive);
      none("unnecessary escalation rate", m.escalation.unnecessaryRate);
      none("injection effect", m.injection.effect);
      if (m.silentMisses.total !== 0) {
        failures.push(`${at}: ${m.silentMisses.total} silent misses, not none`);
      }
      if (m.support.verifiedButUnsupported.count !== 0) {
        failures.push(
          `${at}: ${m.support.verifiedButUnsupported.count} verified but unsupported findings, not none`,
        );
      }
      if (m.slotScores.some((s) => s.failure !== null)) {
        failures.push(
          `${at}: ${m.slotScores.filter((s) => s.failure !== null).length} slots have a failure`,
        );
      }
    }
  }
  return failures;
}
