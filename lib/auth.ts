import 'server-only';
import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual, scryptSync } from 'node:crypto';
import config from '@/config/admin-auth.json';
const cookieName = 'pfq_admin';
function secret() { return process.env.ADMIN_SESSION_SECRET || config.session_secret; }
export function isConfigured() { return Boolean((process.env.ADMIN_PASSWORD || config.password_hash) && secret().length >= 32); }
export function verifyPassword(password:string) {
 if (process.env.ADMIN_PASSWORD) {
   const expected=scryptSync(process.env.ADMIN_PASSWORD,'admin',32);
   const actual=scryptSync(password,'admin',32);
   return timingSafeEqual(expected,actual);
 }
 const expected=Buffer.from(config.password_hash,'hex');
 const actual=scryptSync(password,Buffer.from(config.salt,'hex'),expected.length);
 return timingSafeEqual(expected,actual);
}
function signature() { return createHmac('sha256', secret()).update('pfq-admin-v1').digest('hex'); }
export async function currentUser() {
 if (!isConfigured()) return null;
 const jar = await cookies();
 const received = jar.get(cookieName)?.value || '';
 const expected = signature();
 if (received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
 return { email: 'admin@local' };
}
export function isAdmin(email?: string | null) { return email === 'admin@local'; }
export { cookieName, signature };
