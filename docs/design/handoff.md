# Handoff format

`lr handoff [--round N] [--json]`. Markdown is the default because agents read it best. `--json` returns
the same content as structured data. It's read-only, so the agent can re-read it whenever it wants.

**When there's something to hand off.** Only a human approves. A human's verdict on the round is
the verdict. Without one, the handoff is "changes requested (by agent reviewers)" if an agent asked
for changes or left open threads. That's the agent-reviews-first loop. Otherwise there's nothing to
hand off yet (no reviews, or agents approved and a human hasn't weighed in), and `lr handoff` exits
1 with the reason. `lr status` points at the handoff once it's ready. A human's verdict also moves
the feature to `revising` or `finalizing`.

Rules:

- Include every `open` thread on the feature, from any round (reopened ones included), with the
  context needed to act on them. They're shown where they were re-anchored to in the latest round.
  Outdated threads are marked, with the snippet as it was. `addressed` (waiting on the reviewer),
  `resolved`, `dismissed` and `proposed` threads are left out. That includes notes, unless
  someone reopened one.
- Group by where the fix goes: general → final commits → PR body → the plan → phase → change →
  file. The agent works change by change
  (`jj edit` / `jj squash --into`), so that's the useful order.
- Inline the code snippet and the full thread, so the agent doesn't need extra lookups to
  understand a comment.
- After the threads, list the round's plan gaps (see [Plan](data-model.md#plan)), with a next step to close them.
- Always end with explicit next-step instructions that match the verdict.

Example (changes requested), exactly as rendered:

````md
# Review handoff: auth-refresh, round 2

**Verdict:** changes requested  
**Reviews:** agent:codex: approved · human:nick: changes requested  
**Checks:** ✗ test @ `vtzqlmsr` (fail): log at ~/.local-review/…/checks/0199….log  
**Plan:** v1 · 3 open thread(s) (2 blocking)

## Reviewer summary (human:nick)

> Schema looks right. Rotation has a race; see #14.

## General

### #9 · blocking

> **human:nick**: Rotation should be feature-flagged.

## Phase 1: Schema + migration (`auth-refresh/1-schema`)

### Change `kxqpmwyz` "Adds refresh_tokens table"

#### #13 · nit · commit message, line 1

```
Adds refresh_tokens table
```

> **human:nick**: Subject should be imperative: "Add…", not "Adds…".

#### #12 · blocking · `src/db/schema.ts:40-41` (new)

```ts
40 |   expires_at: timestamp(),
41 |   revoked: boolean(),
```

> **human:nick**: Both need `.notNull()`.
>
> Suggested:
>
> ```ts
> expires_at: timestamp().notNull(),
> revoked: boolean().notNull().default(false),
> ```
>
> **agent:claude-code** (marked addressed): Added in kxqpmwyz.
>
> **human:nick** (marked open): `revoked` still allows null.

## Next steps

1. Fix the failing checks listed above.
2. Write a revised plan that covers every open thread above, and says why for any you won't change: `lr plan revise -F <file>`.
3. Amend the changes the threads are on, in place (`jj edit <change>`, or `jj squash --into <change>`). Don't stack fixup commits unless the plan says to.
4. Reply to every thread: `lr reply <id> --addressed "<what changed>"`, or `lr reply <id> "<why not>"` to push back.
5. Run `lr review create` to open the next round.
````

When the verdict is `approved` and threads are open, the steps are the same, except that the last
one is a final `lr review create` "for a last look". Approved with nothing open means finalize: draft
one message per group (`lr final message <group> -F`) and the PR body (`lr final pr-body -F`),
then run `lr review create --final`. A final round's handoff is titled "final round N". It groups
threads under "Final commit messages" and "PR body". Its steps are to redraft, reply, and open the
next final round, or to run `lr final apply` once approved.
