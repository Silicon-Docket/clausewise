import type { UserOption } from "../../services/views.js";
import { urls } from "../urls.js";
import { RevealedText } from "./components.js";
import { FIELDS, SIGN_IN_INTENT } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";
import { globalRoleLabel } from "../views/labels.js";

export interface SignInPageProps {
  chrome: Chrome;
  users: UserOption[];
}

/**
 * The demo identity picker. It is not authentication: anyone at the keyboard can be anyone. The
 * page says so, because the permanent banner alone is easy to stop seeing.
 */
export function SignInPage(props: SignInPageProps) {
  return (
    <Layout title="Choose a demo identity" chrome={props.chrome}>
      <h1>Choose a demo identity</h1>
      <p class="lead">
        This is a demonstration. There are no passwords: pick a person to act as. It is not
        authentication, and it must never be used with a real client's documents.
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
