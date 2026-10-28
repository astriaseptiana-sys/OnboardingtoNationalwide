import { DEST, SOURCES } from "./config.js";
import { sendSeaTalk } from "./seatalk.js";
import { createClient, readPreviousColumn, readSource, writeDestination } from "./sheets.js";
import { buildFailureReport, buildOutput, buildReport, fmtRibuan, summarize, tallyRegions } from "./transform.js";

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined;
}

async function main() {
  const t0 = Date.now();
  const api = createClient();
  console.log(`Mulai sync${dryRun ? " (DRY RUN — tidak menulis apa pun)" : ""}`);

  // Baca 6 sumber paralel; satu sumber gagal tidak menghentikan yang lain.
  const results = await Promise.all(SOURCES.map((s) => readSource(api, s)));
  for (const r of results) {
    console.log(r.ok ? `✅ ${r.name}: ${fmtRibuan(r.rows.length)} baris (${r.dropped} baris kosong dilewati)` : `❌ ${r.name}: ${r.error}`);
  }

  const out = buildOutput(results);
  if (out.rows.length === 0) {
    throw new Error("Semua sumber gagal atau kosong — Nationwide tidak ditimpa");
  }

  // Data run sebelumnya (kolom X) dipakai untuk perbandingan di laporan; gagal baca bukan masalah fatal.
  let prevCounts = null;
  try {
    prevCounts = tallyRegions(await readPreviousColumn(api));
  } catch (e) {
    console.warn(`Tidak bisa baca data sebelumnya: ${e.message}`);
  }

  let gid;
  if (!dryRun) {
    const written = await writeDestination(api, out);
    gid = written.sheetId;
    console.log(`Nationwide selesai ditulis sampai row ${written.lastRow}`);
  }

  const summary = summarize(results, prevCounts);
  const report = buildReport(summary, {
    durationSec: Math.round((Date.now() - t0) / 1000),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${DEST.spreadsheetId}/edit${gid != null ? `#gid=${gid}` : ""}`,
    dryRun,
  });
  console.log("\n" + report);

  if (summary.items.some((i) => i.status === "error")) {
    console.log("::warning::Ada sumber yang gagal diambil — lihat laporan di atas");
  }
  if (!dryRun) await sendSeaTalk(report);
}

main().catch(async (err) => {
  console.error(`❌ GAGAL: ${err.message}`);
  if (!dryRun) await sendSeaTalk(buildFailureReport(err, { runUrl: runUrl() }));
  process.exit(1);
});
