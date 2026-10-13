// Public read-only site. Administrative access is disabled until local auth is configured.
export async function currentUser() { return null; }
export function isAdmin(_email?: string | null) { return false; }
