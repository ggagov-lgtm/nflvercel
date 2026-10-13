import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

type Outcome = {
  home_score: number;
  away_score: number;
  actual_total: number;
  actual_home_margin: number;
  moneyline_correct: boolean;
  spread_result: string;
  total_result: string;
};
type Game = {
  event_id: string;
  matchup: string;
  kickoff: string;
  market: {
    market_margin: number;
    total: number;
    home_ml: number | null;
    away_ml: number | null;
    moneyline_source: string;
  };
  model: {
    pred_home: number;
    pred_away: number;
    home_win_prob: number;
    away_win_prob: number;
    home_cover_prob: number;
    away_cover_prob: number;
    over_prob: number;
    under_prob: number;
    training_cutoff: string;
  };
  evaluation_after_games: Outcome | null;
};
type Backtest = {
  season: number;
  week: number;
  model_version: string;
  kind: string;
  replayed_at: string;
  source_note: string;
  predictions: Game[];
};

async function readReplay(week: number): Promise<Backtest | null> {
  try {
    const filename = path.join(process.cwd(), "data", "backtests", `2026-week-${week}-model-replay.json`);
    const data = JSON.parse(await fs.readFile(filename, "utf8")) as Backtest;
    if (
      data.kind !== "historical_model_replay_not_original_pregame_predictions" ||
      data.week !== week || data.predictions.length !== 16
    ) return null;
    return data;
  } catch {
    return null;
  }
}

const pct = (p: number) => Number.isFinite(p) ? (100 * p).toFixed(1) + "%" : "—";
const signed = (n: number) => n > 0 ? "+" + n.toFixed(1) : n.toFixed(1);

export default async function HistoricalReplays() {
  const rows = await Promise.all([2, 3].map(readReplay));
  const available = rows.filter((x): x is Backtest => x !== null);
  return (
    <main className="replayPage">
      <div className="replayHeader">
        <Link href="/">← NFL dashboard</Link>
        <span className="replayEyebrow">2026 · HISTORICAL MODEL ANALYSIS</span>
        <h1>Week 2 &amp; 3 Model Replays</h1>
        <p>
          Updated model forecasts recomputed using earlier-week football data.
          These results are <strong>historical backtests, not original predictions issued before kickoff</strong>.
          Official locked picks and tracked profitability remain separate.
        </p>
      </div>
      {!available.length && (
        <div className="replayNotice">
          The historical model replay is still running or its output is not yet available.
          The original prediction records have not been changed.
        </div>
      )}
      {available.map(data => (
        <section key={data.week} className="replayGroup">
          <div className="replayGroupHead">
            <div>
              <span className="replayEyebrow">MODEL {data.model_version}</span>
              <h2>Week {data.week}</h2>
            </div>
            <span>{data.predictions.length} matchups</span>
          </div>
          <p className="replayNote">
            {data.week === 2
              ? "Week 2 uses saved September preview spread/total lines and later-sourced reference moneyline prices. Complete original injury/weather inputs were unavailable."
              : "Week 3 uses the archived pregame spread/total/moneyline inputs, with frozen injury and game-context data."}
            {" "}Replay generated {new Date(data.replayed_at).toLocaleDateString("en-US", {timeZone:"UTC"})}.
          </p>
          <div className="replayTableWrap">
            <table className="replayTable">
              <thead>
                <tr>
                  <th scope="col">Game</th>
                  <th scope="col">Predicted score</th>
                  <th scope="col">Winner pick</th>
                  <th scope="col">Spread pick</th>
                  <th scope="col">Total pick</th>
                  <th scope="col">Final result</th>
                </tr>
              </thead>
              <tbody>
                {data.predictions.map(p => {
                  const [away,home] = p.matchup.split(" @ ");
                  const favHome = p.model.home_win_prob >= p.model.away_win_prob;
                  const side = favHome ? home : away;
                  const hCover = p.model.home_cover_prob >= p.model.away_cover_prob;
                  const o = p.model.over_prob >= p.model.under_prob;
                  const e = p.evaluation_after_games;
                  const pick = (a: string, prob: number, grade: boolean | string | undefined) => (
                    <span className="replayPick">
                      <strong>{a}</strong>
                      <small>{pct(prob)}{grade !== undefined ? " · " + (typeof grade === "boolean" ? grade ? "WIN" : "LOSS" : grade) : ""}</small>
                    </span>
                  );
                  return (
                    <tr key={p.event_id}>
                      <th scope="row">{p.matchup}</th>
                      <td>{away} {p.model.pred_away.toFixed(1)} – {home} {p.model.pred_home.toFixed(1)}</td>
                      <td>{pick(side,Math.max(p.model.home_win_prob,p.model.away_win_prob),e?.moneyline_correct)}</td>
                      <td>{pick((hCover?home:away)+" "+signed(hCover?-p.market.market_margin:p.market.market_margin), Math.max(p.model.home_cover_prob,p.model.away_cover_prob),e?.spread_result)}</td>
                      <td>{pick((o?"Over ":"Under ")+p.market.total.toFixed(1), Math.max(p.model.over_prob,p.model.under_prob),e?.total_result)}</td>
                      <td>{e ? `${away} ${e.away_score} – ${home} ${e.home_score}` : "Unavailable"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <style>{`
        .replayPage{max-width:1180px;margin:0 auto;padding:24px 18px 60px;color:var(--text)}
        .replayHeader>a{color:var(--green);font-size:13px;font-weight:800;text-decoration:none}
        .replayEyebrow{display:block;font-size:11px;font-weight:850;letter-spacing:.09em;color:var(--muted);margin-top:15px}
        .replayHeader h1{font-size:clamp(25px,5vw,38px);letter-spacing:-.04em;line-height:1.15;margin:8px 0 11px}
        .replayHeader p,.replayNote{font-size:13px;line-height:1.7;color:var(--muted);max-width:850px}
        .replayHeader p strong{color:var(--text)}
        .replayNotice{border:1px solid var(--line);border-radius:12px;padding:18px;margin-top:24px;color:var(--muted)}
        .replayGroup{margin-top:30px;padding:18px 17px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}
        .replayGroupHead{display:flex;align-items:end;justify-content:space-between;gap:10px}
        .replayGroupHead .replayEyebrow{margin-top:0}
        .replayGroupHead h2{font-size:25px;margin:4px 0}
        .replayGroupHead>span{color:var(--muted);font-size:11px}
        .replayNote{margin:9px 0 13px}
        .replayTableWrap{overflow:auto;border:1px solid var(--line);border-radius:10px}
        .replayTable{border-collapse:collapse;min-width:910px;width:100%;text-align:left;font-variant-numeric:tabular-nums}
        .replayTable th,.replayTable td{padding:12px 10px;border-bottom:1px solid var(--line);font-size:12px;white-space:nowrap}
        .replayTable thead{background:var(--panel2)}
        .replayTable thead th{font-size:10px;letter-spacing:.03em;color:var(--muted)}
        .replayTable tbody th{font-weight:800}
        .replayTable tbody tr:last-child>*{border-bottom:0}
        .replayPick{display:flex;flex-direction:column;gap:4px}
        .replayPick strong{font-size:12px}
        .replayPick small{font-size:10px;color:var(--muted)}
        @media(max-width:640px){.replayPage{padding:16px 10px 40px}.replayGroup{padding:13px 10px}}
      `}</style>
    </main>
  );
}
