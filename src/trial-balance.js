// Pemeriksaan BALANCE tab "Sort by New (Trial)" terhadap tab Success keenam sumber. Murni (tanpa jaringan).
//
// Yang diperiksa: apakah SETIAP akun (identitas = A:O tanpa kolom tanggal) di sumber sudah ada di tab, dan apakah tab tidak
// memuat akun yang sudah tidak ada di sumber. Dilaporkan juga total baris, cakupan tanggal, dan per sumber/label.
import { TRIAL } from "./config.js";
import { identity, keyOf } from "./trial-diff.js";

const DRIVER = 10; // id_driver (K)

const maxDriver = (rows) => {
  let max = null;
  for (const r of rows) {
    const v = r[DRIVER];
    const n = typeof v === "number" ? v : (/^\d{1,15}$/.test(String(v)) ? Number(v) : null);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
};

/**
 * @param table     seluruh baris sumber (24 kolom), urut create_date menurun, TANPA batas jumlah baris
 * @param tabRows   isi tab (A:O, 15 kolom), urut menurun; tabLabels = isi kolom X untuk baris yang sama
 */
export function buildBalance({ table, tabRows, tabLabels = [], columns = TRIAL.columns }) {
  const srcTotal = table.length;
  const tabTotal = tabRows.length;
  const oldestSrc = srcTotal ? keyOf(table[srcTotal - 1]) : null;
  const oldestTab = tabTotal ? keyOf(tabRows[tabTotal - 1]) : null;
  const newestSrc = srcTotal ? keyOf(table[0]) : null;
  const newestTab = tabTotal ? keyOf(tabRows[0]) : null;

  // Cakupan: PENUH kalau tab memuat sampai baris terlama sumber; kalau tidak, hanya rentang tanggal tertentu.
  const complete = tabTotal > 0 && oldestTab <= oldestSrc;
  // Tab kosong: seluruh sumber dianggap belum masuk. Tab berisi sebagian: yang dibandingkan hanya yang LEBIH BARU dari batas
  // terlama tab (baris tepat di batas bisa terpotong oleh batas ruang, jadi tidak dihitung).
  const scope = complete || tabTotal === 0 ? table : table.filter((r) => keyOf(r) > oldestTab);

  const tabIds = new Set(tabRows.map(identity));
  const scopeIds = new Set();
  for (const r of scope) scopeIds.add(identity(r));
  let missing = 0;
  for (const id of scopeIds) if (!tabIds.has(id)) missing++;

  // Identitas di tab yang tidak ada di sumber (dalam rentang tab); baris tepat di batas terlama ikut dihitung
  const srcIdsInTabRange = new Set();
  for (const r of table) if (tabTotal === 0 || keyOf(r) >= oldestTab) srcIdsInTabRange.add(identity(r));
  let extra = 0;
  for (const r of tabRows) if (!srcIdsInTabRange.has(identity(r))) extra++;

  // Jumlah baris: tab boleh memuat antara "identitas unik" dan "seluruh baris" sumber di cakupan (baris kembar identitas)
  const scopeTotal = scope.length;
  const scopeDistinct = scopeIds.size;
  const tabInScope = complete ? tabTotal : tabRows.filter((r) => keyOf(r) > oldestTab).length;
  const countOk = tabInScope >= scopeDistinct && tabInScope <= scopeTotal;

  // Per label (Sumber_Region)
  const perLabel = {};
  for (const r of scope) { const l = r[23] ?? ""; (perLabel[l] ??= { src: 0, tab: 0 }).src++; }
  const cutoff = complete ? -Infinity : oldestTab;
  tabRows.forEach((r, i) => { if (keyOf(r) > cutoff) { const l = tabLabels[i] ?? ""; (perLabel[l] ??= { src: 0, tab: 0 }).tab++; } });

  let status;
  if (missing > 0 || extra > 0 || !countOk) status = "tidak-balance";
  else status = complete ? "balance-penuh" : "balance-rentang";

  return {
    status, complete, missing, extra, countOk,
    srcTotal, srcDistinct: new Set(table.map(identity)).size, tabTotal,
    scopeTotal, scopeDistinct, tabInScope,
    newestSrc, newestTab, oldestSrc, oldestTab,
    notInTab: complete || tabTotal === 0 ? 0 : table.filter((r) => keyOf(r) < oldestTab).length, // baris sumber lebih lama dari batas tab (tidak muat)
    cellsNeeded: complete ? 0 : (srcTotal - tabTotal) * columns, // perkiraan sel tambahan agar tab memuat semuanya
    maxIdSrc: maxDriver(table), maxIdTab: maxDriver(tabRows),
    perLabel,
  };
}

const num = (n) => Number(n).toLocaleString("id-ID");
const when = (n) => (typeof n === "number" ? new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)).toISOString().slice(0, 16).replace("T", " ") : "-");
const STATUS_TEXT = {
  "balance-penuh": "✅ BALANCE PENUH — seluruh data Success ada di tab, tidak ada yang terlewat",
  "balance-rentang": "🟡 BALANCE DALAM RENTANG — semua data dalam rentang tab lengkap, tetapi data yang lebih lama TIDAK muat di tab",
  "tidak-balance": "❌ TIDAK BALANCE — ada data sumber yang belum masuk, atau isi tab tidak sesuai sumber",
};

export function formatBalance(b) {
  const L = [];
  L.push("BALANCE (tab trial vs tab Success keenam sumber)");
  L.push(`  Total baris — sumber: ${num(b.srcTotal)} (identitas unik ${num(b.srcDistinct)}) | tab: ${num(b.tabTotal)}`);
  L.push(`  Tanggal terbaru — sumber: ${when(b.newestSrc)} | tab: ${when(b.newestTab)}   Tanggal terlama — sumber: ${when(b.oldestSrc)} | tab: ${when(b.oldestTab)}`);
  L.push(`  id_driver terbesar — sumber: ${b.maxIdSrc ?? "-"} | tab: ${b.maxIdTab ?? "-"}`);
  if (b.complete) L.push("  Cakupan: PENUH (tab memuat sampai baris terlama di sumber)");
  else L.push(`  Cakupan: DALAM RENTANG sejak ${when(b.oldestTab)}; ${num(b.notInTab)} baris sumber yang lebih lama TIDAK muat (perkiraan butuh ${num(b.cellsNeeded)} sel lagi)`);
  L.push(`  Akun sumber (dalam cakupan) yang BELUM ada di tab: ${num(b.missing)} | akun di tab yang TIDAK ada di sumber: ${num(b.extra)}`);
  if (b.scopeTotal !== b.scopeDistinct) L.push(`  Catatan: ${num(b.scopeTotal - b.scopeDistinct)} baris sumber punya identitas kembar (data sama dan id_driver sama, tanggal beda); jumlah baris tab boleh berada di antara ${num(b.scopeDistinct)} dan ${num(b.scopeTotal)}`);
  L.push("  Per sumber/label (dalam cakupan):  sumber | tab | selisih");
  for (const [label, c] of Object.entries(b.perLabel).sort()) L.push(`    ${label.padEnd(28)} ${num(c.src).padStart(8)} | ${num(c.tab).padStart(8)} | ${num(c.src - c.tab).padStart(6)}`);
  L.push(`  STATUS: ${STATUS_TEXT[b.status]}`);
  return L.join("\n");
}
