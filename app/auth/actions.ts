'use server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { cookieName, signature } from '@/lib/auth';
export async function login(fd: FormData) {
  const configured = process.env.ADMIN_PASSWORD || '';
  const supplied = String(fd.get('password') || '');
  if (!configured || !process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET.length < 32) redirect('/auth/login?error=setup');
  const a = createHash('sha256').update(configured).digest();
  const b = createHash('sha256').update(supplied).digest();
  if (!timingSafeEqual(a, b)) redirect('/auth/login?error=1');
  (await cookies()).set(cookieName, signature(), { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'lax', path:'/', maxAge:60*60*24*7 });
  redirect('/admin');
}
