# Web UI

`lr ui` serves a React app and a JSON API on 127.0.0.1 and opens the browser (`$BROWSER`, else the
platform's opener) at the current feature's latest round. The port is `--port`, else `[ui] port` in
`.local-review.toml`, else one derived from the repo's path (47000–47999), so it's the same after a
restart and links and open tabs keep working. If something else holds that derived port, `lr ui`
takes any free one and says so; a port set with `--port` or the config must be free. It runs until Ctrl-C. One per repo: it records its pid, port, and token in
`<repo-key>/ui.json` (mode 0600), and a second `lr ui` opens that one instead of starting another.
While one runs, other commands link to the round they're about: `lr review create` (code and final),
`lr status`, `lr handoff`, and the session-start hook print its page's address, and their JSON has
it as `uiUrl` (null when no UI is running). These links leave out the token, since CLI output lands
in transcripts and handoffs; the browser `lr ui` opened already holds it.
The standalone binary embeds the page; from source, Bun bundles `src/web/index.html` at startup.

It acts as a person: `--as` or `$LR_ACTOR` if either names a human, else the OS user, never the
coding agent whose shell started it. It writes through the same code as the CLI: drafts become
reviews via `lr review submit`'s path, and replies go through `lr reply`'s rules.

**Security.** The API reads and writes reviews, so any page open in the browser must
not reach it. The page itself is public, since it's the same bundle for everyone. The API needs a
random token, sent as `Authorization: Bearer`. The link `lr ui` prints carries it as `?t=`; the page
keeps it in `localStorage` (per port) and takes it out of the address bar. A restarted `lr ui` has a
new token; the tab it opens stores it, and pages still open from before pick it up (the `storage`
event), reconnect, and refetch. Only the event stream
accepts it in the URL, since `EventSource` can't send headers. The server also refuses a `Host` other
than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and non-GET requests from another
`Origin`.

**Keyboard.** On a round's pages (`?` lists them): `j`/`k` step through the sidebar (overview,
plan, each change); `n`/`p` select the next or previous unresolved thread, going on to the next page
with one; `r` replies to the selected thread; `]`/`[` move between the diff's files; `c` opens the
page's main comment (the change, the plan, or the feature on the overview); `s` switches between
the whole round and "since your last review"; `f` opens Finish review. They act on what's rendered,
so they need no state of their own. Commenting on lines is still by mouse.

**Live updates.** The CLI and agents write to the same SQLite database from other processes. While a
page is connected, the server checks `PRAGMA data_version` every 500ms, and sends `changed` on a
server-sent event stream when it moves. The page then refetches what it shows.

**API** (types in `src/ui/api.ts`):

- `GET /api/features`: the features, each with its latest round and unsettled thread count.
- `GET /api/features/:slug/rounds/:n` (`n` may be `latest`): the round, its plan's phases, checks,
  reviews, and threads, each with a `placement`.
- `GET /api/features/:slug/rounds/:n/changes/:change`: the change's diff, parsed into files, hunks,
  and lines, from the round's cached patch (or jj, if the cache is gone).
- `GET /api/features/:slug/rounds/:n/plan`: every plan version with its text, which one the round
  was taken against, and the round's coverage of it: each task with the changes naming it, each
  phase's changes naming no task, task ids the plan doesn't have, and changes in no phase.
- `GET /api/features/:slug/rounds/:n/since/:from`: what changed since an earlier round, change by
  change, as `lr diff` compares them. A changed change's interdiff is parsed into files, and a
  message edit is split out of them. Rounds are snapshots, so the server keeps recent comparisons.
- `POST …/rounds/:n/draft/comments`, `PUT`/`DELETE …/draft/comments/:id`: the actor's draft comments,
  in review-file form (`change`, `path`, `lines`, `side`, `message`, `final`, `pr_body`, `plan`,
  `severity`, `body`, `suggestion`).
- `PUT …/rounds/:n/draft` (verdict and summary, saved as they're written), `DELETE …/draft`
  (discard), `POST …/draft/submit` (record it as a review).
- `POST /api/features/:slug/threads/:id/replies` (`action`, `body`): like `lr reply`. The round view
  lists each thread's `actions`: what the actor may do to it now.

Writes push `changed` to other open pages too, since the server's own writes don't move
`data_version` for its own connection.

**Commenting.** Lines are picked the same way in a diff and in a text (a commit message, a final
commit's message, the PR body): click a line number, drag across several, or shift-click to
extend. The form follows the last picked line and keeps what's written; a suggestion that wasn't
edited follows the pick. A final round shows each final commit's message and the PR body line by
line, so they take comments like a change's message does.

**The plan.** A round's plan page shows the plan version it was taken against, phase by phase:
each task with the changes whose `Plan-Task` names it (or none), the phase's changes that name no
task, and below, anything outside the plan. Phase comments go there, and so do plan comments: the
plan file shows as numbered lines while the round takes comments, with a rendered preview. The body is rendered as
GitHub-flavored markdown (tables, task lists, strikethrough) by `react-markdown`, which builds React
elements: raw HTML shows as text, unsafe link schemes are dropped, and images become links, so
nothing is fetched until someone clicks. Other versions can be read,
each with a line diff from the one before, but only the round's version shows coverage or takes
comments, since those are on the round's phases.

**Markdown.** Comments, replies, review summaries, and the PR body's preview render as markdown
like the plan, with each newline a line break, as GitHub treats comments and PR descriptions. The
PR body shows as numbered lines while its round takes comments (they go on lines), and rendered
otherwise; a toggle switches. Suggestions and commit messages stay plain text.

**Syntax highlighting.** Diffs, and fenced code blocks with a language, are highlighted with Shiki
(`src/web/highlight.ts`) in GitHub's light and dark themes:

- **Colors.** Each token carries both themes' colors as CSS variables, and `style.css` picks one
  with `prefers-color-scheme`. Highlighting only sets the text's color and font style, so a row's
  background still shows added, removed, commented and picked lines.
- **Grammars.** A file's grammar comes from its extension or name, and a code block's from its
  fence. Anything else stays plain. The grammars are bundled into the page, since Bun's HTML
  bundling doesn't split `import()`. Each is compiled the first time it's used.
- **Hunks.** A hunk's old side (context and removed lines) and its new side (context and added
  lines) are each highlighted as one text, then split back into rows. So a block comment or a
  string that spans lines within the hunk colors correctly. One that starts above the hunk can't,
  since the API serves only the patch, not the whole file.
- **It never holds up the page:**
  - a diff shows plain, and colors a hunk at a time once its file is open, yielding between hunks;
  - a code block shows plain until its highlight is ready;
  - files over 5,000 diff lines, and lines over 1,000 characters, stay plain.
- **Caching.** Results are cached by language and text, since the page refetches what it shows
  after every write.

**Since an earlier round.** A round can show only what changed since an earlier one: by default
the last round the actor reviewed (the round view's `lastReviewed`), else the one before. It's
`?since=<n>` in the address, and off unless asked for. The sidebar marks each change changed, new,
or the same, with a changed change's stats taken from its interdiff, and lists the changes removed
since. A changed change shows its interdiff and its message edit; a new one, and one whose earlier
commit is gone, show their whole diff. An interdiff's new side is the change's own new side, so
comments go on its new lines exactly as on the whole diff. Its old side is the earlier commit,
rebased, so it takes no comments, and old-side comments aren't placed on it. A comment on lines an
interdiff doesn't show is listed above its file; one on a file it doesn't show, with the change.

**Which threads a round shows, and where.** The latest round shows the threads placed in it, every
unsettled one, and any with activity in it. Outdated threads stay anchored in the round where they
were last found, so these can point into an earlier round. An earlier round shows the threads made
in it, where they were made; where they were carried later isn't recorded. A code comment goes
inline only in the diff it was made in: the change's own diff. Comments made in a phase's or the
stack's combined diff have that diff's line numbers, and outdated ones point at code that has
changed, so both are listed with their change, with their snippet. A thread whose change has left
the stack is listed on the round's overview.
