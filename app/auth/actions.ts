'use server';
import {redirect} from 'next/navigation';
import {headers} from 'next/headers';
import {createClient} from '@/lib/supabase/server';

export async function login(fd:FormData){
  const s=await createClient();
  const {error}=await s.auth.signInWithPassword({email:String(fd.get('email')),password:String(fd.get('password'))});
  if(error)redirect('/auth/login?error=1');
  redirect('/');
}

export async function signup(fd:FormData){
  const s=await createClient();
  const {error}=await s.auth.signUp({email:String(fd.get('email')),password:String(fd.get('password')),options:{data:{name:String(fd.get('name'))}}});
  if(error)redirect('/auth/register?error=1');
  redirect('/');
}

export async function requestPasswordReset(fd:FormData){
  const email=String(fd.get('email')||'').trim();
  const h=await headers();
  const origin=h.get('origin') || process.env.NEXT_PUBLIC_SITE_URL || 'https://nflvercel.vercel.app';
  const s=await createClient();
  await s.auth.resetPasswordForEmail(email,{redirectTo:`${origin}/auth/callback?next=/auth/reset-password`});
  redirect('/auth/forgot-password?sent=1');
}

export async function updatePassword(fd:FormData){
  const password=String(fd.get('password')||'');
  const confirm=String(fd.get('confirm')||'');
  if(password.length<8 || password!==confirm)redirect('/auth/reset-password?error=1');
  const s=await createClient();
  const {error}=await s.auth.updateUser({password});
  if(error)redirect('/auth/reset-password?error=1');
  redirect('/auth/login?reset=1');
}
