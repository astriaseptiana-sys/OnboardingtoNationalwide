// Mode TRIAL (TRIAL=true): isi tab "Sort by New (Trial)" langsung dari sumber, urut terbaru dulu, tanpa rumus.
// Impor INKREMENTAL: sumber dibandingkan dengan isi tab, dan hanya baris yang BELUM ada di tab yang disisipkan.
// Tulis ulang penuh hanya untuk tab kosong/baru, kalau diminta (TRIAL_FULL=true), atau kalau perubahannya terlalu besar.
// Tidak menyentuh Nationwide, Sort by New, Control Panel, LOG, dan tidak mengirim SeaTalk. Hanya log GitHub.
import { REGION_SPLIT, SOURCES, TRIAL } from "./config.js";
import { createClient, hubMapFromRows, readRegionRows, readSource } from "./sheets.js";
import { buildOutput, fmtRibuan, splitResult } from "./transform.js";
import { buildRegionLookup, buildTrialTable } from "./trial.js";
import { buildBalance, formatBalance } from "./trial-balance.js";
import { planIncremental } from "./trial-diff.js";
import { applyIncremental, applyTrialFormats, ensureTrialTab, planTrialTab, readTrialRows, verifyTrialTop, writeTrialRows } from "./trial-write.js";

// Serial tanggal Google Sheets (jam dinding WIB) -> teks
const serialText = (n) => (typeof n === "number"
  ? new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)).toISOString().slice(0, 19).replace("T", " ")
  : "-");

export async function runTrial({ dryRun = false, maxRowsOverride, full = false } = {}) {
  const t0 = Date.now();
  const lap = (label) => console.log(`⏱  ${label}: ${((Date.now() - t0) / 1000).toFixed(1)} dtk sejak mulai`);
  const api = createClient();
  console.log(`TRIAL — tab '${TRIAL.tab}'${dryRun ? " (DRY RUN: tidak menulis apa pun)" : ""}${full ? " [TULIS ULANG PENUH diminta]" : ""}. Tab lain tidak disentuh.`);

  // 1) Baca 6 sumber (sama dengan sync produksi). Percobaan trial butuh data LENGKAP supaya perbandingannya benar.
  const results = await Promise.all(SOURCES.map((s) => readSource(api, s)));
  for (const r of results) {
    console.log(r.ok ? `✅ ${r.name}: ${fmtRibuan(r.rows.length)} baris` : `❌ ${r.name}: ${r.error}`);
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) throw new Error(`Sumber gagal dibaca (${failed.map((r) => r.name).join(", ")}) — percobaan trial dibatalkan agar tab trial tidak berisi data parsial`);
  lap("sumber dibaca");

  // 2) Tab Region: peta hub untuk label pecahan Jabo (X) dan pencarian Region/Province/City (U:W)
  const regionRows = await readRegionRows(api);
  const hubMap = hubMapFromRows(regionRows, REGION_SPLIT);
  const lookup = buildRegionLookup(regionRows);
  console.log(`Tab Region dibaca: ${fmtRibuan(regionRows.length)} baris, ${hubMap.size} hub Jabo, ${lookup.size} hub total`);
  lap("tab Region dibaca");

  // 3) Susun seluruh tabel sumber di kode (urut terbaru dulu, kolom P:W dihitung); belum dipotong
  const resolved = results.map((r) => (r.name === REGION_SPLIT.source ? splitResult(r, hubMap, REGION_SPLIT) : r));
  const out = buildOutput(resolved);
  const table = buildTrialTable(out.rows, out.regions.map((x) => x[0]), lookup);
  const plan = await planTrialTab(api, { maxRowsOverride });
  const notFound = table.rows.filter((r) => r[20] === "#N/A").length;
  console.log(
    `Sumber: ${fmtRibuan(table.total)} baris ber-create_date (${fmtRibuan(out.rows.length - table.total)} tanpa create_date dilewati). ` +
    `Ruang tab: maksimum ${fmtRibuan(plan.maxRows)} baris. Hub tidak ketemu di Region: ${notFound}.`,
  );
  lap("tabel sumber disusun di kode");

  // 4) Bandingkan dengan isi tab (kalau tab sudah ada dan bukan permintaan tulis ulang penuh)
  let mode = "full";
  let reason = full ? "diminta (TRIAL_FULL=true)" : "tab trial belum ada";
  let diff = null;
  let before = null;
  if (!full && plan.trial) {
    before = await readTrialRows(api);
    lap(`isi tab trial dibaca (${fmtRibuan(before.rows.length)} baris)`);
    diff = planIncremental({ table: table.rows, target: before.rows, maxRows: plan.maxRows });
    console.log(
      `PERBANDINGAN — terbaru di sumber: ${serialText(diff.newestSource)} | terbaru di tab: ${serialText(diff.newestTarget)} | ` +
      `baris sumber di rentang tab: ${fmtRibuan(diff.inWindow ?? 0)} | baris di tab: ${fmtRibuan(diff.targetRows ?? 0)}`,
    );
    console.log(
      `  baris BARU (belum ada di tab): ${fmtRibuan(diff.additions?.length ?? 0)} | di tab tetapi tidak lagi ada/berubah di sumber: ${fmtRibuan(diff.stale ?? 0)}` +
      (diff.groups?.length ? ` | tersebar di ${diff.groups.length} posisi` : ""),
    );
    mode = diff.mode;
    reason = diff.reason ?? "";
  }
  console.log(`KEPUTUSAN: ${mode === "incremental" ? "impor INKREMENTAL (hanya baris baru)" : mode === "none" ? "tidak ada baris baru, tab sudah sama dengan sumber" : `tulis ulang PENUH (${reason})`}`);

  // Pemeriksaan balance: tab vs tab Success. Dipakai sebelum menulis (dry run / tidak ada perubahan) dan sesudah menulis.
  const checkBalance = (state, label) => {
    const b = buildBalance({ table: table.rows, tabRows: state.rows, tabLabels: state.labels });
    console.log(`
[${label}]
${formatBalance(b)}`);
    return b;
  };

  if (dryRun) {
    if (before) checkBalance(before, "kondisi tab SAAT INI (sebelum ada yang ditulis)");
    console.log("DRY RUN selesai: tidak ada yang ditulis.");
    return { status: "dry-run" };
  }

  // 5) Eksekusi
  // Format tanggal/SLA dijaga eksplisit di seluruh tab (tidak fatal kalau gagal; hanya tampilan)
  if (plan.trial) {
    try { await applyTrialFormats(api, plan.trial.sheetId); } catch (e) { console.log(`::warning::Format tanggal/SLA tab trial gagal (${e.message})`); }
  }

  if (mode === "none") {
    if (diff.stale > 0) console.log(`::warning::${diff.stale} baris di tab sudah tidak ada/berubah di sumber; jalankan dengan TRIAL_FULL untuk menyamakan`);
    lap("tidak ada perubahan");
    return finish(checkBalance(before, "HASIL AKHIR (tidak ada baris baru)"), lap);
  }

  if (mode === "incremental") {
    const t1 = Date.now();
    await applyIncremental(api, plan.trial.sheetId, diff, { maxRows: plan.maxRows });
    const v = await verifyTrialTop(api, diff.newestSource);
    if (!v.ok) console.log(`::warning::Pemeriksaan baris teratas tab trial tidak lolos (${v.error})`);
    console.log(`Impor inkremental selesai: ${fmtRibuan(diff.additions.length)} baris baru. Waktu penulisan saja: ${((Date.now() - t1) / 1000).toFixed(1)} dtk.`);
    lap("penulisan selesai");
  } else {
    // mode "full": tab dibuat/diperbesar kalau perlu, lalu isinya ditulis ulang. Kalau ruang sel tidak cukup untuk SEMUA
    // baris, yang terlama dipotong dan itu DILAPORKAN terang-terangan di balance (bukan diam-diam).
    const capped = table.rows.slice(0, plan.maxRows);
    if (capped.length < table.rows.length) {
      console.log(`::warning::Ruang sel hanya cukup untuk ${fmtRibuan(capped.length)} dari ${fmtRibuan(table.rows.length)} baris; ${fmtRibuan(table.rows.length - capped.length)} baris TERLAMA tidak dimuat`);
    }
    const tab = await ensureTrialTab(api, plan, capped.length);
    console.log(`Tab trial ${tab.created ? "DIBUAT" : "sudah ada"} (grid ${fmtRibuan(tab.rowCount)} baris).`);
    for (const w of tab.warnings) console.log(`::warning::${w}`);
    lap("tab siap");
    const t1 = Date.now();
    const { lastRow } = await writeTrialRows(api, capped, tab.rowCount);
    console.log(`Tab trial ditulis penuh sampai row ${fmtRibuan(lastRow)}. Waktu penulisan data saja: ${((Date.now() - t1) / 1000).toFixed(1)} dtk.`);
    lap("penulisan selesai");
  }

  // 6) Baca ulang tab dan bandingkan lagi dengan Success: harus BALANCE
  const after = await readTrialRows(api);
  lap(`tab dibaca ulang (${fmtRibuan(after.rows.length)} baris)`);
  return finish(checkBalance(after, "HASIL AKHIR (tab dibaca ulang setelah ditulis)"), lap);
}

// Status akhir: TIDAK BALANCE = galat (job gagal); BALANCE DALAM RENTANG = peringatan; BALANCE PENUH = bersih.
function finish(b, lap) {
  if (b.status === "tidak-balance") console.log(`::error::TIDAK BALANCE: ${b.missing} akun sumber belum ada di tab, ${b.extra} akun di tab tidak ada di sumber, jumlah baris sesuai: ${b.countOk}`);
  else if (b.status === "balance-rentang") console.log(`::warning::Balance hanya dalam rentang tab: ${fmtRibuan(b.notInTab)} baris sumber yang lebih lama tidak muat (perlu ±${fmtRibuan(b.cellsNeeded)} sel lagi)`);
  lap("SELESAI");
  return { status: b.status };
}
