import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
export const dynamic='force-dynamic';
export async function GET() {
 try { const folder=path.join(process.cwd(),'data','predictions'); const files=(await fs.readdir(folder)).filter(x=>x.endsWith('.json')); return NextResponse.json({ok:files.length>0,storage:'local-json',prediction_weeks:files.length,time:new Date().toISOString()},{status:files.length>0?200:503}); }
 catch { return NextResponse.json({ok:false,storage:'local-json',error:'Prediction files unavailable'}, {status:503}); }
}
