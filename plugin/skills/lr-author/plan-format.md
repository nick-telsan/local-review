# Plan format

A plan is markdown with YAML frontmatter. The frontmatter defines the phases. The body is for
reviewers: the goal, key decisions and the alternatives you rejected, risks, and what's out of
scope.

```md
---
phases:
  - id: 1
    title: "Schema + migration"
    done_when: migrations apply cleanly to an empty and to a seeded database
    tasks:
      - { id: "1.1", title: "Add refresh_tokens table" }
      - { id: "1.2", title: "Backfill existing sessions" }
  - id: 2
    title: "Token rotation"
    bookmark: auth-refresh/rotation
    done_when: a refresh token works once, and reusing it revokes its whole family
    tasks:
      - { id: "2.1", title: "Rotate on use" }
      - { id: "2.2", title: "Revoke the family on reuse" }
---
# Refresh token rotation

Why, how, and what could go wrong…
```

Each phase has:

| Field       | Required | Meaning                                                                          |
| ----------- | -------- | -------------------------------------------------------------------------------- |
| `id`        | yes      | A unique positive integer. Phases are implemented in list order.                |
| `title`     | yes      | A short name.                                                                    |
| `bookmark`  | no       | Defaults to `<feature>/<id>-<title-slug>`, e.g. `auth-refresh/1-schema-migration`. |
| `done_when` | no       | Acceptance criteria. Reviewers check the phase against it.                      |
| `tasks`     | no       | `{ id, title }` items. Ids are unique across the plan; quote them (`"1.1"`).    |

Quote titles, as the example does. In `{ … }`, an unquoted title ends at its first comma, and YAML
reads the rest as more keys. `lr plan submit` checks the frontmatter, rejects fields it doesn't
know, and lists every problem at once.

## Good phases

- **Each phase is one step a reviewer can judge on its own**, and it builds and passes tests
  without the phases after it. At the end, the stack is squashed to one commit per phase, so each
  phase should make sense as one commit in the final PR.
- Most features need 2–5 phases of 1–5 tasks. Each task is one change in the stack.
- Make `done_when` concrete: something a reviewer can confirm from the diff and the checks.
- Order phases so no phase depends on a later one.

## Revising

`lr plan revise` records a new version in response to the latest round. Keep phase ids and
bookmarks stable so threads and bookmarks keep their meaning. Add a "Changes from review" section
to the body with each open thread (`#12`) and what you'll do about it, or why you won't.
