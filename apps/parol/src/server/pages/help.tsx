import type { FindingView, IssueRow } from "../../services/views.js";
import { urls } from "../urls.js";
import { contextHelp, helpGroups, wordsInRun, type HelpGroup } from "../views/help.js";
import { Section } from "./components.js";
import { Layout, type Chrome } from "./layout.js";

/**
 * In-app help for the words the review uses (package W2.8): the help page, and two `<details>`
 * disclosures that sit inside the run page and the finding pane. All three hold fixed text taken
 * from the same tables the chips use (`views/help.ts`), so a word is explained where it is shown,
 * and a keyboard or touch user gets the same words as one who can hover a chip. Nothing here is
 * script: a disclosure opens with Enter or Space on its summary, and the `?` key of the review page
 * still opens the keyboard list only.
 *
 * The host pages (`run.tsx`, `finding.tsx`) call `WordsHelp` and `ContextHelp`; they belong to
 * W2.6a from phase 2 on, so this file is the one place the help is changed. The file name is
 * letters only because a page may import another page only by such a name (the static test).
 */

/** A list of terms and what they mean. `anchors` gives each term the id the help page links to. */
function TermList({ terms, anchors }: { terms: HelpGroup["terms"]; anchors: boolean }) {
  return (
    <dl class="help-terms">
      {terms.map((term) => (
        <>
          <dt id={anchors ? term.id : undefined}>{term.term}</dt>
          <dd>{term.meaning}</dd>
        </>
      ))}
    </dl>
  );
}

export interface HelpPageProps {
  chrome: Chrome;
  /** The groups to show. Default: all of them, from `helpGroups()`. */
  groups?: readonly HelpGroup[] | undefined;
}

/**
 * The whole vocabulary on one page, open to everyone. A list of the topics comes first, then one
 * section per group, each term with an anchor so that a link can lead to it. No form, no script.
 */
export function HelpPage(props: HelpPageProps) {
  const groups = props.groups ?? helpGroups();
  return (
    <Layout title="Help" chrome={props.chrome}>
      <h1>Help</h1>
      <p class="lead">
        What the words on the review page mean. Each one is the sentence the page itself uses where
        the word is shown, so nothing here is new, and nothing depends on hovering a chip.
      </p>
      <nav aria-label="Help topics" class="help-topics">
        <ul class="nav-list">
          {groups.map((group) => (
            <li>
              <a href={urls.help(group.id)}>{group.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      {groups.map((group) => (
        <Section id={group.id} title={group.title} note={group.intro}>
          <TermList terms={group.terms} anchors />
        </Section>
      ))}
      <p>
        <a href={urls.quickstart()}>Back to the quickstart</a>
      </p>
    </Layout>
  );
}

export interface WordsHelpProps {
  /** Every issue row of the run, so the help lists the flags this run carries and no others. */
  rows: readonly IssueRow[];
}

/**
 * "What the words mean", on the run page after the keyboard list: the statuses, severities and
 * passage roles, the flags this review carries, and a link to all of them. It is not the keyboard
 * list and has no `data-keys-help`, so the `?` key still opens only that list.
 */
export function WordsHelp(props: WordsHelpProps) {
  const groups = wordsInRun(props.rows);
  return (
    <details class="disclosure words-help" id="words-help">
      <summary>What the words mean</summary>
      {groups.map((group) => (
        <>
          <p>
            <strong>{group.title}</strong>
          </p>
          <TermList terms={group.terms} anchors={false} />
        </>
      ))}
      <p>
        <a href={urls.help()}>All the words</a>
      </p>
    </details>
  );
}

export interface ContextHelpProps {
  finding: FindingView;
}

/**
 * "What these words mean for this finding", in the finding pane before the evidence: only the
 * words this finding shows, each linked to its place on the help page. A finding that shows nothing
 * it has a word for gets no disclosure.
 */
export function ContextHelp(props: ContextHelpProps) {
  const groups = contextHelp(props.finding);
  if (groups.length === 0) return null;
  return (
    <details class="disclosure context-help">
      <summary>What these words mean for this finding</summary>
      {groups.map((group) => (
        <>
          <p>
            <strong>{group.title}</strong>
          </p>
          <dl class="help-terms">
            {group.terms.map((term) => (
              <>
                <dt>
                  <a href={urls.help(term.id)}>{term.term}</a>
                </dt>
                <dd>{term.meaning}</dd>
              </>
            ))}
          </dl>
        </>
      ))}
    </details>
  );
}
