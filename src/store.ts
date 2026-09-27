import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatActor, parseActor } from "./actor.ts";
import { LrError } from "./errors.ts";
import type {
  Actor,
  Anchor,
  ChangeSnapshot,
  CheckRun,
  CheckStatus,
  Entry,
  Feature,
  FeatureStatus,
  Phase,
  PlanVersion,
  Review,
  Round,
  RoundStatus,
  Severity,
  Thread,
  ThreadStatus,
  Verdict,
} from "./model.ts";
import { repoDir } from "./paths.ts";

// Append-only list; the index + 1 is the schema version stored in `user_version`.
const MIGRATIONS = [
  `
  CREATE TABLE features (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    base_revset TEXT NOT NULL,
    status TEXT NOT NULL,
    current_plan_version INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE plan_versions (
    feature TEXT NOT NULL REFERENCES features(slug) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    phases TEXT NOT NULL,
    responds_to_round INTEGER,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (feature, version)
  );
  CREATE TABLE rounds (
    feature TEXT NOT NULL REFERENCES features(slug) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    jj_op_id TEXT NOT NULL,
    plan_version INTEGER NOT NULL,
    base_commit_id TEXT NOT NULL,
    status TEXT NOT NULL,
    verdict TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (feature, n)
  );
  CREATE TABLE round_changes (
    feature TEXT NOT NULL,
    round INTEGER NOT NULL,
    position INTEGER NOT NULL,
    change_id TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    description TEXT NOT NULL,
    trailers TEXT NOT NULL,
    phase_id INTEGER,
    bookmarks TEXT NOT NULL,
    conflicted INTEGER NOT NULL,
    empty INTEGER NOT NULL,
    files INTEGER NOT NULL,
    added INTEGER NOT NULL,
    removed INTEGER NOT NULL,
    PRIMARY KEY (feature, round, position),
    FOREIGN KEY (feature, round) REFERENCES rounds(feature, n) ON DELETE CASCADE
  );
  -- Check runs are keyed by commit, not round: a passing result is reused by any later round
  -- whose commit and command are unchanged. round_checks links runs to the rounds that used them.
  CREATE TABLE check_runs (
    id TEXT PRIMARY KEY,
    feature TEXT NOT NULL REFERENCES features(slug) ON DELETE CASCADE,
    check_name TEXT NOT NULL,
    command TEXT NOT NULL,
    change_id TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    log_path TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX check_runs_by_commit ON check_runs(feature, commit_id, check_name);
  CREATE TABLE round_checks (
    feature TEXT NOT NULL,
    round INTEGER NOT NULL,
    check_run_id TEXT NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
    PRIMARY KEY (feature, round, check_run_id),
    FOREIGN KEY (feature, round) REFERENCES rounds(feature, n) ON DELETE CASCADE
  );
  `,
  `
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY,
    feature TEXT NOT NULL,
    round INTEGER NOT NULL,
    reviewer TEXT NOT NULL,
    state TEXT NOT NULL,
    verdict TEXT,
    body TEXT,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    FOREIGN KEY (feature, round) REFERENCES rounds(feature, n) ON DELETE CASCADE
  );
  CREATE INDEX reviews_by_round ON reviews(feature, round);
  -- Threads belong to the feature, not a round: they carry across rounds and get re-anchored.
  CREATE TABLE threads (
    feature TEXT NOT NULL REFERENCES features(slug) ON DELETE CASCADE,
    id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    anchor TEXT NOT NULL,
    severity TEXT,
    status TEXT NOT NULL,
    anchor_state TEXT NOT NULL,
    review_id TEXT REFERENCES reviews(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_in_round INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (feature, id)
  );
  CREATE TABLE thread_entries (
    id TEXT PRIMARY KEY,
    feature TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    suggestion TEXT,
    status_from TEXT,
    status_to TEXT,
    round INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (feature, thread_id) REFERENCES threads(feature, id) ON DELETE CASCADE
  );
  CREATE INDEX thread_entries_by_thread ON thread_entries(feature, thread_id, created_at);
  `,
];

export interface NewComment {
  anchor: Anchor;
  severity: Severity | null;
  body: string;
  suggestion: string | null;
  status: ThreadStatus;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: Database;

  private constructor(
    readonly root: string,
    readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "state.db"), { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  static async open(root: string): Promise<Store> {
    const dir = repoDir(root);
    const store = new Store(root, dir);
    const repoJson = Bun.file(join(dir, "repo.json"));
    if (!(await repoJson.exists())) {
      await Bun.write(repoJson, `${JSON.stringify({ root, createdAt: now() }, null, 2)}\n`);
    }
    return store;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version } = this.db.query("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.run(MIGRATIONS[v]!);
        this.db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  // ── features ──────────────────────────────────────────────────────────────

  createFeature(f: { slug: string; title: string; baseRevset: string }): Feature {
    if (this.getFeature(f.slug)) throw new LrError(`feature "${f.slug}" already exists`);
    const feature: Feature = {
      ...f,
      status: "planning",
      currentPlanVersion: null,
      createdAt: now(),
    };
    this.db
      .query(
        `INSERT INTO features (slug, title, base_revset, status, current_plan_version, created_at)
         VALUES ($slug, $title, $base, $status, NULL, $created)`,
      )
      .run({
        slug: feature.slug,
        title: feature.title,
        base: feature.baseRevset,
        status: feature.status,
        created: feature.createdAt,
      });
    return feature;
  }

  getFeature(slug: string): Feature | null {
    const row = this.db
      .query("SELECT * FROM features WHERE slug = ?")
      .get(slug) as FeatureRow | null;
    return row ? featureFromRow(row) : null;
  }

  listFeatures(): Feature[] {
    const rows = this.db.query("SELECT * FROM features ORDER BY created_at").all() as FeatureRow[];
    return rows.map(featureFromRow);
  }

  setFeatureStatus(slug: string, status: FeatureStatus): void {
    this.db.query("UPDATE features SET status = ? WHERE slug = ?").run(status, slug);
  }

  // ── plans ─────────────────────────────────────────────────────────────────

  addPlanVersion(
    slug: string,
    p: { phases: Phase[]; respondsToRound: number | null; createdBy: Actor },
  ): PlanVersion {
    return this.db.transaction(() => {
      const { next } = this.db
        .query("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plan_versions WHERE feature = ?")
        .get(slug) as { next: number };
      // Relative to the feature dir; the caller writes the file.
      const plan: PlanVersion = { version: next, path: `plan/v${next}.md`, ...p, createdAt: now() };
      this.db
        .query(
          `INSERT INTO plan_versions (feature, version, path, phases, responds_to_round, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slug,
          plan.version,
          plan.path,
          JSON.stringify(plan.phases),
          plan.respondsToRound,
          formatActor(plan.createdBy),
          plan.createdAt,
        );
      this.db.query("UPDATE features SET current_plan_version = ? WHERE slug = ?").run(next, slug);
      return plan;
    })();
  }

  getPlanVersion(slug: string, version: number): PlanVersion | null {
    const row = this.db
      .query("SELECT * FROM plan_versions WHERE feature = ? AND version = ?")
      .get(slug, version) as PlanRow | null;
    return row ? planFromRow(row) : null;
  }

  // ── rounds ────────────────────────────────────────────────────────────────

  getRound(slug: string, n: number): Round | null {
    const row = this.db
      .query("SELECT * FROM rounds WHERE feature = ? AND n = ?")
      .get(slug, n) as RoundRow | null;
    return row ? this.roundFromRow(row) : null;
  }

  latestRound(slug: string): Round | null {
    const row = this.db
      .query("SELECT * FROM rounds WHERE feature = ? ORDER BY n DESC LIMIT 1")
      .get(slug) as RoundRow | null;
    return row ? this.roundFromRow(row) : null;
  }

  /**
   * Open a new round. A round still open is replaced: `closed` if it was reviewed, `superseded`
   * if nobody got to it. Returns the new round and what happened to the one it replaced.
   */
  createRound(
    slug: string,
    r: {
      jjOpId: string;
      planVersion: number;
      baseCommitId: string;
      changes: ChangeSnapshot[];
      checkRunIds: string[];
      createdBy: Actor;
    },
  ): { round: Round; replaced: { n: number; status: RoundStatus } | null } {
    return this.db.transaction(() => {
      const open = this.db
        .query(
          `SELECT n, EXISTS (
             SELECT 1 FROM reviews r WHERE r.feature = rounds.feature AND r.round = rounds.n
               AND r.state = 'submitted'
           ) AS reviewed
           FROM rounds WHERE feature = ? AND status = 'open'`,
        )
        .get(slug) as { n: number; reviewed: number } | null;
      const replaced = open
        ? { n: open.n, status: (open.reviewed ? "closed" : "superseded") as RoundStatus }
        : null;
      if (replaced) {
        this.db
          .query("UPDATE rounds SET status = ? WHERE feature = ? AND n = ?")
          .run(replaced.status, slug, replaced.n);
      }
      const { next } = this.db
        .query("SELECT COALESCE(MAX(n), 0) + 1 AS next FROM rounds WHERE feature = ?")
        .get(slug) as { next: number };
      const round: Round = {
        n: next,
        jjOpId: r.jjOpId,
        planVersion: r.planVersion,
        baseCommitId: r.baseCommitId,
        changes: r.changes,
        status: "open",
        verdict: null,
        createdBy: r.createdBy,
        createdAt: now(),
      };
      this.db
        .query(
          `INSERT INTO rounds (feature, n, jj_op_id, plan_version, base_commit_id, status, verdict, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
        )
        .run(
          slug,
          round.n,
          round.jjOpId,
          round.planVersion,
          round.baseCommitId,
          formatActor(round.createdBy),
          round.createdAt,
        );

      const insertChange = this.db.query(
        `INSERT INTO round_changes (feature, round, position, change_id, commit_id, description, trailers,
           phase_id, bookmarks, conflicted, empty, files, added, removed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [i, c] of r.changes.entries()) {
        insertChange.run(
          slug,
          round.n,
          i,
          c.changeId,
          c.commitId,
          c.description,
          JSON.stringify(c.trailers),
          c.phaseId,
          JSON.stringify(c.bookmarks),
          c.conflicted ? 1 : 0,
          c.empty ? 1 : 0,
          c.stats.files,
          c.stats.added,
          c.stats.removed,
        );
      }

      const link = this.db.query(
        "INSERT INTO round_checks (feature, round, check_run_id) VALUES (?, ?, ?)",
      );
      for (const id of r.checkRunIds) link.run(slug, round.n, id);

      this.setFeatureStatus(slug, "in_review");
      return { round, replaced };
    })();
  }

  private roundFromRow(row: RoundRow): Round {
    const changes = (
      this.db
        .query("SELECT * FROM round_changes WHERE feature = ? AND round = ? ORDER BY position")
        .all(row.feature, row.n) as ChangeRow[]
    ).map(changeFromRow);
    return {
      n: row.n,
      jjOpId: row.jj_op_id,
      planVersion: row.plan_version,
      baseCommitId: row.base_commit_id,
      changes,
      status: row.status as RoundStatus,
      verdict: row.verdict as Round["verdict"],
      createdBy: parseActor(row.created_by),
      createdAt: row.created_at,
    };
  }

  // ── checks ────────────────────────────────────────────────────────────────

  /** Most recent passing run of this check+command at this exact commit, if any. */
  findPassingCheck(
    slug: string,
    check: string,
    command: string,
    commitId: string,
  ): CheckRun | null {
    const row = this.db
      .query(
        `SELECT * FROM check_runs
         WHERE feature = ? AND check_name = ? AND command = ? AND commit_id = ? AND status = 'pass'
         ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(slug, check, command, commitId) as CheckRow | null;
    return row ? checkFromRow(row) : null;
  }

  insertCheckRun(slug: string, run: CheckRun): void {
    this.db
      .query(
        `INSERT INTO check_runs (id, feature, check_name, command, change_id, commit_id, trigger, status,
           exit_code, log_path, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        slug,
        run.check,
        run.command,
        run.changeId,
        run.commitId,
        run.trigger,
        run.status,
        run.exitCode,
        run.logPath,
        run.startedAt,
        run.finishedAt,
      );
  }

  updateCheckRun(
    id: string,
    u: { status: CheckStatus; exitCode?: number | null; startedAt?: string; finishedAt?: string },
  ): void {
    this.db
      .query(
        `UPDATE check_runs SET status = ?,
           exit_code = COALESCE(?, exit_code),
           started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at)
         WHERE id = ?`,
      )
      .run(u.status, u.exitCode ?? null, u.startedAt ?? null, u.finishedAt ?? null, id);
  }

  roundChecks(slug: string, n: number): CheckRun[] {
    const rows = this.db
      .query(
        `SELECT c.* FROM check_runs c JOIN round_checks rc ON rc.check_run_id = c.id
         WHERE rc.feature = ? AND rc.round = ? ORDER BY c.started_at`,
      )
      .all(slug, n) as CheckRow[];
    return rows.map(checkFromRow);
  }

  // ── reviews & threads ─────────────────────────────────────────────────────

  /**
   * Record a submitted review and its comments (one new thread each). A human's verdict becomes
   * the round's verdict.
   */
  submitReview(
    slug: string,
    r: {
      round: number;
      reviewer: Actor;
      verdict: Verdict | null;
      body: string | null;
      comments: NewComment[];
    },
  ): { review: Review; threads: Thread[] } {
    return this.db.transaction(() => {
      const at = now();
      const review: Review = {
        id: Bun.randomUUIDv7(),
        round: r.round,
        reviewer: r.reviewer,
        state: "submitted",
        verdict: r.verdict,
        body: r.body,
        createdAt: at,
        submittedAt: at,
      };
      this.db
        .query(
          `INSERT INTO reviews (id, feature, round, reviewer, state, verdict, body, created_at, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          review.id,
          slug,
          review.round,
          formatActor(review.reviewer),
          review.state,
          review.verdict,
          review.body,
          review.createdAt,
          review.submittedAt,
        );

      let { next } = this.db
        .query("SELECT COALESCE(MAX(id), 0) + 1 AS next FROM threads WHERE feature = ?")
        .get(slug) as { next: number };
      const insertThread = this.db.query(
        `INSERT INTO threads (feature, id, kind, anchor, severity, status, anchor_state, review_id,
           created_by, created_in_round, created_at)
         VALUES (?, ?, 'comment', ?, ?, ?, 'current', ?, ?, ?, ?)`,
      );
      const threads: Thread[] = r.comments.map((c) => {
        const thread: Thread = {
          id: next++,
          kind: "comment",
          anchor: c.anchor,
          severity: c.severity,
          status: c.status,
          anchorState: "current",
          reviewId: review.id,
          createdBy: r.reviewer,
          createdInRound: r.round,
          createdAt: at,
          entries: [
            {
              id: Bun.randomUUIDv7(),
              author: r.reviewer,
              body: c.body,
              suggestion: c.suggestion,
              statusChange: null,
              round: r.round,
              createdAt: at,
            },
          ],
        };
        insertThread.run(
          slug,
          thread.id,
          JSON.stringify(thread.anchor),
          thread.severity,
          thread.status,
          review.id,
          formatActor(thread.createdBy),
          thread.createdInRound,
          at,
        );
        this.insertEntry(slug, thread.id, thread.entries[0]!);
        return thread;
      });

      // Only a human's verdict decides the round, and it hands the feature back to the author.
      if (r.reviewer.kind === "human" && r.verdict) {
        this.db
          .query("UPDATE rounds SET verdict = ? WHERE feature = ? AND n = ?")
          .run(r.verdict, slug, r.round);
        this.setFeatureStatus(slug, r.verdict === "approved" ? "finalizing" : "revising");
      }
      return { review, threads };
    })();
  }

  private insertEntry(slug: string, threadId: number, e: Entry): void {
    this.db
      .query(
        `INSERT INTO thread_entries (id, feature, thread_id, author, body, suggestion, status_from,
           status_to, round, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        slug,
        threadId,
        formatActor(e.author),
        e.body,
        e.suggestion,
        e.statusChange?.from ?? null,
        e.statusChange?.to ?? null,
        e.round,
        e.createdAt,
      );
  }

  listReviews(slug: string, round: number): Review[] {
    const rows = this.db
      .query("SELECT * FROM reviews WHERE feature = ? AND round = ? ORDER BY created_at")
      .all(slug, round) as ReviewRow[];
    return rows.map(reviewFromRow);
  }

  /** Threads in id order, with their entries. */
  listThreads(slug: string): Thread[] {
    const rows = this.db
      .query("SELECT * FROM threads WHERE feature = ? ORDER BY id")
      .all(slug) as ThreadRow[];
    return rows.map((row) => this.withEntries(slug, row));
  }

  getThread(slug: string, id: number): Thread | null {
    const row = this.db
      .query("SELECT * FROM threads WHERE feature = ? AND id = ?")
      .get(slug, id) as ThreadRow | null;
    return row ? this.withEntries(slug, row) : null;
  }

  /** Add an entry to a thread, applying its status change (if any). */
  addEntry(slug: string, threadId: number, entry: Entry): Thread {
    return this.db.transaction(() => {
      this.insertEntry(slug, threadId, entry);
      if (entry.statusChange) {
        this.db
          .query("UPDATE threads SET status = ? WHERE feature = ? AND id = ?")
          .run(entry.statusChange.to, slug, threadId);
      }
      return this.getThread(slug, threadId)!;
    })();
  }

  private withEntries(slug: string, row: ThreadRow): Thread {
    const entries = this.db
      .query(
        "SELECT * FROM thread_entries WHERE feature = ? AND thread_id = ? ORDER BY created_at, id",
      )
      .all(slug, row.id) as EntryRow[];
    return threadFromRow(row, entries.map(entryFromRow));
  }
}

// ── row mapping ─────────────────────────────────────────────────────────────

interface FeatureRow {
  slug: string;
  title: string;
  base_revset: string;
  status: string;
  current_plan_version: number | null;
  created_at: string;
}
function featureFromRow(r: FeatureRow): Feature {
  return {
    slug: r.slug,
    title: r.title,
    baseRevset: r.base_revset,
    status: r.status as FeatureStatus,
    currentPlanVersion: r.current_plan_version,
    createdAt: r.created_at,
  };
}

interface PlanRow {
  version: number;
  path: string;
  phases: string;
  responds_to_round: number | null;
  created_by: string;
  created_at: string;
}
function planFromRow(r: PlanRow): PlanVersion {
  return {
    version: r.version,
    path: r.path,
    phases: JSON.parse(r.phases) as Phase[],
    respondsToRound: r.responds_to_round,
    createdBy: parseActor(r.created_by),
    createdAt: r.created_at,
  };
}

interface RoundRow {
  feature: string;
  n: number;
  jj_op_id: string;
  plan_version: number;
  base_commit_id: string;
  status: string;
  verdict: string | null;
  created_by: string;
  created_at: string;
}

interface ChangeRow {
  change_id: string;
  commit_id: string;
  description: string;
  trailers: string;
  phase_id: number | null;
  bookmarks: string;
  conflicted: number;
  empty: number;
  files: number;
  added: number;
  removed: number;
}
function changeFromRow(r: ChangeRow): ChangeSnapshot {
  return {
    changeId: r.change_id,
    commitId: r.commit_id,
    description: r.description,
    trailers: JSON.parse(r.trailers) as [string, string][],
    phaseId: r.phase_id,
    bookmarks: JSON.parse(r.bookmarks) as string[],
    conflicted: r.conflicted === 1,
    empty: r.empty === 1,
    stats: { files: r.files, added: r.added, removed: r.removed },
  };
}

interface CheckRow {
  id: string;
  check_name: string;
  command: string;
  change_id: string;
  commit_id: string;
  trigger: string;
  status: string;
  exit_code: number | null;
  log_path: string;
  started_at: string | null;
  finished_at: string | null;
}
function checkFromRow(r: CheckRow): CheckRun {
  return {
    id: r.id,
    check: r.check_name,
    command: r.command,
    changeId: r.change_id,
    commitId: r.commit_id,
    trigger: r.trigger as CheckRun["trigger"],
    status: r.status as CheckStatus,
    exitCode: r.exit_code,
    logPath: r.log_path,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

interface ReviewRow {
  id: string;
  round: number;
  reviewer: string;
  state: string;
  verdict: string | null;
  body: string | null;
  created_at: string;
  submitted_at: string | null;
}
function reviewFromRow(r: ReviewRow): Review {
  return {
    id: r.id,
    round: r.round,
    reviewer: parseActor(r.reviewer),
    state: r.state as Review["state"],
    verdict: r.verdict as Verdict | null,
    body: r.body,
    createdAt: r.created_at,
    submittedAt: r.submitted_at,
  };
}

interface ThreadRow {
  id: number;
  kind: string;
  anchor: string;
  severity: string | null;
  status: string;
  anchor_state: string;
  review_id: string | null;
  created_by: string;
  created_in_round: number | null;
  created_at: string;
}
function threadFromRow(r: ThreadRow, entries: Entry[]): Thread {
  return {
    id: r.id,
    kind: r.kind as Thread["kind"],
    anchor: JSON.parse(r.anchor) as Anchor,
    severity: r.severity as Severity | null,
    status: r.status as ThreadStatus,
    anchorState: r.anchor_state as Thread["anchorState"],
    reviewId: r.review_id,
    createdBy: parseActor(r.created_by),
    createdInRound: r.created_in_round,
    createdAt: r.created_at,
    entries,
  };
}

interface EntryRow {
  id: string;
  author: string;
  body: string;
  suggestion: string | null;
  status_from: string | null;
  status_to: string | null;
  round: number | null;
  created_at: string;
}
function entryFromRow(r: EntryRow): Entry {
  return {
    id: r.id,
    author: parseActor(r.author),
    body: r.body,
    suggestion: r.suggestion,
    statusChange:
      r.status_from && r.status_to
        ? { from: r.status_from as ThreadStatus, to: r.status_to as ThreadStatus }
        : null,
    round: r.round,
    createdAt: r.created_at,
  };
}
