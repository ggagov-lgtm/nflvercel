import { NextResponse } from 'next/server';
export async function POST(req: Request) { return NextResponse.redirect(new URL('/', req.url), 303); }
