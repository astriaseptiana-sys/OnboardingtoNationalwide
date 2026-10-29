import { DEST } from "./config.js";
import { toSheetSerial } from "./log.js";
import { describeError, longOpts, retryLong } from "./sheets.js";

// Tab "Control Panel" di BPO Tracker. Hanya NILAI sel yang diisi (dan warna status), struktur tidak diubah.
// Layout sama dengan yang diisi script Apps Script lama:
//   B9 status sistem | D9 total baris | F9 update terakhir
//   tabel region: nama di kolom B (baris 13-20), lalu C=Rows, D=% of Total, E=Change, F=Status
export const PANEL = {
  tab: "Control Panel",
  status: { row: 9, col: "B" },
  total: { row: 9, col: "D" },
  updated: { row: 9, col: "F" },
  nameCol: "B",
  scanFrom: 13,
  scanTo: 26, // baris TOTAL (row 23 setelah Jabo dipecah 4) ada di dalam rentang ini
  totalName: "TOTAL",
  cols: { rows: "C", pct: "D", change: "E", status: "F" },
};

const COLORS = {
  ok: { fg: "#0F6E56", bg: "#E1F5EE" },
  anomaly: { fg: "#854F0B", bg: "#FAEEDA" },
  error: { fg: "#A32D2D", bg: "#FCEBEB" },
  busy: { fg: "#1A56A3" },
};
const REGION_STATUS = { ok: "✅ STABLE", anomaly: "⚠️ Anomali", error: "❌ Error", mismatch: "⚠️ Tidak sinkron" };
COLORS.mismatch = COLORS.anomaly;
const fmt = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

const colIdx = (l) => l.toUpperCase().charCodeAt(0) - 65;
const rgb = (hex) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});

function statusText(overall, failedNames, unmapped) {
  if (failedNames.length) return `${overall} — ${failedNames.join(", ")} tidak terambil`;
  if (unmapped > 0) return `${overall} — ${fmt(unmapped)} baris Jabo belum terpetakan`;
  return overall;
}

// Data panel dari ringkasan sync (pure, mudah dites).
// sheetCounts = jumlah baris per label di kolom Sumber_Region (X) Nationwide SETELAH ditulis. Itu sumber angka panel;
// kalau tidak tersedia (gagal dibaca), dipakai hitungan sync. Selisih antara sheet dan sumber ditandai "Tidak sinkron".
export function buildPanel(summary, { finishedAt = new Date(), sheetCounts = null } = {}) {
  const items = summary.items.map((i) => {
    if (!sheetCounts || i.status === "error") return { ...i, rows: i.count };
    const rows = sheetCounts[i.region] ?? 0;
    return { ...i, rows, status: rows !== i.count ? "mismatch" : i.status, expected: i.count };
  });
  // Total = seluruh baris berlabel di Sumber_Region (termasuk baris Jabo yang belum terpetakan)
  const total = sheetCounts ? Object.values(sheetCounts).reduce((a, b) => a + b, 0) : summary.total;

  // Subtotal (mis. Total Jabo): jumlah label pecahan + label sumber asli di Sumber_Region
  const groups = (summary.groups ?? []).map((g) => {
    if (!sheetCounts || g.status === "error") return { ...g, rows: g.count };
    const rows = g.labels.reduce((a, l) => a + (sheetCounts[l] ?? 0), 0);
    return { ...g, rows, status: rows !== g.count ? "mismatch" : g.status, expected: g.count };
  });

  const hasError = items.some((i) => i.status === "error");
  const unmapped = summary.unmapped ?? 0;
  const hasAnomaly = unmapped > 0 || [...items, ...groups].some((i) => i.status === "anomaly" || i.status === "mismatch");
  const overallKey = hasError ? "error" : hasAnomaly ? "anomaly" : "ok";
  const overall = hasError ? "❌ ADA ERROR" : hasAnomaly ? "⚠️ PERLU DICEK" : "✅ All STABLE";

  const regions = {};
  for (const i of items) {
    let change = i.change;
    // Region tidak terambil / tidak sinkron: kolom Change diganti keterangannya
    if (i.status === "error") change = `Tidak terambil: ${String(i.error ?? "gagal").slice(0, 70)}`;
    else if (i.status === "mismatch") change = `Sheet ${fmt(i.rows)} ≠ sumber ${fmt(i.expected)}`;
    regions[i.name] = {
      rows: i.rows === null ? "—" : i.rows,
      pct: i.rows === null || total <= 0 ? "" : i.rows / total,
      change,
      status: REGION_STATUS[i.status],
      ...COLORS[i.status],
    };
  }
  for (const g of groups) {
    let change = g.change;
    if (g.status === "error") change = `Tidak terambil: ${String(g.error ?? "gagal").slice(0, 70)}`;
    else if (g.status === "mismatch") change = `Sheet ${fmt(g.rows)} ≠ sumber ${fmt(g.expected)}`;
    regions[g.name] = {
      rows: g.rows === null ? "—" : g.rows,
      pct: g.rows === null || total <= 0 ? "" : g.rows / total,
      change,
      status: REGION_STATUS[g.status],
      ...COLORS[g.status],
    };
  }
  const failedNames = items.filter((i) => i.status === "error").map((i) => i.name);
  return {
    // Kartu status menyebut region yang tidak terambil; kalau semua sukses dan stabil: "✅ All STABLE"
    status: { text: statusText(overall, failedNames, unmapped), fg: COLORS[overallKey].fg },
    total,
    updated: toSheetSerial(finishedAt),
    regions,
    totalRow: { rows: total, pct: 1, change: summary.totalChange, status: overall, ...COLORS[overallKey] },
  };
}

const value = (v) => (typeof v === "number" ? { userEnteredValue: { numberValue: v } }
  : v === "" || v == null ? {} : { userEnteredValue: { stringValue: String(v) } });

// Satu request updateCells untuk satu sel; warna hanya diubah kalau diberikan.
function cellRequest(sheetId, row, colLetter, v, { fg, bg } = {}) {
  const fields = ["userEnteredValue"];
  const cell = value(v);
  if (fg || bg) {
    cell.userEnteredFormat = {};
    if (fg) { cell.userEnteredFormat.textFormat = { foregroundColor: rgb(fg) }; fields.push("userEnteredFormat.textFormat.foregroundColor"); }
    if (bg) { cell.userEnteredFormat.backgroundColor = rgb(bg); fields.push("userEnteredFormat.backgroundColor"); }
  }
  return {
    updateCells: {
      start: { sheetId, rowIndex: row - 1, columnIndex: colIdx(colLetter) },
      rows: [{ values: [cell] }],
      fields: fields.join(","),
    },
  };
}

async function sheetIdOfPanel(api) {
  const res = await api.spreadsheets.get({ spreadsheetId: DEST.spreadsheetId, fields: "sheets.properties(sheetId,title)" }, longOpts);
  const s = res.data.sheets.find((x) => x.properties.title === PANEL.tab);
  if (!s) throw Object.assign(new Error(`Tab '${PANEL.tab}' tidak ditemukan`), { status: 404 });
  return s.properties.sheetId;
}

// Hanya status sistem (B9): "Sedang Diproses..." saat mulai, atau "Error" kalau gagal. Tidak pernah throw.
export async function setPanelStatus(api, text, fg) {
  try {
    const sheetId = await retryLong(() => sheetIdOfPanel(api), "Cari tab Control Panel");
    await retryLong(() => api.spreadsheets.batchUpdate({
      spreadsheetId: DEST.spreadsheetId,
      requestBody: { requests: [cellRequest(sheetId, PANEL.status.row, PANEL.status.col, text, { fg })] },
    }, longOpts), "Set status Control Panel");
    return { ok: true };
  } catch (e) {
    console.warn(`⚠️ Gagal set status Control Panel: ${e.message}`);
    return { ok: false, error: describeError(e) };
  }
}
export const setPanelBusy = (api) => setPanelStatus(api, "🔄 Sedang Diproses...", COLORS.busy.fg);
export const setPanelError = (api) => setPanelStatus(api, "❌ Error — cek LOG", COLORS.error.fg);

// Isi kartu status dan tabel region. Region dicari berdasarkan NAMA di kolom B (anti geser baris).
// Nama yang tidak ketemu (mis. "Jabo Recycle Pipeline" yang bukan lagi sumber) tidak disentuh. Tidak pernah throw.
export async function updateControlPanel(api, panel) {
  const { spreadsheetId } = DEST;
  try {
    const sheetId = await retryLong(() => sheetIdOfPanel(api), "Cari tab Control Panel");
    const res = await retryLong(() => api.spreadsheets.values.get({
      spreadsheetId,
      range: `'${PANEL.tab}'!${PANEL.nameCol}${PANEL.scanFrom}:${PANEL.nameCol}${PANEL.scanTo}`,
    }, longOpts), "Baca nama region Control Panel");
    const rowOf = {};
    (res.data.values ?? []).forEach((r, i) => {
      const name = String(r[0] ?? "").trim();
      if (name) rowOf[name] = PANEL.scanFrom + i;
    });

    const requests = [
      cellRequest(sheetId, PANEL.status.row, PANEL.status.col, panel.status.text, { fg: panel.status.fg }),
      cellRequest(sheetId, PANEL.total.row, PANEL.total.col, panel.total),
      cellRequest(sheetId, PANEL.updated.row, PANEL.updated.col, panel.updated),
    ];
    const missing = [];
    const addRow = (name, d) => {
      const r = rowOf[name];
      if (!r) { missing.push(name); return; }
      requests.push(
        cellRequest(sheetId, r, PANEL.cols.rows, d.rows),
        cellRequest(sheetId, r, PANEL.cols.pct, d.pct),
        cellRequest(sheetId, r, PANEL.cols.change, d.change),
        cellRequest(sheetId, r, PANEL.cols.status, d.status, { fg: d.fg, bg: d.bg }),
      );
    };
    for (const [name, d] of Object.entries(panel.regions)) addRow(name, d);
    addRow(PANEL.totalName, panel.totalRow);
    if (missing.length) console.warn(`⚠️ Tidak ketemu di Control Panel: ${missing.join(", ")}`);

    await retryLong(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, longOpts), "Isi Control Panel");
    return { ok: true, missing };
  } catch (e) {
    console.warn(`⚠️ Gagal mengisi Control Panel: ${e.message}`);
    return { ok: false, error: describeError(e) };
  }
}
