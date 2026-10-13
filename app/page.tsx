import PerformanceSummary from "./PerformanceSummary";
import { promises as fs } from "node:fs";
import path from "node:path";
import week2Preview from "@/data/week2-preview.json";

// Predictions change independently of Vercel deployments via GitHub Actions.
// Never serve a cached HTML snapshot of the weekly prediction board.
export const dynamic = "force-dynamic";
export const revalidate = 0;

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

// ESPN scoreboard competitors include an overall season record (e.g. "4-2").
// Show all three W-L-T fields, with zero ties when ESPN omits that field.
function espnTeamRecord(competitor: AnyObj | undefined): string | undefined {
  const records = Array.isArray(competitor?.records) ? competitor.records : [];
  const overall = records.find((r: AnyObj) =>
    r?.type === "total" || String(r?.name || "").toLowerCase() === "overall"
  );
  const match = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(String(overall?.summary || "").trim());
  return match ? `${match[1]}-${match[2]}-${match[3] || "0"}` : undefined;
}

type LiveGame = {
  date?: string;
  state: "pre" | "in" | "post";
  detail?: string;
  homeScore?: number;
  awayScore?: number;
  homeRecord?: string;
  awayRecord?: string;
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
        homeRecord: espnTeamRecord(home),
        awayRecord: espnTeamRecord(away),
      });
    }
    return out;
  } catch {
    return new Map<string, LiveGame>();
  }
}


type ScheduledGame = { id: string; date: string; state: string; home: string; away: string; homeLogo: string; awayLogo: string; homeRecord?: string; awayRecord?: string };

async function getScheduledGames(season: number, week: number): Promise<ScheduledGame[]> {
  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&week=${week}&seasontype=2`;
    const response = await fetch(url, { next: { revalidate: 300 } });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.events || []).map((event: AnyObj) => {
      const competitors = event.competitions?.[0]?.competitors || [];
      const homeCompetitor = competitors.find((x: AnyObj) => x.homeAway === "home");
      const awayCompetitor = competitors.find((x: AnyObj) => x.homeAway === "away");
      const home = homeCompetitor?.team;
      const away = awayCompetitor?.team;
      return { id: String(event.id), date: event.date as string, state: event.status?.type?.state || "pre",
        home: home?.abbreviation || "HOME", away: away?.abbreviation || "AWAY",
        homeLogo: home?.logo || "", awayLogo: away?.logo || "",
        homeRecord: espnTeamRecord(homeCompetitor), awayRecord: espnTeamRecord(awayCompetitor) };
    });
  } catch { return []; }
}

async function getCurrentEspnWeek() {
  try {
    const response = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { next: { revalidate: 300 } });
    if (!response.ok) return null;
    const data = await response.json();
    const season = Number(data.season?.year);
    const week = Number(data.week?.number);
    return Number.isInteger(season) && Number.isInteger(week) ? { season, week } : null;
  } catch { return null; }
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

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<{ season?: string; week?: string }>;
}) {
  const predictionDir = path.join(process.cwd(), "data", "predictions");
  const loadWeek = async (season: number, week: number): Promise<Pred[]> => {
    try {
      const raw = await fs.readFile(path.join(predictionDir, `${season}-week-${week}.json`), "utf8");
      return (JSON.parse(raw).predictions || []).filter((p: AnyObj) => p.model && !p.backfill_status) as Pred[];
    } catch { return []; }
  };
  const loadPerformance = async (season: number, week: number): Promise<AnyObj | null> => {
    try {
      const raw = await fs.readFile(path.join(process.cwd(), "data", "performance", `${season}-week-${week}.json`), "utf8");
      return JSON.parse(raw);
    } catch { return null; }
  };
  let availableWeeks: {season: number; week: number}[] = [];
  try {
    const files = await fs.readdir(predictionDir);
    availableWeeks = files.flatMap(name => { const m = /^(\d{4})-week-(\d+)\.json$/.exec(name); return m ? [{season: Number(m[1]), week: Number(m[2])}] : []; });
    availableWeeks.sort((a,b) => b.season - a.season || b.week - a.week);
  } catch {}
  const params = (await searchParams) || {};
  const requestedSeason = Number(params.season);
  const requestedWeek = Number(params.week);
  const hasRequestedWeek = Number.isInteger(requestedSeason) && Number.isInteger(requestedWeek) && requestedWeek > 0;

  const latest = availableWeeks[0] || null;

  let preds: Pred[] = [];
  let displayLatest: { season: number; week: number } | null =
    hasRequestedWeek ? { season: requestedSeason, week: requestedWeek } : latest;
  let previewMode = false;
  if (!hasRequestedWeek) {
    const current = await getCurrentEspnWeek();
    if (current && (!displayLatest || current.season > displayLatest.season || (current.season === displayLatest.season && current.week > displayLatest.week))) {
      displayLatest = current;
    }
  }

  if (displayLatest) preds = await loadWeek(displayLatest.season, displayLatest.week);

  if (!preds.length && displayLatest?.season === week2Preview.season && displayLatest?.week === week2Preview.week) {
    preds = week2Preview.games as unknown as Pred[];
    previewMode = true;
  } else if (!displayLatest) {
    preds = week2Preview.games as unknown as Pred[];
    displayLatest = { season: week2Preview.season, week: week2Preview.week };
    previewMode = true;
  }

  const previousWeekHref = displayLatest && displayLatest.week > 1
    ? `/?season=${displayLatest.season}&week=${displayLatest.week - 1}`
    : null;
  const nextWeekHref = displayLatest
    ? `/?season=${displayLatest.season}&week=${displayLatest.week + 1}`
    : null;

  const gameStates = displayLatest
    ? await getEspnGameStates(displayLatest.season, displayLatest.week)
    : new Map<string, LiveGame>();

  const scheduledGames = displayLatest ? await getScheduledGames(displayLatest.season, displayLatest.week) : [];
  const savedEventIds = new Set(preds.map(p => String(p.event_id)));
  const pendingGames = previewMode ? [] : scheduledGames.filter((g: ScheduledGame) => !savedEventIds.has(g.id));

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
    for (let w = 1; w < displayLatest.week; w++) {
      const row = await loadPerformance(displayLatest.season, w);
      priorSeasonTopWins += Number(row?.top_pick_wins || 0);
      priorSeasonTopLosses += Number(row?.top_pick_losses || 0);
    }
  }

  let previousWeekPerformance: AnyObj | null = null;
  if (displayLatest && displayLatest.week > 1) previousWeekPerformance = await loadPerformance(displayLatest.season, displayLatest.week - 1);

  let weeklyNumberOneWins = 0;
  let weeklyNumberOneLosses = 0;
  if (displayLatest && !previewMode) {
    for (let w = 1; w < displayLatest.week; w++) {
      const row = await loadPerformance(displayLatest.season, w);
      weeklyNumberOneWins += Number(row?.weekly_top_pick_wins || 0);
      weeklyNumberOneLosses += Number(row?.weekly_top_pick_losses || 0);
    }
  }

  const weeklyNumberOneHistoryRate =
    weeklyNumberOneWins + weeklyNumberOneLosses
      ? weeklyNumberOneWins / (weeklyNumberOneWins + weeklyNumberOneLosses)
      : null;

  const seasonTopPerformance = (() => {
    // Success is based on the highest-probability selection within each game
    // (Winner, Point Spread, or Over / Under), not winner predictions alone.
    const wins = priorSeasonTopWins + completedPerformance.topWins;
    const losses = priorSeasonTopLosses + completedPerformance.topLosses;
    return {
      wins,
      losses,
      rate: wins + losses ? wins / (wins + losses) : null,
      games: wins + losses,
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

      // Grade the original locked selection against ESPN's final score.
      const live = gameStates.get(String(p.event_id));
      const grade = (side: "home"|"away"|"over"|"under", line?: number) => {
        if (live?.state !== "post" || live.homeScore === undefined || live.awayScore === undefined) return state === "in" ? "LIVE" : "UPCOMING";
        const diff = live.homeScore - live.awayScore;
        const totalPoints = live.homeScore + live.awayScore;
        const delta = side === "home" ? diff + (line ?? 0) : side === "away" ? -diff + (line ?? 0) : side === "over" ? totalPoints - (line ?? NaN) : (line ?? NaN) - totalPoints;
        if (!Number.isFinite(delta)) return "UNAVAILABLE";
        return Math.abs(delta) < 0.000001 ? "PUSH" : delta > 0 ? "WIN" : "LOSS";
      };
      Object.assign(ml, {result:grade(homeML ? "home" : "away")});
      Object.assign(sp, {result:grade(spreadHome ? "home" : "away", selectedLine)});
      Object.assign(tot, {result:grade(isOver ? "over" : "under", marketTotal)});
      // Preserve every locked prediction in the overall pool so the week's
      // true #1 pick remains identifiable and gradeable after its game finishes.
      overall.push(ml, sp, tot);

      // Keep locked picks visible after kickoff so final results can be reviewed.
      winner.push(ml); spread.push(sp); total.push(tot);
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


  // Three transparent, fixed-$10 strategies. Select before grading each game.
  const bettorWeeks = await Promise.all(
    availableWeeks.filter(w => w.season === (displayLatest?.season || 2026) && w.week <= (displayLatest?.week || 99))
      .map(async ({season,week}) => {
        const records = await loadWeek(season,week);
        const live = await getEspnGameStates(season,week);
        type Selection = {game:string;selection:string;type:string;confidence:number;odds:number|null;result:"WIN"|"LOSS"|"PUSH"|"PENDING";eventId:string;week:number};
        const all:Selection[]=[];
        const bestPerGame:Selection[]=[];
        for(const p of records) {
          const x=p.model||{}, m=p.market||{}, g=p.game||{};
          const home=String(g.home?.abbr||"HOME"),away=String(g.away?.abbr||"AWAY");
          const lineTotal=Number(m.total??x.market_total);
          const margin=Number(x.market_margin??m.market_margin);
          const options=[
            {type:"Moneyline",prob:Number(x.home_win_prob),selection:home+" to win",side:"home",odds:m.home_ml},
            {type:"Moneyline",prob:Number(x.away_win_prob),selection:away+" to win",side:"away",odds:m.away_ml},
            {type:"Spread",prob:Number(x.home_cover_prob),selection:home+" spread",side:"home",odds:m.home_spread_odds??m.spread_home_odds},
            {type:"Spread",prob:Number(x.away_cover_prob),selection:away+" spread",side:"away",odds:m.away_spread_odds??m.spread_away_odds},
            {type:"Total",prob:Number(x.over_prob),selection:"Over "+lineTotal,side:"over",odds:m.over_odds},
            {type:"Total",prob:Number(x.under_prob),selection:"Under "+lineTotal,side:"under",odds:m.under_odds}
          ].filter(v=>Number.isFinite(v.prob)&&v.prob>=0&&v.prob<=1);
          const final=live.get(String(p.event_id));
          const byMarket=["Moneyline","Spread","Total"].map(type=>options.filter(o=>o.type===type).sort((u,v)=>v.prob-u.prob)[0]).filter((o):o is (typeof options)[number]=>Boolean(o));
          const selections:Selection[]=byMarket.map(o=>{
            let result:Selection["result"]="PENDING";
            if(final?.state==="post"&&final.homeScore!==undefined&&final.awayScore!==undefined){
              const diff=final.homeScore-final.awayScore;
              const total=final.homeScore+final.awayScore;
              let delta:number|null=null;
              if(o.type==="Moneyline")delta=o.side==="home"?diff:-diff;
              if(o.type==="Spread"&&Number.isFinite(margin))delta=o.side==="home"?diff-margin:margin-diff;
              if(o.type==="Total"&&Number.isFinite(lineTotal))delta=o.side==="over"?total-lineTotal:lineTotal-total;
              if(delta!==null)result=Math.abs(delta)<0.000001?"PUSH":delta>0?"WIN":"LOSS";
            }
            const raw=Number(o.odds);
            const odds=o.odds!==null&&o.odds!==undefined&&Number.isFinite(raw)&&Math.abs(raw)>=100?raw:null;
            return {game:away+" @ "+home,selection:o.selection,type:o.type,confidence:o.prob,odds,result,eventId:String(p.event_id),week};
          });
          all.push(...selections);
          const best=[...selections].sort((u,v)=>v.confidence-u.confidence)[0];
          if(best)bestPerGame.push(best);
        }
        // Rank the original locked bets, before grading, to match the next-week Top 3 cards.
        // Each category selects at most three per week; incomplete games remain pending.
        const rankTopThree=(rows:Selection[])=>[...rows].sort((u,v)=>v.confidence-u.confidence).slice(0,3);
        const topThree=rankTopThree(all);
        const top3Winner=rankTopThree(all.filter(p=>p.type==="Moneyline"));
        const top3Spread=rankTopThree(all.filter(p=>p.type==="Spread"));
        const top3Total=rankTopThree(all.filter(p=>p.type==="Total"));
        const strategy=(picks:Selection[])=>{
          const settled=picks.filter(p=>p.result!=="PENDING");
          // Use the saved sportsbook price where present. For historical spread/total
          // picks without a saved price, estimate at standard -110 (not an actual quote).
          // Never invent a missing moneyline price.
          const estimatedOdds=settled.filter(p=>p.odds===null&&p.type!=="Moneyline").length;
          const missingOdds=settled.filter(p=>p.odds===null&&p.type==="Moneyline").length;
          const profit=settled.length&&!missingOdds?settled.reduce((sum,p)=>{
            const price=p.odds??-110;
            return sum+(p.result==="LOSS"?-10:p.result==="WIN"?(price>0?price/100*10:100/Math.abs(price)*10):0);
          },0):null;
          return {wins:settled.filter(p=>p.result==="WIN").length,losses:settled.filter(p=>p.result==="LOSS").length,pushes:settled.filter(p=>p.result==="PUSH").length,profit,missingOdds,estimatedOdds,settled:settled.length,picks};
        };
        return {week,all:strategy(all),best:strategy(bestPerGame),top3:strategy(topThree),moneyline:strategy(all.filter(p=>p.type==="Moneyline")),spread:strategy(all.filter(p=>p.type==="Spread")),total:strategy(all.filter(p=>p.type==="Total")),top3Winner:strategy(top3Winner),top3Spread:strategy(top3Spread),top3Total:strategy(top3Total),top3Overall:strategy(topThree)};
      })
  );

  return (
    <main className="dashboard">
      <section className="dashboardIntro">
        <div className="introIdentity">
          <span className="introSeason">NFL · {displayLatest?.season || "—"}</span>
          <div className="weekNavigator">
            {previousWeekHref ? <a className="weekArrow" href={previousWeekHref} aria-label="Previous week">‹</a> : <span className="weekArrow weekArrowDisabled">‹</span>}
            <h1>Week {displayLatest?.week || "—"}</h1>
            {nextWeekHref ? <a className="weekArrow" href={nextWeekHref} aria-label="Next week">›</a> : <span className="weekArrow weekArrowDisabled">›</span>}
          </div>
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

          <div className="introModelStatus">
            <span className="statusDot" />
            <div>
              <strong>{previewMode ? "Model Preview" : latest ? "Predictions Locked" : "Awaiting First Run"}</strong>
              <span>{modelVersion} · {simulationCount.toLocaleString()} simulations</span>
            </div>
          </div>
        </div>
      </section>

      <PerformanceSummary weeks={bettorWeeks} currentWeek={displayLatest?.week || 0} season={displayLatest?.season || 2026} overallPicks={weeklyTopPicks.overall} />

      <section className="topPicksSection">
        <div className="topPicksTitle">
          <div>
            <span className="sectionKicker">TOP PICKS &amp; RESULTS</span>
            <h2>Highest-probability model predictions</h2>
          </div>
          <small>Original locked predictions · final games show results</small>
        </div>

        <div className="topPicksGrid">
          {[
            { title: "Top 3 Winner Picks", subtitle: "Most likely game winners", rows: weeklyTopPicks.winner, className: "topWinner" },
            { title: "Top 3 Point Spread Picks", subtitle: "Most likely to cover the point spread", rows: weeklyTopPicks.spread, className: "topSpread" },
            { title: "Top 3 Over / Under Picks", subtitle: "Highest probability total-points predictions", rows: weeklyTopPicks.total, className: "topTotal" },
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
                      <span>{pick.matchup}</span>
                    </div>
                    <div className="topPickOutcome"><b className={`topProbability topProbability${pick.result || "UPCOMING"}`}>{pct(pick.probability)}</b><span className={`topPickResult topPickResult${pick.result || "UPCOMING"}`}>{pick.result || "UPCOMING"}</span></div>
                  </div>
                ))}
                {!group.rows.length && <div className="noTopPicks">No predictions available</div>}
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
              : `${preds.length + pendingGames.length} Games · ${preds.length} Locked Predictions`}
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

      {!preds.length && !pendingGames.length && (
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
        {pendingGames.map(game => {
          const live = gameStates.get(game.id);
          const isFinal = game.state === "post";
          return (
            <details className={`gameRowCard ${isFinal ? "gameFinal" : ""}`} key={game.id}>
              <summary className="gameRow">
                <div className="rowWhen"><strong>{isFinal ? "FINAL" : dateLabel(game.date).split(",")[0]}</strong><span>{dateLabel(game.date)}</span></div>
                <div className="rowMatchup">
                  <span className="rowTeam"><img src={game.awayLogo} alt="" /><span className="rowTeamText"><b>{game.away}</b><small className="rowTeamRecord" title="Wins-Losses-Ties">{game.awayRecord || "—"}</small></span></span>
                  <em>@</em>
                  <span className="rowTeam"><img src={game.homeLogo} alt="" /><span className="rowTeamText"><b>{game.home}</b><small className="rowTeamRecord" title="Wins-Losses-Ties">{game.homeRecord || "—"}</small></span></span>
                </div>
                <div className="rowMetric"><span>WIN PROBABILITY</span><b>—</b></div>
                <div className="rowMetric rowScore"><span>FINAL SCORE</span><b>{live?.awayScore ?? "—"}–{live?.homeScore ?? "—"}</b></div>
                <div className="rowMetric"><span>POINT SPREAD</span><b>—</b></div>
                <div className="rowMetric"><span>OVER / UNDER</span><b>—</b></div>
                <div className="rowTopPick"><span>TOP PICK</span><b>—</b><small>—</small></div>
                <div className="rowChevron" aria-hidden="true">⌄</div>
              </summary>
              <div className="gameExpansion"><p>Historical schedule entry. No verified pregame prediction is available for this game.</p></div>
            </details>
          );
        })}
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

          const topPick = picks[0];
          const favoredTeam = homeML ? g.home?.abbr : g.away?.abbr;
          const injuryAdj = Number(x.injury_margin_adjustment);
          const contextAdj = Number(x.context_margin_adjustment);
          const weatherAdj = Number(x.weather_total_adjustment);
          const marketGap = Number.isFinite(modelMargin) && Number.isFinite(marketMargin)
            ? Math.abs(modelMargin - marketMargin) : null;
          const analyst = x.analysis_context || {};
          const injuryList = Array.isArray(analyst.injuries)
            ? analyst.injuries
                .filter((i:any) => i?.player && ["out","doubtful","questionable"].includes(String(i.status || "").toLowerCase()))
                .sort((a:any,b:any) => Number(b.raw_impact || 0) - Number(a.raw_impact || 0))
                .slice(0, 4)
            : [];
          const injuryText = injuryList.length
            ? `Key injuries: ${injuryList.map((i:any) => `${i.player} (${i.position || "player"}, ${i.status})`).join(", ")}.`
            : (Number.isFinite(injuryAdj) && Math.abs(injuryAdj) >= .1 ? `Injuries account for a ${signed(injuryAdj)}-point margin adjustment.` : "");
          const recentText = (team:string, rows:any[]) => Array.isArray(rows) && rows.length
            ? `${team} last ${rows.length}: ${rows.map((r:any) => `${r.result} ${r.team_score}–${r.opponent_score} vs ${r.opponent}`).join(", ")}.`
            : "";
          const weather = analyst.weather || {};
          const weatherText = weather.indoor
            ? "Weather is not a material factor in this indoor game."
            : weather.temperature != null
              ? `Weather: ${Math.round(Number(weather.temperature))}°F${Number(weather.wind_gust)>0 ? `, gusts ${Math.round(Number(weather.wind_gust))} mph` : ""}${Number(weather.precipitation_probability)>0 ? `, precipitation ${Math.round(Number(weather.precipitation_probability))}%` : ""}; model total adjustment ${signed(weatherAdj)}.`
              : (Math.abs(weatherAdj || 0) >= .1 ? `Weather changes the projected total by ${signed(weatherAdj)} points.` : "");
          const explanation = [
            `${g.home?.abbr || "The home team"} is at home. The model favors ${favoredTeam || "the selected team"} at ${pct(mlProb)} and projects ${g.away?.abbr} ${num(x.pred_away)}–${g.home?.abbr} ${num(x.pred_home)}.`,
            injuryText,
            recentText(g.away?.abbr || "Away", analyst.away_recent_games),
            recentText(g.home?.abbr || "Home", analyst.home_recent_games),
            weatherText,
            marketGap != null ? `Model vs sportsbook point difference: ${signed(modelMargin)} vs ${signed(marketMargin)} (${num(marketGap)}-point gap).` : "",
          ].filter(Boolean).join(" ");

          return (
            <details className={`gameRowCard ${isFinal ? "gameFinal" : ""} ${isLive ? "gameLive" : ""}`} key={p.id}>
              <summary className="gameRow">
                <div className="rowWhen"><strong>{isLive ? "● LIVE" : isFinal ? "FINAL" : dateLabel(displayDate).split(",")[0]}</strong><span>{isLive ? live?.detail : dateLabel(displayDate)}</span></div>
                <div className="rowMatchup">
                  <span className="rowTeam"><img src={g.away?.logo || ""} alt="" /><span className="rowTeamText"><b>{g.away?.abbr || "AWAY"}</b><small className="rowTeamRecord" title="Wins-Losses-Ties">{live?.awayRecord || "—"}</small></span></span>
                  <em>@</em>
                  <span className="rowTeam"><img src={g.home?.logo || ""} alt="" /><span className="rowTeamText"><b>{g.home?.abbr || "HOME"}</b><small className="rowTeamRecord" title="Wins-Losses-Ties">{live?.homeRecord || "—"}</small></span></span>
                </div>
                <div className="rowMetric"><span>WIN PROBABILITY</span><b>{favoredTeam} {pct(mlProb)}</b></div>
                <div className="rowMetric rowScore"><span>{isFinal ? "FINAL / MODEL" : isLive ? "LIVE / MODEL" : "MODEL SCORE"}</span><b>{isFinal || isLive ? `${live?.awayScore ?? "—"}–${live?.homeScore ?? "—"} / ${num(x.pred_away)}–${num(x.pred_home)}` : `${num(x.pred_away)}–${num(x.pred_home)}`}</b></div>
                <div className="rowMetric"><span>POINT SPREAD</span><b>{spreadTeam} · {pct(spreadProb)}</b></div>
                <div className="rowMetric"><span>OVER / UNDER</span><b>{isOver ? "OVER" : "UNDER"} · {pct(totalProb)}</b></div>
                <div className="rowTopPick"><span>TOP PICK</span><b>{topPick.selection}</b><small>{pct(topPick.probability)}</small></div>
                <div className="rowChevron" aria-hidden="true">⌄</div>
              </summary>

              <div className="gameExpansion">
                <div className="analysisLead">
                  <div className="analysisPrediction">
                    <span className="sectionKicker">LOCKED MODEL PREDICTION</span>
                    <div className="analysisScore"><b>{g.away?.abbr} {num(x.pred_away)}</b><em>—</em><b>{g.home?.abbr} {num(x.pred_home)}</b></div>
                    <div className="analysisPicks">
                      {picks.map((pick,rank)=>{
                        const modelLine = pick.key === "ml"
                          ? `${pick.selection} ${pick.market}`
                          : pick.key === "spread"
                            ? signed(spreadHome ? -modelMargin : modelMargin)
                            : num(modelTotal);
                        const modelRecommendation = pick.key === "ml"
                          ? `${pick.selection} WIN (${pct(pick.probability)})`
                          : pick.key === "spread"
                            ? `${pick.selection} ${signed(spreadHome ? -modelMargin : modelMargin)} (${pct(pick.probability)})`
                            : `${isOver ? "OVER" : "UNDER"} ${num(modelTotal)} (${pct(pick.probability)})`;
                        const sportsbookLine = pick.key === "ml"
                          ? `${pick.selection} ${pick.market}`
                          : pick.key === "spread"
                            ? `${pick.selection} ${signed(spreadHome ? -marketMargin : marketMargin)}`
                            : `${isOver ? "OVER" : "UNDER"} ${num(marketTotal)}`;
                        return <div key={pick.key} className={`analysisPick ${rank===0?"analysisPickBest":rank===1?"analysisPickSecond":"analysisPickThird"} ${resultClass(pick.result)}`}>
                          <span>{pick.label}</span>
                          <div className="recommendationLine"><strong>{modelRecommendation}</strong></div>
                          <div className="pickComparison"><small>MODEL</small><b>{modelLine}</b></div>
                          <div className="pickComparison"><small>SPORTSBOOK</small><b>{sportsbookLine}</b></div>
                          {isFinal&&pick.result?<small className="pickOutcome">{resultLabel(pick.result)}</small>:null}
                        </div>
                      })}
                    </div>
                  </div>
                  <div className="whyModel">
                    <span className="sectionKicker">WHY THE MODEL LIKES THIS PREDICTION</span>
                    <p>{explanation}</p>
                    <div className="driverChips">
                      <span>Model vs Market <b>{marketGap==null?"—":`${num(marketGap)} pts`}</b></span>
                      <span>Injury Adjustment <b>{signed(injuryAdj)}</b></span>
                      <span>Context Adjustment <b>{signed(contextAdj)}</b></span>
                      <span>Simulations <b>{Number(x.simulations || simulationCount).toLocaleString()}</b></span>
                    </div>
                  </div>
                </div>

                <div className="factorGrid">
                  <div className="factorCard weatherFactor"><div className="factorIcon">☁︎</div><div><span>WEATHER</span><strong>{Math.abs(weatherAdj||0)<.1?"Minimal model impact":`${signed(weatherAdj)} total-point impact`}</strong><small>Locked pregame adjustment</small></div></div>
                  <div className="factorCard"><div className="factorIcon">✚</div><div><span>INJURIES</span><strong>{Math.abs(injuryAdj||0)<.1?"Minimal model impact":`${signed(injuryAdj)} margin impact`}</strong><small>Locked pregame adjustment</small></div></div>
                  <div className="factorCard"><div className="factorIcon">↗</div><div><span>MODEL VS MARKET</span><strong>{marketGap==null?"No comparison":`${num(marketGap)} point difference`}</strong><small>Model margin vs captured line</small></div></div>
                  <div className="factorCard"><div className="factorIcon">◎</div><div><span>CONTEXT</span><strong>{Math.abs(contextAdj||0)<.1?"Minimal model impact":`${signed(contextAdj)} margin impact`}</strong><small>Locked game-context adjustment</small></div></div>
                </div>

                <p className="analysisNote">The explanation uses values stored with the locked prediction. It does not change because of live or final game information.</p>
              </div>
            </details>
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
