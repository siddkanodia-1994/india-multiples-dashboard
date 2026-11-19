// Prints the app tables and the database size: npm run db:status
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
const t = await sql`select table_name from information_schema.tables where table_schema='public' order by 1`;
const s = await sql`select pg_size_pretty(pg_database_size(current_database())) size`;
console.log(t.map(r=>r.table_name).join(", "), "|", s[0].size);
