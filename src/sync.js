import { ATTEMPT_PAUSE_MS, DEST, MAX_ATTEMPTS, REGION_SPLIT, SOURCES } from "./config.js";
import { bounded } from "./deadline.js";
import { sendSeaTalk } from "./seatalk.js";
import { failureEntry, successEntry } from "./log.js";
import { buildPanel, setPanelBusy, setPanelError, updateControlPanel } from "./panel.js";
import {
  appendLogRow, appendLogRowOnce, createClient, readPreviousColumn, readRegionMap, readSource, verifyLastRow, writeDestination,
} from "./sheets.js";
import { runTrial } from "./trial-run.js";
import { buildFailureReport, buildOutput, buildReport, fmtRibuan, splitResult, summarize, tallyRegions } from "./transform.js";

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "true";
// SKIP_PANEL=true: Control Panel tidak disentuh sama sekali (penanda "Sedang Diproses", pengisian, penanda Error).
const skipPanel = process.env.SKIP_PANEL === "true";
// FULL_READBACK=true: baca ulang seluruh kolom Sumber_Region setelah menulis (verifikasi penuh, berat). Bawaan: cek ringan.
const fullReadback = process.env.FULL_READBACK === "true";
// TRIAL=true: hanya mengisi tab "Sort by New (Trial)" (lihat trial-run.js); tab lain, LOG, panel, SeaTalk tidak disentuh.
const trialMode = process.env.TRIAL === "true";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

// Batas total untuk pekerjaan kecil sesudah data utama (Control Panel, LOG, cek baris terakhir), agar run tidak molor.
const POST_WRITE_BUDGET_MS = 90_000;
// Putaran kedua HANYA untuk Control Panel/LOG yang gagal di putaran pertama (Google sering masih sibuk menghitung ulang rumus
// sesudah penulisan data besar). Tidak jalan sama sekali kalau putaran pertama berhasil, jadi run normal tidak bertambah lama.
const SECOND_PASS_BUDGET_MS = 180_000;
// Batas untuk pembacaan pelengkap sebelum penulisan data (peta hub, data run sebelumnya).
const PRE_READ_BUDGET_MS = 45_000;
// Batas untuk penanda "Sedang Diproses" di awal run.
const BUSY_BUDGET_MS = 15_000;

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
  // Indikator "Sedang Diproses..." di Control Panel: sekadar tambahan, dibatasi dan dibatalkan kalau lewat waktu
  if (!dryRun && !skipPanel) await bounded((signal) => setPanelBusy(api, { signal }), BUSY_BUDGET_MS);

  // Baca 6 sumber paralel; satu sumber gagal tidak menghentikan yang lain.
  const results = await Promise.all(SOURCES.map((s) => readSource(api, s)));
  for (const r of results) {
    console.log(r.ok ? `✅ ${r.name}: ${fmtRibuan(r.rows.length)} baris (${r.dropped} baris kosong dilewati)` : `❌ ${r.name}: ${r.error}`);
  }

  // Pecah sumber Jabodetabek per hub (West/South/East/North Jabo, dari provinsi + kota hub). Peta gagal dibaca -> tetap sync dengan label
  // sumber asli; semua baris Jabo terhitung "belum terpetakan" dan muncul sebagai peringatan di laporan.
  // Peta hub dan data run sebelumnya (kolom X, untuk perbandingan di laporan) dibaca bersamaan dengan batas waktu;
  // keduanya pelengkap, jadi kalau lambat/gagal sync tetap jalan tanpa menunggu lama (dan permintaannya dibatalkan).
  const needMap = results.some((r) => r.name === REGION_SPLIT.source && r.ok);
  const [mapRes, prevRes] = await Promise.all([
    needMap ? bounded((signal) => readRegionMap(api, REGION_SPLIT, { signal }), PRE_READ_BUDGET_MS) : { ok: false },
    bounded((signal) => readPreviousColumn(api, { signal }), PRE_READ_BUDGET_MS),
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
  let prevLastRow; // baris data terakhir run sebelumnya, untuk membatasi format tanggal ke baris baru saja
  if (prevRes.ok) {
    prevCounts = tallyRegions(prevRes.value);
    prevLastRow = Object.values(prevCounts).reduce((a, b) => a + b, 0) + DEST.firstRow - 1;
  } else {
    console.warn(`Tidak bisa baca data sebelumnya: ${prevRes.error}`);
  }

  const warnings = [];
  let gid;
  let written = null;
  if (!dryRun) {
    written = await writeDestination(api, out, { prevLastRow });
    gid = written.sheetId;
    warnings.push(...(written.warnings ?? []));
    console.log(`Nationwide selesai ditulis sampai row ${written.lastRow}`);
  }

  const summary = summarize(resolved, prevCounts);

  // Sesudah data utama tertulis: cek baris terakhir, Control Panel, dan LOG dikerjakan BERSAMAAN dengan batas waktu total.
  // bounded() tidak pernah throw dan membatalkan permintaan yang lewat waktu, jadi apa pun yang terjadi di sini tidak
  // bisa menggagalkan atau mengulang sync data yang sudah tertulis; yang gagal hanya menjadi peringatan di laporan.
  if (!dryRun) {
    const panelTask = async (signal) => {
      if (skipPanel) return { ok: true, skipped: true };
      let sheetCounts = null;
      if (fullReadback) {
        try {
          sheetCounts = tallyRegions(await readPreviousColumn(api, { signal }));
          console.log("Sumber_Region di Nationwide:", JSON.stringify(sheetCounts));
        } catch (e) {
          console.warn(`⚠️ Tidak bisa baca ulang Sumber_Region, panel memakai hitungan sync: ${e.message}`);
        }
      }
      return updateControlPanel(api, buildPanel(summary, { sheetCounts }), { signal });
    };
    const logRow = successEntry(summary, out.rows.length, { attempt }); // dibuat sekali: waktu yang sama dipakai kalau LOG dicoba ulang
    const [panelJob, logJob, verifyJob] = await Promise.all([
      bounded(panelTask, POST_WRITE_BUDGET_MS),
      bounded((signal) => appendLogRow(api, logRow, { signal }), POST_WRITE_BUDGET_MS),
      bounded((signal) => verifyLastRow(api, written.lastRow, { signal }), POST_WRITE_BUDGET_MS),
    ]);
    let panelRes = unwrap(panelJob);
    let logRes = unwrap(logJob);
    const verifyRes = unwrap(verifyJob);
    if (!panelRes.ok || !logRes.ok) {
      console.log(`Putaran pertama gagal untuk ${[!panelRes.ok && "Control Panel", !logRes.ok && "LOG"].filter(Boolean).join(" dan ")}; mencoba sekali lagi (maks ${SECOND_PASS_BUDGET_MS / 1000} dtk)...`);
      const [panel2, log2] = await Promise.all([
        panelRes.ok ? { ok: true, value: panelRes } : bounded(panelTask, SECOND_PASS_BUDGET_MS),
        logRes.ok ? { ok: true, value: logRes } : bounded((signal) => appendLogRowOnce(api, logRow, { signal }), SECOND_PASS_BUDGET_MS),
      ]);
      panelRes = unwrap(panel2);
      logRes = unwrap(log2);
    }
    if (!panelRes.ok) warnings.push(`Control Panel gagal diisi (${panelRes.error})`);
    else if (panelRes.missing?.length) warnings.push(`Baris tidak ditemukan di Control Panel: ${panelRes.missing.join(", ")}`);
    if (!logRes.ok) warnings.push(`Tab LOG gagal dicatat (${logRes.error})`);
    if (!verifyRes.ok) warnings.push(`Pemeriksaan baris terakhir Nationwide tidak lolos (${verifyRes.error})`);
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
  if (trialMode) {
    try {
      const res = await runTrial({ dryRun, maxRowsOverride: Number(process.env.TRIAL_MAX_ROWS) || undefined, full: process.env.TRIAL_FULL === "true" });
      process.exit(res?.status === "tidak-balance" ? 1 : 0);
    } catch (err) {
      console.error(`❌ Trial gagal: ${err.message}`);
      process.exit(1);
    }
  }
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
        skipPanel ? { ok: true, value: { ok: true } } : bounded((signal) => setPanelError(api, { signal }), POST_WRITE_BUDGET_MS),
        bounded((signal) => appendLogRow(api, failureEntry(lastErr, { attempts: maxAttempts }), { signal }), POST_WRITE_BUDGET_MS),
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
