'use server';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { cookieName, signature, verifyPassword, isConfigured } from '@/lib/auth';
export async function login(fd: FormData) {
  const supplied = String(fd.get('password') || '');
  if (!isConfigured()) redirect('/auth/login?error=setup');
  if (!verifyPassword(supplied)) redirect('/auth/login?error=1');
  (await cookies()).set(cookieName, signature(), { httpOnly:true, secure:process.env.NODE_ENV==='production', sameSite:'lax', path:'/', maxAge:60*60*24*7 });
  redirect('/admin');
}
