import { describe, expect, test } from "bun:test";
import { buildHandoff, type Handoff, renderHandoff } from "../src/handoff.ts";
import type {
  Actor,
  Anchor,
  ChangeSnapshot,
  CheckRun,
  Entry,
  Feature,
  Phase,
  Review,
  Round,
  Thread,
} from "../src/model.ts";

const codex: Actor = { kind: "agent", name: "codex" };
const nick: Actor = { kind: "human", name: "nick" };
const feature: Feature = {
  slug: "auth",
  title: "Auth",
  baseRevset: "main",
  status: "in_review",
  currentPlanVersion: 1,
  createdAt: "",
};
const phases: Phase[] = [
  { id: 1, title: "Schema", bookmark: "auth/1-schema", doneWhen: null, tasks: [] },
  { id: 2, title: "Rotation", bookmark: "auth/2-rotation", doneWhen: null, tasks: [] },
];
const change = (id: string, phaseId: number | null, description = `Subject ${id}\n`) =>
  ({
    changeId: `${id}xxxxxxxxxx`,
    commitId: `commit-${id}`,
    description,
    trailers: [],
    phaseId,
    bookmarks: [],
    conflicted: false,
    empty: false,
    stats: { files: 1, added: 1, removed: 0 },
  }) satisfies ChangeSnapshot;
const changes = [change("aaaa", 1), change("bbbb", 1, ""), change("cccc", 2), change("dddd", null)];
const round = (verdict: Round["verdict"] = null): Round => ({
  n: 2,
  kind: "code",
  final: null,
  jjOpId: "op",
  planVersion: 1,
  baseCommitId: "base",
  changes,
  status: "open",
  verdict,
  createdBy: codex,
  createdAt: "",
});
const review = (
  reviewer: Actor,
  verdict: Review["verdict"],
  body: string | null = null,
): Review => ({
  id: `${reviewer.name}-review`,
  round: 2,
  reviewer,
  state: "submitted",
  verdict,
  body,
  createdAt: "",
  submittedAt: "",
});
const entry = (body: string, extra: Partial<Entry> = {}): Entry => ({
  id: body,
  author: codex,
  body,
  suggestion: null,
  statusChange: null,
  round: 2,
  createdAt: "",
  ...extra,
});
let nextId = 1;
const thread = (anchor: Anchor, extra: Partial<Thread> = {}): Thread => ({
  id: nextId++,
  kind: "comment",
  anchor,
  anchorRound: 2,
  anchorState: "current",
  originalAnchor: anchor,
  severity: null,
  status: "open",
  reviewId: "codex-review",
  createdBy: codex,
  createdInRound: 2,
  createdAt: "",
  entries: [entry("comment")],
  ...extra,
});
const code = (id: string, path: string, first: number, snippet = ["x"]): Anchor => ({
  kind: "code",
  view: { from: "base", to: { changeId: `${id}xxxxxxxxxx` } },
  changeId: `${id}xxxxxxxxxx`,
  commitId: `commit-${id}`,
  path,
  side: "new",
  lines: [first, first + snippet.length - 1],
  snippet,
});
const checkRun = (status: CheckRun["status"]): CheckRun => ({
  id: status,
  check: "test",
  command: "bun test",
  changeId: "ccccxxxxxxxxxx",
  commitId: "commit-cccc",
  trigger: "auto",
  status,
  exitCode: status === "pass" ? 0 : 1,
  logPath: "/logs/test.log",
  startedAt: null,
  finishedAt: null,
});

const build = (opts: {
  verdict?: Round["verdict"];
  reviews?: Review[];
  threads?: Thread[];
  checks?: CheckRun[];
}) =>
  buildHandoff({
    feature,
    round: round(opts.verdict ?? null),
    phases,
    reviews: opts.reviews ?? [],
    checks: opts.checks ?? [],
    threads: opts.threads ?? [],
  });

const ready = (result: ReturnType<typeof build>): Handoff => {
  if (!result.ready) throw new Error(result.reason);
  return result.handoff;
};

describe("buildHandoff: verdict", () => {
  test("not ready without reviews", () => {
    expect(build({})).toEqual({ ready: false, reason: "round 2 has no reviews yet" });
  });

  test("drafts don't count as reviews", () => {
    const draft = { ...review(nick, "approved"), state: "draft" as const };
    expect(build({ reviews: [draft] }).ready).toBe(false);
  });

  test("agents approving isn't enough; a human decides", () => {
    const result = build({ reviews: [review(codex, "approved")] });
    expect(result).toEqual({
      ready: false,
      reason: "agent reviewers have nothing for you on round 2; waiting on a human verdict",
    });
  });

  test("agent reviewers can request changes by verdict or by open threads", () => {
    expect(ready(build({ reviews: [review(codex, "changes_requested")] }))).toMatchObject({
      verdict: "changes_requested",
      decidedBy: "agents",
    });
    const commented = build({
      reviews: [review(codex, null)],
      threads: [thread({ kind: "feature" })],
    });
    expect(ready(commented).decidedBy).toBe("agents");
  });

  test("a human verdict wins", () => {
    const h = ready(
      build({
        verdict: "approved",
        reviews: [review(codex, "changes_requested"), review(nick, "approved")],
      }),
    );
    expect([h.verdict, h.decidedBy]).toEqual(["approved", "human"]);
  });
});

describe("buildHandoff: threads", () => {
  test("only open comment threads, grouped by where the fix goes", () => {
    nextId = 1;
    const t = {
      general: thread({ kind: "feature" }),
      codeB2: thread(code("aaaa", "b.ts", 2)),
      codeA9: thread(code("aaaa", "a.ts", 9)),
      codeA3: thread(code("aaaa", "a.ts", 3)),
      message: thread({
        kind: "message",
        changeId: "aaaaxxxxxxxxxx",
        commitId: "",
        lines: null,
        snippet: [],
      }),
      change: thread({ kind: "change", changeId: "aaaaxxxxxxxxxx" }),
      phase2: thread({ kind: "phase", phaseId: 2 }),
      rotate: thread(code("cccc", "r.ts", 1)),
      unassigned: thread({ kind: "change", changeId: "ddddxxxxxxxxxx" }),
      gone: thread({ kind: "change", changeId: "zzzzxxxxxxxxxx" }),
      earlierRound: thread({ kind: "change", changeId: "bbbbxxxxxxxxxx" }, { createdInRound: 1 }),
      proposed: thread({ kind: "feature" }, { status: "proposed" }),
      addressed: thread({ kind: "feature" }, { status: "addressed" }),
      resolved: thread({ kind: "feature" }, { status: "resolved" }),
      note: thread({ kind: "feature" }, { kind: "note" }),
    };
    const h = ready(build({ reviews: [review(codex, null)], threads: Object.values(t) }));
    expect(h.sections.map((s) => [s.depth, s.title, s.threads.map((x) => x.id)])).toEqual([
      [2, "General", [t.general.id]],
      [2, "Phase 1: Schema (`auth/1-schema`)", []],
      [
        3,
        'Change `aaaaxxxx` "Subject aaaa"',
        [t.change.id, t.message.id, t.codeA3.id, t.codeA9.id, t.codeB2.id],
      ],
      [3, 'Change `bbbbxxxx` "(no description)"', [t.earlierRound.id]],
      [2, "Phase 2: Rotation (`auth/2-rotation`)", [t.phase2.id]],
      [3, 'Change `ccccxxxx` "Subject cccc"', [t.rotate.id]],
      [2, "Not in a phase yet", []],
      [3, 'Change `ddddxxxx` "Subject dddd"', [t.unassigned.id]],
      [2, "No longer in the stack or plan", [t.gone.id]],
    ]);
    expect(h.threads.map((x) => x.id)).toEqual(
      h.sections.flatMap((s) => s.threads.map((x) => x.id)),
    );
  });

  test("phases with nothing to address are left out", () => {
    const h = ready(build({ reviews: [review(codex, "changes_requested")], threads: [] }));
    expect(h.sections).toEqual([]);
  });
});

describe("buildHandoff: next steps", () => {
  test("approved with nothing open means stop", () => {
    const h = ready(build({ verdict: "approved", reviews: [review(nick, "approved")] }));
    expect(h.nextSteps).toHaveLength(1);
    expect(h.nextSteps[0]).toContain("Approved with nothing left to address");
  });

  test("failing checks come first", () => {
    const h = ready(
      build({
        reviews: [review(codex, "changes_requested")],
        checks: [checkRun("pass"), checkRun("fail")],
      }),
    );
    expect(h.failingChecks.map((c) => c.status)).toEqual(["fail"]);
    expect(h.nextSteps[0]).toBe("Fix the failing checks listed above.");
    expect(h.nextSteps.at(-1)).toBe("Run `lr review create` to open the next round.");
  });

  test("approved with comments ends in a last look", () => {
    const h = ready(
      build({
        verdict: "approved",
        reviews: [review(nick, "approved")],
        threads: [thread({ kind: "feature" })],
      }),
    );
    expect(h.nextSteps.at(-1)).toContain("for a last look");
  });
});

describe("renderHandoff", () => {
  test("header, summaries, sections, and numbered steps", () => {
    nextId = 1;
    const threads = [
      thread({ kind: "feature" }, { severity: "blocking", entries: [entry("Flag it.")] }),
      thread(code("aaaa", "src/db.ts", 9, ["  a: 1,", "  b: 2,"]), {
        severity: "blocking",
        entries: [
          entry("Both NOT NULL.", { suggestion: "  a: 1!,\n  b: 2!," }),
          entry("Done in aaaa.", {
            author: { kind: "agent", name: "claude" },
            statusChange: { from: "open", to: "addressed" },
          }),
          entry("Not quite.", { author: nick, statusChange: { from: "addressed", to: "open" } }),
        ],
      }),
      thread(
        {
          kind: "message",
          changeId: "aaaaxxxxxxxxxx",
          commitId: "",
          lines: [1, 1],
          snippet: ["Adds a"],
        },
        { severity: "nit", entries: [entry("Imperative.")] },
      ),
    ];
    const md = renderHandoff(
      ready(
        build({
          verdict: "changes_requested",
          reviews: [
            review(codex, "changes_requested", "Close.\n\nSee #2."),
            review(nick, "changes_requested"),
          ],
          threads,
          checks: [checkRun("fail")],
        }),
      ),
    );
    expect(md).toContain("# Review handoff: auth, round 2\n");
    expect(md).toContain("**Verdict:** changes requested  \n");
    expect(md).toContain(
      "**Reviews:** agent:codex: changes requested · human:nick: changes requested",
    );
    expect(md).toContain("**Checks:** ✗ test @ `ccccxxxx` (fail): log at /logs/test.log");
    expect(md).toContain("**Plan:** v1 · 3 open thread(s) (2 blocking)");
    expect(md).toContain("## Reviewer summary (agent:codex)\n\n> Close.\n>\n> See #2.");
    expect(md).not.toContain("Reviewer summary (human:nick)");
    expect(md).toContain("## General\n\n### #1 · blocking\n\n> **agent:codex**: Flag it.");
    expect(md).toContain("#### #3 · nit · commit message, line 1\n\n```\nAdds a\n```");
    expect(md).toContain(
      [
        "#### #2 · blocking · `src/db.ts:9-10` (new)",
        "",
        "```ts",
        " 9 |   a: 1,",
        "10 |   b: 2,",
        "```",
        "",
        "> **agent:codex**: Both NOT NULL.",
        ">",
        "> Suggested:",
        ">",
        "> ```ts",
        ">   a: 1!,",
        ">   b: 2!,",
        "> ```",
        ">",
        "> **agent:claude** (marked addressed): Done in aaaa.",
        ">",
        "> **human:nick** (marked open): Not quite.",
      ].join("\n"),
    );
    expect(md).toContain(
      "## Next steps\n\n1. Fix the failing checks listed above.\n2. Write a revised plan",
    );
    expect(md.endsWith("to open the next round.\n")).toBe(true);
  });

  test("variants: agents' verdict, check counts, approval, and fences", () => {
    nextId = 1;
    const tricky = thread(code("aaaa", "README", 1, ["```sh", "x", "```"]));
    const agents = renderHandoff(
      ready(
        build({ reviews: [review(codex, null)], threads: [tricky], checks: [checkRun("pass")] }),
      ),
    );
    expect(agents).toContain("changes requested (by agent reviewers; no human verdict yet)");
    expect(agents).toContain("**Checks:** all 1 passing");
    expect(agents).toContain("````\n1 | ```sh\n2 | x\n3 | ```\n````");

    const approved = renderHandoff(
      ready(build({ verdict: "approved", reviews: [review(nick, "approved")] })),
    );
    expect(approved).toContain("**Verdict:** approved  ");
    expect(approved).toContain("**Checks:** none run");
    expect(approved).toContain("## Next steps\n\nApproved with nothing left to address.");

    const withComments = renderHandoff(
      ready(build({ verdict: "approved", reviews: [review(nick, "approved")], threads: [tricky] })),
    );
    expect(withComments).toContain("**Verdict:** approved, with comments");
  });
});
