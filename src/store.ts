import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatActor, parseActor } from "./actor.ts";
import { LrError } from "./errors.ts";
import type {
  Actor,
  ChangeSnapshot,
  CheckRun,
  CheckStatus,
  Feature,
  FeatureStatus,
  Phase,
  PlanVersion,
  Round,
  RoundStatus,
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
];

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

  latestRound(slug: string): Round | null {
    const row = this.db
      .query("SELECT * FROM rounds WHERE feature = ? ORDER BY n DESC LIMIT 1")
      .get(slug) as RoundRow | null;
    return row ? this.roundFromRow(row) : null;
  }

  /**
   * Open a new round. Any round still open is marked superseded. Returns the new round and the
   * number of the round it superseded, if any.
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
  ): { round: Round; superseded: number | null } {
    return this.db.transaction(() => {
      const open = this.db
        .query("SELECT n FROM rounds WHERE feature = ? AND status = 'open'")
        .get(slug) as { n: number } | null;
      if (open) {
        this.db
          .query("UPDATE rounds SET status = 'superseded' WHERE feature = ? AND n = ?")
          .run(slug, open.n);
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
      return { round, superseded: open?.n ?? null };
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
