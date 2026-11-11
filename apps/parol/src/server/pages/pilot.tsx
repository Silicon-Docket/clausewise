import { globalRoleAllows } from "../../auth/actions.js";
import type { PilotAdminView, PilotMeasuresView, PilotTableView } from "../../services/views.js";
import { urls } from "../urls.js";
import { Chip, Field, RevealedText, ScrollBox, Section, Time, idPart } from "./components.js";
import { FIELDS } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";
import { PILOT_ANCHORS, TRAINED_VALUE, trainedField } from "./pilotfields.js";

/**
 * The pilot measures page (package W2.6b): `GET /pilot`, for the legal engineer and an
 * administrator. The service hands over everything the page prints that comes from the measures,
 * as strings and data (`PilotMeasuresView`): the numbers with their denominators, the sentences,
 * the captions. This page lays them out and adds only its headings and the labels of its two forms.
 * It computes nothing, reads no clock, and states no number of its own.
 *
 * The first thing a reader meets is the scope. The pilot scope is the default and is empty on every
 * database this build can make (every person is a demonstration identity); the synthetic scope
 * shows what the same code does with demonstration events, under a banner, in the title and in the
 * caption of every table, so a picture of one table still says which scope it counts.
 *
 * The two forms (the first day of the pilot, and the roster of people the trainer says were
 * trained) are shown to the people who may change them. A form that was refused is shown again
 * with what was typed or ticked (`draft`). Every control is a native one with a label, in reading
 * order, and the page uses no script.
 */

/** What was typed or ticked in a form that was refused, to show it again. */
export interface PilotDraft {
  /** The text of the date field. */
  startDate?: string | undefined;
  /** The user ids that were ticked. */
  trained?: readonly string[] | undefined;
}

export interface PilotPageProps {
  chrome: Chrome;
  view: PilotMeasuresView;
  admin: PilotAdminView;
  draft?: PilotDraft | undefined;
}

function ScopeSection({ view }: { view: PilotMeasuresView }) {
  return (
    <Section id="scope" title="Which scope is shown">
      <nav aria-label="Scope">
        <ul class="scope-switch">
          {view.scopeLinks.map((link) => (
            <li>
              <a href={urls.pilot(link.scope)} aria-current={link.current ? "page" : undefined}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {view.banner === null ? null : (
        <p class="banner banner-synthetic" role="note">
          <strong>{view.banner}</strong>
        </p>
      )}
      {view.emptyNote === null ? null : <p>{view.emptyNote}</p>}
    </Section>
  );
}

function CalendarSection(props: {
  chrome: Chrome;
  view: PilotMeasuresView;
  admin: PilotAdminView;
  draft?: PilotDraft | undefined;
}) {
  const { chrome, view, admin, draft } = props;
  const canManage =
    chrome.globalRole !== undefined && globalRoleAllows(chrome.globalRole, "pilot.manage");
  const typed = draft?.startDate ?? admin.calendar?.startDate ?? "";
  return (
    <Section id="calendar" title="Pilot calendar">
      <p>{view.calendarSentence}</p>
      {admin.calendar === null ? null : (
        <p class="hint">
          {`The start date has been set ${admin.calendar.timesSet} ${admin.calendar.timesSet === 1 ? "time" : "times"}; the latest was saved at `}
          <Time value={admin.calendar.setAt} />
          {". Every date that was set is kept."}
        </p>
      )}
      {canManage ? (
        <form method="post" action={urls.pilotCalendar()} class="stack form-panel">
          {csrfField(chrome.csrfToken)}
          <Field
            id={PILOT_ANCHORS.startDate}
            label="First day of the pilot"
            hint="Week 1 starts at midnight UTC on this day. The five weeks are counted from it."
          >
            <input
              id={PILOT_ANCHORS.startDate}
              name={FIELDS.startDate}
              type="date"
              required
              autocomplete="off"
              value={typed}
              aria-describedby={`${PILOT_ANCHORS.startDate}-hint`}
            />
          </Field>
          <div class="actions">
            <button type="submit" class="button button-primary">
              Save the start date
            </button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

function ParticipantsSection(props: {
  chrome: Chrome;
  admin: PilotAdminView;
  draft?: PilotDraft | undefined;
}) {
  const { chrome, admin, draft } = props;
  const canManage =
    chrome.globalRole !== undefined && globalRoleAllows(chrome.globalRole, "pilot.manage");
  const ticked = new Set(
    draft?.trained ?? admin.participants.filter((p) => p.trained).map((p) => p.userId),
  );
  return (
    <Section
      id={PILOT_ANCHORS.participants}
      title="People who were trained"
      note="The list is a record that the trainer made. It is not worked out from use."
    >
      {canManage ? (
        <form method="post" action={urls.pilotParticipants()} class="stack form-panel">
          {csrfField(chrome.csrfToken)}
          <fieldset>
            <legend>People who completed the training</legend>
            {admin.participants.map((person) => {
              const id = idPart(`trained-${person.userId}`);
              return (
                <p class="choice">
                  <input
                    id={id}
                    type="checkbox"
                    name={trainedField(person.userId)}
                    value={TRAINED_VALUE}
                    checked={ticked.has(person.userId)}
                  />{" "}
                  <label for={id}>
                    <RevealedText value={person.name} />
                  </label>
                  {person.completedTraining === true
                    ? " (completed steps 3 to 7 of the training matter)"
                    : null}
                </p>
              );
            })}
          </fieldset>
          <div class="actions">
            <button type="submit" class="button button-primary">
              Save who was trained
            </button>
          </div>
        </form>
      ) : (
        <p>{`${admin.participants.filter((p) => p.trained).length} of ${admin.participants.length} people are recorded as trained.`}</p>
      )}
    </Section>
  );
}

function MeasureTable({ table }: { table: PilotTableView }) {
  // The measures table has a Note column that says why a row has no data; the others say it under
  // the chip.
  const reasonUnderChip = table.id !== "measures";
  return (
    <>
      <ScrollBox label={table.caption} id={`table-${table.id}`}>
        <table class="data-table">
          <caption>{table.caption}</caption>
          <thead>
            <tr>
              {table.columns.map((name) => (
                <th scope="col">{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr>
                <th scope="row">
                  {row.header}
                  {row.detail === null ? null : <p class="hint">{row.detail}</p>}
                </th>
                {row.cells.map((cell) => (
                  <td>
                    {cell.noData ? (
                      <>
                        <Chip tone="neutral" shape="ring">
                          {cell.text}
                        </Chip>
                        {reasonUnderChip && cell.reason !== null ? (
                          <p class="measure-no-data">{cell.reason}</p>
                        ) : null}
                      </>
                    ) : (
                      cell.text
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
    </>
  );
}

function MeasuresSection({ view }: { view: PilotMeasuresView }) {
  const [first, ...rest] = view.tables;
  return (
    <>
      <Section id="measures" title="Measures">
        {first === undefined ? null : <MeasureTable table={first} />}
      </Section>
      <Section id="breakdowns" title="Breakdowns">
        {rest.map((table) => (
          <MeasureTable table={table} />
        ))}
      </Section>
    </>
  );
}

function PopulationSection({ view }: { view: PilotMeasuresView }) {
  return (
    <Section
      id="population"
      title="What the measures count"
      note="These are the denominators and the exclusions, so that no number is without its context."
    >
      {view.expiringNote === null ? null : <p role="status">{view.expiringNote}</p>}
      <ScrollBox label={`Population of the measures, ${view.phrases.scopeNames[view.scope]}`}>
        <table class="data-table">
          <caption>{`Population of the measures, ${view.phrases.scopeNames[view.scope]}`}</caption>
          <thead>
            <tr>
              <th scope="col">What is counted</th>
              <th scope="col">Count</th>
            </tr>
          </thead>
          <tbody>
            {view.population.map((line) => (
              <tr>
                <th scope="row">{line.sentence}</th>
                <td>{String(line.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollBox>
    </Section>
  );
}

export function PilotPage({ chrome, view, admin, draft }: PilotPageProps) {
  return (
    <Layout title={view.title} chrome={chrome} wide>
      <h1>Pilot measures</h1>
      <ScopeSection view={view} />
      <CalendarSection chrome={chrome} view={view} admin={admin} draft={draft} />
      <ParticipantsSection chrome={chrome} admin={admin} draft={draft} />
      <MeasuresSection view={view} />
      <PopulationSection view={view} />
      <Section id="method" title="How to read this page">
        <ul>
          {view.method.map((line) => (
            <li>{line}</li>
          ))}
        </ul>
      </Section>
      <Section id="download" title="Download">
        <p>
          <a href={urls.pilotCsv(view.download.scope)}>{view.download.label}</a>
        </p>
      </Section>
    </Layout>
  );
}
