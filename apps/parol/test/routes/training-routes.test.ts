import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { FIELDS } from "../../src/server/pages/forms.js";
import {
  NOTICES,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { REFUSALS_TRAINING } from "../../src/server/routes/refusals-training.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { StartTrainingInput } from "../../src/server/routes/training.js";
import { urls } from "../../src/server/urls.js";
import { ConflictError, ValidationError } from "../../src/store/index.js";
import { T01 } from "../../src/training/t01.js";
import {
  all,
  attr,
  byId,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  withClass,
} from "../pages/html.js";
import { NO_PLAYBOOK_SENTENCE } from "../../src/server/pages/quickstart.js";
import { expectAccessible } from "../a11y/rules.js";
import { simulatedModel, trainingMatterIds } from "../training/support.js";
import { ROOT } from "../integration/pipeline.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  matterIdFrom,
  type Browser,
  type Site,
} from "./support.js";

/**
 * Starting the training matter through the routes (package W2.8): `POST /training`. It names no
 * matter and takes two named fields, so what these tests show is who may use it, that the token is
 * needed, what it makes (and that a second post makes nothing), what it refuses in words, on the
 * quickstart page that holds the form, and that no request can reach another person's training
 * matter or set its key. The pages themselves (`GET /quickstart` and `GET /help`) are in
 * quickstart-routes.test.ts. The reader here is the simulated reader; nothing calls a network.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FORM = { "content-type": "application/x-www-form-urlencoded" };

let site: Site;
let associate: Browser;
let reviewer: Browser;
let visitor: Browser;

beforeAll(async () => {
  site = makeSite({ model2: simulatedModel() });
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
  visitor = site.anonymous();
});

/** The form post the quickstart will make, with the token and the fields given. */
async function start(
  who: Browser,
  fields: Record<string, string> = { [FIELDS.reviewerUserId]: IDS.reviewer },
  token: string | null | "own" = "own",
): Promise<Response> {
  const pairs = new URLSearchParams(fields);
  const sent = token === "own" ? await who.apiToken() : token;
  if (sent !== null) pairs.set("_csrf", sent);
  return who.send("POST", urls.training(), { headers: FORM, body: pairs.toString() });
}

const trainingIds = (): string[] => trainingMatterIds(site.w.repo);
const eventsOf = (matterId: string) => site.w.repo.listAuditEvents({ matterId, limit: 1000 });

describe("who may start it, and what it needs", () => {
  it("is open to every signed-in person, who becomes the associate of a matter of their own", async () => {
    const before = trainingIds().length;
    for (const [userId, reviewerId] of [
      [IDS.legalEngineer, IDS.reviewer],
      [IDS.admin, IDS.reviewer],
      [OTHER_ASSOCIATE, IDS.associate],
    ] as const) {
      const who = await site.as(userId);
      const response = await start(who, { [FIELDS.reviewerUserId]: reviewerId });
      expect(response.status, userId).toBe(303);
      const matter = site.w.repo.getMatter(matterIdFrom(response))!;
      expect(matter.trainingKey).toBe("T01");
      expect(matter.createdBy).toBe(userId);
      expect(site.w.repo.getMember(matter.id, userId)?.role).toBe("associate");
    }
    expect(trainingIds()).toHaveLength(before + 3);
  });

  it("is refused without a valid token, whatever the token is, and changes nothing", async () => {
    const other = await site.as(IDS.reviewer);
    const before = fingerprint(site);
    for (const [name, token] of [
      ["no token", null],
      ["an empty token", ""],
      ["a wrong token", "not-a-token"],
      ["another session's token", await other.apiToken()],
    ] as const) {
      const response = await start(associate, undefined, token);
      expect(response.status, name).toBe(403);
    }
    expect(fingerprint(site)).toEqual(before);
  });

  it("sends a visitor to sign in, whatever they carry, and changes nothing", async () => {
    const before = fingerprint(site);
    for (const token of [null, "", "not-a-token", await associate.apiToken()]) {
      const response = await start(visitor, undefined, token);
      expect(response.status, String(token)).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("what it makes", () => {
  let matterId: string;
  let firstLocation: string;

  it("makes one training matter, with its documents and members, and says so on the page it leads to", async () => {
    const fresh = await site.as(IDS.associate);
    // Alex is the reviewer of another person's training matter by now, and has none of their own.
    const ownOf = (userId: string): string[] =>
      trainingIds().filter((id) => site.w.repo.getMember(id, userId)?.role === "associate");
    expect(ownOf(IDS.associate)).toEqual([]);
    const response = await start(fresh, {
      [FIELDS.reviewerUserId]: IDS.reviewer,
      [FIELDS.trainerUserId]: IDS.legalEngineer,
    });
    expect(response.status).toBe(303);
    firstLocation = response.headers.get("location")!;
    matterId = matterIdFrom(response);
    expect(firstLocation).toMatch(
      new RegExp(
        `^${urls.matter(matterId)}\\?notice=training-started&nt=\\d+\\.[A-Za-z0-9_-]{43}$`,
      ),
    );

    const matter = site.w.repo.getMatter(matterId)!;
    expect(matter).toMatchObject({
      name: T01.matterName,
      clientLegalName: T01.clientLegalName,
      trainingKey: "T01",
      synthetic: true,
    });
    expect(
      site.w.repo
        .listMembers(matterId)
        .map((m) => [m.userId, m.role])
        .sort(),
    ).toEqual(
      [
        [IDS.associate, "associate"],
        [IDS.reviewer, "reviewer"],
        [IDS.legalEngineer, "viewer"],
      ].sort(),
    );
    expect(site.w.repo.listDocuments(matterId).map((d) => d.kind)).toEqual(["nda", "amendment"]);
    expect(site.w.repo.listRunsForMatter(matterId)).toEqual([]);

    // The events are the person's own: the creation names the key, and nothing names a text.
    const events = eventsOf(matterId);
    const created = events.find((e) => e.action === "matter.create")!;
    expect(created).toMatchObject({ actorId: IDS.associate, detail: { training: "T01" } });
    expect(events.filter((e) => e.action === "document.add")).toHaveLength(2);
    expect(events.filter((e) => e.action === "member.add")).toHaveLength(3);
    expect(site.w.repo.verifyAuditChain().ok).toBe(true);

    const landed = await fresh.page(firstLocation);
    const notices = all(landed.root, (el) => hasClass(el, "notice")).map((el) => readable(el));
    expect(notices).toEqual([
      "Done The training matter is ready. Follow the quickstart from step 1.",
    ]);
    expect(readable(landed.root)).toContain(T01.matterName);
  });

  it("makes nothing the second time, and says that the person already has one", async () => {
    const fresh = await site.as(IDS.associate);
    const before = fingerprint(site);
    const response = await start(fresh, {
      [FIELDS.reviewerUserId]: IDS.reviewer,
      [FIELDS.trainerUserId]: IDS.legalEngineer,
    });
    expect(response.status).toBe(303);
    expect(matterIdFrom(response)).toBe(matterId);
    expect(response.headers.get("location")).toContain("notice=training-exists");
    expect(fingerprint(site)).toEqual(before);
    const landed = await fresh.page(response.headers.get("location")!);
    expect(all(landed.root, (el) => hasClass(el, "notice")).map((el) => readable(el))).toEqual([
      "Note You already have a training matter, so no second one was made. This is it.",
    ]);
  });

  it("reads two named fields and nothing else: a field that sets the key, the name or the retention is ignored", async () => {
    const who = await site.as(OUTSIDER);
    const response = await start(who, {
      [FIELDS.reviewerUserId]: IDS.reviewer,
      trainingKey: "T02",
      name: "Hacked",
      clientLegalName: "Someone Else",
      synthetic: "0",
      retainDays: "1",
      playbookVersionId: "pbv_other",
      createdBy: IDS.admin,
    });
    expect(response.status).toBe(303);
    const matter = site.w.repo.getMatter(matterIdFrom(response))!;
    expect(matter).toMatchObject({
      name: T01.matterName,
      clientLegalName: T01.clientLegalName,
      trainingKey: "T01",
      synthetic: true,
      createdBy: OUTSIDER,
    });
    const days = (Date.parse(matter.retainUntil) - Date.parse(matter.createdAt)) / 86_400_000;
    expect(days).toBe(30);
  });

  it("leaves the schema strict: a body with any other key does not parse", () => {
    expect(
      StartTrainingInput.safeParse({ reviewerUserId: null, trainerUserId: null }).success,
    ).toBe(true);
    for (const body of [
      { reviewerUserId: null, trainerUserId: null, trainingKey: "T01" },
      { reviewerUserId: null, trainerUserId: null, playbookVersionId: "x" },
      { reviewerUserId: null },
      { reviewerUserId: "", trainerUserId: null },
    ])
      expect(StartTrainingInput.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

describe("what it refuses, in words, on the quickstart page that holds the form", () => {
  /** A refused post: its status, the quickstart page, and the one alert on it. */
  async function refused(who: Browser, fields: Record<string, string>, status: 400 | 409) {
    const before = fingerprint(site);
    const response = await start(who, fields);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    const html = await response.text();
    const root = parseHtml(html);
    expect(readable(all(root, (el) => el.name === "h1")[0]!)).toBe("Quickstart");
    const alerts = all(root, (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(hasClass(alerts[0]!, "notice-error")).toBe(true);
    expect(fingerprint(site)).toEqual(before);
    return { html, root, alert: alerts[0]! };
  }

  // The reviewing attorney of the site has no training matter of their own, and a refusal changes
  // nothing, so the form is on the page for every case below.
  const CASES = [
    ["no reviewer", {}, "reviewer_required"],
    ["the person as their own reviewer", { [FIELDS.reviewerUserId]: IDS.reviewer }, "bad_reviewer"],
    [
      "a reviewer who is not a user",
      { [FIELDS.reviewerUserId]: "usr_QZX-TYPED" },
      "unknown_identity",
    ],
    [
      "a trainer who is not a user",
      { [FIELDS.reviewerUserId]: IDS.associate, [FIELDS.trainerUserId]: "usr_QZX-TYPED" },
      "unknown_identity",
    ],
    [
      "a trainer who is the reviewer",
      { [FIELDS.reviewerUserId]: IDS.associate, [FIELDS.trainerUserId]: IDS.associate },
      "bad_trainer",
    ],
    [
      "a trainer who is the person",
      { [FIELDS.reviewerUserId]: IDS.associate, [FIELDS.trainerUserId]: IDS.reviewer },
      "bad_trainer",
    ],
  ] as const;

  for (const [name, fields, code] of CASES) {
    it(`${name} is answered with the phrase of ${code}, the sentence to follow and a link to the field`, async () => {
      const { html, root, alert } = await refused(reviewer, { ...fields }, 400);
      expect(readable(alert)).toBe(
        `Problem ${REFUSAL_PHRASES[code]}${
          Object.hasOwn(REFUSAL_JUMP, code) ? ` ${REFUSAL_JUMP[code]!.label}` : ""
        }`,
      );
      expect(withClass(alert, "todo").map((el) => readable(el))).toEqual([REFUSAL_TODO[code]]);
      // The link leads to a place on this page: the field to fix, or the form.
      const links = all(alert, (el) => el.name === "a");
      expect(links.map((el) => attr(el, "href"))).toEqual([REFUSAL_JUMP[code]!.href]);
      expect(byId(root, REFUSAL_JUMP[code]!.href.slice(1)), code).toBeDefined();
      // The form is there again, for the person to correct.
      expect(
        all(root, (el) => el.name === "form" && attr(el, "action") === urls.training()),
      ).toHaveLength(1);
      // The page is a whole page that passes the rules of the keyboard and the labels.
      expectAccessible(root);
      // Nothing of the request is in the page.
      expect(html).not.toContain("QZX-TYPED");
    });
  }

  it("keeps the person's choice of reviewing attorney and trainer in the form", async () => {
    const { root } = await refused(
      reviewer,
      { [FIELDS.reviewerUserId]: IDS.associate, [FIELDS.trainerUserId]: IDS.associate },
      400,
    );
    const form = all(
      root,
      (el) => el.name === "form" && attr(el, "action") === urls.training(),
    )[0]!;
    for (const name of [FIELDS.reviewerUserId, FIELDS.trainerUserId]) {
      const select = all(form, (el) => el.name === "select" && attr(el, "name") === name)[0]!;
      const picked = all(select, (el) => el.name === "option" && hasAttr(el, "selected"));
      expect(
        picked.map((o) => attr(o, "value")),
        name,
      ).toEqual([IDS.associate]);
    }
  });

  it("is answered for a person who has a training matter with the link to it and no form, and no link to a field", async () => {
    // The associate has one by now. A post that cannot be made (a hand-made one: the form is not
    // offered to them) is refused first, and the page does not point at a form it does not show.
    expect(
      trainingIds().some((id) => site.w.repo.getMember(id, IDS.associate)?.role === "associate"),
    ).toBe(true);
    const { root, alert } = await refused(associate, {}, 400);
    expect(readable(alert)).toBe(`Problem ${REFUSAL_PHRASES["reviewer_required"]}`);
    expect(all(alert, (el) => el.name === "a")).toEqual([]);
    expect(withClass(alert, "todo").map((el) => readable(el))).toEqual([
      REFUSAL_TODO["reviewer_required"],
    ]);
    expect(all(root, (el) => el.name === "form" && attr(el, "action") === urls.training())).toEqual(
      [],
    );
    const own = all(root, (el) => el.name === "a" && readable(el) === "Open the training matter");
    expect(own).toHaveLength(1);
    expectAccessible(root);
  });

  it("a server with no approved playbook version is answered 409, with the sentence for whoever runs it in the page", async () => {
    const services = {
      ...site.deps.services,
      matters: { ...site.deps.services.matters, playbooks: () => [] },
    };
    const deps = { ...site.deps, services };
    const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
    registerRoutes(app, deps);
    const { Browser: B } = await import("./support.js");
    const who = new B(app);
    await who.signIn(VIEWER);
    expect(trainingIds().some((id) => site.w.repo.getMember(id, VIEWER) !== undefined)).toBe(false);
    const before = fingerprint(site);
    const token = await who.apiToken();
    const response = await who.send("POST", urls.training(), {
      headers: FORM,
      body: new URLSearchParams({ [FIELDS.reviewerUserId]: IDS.reviewer, _csrf: token }).toString(),
    });
    expect(response.status).toBe(409);
    const root = parseHtml(await response.text());
    expectAccessible(root);
    const alerts = all(root, (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(readable(alerts[0]!)).toBe(`Problem ${REFUSAL_PHRASES["no_playbook"]}`);
    expect(withClass(alerts[0]!, "todo").map((el) => readable(el))).toEqual([
      REFUSAL_TODO["no_playbook"],
    ]);
    // The page says it again where the form would be, and offers no form.
    expect(readable(all(root, (el) => hasClass(el, "empty"))[0]!)).toBe(NO_PLAYBOOK_SENTENCE);
    expect(all(root, (el) => el.name === "form" && attr(el, "action") === urls.training())).toEqual(
      [],
    );
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("another person's training matter", () => {
  let mine: string;
  beforeAll(async () => {
    const who = await site.as(IDS.admin);
    // The administrator has one from an earlier test; it is theirs and no one else's.
    mine = trainingIds().find((id) => site.w.repo.getMember(id, IDS.admin)?.role === "associate")!;
    expect(mine).toBeDefined();
  });

  it("is not in the list of a person who is not on it, and its name and id are not on any page of theirs", async () => {
    const stranger = await site.as(VIEWER);
    const list = await stranger.page(urls.matters());
    expect(list.html).not.toContain(mine);
    expect(list.html).not.toContain(T01.matterName);
    const api = await stranger.api("GET", "/api/matters");
    const body = await api.text();
    expect(body).not.toContain(mine);
    expect(body).not.toContain(T01.matterName);
  });

  it("is answered 404 to a person who is not on it, with the answer a matter that does not exist gets", async () => {
    const stranger = await site.as(VIEWER);
    const missing = "mat_00000000deadbeef";
    for (const path of [(id: string) => urls.matter(id), (id: string) => `/api/matters/${id}`]) {
      const real = await stranger.get(path(mine));
      const none = await stranger.get(path(missing));
      expect(real.status).toBe(404);
      expect(none.status).toBe(404);
      expect(await real.text()).toBe(await none.text());
    }
  });
});

describe("what the routes of the matter forms do not offer", () => {
  it("refuses a training key in the body of the JSON route that makes a matter", async () => {
    const before = fingerprint(site);
    const response = await associate.api("POST", "/api/matters", {
      name: "An NDA",
      clientLegalName: "Marlowe Analytics, Inc.",
      trainingKey: "T01",
    });
    expect(response.status).toBe(400);
    expect(fingerprint(site)).toEqual(before);
    // The same body without the key makes an ordinary matter.
    const ok = await associate.api("POST", "/api/matters", {
      name: "An NDA",
      clientLegalName: "Marlowe Analytics, Inc.",
    });
    expect(ok.status).toBe(201);
    const made = (await ok.json()) as { id: string };
    expect(site.w.repo.getMatter(made.id)?.trainingKey).toBeNull();
  });

  it("ignores a training field of the form that makes a matter, which makes an ordinary one", async () => {
    const response = await associate.send("POST", urls.matters(), {
      headers: FORM,
      body: new URLSearchParams({
        _csrf: await associate.apiToken(),
        [FIELDS.name]: "Plain NDA",
        [FIELDS.clientLegalName]: "Marlowe Analytics, Inc.",
        trainingKey: "T01",
      }).toString(),
    });
    expect(response.status).toBe(303);
    expect(site.w.repo.getMatter(matterIdFrom(response))?.trainingKey).toBeNull();
  });

  it("has no JSON twin of the form: the training matter is started from a page", async () => {
    const response = await associate.api("POST", "/api/training", {
      reviewerUserId: IDS.reviewer,
      trainerUserId: null,
    });
    expect(response.status).toBe(404);
  });
});

describe("the words", () => {
  const codes = Object.keys(REFUSALS_TRAINING.phrases);

  it("give every code a phrase, a todo that occurs inside it and, for a field, a jump to a place on the page", () => {
    expect(codes.sort()).toEqual(
      [
        "bad_reviewer",
        "bad_trainer",
        "no_playbook",
        "reviewer_required",
        "training_files_missing",
        "unknown_identity",
      ].sort(),
    );
    for (const code of codes) {
      const phrase = REFUSAL_PHRASES[code]!;
      const todo = REFUSAL_TODO[code]!;
      expect(phrase, code).toMatch(/^[A-Z][^<>&"]*\.$/);
      expect(todo, code).toBeTruthy();
      expect(phrase, code).toContain(todo);
      expect(phrase.endsWith(todo), code).toBe(true);
    }
    for (const [code, jump] of Object.entries(REFUSAL_JUMP).filter(([c]) => codes.includes(c))) {
      expect(jump.href, code).toMatch(/^#[a-z][a-z0-9-]*$/);
      expect(jump.label, code).toMatch(/^Go to /);
    }
    // The three that are about a field have a jump; the two that are the operator's do not.
    expect(codes.filter((c) => Object.hasOwn(REFUSAL_JUMP, c)).sort()).toEqual(
      ["bad_reviewer", "bad_trainer", "reviewer_required", "unknown_identity"].sort(),
    );
  });

  it("have a phrase for every code the training start and its route can throw", () => {
    const files = [
      join(ROOT, "apps", "parol", "src", "server", "routes", "training.ts"),
      ...readdirSync(join(ROOT, "apps", "parol", "src", "training"))
        .filter((name) => name.endsWith(".ts"))
        .map((name) => join(ROOT, "apps", "parol", "src", "training", name)),
    ];
    const thrown = new Set<string>();
    for (const file of files)
      for (const match of readFileSync(file, "utf8").matchAll(
        /new (?:ValidationError|ConflictError)\(\s*"([a-z_]+)"/g,
      ))
        thrown.add(match[1]!);
    expect([...thrown].sort()).toEqual(codes.sort());
  });

  it("register the two notices, success for a new matter and info for the one it already had", () => {
    expect(NOTICES["training-started"]).toEqual({
      kind: "success",
      text: "The training matter is ready. Follow the quickstart from step 1.",
    });
    expect(NOTICES["training-exists"]).toEqual({
      kind: "info",
      text: "You already have a training matter, so no second one was made. This is it.",
    });
    const dashes = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
    for (const text of [
      ...Object.values(REFUSALS_TRAINING.phrases),
      ...Object.values(REFUSALS_TRAINING.todo),
      ...Object.values(REFUSALS_TRAINING.jump).map((j) => j.label),
      NOTICES["training-started"]!.text,
      NOTICES["training-exists"]!.text,
    ])
      expect(text).not.toMatch(dashes);
  });

  it("reach the person from the store's own refusals, and the status is the shell's", () => {
    const validation = refusalOf(
      new ValidationError("bad_trainer", "the trainer is not the author"),
    );
    expect(validation).toMatchObject({ status: 400, code: "bad_trainer" });
    expect(validation?.notice).toEqual({
      kind: "error",
      text: REFUSAL_PHRASES["bad_trainer"],
      todo: REFUSAL_TODO["bad_trainer"],
      jump: REFUSAL_JUMP["bad_trainer"],
    });
    const conflict = refusalOf(new ConflictError("no_playbook", "no approved playbook version"));
    expect(conflict).toMatchObject({ status: 409, code: "no_playbook" });
    expect(conflict?.notice.jump).toBeUndefined();
    expect(byId(parseHtml('<main id="x"></main>'), "x")).toBeDefined();
  });
});
