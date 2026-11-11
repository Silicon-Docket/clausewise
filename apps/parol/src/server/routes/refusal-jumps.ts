import type { Context } from "hono";
import { render, type Notice } from "../pages/layout.js";
import type { Refusal } from "./notices.js";
import { sendPage } from "./shared.js";

/**
 * The link of a refusal to the control that is wrong, kept only where that control is on the page.
 *
 * A refusal of a form carries a `jump` to one control of it (`#decision-reason-code`,
 * `#missed-issue-rule`, `#note-text`, `#rating-choice`). The parsers and the store check a form's
 * fields before the state of the thing it is about, so a refusal for a field can be answered on a
 * page that has no such form: a decision posted for a finding that has since gone out of date or
 * whose matter was exported, a report posted for a review that has no findings or is still running,
 * a note or a rating posted by hand. That page shows a sentence in place of the form, and a link to
 * a control that is not there leads nowhere. The words and the todo of the refusal are still right,
 * so only the link goes.
 *
 * The check is made against the page that was built and not against the conditions that decide
 * whether its form is shown, so it cannot drift from them: if the form is ever shown under other
 * conditions, the link follows it.
 *
 * Every page that answers a refusal is built through it: the matter's page too, whose links lead to
 * its documents, its people and its reviews (always there) and to the timer and the reference list
 * (there for some roles, some states and not for a training matter). One mechanism decides, for all
 * of them, whether the place a link names is on the page that was built.
 */

/** The notice as it is, without its link to a place on the page. */
export function withoutJump(notice: Notice): Notice {
  const { jump: _jump, ...rest } = notice;
  return rest;
}

/**
 * Whether the page has an element with this id. A page is built by the application, which writes
 * each attribute in double quotes and escapes a quote in a value, so the id is found only where it
 * is an attribute of its own: not in text, not in `data-id` and not as part of a longer id.
 */
function hasId(html: string, id: string): boolean {
  return html.includes(` id="${id}"`);
}

/**
 * Builds the page that answers `refusal` (or the page a GET shows, with none) and returns it as
 * HTML. When the notice links to a control that the page does not have, the page is built again with
 * the same notice less its link. `build` must only put the page together from what the caller has
 * already read, because it can be called twice.
 */
export function pageWithLiveJump(
  refusal: Refusal | undefined,
  build: (shown: Refusal | undefined) => { toString(): string | Promise<string> },
): string {
  const page = render(build(refusal));
  const jump = refusal?.notice.jump;
  if (refusal === undefined || jump === undefined || hasId(page, jump.href.slice(1))) return page;
  return render(build({ ...refusal, notice: withoutJump(refusal.notice) }));
}

/**
 * `pageWithLiveJump`, sent: with the status of the refusal, or 200 for the page a GET shows.
 */
export function sendPageWithLiveJump(
  c: Context,
  refusal: Refusal | undefined,
  build: (shown: Refusal | undefined) => { toString(): string | Promise<string> },
): Response {
  return sendPage(c, pageWithLiveJump(refusal, build), refusal?.status);
}
