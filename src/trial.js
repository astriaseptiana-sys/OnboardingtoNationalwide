// Percobaan "Sort by New (Trial)": data diurutkan di kode (terbaru di atas) dan ditulis langsung sebagai NILAI,
// tanpa rumus. Kolom P:W menirukan rumus di tab Nationwide supaya hasilnya sama persis:
//   Q timestamp_req (Revise), R timestamp_req (Final), S SLA, T SLA (Final)  -> hitungan di bawah
//   U Region, V Province, W City                                              -> XLOOKUP nama_hub ke tab Region
// Modul ini murni (tanpa akses jaringan) supaya mudah dites.

// ROUND di Google Sheets: angka lebih dulu dibulatkan ke 15 digit signifikan, lalu setengah dibulatkan menjauhi nol.
// (Tanpa langkah pertama, nilai seperti 3997276316.4999995 dibulatkan turun di JavaScript tetapi naik di Sheets.)
const round = (x) => Math.sign(x) * Math.round(Math.abs(Number(x.toPrecision(15))));
export const sheetsRound = round; // diekspor untuk tes
const frac = (n) => n - Math.floor(n);
const time = (h, m) => (h * 3600 + m * 60) / 86400; // TIME(h, m, 0)

const T_09 = time(9, 0);
const T_11 = time(11, 0);
const T_1230 = time(12, 30);
const T_16 = time(16, 0);
const T_15MIN = time(0, 15);

const isNum = (v) => typeof v === "number";

// Indeks kolom di baris data A:O
const COL = { nhe: 0, hub: 9, create: 12, req: 13 };

// Permintaan yang masuk 09:00-11:00 digeser ke 11:00, yang 12:30-16:00 ke 16:00 (jam gelombang pembuatan akun).
function baseTime(n) {
  const f = frac(n);
  if (f >= T_09 && f < T_11) return Math.floor(n) + T_11;
  if (f >= T_1230 && f < T_16) return Math.floor(n) + T_16;
  return n;
}

// Peta nama hub (huruf kecil, tanpa trim, seperti XLOOKUP) -> [Region, Province, City]; kecocokan PERTAMA yang dipakai.
export function buildRegionLookup(regionRows) {
  const map = new Map();
  for (const r of regionRows) {
    const key = String(r[0] ?? "").toLowerCase();
    if (key === "" || map.has(key)) continue;
    map.set(key, [r[1] ?? "", r[2] ?? "", r[3] ?? ""]);
  }
  return map;
}

// Hitung kolom P:W untuk setiap baris data (A:O). Mengembalikan array baris [P, Q, R, S, T, U, V, W].
export function computeDerived(rows, lookup) {
  // Tahap 1 (rumus Q): kumpulan detik pembuatan dari baris "bad" — dipakai seluruh baris sebagai kunci pencocokan.
  const info = rows.map((r) => {
    const m = r[COL.create];
    const n = r[COL.req];
    if (!isNum(m) || !isNum(n)) return null;
    const base = baseTime(n);
    const s = round((m - n) * 86400);
    const keep = s >= 900 && s < 7200;
    const ds = round((m - base) * 86400);
    const bad = !keep && (ds < 900 || ds > 6600);
    return { m, n, base, keep, bad, sec: round(m * 86400) };
  });
  const badSeconds = new Set();
  for (const x of info) if (x && x.bad) badSeconds.add(x.sec);

  return rows.map((r, i) => {
    const x = info[i];
    const a = r[COL.nhe];
    const m = r[COL.create];
    const n = r[COL.req];

    // Q timestamp_req (Revise)
    let q = "";
    if (x) {
      if (x.keep) q = x.base !== x.n ? x.n : "";
      else if (badSeconds.has(x.sec)) q = x.m - (T_15MIN + (x.sec % 96) / 1440);
    }

    // R timestamp_req (Final)
    let rr = "";
    if (a !== "" && a !== undefined) rr = q !== "" ? q : (isNum(n) ? baseTime(n) : n);

    // S SLA dan T SLA (Final): sel kosong dihitung 0 seperti di Sheets
    const num = (v) => (isNum(v) ? v : 0);
    const s = num(m) - num(n);
    const t = num(m) - num(rr);

    // U:W XLOOKUP nama_hub ke tab Region (tidak ketemu = #N/A)
    const hit = lookup.get(String(r[COL.hub] ?? "").toLowerCase());
    const [region, province, city] = hit ?? ["#N/A", "#N/A", "#N/A"];

    return ["", q, rr, s, t, region, province, city];
  });
}

// Nilai kunci urut seperti rumus Sort by New: angka apa adanya, teks angka dikonversi, selain itu 0.
const sortKey = (m) => (isNum(m) ? m : (Number.isFinite(Number(m)) && m !== "" ? Number(m) : 0));

// Susun tabel trial: A:O + P:W (dihitung) + X (Sumber_Region), hanya baris dengan create_date terisi,
// diurutkan create_date menurun (terbaru dulu, urutan sama dipertahankan), dibatasi `maxRows` baris terbaru.
export function buildTrialTable(rows, labels, lookup, { maxRows = Infinity } = {}) {
  const derived = computeDerived(rows, lookup);
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i][COL.create];
    if (m === "" || m === undefined || m === null) continue; // sama dengan FILTER(... M<>"")
    items.push({ key: sortKey(m), row: [...rows[i], ...derived[i], labels[i]] });
  }
  items.sort((a, b) => b.key - a.key); // stabil: urutan asal dipertahankan untuk tanggal yang sama
  const total = items.length;
  const kept = Number.isFinite(maxRows) ? items.slice(0, maxRows) : items;
  return { rows: kept.map((x) => x.row), total, cut: total - kept.length };
}

export const TRIAL_HEADER = [
  "nhe_release", "nama_kurir", "id_ktp", "email_kurir", "nama_vendor", "kategori", "posisi_yang_dilamar", "nomor_hp",
  "driver_group", "nama_hub", "id_driver", "source", "create_date", "timestamp_req", "pic", "mobile_hub",
  "timestamp_req (Revise)", "timestamp_req (Final)", "SLA", "SLA (Final)", "Region", "Province", "City", "Sumber_Region",
];
