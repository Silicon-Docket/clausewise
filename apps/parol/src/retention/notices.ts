import { AUDIT_BREAK_TEXT, type AuditBreak, type Repository } from "../store/index.js";

/**
 * The start-up notices about retention (package W2.7, slice D): a warning when the audit log does
 * not verify, and a notice when matters are past their retention date. Both are advice to the
 * operator, printed once, where the server prints its other start-up lines.
 *
 * What the lines may hold: counts with the number they are counted out of, the number of one audit
 * event, one of the fixed reason codes the store uses for a break in the chain (with the fixed words
 * `AUDIT_BREAK_TEXT` gives for it), and the names of the two commands. They never hold a matter's
 * name, its client, an id, a title, a document's text or the message of an error: a start-up line
 * goes to a terminal or a log file that deleting a matter does not reach.
 *
 * What this does not do: it deletes nothing, changes nothing and appends no audit event. It only
 * reads, so `RetentionNoticeDeps.repo` names the three reads it uses and nothing else. And it never
 * stops the server from starting: advice that cannot be given is replaced by a fixed line that says
 * so, because a start that fails over a notice would keep the operator from the very command the
 * notice points to.
 *
 * Contract commit CC1: `main.ts` calls this once, after the orphan sweep, and is not edited again
 * for it.
 */
export interface RetentionNoticeDeps {
  /** Only the reads this module uses, so that it cannot write. `main.ts` passes the repository. */
  repo: Pick<Repository, "verifyAuditChain" | "listExpiredMatters" | "listMatterIds">;
  /** The clock, for the retention dates. */
  now: () => Date;
  /** One line to the operator, as `start` prints its other start-up notices. */
  notice: (line: string) => void;
}

const matters = (n: number): string => `${n} ${n === 1 ? "matter" : "matters"}`;

/** The warning for a chain that breaks at event `seq`, after `checked` events that held. */
function chainBroken(seq: number, reason: AuditBreak, checked: number): string {
  return (
    `warning: the audit log does not verify. It breaks at event ${seq} (${reason}: ` +
    `${AUDIT_BREAK_TEXT[reason]}). Events before it that check out: ${checked}. ` +
    `Nothing after event ${seq} can be trusted. Run pnpm parol:audit-verify.`
  );
}

/** The notice for `past` matters past their date, out of `total` matters in the database. */
function mattersPast(past: number, total: number): string {
  return (
    `notice: ${past} of ${matters(total)} ${past === 1 ? "is" : "are"} past ` +
    `${past === 1 ? "its" : "their"} retention date. The server deletes nothing. ` +
    `Run pnpm parol:retain to see ${past === 1 ? "it" : "them"}.`
  );
}

/** The line about the audit chain, or null when the chain verifies. */
function chainLine(repo: RetentionNoticeDeps["repo"]): string | null {
  try {
    const chain = repo.verifyAuditChain();
    return chain.ok ? null : chainBroken(chain.firstBrokenSeq, chain.reason, chain.events);
  } catch {
    // The reason is not repeated: an error from the database can carry what it was reading.
    return "warning: the audit log could not be checked at start-up. Run pnpm parol:audit-verify.";
  }
}

/** The line about matters past their date, or null when none is. */
function pastLine(repo: RetentionNoticeDeps["repo"], now: () => Date): string | null {
  try {
    const past = repo.listExpiredMatters(now()).length;
    return past > 0 ? mattersPast(past, repo.listMatterIds().length) : null;
  } catch {
    return (
      "warning: the matters past their retention date could not be counted at start-up. " +
      "Run pnpm parol:retain to see them."
    );
  }
}

export function reportRetentionNotices(deps: RetentionNoticeDeps): void {
  const { repo, now, notice } = deps;
  const lines = [chainLine(repo), pastLine(repo, now)];
  for (const line of lines) if (line !== null) notice(line);
}
