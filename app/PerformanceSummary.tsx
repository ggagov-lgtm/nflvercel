"use client";
type Pick={game:string;selection:string;type:string;confidence:number;odds:number|null;result:"WIN"|"LOSS"|"PUSH"|"PENDING";eventId:string};
type Stats={wins:number;losses:number;pushes:number;profit:number|null;missingOdds:number;settled:number;picks:Pick[]};
type Week={week:number;all:Stats;best:Stats;top3:Stats};
type Key="all"|"best"|"top3";
const labels:{key:Key;title:string;subtitle:string}[]=[
 {key:"all",title:"Every Prediction",subtitle:"Moneyline, spread and total for each game"},
 {key:"best",title:"Best Bet Per Game",subtitle:"One highest-confidence pick for each game"},
 {key:"top3",title:"Top 3 Picks",subtitle:"Three highest-confidence picks each week"}
];
const money=(n:number|null)=>n===null?"Odds unavailable":(n<0?"−":"+")+"$"+Math.abs(n).toFixed(2);
function merge(rows:Stats[]):Stats {
 const picks=rows.flatMap(r=>r.picks);
 const settled=rows.reduce((n,r)=>n+r.settled,0);
 const missingOdds=rows.reduce((n,r)=>n+r.missingOdds,0);
 return {wins:rows.reduce((n,r)=>n+r.wins,0),losses:rows.reduce((n,r)=>n+r.losses,0),pushes:rows.reduce((n,r)=>n+r.pushes,0),settled,missingOdds,picks,profit:settled>0&&missingOdds===0&&rows.every(r=>r.settled===0||r.profit!==null)?rows.reduce((n,r)=>n+(r.profit||0),0):null};
}
export default function PerformanceSummary({weeks,currentWeek,season}:{weeks:Week[];currentWeek:number;season:number}) {
 const ordered=[...weeks].sort((a,b)=>b.week-a.week);
 const completed=ordered.filter(w=>w.best.settled>0);
 const latest=completed[0];
 const panels=[{id:"last",title:"Last Week",week:latest?.week,stats:latest||null},{id:"season",title:"Season to Date",week:null,stats:null}];
 const summaries=Object.fromEntries(labels.map(({key})=>[key,merge(completed.map(w=>w[key]))])) as Record<Key,Stats>;
 return <section className="bettorSummary bettorCompact" aria-label="Model betting performance">
  <div className="bettorCompactIntro"><span className="sectionKicker">MODEL PERFORMANCE</span><h2>How our picks performed</h2><p>Hypothetical $10 per bet</p></div>
  {panels.map(panel=><div className="bettorCompactGroup" key={panel.id}>
    <div className="bettorCompactHeading"><h3>{panel.title}</h3><span>{panel.week?"Week "+panel.week:season+" season"}</span></div>
    <div className="bettorCompactGrid">{labels.map(({key,title})=>{
      const s=panel.stats?panel.stats[key]:summaries[key];
      const label=key==="all"?"All Bets":key==="best"?"Best / Game":"Top 3";
      return <div className="bettorCompactCell" key={key}>
        <span className="bettorCompactLabel">{label}</span>
        <strong className={s.profit===null?"bettorUnknown":s.profit>=0?"bettorPositive":"bettorNegative"}>{s.profit===null?"N/A":money(s.profit)}</strong>
        <span className="bettorCompactRecord">{s.wins}W–{s.losses}L{s.pushes?"–"+s.pushes+"P":""}</span>
        {s.profit===null?<span className="bettorCompactMissing">Odds missing</span>:null}

      </div>;
    })}</div>
  </div>)}
  <details className="bettorCompactFoot"><summary>How are these calculated?</summary><p>All 3 Bets means one moneyline, one spread and one over/under selection per game. Best / Game means the highest-confidence selection in each game. Top 3 means the three highest-confidence selections in each week. Results assume $10 on each selection, using archived sportsbook odds and final scores. A dash means some required original odds are missing, so we cannot calculate an accurate dollar return. These are hypothetical results, not actual winnings. Only weeks with archived individual predictions are included.</p></details>
 </section>;
}
