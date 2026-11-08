import { describe, expect, it } from "vitest";
import { SignInPage, render } from "../../src/server/pages/index.js";
import { checkInvariants } from "./invariants.js";
import { all, attr, first, forms, readable } from "./html.js";
import { buildChrome, buildUsers } from "./support.js";

/**
 * With the demonstration identity off the users exist and signing in is switched off, which is not
 * the same as "no identities have been set up". The page says which it is and what to do about it,
 * because the start-up warning on the operator's terminal is not where the visitor is looking.
 */

const chrome = buildChrome({ userName: null });
const page = (props: { users?: ReturnType<typeof buildUsers>; signInEnabled?: boolean }): string =>
  render(SignInPage({ chrome, users: props.users ?? [], ...props }));

describe("SignInPage with sign-in switched off", () => {
  const root = checkInvariants(page({ signInEnabled: false }));
  const text = readable(root);

  it("says that sign-in is switched off, in the title and the heading", () => {
    expect(readable(first(root, (el) => el.name === "title"))).toContain("Sign-in is switched off");
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Sign-in is switched off");
  });

  it("says how it is switched on", () => {
    expect(text).toContain("PAROL_DEMO_IDENTITY=1");
  });

  it("does not offer a choice, or claim that nothing has been set up", () => {
    expect(text).not.toContain("Choose a demo identity");
    expect(text).not.toContain("pick a person to act as");
    expect(text).not.toContain("No demo identities have been set up");
    expect(forms(root)).toHaveLength(0);
    expect(all(root, (el) => el.name === "button" || el.name === "input")).toEqual([]);
  });

  it("shows no list even when it is handed users", () => {
    const withUsers = checkInvariants(page({ signInEnabled: false, users: buildUsers() }));
    expect(forms(withUsers)).toHaveLength(0);
    expect(readable(withUsers)).not.toContain(buildUsers()[0]!.displayName);
  });
});

describe("SignInPage with sign-in switched on", () => {
  it("is the picker, as before", () => {
    const root = checkInvariants(page({ signInEnabled: true, users: buildUsers() }));
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Choose a demo identity");
    expect(forms(root)).toHaveLength(1);
    expect(attr(forms(root)[0]!, "method")).toBe("post");
  });

  it("is the picker when the setting is not given", () => {
    const root = checkInvariants(page({ users: buildUsers() }));
    expect(readable(first(root, (el) => el.name === "h1"))).toBe("Choose a demo identity");
  });

  it("still says that no identities exist when sign-in is on and the list is empty", () => {
    const root = checkInvariants(page({ signInEnabled: true, users: [] }));
    expect(readable(root)).toContain("No demo identities have been set up.");
  });
});
