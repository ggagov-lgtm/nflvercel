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
type OverallPick = {
  eventId: string | number;
  category: string;
  probability: number;
  selection: string;
  logo: string;
  matchup: string;
  result?: string;
};

export default function OverallSummary({ lastWeek, lastWeekNumber, seasonSummary, overallPicks }: {
  lastWeek: Stats;
  lastWeekNumber?: number;
  seasonSummary: Stats;
  overallPicks: OverallPick[];
}) {
  return (
    <section className="bettorOverallFeatured" aria-label="Overall top three model picks and results">
      <div className="bettorOverallFeaturedHeading">
        <div>
          <span className="sectionKicker">TOP 3 OVERALL</span>
          <h3>Strongest predictions across all bet types</h3>
        </div>
        <small>Selected using saved pregame confidence</small>
      </div>
      <div className="bettorOverallFeaturedGrid">
        <div className="bettorOverallHistory">
          <h4>Historical Performance</h4>
          <div className="bettorOverallHistoryGrid">
            {[
              { id: "last", title: "Last Week", week: lastWeekNumber, stats: lastWeek },
              { id: "season", title: "Season to Date", week: undefined, stats: seasonSummary },
            ].map(({ id, title, week, stats }) => {
              const attempts = stats.wins + stats.losses;
              const graded = stats.picks.filter(p => p.result !== "PENDING");
              return (
                <div className="bettorOverallHistoryCard" key={id}>
                  <span>{title}{week ? " · W" + week : ""}</span>
                  <strong>{attempts ? (100 * stats.wins / attempts).toFixed(1) + "%" : "—"}</strong>
                  <b>{stats.wins}W · {stats.losses}L · {stats.pushes}P</b>
                  <small>{stats.settled} graded pick{stats.settled === 1 ? "" : "s"}</small>
                  {graded.length > 0 ? (
                    <details className="bettorTop3Details">
                      <summary>View picks</summary>
                      <div className="bettorTop3PickList">
                        {graded.map((pick, i) => (
                          <div className="bettorTop3Pick" key={pick.week + "-" + pick.eventId + "-" + pick.type + "-" + i}>
                            <span className="bettorTop3PickMeta">W{pick.week} · {pick.game}</span>
                            <span className="bettorTop3PickSelection">
                              {pick.selection}
                              <b className={"bettorTop3Outcome bettorTop3" + pick.result}>{pick.result}</b>
                            </span>
                            <span className="bettorTop3PickMeta">Confidence {(100 * pick.confidence).toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : <small>No graded results yet</small>}
                </div>
              );
            })}
          </div>
        </div>
        <div className="bettorOverallUpcoming">
          <h4>Selected Week · Top 3 Picks</h4>
          <div className="topPicksRows">
            {overallPicks.map((pick, index) => (
              <div className="topPickRow" key={String(pick.eventId) + "-" + pick.category + "-" + index}>
                <b className="topRank">{index + 1}</b>
                {pick.logo ? <img src={pick.logo} alt="" /> : <span />}
                <div className="topPickText">
                  <strong>{pick.selection}</strong>
                  <span>{pick.matchup} · {pick.category}</span>
                </div>
                <div className="topPickOutcome">
                  <b className={`topProbability topProbability${pick.result || "UPCOMING"}`}>
                    {Number.isFinite(pick.probability) ? (100 * pick.probability).toFixed(1) + "%" : "—"}
                  </b>
                  <span className={`topPickResult topPickResult${pick.result || "UPCOMING"}`}>
                    {pick.result || "UPCOMING"}
                  </span>
                </div>
              </div>
            ))}
            {!overallPicks.length && <div className="noTopPicks">No verified predictions for this week</div>}
          </div>
        </div>
      </div>
      <p className="bettorOverallFootnote">Historical win rates exclude pushes and pending games. Model confidence is a pregame prediction, not a historical win rate.</p>
    </section>
  );
}
