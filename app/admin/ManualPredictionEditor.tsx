"use client";
import {useState} from "react";
type Game={event_id:string;away:string;home:string;manual:boolean};
type Props={weeks:{name:string;games:Game[]}[]};
const fields=[["home_win_prob","Home win probability"],["away_win_prob","Away win probability"],["home_cover_prob","Home cover probability"],["away_cover_prob","Away cover probability"],["over_prob","Over probability"],["under_prob","Under probability"],["market_margin","Home favored by (points)"],["market_total","Total points line"],["pred_home","Predicted home score"],["pred_away","Predicted away score"]];
export default function ManualPredictionEditor({weeks}:Props){
 const [week,setWeek]=useState(weeks[0]?.name||"");
 const games=weeks.find(w=>w.name===week)?.games||[];
 const [eventId,setEventId]=useState("");
 const [values,setValues]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 async function save(e:React.FormEvent){e.preventDefault();setBusy(true);setMessage("");try{
 const [season,w]=week.split("-week-");
 const response=await fetch("/api/admin/predictions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({season:Number(season),week:Number(w),event_id:eventId,...values})});
 const result=await response.json();setMessage(result.ok?"Saved. Changes will appear after Vercel deploys.":result.error||"Save failed.");
 }catch{setMessage("Network error while saving.");}finally{setBusy(false)}}
 return <section className="panel" style={{padding:20,marginTop:18}}>
 <h2>Manual Prediction Editor</h2>
 <p className="muted">Enter probabilities as decimals (e.g. 0.65 for 65%). Manual retrospective entries are timestamped and are not verified pregame predictions.</p>
 <form onSubmit={save} style={{display:"grid",gap:12,maxWidth:640}}>
 <label>Week<select required value={week} onChange={e=>{setWeek(e.target.value);setEventId("");setMessage("")}} style={{display:"block",width:"100%",padding:10}}>{weeks.map(w=><option key={w.name} value={w.name}>{w.name}</option>)}</select></label>
 <label>Game<select required value={eventId} onChange={e=>setEventId(e.target.value)} style={{display:"block",width:"100%",padding:10}}><option value="">Select game</option>{games.map(g=><option key={g.event_id} value={g.event_id}>{g.away} @ {g.home}{g.manual?" (manual)":""}</option>)}</select></label>
 <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:10}}>
 {fields.map(([key,label])=><label key={key} style={{fontSize:13}}>{label}<input required type="number" step="any" value={values[key]||""} onChange={e=>setValues(v=>({...v,[key]:e.target.value}))} style={{display:"block",width:"100%",padding:10,marginTop:4}}/></label>)}
 </div>
 <button type="submit" disabled={!eventId||busy} style={{padding:12,fontWeight:700,cursor:"pointer"}}>{busy?"Saving…":"Save Manual Prediction"}</button>
 {message&&<p role="status">{message}</p>}
 </form></section>;
}
