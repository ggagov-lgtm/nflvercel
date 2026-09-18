import {NextResponse} from 'next/server';
import {createClient} from '@/lib/supabase/server';

function safeNext(value:string|null){
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/auth/reset-password';
}

export async function GET(request:Request){
  const url=new URL(request.url);
  const next=safeNext(url.searchParams.get('next'));
  const code=url.searchParams.get('code');

  if(code){
    const s=await createClient();
    const {error}=await s.auth.exchangeCodeForSession(code);
    if(!error)return NextResponse.redirect(new URL(next,url.origin));
  }

  return NextResponse.redirect(new URL('/auth/forgot-password?error=invalid-link',url.origin));
}
