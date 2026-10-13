import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const repo = "ggagov-lgtm/nflvercel";
const headers = () => ({ Authorization: `Bearer ${process.env.GITHUB_WRITE_TOKEN || ""}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
export async function POST(req: NextRequest) {
  if (!(await currentUser())) return NextResponse.json({error:"Unauthorized"},{status:401});
  if (!process.env.GITHUB_WRITE_TOKEN) return NextResponse.json({error:"Set GITHUB_WRITE_TOKEN in Vercel environment variables to enable saving."},{status:503});
  try {
    const body = await req.json();
    const season=Number(body.season), week=Number(body.week), eventId=String(body.event_id || "");
    if (!Number.isInteger(season)||season<2020||season>2100||!Number.isInteger(week)||week<1||week>22||!/^\d{5,15}$/.test(eventId)) return NextResponse.json({error:"Invalid game selection"},{status:400});
    const keys=["home_win_prob","away_win_prob","home_cover_prob","away_cover_prob","over_prob","under_prob","market_margin","market_total","pred_home","pred_away"];
    const values:Record<string,number>={};
    for (const key of keys) { const raw=body[key]; if(raw===""||raw===null||raw===undefined) return NextResponse.json({error:`Missing ${key}`},{status:400}); const n=Number(raw); if(!Number.isFinite(n)) return NextResponse.json({error:`Invalid ${key}`},{status:400}); values[key]=n; }
    for (const key of keys.filter(k=>k.endsWith("_prob"))) if(values[key]<0||values[key]>1) return NextResponse.json({error:`${key} must be between 0 and 1`},{status:400});
    for (const [a,b] of [["home_cover_prob","away_cover_prob"],["over_prob","under_prob"]]) if(Math.abs(values[a]+values[b]-1)>0.011) return NextResponse.json({error:`${a} and ${b} must total 100%`},{status:400});
    if(values.home_win_prob+values.away_win_prob>1.001) return NextResponse.json({error:"Win probabilities cannot exceed 100%"},{status:400});
    const file=`data/predictions/${season}-week-${week}.json`;
    const url=`https://api.github.com/repos/${repo}/contents/${file}`;
    const response=await fetch(url,{headers:headers(),cache:"no-store"});
    if(!response.ok) return NextResponse.json({error:`Cannot read archive (HTTP ${response.status})`},{status:502});
    const remote=await response.json();
    const data=JSON.parse(Buffer.from(remote.content,"base64").toString("utf8"));
    const row=(data.predictions||[]).find((p:Record<string,unknown>)=>String(p.event_id)===eventId);
    if(!row) return NextResponse.json({error:"Game is not in the selected archive"},{status:404});
    const now=new Date().toISOString();
    row.model={...(row.model||{}),...values,model_version:"manual-entry",simulations:0};
    row.market={...(row.market||{}),market_margin:values.market_margin,total:values.market_total,provider:"Manual entry"};
    row.model_version="manual-entry";
    row.manual_entry={created_at:now,source:"admin",retrospective:true,verified_pregame:false};
    row.backfill_status="retrospective_manual";
    row.prediction_run_at=now;
    row.locked_at=null;
    data.updated_at=now;
    const save=await fetch(url,{method:"PUT",headers:{...headers(),"Content-Type":"application/json"},body:JSON.stringify({message:`Manual retrospective prediction ${season} W${week} event ${eventId}`,sha:remote.sha,content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64")})});
    if(!save.ok) return NextResponse.json({error:`GitHub save failed (HTTP ${save.status}): ${(await save.text()).slice(0,250)}`},{status:502});
    return NextResponse.json({ok:true,message:"Saved to GitHub. Vercel deployment will follow."});
  } catch(e) {return NextResponse.json({error:e instanceof Error?e.message:"Unexpected error"},{status:500});}
}
