import { ATTEMPT_PAUSE_MS, DEST, MAX_ATTEMPTS, SOURCES } from "./config.js";
import { sendSeaTalk } from "./seatalk.js";
import { createClient, readPreviousColumn, readSource, writeDestination } from "./sheets.js";
import { buildFailureReport, buildOutput, buildReport, fmtRibuan, summarize, tallyRegions } from "./transform.js";

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

function runUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : undefined;
}

// Halaman workflow tempat tombol "Run workflow" berada (GitHub tidak punya link yang langsung menjalankan).
function rerunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY } = process.env;
  return GITHUB_REPOSITORY ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/workflows/sync.yml` : undefined;
}

async function runOnce() {
  const api = createClient();

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
    rerunUrl: rerunUrl(),
  });
  console.log("\n" + report);

  if (summary.items.some((i) => i.status === "error")) {
    console.log("::warning::Ada sumber yang gagal diambil — lihat laporan di atas");
  }
  if (!dryRun) await sendSeaTalk(report);
}

// Seluruh sync diulang sekali kalau gagal (menimpa penuh, jadi aman diulang).
// Notifikasi gagal hanya dikirim setelah percobaan terakhir, supaya grup tidak dibanjiri.
async function main() {
  const maxAttempts = dryRun ? 1 : MAX_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runOnce();
      return;
    } catch (err) {
      lastErr = err;
      console.error(`❌ Percobaan ${attempt}/${maxAttempts} gagal: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log(`Mencoba ulang dalam ${ATTEMPT_PAUSE_MS / 1000} dtk...`);
        await sleep(ATTEMPT_PAUSE_MS);
      }
    }
  }
  if (!dryRun) await sendSeaTalk(buildFailureReport(lastErr, { runUrl: runUrl(), attempts: maxAttempts, rerunUrl: rerunUrl() }));
  process.exit(1);
}

main();
