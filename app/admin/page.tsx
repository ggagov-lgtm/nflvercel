import ManualPredictionEditor from "./ManualPredictionEditor";
import { redirect } from 'next/navigation';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { currentUser } from '@/lib/auth';
export const dynamic='force-dynamic';
async function files(folder:string) {try{return (await fs.readdir(path.join(process.cwd(),'data',folder))).filter(x=>x.endsWith('.json')).sort().reverse();}catch{return [] as string[];}}
export default async function Admin() {
  if (!await currentUser()) redirect('/auth/login');
  const [predictions,performance,results]=await Promise.all([files('predictions'),files('performance'),files('results')]);
  const weeks=await Promise.all(predictions.map(async name=>{try{const data=JSON.parse(await fs.readFile(path.join(process.cwd(),'data','predictions',name),'utf8'));return {name:name.replace(/\.json$/,''),games:(data.predictions||[]).map((p:{event_id:string;game?:{away?:{abbr?:string};home?:{abbr?:string}};backfill_status?:string})=>({event_id:String(p.event_id),away:p.game?.away?.abbr||'AWAY',home:p.game?.home?.abbr||'HOME',manual:!!p.backfill_status}))};}catch{return {name:name.replace(/\\.json$/,''),games:[]};}}));
  return <main><h1>Admin • Local File Health</h1><p className="muted">No database connection. All predictions and performance are stored as versioned JSON in GitHub.</p><div className="health"><div className="panel"><span className="muted">PREDICTION WEEKS</span><h2>{predictions.length}</h2></div><div className="panel"><span className="muted">PERFORMANCE WEEKS</span><h2>{performance.length}</h2></div><div className="panel"><span className="muted">SETTLED WEEKS</span><h2>{results.length}</h2></div></div><ManualPredictionEditor weeks={weeks}/><h2>Available prediction files</h2><div className="panel">{predictions.length?predictions.map(f=><p key={f}>{f}</p>):<p className="muted">No prediction files yet.</p>}</div><h2>Performance files</h2><div className="panel">{performance.length?performance.map(f=><p key={f}>{f}</p>):<p className="muted">No performance files yet.</p>}</div><p className="muted">For run logs and failures, see the GitHub Actions NFL Weekly Model workflow.</p></main>;
}
