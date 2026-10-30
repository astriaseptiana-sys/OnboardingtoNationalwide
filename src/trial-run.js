// Mode TRIAL (TRIAL=true): isi tab "Sort by New (Trial)" langsung dari sumber, urut terbaru dulu, tanpa rumus.
// Tidak menyentuh Nationwide, Sort by New, Control Panel, LOG, dan tidak mengirim SeaTalk. Hanya log GitHub.
import { REGION_SPLIT, SOURCES, TRIAL } from "./config.js";
import { createClient, hubMapFromRows, readRegionRows, readSource } from "./sheets.js";
import { buildOutput, fmtRibuan, splitResult } from "./transform.js";
import { buildRegionLookup, buildTrialTable } from "./trial.js";
import { ensureTrialTab, planTrialTab, writeTrialRows } from "./trial-write.js";

export async function runTrial({ dryRun = false, maxRowsOverride } = {}) {
  const t0 = Date.now();
  const lap = (label) => console.log(`⏱  ${label}: ${((Date.now() - t0) / 1000).toFixed(1)} dtk sejak mulai`);
  const api = createClient();
  console.log(`TRIAL — tab '${TRIAL.tab}'${dryRun ? " (DRY RUN: tidak menulis apa pun)" : ""}. Tab lain tidak disentuh.`);

  // 1) Baca 6 sumber (sama dengan sync produksi). Percobaan trial butuh data LENGKAP supaya bisa dibandingkan.
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

  // 3) Gabung + label Sumber_Region (pecahan Jabo), lalu urutkan dan hitung kolom P:W di kode
  const resolved = results.map((r) => (r.name === REGION_SPLIT.source ? splitResult(r, hubMap, REGION_SPLIT) : r));
  const out = buildOutput(resolved);
  const plan = await planTrialTab(api, { maxRowsOverride });
  const table = buildTrialTable(out.rows, out.regions.map((x) => x[0]), lookup, { maxRows: plan.maxRows });
  const notFound = table.rows.filter((r) => r[20] === "#N/A").length;
  console.log(
    `Tabel trial: ${fmtRibuan(table.rows.length)} baris dari ${fmtRibuan(table.total)} baris ber-create_date ` +
    `(${fmtRibuan(out.rows.length - table.total)} baris tanpa create_date dilewati, ${fmtRibuan(table.cut)} baris terlama dipotong karena ruang sel). ` +
    `Hub tidak ketemu di Region: ${notFound}. Baris teratas create_date: ${table.rows[0]?.[12]}`,
  );
  lap("tabel disusun di kode");

  if (dryRun) {
    console.log("DRY RUN selesai: tidak ada yang ditulis.");
    return;
  }

  // 4) Pastikan tab ada, tulis seluruh isinya
  const tab = await ensureTrialTab(api, plan, table.rows.length);
  console.log(`Tab trial ${tab.created ? "DIBUAT" : "sudah ada"} (grid ${fmtRibuan(tab.rowCount)} baris).`);
  for (const w of tab.warnings) console.log(`::warning::${w}`);
  lap("tab siap");
  const t1 = Date.now();
  const { lastRow } = await writeTrialRows(api, table.rows, tab.rowCount);
  console.log(`Tab trial ditulis sampai row ${fmtRibuan(lastRow)}. Waktu penulisan data saja: ${((Date.now() - t1) / 1000).toFixed(1)} dtk.`);
  lap("SELESAI");
}
