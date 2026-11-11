import type { MatterSummary, PlaybookOption, UserOption } from "../../services/views.js";
import { urls } from "../urls.js";
import {
  Chip,
  Field,
  MatterStatusChip,
  RevealedText,
  ScrollBox,
  Section,
  Time,
} from "./components.js";
import { FIELDS } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";
import { formatDate, plural } from "../views/format.js";
import { globalRoleLabel, matterRoleLabel } from "../views/labels.js";
import { FORM_RETAIN_DEFAULT_DAYS, FORM_RETAIN_MAX_DAYS } from "../views/retention.js";
import { revealToString } from "../views/reveal.js";

export interface MattersPageProps {
  chrome: Chrome;
  matters: MatterSummary[];
  /** Approved playbook versions a new matter can pin. */
  playbooks: PlaybookOption[];
  /** Demo identities, for the reviewer picker. */
  users: UserOption[];
}

export function NewMatterForm(props: {
  chrome: Chrome;
  playbooks: PlaybookOption[];
  users: UserOption[];
}) {
  return (
    <form method="post" action={urls.matters()} class="stack form-panel">
      {csrfField(props.chrome.csrfToken)}
      <Field id="new-matter-name" label="Matter name">
        <input
          id="new-matter-name"
          name={FIELDS.name}
          type="text"
          required
          maxlength={200}
          autocomplete="off"
        />
      </Field>
      <Field
        id="new-matter-client"
        label="Our client"
        hint="The exact legal name, as it should appear in the agreement. Parol checks the parties clause against it."
      >
        <input
          id="new-matter-client"
          name={FIELDS.clientLegalName}
          type="text"
          required
          maxlength={300}
          autocomplete="off"
          aria-describedby="new-matter-client-hint"
        />
      </Field>
      <Field
        id="new-matter-reviewer"
        label="Reviewing attorney"
        hint="The person who will decide each finding and export the memo. You can add or change reviewers later."
      >
        <select
          id="new-matter-reviewer"
          name={FIELDS.reviewerUserId}
          aria-describedby="new-matter-reviewer-hint"
        >
          <option value="">Choose later</option>
          {props.users.map((user) => (
            <option value={user.userId}>
              {revealToString(user.displayName)} ({globalRoleLabel(user.globalRole)})
            </option>
          ))}
        </select>
      </Field>
      <Field id="new-matter-playbook" label="Playbook">
        <select id="new-matter-playbook" name={FIELDS.playbookVersionId}>
          <option value="">Choose later</option>
          {props.playbooks.map((playbook) => (
            <option value={playbook.versionId}>
              {revealToString(`${playbook.name} ${playbook.version}`)}, approved{" "}
              {formatDate(playbook.approvedAt)}, {plural(playbook.ruleCount, "rule")}
            </option>
          ))}
        </select>
      </Field>
      <div id="retention">
        <Field
          id="new-matter-retain"
          label="Keep for (days)"
          hint="After this many days the matter can be deleted by the retention command. You can change it later on the matter's page."
        >
          <input
            id="new-matter-retain"
            name={FIELDS.retainDays}
            type="number"
            inputmode="numeric"
            min={1}
            max={FORM_RETAIN_MAX_DAYS}
            value={FORM_RETAIN_DEFAULT_DAYS}
            required
            autocomplete="off"
            aria-describedby="new-matter-retain-hint"
          />
        </Field>
      </div>
      <div class="actions">
        <button type="submit" class="button button-primary">
          Create matter
        </button>
      </div>
    </form>
  );
}

export function MattersPage(props: MattersPageProps) {
  const { chrome, matters } = props;
  return (
    <Layout title="Matters" chrome={chrome}>
      <h1>Matters</h1>
      <p class="lead">
        New to Parol? <a href={urls.quickstart()}>Read the quickstart</a>.
      </p>
      <Section
        id="matter-list"
        title="Your matters"
        note="Only matters you are a member of are listed."
      >
        {matters.length === 0 ? (
          <p class="empty">You have no matters yet. Start one below.</p>
        ) : (
          <ScrollBox label="Matters">
            <table class="data-table">
              <caption class="sr-only">Your matters</caption>
              <thead>
                <tr>
                  <th scope="col">Matter</th>
                  <th scope="col">Client</th>
                  <th scope="col">Status</th>
                  <th scope="col">Your role</th>
                  <th scope="col">Playbook</th>
                  <th scope="col">Created</th>
                  <th scope="col">Kept until</th>
                </tr>
              </thead>
              <tbody>
                {matters.map((matter) => (
                  <tr>
                    <th scope="row">
                      <a href={urls.matter(matter.id)}>
                        <RevealedText value={matter.name} />
                      </a>
                      {matter.synthetic ? null : (
                        <>
                          {" "}
                          <Chip tone="warn" shape="triangle">
                            Not marked synthetic
                          </Chip>
                        </>
                      )}
                      {matter.training === undefined || matter.training === null ? null : (
                        <>
                          {" "}
                          <Chip tone="info" shape="square">
                            Training
                          </Chip>
                        </>
                      )}
                    </th>
                    <td>
                      <RevealedText value={matter.clientLegalName} />
                    </td>
                    <td>
                      <MatterStatusChip status={matter.status} />
                    </td>
                    <td>{matterRoleLabel(matter.role)}</td>
                    <td>
                      {matter.playbook === null ? (
                        "None chosen"
                      ) : (
                        <RevealedText
                          value={`${matter.playbook.slug} ${matter.playbook.version}`}
                        />
                      )}
                    </td>
                    <td>
                      <Time value={matter.createdAt} />
                    </td>
                    <td>
                      {formatDate(matter.retainUntil)}
                      {matter.pastRetention === true ? (
                        <>
                          {" "}
                          <Chip tone="warn" shape="triangle">
                            Past
                          </Chip>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollBox>
        )}
      </Section>
      <Section
        id="new-matter"
        title="New matter"
        note="You become the associate on the matter. Upload the documents on the next page."
      >
        <NewMatterForm chrome={chrome} playbooks={props.playbooks} users={props.users} />
      </Section>
    </Layout>
  );
}
