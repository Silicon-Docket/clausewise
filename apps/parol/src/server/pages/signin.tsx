import type { UserOption } from "../../services/views.js";
import { urls } from "../urls.js";
import { RevealedText } from "./components.js";
import { FIELDS, SIGN_IN_INTENT } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";
import { globalRoleLabel } from "../views/labels.js";

export interface SignInPageProps {
  chrome: Chrome;
  users: UserOption[];
  /**
   * False when the server was started without the demo identity: the people exist, but nobody can
   * sign in as one. Absent means on, which is how a page built before this setting behaves.
   */
  signInEnabled?: boolean;
}

/**
 * The demo identity picker. It is not authentication: anyone at the keyboard can be anyone. The
 * page says so, because the permanent banner alone is easy to stop seeing.
 *
 * With sign-in off it says that instead of offering a choice, and how it is turned on: the warning
 * the server prints when it starts is on the operator's terminal, not where the visitor is looking,
 * and "no identities have been set up" would be untrue.
 */
export function SignInPage(props: SignInPageProps) {
  if (props.signInEnabled === false) {
    return (
      <Layout title="Sign-in is switched off" chrome={props.chrome}>
        <h1>Sign-in is switched off</h1>
        <p class="lead">
          This server was started without the demo identity, so nobody can sign in. Whoever runs the
          server can turn it on by starting it with <code>PAROL_DEMO_IDENTITY=1</code>.
        </p>
        <p>
          New here? <a href={urls.quickstart()}>Read the quickstart</a>.
        </p>
      </Layout>
    );
  }
  return (
    <Layout title="Choose a demo identity" chrome={props.chrome}>
      <h1>Choose a demo identity</h1>
      <p class="lead">
        This is a demonstration. There are no passwords: pick a person to act as. It is not
        authentication, and it must never be used with a real client's documents.
      </p>
      <p>
        New here? <a href={urls.quickstart()}>Read the quickstart</a>.
      </p>
      {props.users.length === 0 ? (
        <p class="empty">No demo identities have been set up.</p>
      ) : (
        <form method="post" action={urls.session()} class="identity-list">
          {csrfField(props.chrome.csrfToken)}
          <input type="hidden" name={FIELDS.intent} value={SIGN_IN_INTENT} />
          <ul>
            {props.users.map((user) => (
              <li>
                <button type="submit" name={FIELDS.userId} value={user.userId} class="identity">
                  <span class="identity-name">
                    <RevealedText value={user.displayName} />
                  </span>
                  <span class="identity-role">{globalRoleLabel(user.globalRole)}</span>
                </button>
              </li>
            ))}
          </ul>
        </form>
      )}
    </Layout>
  );
}
