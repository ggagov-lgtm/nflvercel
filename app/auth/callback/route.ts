import {NextResponse} from 'next/server';
import type {EmailOtpType} from '@supabase/supabase-js';
import {createClient} from '@/lib/supabase/server';

function safeNext(value:string|null){
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/auth/reset-password';
}

export async function GET(request:Request){
  const url=new URL(request.url);
  const next=safeNext(url.searchParams.get('next'));
  const tokenHash=url.searchParams.get('token_hash');
  const type=url.searchParams.get('type') as EmailOtpType | null;
  const code=url.searchParams.get('code');
  const s=await createClient();

  if(tokenHash && type){
    const {error}=await s.auth.verifyOtp({token_hash:tokenHash,type});
    if(!error)return NextResponse.redirect(new URL(next,url.origin));
  }else if(code){
    const {error}=await s.auth.exchangeCodeForSession(code);
    if(!error)return NextResponse.redirect(new URL(next,url.origin));
  }

  return NextResponse.redirect(new URL('/auth/forgot-password?error=invalid-link',url.origin));
}
