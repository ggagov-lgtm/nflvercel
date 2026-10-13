"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
type Filter = "ALL" | Pick["result"];

const dollars = (amount: number | null) =>
  amount === null ? "N/A" : `${amount < 0 ? "−" : "+"}$${Math.abs(amount).toFixed(2)}`;
const oddLabel = (p: Pick) => p.odds !== null
  ? (p.odds > 0 ? "+" : "") + p.odds.toString()
  : p.type === "Moneyline" ? "Unavailable" : "Est. −110";

function betProfit(pick: Pick): number | null {
  if (pick.result === "PENDING") return null;
  // Match the summary's conservative rule for missing moneyline prices.
  if (pick.odds === null && pick.type === "Moneyline") return null;
  if (pick.result === "PUSH") return 0;
  if (pick.result === "LOSS") return -10;
  const odds = pick.odds ?? -110;
  return odds > 0 ? odds / 100 * 10 : 100 / Math.abs(odds) * 10;
}

export default function PerformanceDrilldown({
  title, period, stats, onClose,
}: {
  title: string;
  period: string;
  stats: Stats;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("ALL");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", keyHandler);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const allPicks = [...stats.picks].sort((a, b) =>
    (a.result === "PENDING" ? 1 : 0) - (b.result === "PENDING" ? 1 : 0) ||
    b.week - a.week || a.game.localeCompare(b.game) || a.type.localeCompare(b.type)
  );
  const filtered = filter === "ALL" ? allPicks : allPicks.filter(p => p.result === filter);
  const pending = allPicks.filter(p => p.result === "PENDING").length;
  const winners = allPicks.filter(p => p.result === "WIN");
  const winProfits = winners.map(betProfit);
  const winningReturns = winProfits.every((p): p is number => p !== null)
    ? winProfits.reduce((total, amount) => total + (amount ?? 0), 0)
    : null;
  const settledDenominator = stats.wins + stats.losses;
  const accuracy = settledDenominator ? (100 * stats.wins / settledDenominator).toFixed(1) + "%" : "—";
  const counts = {
    ALL: allPicks.length,
    WIN: stats.wins,
    LOSS: stats.losses,
    PUSH: stats.pushes,
    PENDING: pending,
  };
  const availableFilters: { value: Filter; label: string }[] = [
    { value: "ALL", label: "All" },
    { value: "WIN", label: "Wins" },
    { value: "LOSS", label: "Losses" },
    { value: "PUSH", label: "Pushes" },
    ...(pending ? [{ value: "PENDING" as const, label: "Pending" }] : []),
  ];

  return createPortal(
    <div className="bettorDetailBackdrop" onMouseDown={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="bettorDetailDialog" role="dialog" aria-modal="true"
        aria-labelledby="bettorDetailTitle" aria-describedby="bettorDetailNote">
        <div className="bettorDetailHeader">
          <div>
            <span className="sectionKicker">BET-BY-BET RESULTS · {period}</span>
            <h3 id="bettorDetailTitle">{title}</h3>
          </div>
          <button ref={closeRef} className="bettorDetailClose" type="button"
            aria-label="Close bet details" onClick={onClose}>×</button>
        </div>
        <div className="bettorDetailMetrics">
          <div><small>Win rate</small><strong>{accuracy}</strong></div>
          <div><small>Net $10 bets</small><strong className={stats.profit !== null && stats.profit < 0 ? "bettorNegative" : stats.profit !== null && stats.profit > 0 ? "bettorPositive" : ""}>{dollars(stats.profit)}</strong></div>
          <div><small>Record</small><strong>{stats.wins}W–{stats.losses}L{stats.pushes ? "–" + stats.pushes + "P" : ""}</strong></div>
        </div>
        <div className="bettorDetailBreakdown">
          <span>Winning bets earned <b className="bettorPositive">{dollars(winningReturns)}</b></span>
          <span>Losing bets cost <b className="bettorNegative">{"−$" + (stats.losses * 10).toFixed(2)}</b></span>
        </div>
        <p className="bettorDetailNote" id="bettorDetailNote">
          Hypothetical $10 stake per pick · archived odds when available · missing spread/total prices estimated at −110.
          Missing moneyline odds show N/A; pending picks are not graded.
        </p>
        <div className="bettorDetailFilters" role="group" aria-label="Filter bets by result">
          {availableFilters.map(({ value, label }) => (
            <button type="button" key={value} aria-pressed={filter === value}
              onClick={() => setFilter(value)}>{label} <small>{counts[value]}</small></button>
          ))}
        </div>
        <div className="bettorDetailList" role="region" tabIndex={0}
          aria-label={title + " graded individual bet details"}>
          {filtered.map((p, index) => {
            const profit = betProfit(p);
            return (
              <div className="bettorDetailBet" key={p.week + "-" + p.eventId + "-" + p.type + "-" + index}>
                <div className="bettorDetailBetInfo">
                  <strong>{p.selection}</strong>
                  <span>W{p.week} · {p.game}</span>
                  <small>{p.type} · Odds {oddLabel(p)} · Model confidence {(p.confidence * 100).toFixed(1)}%</small>
                </div>
                <div className="bettorDetailBetOutcome">
                  <b className={"bettorDetailResult bettorDetailResult" + p.result}>{p.result}</b>
                  <strong className={profit === null ? "bettorUnknown" : profit > 0 ? "bettorPositive" : profit < 0 ? "bettorNegative" : ""}>
                    {dollars(profit)}
                  </strong>
                </div>
              </div>
            );
          })}
          {!filtered.length && <div className="bettorDetailEmpty">No {filter === "ALL" ? "" : filter.toLowerCase() + " "}bets available in this period.</div>}
        </div>
        <div className="bettorDetailFooter">
          <span>{filtered.length} displayed · {stats.settled} graded · pushes excluded from win rate</span>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
