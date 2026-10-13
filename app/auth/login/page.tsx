import { login } from '../actions';
export default async function Login({ searchParams }: { searchParams: Promise<{error?:string}> }) {
 const q=await searchParams;
 return <div className="auth panel"><h1>Administrator sign in</h1><p className="muted">Local authentication — no Supabase account required.</p>{q.error?<p className="authError">{q.error==='setup'?'Admin authentication is not configured.':'Incorrect password.'}</p>:null}<form action={login}><label>Administrator password</label><input name="password" type="password" autoComplete="current-password" required/><button className="button">Sign in</button></form></div>;
}
