import { NextResponse } from 'next/server';
import { cookieName } from '@/lib/auth';
export async function POST(req: Request) { const response=NextResponse.redirect(new URL('/',req.url),303);response.cookies.delete(cookieName);return response; }
