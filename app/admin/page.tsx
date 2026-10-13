import { notFound } from 'next/navigation';
// Admin access is disabled until a file-backed authentication mechanism is configured.
// Never expose operational information without authentication.
export default function Admin() { notFound(); }
