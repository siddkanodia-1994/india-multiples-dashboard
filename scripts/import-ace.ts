// Loads an Ace Equity "Query Expression" export into Neon from the command line,
// through the same parser and batch logic as the Admin upload:
//   npm run import-ace -- "<path to .xlsx>" [profile]
// The file stays where it is: Ace data is licensed and never goes into the repo.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as XLSX from "xlsx";
import { parseAceRows } from "../src/lib/ace/parse";
import { saveAceRows } from "../src/lib/ace/store";

async function main() {
  const [file, profile = "import script"] = process.argv.slice(2);
  if (!file) throw new Error('Usage: npm run import-ace -- "<file.xlsx>" [profile]');
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const sheet = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
  const { rows, errors, missing } = parseAceRows(sheet);
  if (missing.length) console.log("Columns not in this file:", missing.join(", "));
  if (errors.length) console.log("Skipped:", errors.join(" | "));
  if (!rows.length) throw new Error("Nothing to import.");
  const { batchId, companies } = await saveAceRows(rows, basename(file), profile);
  console.log(`Batch ${batchId}:`);
  for (const c of companies) console.log(`  ${c.name}: ${c.from} → ${c.to}, ${c.added} new, ${c.changed} changed, ${c.unchanged} unchanged${c.newStock ? " (new stock)" : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
