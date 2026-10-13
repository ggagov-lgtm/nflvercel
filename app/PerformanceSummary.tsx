"use client";
import { useState } from "react";
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
 const [open,setOpen]=useState<string|null>(null);
 const ordered=[...weeks].sort((a,b)=>b.week-a.week);
 const completed=ordered.filter(w=>w.best.settled>0);
 const latest=completed[0];
 const panels=[{id:"last",title:"Last Week",week:latest?.week,stats:latest||null},{id:"season",title:"Season to Date",week:null,stats:null}];
 const summaries=Object.fromEntries(labels.map(({key})=>[key,merge(completed.map(w=>w[key]))])) as Record<Key,Stats>;
 return <section className="bettorSummary" aria-label="Model betting performance">
  <div className="bettorHead"><div><span className="sectionKicker">MODEL PERFORMANCE</span><h2>What if you followed our picks?</h2><p>Assuming a <strong>$10 bet on each selection.</strong> Compare three ways to follow the model.</p></div></div>
  <div className="bettorComparison">{panels.map(panel=><div className="bettorComparisonPanel" key={panel.id}>
   <div className="bettorComparisonHeading"><h3>{panel.title}</h3><span>{panel.week?"Week "+panel.week:season+" NFL Season"}</span></div>
   <div className="bettorStrategyGrid">{labels.map(({key,title,subtitle})=>{
    const s=panel.stats?panel.stats[key]:summaries[key];
    const record=s.wins+"W · "+s.losses+"L"+(s.pushes?" · "+s.pushes+"P":"");
    const id=panel.id+key;
    return <article className="bettorStrategy" key={key}>
      <div className="bettorStrategyLabel">{title}</div>
      <strong className={s.profit===null?"bettorUnknown":s.profit>=0?"bettorPositive":"bettorNegative"}>{money(s.profit)}</strong>
      <div className="bettorStrategyRecord">{record} <span>· {s.settled} settled bets</span></div>
      <div className="bettorWinBar" aria-label={record}><i style={{width:(s.settled?100*s.wins/s.settled:0)+"%"}}/><em style={{width:(s.settled?100*s.losses/s.settled:0)+"%"}}/></div>
      <p>{subtitle}</p>
      <small>{s.settled?("$"+(s.settled*10).toLocaleString()+" total hypothetical wagers"):"No completed bets yet"}</small>
      {s.missingOdds>0?<small className="bettorMissing">Original odds missing for {s.missingOdds} settled bets</small>:null}
      {s.picks.length>0?<><button type="button" className="bettorExpand" onClick={()=>setOpen(open===id?null:id)}>{open===id?"Hide picks":"See picks"} <span>{open===id?"−":"›"}</span></button>{open===id?<div className="bettorPickList">{s.picks.filter(p=>p.result!=="PENDING").slice(0,48).map((p,i)=><div key={i}><div><strong>{p.game}</strong><small>{p.selection} · {p.type}</small></div><span className={"bettorResult "+p.result.toLowerCase()}>{p.result}</span></div>)}</div>:null}</>:null}
    </article>;
   })}</div>
  </div>)}</div>
  <p className="bettorDisclosure"><strong>How to read this:</strong> Each column represents a different betting strategy, not three amounts you should wager simultaneously. The model's recorded probabilities determine its selections. Profit is simulated at $10 per bet using archived sportsbook odds and official final scores; if required odds are missing, profit is marked unavailable. These are historical hypothetical results, not actual winnings. Only weeks with archived individual predictions are included in this comparison.</p>
 </section>;
}
