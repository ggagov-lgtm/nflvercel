import { createClient } from '@/lib/supabase/server'
export async function currentUser(){const s=await createClient();const {data:{user}}=await s.auth.getUser();return user}
export function isAdmin(email?:string|null){const admins=(process.env.ADMIN_EMAILS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);return !!email&&admins.includes(email.toLowerCase())}
