import { ATTEMPT_PAUSE_MS, DEST, MAX_ATTEMPTS, REGION_SPLIT, SOURCES } from "./config.js";
import { bounded } from "./deadline.js";
import { sendSeaTalk } from "./seatalk.js";
import { failureEntry, successEntry } from "./log.js";
import { buildPanel, setPanelBusy, setPanelError, updateControlPanel } from "./panel.js";
import { appendLogRow, createClient, readPreviousColumn, readRegionMap, readSource, writeDestination } from "./sheets.js";
import { buildFailureReport, buildOutput, buildReport, fmtRibuan, splitResult, summarize, tallyRegions } from "./transform.js";

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

// Batas total untuk penulisan kecil sesudah data utama (Control Panel + LOG), agar run tidak molor.
const POST_WRITE_BUDGET_MS = 90_000;
// Batas untuk pembacaan pelengkap sebelum penulisan data (peta hub, data run sebelumnya).
const PRE_READ_BUDGET_MS = 45_000;

// bounded() -> { ok, value } atau { ok:false, error }; ambil hasil asli fungsinya ({ ok, error, ... }) kalau sempat selesai.
const unwrap = (r) => (r.ok ? r.value : r);

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
  // Indikator "Sedang Diproses..." di Control Panel: sekadar tambahan, maksimal 15 detik dan tidak boleh menunda sync data
  if (!dryRun) await bounded(() => setPanelBusy(api), 15_000);

  // Baca 6 sumber paralel; satu sumber gagal tidak menghentikan yang lain.
  const results = await Promise.all(SOURCES.map((s) => readSource(api, s)));
  for (const r of results) {
    console.log(r.ok ? `✅ ${r.name}: ${fmtRibuan(r.rows.length)} baris (${r.dropped} baris kosong dilewati)` : `❌ ${r.name}: ${r.error}`);
  }

  // Pecah sumber Jabodetabek per hub (West/South/East/North Jabo). Peta gagal dibaca -> tetap sync dengan label
  // sumber asli; semua baris Jabo terhitung "belum terpetakan" dan muncul sebagai peringatan di laporan.
  // Peta hub dan data run sebelumnya (kolom X, untuk perbandingan di laporan) dibaca bersamaan dengan batas waktu;
  // keduanya pelengkap, jadi kalau lambat/gagal sync tetap jalan tanpa menunggu lama.
  const needMap = results.some((r) => r.name === REGION_SPLIT.source && r.ok);
  const [mapRes, prevRes] = await Promise.all([
    needMap ? bounded(() => readRegionMap(api), PRE_READ_BUDGET_MS) : { ok: false },
    bounded(() => readPreviousColumn(api), PRE_READ_BUDGET_MS),
  ]);
  let hubMap = null;
  if (mapRes.ok) {
    hubMap = mapRes.value;
    console.log(`Peta hub dibaca: ${hubMap.size} hub untuk ${REGION_SPLIT.regions.join(", ")}`);
  } else if (needMap) {
    console.warn(`⚠️ Peta hub tab ${REGION_SPLIT.mapTab} gagal dibaca: ${mapRes.error}`);
  }
  const resolved = results.map((r) => (r.name === REGION_SPLIT.source ? splitResult(r, hubMap, REGION_SPLIT) : r));
  const out = buildOutput(resolved);
  if (out.rows.length === 0) {
    throw new Error("Semua sumber gagal atau kosong — Nationwide tidak ditimpa");
  }

  let prevCounts = null;
  if (prevRes.ok) prevCounts = tallyRegions(prevRes.value);
  else console.warn(`Tidak bisa baca data sebelumnya: ${prevRes.error}`);

  let gid;
  if (!dryRun) {
    const written = await writeDestination(api, out);
    gid = written.sheetId;
    console.log(`Nationwide selesai ditulis sampai row ${written.lastRow}`);
  }

  const summary = summarize(resolved, prevCounts);

  // Control Panel dan LOG diisi sebelum laporan dikirim; kalau salah satunya gagal (setelah retry sabar),
  // peringatannya ikut masuk ke pesan SeaTalk supaya tidak gagal diam-diam.
  const warnings = [];
  if (!dryRun) {
    // Control Panel (angka dari Sumber_Region yang dibaca ulang) dan LOG dikerjakan BERSAMAAN dengan batas waktu total,
    // supaya run tidak molor kalau Google sedang lambat; yang belum selesai hanya jadi peringatan.
    const panelTask = async () => {
      let sheetCounts = null;
      try {
        sheetCounts = tallyRegions(await readPreviousColumn(api));
        console.log("Sumber_Region di Nationwide:", JSON.stringify(sheetCounts));
      } catch (e) {
        console.warn(`⚠️ Tidak bisa baca ulang Sumber_Region, panel memakai hitungan sync: ${e.message}`);
        warnings.push("Sumber_Region tidak bisa dibaca ulang; angka Control Panel memakai hitungan sync (tidak diverifikasi terhadap sheet)");
      }
      return updateControlPanel(api, buildPanel(summary, { sheetCounts }));
    };
    // bounded(): tidak pernah throw (bug/error di sini tidak boleh menggagalkan atau mengulang sync data yang sudah tertulis)
    const [panelJob, logJob] = await Promise.all([
      bounded(panelTask, POST_WRITE_BUDGET_MS),
      bounded(() => appendLogRow(api, successEntry(summary, out.rows.length, { attempt })), POST_WRITE_BUDGET_MS),
    ]);
    const panelRes = unwrap(panelJob);
    const logRes = unwrap(logJob);
    if (!panelRes.ok) warnings.push(`Control Panel gagal diisi (${panelRes.error})`);
    else if (panelRes.missing?.length) warnings.push(`Baris tidak ditemukan di Control Panel: ${panelRes.missing.join(", ")}`);
    if (!logRes.ok) warnings.push(`Tab LOG gagal dicatat (${logRes.error})`);
  }

  const report = buildReport(summary, {
    durationSec: Math.round((Date.now() - t0) / 1000),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${DEST.spreadsheetId}/edit${gid != null ? `#gid=${gid}` : ""}`,
    dryRun,
    rerunUrl: rerunUrl(),
    warnings,
  });
  console.log("\n" + report);

  if (summary.items.some((i) => i.status === "error")) {
    console.log("::warning::Ada sumber yang gagal diambil — lihat laporan di atas");
  }
  for (const w of warnings) console.log(`::warning::${w}`);
  if (!dryRun) await sendSeaTalk(report);
}

// Seluruh sync diulang sekali kalau gagal (menimpa penuh, jadi aman diulang).
// Notifikasi gagal hanya dikirim setelah percobaan terakhir, supaya grup tidak dibanjiri.
async function main() {
  const maxAttempts = dryRun ? 1 : MAX_ATTEMPTS;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runOnce(attempt);
      // Keluar langsung: permintaan/retry yang kalah dari batas waktu tidak boleh menahan job GitHub tetap hidup.
      process.exit(0);
    } catch (err) {
      lastErr = err;
      console.error(`❌ Percobaan ${attempt}/${maxAttempts} gagal: ${err.message}`);
      if (attempt < maxAttempts) {
        console.log(`Mencoba ulang dalam ${ATTEMPT_PAUSE_MS / 1000} dtk...`);
        await sleep(ATTEMPT_PAUSE_MS);
      }
    }
  }
  const warnings = [];
  if (!dryRun) {
    try {
      const api = createClient();
      // Bersamaan dan dengan batas waktu total, sama seperti jalur sukses
      const [panelJob, logJob] = await Promise.all([
        bounded(() => setPanelError(api), POST_WRITE_BUDGET_MS),
        bounded(() => appendLogRow(api, failureEntry(lastErr, { attempts: maxAttempts })), POST_WRITE_BUDGET_MS),
      ]);
      const panelRes = unwrap(panelJob);
      const logRes = unwrap(logJob);
      if (!panelRes.ok) warnings.push(`Control Panel gagal ditandai Error (${panelRes.error})`);
      if (!logRes.ok) warnings.push(`Tab LOG gagal dicatat (${logRes.error})`);
    } catch (e) {
      console.warn(`⚠️ Tidak bisa mencatat kegagalan ke sheet: ${e.message}`);
      warnings.push(`Kegagalan tidak tercatat di sheet (${e.message})`);
    }
  }
  if (!dryRun) await sendSeaTalk(buildFailureReport(lastErr, { runUrl: runUrl(), attempts: maxAttempts, rerunUrl: rerunUrl(), warnings }));
  process.exit(1);
}

main();
