"use client";

import { useState } from "react";

export type ArchivedOddsGame = {
  team_1: string;
  team_2: string;
  team_1_spread: number;
  team_1_spread_price: number;
  team_2_spread: number;
  team_2_spread_price: number;
  total: number;
  over_price: number;
  under_price: number;
  team_1_moneyline: number;
  team_2_moneyline: number;
};

export type ArchivedOddsWeek = {
  season: number;
  week: number;
  kind: "retrospective_reference_odds";
  source: string;
  source_url: string;
  observed_at: string;
  timestamp_warning: string;
  games: ArchivedOddsGame[];
};

const price = (n: number) => n > 0 ? "+" + n : String(n);
const line = (n: number) => n > 0 ? "+" + n : String(n);

export default function HistoricalOdds({
  archives,
  currentWeek,
}: {
  archives: ArchivedOddsWeek[];
  currentWeek: number;
}) {
  const [week, setWeek] = useState(
    archives.some(a => a.week === currentWeek)
      ? currentWeek
      : archives[archives.length - 1]?.week ?? 1
  );
  const active = archives.find(a => a.week === week) || archives[archives.length - 1];
  if (!active) return null;

  return (
    <section className="historicalOddsSection" aria-label="Historical sportsbook odds archive">
      <details className="historicalOddsDisclosure">
        <summary>
          <span>
            <span className="sectionKicker">HISTORICAL SPORTSBOOK ODDS</span>
            <strong>VegasInsider · 2026 Weeks 1–3</strong>
            <small>48 archived game lines · spreads, totals, and moneylines</small>
          </span>
          <span className="historicalOddsOpen" aria-hidden="true">View odds ▾</span>
        </summary>
        <div className="historicalOddsContent">
          <p className="historicalOddsWarning">
            Historical reference quotes from VegasInsider, collected October 13, 2026.
            These prices were viewed after kickoff and are <b>not verified as the
            prices available when the model locked its predictions</b>. They do not
            replace saved betting lines or create missing predictions for Weeks 1–2.
            Model Performance profit/loss remains based on saved pregame selections.
          </p>
          <div className="historicalOddsToolbar">
            <div className="historicalOddsWeeks" role="group" aria-label="Select archived NFL week">
              {archives.map(a => (
                <button
                  type="button"
                  key={a.week}
                  aria-pressed={active.week === a.week}
                  onClick={() => setWeek(a.week)}
                >
                  Week {a.week}
                </button>
              ))}
            </div>
            <a href={active.source_url} target="_blank" rel="noopener noreferrer">
              Original VegasInsider table ↗
            </a>
          </div>
          <div className="historicalOddsTableWrap" role="region" tabIndex={0}
            aria-label={`Week ${active.week} VegasInsider sportsbook odds table`}>
            <table className="historicalOddsTable">
              <thead>
                <tr>
                  <th scope="col">Matchup</th>
                  <th scope="col">Spread &amp; price</th>
                  <th scope="col">Over / Under</th>
                  <th scope="col">Moneyline</th>
                </tr>
              </thead>
              <tbody>
                {active.games.map(g => (
                  <tr key={g.team_1 + "-" + g.team_2}>
                    <th scope="row">{g.team_1} / {g.team_2}</th>
                    <td>
                      <span>{g.team_1} {line(g.team_1_spread)} ({price(g.team_1_spread_price)})</span>
                      <span>{g.team_2} {line(g.team_2_spread)} ({price(g.team_2_spread_price)})</span>
                    </td>
                    <td>
                      <span>Over {g.total} ({price(g.over_price)})</span>
                      <span>Under {g.total} ({price(g.under_price)})</span>
                    </td>
                    <td>
                      <span>{g.team_1} {price(g.team_1_moneyline)}</span>
                      <span>{g.team_2} {price(g.team_2_moneyline)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="historicalOddsFootnote">
            <a href="/replays" style={{ color: "inherit", textDecoration: "underline", fontWeight: 800 }}>
              View Week 2–3 current-model historical replays ↗
            </a>
          </p>
          <p className="historicalOddsFootnote">
            Table team order follows VegasInsider, not home/away order. Lines from
            a later sportsbook snapshot can differ from locked DraftKings lines;
            do not use a mismatched spread or total to price a historical bet.
          </p>
        </div>
      </details>
    </section>
  );
}
