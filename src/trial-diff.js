// Pembanding untuk impor INKREMENTAL tab "Sort by New (Trial)": bandingkan baris sumber dengan isi tab,
// lalu tentukan baris mana yang BARU (belum ada di tab) dan di posisi mana ia harus disisipkan supaya urutan
// terbaru-di-atas tetap benar. Modul ini murni (tanpa jaringan) supaya mudah dites.
import { TRIAL } from "./config.js";

const DATA_COLS = 15; // A:O = data asli dari sumber; P:X dihitung/ditambahkan sehingga tidak ikut dibandingkan
const CREATE = 12;    // kolom M = create_date

// Tanda tangan satu baris = seluruh isi A:O. Karena id_driver (K) dan create_date (M) ikut di dalamnya, akun yang
// BERGABUNG ULANG (orang yang sama dengan id_driver/tanggal baru) otomatis dianggap baris baru dan tetap ditarik.
// Angka dibulatkan ke 14 digit signifikan karena bolak-balik lewat Google Sheets bisa mengubah digit ke-16/17.
// Teks yang isinya bilangan bulat biasa (maks 15 digit, tanpa nol di depan) disamakan dengan angkanya, supaya sel yang
// tipenya berubah di sumber (123456 <-> "123456") tidak dianggap baris baru. id_ktp 16 digit dan nomor ber-nol-depan tetap teks.
const INTEGER_TEXT = /^(0|[1-9]\d{0,14})$/;
const part = (v) => {
  if (typeof v === "number") return `n${Number(v.toPrecision(14))}`;
  const s = String(v ?? "");
  return INTEGER_TEXT.test(s) ? `n${Number(s)}` : `s${s}`;
};
export function signature(row) {
  const p = new Array(DATA_COLS);
  for (let i = 0; i < DATA_COLS; i++) p[i] = part(row[i] ?? "");
  return p.join("\u0001");
}

// Kolom tanggal: nhe_release (A), create_date (M), timestamp_req (N). TIDAK menentukan apakah sebuah baris itu baru.
const DATE_COLUMNS_SKIPPED = new Set([0, 12, 13]);

// Identitas akun = A:O TANPA kolom tanggal, jadi id_driver (K) ikut menentukan:
//   - data sama tetapi id_driver BERBEDA  -> akun lain (mis. bergabung ulang) -> BARU, ditarik
//   - data sama dan id_driver SAMA, walaupun tanggalnya lebih baru -> akun yang sama -> DILEWATI
export function identity(row) {
  const p = [];
  for (let i = 0; i < DATA_COLS; i++) p.push(DATE_COLUMNS_SKIPPED.has(i) ? "" : part(row[i] ?? ""));
  return p.join("");
}

const keyOf = (row) => {
  const m = row[CREATE];
  if (typeof m === "number") return m;
  const n = Number(m);
  return m !== "" && m != null && Number.isFinite(n) ? n : 0;
};

// Indeks pertama di array kunci (menurun) yang nilainya < k  => posisi sisip: setelah semua baris dengan kunci >= k.
function insertIndex(keysDesc, k) {
  let lo = 0, hi = keysDesc.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keysDesc[mid] >= k) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * @param table  seluruh baris sumber yang sudah disusun (24 kolom), urut create_date menurun (TANPA batas jumlah baris)
 * @param target isi tab trial saat ini (minimal kolom A:O), urut create_date menurun
 * @returns rencana: { mode: "none" | "incremental" | "full", reason, additions, groups, stale, ... }
 */
export function planIncremental({ table, target, maxRows, maxGroups = TRIAL.maxGroups, maxAdditions = TRIAL.maxAdditions }) {
  const newestSource = table.length ? keyOf(table[0]) : null;
  if (target.length === 0) return { mode: "full", reason: "tab trial masih kosong", newestSource, newestTarget: null };

  const tkeys = target.map(keyOf);
  const newestTarget = tkeys[0];
  const oldestTarget = tkeys[tkeys.length - 1];

  // Identitas akun yang sudah ada di tab
  const present = new Set();
  for (const r of target) present.add(identity(r));

  // Telusuri baris sumber dalam "jendela" tab (create_date >= yang terlama di tab), dari yang terbaru.
  // Identitas yang sudah ada di tab dilewati (walau tanggalnya lebih baru). Identitas yang belum ada dan LEBIH BARU dari
  // yang terlama di tab = baris baru; kalau identitas yang sama muncul lagi di antara baris baru, hanya yang terbaru
  // diambil. (Baris tepat di batas terlama diabaikan: di sana tab dipotong oleh batas ruang, bukan oleh perubahan data.)
  const additions = [];
  const seen = new Set();
  let inWindow = 0;
  for (const r of table) {
    const k = keyOf(r);
    if (k < oldestTarget) break;
    inWindow++;
    const id = identity(r);
    seen.add(id);
    if (present.has(id)) continue;
    if (k > oldestTarget) { additions.push(r); present.add(id); }
  }
  // Baris di tab yang identitasnya tidak ada lagi di sumber (dihapus/diedit di sumber): dilaporkan, tidak dihapus otomatis
  let stale = 0;
  for (const r of target) if (!seen.has(identity(r))) stale++;

  const base = { newestSource, newestTarget, oldestTarget, inWindow, targetRows: target.length, additions, stale };
  if (additions.length === 0) return { ...base, mode: "none", groups: [], totalAfter: target.length, overflow: Math.max(0, target.length - maxRows) };
  if (additions.length > maxAdditions) return { ...base, mode: "full", reason: `terlalu banyak baris baru (${additions.length} > ${maxAdditions}); tulis ulang penuh lebih efisien`, groups: [] };

  // Kelompokkan baris baru menurut posisi sisip di tab (urutan relatif tetap)
  const byPos = new Map();
  for (const r of additions) {
    const p = insertIndex(tkeys, keyOf(r));
    if (!byPos.has(p)) byPos.set(p, []);
    byPos.get(p).push(r);
  }
  const groups = [...byPos.entries()].map(([p, rows]) => ({ p, rows })).sort((a, b) => b.p - a.p); // dari bawah ke atas
  if (groups.length > maxGroups) return { ...base, mode: "full", reason: `baris baru tersebar di ${groups.length} posisi (> ${maxGroups}); tulis ulang penuh lebih efisien`, groups: [] };

  const totalAfter = target.length + additions.length;
  return { ...base, mode: "incremental", groups, totalAfter, overflow: Math.max(0, totalAfter - maxRows) };
}
