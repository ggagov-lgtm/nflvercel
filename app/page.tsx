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

export default async function Page({ searchParams }: { searchParams?: Promise<{ week?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/auth/login");

  const s = await createClient();
  const params = await searchParams;

  const { data: latest } = await s
    .from("predictions")
    .select("season,week")
    .order("season", { ascending: false })
    .order("week", { ascending: false })
    .limit(1)
    .maybeSingle();

  const season = latest?.season || week2Preview.season;
  const { data: availableRows } = await s
    .from("predictions")
    .select("season,week")
    .eq("season", season)
    .order("week", { ascending: false });

  const availableWeeks = Array.from(new Set([
    ...(availableRows || []).map((r: AnyObj) => Number(r.week)),
    Number(week2Preview.week),
  ])).filter(Number.isFinite).sort((a,b)=>b-a);

  const requestedWeek = Number(params?.week);
  const selectedWeek = Number.isFinite(requestedWeek) && availableWeeks.includes(requestedWeek)
    ? requestedWeek
    : (latest?.week || Number(week2Preview.week));

  let preds: Pred[] = [];
  let displayLatest: { season: number; week: number } | null = { season, week: selectedWeek };
  let previewMode = false;

  if (latest && availableWeeks.includes(selectedWeek)) {
    const { data } = await s
      .from("predictions")
      .select("*")
      .eq("season", season)
      .eq("week", selectedWeek)
      .order("locked_at");
    preds = (data || []) as Pred[];
  }

  if (!preds.length && selectedWeek === Number(week2Preview.week)) {
    preds = week2Preview.games as unknown as Pred[];
    previewMode = true;
  }

  const gameStates = displayLatest
    ? await getEspnGameStates(displayLatest.season, displayLatest.week)
    : new Map<string, LiveGame>();

  const completedPerformance = (() => {
    let finals = 0;
    let mlWins = 0, mlLosses = 0;
    let spreadWins = 0, spreadLosses = 0;
    let totalWins = 0, totalLosses = 0;
    let topWins = 0, topLosses = 0;
    let scoreError = 0;
    let scoreGames = 0;

    for (const p of preds) {
      const live = gameStates.get(String(p.event_id));
      if (live?.state !== "post" || live.homeScore == null || live.awayScore == null) continue;

      finals += 1;
      const x = p.model || {};
      const m = p.market || {};
      const finalMargin = live.homeScore - live.awayScore;
      const finalTotal = live.homeScore + live.awayScore;

      const hp = Number(x.home_win_prob);
      const ap = Number(x.away_win_prob);
      const homeML = hp >= ap;
      const mlProb = homeML ? hp : ap;
      const actualHomeWin = finalMargin > 0;
      const mlResult = finalMargin === 0 ? "PUSH" : actualHomeWin === homeML ? "WIN" : "LOSS";
      if (mlResult === "WIN") mlWins += 1;
      if (mlResult === "LOSS") mlLosses += 1;

      const hc = Number(x.home_cover_prob);
      const ac = Number(x.away_cover_prob);
      const spreadHome = hc >= ac;
      const spreadProb = spreadHome ? hc : ac;
      const marketMargin = Number(x.market_margin);
      let spreadResult: string | undefined;
      if (Number.isFinite(marketMargin)) {
        const diff = finalMargin - marketMargin;
        spreadResult = diff === 0 ? "PUSH" : (spreadHome ? diff > 0 : diff < 0) ? "WIN" : "LOSS";
        if (spreadResult === "WIN") spreadWins += 1;
        if (spreadResult === "LOSS") spreadLosses += 1;
      }

      const overProb = Number(x.over_prob);
      const underProb = Number(x.under_prob);
      const isOver = overProb >= underProb;
      const totalProb = isOver ? overProb : underProb;
      const marketTotal = Number(x.market_total ?? m.total);
      let totalResult: string | undefined;
      if (Number.isFinite(marketTotal)) {
        totalResult = finalTotal === marketTotal ? "PUSH" : (isOver ? finalTotal > marketTotal : finalTotal < marketTotal) ? "WIN" : "LOSS";
        if (totalResult === "WIN") totalWins += 1;
        if (totalResult === "LOSS") totalLosses += 1;
      }

      const ranked = [
        { probability: mlProb, result: mlResult },
        { probability: spreadProb, result: spreadResult },
        { probability: totalProb, result: totalResult },
      ].sort((a, b) => Number(b.probability) - Number(a.probability));
      if (ranked[0]?.result === "WIN") topWins += 1;
      if (ranked[0]?.result === "LOSS") topLosses += 1;

      const predHome = Number(x.pred_home);
      const predAway = Number(x.pred_away);
      if (Number.isFinite(predHome) && Number.isFinite(predAway)) {
        scoreError += (Math.abs(predHome - live.homeScore) + Math.abs(predAway - live.awayScore)) / 2;
        scoreGames += 1;
      }
    }

    const rate = (wins: number, losses: number) =>
      wins + losses ? wins / (wins + losses) : null;

    return {
      finals,
      mlWins, mlLosses, mlRate: rate(mlWins, mlLosses),
      spreadWins, spreadLosses, spreadRate: rate(spreadWins, spreadLosses),
      totalWins, totalLosses, totalRate: rate(totalWins, totalLosses),
      topWins, topLosses, topRate: rate(topWins, topLosses),
      scoreMae: scoreGames ? scoreError / scoreGames : null,
    };
  })();

  let priorSeasonTopWins = 0;
  let priorSeasonTopLosses = 0;
  if (displayLatest && !previewMode) {
    const { data: settled } = await s
      .from("prediction_settlements")
      .select("top_pick_result,predictions!inner(season,week)")
      .eq("predictions.season", displayLatest.season)
      .lt("predictions.week", displayLatest.week);
    for (const row of settled || []) {
      if (row.top_pick_result === "WIN") priorSeasonTopWins += 1;
      if (row.top_pick_result === "LOSS") priorSeasonTopLosses += 1;
    }
  }

  const seasonTopPerformance = (() => {
    // Current displayed week is graded from live ESPN finals. Prior official weeks
    // come from the settlement table so only completed, settled games are counted.
    return {
      wins: priorSeasonTopWins + completedPerformance.topWins,
      losses: priorSeasonTopLosses + completedPerformance.topLosses,
      rate: (priorSeasonTopWins + priorSeasonTopLosses + completedPerformance.topWins + completedPerformance.topLosses)
        ? (priorSeasonTopWins + completedPerformance.topWins) /
          (priorSeasonTopWins + priorSeasonTopLosses + completedPerformance.topWins + completedPerformance.topLosses)
        : null,
      games: priorSeasonTopWins + priorSeasonTopLosses + completedPerformance.topWins + completedPerformance.topLosses,
    };
  })();

  const weeklyTopPicks = (() => {
    const winner: AnyObj[] = [];
    const spread: AnyObj[] = [];
    const total: AnyObj[] = [];
    const overall: AnyObj[] = [];

    for (const p of preds) {
      const g = p.game || {};
      const m = p.market || {};
      const x = p.model || {};
      const state = gameStates.get(String(p.event_id))?.state || "pre";
      if (state === "post") continue;

      const hp = Number(x.home_win_prob);
      const ap = Number(x.away_win_prob);
      const homeML = hp >= ap;
      const mlProb = homeML ? hp : ap;
      const mlTeam = homeML ? g.home : g.away;
      const ml = {
        eventId: p.event_id, category: "Winner", probability: mlProb,
        selection: mlTeam?.abbr || "—", logo: mlTeam?.logo || "",
        matchup: `${g.away?.abbr || "AWAY"} at ${g.home?.abbr || "HOME"}`,
      };

      const hc = Number(x.home_cover_prob);
      const ac = Number(x.away_cover_prob);
      const spreadHome = hc >= ac;
      const spreadProb = spreadHome ? hc : ac;
      const spreadTeam = spreadHome ? g.home : g.away;
      const marketMargin = Number(x.market_margin);
      const selectedLine = Number.isFinite(marketMargin)
        ? (spreadHome ? -marketMargin : marketMargin)
        : NaN;
      const sp = {
        eventId: p.event_id, category: "Point Spread", probability: spreadProb,
        selection: `${spreadTeam?.abbr || "—"} ${Number.isFinite(selectedLine) ? signed(selectedLine) : ""}`.trim(),
        logo: spreadTeam?.logo || "",
        matchup: `${g.away?.abbr || "AWAY"} at ${g.home?.abbr || "HOME"}`,
      };

      const overProb = Number(x.over_prob);
      const underProb = Number(x.under_prob);
      const isOver = overProb >= underProb;
      const totalProb = isOver ? overProb : underProb;
      const marketTotal = Number(x.market_total ?? m.total);
      const totalTeam = homeML ? g.home : g.away;
      const tot = {
        eventId: p.event_id, category: "Over / Under", probability: totalProb,
        selection: `${isOver ? "OVER" : "UNDER"} ${Number.isFinite(marketTotal) ? marketTotal.toFixed(1) : "—"}`,
        logo: totalTeam?.logo || "",
        matchup: `${g.away?.abbr || "AWAY"} at ${g.home?.abbr || "HOME"}`,
      };

      winner.push(ml); spread.push(sp); total.push(tot);
      overall.push(ml, sp, tot);
    }

    const top3 = (rows: AnyObj[]) =>
      rows.filter(r => Number.isFinite(r.probability))
        .sort((a, b) => b.probability - a.probability).slice(0, 3);

    return { winner: top3(winner), spread: top3(spread), total: top3(total), overall: top3(overall) };
  })();

  const weeklyNumberOne = weeklyTopPicks.overall[0] || null;
  const weeklyNumberOneState = weeklyNumberOne
    ? gameStates.get(String(weeklyNumberOne.eventId))?.state || "pre"
    : "pre";
  const weeklyNumberOneResult =
    weeklyNumberOne && weeklyNumberOneState === "post"
      ? (() => {
          const p = preds.find((row) => String(row.event_id) === String(weeklyNumberOne.eventId));
          const live = p ? gameStates.get(String(p.event_id)) : null;
          if (!p || !live) return null;
          const x = p.model || {};
          const m = p.market || {};
          const finalHome = Number(live.homeScore);
          const finalAway = Number(live.awayScore);
          if (weeklyNumberOne.category === "Winner") {
            const selectedHome = weeklyNumberOne.selection === p.game?.home?.abbr;
            return finalHome === finalAway ? "PUSH" : (selectedHome === (finalHome > finalAway) ? "WIN" : "LOSS");
          }
          if (weeklyNumberOne.category === "Point Spread") {
            const marketMargin = Number(x.market_margin ?? m.market_margin);
            const diff = finalHome - finalAway - marketMargin;
            if (Math.abs(diff) < 0.0001) return "PUSH";
            const selectedHome = weeklyNumberOne.selection.startsWith(p.game?.home?.abbr || "__");
            return selectedHome === (diff > 0) ? "WIN" : "LOSS";
          }
          const marketTotal = Number(x.market_total ?? m.total);
          const diff = finalHome + finalAway - marketTotal;
          if (Math.abs(diff) < 0.0001) return "PUSH";
          const selectedOver = weeklyNumberOne.selection.startsWith("OVER");
          return selectedOver === (diff > 0) ? "WIN" : "LOSS";
        })()
      : null;

  const weekProgress = preds
    .map((p) => {
      const live = gameStates.get(String(p.event_id));
      return {
        eventId: p.event_id,
        state: live?.state || "pre",
        date: live?.date || p.game?.date || "",
        matchup: `${p.game?.away?.abbr || "AWAY"} at ${p.game?.home?.abbr || "HOME"}`,
      };
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const progressFinal = weekProgress.filter((g) => g.state === "post").length;
  const progressLive = weekProgress.filter((g) => g.state === "in").length;
  const progressUpcoming = weekProgress.length - progressFinal - progressLive;

  const modelVersion =
    preds[0]?.model_version || "v2.0.0";

  const simulationCount =
    preds[0]?.model?.simulations || 50000;

  return (
    <main className="dashboard">
      <section className="dashboardIntro">
        <div className="introIdentity">
          <span className="introSeason">NFL · {displayLatest?.season || "—"}</span>
          <h1>Week {displayLatest?.week || "—"}</h1>
          <p>Market-anchored quantitative predictions · locked before kickoff</p>
        </div>

        <div className="introOperations">
          <div className="introProgress">
            <div className="introProgressHead">
              <strong>Week Progress</strong>
              <span>{progressFinal} of {weekProgress.length} final</span>
            </div>
            <div className="introSegments">
              {weekProgress.map((game) => (
                <span
                  key={game.eventId}
                  className={`introSegment ${game.state === "post" ? "segmentFinal" : game.state === "in" ? "segmentLive" : "segmentUpcoming"}`}
                  title={`${game.matchup} · ${game.state === "post" ? "Final" : game.state === "in" ? "In Progress" : "Upcoming"}`}
                />
              ))}
            </div>
            <div className="introProgressMeta">
              <span><i className="progressFinalDot" />{progressFinal} Final</span>
              <span><i className="progressLiveDot" />{progressLive} In Progress</span>
              <span><i className="progressUpcomingDot" />{progressUpcoming} Upcoming</span>
            </div>
          </div>

          <div className="introRight">
            <form className="weekSelector" action="/" method="get">
              <label htmlFor="week-select">VIEW WEEK</label>
              <select id="week-select" name="week" defaultValue={String(selectedWeek)} onChange={undefined}>
                {availableWeeks.map((week) => (
                  <option key={week} value={week}>Week {week}</option>
                ))}
              </select>
              <button type="submit">View</button>
            </form>
            <div className="introModelStatus">
              <span className="statusDot" />
              <div>
                <strong>{previewMode ? "Model Preview" : preds.length ? "Predictions Locked" : "Awaiting First Run"}</strong>
                <span>{modelVersion} · {simulationCount.toLocaleString()} simulations</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="modelSummary">
        <div className="summaryHead">
          <div><span className="sectionKicker">MODEL SUMMARY</span><h2>Completed-game performance</h2></div>
          <small>{completedPerformance.finals} of {preds.length} games completed</small>
        </div>
        <div className="summaryGrid">
          <div className="summaryPrimary summaryPrimaryThree">
            <div className="summaryPanel">
              <div className="summaryLabel">TOP PICK<button type="button" className="infoTip" aria-label="Explain top guess success" data-tip="How often the model’s single highest-probability prediction for each completed game was correct.">i</button></div>
              <div className="donutWrap">
                <div className={`donut ${!weeklyNumberOneResult ? "donutPending" : weeklyNumberOneResult === "LOSS" ? "donutLoss" : ""}`} style={{"--value": weeklyNumberOneResult ? "100%" : "0%"} as React.CSSProperties}>
                  <div>
                    <b>{weeklyNumberOneResult === "WIN" ? "100%" : weeklyNumberOneResult === "LOSS" ? "0%" : weeklyNumberOneResult === "PUSH" ? "PUSH" : "PENDING"}</b>
                    <span>{weeklyNumberOne ? `${weeklyNumberOne.selection} · ${pct(weeklyNumberOne.probability)}` : "No #1 prediction"}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="summaryPanel">
              <div className="summaryLabel">SEASON SUCCESS<button type="button" className="infoTip" aria-label="Explain season top prediction percentage" data-tip="Success rate of the model’s #1 prediction using completed games only for the season.">i</button></div>
              <div className="donutWrap">
                <div className={`donut donutBlue ${seasonTopPerformance.games === 0 ? "donutPending" : ""}`} style={{"--value": seasonTopPerformance.games ? `${Math.max(0, Math.min(100, Number(seasonTopPerformance.rate || 0) * 100))}%` : "0%"} as React.CSSProperties}>
                  <div><b>{seasonTopPerformance.games ? pct(seasonTopPerformance.rate) : "N/A"}</b><span>{seasonTopPerformance.games ? `${seasonTopPerformance.wins} of ${seasonTopPerformance.games} correct` : "No completed games"}</span></div>
                </div>
              </div>
            </div>

            <div className="summaryPanel">
              <div className="summaryLabel">WEEK SUCCESS<button type="button" className="infoTip" aria-label="Explain weekly top prediction percentage" data-tip="Success rate of the model’s #1 prediction using completed games only for the displayed week.">i</button></div>
              <div className="donutWrap">
                <div className={`donut donutPurple ${completedPerformance.topWins + completedPerformance.topLosses === 0 ? "donutPending" : ""}`} style={{"--value": completedPerformance.topWins + completedPerformance.topLosses ? `${Math.max(0, Math.min(100, Number(completedPerformance.topRate || 0) * 100))}%` : "0%"} as React.CSSProperties}>
                  <div><b>{completedPerformance.topWins + completedPerformance.topLosses ? pct(completedPerformance.topRate) : "N/A"}</b><span>{completedPerformance.topWins + completedPerformance.topLosses ? `${completedPerformance.topWins} of ${completedPerformance.topWins + completedPerformance.topLosses} correct` : "No completed games"}</span></div>
                </div>
              </div>
            </div>
          </div>
          <div className="summarySecondary">
            {[
              ["WINNER PREDICTION SUCCESS",completedPerformance.mlRate,completedPerformance.mlWins,completedPerformance.mlLosses],
              ["POINT SPREAD SUCCESS",completedPerformance.spreadRate,completedPerformance.spreadWins,completedPerformance.spreadLosses],
              ["OVER / UNDER SUCCESS",completedPerformance.totalRate,completedPerformance.totalWins,completedPerformance.totalLosses],
            ].map(([label,rate,wins,losses])=><div className="miniMetric" key={String(label)}>
              <div className="miniDonut" style={{"--value":`${Math.max(0,Math.min(100,Number(rate||0)*100))}%`} as React.CSSProperties} />
              <div><span>{String(label)}<button type="button" className="infoTip" aria-label={`Explain ${String(label).toLowerCase()}`} data-tip={String(label)==="WINNER PREDICTION SUCCESS" ? "Percentage of completed winner predictions that were correct." : String(label)==="POINT SPREAD SUCCESS" ? "Percentage of completed point-spread predictions that covered the sportsbook line. Pushes are excluded." : "Percentage of completed over / under predictions that correctly predicted the sportsbook total. Pushes are excluded."}>i</button></span><b>{pct(rate)}</b><small>{Number(wins)}–{Number(losses)} · Completed only</small></div>
            </div>)}
            <div className="miniMetric errorMetric">
              <div className="errorIcon">▥</div>
              <div><span>AVERAGE SCORE ERROR<button type="button" className="infoTip" aria-label="Explain average score error" data-tip="Average absolute difference between the model’s predicted team scores and the actual final scores. Lower is better.">i</button></span><b>{num(completedPerformance.scoreMae)}</b><small>{completedPerformance.finals} completed game{completedPerformance.finals===1?"":"s"} · Lower is better</small></div>
            </div>
          </div>
        </div>
      </section>

      <section className="topPicksSection">
        <div className="topPicksTitle">
          <div>
            <span className="sectionKicker">TOP PICKS THIS WEEK</span>
            <h2>Highest-probability model predictions</h2>
          </div>
          <small>Upcoming and live games only · completed games automatically drop out</small>
        </div>

        <div className="topPicksGrid">
          {[
            { title: "Top 3 Winner Picks", subtitle: "Most likely game winners", rows: weeklyTopPicks.winner, className: "topWinner" },
            { title: "Top 3 Point Spread Picks", subtitle: "Most likely to cover the point spread", rows: weeklyTopPicks.spread, className: "topSpread" },
            { title: "Top 3 Over / Under Picks", subtitle: "Highest probability total-points predictions", rows: weeklyTopPicks.total, className: "topTotal" },
            { title: "Top 3 Overall Picks", subtitle: "Highest confidence across all categories", rows: weeklyTopPicks.overall, className: "topOverall" },
          ].map((group) => (
            <article className={`topPicksCard ${group.className}`} key={group.title}>
              <header>
                <strong>{group.title}</strong>
                <span>{group.subtitle}</span>
              </header>
              <div className="topPicksRows">
                {group.rows.map((pick, index) => (
                  <div className="topPickRow" key={`${group.title}-${pick.eventId}-${pick.category}`}>
                    <b className="topRank">{index + 1}</b>
                    {pick.logo ? <img src={pick.logo} alt="" /> : null}
                    <div className="topPickText">
                      <strong>{pick.selection}</strong>
                      <span>{pick.matchup}{group.className === "topOverall" ? ` · ${pick.category}` : ""}</span>
                    </div>
                    <b className="topProbability">{pct(pick.probability)}</b>
                  </div>
                ))}
                {!group.rows.length && <div className="noTopPicks">No upcoming picks</div>}
              </div>
            </article>
          ))}
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
                  <span>MODEL POINT DIFFERENCE</span>
                  <strong>
                    {signed(x.model_margin)}
                  </strong>
                </div>

                <div>
                  <span>SPORTSBOOK POINT DIFFERENCE</span>
                  <strong>
                    {signed(x.market_margin)}
                  </strong>
                </div>

                <div>
                  <span>MODEL TOTAL POINTS</span>
                  <strong>
                    {num(x.model_total)}
                  </strong>
                </div>

                <div>
                  <span>SPORTSBOOK TOTAL POINTS</span>
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
                  simulations
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
