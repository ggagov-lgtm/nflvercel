"use client";

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
type Key = "all" | "best" | "top3" | "moneyline" | "spread" | "total";
type Week = { week: number } & Record<Key, Stats>;

const labels: { key: Key; title: string }[] = [
  { key: "all", title: "All Bets" },
  { key: "best", title: "Best / Game" },
  { key: "top3", title: "Top 3" },
  { key: "moneyline", title: "Moneyline" },
  { key: "spread", title: "Spread" },
  { key: "total", title: "Over/Under" },
];

// Historical accuracy is the share of graded picks that won (pushes excluded).
const winPercentage = (wins: number, losses: number) => {
  const graded = wins + losses;
  return graded > 0 ? (100 * wins / graded).toFixed(1) + "%" : "—";
};

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

export default function PerformanceSummary({ weeks, currentWeek, season }: {
  weeks: Week[];
  currentWeek: number;
  season: number;
}) {
  const ordered = [...weeks].sort((a, b) => b.week - a.week);
  // Last Week means the previous NFL week, not a partially played current week.
  const previousWeek = ordered.find(w => w.week === currentWeek - 1 && w.all.settled > 0);
  const gradedWeeks = ordered.filter(w => w.all.settled > 0);
  const summaries = Object.fromEntries(
    labels.map(({ key }) => [key, merge(gradedWeeks.map(w => w[key]))])
  ) as Record<Key, Stats>;
  const panels = [
    { id: "last", title: "Last Week", week: previousWeek?.week, isLast: true },
    { id: "season", title: "Season to Date", week: null, isLast: false },
  ];

  return (
    <section className="bettorSummary bettorCompact" aria-label="Model betting performance">
      <div className="bettorCompactIntro">
        <span className="sectionKicker">MODEL PERFORMANCE</span>
        <h2>How our picks performed</h2>
        <p>Historical win percentages · pushes excluded</p>
      </div>

      {panels.map(panel => (
        <div className="bettorCompactGroup" key={panel.id}>
          <div className="bettorCompactHeading">
            <h3>{panel.title}</h3>
            <span>{panel.week ? "Week " + panel.week : panel.isLast ? "No graded prior week" : season + " season"}</span>
          </div>
          <div className="bettorCompactGrid">
            {labels.map(({ key, title }) => {
              const s = panel.isLast ? previousWeek?.[key] ?? empty : summaries[key];
              const graded = s.wins + s.losses;
              const trend = graded === 0 ? "bettorUnknown" : s.wins > s.losses ? "bettorPositive" : s.wins < s.losses ? "bettorNegative" : "bettorNeutral";
              return (
                <div className="bettorCompactCell" key={key}>
                  <span className="bettorCompactLabel">{title}</span>
                  <strong className={trend}>{winPercentage(s.wins, s.losses)}</strong>
                  <span className="bettorCompactRecord">{s.wins}W–{s.losses}L{s.pushes ? "–" + s.pushes + "P" : ""}</span>
                  <span className="bettorCompactMissing">{graded === 0 ? "No graded picks" : s.pushes > 0 ? "Pushes excluded" : "Win rate"}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <details className="bettorCompactFoot">
        <summary>How are these calculated?</summary>
        <p>Each large percentage is the actual win rate for graded selections: wins divided by wins plus losses, displayed to one decimal place. Pushes and pending bets are excluded from the percentage. All Bets means one moneyline, one spread and one over/under selection per game. Best / Game means the highest-confidence selection in each game. Top 3 means the three highest-confidence selections in each week, regardless of market. Moneyline, Spread and Over/Under each show the strongest selection in that market per game. These are actual outcomes of archived model selections, not the model's predicted confidence percentages. Only archived individual predictions are included.</p>
      </details>
    </section>
  );
}
