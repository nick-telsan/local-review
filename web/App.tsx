import type { FeaturesOk } from "../src/ui/api.ts";
import { useApi } from "./api.ts";
import { RoundPage } from "./RoundPage.tsx";
import { Link, match, usePath } from "./router.tsx";
import { ErrorBox, formatActor, Loading, Pill, timeAgo } from "./ui.tsx";

export function App() {
  const path = usePath();
  const change = match("/f/:slug/r/:n/c/:change", path);
  const round = match("/f/:slug/r/:n", path) ?? match("/f/:slug", path);
  const params = change ?? round;
  return (
    <div className="app">
      {params ? (
        <RoundPage slug={params.slug!} n={params.n ?? "latest"} change={change?.change ?? null} />
      ) : (
        <Features />
      )}
    </div>
  );
}

function Features() {
  const { data, error } = useApi<FeaturesOk>("/features");
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const active = data.features.filter((f) => f.status !== "done" && f.status !== "abandoned");
  const finished = data.features.filter((f) => !active.includes(f));
  return (
    <main className="features">
      <header className="features-header">
        <h1>local-review</h1>
        <p className="muted">
          <span className="mono">{data.root}</span> · reviewing as {formatActor(data.actor)}
        </p>
      </header>
      {data.features.length === 0 && (
        <p className="empty">
          No features yet. Start one with <code>lr feature start &lt;slug&gt;</code>.
        </p>
      )}
      <FeatureSection label="Active" list={active} />
      <FeatureSection label="Finished" list={finished} />
    </main>
  );
}

function FeatureSection({ label, list }: { label: string; list: FeaturesOk["features"] }) {
  if (list.length === 0) return null;
  return (
    <section>
      <h2>{label}</h2>
      <ul className="feature-list">
        {list.map((f) => (
          <li key={f.slug}>
            <Link to={`/f/${encodeURIComponent(f.slug)}`} className="feature-row">
              <span className="feature-title">{f.title}</span>
              <span className="mono muted">{f.slug}</span>
              <Pill kind={f.status}>{f.status.replace("_", " ")}</Pill>
              <span className="muted">
                {f.latestRound
                  ? `round ${f.latestRound.n} · ${timeAgo(f.latestRound.createdAt)}`
                  : "no rounds"}
              </span>
              {f.unsettled > 0 && (
                <span className="count" title="unsettled threads">
                  {f.unsettled}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
