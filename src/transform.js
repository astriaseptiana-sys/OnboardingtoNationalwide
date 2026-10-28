import { ANOMALY_DROP, TZ } from "./config.js";

export const fmtRibuan = (x) => Math.round(x).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fmtPct = (x) => (x * 100).toFixed(1).replace(".", ",");

// "A" -> 0, "O" -> 14, "X" -> 23
export function colIndex(letter) {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function formatWib(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute}`;
}

// Sheets API memotong sel kosong di ujung kanan baris -> samakan lebar jadi `width`.
export function normalizeRow(row, width) {
  const out = new Array(width);
  for (let i = 0; i < width; i++) out[i] = row[i] ?? "";
  return out;
}

export const isBlankRow = (row) => row.every((v) => v === "" || v === null || v === undefined);

export function cleanRows(rawRows, width) {
  const rows = [];
  let dropped = 0;
  for (const raw of rawRows) {
    const row = normalizeRow(raw, width);
    if (isBlankRow(row)) dropped++;
    else rows.push(row);
  }
  return { rows, dropped };
}

// Gabung baris semua sumber yang sukses; kolom X diisi nama region sumbernya.
export function buildOutput(results) {
  const rows = [];
  const regions = [];
  for (const r of results) {
    if (!r.ok) continue;
    for (const row of r.rows) {
      rows.push(row);
      regions.push([r.region]);
    }
  }
  return { rows, regions };
}

// Hitung jumlah baris per label region dari isi kolom X (values.get -> [[label], ...]).
export function tallyRegions(columnValues) {
  const counts = {};
  for (const row of columnValues ?? []) {
    const label = String(row[0] ?? "").trim();
    if (label) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

export function changeText(now, prev) {
  if (!prev) return "baseline";
  const d = now - prev;
  const sg = d >= 0 ? "+" : "-";
  return `${sg}${fmtRibuan(Math.abs(d))} (${sg}${fmtPct(Math.abs(d / prev))}%)`;
}

export function summarize(results, prevCounts) {
  const prevTotal = prevCounts ? Object.values(prevCounts).reduce((a, b) => a + b, 0) : 0;
  const total = results.reduce((a, r) => a + (r.ok ? r.rows.length : 0), 0);

  const items = results.map((r) => {
    const prev = prevCounts?.[r.region] ?? 0;
    let status = "ok";
    if (!r.ok) status = "error";
    else if (prev > 0 && (r.rows.length - prev) / prev <= -ANOMALY_DROP) status = "anomaly";
    return {
      name: r.name,
      region: r.region,
      status,
      count: r.ok ? r.rows.length : null,
      share: r.ok && total > 0 ? r.rows.length / total : null,
      change: r.ok ? changeText(r.rows.length, prev) : "-",
      dropped: r.dropped ?? 0,
      error: r.error ?? null,
    };
  });

  let overall = "✅ SUKSES";
  if (items.some((i) => i.status === "error")) overall = "⚠️ SEBAGIAN GAGAL";
  else if (items.some((i) => i.status === "anomaly")) overall = "⚠️ PERLU DICEK";

  return { items, total, prevTotal, totalChange: changeText(total, prevTotal), overall };
}

const ICON = { ok: "🟢", anomaly: "🟡", error: "🔴" };

export function buildReport(summary, { finishedAt = new Date(), durationSec, sheetUrl, dryRun = false } = {}) {
  let t = `📊 Sync Nationwide BPO Tracker (Success 6 Region)${dryRun ? " — DRY RUN (tidak menulis)" : ""}\n`;
  t += `Status: ${summary.overall}\n`;
  t += `Total baris: ${fmtRibuan(summary.total)} (${summary.totalChange})\n`;
  t += `Update: ${formatWib(finishedAt)} WIB`;
  if (durationSec != null) t += `  |  Durasi: ${durationSec} dtk`;
  t += "\n----------------------------------------\n";
  t += "Breakdown per Region:\n\n";

  for (const i of summary.items) {
    t += `${ICON[i.status]} ${i.name}\n`;
    if (i.status === "error") {
      t += `     GAGAL diambil — dilewati, data region ini TIDAK ikut di Nationwide\n`;
      t += `     ${String(i.error ?? "").slice(0, 200)}\n\n`;
    } else {
      const share = i.share === null ? "—" : `${fmtPct(i.share)}%`;
      t += `     ${fmtRibuan(i.count)} baris  |  ${share} dari total  |  ${i.change}\n`;
      if (i.status === "anomaly") t += `     ⚠️ Turun >= ${ANOMALY_DROP * 100}% dari run sebelumnya\n`;
      t += "\n";
    }
  }

  t += "----------------------------------------\n";
  t += `TOTAL: ${fmtRibuan(summary.total)} baris  |  ${summary.totalChange}\n`;
  if (sheetUrl) t += `\nSheet: ${sheetUrl}`;
  return t;
}

export function buildFailureReport(err, { finishedAt = new Date(), runUrl } = {}) {
  let t = "❌ Sync Nationwide BPO Tracker GAGAL\n\n";
  t += `Error: ${String(err?.message ?? err).slice(0, 500)}\n`;
  t += `Jam: ${formatWib(finishedAt)} WIB\n`;
  t += "Nationwide tidak diubah kalau gagal sebelum tahap tulis.";
  if (runUrl) t += `\nLog: ${runUrl}`;
  return t;
}
