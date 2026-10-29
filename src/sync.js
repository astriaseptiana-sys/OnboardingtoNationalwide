import { ATTEMPT_PAUSE_MS, DEST, MAX_ATTEMPTS, REGION_SPLIT, SOURCES } from "./config.js";
import { sendSeaTalk } from "./seatalk.js";
import { failureEntry, successEntry } from "./log.js";
import { buildPanel, setPanelBusy, setPanelError, updateControlPanel } from "./panel.js";
import { appendLogRow, createClient, readPreviousColumn, readRegionMap, readSource, writeDestination } from "./sheets.js";
import { buildFailureReport, buildOutput, buildReport, fmtRibuan, splitResult, summarize, tallyRegions } from "./transform.js";

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

async function runOnce(attempt) {
  const api = createClient();
  if (!dryRun) await setPanelBusy(api); // indikator "Sedang Diproses..." di Control Panel

  // Baca 6 sumber paralel; satu sumber gagal tidak menghentikan yang lain.
  const results = await Promise.all(SOURCES.map((s) => readSource(api, s)));
  for (const r of results) {
    console.log(r.ok ? `✅ ${r.name}: ${fmtRibuan(r.rows.length)} baris (${r.dropped} baris kosong dilewati)` : `❌ ${r.name}: ${r.error}`);
  }

  // Pecah sumber Jabodetabek per hub (West/South/East/North Jabo). Peta gagal dibaca -> tetap sync dengan label
  // sumber asli; semua baris Jabo terhitung "belum terpetakan" dan muncul sebagai peringatan di laporan.
  let hubMap = null;
  if (results.some((r) => r.name === REGION_SPLIT.source && r.ok)) {
    try {
      hubMap = await readRegionMap(api);
      console.log(`Peta hub dibaca: ${hubMap.size} hub untuk ${REGION_SPLIT.regions.join(", ")}`);
    } catch (e) {
      console.warn(`⚠️ Peta hub tab ${REGION_SPLIT.mapTab} gagal dibaca: ${e.message}`);
    }
  }
  const resolved = results.map((r) => (r.name === REGION_SPLIT.source ? splitResult(r, hubMap, REGION_SPLIT) : r));
  const out = buildOutput(resolved);
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

  const summary = summarize(resolved, prevCounts);
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
  if (!dryRun) {
    // Angka Control Panel diambil dari kolom Sumber_Region di Nationwide (dibaca ulang setelah ditulis);
    // kalau gagal dibaca, panel memakai hitungan sync.
    let sheetCounts = null;
    try {
      sheetCounts = tallyRegions(await readPreviousColumn(api));
      console.log("Sumber_Region di Nationwide:", JSON.stringify(sheetCounts));
    } catch (e) {
      console.warn(`⚠️ Tidak bisa baca ulang Sumber_Region, panel memakai hitungan sync: ${e.message}`);
    }
    await updateControlPanel(api, buildPanel(summary, { sheetCounts }));
    await appendLogRow(api, successEntry(summary, out.rows.length, { attempt }));
    await sendSeaTalk(report);
  }
}

// Seluruh sync diulang sekali kalau gagal (menimpa penuh, jadi aman diulang).
// Notifikasi gagal hanya dikirim setelah percobaan terakhir, supaya grup tidak dibanjiri.
async function main() {
  const maxAttempts = dryRun ? 1 : MAX_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runOnce(attempt);
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
  if (!dryRun) {
    try {
      const api = createClient();
      await setPanelError(api);
      await appendLogRow(api, failureEntry(lastErr, { attempts: maxAttempts }));
    } catch (e) {
      console.warn(`⚠️ Tidak bisa mencatat kegagalan ke tab LOG: ${e.message}`);
    }
  }
  if (!dryRun) await sendSeaTalk(buildFailureReport(lastErr, { runUrl: runUrl(), attempts: maxAttempts, rerunUrl: rerunUrl() }));
  process.exit(1);
}

main();
