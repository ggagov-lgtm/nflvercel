import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUser } from "@/lib/auth";
import week2Preview from "@/data/week2-preview.json";

type AnyObj = Record<string, any>;

type Pred = {
  id: string;
  season: number;
  week: number;
  event_id: string;
  game: AnyObj;
  market: AnyObj;
  model: AnyObj;
  model_version: string;
  prediction_run_at: string;
  locked_at: string;
};

function pct(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—";
}

function num(v: any, digits = 1) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function signed(v: any, digits = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function american(v: any) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

function dateLabel(v?: string) {
  if (!v) return "Schedule pending";

  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
      timeZoneName: "short",
    }).format(new Date(v));
  } catch {
    return v;
  }
}

function confidenceClass(rank: number) {
  if (rank === 0) return "pick pickBest";
  if (rank === 1) return "pick pickSecond";
  return "pick pickThird";
}

type LiveGame = {
  date?: string;
  state: "pre" | "in" | "post";
  detail?: string;
  homeScore?: number;
  awayScore?: number;
};

async function getEspnGameStates(season: number, week: number) {
  try {
    const url =
      `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&week=${week}&seasontype=2`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return new Map<string, LiveGame>();
    const json = await res.json();
    const out = new Map<string, LiveGame>();

    for (const event of json.events || []) {
      const comp = event.competitions?.[0];
      const home = comp?.competitors?.find((x: AnyObj) => x.homeAway === "home");
      const away = comp?.competitors?.find((x: AnyObj) => x.homeAway === "away");
      out.set(String(event.id), {
        date: event.date,
        state: event.status?.type?.state || "pre",
        detail: event.status?.type?.shortDetail || event.status?.type?.detail,
        homeScore: Number.isFinite(Number(home?.score)) ? Number(home.score) : undefined,
        awayScore: Number.isFinite(Number(away?.score)) ? Number(away.score) : undefined,
      });
    }
    return out;
  } catch {
    return new Map<string, LiveGame>();
  }
}

function resultClass(result?: string) {
  if (result === "WIN") return "resultWin";
  if (result === "LOSS") return "resultLoss";
  if (result === "PUSH") return "resultPush";
  return "";
}

function resultLabel(result?: string) {
  if (result === "WIN") return "✓ WON";
  if (result === "LOSS") return "✕ LOST";
  if (result === "PUSH") return "— PUSH";
  return "";
}

export default async function Page() {
  const user = await currentUser();
  if (!user) redirect("/auth/login");

  const s = await createClient();

  const { data: perf } = await s
    .from("model_performance_season")
    .select("*")
    .order("season", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: latest } = await s
    .from("predictions")
    .select("season,week")
    .order("season", { ascending: false })
    .order("week", { ascending: false })
    .limit(1)
    .maybeSingle();

  let preds: Pred[] = [];
  let displayLatest: { season: number; week: number } | null = latest;
  let previewMode = false;

  if (latest) {
    const { data } = await s
      .from("predictions")
      .select("*")
      .eq("season", latest.season)
      .eq("week", latest.week)
      .order("locked_at");

    preds = (data || []) as Pred[];
  } else {
    preds = week2Preview.games as unknown as Pred[];
    displayLatest = { season: week2Preview.season, week: week2Preview.week };
    previewMode = true;
  }

  const gameStates = displayLatest
    ? await getEspnGameStates(displayLatest.season, displayLatest.week)
    : new Map<string, LiveGame>();

  const modelVersion =
    preds[0]?.model_version || "v2.0.0";

  const simulationCount =
    preds[0]?.model?.simulations || 50000;

  return (
    <main className="dashboard">
      <section className="hero">
        <div>
          <div className="eyebrow">
            NFL QUANTITATIVE ENGINE
          </div>

          <h1>
            {displayLatest
              ? `${displayLatest.season} · Week ${displayLatest.week}`
              : "NFL Quant Model"}
          </h1>

          <p className="heroText">
            Market-anchored football modeling, contextual
            adjustments and Monte Carlo simulation.
          </p>
        </div>

        <div className="heroStatus">
          <div className="statusDot" />
          <div>
            <strong>
              {previewMode
                ? "Week 2 Model Preview"
                : latest
                  ? "Predictions Locked"
                  : "Awaiting First Official Run"}
            </strong>
            <span>
              {simulationCount.toLocaleString()} simulations/game
            </span>
          </div>
        </div>
      </section>

      <section className="performance">
        <div className="metric">
          <span>ML ACCURACY</span>
          <b>{pct(perf?.ml_accuracy)}</b>
          <small>Season</small>
        </div>

        <div className="metric">
          <span>ATS ACCURACY</span>
          <b>{pct(perf?.spread_accuracy)}</b>
          <small>Spread</small>
        </div>

        <div className="metric">
          <span>TOTAL ACCURACY</span>
          <b>{pct(perf?.total_accuracy)}</b>
          <small>O/U</small>
        </div>

        <div className="metric">
          <span>#1 PICK</span>
          <b>{pct(perf?.top_pick_accuracy)}</b>
          <small>Highest confidence</small>
        </div>

        <div className="metric">
          <span>SCORE MAE</span>
          <b>{num(perf?.score_mae)}</b>
          <small>Points</small>
        </div>

        <div className="metric">
          <span>MODEL</span>
          <b>{modelVersion}</b>
          <small>Frozen architecture</small>
        </div>
      </section>

      <section className="sectionBar">
        <div>
          <span className="sectionKicker">
            WEEKLY BOARD
          </span>
          <h2>
            {previewMode
              ? `${preds.length} Display-Only Games`
              : latest
                ? `${preds.length} Locked Games`
                : "No locked predictions yet"}
          </h2>
        </div>

        <div className="legend">
          <span>
            <i className="legendBest" />
            Highest
          </span>
          <span>
            <i className="legendSecond" />
            Second
          </span>
          <span>
            <i className="legendThird" />
            Third
          </span>
        </div>
      </section>

      {!preds.length && (
        <section className="emptyState panel">
          <div className="lockIcon">🔒</div>
          <h2>Production pipeline ready</h2>
          <p>
            The dashboard will populate automatically after
            the first official weekly model run.
          </p>
        </section>
      )}

      <section className="games">
        {preds.map((p) => {
          const g = p.game || {};
          const m = p.market || {};
          const x = p.model || {};
          const live = gameStates.get(String(p.event_id));
          const state = live?.state || "pre";
          const isLive = state === "in";
          const isFinal = state === "post";
          const displayDate = live?.date || g.date;

          const hp = Number(x.home_win_prob);
          const ap = Number(x.away_win_prob);

          const homeML = hp >= ap;
          const mlProb = homeML ? hp : ap;
          const mlTeam = homeML
            ? g.home?.abbr
            : g.away?.abbr;

          const fairHome =
            Number(x.market_fair_home_prob);
          const fairAway =
            Number(x.market_fair_away_prob);

          const mlEdge = homeML
            ? hp - fairHome
            : ap - fairAway;

          const hc = Number(x.home_cover_prob);
          const ac = Number(x.away_cover_prob);
          const spreadHome = hc >= ac;
          const spreadProb = spreadHome ? hc : ac;
          const spreadTeam = spreadHome
            ? g.home?.abbr
            : g.away?.abbr;

          const overProb = Number(x.over_prob);
          const underProb = Number(x.under_prob);
          const isOver = overProb >= underProb;
          const totalProb = isOver
            ? overProb
            : underProb;

          const marketMargin =
            Number(x.market_margin);
          const modelMargin =
            Number(x.model_margin);

          const spreadEdge = spreadHome
            ? modelMargin - marketMargin
            : marketMargin - modelMargin;

          const marketTotal =
            Number(x.market_total ?? m.total);
          const modelTotal =
            Number(x.model_total);

          const totalEdge = isOver
            ? modelTotal - marketTotal
            : marketTotal - modelTotal;

          const finalHome = live?.homeScore;
          const finalAway = live?.awayScore;
          const finalMargin =
            isFinal && finalHome != null && finalAway != null
              ? finalHome - finalAway
              : null;
          const finalTotal =
            isFinal && finalHome != null && finalAway != null
              ? finalHome + finalAway
              : null;

          const gradeML = () => {
            if (!isFinal || finalMargin == null) return undefined;
            if (finalMargin === 0) return "PUSH";
            const actualHomeWin = finalMargin > 0;
            return actualHomeWin === homeML ? "WIN" : "LOSS";
          };

          const gradeSpread = () => {
            if (!isFinal || finalMargin == null || !Number.isFinite(marketMargin)) return undefined;
            const diff = finalMargin - marketMargin;
            if (diff === 0) return "PUSH";
            return (spreadHome ? diff > 0 : diff < 0) ? "WIN" : "LOSS";
          };

          const gradeTotal = () => {
            if (!isFinal || finalTotal == null || !Number.isFinite(marketTotal)) return undefined;
            if (finalTotal === marketTotal) return "PUSH";
            return (isOver ? finalTotal > marketTotal : finalTotal < marketTotal) ? "WIN" : "LOSS";
          };

          const picks = [
            {
              key: "ml",
              label: "MONEYLINE",
              selection: mlTeam || "—",
              probability: mlProb,
              edge: mlEdge,
              market: homeML
                ? american(m.home_ml)
                : american(m.away_ml),
              result: gradeML(),
            },
            {
              key: "spread",
              label: "SPREAD",
              selection: spreadTeam || "—",
              probability: spreadProb,
              edge: spreadEdge,
              market:
                Number.isFinite(Number(m.spread))
                  ? signed(m.spread)
                  : "—",
              result: gradeSpread(),
            },
            {
              key: "total",
              label: "TOTAL",
              selection: `${isOver ? "OVER" : "UNDER"} ${
                Number.isFinite(marketTotal)
                  ? marketTotal.toFixed(1)
                  : "—"
              }`,
              probability: totalProb,
              edge: totalEdge,
              market:
                Number.isFinite(marketTotal)
                  ? marketTotal.toFixed(1)
                  : "—",
              result: gradeTotal(),
            },
          ].sort(
            (a, b) =>
              Number(b.probability) -
              Number(a.probability)
          );

          return (
            <article
              className={`gameCard ${isFinal ? "gameFinal" : ""} ${isLive ? "gameLive" : ""}`}
              key={p.id}
            >
              <header className="gameTop">
                <div>
                  <span className="gameTime">
                    {isLive ? live?.detail || "LIVE" : isFinal ? `FINAL · ${dateLabel(displayDate)}` : dateLabel(displayDate)}
                  </span>
                  <span className="book">
                    {m.provider || "ESPN"}
                  </span>
                </div>

                <span className="locked">
                  {isLive ? "● LIVE" : isFinal ? "FINAL" : previewMode ? "PREVIEW" : "🔒 LOCKED"}
                </span>
              </header>

              <div className="matchup">
                <div className="teamBlock">
                  <img
                    src={g.away?.logo || ""}
                    alt=""
                  />
                  <div>
                    <strong>
                      {g.away?.abbr || "AWAY"}
                    </strong>
                    <span>
                      {g.away?.name || ""}
                    </span>
                  </div>
                </div>

                <div className="projection">
                  {isFinal || isLive ? (
                    <>
                      <span>{isFinal ? "FINAL SCORE" : "LIVE SCORE"}</span>
                      <div className="actualScore">
                        <b>{finalAway ?? live?.awayScore ?? "—"}</b>
                        <em>—</em>
                        <b>{finalHome ?? live?.homeScore ?? "—"}</b>
                      </div>
                      <small className="modelWas">
                        Model {num(x.pred_away)} — {num(x.pred_home)}
                      </small>
                    </>
                  ) : (
                    <>
                      <span>MODEL SCORE</span>
                      <div className="upcomingModelScore">
                        <b>{num(x.pred_away)}</b>
                        <em>—</em>
                        <b>{num(x.pred_home)}</b>
                      </div>
                    </>
                  )}
                </div>

                <div className="teamBlock teamHome">
                  <div>
                    <strong>
                      {g.home?.abbr || "HOME"}
                    </strong>
                    <span>
                      {g.home?.name || ""}
                    </span>
                  </div>
                  <img
                    src={g.home?.logo || ""}
                    alt=""
                  />
                </div>
              </div>

              <div className="modelStrip">
                <div>
                  <span>MODEL MARGIN</span>
                  <strong>
                    {signed(x.model_margin)}
                  </strong>
                </div>

                <div>
                  <span>MARKET MARGIN</span>
                  <strong>
                    {signed(x.market_margin)}
                  </strong>
                </div>

                <div>
                  <span>MODEL TOTAL</span>
                  <strong>
                    {num(x.model_total)}
                  </strong>
                </div>

                <div>
                  <span>MARKET TOTAL</span>
                  <strong>
                    {num(x.market_total ?? m.total)}
                  </strong>
                </div>
              </div>

              <div className="picks">
                {picks.map((pick, rank) => (
                  <div
                    className={`${confidenceClass(rank)} ${resultClass(pick.result)}`}
                    key={pick.key}
                  >
                    <div className="pickHead">
                      <span>{pick.label}</span>
                      <b>{isFinal && pick.result ? resultLabel(pick.result) : `#${rank + 1}`}</b>
                    </div>

                    <strong className="selection">
                      {pick.selection}
                    </strong>

                    <div className="pickStats">
                      <div>
                        <span>Probability</span>
                        <b>
                          {pct(pick.probability)}
                        </b>
                      </div>

                      <div>
                        <span>
                          {pick.key === "ml"
                            ? "Prob. Edge"
                            : "Point Edge"}
                        </span>
                        <b>
                          {pick.key === "ml"
                            ? pct(pick.edge)
                            : signed(pick.edge)}
                        </b>
                      </div>

                      <div>
                        <span>Market</span>
                        <b>{pick.market}</b>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {isFinal && picks[0]?.result && (
                <div className={`topPickResult ${resultClass(picks[0].result)}`}>
                  #1 PICK · {picks[0].selection} · {pct(picks[0].probability)} · {resultLabel(picks[0].result)}
                </div>
              )}

              <footer className="gameFooter">
                <span>
                  Injury adj{" "}
                  {signed(
                    x.injury_margin_adjustment
                  )}
                </span>

                <span>
                  Context{" "}
                  {signed(
                    x.context_margin_adjustment
                  )}
                </span>

                <span>
                  Weather{" "}
                  {signed(
                    x.weather_total_adjustment
                  )}
                </span>

                <span>
                  {Number(
                    x.simulations || simulationCount
                  ).toLocaleString()}{" "}
                  sims
                </span>
              </footer>
            </article>
          );
        })}
      </section>

      <footer className="modelDisclosure">
        <strong>NFL Quant Model {modelVersion}</strong>
        <span>
          Predictions are generated and locked before the
          weekly slate. Probabilities are model estimates,
          not guarantees. Model edge compares the model with
          the captured sportsbook market.
        </span>
      </footer>
    </main>
  );
}
