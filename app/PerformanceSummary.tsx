"use client";

import { useEffect, useState } from "react";
import PerformanceDrilldown from "./PerformanceDrilldown";

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
  aggregateOnly?: boolean;
  missingArchiveWeeks?: number[];
  previewWeek?: boolean;
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

type MetricView = "percentage" | "dollars";
const VIEW_STORAGE_KEY = "nfl-model-performance-view";

const money = (amount: number | null) =>
  amount == null ? "N/A" : `${amount < 0 ? "−" : "+"}${Math.abs(amount).toFixed(2)}`;

const profitTone = (amount: number | null) =>
  amount === null ? "bettorUnknown" : amount > 0 ? "bettorPositive" : amount < 0 ? "bettorNegative" : "bettorNeutral";

const empty: Stats = {
  wins: 0, losses: 0, pushes: 0, profit: null,
  missingOdds: 0, estimatedOdds: 0, settled: 0, picks: [],
};

function merge(rows: Stats[]): Stats {
  const picks = rows.flatMap(r => r.picks);
  const settled = rows.reduce((n, r) => n + r.settled, 0);
  const missingOdds = rows.reduce((n, r) => n + r.missingOdds, 0);
  const estimatedOdds = rows.reduce((n, r) => n + r.estimatedOdds, 0);
  const missingArchiveWeeks = Array.from(new Set(rows.flatMap(r => r.missingArchiveWeeks || []))).sort((a, b) => a - b);
  const previewWeek = rows.some(r => r.previewWeek);
  return {
    wins: rows.reduce((n, r) => n + r.wins, 0),
    losses: rows.reduce((n, r) => n + r.losses, 0),
    pushes: rows.reduce((n, r) => n + r.pushes, 0),
    settled, missingOdds, estimatedOdds, picks, missingArchiveWeeks, previewWeek,
    profit: settled > 0 && missingOdds === 0 && rows.every(r => r.settled === 0 || (r.profit !== null && !r.missingArchiveWeeks?.length))
      ? rows.reduce((n, r) => n + (r.profit || 0), 0)
      : null,
  };
}

export default function PerformanceSummary({ weeks, currentWeek, season }: {
  weeks: Week[];
  currentWeek: number;
  season: number;
}) {
  const [view, setView] = useState<MetricView>("percentage");
  const [selected, setSelected] = useState<{ title: string; period: string; stats: Stats } | null>(null);

  // Read the preference after hydration; keep the server/client first render identical.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_STORAGE_KEY) === "dollars") {
        setView("dollars");
      }
    } catch {
      // Private browsing or disabled storage: the toggle still works for this visit.
    }
  }, []);

  const changeView = (next: MetricView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Preference storage is optional.
    }
  };

  const ordered = [...weeks].sort((a, b) => b.week - a.week);
  // Last Week means the previous NFL week, not a partially played current week.
  const previousWeek = ordered.find(w => w.week === currentWeek - 1 && w.all.settled > 0);
  // The Week 2 screen has no Week 1 history; show its own saved preview
  // results in the first row instead of six empty "Last Week" tiles.
  const week2Preview = currentWeek === 2
    ? ordered.find(w => w.week === 2 && w.all.settled > 0 && w.all.previewWeek)
    : undefined;
  const firstPanelWeek = week2Preview ?? previousWeek;
  const gradedWeeks = ordered.filter(w => w.all.settled > 0);
  const unavailableWeeks = Array.from({ length: Math.max(0, Math.min(currentWeek, 18)) }, (_, i) => i + 1)
    .filter(week => !ordered.some(w => w.week === week && (w.all.settled > 0 || w.all.picks.length > 0)));
  const aggregateWeeks = ordered.filter(w => w.all.aggregateOnly && w.all.settled > 0).map(w => w.week);
  const summaries = Object.fromEntries(
    labels.map(({ key }) => [key, merge(gradedWeeks.map(w => w[key]))])
  ) as Record<Key, Stats>;
  const panels = [
    { id: "last", title: week2Preview ? "Week 2 Preview Results" : "Last Week", week: firstPanelWeek?.week, isLast: true },
    { id: "season", title: "Season to Date", week: null, isLast: false },
  ];

  return (
    <section className="bettorSummary bettorCompact" aria-label="Model betting performance">
      <div className="bettorCompactHeader">
        <div className="bettorCompactIntro">
          <span className="sectionKicker">MODEL PERFORMANCE</span>
          <h2>How our picks performed</h2>
          <p>Win rates exclude pushes · hypothetical $10 per bet</p>
        </div>
        <div className="bettorCompactSwitch" role="group" aria-label="Choose primary performance metric">
          <button type="button" aria-pressed={view === "percentage"} onClick={() => changeView("percentage")}>Win %</button>
          <button type="button" aria-pressed={view === "dollars"} onClick={() => changeView("dollars")}>$ Profit</button>
        </div>
      </div>

      {ordered.some(w => w.all.previewWeek) && (
        <p className="bettorCompactCoverage">
          Week 2 figures use a saved September 18 preview, not official pre-kickoff locks.
          Profit is hypothetical using retrospective VegasInsider odds or estimated −110
          where exact prices were unavailable. The preview may postdate some Week 2 kickoffs.
          Combined season results containing it are illustrative, not an officially verified betting record.
        </p>
      )}

      {(aggregateWeeks.length > 0 || unavailableWeeks.length > 0) && (
        <p className="bettorCompactCoverage">
          Historical coverage: {aggregateWeeks.length > 0 && `Week ${aggregateWeeks.join(", ")} includes verified aggregate records only (no saved individual picks or odds).`}
          {aggregateWeeks.length > 0 && unavailableWeeks.length > 0 ? " " : ""}
          {unavailableWeeks.length > 0 && `No archived predictions for Week ${unavailableWeeks.join(", ")}; excluded from calculations.`}
        </p>
      )}

      {panels.map(panel => (
        <div className="bettorCompactGroup" key={panel.id}>
          <div className="bettorCompactHeading">
            <h3>{panel.title}</h3>
            <span>{panel.week ? "Week " + panel.week : panel.isLast ? "No graded prior week" : season + " season"}</span>
          </div>
          <div className="bettorCompactGrid">
            {labels.map(({ key, title }) => {
              const s = panel.isLast ? firstPanelWeek?.[key] ?? empty : summaries[key];
              const graded = s.wins + s.losses;
              const winTone = graded === 0 ? "bettorUnknown" : s.wins > s.losses ? "bettorPositive" : s.wins < s.losses ? "bettorNegative" : "bettorNeutral";
              const dollarTone = profitTone(s.profit);
              const showDollars = view === "dollars";
              const hasDetail = s.picks.length > 0;
              const unavailableTop3 = Boolean(s.missingArchiveWeeks?.length) && graded === 0;
              // Keep repetitive odds/preview notes off individual cards.
              // The historical price methodology remains available below under
              // "How are these calculated?" and inside bet-by-bet details.
              const summaryNote = unavailableTop3
                ? "Top 3 archive unavailable"
                : s.aggregateOnly
                  ? "Aggregate only · prices unavailable"
                  : s.missingArchiveWeeks?.length
                    ? key === "top3"
                      ? `W${s.missingArchiveWeeks.join(", ")} Top 3 not archived`
                      : `Includes aggregate-only W${s.missingArchiveWeeks.join(", ")}`
                    : s.missingOdds > 0
                      ? "Moneyline prices unavailable"
                      : graded === 0
                        ? "No graded picks"
                        : s.pushes > 0
                          ? "Pushes excluded"
                          : "Win rate";
              return (
                <button
                  type="button"
                  className="bettorCompactCell bettorCompactClickable"
                  key={key}
                  onClick={() => hasDetail && setSelected({ title, period: panel.title, stats: s })}
                  disabled={!hasDetail}
                  aria-label={hasDetail ? `View bet-by-bet details for ${title}, ${panel.title}` : `No saved individual picks for ${title}, ${panel.title}`}
                >
                  <span className="bettorCompactLabel">{title}</span>
                  <strong className={`${showDollars ? dollarTone : winTone} bettorCompactPrimary ${showDollars ? "bettorProfitPrimary" : ""}`}>
                    {showDollars ? money(s.profit) : winPercentage(s.wins, s.losses)}
                  </strong>
                  <span className={`bettorCompactSecondary ${showDollars ? winTone : dollarTone}`}>
                    {showDollars ? winPercentage(s.wins, s.losses) : money(s.profit)}
                  </span>
                  <span className="bettorCompactRecord">{s.wins}W–{s.losses}L{s.pushes ? "–" + s.pushes + "P" : ""}</span>
                  <span className="bettorCompactMissing">{summaryNote}</span>
                  {hasDetail ? <span className="bettorCompactViewCue" aria-hidden="true">View bets ›</span> : <span className="bettorCompactNoDetails">No bet details</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <details className="bettorCompactFoot">
        <summary>How are these calculated?</summary>
        <p>Win % is the historical accuracy of graded model selections: wins divided by wins plus losses, displayed to one decimal place. Pushes and pending bets are excluded. Dollar profit/loss is hypothetical, assuming $10 staked on each selection and saved sportsbook odds where available. Spread and total bets without saved prices use estimated −110 odds; when any selected moneyline price is missing, the dollar result shows N/A rather than inventing a return. Win rate can be positive while the betting strategy loses money.</p>
        <p>Week 2 is evaluated using a saved September 18 preview, not verified original locked picks; some games may already have started when that file was created. VegasInsider prices are retrospective reference odds, and unmatched spread and total prices use estimated −110. These returns are hypothetical and should not be interpreted as a live pregame track record.</p>
        <p>Some older weeks have only summary results. Those weeks contribute to verified win/loss percentages, but profit is N/A if the individual betting odds are unavailable. A missing weekly Top 3 list is not reconstructed; only archived selections count toward Top 3. Weeks without any archived results are excluded, and the bet-by-bet drilldown displays only saved individual picks.</p>
        <p>All Bets includes one moneyline, one spread and one over/under selection per game. Best / Game uses the highest-confidence selection in each game. Top 3 shows the three highest-confidence predictions from each week, regardless of market. Moneyline, Spread and Over/Under show the strongest selection in their respective markets per game. Season to Date totals the available archived weeks. These are modeled hypothetical returns, not actual betting winnings. The toggle changes the primary number, while both measures remain visible.</p>
      </details>
      {selected && (
        <PerformanceDrilldown
          title={selected.title}
          period={selected.period}
          stats={selected.stats}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
