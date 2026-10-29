import { ANOMALY_DROP, REGION_SPLIT, TZ } from "./config.js";

const totalName = REGION_SPLIT.totalName;

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

// Gabung baris semua sumber yang sukses; kolom X diisi nama region sumbernya
// (atau label hasil pecahan per hub kalau sumbernya dipecah, mis. Jabodetabek -> West/South/East/North Jabo).
export function buildOutput(results) {
  const rows = [];
  const regions = [];
  for (const r of results) {
    if (!r.ok) continue;
    for (let i = 0; i < r.rows.length; i++) {
      rows.push(r.rows[i]);
      regions.push([r.rowLabels ? r.rowLabels[i] : r.region]);
    }
  }
  return { rows, regions };
}

const normHub = (s) => String(s ?? "").trim().toLowerCase();

// Pecah satu sumber menjadi beberapa label berdasarkan nama hub (kolom J) -> region di tab Region.
// Hub yang tidak ada di peta tetap memakai label sumber aslinya dan dihitung sebagai `unmapped`.
export function splitResult(result, hubMap, split) {
  const labels = split.regions.map((n) => ({ name: n, region: `Region ${n}`, count: 0 }));
  if (!result.ok) return { ...result, split: { labels, unmapped: 0 } };
  const byName = Object.fromEntries(labels.map((l) => [l.name, l]));
  let unmapped = 0;
  const rowLabels = result.rows.map((row) => {
    const reg = hubMap?.get(normHub(row[split.hubIndex]));
    if (reg && byName[reg]) {
      byName[reg].count++;
      return byName[reg].region;
    }
    unmapped++;
    return result.region;
  });
  return { ...result, rowLabels, split: { labels, unmapped } };
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

  // Sumber yang dipecah (r.split) menghasilkan satu item per label; yang lain satu item per sumber.
  const entries = results.flatMap((r) => (r.split
    ? r.split.labels.map((l, idx) => ({ name: l.name, region: l.region, ok: r.ok, count: r.ok ? l.count : null, dropped: idx === 0 ? r.dropped : 0, error: r.error }))
    : [{ name: r.name, region: r.region, ok: r.ok, count: r.ok ? r.rows.length : null, dropped: r.dropped, error: r.error }]));

  const items = entries.map((e) => {
    const prev = prevCounts?.[e.region] ?? 0;
    let status = "ok";
    if (!e.ok) status = "error";
    else if (prev > 0 && (e.count - prev) / prev <= -ANOMALY_DROP) status = "anomaly";
    return {
      name: e.name,
      region: e.region,
      status,
      count: e.count,
      share: e.ok && total > 0 ? e.count / total : null,
      change: e.ok ? changeText(e.count, prev) : "-",
      dropped: e.dropped ?? 0,
      error: e.error ?? null,
    };
  });
  const unmapped = results.reduce((a, r) => a + (r.split?.unmapped ?? 0), 0);

  // Subtotal untuk sumber yang dipecah (mis. Total Jabo): seluruh baris sumber itu, termasuk yang belum terpetakan.
  // Pembandingnya = jumlah label pecahan + label sumber asli di run sebelumnya, jadi run pertama setelah pemecahan
  // dibandingkan dengan angka Jabodetabek gabungan, bukan "baseline".
  const groups = results.filter((r) => r.split).map((r) => {
    const labels = [...r.split.labels.map((l) => l.region), r.region];
    const prev = labels.reduce((a, l) => a + (prevCounts?.[l] ?? 0), 0);
    const count = r.ok ? r.rows.length : null;
    let status = "ok";
    if (!r.ok) status = "error";
    else if ((prev > 0 && (count - prev) / prev <= -ANOMALY_DROP) || r.split.unmapped > 0) status = "anomaly";
    return {
      name: totalName,
      source: r.name,
      labels,
      afterRegion: r.split.labels[r.split.labels.length - 1].region,
      status,
      count,
      share: r.ok && total > 0 ? count / total : null,
      change: r.ok ? changeText(count, prev) : "-",
      error: r.error ?? null,
    };
  });

  let overall = "✅ SUKSES";
  if (items.some((i) => i.status === "error")) overall = "⚠️ SEBAGIAN GAGAL";
  else if (unmapped > 0 || items.some((i) => i.status === "anomaly")) overall = "⚠️ PERLU DICEK";

  return { items, groups, total, prevTotal, totalChange: changeText(total, prevTotal), overall, unmapped };
}

const ICON = { ok: "🟢", anomaly: "🟡", error: "🔴" };

const rerunLine = (rerunUrl) =>
  `\n\n🔁 Silakan run ulang di sini: ${rerunUrl}\n   (klik "Run workflow", biarkan "Dry run" tidak dicentang, lalu klik tombol hijau "Run workflow")`;

export function buildReport(summary, { finishedAt = new Date(), durationSec, sheetUrl, dryRun = false, rerunUrl, warnings = [] } = {}) {
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
    // Subtotal (mis. Total Jabo) tepat setelah baris pecahan terakhirnya
    for (const g of (summary.groups ?? []).filter((x) => x.afterRegion === i.region)) {
      t += `${ICON[g.status]} ${g.name}\n`;
      if (g.status === "error") {
        t += `     GAGAL diambil — seluruh ${g.source} tidak ikut di Nationwide\n\n`;
      } else {
        const share = g.share === null ? "—" : `${fmtPct(g.share)}%`;
        t += `     ${fmtRibuan(g.count)} baris  |  ${share} dari total  |  ${g.change}\n\n`;
      }
    }
  }

  t += "----------------------------------------\n";
  t += `TOTAL: ${fmtRibuan(summary.total)} baris  |  ${summary.totalChange}\n`;
  if (summary.unmapped > 0) {
    t += `⚠️ ${fmtRibuan(summary.unmapped)} baris Jabo dengan hub yang belum ada di tab Region (tetap berlabel region sumbernya)\n`;
  }
  for (const w of warnings) t += `⚠️ ${w}\n`;
  if (sheetUrl) t += `\nSheet: ${sheetUrl}`;
  if (rerunUrl && summary.items.some((i) => i.status === "error")) t += rerunLine(rerunUrl);
  return t;
}

export function buildFailureReport(err, { finishedAt = new Date(), runUrl, attempts, rerunUrl, warnings = [] } = {}) {
  let t = "❌ Sync Nationwide BPO Tracker GAGAL\n\n";
  t += `Error: ${String(err?.message ?? err).slice(0, 500)}\n`;
  if (attempts > 1) t += `Sudah dicoba ${attempts}x.\n`;
  t += `Jam: ${formatWib(finishedAt)} WIB\n`;
  const upTo = err?.writtenUntilRow;
  if (upTo > 1) {
    t += `⚠️ Nationwide SEBAGIAN terupdate: baris 2-${fmtRibuan(upTo)} sudah data baru, sisanya masih data lama. ` +
      "Total per region sementara tidak akurat sampai sync berikutnya sukses.";
  } else if (upTo === 1) {
    t += "Nationwide belum diubah (gagal di potongan tulis pertama).";
  } else {
    t += "Nationwide tidak diubah kalau gagal sebelum tahap tulis.";
  }
  for (const w of warnings) t += `\n⚠️ ${w}`;
  if (runUrl) t += `\nLog: ${runUrl}`;
  if (rerunUrl) t += rerunLine(rerunUrl);
  return t;
}
