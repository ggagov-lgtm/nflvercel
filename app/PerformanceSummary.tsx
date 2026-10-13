"use client";
import OverallSummary from "./OverallSummary";

type Pick = {
  game: string;
  selection: string;
  type: string;
  confidence: number;
  odds: number | null;
  result: "WIN" | "LOSS" | "PUSH" | "PENDING";
  eventId: string;
  week: number;
};
type Stats = {
  wins: number;
  losses: number;
  pushes: number;
  profit: number | null;
  missingOdds: number;
  estimatedOdds: number;
  settled: number;
  picks: Pick[];
};
type HistoryKey = "top3Winner" | "top3Spread" | "top3Total" | "top3Overall";
type OverallPick = { eventId: string | number; category: string; probability: number; selection: string; logo: string; matchup: string; result?: string };
type Key = "all" | "best" | "top3" | "moneyline" | "spread" | "total";
type Week = { week: number } & Record<Key | HistoryKey, Stats>;

const labels: { key: Key; title: string }[] = [
  { key: "all", title: "All Bets" },
  { key: "best", title: "Best / Game" },
  { key: "top3", title: "Top 3" },
  { key: "moneyline", title: "Moneyline" },
  { key: "spread", title: "Spread" },
  { key: "total", title: "Over/Under" },
];

const historyLabels: { key: HistoryKey; title: string; subtitle: string }[] = [
  { key: "top3Winner", title: "Top 3 Winners", subtitle: "Moneyline" },
  { key: "top3Spread", title: "Top 3 Spreads", subtitle: "Point spread" },
  { key: "top3Total", title: "Top 3 Over/Unders", subtitle: "Game totals" },
];

const money = (n: number | null) =>
  n === null ? "Odds unavailable" : (n < 0 ? "−" : "+") + "$" + Math.abs(n).toFixed(2);

const empty: Stats = {
  wins: 0, losses: 0, pushes: 0, profit: null,
  missingOdds: 0, estimatedOdds: 0, settled: 0, picks: [],
};

function merge(rows: Stats[]): Stats {
  const picks = rows.flatMap(r => r.picks);
  const settled = rows.reduce((n, r) => n + r.settled, 0);
  const missingOdds = rows.reduce((n, r) => n + r.missingOdds, 0);
  const estimatedOdds = rows.reduce((n, r) => n + r.estimatedOdds, 0);
  return {
    wins: rows.reduce((n, r) => n + r.wins, 0),
    losses: rows.reduce((n, r) => n + r.losses, 0),
    pushes: rows.reduce((n, r) => n + r.pushes, 0),
    settled, missingOdds, estimatedOdds, picks,
    profit: settled > 0 && missingOdds === 0 && rows.every(r => r.settled === 0 || r.profit !== null)
      ? rows.reduce((n, r) => n + (r.profit || 0), 0)
      : null,
  };
}

export default function PerformanceSummary({ weeks, currentWeek, season, overallPicks }: {
  weeks: Week[];
  currentWeek: number;
  season: number;
  overallPicks: OverallPick[];
}) {
  const ordered = [...weeks].sort((a, b) => b.week - a.week);
  // Last Week means the previous NFL week, not a partially played current week.
  const previousWeek = ordered.find(w => w.week === currentWeek - 1 && w.all.settled > 0);
  const gradedWeeks = ordered.filter(w => w.all.settled > 0);
  const summaries = Object.fromEntries(
    labels.map(({ key }) => [key, merge(gradedWeeks.map(w => w[key]))])
  ) as Record<Key, Stats>;
  const historicalSummaries = Object.fromEntries(
    (["top3Winner", "top3Spread", "top3Total", "top3Overall"] as HistoryKey[]).map(key =>
      [key, merge(gradedWeeks.map(w => w[key]))]
    )
  ) as Record<HistoryKey, Stats>;

  const panels = [
    { id: "last", title: "Last Week", week: previousWeek?.week, isLast: true },
    { id: "season", title: "Season to Date", week: null, isLast: false },
  ];

  return (
    <section className="bettorSummary bettorCompact" aria-label="Model betting performance">
      <div className="bettorCompactIntro">
        <span className="sectionKicker">MODEL PERFORMANCE</span>
        <h2>How our picks performed</h2>
        <p>Hypothetical $10 per bet</p>
      </div>

      <OverallSummary
        lastWeek={previousWeek?.top3Overall ?? empty}
        lastWeekNumber={previousWeek?.week}
        seasonSummary={historicalSummaries.top3Overall}
        overallPicks={overallPicks}
      />

      {panels.map(panel => (
        <div className="bettorCompactGroup" key={panel.id}>
          <div className="bettorCompactHeading">
            <h3>{panel.title}</h3>
            <span>{panel.week ? "Week " + panel.week : panel.isLast ? "No graded prior week" : season + " season"}</span>
          </div>
          <div className="bettorCompactGrid">
            {labels.map(({ key, title }) => {
              const s = panel.isLast ? previousWeek?.[key] ?? empty : summaries[key];
              return (
                <div className="bettorCompactCell" key={key}>
                  <span className="bettorCompactLabel">{title}</span>
                  <strong className={s.profit === null ? "bettorUnknown" : s.profit >= 0 ? "bettorPositive" : "bettorNegative"}>
                    {s.profit === null ? "N/A" : money(s.profit)}
                  </strong>
                  <span className="bettorCompactRecord">{s.wins}W–{s.losses}L{s.pushes ? "–" + s.pushes + "P" : ""}</span>
                  {s.settled === 0
                    ? <span className="bettorCompactMissing">No graded picks</span>
                    : s.profit === null
                      ? <span className="bettorCompactMissing">Odds missing</span>
                      : s.estimatedOdds > 0
                        ? <span className="bettorCompactMissing">Est. −110 odds</span>
                        : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="bettorTop3History">
        <div className="bettorTop3HistoryHead">
          <div>
            <span className="sectionKicker">HISTORICAL TOP 3 RESULTS</span>
            <h3>How the strongest weekly picks performed</h3>
          </div>
          <span>Win rate excludes pushes</span>
        </div>
        {panels.map(panel => (
          <div className="bettorCompactGroup bettorTop3Group" key={panel.id}>
            <div className="bettorCompactHeading">
              <h3>{panel.title}</h3>
              <span>{panel.week ? "Week " + panel.week : panel.isLast ? "No graded prior week" : season + " season"}</span>
            </div>
            <div className="bettorTop3Grid">
              {historyLabels.map(({ key, title, subtitle }) => {
                const s = panel.isLast ? previousWeek?.[key] ?? empty : historicalSummaries[key];
                const attempts = s.wins + s.losses;
                const winRate = attempts ? Math.round(1000 * s.wins / attempts) / 10 : null;
                const gradedPicks = s.picks.filter(p => p.result !== "PENDING");
                const pending = s.picks.length - gradedPicks.length;
                return (
                  <article className="bettorTop3Cell" key={key}>
                    <div className="bettorTop3Name">{title}<small>{subtitle}</small></div>
                    <strong className="bettorTop3Rate">{winRate === null ? "—" : winRate.toFixed(1) + "%"}</strong>
                    <span className="bettorTop3Record">{s.wins}W · {s.losses}L · {s.pushes}P</span>
                    <span className="bettorTop3Count">{s.settled} graded pick{s.settled === 1 ? "" : "s"}{pending > 0 ? " · " + pending + " pending" : ""}</span>
                    {gradedPicks.length > 0 ? (
                      <details className="bettorTop3Details">
                        <summary>View picks</summary>
                        <div className="bettorTop3PickList">
                          {gradedPicks.map((pick, index) => (
                            <div className="bettorTop3Pick" key={pick.week + "-" + pick.eventId + "-" + pick.type + "-" + index}>
                              <span className="bettorTop3PickMeta">W{pick.week} · {pick.game}</span>
                              <span className="bettorTop3PickSelection">{pick.selection} <b className={"bettorTop3Outcome bettorTop3" + pick.result}>{pick.result}</b></span>
                              <span className="bettorTop3PickMeta">Model confidence {(pick.confidence * 100).toFixed(1)}%</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : <span className="bettorTop3NoPicks">No graded results yet</span>}
                  </article>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <details className="bettorCompactFoot">
        <summary>How are these calculated?</summary>
        <p>All Bets means one moneyline, one spread and one over/under selection per game. Best / Game means the highest-confidence selection in each game. Top 3 means the three highest-confidence selections in each week, regardless of market. Moneyline, Spread and Over/Under each show the strongest selection in that market per game. Results assume $10 on each selection, using archived sportsbook odds and final scores. Missing spread and total odds are estimated at −110; actual saved prices are used where available. Missing moneyline prices are not estimated and show N/A. Estimated returns are not historical sportsbook quotes. These are hypothetical results, not actual winnings.</p>
        <p>The historical Top 3 breakdown shows the three most-confident winner, spread and over/under predictions from each week. Top 3 Overall appears above as a separate featured card with historical results alongside the selected week's picks. Predictions are ranked from saved confidence before outcomes are known. Only graded picks count toward win/loss records; pushes and pending bets are excluded from the win-rate denominator. Season-to-date uses archived weeks and excludes unverified retrospective backfills. Model confidence is not a measured win rate.</p>
      </details>
    </section>
  );
}
