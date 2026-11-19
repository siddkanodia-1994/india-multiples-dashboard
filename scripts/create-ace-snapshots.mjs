// One-off: creates the ace_snapshots table without drizzle-kit push (which wanted to truncate ca_suggestions). Safe to re-run.
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
await sql`create table if not exists ace_snapshots (
  stock_id integer not null references stocks(id),
  basis char(1) not null,
  as_of date not null,
  mcap double precision,
  ev double precision,
  shares double precision,
  batch_id integer not null,
  primary key (stock_id, basis, as_of))`;
const c = await sql`select conname from pg_constraint where conrelid = 'ca_suggestions'::regclass`;
console.log("ace_snapshots ready; ca_suggestions constraints:", c.map((r) => r.conname).join(", "));
