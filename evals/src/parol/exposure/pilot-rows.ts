/**
 * Fills the two tables that the pilot measures added (package W2.6b), `time_entries` and
 * `reference_issues`, for a matter of the exposure suite, the way people do: through the real
 * service, as the roles the application gives the actions.
 *
 * Why the suite does it. The canary scan reads every table that holds matter data (`STORE_SCOPES`)
 * for the matter of each side, and a table that is empty on both sides could never show a leak: a
 * route that dumped every timer or every reference list of the store to a reader would carry the
 * other matter's id only if the other matter had a row in it. A review fills most of the tables by
 * itself. A timer and a reference list are written by hand, so the suite writes one of each for the
 * matter of the case and for each canary matter, which are the two sides of the scan.
 *
 *  - The reviewer saves a reference list: one issue for the first rule of the matter's pinned
 *    playbook, and one issue that no rule covers. It has to be done before a review is started,
 *    because the list is closed by the first run (the application and the database both hold that).
 *  - The associate presses Start and Stop once: a closed timer.
 *
 * Neither table holds text (a timer is a role and two times, a reference issue a rule key and a
 * severity), so nothing here puts a document, a note or a canary string anywhere. What it writes
 * is the application's own data for the matter: ids, a role, a rule key, a severity and the
 * site's clock.
 *
 * A control follows: the matter's rows in both tables must be there, or the scan could not see a
 * leak of them, and the suite stops (`ExposureControlFailure`, exit code 2) like any other control.
 */
import { EvalError } from "../../errors.js";
import { ExposureControlFailure } from "./errors.js";
import type { ExposureSite } from "./site.js";

/** The people of a matter who write the two kinds of row. */
export interface PilotRowPeople {
  /** Holds the role `associate` on the matter: runs the timer. */
  associate: string;
  /** Holds the role `reviewer` on the matter: saves the reference list. */
  reviewer: string;
}

/** What the suite wrote for one matter, as counts. */
export interface PilotRowsWritten {
  /** Closed timers of the matter. */
  timers: number;
  /** Issues of its reference list, rule slots and issues no rule covers together. */
  referenceIssues: number;
}

/** The step that failed, never the message of the failure: a store error is not for a log line. */
const step = (what: string, error: unknown): EvalError => {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
      ? ` (${(error as { code: string }).code})`
      : "";
  return new EvalError(`The exposure suite could not ${what}${code}.`);
};

const count = (site: ExposureSite, table: string, matterId: string): number =>
  (
    site.repo.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE matter_id = ?`)
      .get(matterId) as {
      n: number;
    }
  ).n;

/**
 * Saves a reference list as the reviewer and runs one timer as the associate, on a matter that has
 * not been reviewed. Returns what is now in the matter's two tables.
 */
export function recordPilotRows(args: {
  site: ExposureSite;
  matterId: string;
  people: PilotRowPeople;
}): PilotRowsWritten {
  const { site, matterId, people } = args;

  const rule = site.repo.listRules(site.playbookVersionId)[0];
  if (rule === undefined)
    throw new ExposureControlFailure(
      "The playbook of the exposure site has no rule, so a reference list could not be saved.",
    );
  try {
    const writer = site.authorize(people.reviewer, matterId, "reference.write");
    site.services.pilot.saveReferenceList(writer, {
      rules: [{ ruleKey: rule.key, severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 1,
    });
  } catch (error) {
    throw step("save a reference list", error);
  }
  try {
    const timer = site.authorize(people.associate, matterId, "time.record");
    site.services.pilot.startTimer(timer);
    site.services.pilot.stopTimer(timer);
  } catch (error) {
    throw step("run a timer", error);
  }

  const written: PilotRowsWritten = {
    timers: (
      site.repo.db
        .prepare(
          "SELECT COUNT(*) AS n FROM time_entries WHERE matter_id = ? AND stopped_at IS NOT NULL",
        )
        .get(matterId) as { n: number }
    ).n,
    referenceIssues: count(site, "reference_issues", matterId),
  };
  if (written.timers === 0 || written.referenceIssues === 0)
    throw new ExposureControlFailure(
      "A matter of the exposure suite has no timer or no reference list after the suite wrote them, so a scan of those tables could not see a leak.",
    );
  return written;
}
