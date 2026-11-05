import { bounded } from "./deadline.js";
import { successEntry } from "./log.js";
import { buildPanel, updateControlPanel } from "./panel.js";
import { appendLogRow, appendLogRowOnce } from "./sheets.js";

const unwrap = (r) => (r.ok ? r.value : r);

// Control Panel + LOG ditulis SEBELUM data utama (lihat catatan di sync.js). Bersamaan dengan batas `firstMs`; yang gagal dicoba
// sekali lagi dengan batas `secondMs` (LOG dicek dulu supaya tidak ganda). Tidak pernah throw. Mengembalikan daftar peringatan.
export async function writePanelAndLog(api, { summary, rowCount, attempt = 1, skipPanel = false, firstMs, secondMs }) {
  const logRow = successEntry(summary, rowCount, { attempt }); // dibuat sekali: waktu yang sama dipakai kalau LOG dicoba ulang
  const panelTask = async (signal) => (skipPanel
    ? { ok: true, skipped: true }
    : updateControlPanel(api, buildPanel(summary), { signal }));

  const [panelJob, logJob] = await Promise.all([
    bounded(panelTask, firstMs),
    bounded((signal) => appendLogRow(api, logRow, { signal }), firstMs),
  ]);
  let panelRes = unwrap(panelJob);
  let logRes = unwrap(logJob);
  if (!panelRes.ok || !logRes.ok) {
    console.log(`Penulisan awal gagal untuk ${[!panelRes.ok && "Control Panel", !logRes.ok && "LOG"].filter(Boolean).join(" dan ")}; mencoba sekali lagi (maks ${secondMs / 1000} dtk)...`);
    const [panel2, log2] = await Promise.all([
      panelRes.ok ? { ok: true, value: panelRes } : bounded(panelTask, secondMs),
      logRes.ok ? { ok: true, value: logRes } : bounded((signal) => appendLogRowOnce(api, logRow, { signal }), secondMs),
    ]);
    panelRes = unwrap(panel2);
    logRes = unwrap(log2);
  }

  const warnings = [];
  if (!panelRes.ok) warnings.push(`Control Panel gagal diisi (${panelRes.error})`);
  else if (panelRes.missing?.length) warnings.push(`Baris tidak ditemukan di Control Panel: ${panelRes.missing.join(", ")}`);
  if (!logRes.ok) warnings.push(`Tab LOG gagal dicatat (${logRes.error})`);
  return warnings;
}
