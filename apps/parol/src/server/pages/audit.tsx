import type { AuditPageView } from "../../services/views.js";
import { urls } from "../urls.js";
import { plural } from "../views/format.js";
import { Chip, Section, Time } from "./components.js";
import { Layout, type Chrome } from "./layout.js";

/**
 * The audit log check (package W2.7, slice C): `GET /audit`, for an administrator. It runs the
 * check of the log's hash chain each time it is opened and shows the result in words, with the
 * matters set against the events that account for them and the last run of the retention command.
 * It does not store a result, offers no control that changes anything, and renders nothing that
 * came out of a row: the service (services/audit.ts) hands over counts, ids of the form the
 * application issues, one hash, and words chosen from fixed lists, and this page adds fixed
 * sentences. A broken chain is a result, shown in words; it is not an error page.
 *
 * Every count is shown with the number it is part of ("12 of 12 events", "2 of 7 matters").
 */

export interface AuditPageProps {
  chrome: Chrome;
  view: AuditPageView;
}

/** What the job's compaction step ended with, in words. A closed list: any other word is "unknown". */
const COMPACTION_WORDS: Record<string, string> = {
  done: "done",
  not_needed: "not needed",
  failed: "failed",
  not_run: "not run",
};

function ChainSection({ view }: { view: AuditPageView }) {
  const { chain, eventsInLog, head } = view;
  return (
    <Section
      id="audit-chain"
      title="Chain of events"
      note="Each event holds a hash of its own content and of the event before it, so an event that was changed, removed or put in afterwards breaks the chain."
    >
      {chain.ok ? (
        <p>
          <Chip tone="ok" shape="circle">
            Intact
          </Chip>{" "}
          {eventsInLog === 0
            ? "The log has no events yet."
            : `Events checked: ${chain.events} of ${eventsInLog} in the log. Each event's hash matches its content and the event before it.`}
        </p>
      ) : (
        <p>
          <Chip tone="bad" shape="triangle">
            Broken
          </Chip>{" "}
          {`The chain breaks at event ${chain.firstBrokenSeq}: ${chain.reasonText} (${chain.reason}). Events that check out before it: ${chain.events} of ${eventsInLog} in the log. Nothing from event ${chain.firstBrokenSeq} on can be trusted.`}
        </p>
      )}
      {head === null ? (
        <p class="empty">The log has no events, so it has no newest event to keep.</p>
      ) : (
        <>
          <dl class="facts">
            <dt>Newest event</dt>
            <dd>{`Event ${head.seq}`}</dd>
            <dt>Its hash</dt>
            <dd>
              {head.hash === null ? (
                "The value stored is not in the form of a hash."
              ) : (
                <code class="hash">{head.hash}</code>
              )}
            </dd>
          </dl>
          <p class="hint">
            Keep these two lines somewhere that nobody who can write to the database can edit, and
            check the log against them with{" "}
            <code>pnpm parol:audit-verify --expect-head SEQ:HASH</code>.
          </p>
        </>
      )}
    </Section>
  );
}

/** A heading and the matters of one kind of mismatch, by id, with how many more there are. */
function MatterIds(props: {
  id: string;
  title: string;
  list: AuditPageView["matters"]["goneWithoutDeleteEvent"];
}) {
  const { list } = props;
  if (list.count === 0) return null;
  const more = list.count - list.ids.length;
  return (
    <>
      <h3 id={props.id}>{props.title}</h3>
      {list.ids.length === 0 ? null : (
        <ul aria-labelledby={props.id}>
          {list.ids.map((id) => (
            <li>
              <code>{id}</code>
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? <p class="hint">{`and ${more} more, not listed here.`}</p> : null}
    </>
  );
}

function MattersSection({ view }: { view: AuditPageView }) {
  const { matters } = view;
  const { created, present } = matters;
  const unaccounted =
    matters.goneWithoutDeleteEvent.count +
    matters.presentWithoutCreateEvent.count +
    matters.deletedButPresent.count;
  return (
    <Section
      id="audit-matters"
      title="Matters and their events"
      note="Every matter that was created has a creation event, and every matter that was deleted has a deletion event. This compares the events with the matters in the database."
    >
      <dl class="facts">
        <dt>In the database</dt>
        <dd>{plural(present, "matter")}</dd>
        <dt>Created</dt>
        <dd>{`${plural(created, "matter")} with a creation event`}</dd>
        <dt>Deleted</dt>
        <dd>{`${matters.deleted} of ${created} created, with a deletion event`}</dd>
        <dt>Gone, no deletion event</dt>
        <dd>{`${matters.goneWithoutDeleteEvent.count} of ${created} created`}</dd>
        <dt>Present, no creation event</dt>
        <dd>{`${matters.presentWithoutCreateEvent.count} of ${present} in the database`}</dd>
        <dt>Present, but deleted</dt>
        <dd>{`${matters.deletedButPresent.count} of ${present} in the database`}</dd>
      </dl>
      {unaccounted === 0 ? (
        <p>
          <Chip tone="ok" shape="circle">
            All accounted for
          </Chip>{" "}
          No matter is missing a creation or a deletion event.
        </p>
      ) : (
        <>
          <p>
            <Chip tone="bad" shape="triangle">
              Not accounted for
            </Chip>{" "}
            The events do not explain these matters. A matter removed or put in by something other
            than the application would look like this.
          </p>
          <MatterIds
            id="audit-gone"
            title="Gone, with no deletion event"
            list={matters.goneWithoutDeleteEvent}
          />
          <MatterIds
            id="audit-no-create"
            title="Present, with no creation event"
            list={matters.presentWithoutCreateEvent}
          />
          <MatterIds
            id="audit-deleted-present"
            title="Present, although a deletion event names them"
            list={matters.deletedButPresent}
          />
        </>
      )}
    </Section>
  );
}

function RetentionSection({ view }: { view: AuditPageView }) {
  const { retention } = view;
  const run = retention.lastRun;
  return (
    <Section id="audit-retention" title="Retention">
      <p>
        {`${retention.pastDate} of ${plural(retention.totalMatters, "matter")} ${retention.pastDate === 1 ? "is" : "are"} past their retention date. Nothing deletes them until the operator runs the retention command.`}
      </p>
      {run !== null ? (
        <>
          <p>
            {`Last retention run: event ${run.seq}, `}
            <Time value={run.at} />
            {`. Of ${plural(run.expired, "matter")} past their date, ${run.deleted} deleted, ${run.skipped} skipped, ${run.failed} failed.`}
          </p>
          <p>
            {`Folders that no matter named: ${run.orphansRemoved} of ${run.orphansRemoved + run.orphansFailed} removed. Compaction of the database: ${COMPACTION_WORDS[run.compaction] ?? "unknown"}.`}
          </p>
          {run.refused ? (
            <p>
              That run refused to delete anything: more matters were past their date than its limit
              allows.
            </p>
          ) : null}
        </>
      ) : retention.lastRunUnreadable ? (
        <p>
          <Chip tone="warn" shape="diamond">
            Not readable
          </Chip>{" "}
          The log holds a retention run, but its details are not in the form the retention command
          writes, so they are not shown here.
        </p>
      ) : (
        <p class="empty">
          No retention run is recorded. The operator runs <code>pnpm parol:retain</code>.
        </p>
      )}
    </Section>
  );
}

function LimitsSection() {
  return (
    <Section id="audit-limits" title="What this check does not show">
      <ul>
        <li>
          The log is in the same file as the rest of the data. Each hash is not keyed, so someone
          who can write that file and recompute every later hash makes a log that passes this check.
        </li>
        <li>
          The number of the newest event is kept in that file too, so a log cut back to an earlier
          event can be made to look whole.
        </li>
        <li>
          A head kept elsewhere closes both for the history up to the event it names, and for
          nothing after it.
        </li>
        <li>
          The log records changes. It does not record who read a page, and it does not record a
          request that was refused: a refusal is a line in the access log, which goes to standard
          output and is not stored.
        </li>
      </ul>
    </Section>
  );
}

export function AuditPage({ chrome, view }: AuditPageProps) {
  return (
    <Layout title="Audit log check" chrome={chrome}>
      <h1>Audit log check</h1>
      <p class="hint">
        Demonstration data. Only an administrator can open this page. It checks the log when it is
        opened, at <Time value={view.checkedAt} />, and does not store the result.
      </p>
      <ChainSection view={view} />
      <MattersSection view={view} />
      <RetentionSection view={view} />
      <LimitsSection />
      <p>
        <a href={urls.audit()}>Check again</a>
      </p>
    </Layout>
  );
}
