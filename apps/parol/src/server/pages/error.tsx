import { urls } from "../urls.js";
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
        <p>{props.message}</p>
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
 * One sentence for each status the shell answers with. They say what happened and what to do, and
 * are the same for every request, so a refusal cannot be told from another by its words.
 */
const MESSAGES: Record<number, string> = {
  400: "The request could not be understood. Go back, check the form and try again.",
  401: "You need to sign in first.",
  403: "Your role on this matter does not allow that.",
  404: "There is nothing here, or you are not a member of the matter.",
  409: "The matter changed, or the request does not fit its state. Reload the page and try again.",
  413: "That upload is larger than Parol accepts.",
  422: "That file could not be accepted. Parol reads .docx and .txt files.",
  500: "Something went wrong on the server. Quote the reference below if you report it.",
};
const FALLBACK_MESSAGE = "The request could not be completed.";

/**
 * The shell's error renderer (`AppOptions.renderError`), made from `ErrorPage`. The shell calls it
 * with a status, a fixed title and, for a server fault, the request id, and with no request and so
 * no session: the page is the signed-out one, and the same bytes for the same status, which keeps
 * the 404 for a matter that is not yours identical to the 404 for one that does not exist.
 */
export function renderErrorPage(status: number, title: string, requestId?: string): string {
  const message = Object.hasOwn(MESSAGES, status) ? MESSAGES[status] : undefined;
  return render(
    ErrorPage({
      chrome: { userName: null, csrfToken: "" },
      status,
      title,
      message: message ?? FALLBACK_MESSAGE,
      ...(status === 401 ? { backHref: urls.home(), backLabel: "Go to sign in" } : {}),
      requestId,
    }),
  );
}
