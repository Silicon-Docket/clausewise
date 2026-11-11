import { guidanceFor, type GuidanceKey } from "../guidance.js";
import { urls } from "../urls.js";
import { TodoText } from "./components.js";
import { localPath } from "./forms.js";
import { Layout, render, type Chrome } from "./layout.js";

export interface ErrorPageProps {
  chrome: Chrome;
  /** The HTTP status the route sends. */
  status: number;
  /** A fixed title such as "Page not found". Never text from the request. */
  title: string;
  /** A fixed sentence saying what happened and what to do. Never text from the request. */
  message: string;
  /**
   * The part of `message` that says what to do, which the page sets in bold. Required, so that a
   * caller cannot forget it: an error page that says what happened and not what to do is the thing
   * this field exists to prevent. Normally a sentence that occurs inside `message`.
   */
  todo: string;
  /** Where "back" goes: a path on this site. Anything else is ignored. Defaults to the matters list. */
  backHref?: string;
  backLabel?: string;
  /**
   * The id the shell made for this request, given for a server fault only so the person can quote
   * it. It is printed only when it has the shape the shell makes, so nothing else can get on the
   * page through this field.
   */
  requestId?: string | undefined;
}

/** What the shell's request ids look like (`req_` and sixteen hex digits). */
const REQUEST_ID = /^req_[0-9a-f]{16}$/;

/**
 * Says what kind of problem it was and nothing about what the caller sent, so it can be shown for
 * any failure, including one caused by hostile input.
 */
export function ErrorPage(props: ErrorPageProps) {
  const href = localPath(props.backHref) ?? urls.matters();
  const reference =
    typeof props.requestId === "string" && REQUEST_ID.test(props.requestId)
      ? props.requestId
      : null;
  return (
    <Layout title={props.title} chrome={props.chrome}>
      <div class="error-page" role="alert">
        <p class="error-code">Error {props.status}</p>
        <h1>{props.title}</h1>
        <p>
          <TodoText text={props.message} todo={props.todo} />
        </p>
        {reference === null ? null : (
          <p class="technical">
            Reference: <code>{reference}</code>
          </p>
        )}
        <p>
          <a class="button" href={href}>
            {props.backLabel ?? "Back to your matters"}
          </a>
        </p>
      </div>
    </Layout>
  );
}

/**
 * The shell's error renderer (`AppOptions.renderError`), made from `ErrorPage`. The shell calls it
 * with a status, a fixed title, for a server fault the request id, and the key of the sentence for
 * the kind of failure (`guidance.ts`), and with no request and so no session: the page is the
 * signed-out one, and the same bytes for the same status and key, which keeps the 404 for a matter
 * that is not yours identical to the 404 for one that does not exist. Without a key the status
 * decides, and a status the table does not know gets the general sentence.
 */
export function renderErrorPage(
  status: number,
  title: string,
  requestId?: string,
  guidance?: GuidanceKey,
): string {
  const { text, todo } = guidanceFor(status, guidance);
  return render(
    ErrorPage({
      chrome: { userName: null, csrfToken: "" },
      status,
      title,
      message: text,
      todo,
      ...(status === 401 ? { backHref: urls.home(), backLabel: "Go to sign in" } : {}),
      requestId,
    }),
  );
}
