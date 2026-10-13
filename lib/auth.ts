import 'server-only';
import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
const cookieName = 'pfq_admin';
function secret() { return process.env.ADMIN_SESSION_SECRET || ''; }
function signature() { return createHmac('sha256', secret()).update('pfq-admin-v1').digest('hex'); }
export async function currentUser() {
  if (!process.env.ADMIN_PASSWORD || secret().length < 32) return null;
  const jar = await cookies();
  const received = jar.get(cookieName)?.value || '';
  const expected = signature();
  if (received.length !== expected.length || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) return null;
  return { email: 'admin@local' };
}
export function isAdmin(email?: string | null) { return email === 'admin@local'; }
export { cookieName, signature };
