// Urutan SUMBER sama dengan script Nationwide di Apps Script.
// `region` = teks yang ditulis ke kolom X di Nationwide untuk tiap baris dari sumber itu.
export const SOURCES = [
  { name: "Jabodetabek & Banten", region: "Region Jabodetabek & Banten", id: "1A6lYvBHt-p637RGfDgpDxlGB4S3Su-y--vM99HRSDLQ" },
  { name: "Sumatera",             region: "Region Sumatera",             id: "1gH4FNSYfTqn8zn-IQwXL-uKm-ZB8MaIqjsRVwFit2S8" },
  { name: "Jatim-Balnus",         region: "Region Jatim Bal-Nus",        id: "1qCAPBaCQ2CaWh8bL9jh43hxzxZTuUuYuBiO1DHNfNOI" },
  { name: "Kalsumal",             region: "Region Kalsumal",             id: "1nLeSA9Chc8y9FwY1wrsWUCqk6u2FkXcveHvvNykLKFQ" },
  { name: "Jateng",               region: "Region Jateng",               id: "1FP_AnAZjjWtasGVfoOeA7Ch61p2h1eeJRSmBNptyW74" },
  { name: "Jabar",                region: "Region Jabar",                id: "1LFLA2GNuybH68m1AhuUDRxuU0tuVE7qikV7PCN_FBew" },
];

// Sumber yang dipecah per hub: kolom Sumber_Region (X) berisi "Region West Jabo", "Region South Jabo", dst.
// Peta hub -> region dibaca dari tab Region di BPO Tracker (kolom A = Station Name, kolom B = For Nationwide).
export const REGION_SPLIT = {
  source: "Jabodetabek & Banten",
  mapTab: "Region",
  hubIndex: 9, // nama_hub = kolom J di A:O
  regions: ["West Jabo", "South Jabo", "East Jabo", "North Jabo"],
  totalName: "Total Jabo", // baris subtotal (semua baris sumber, termasuk hub yang belum terpetakan)
};

export const SOURCE_TAB = "Success";
export const SOURCE_LAST_COL = "O"; // ambil A:O, mulai row 2
export const SOURCE_WIDTH = 15;     // jumlah kolom A:O

// Tujuan: BPO Tracker, tab Nationwide. Hanya A:O dan X yang ditulis; P:W (rumus ARRAYFORMULA) tidak disentuh.
export const DEST = {
  spreadsheetId: "14066o_4MxeLbfAyIfMDMF6ExRFzSwlN6HemgDAP0y_0",
  tab: "Nationwide",
  dataFirstCol: "A",
  dataLastCol: "O",
  regionCol: "X",
  firstRow: 2,
  // Tab yang membaca Nationwide lewat formula spill: barisnya harus cukup supaya tidak #REF!
  // (sama seperti pastikanBarisCukup di script Apps Script lama).
  companionTabs: [{ tab: "Sort by New", buffer: 1000 }],
};

// Format kolom di A:O, disamakan dengan format yang sudah ada di Nationwide (index 0-based).
export const DATE_COLUMNS = [
  { index: 0,  type: "DATE",      pattern: 'd"-"mmm"-"yyyy' },     // nhe_release
  { index: 10, type: "NUMBER",    pattern: "0" },                  // id_driver
  { index: 12, type: "DATE_TIME", pattern: "M/d/yyyy H:mm:ss" },   // create_date
  { index: 13, type: "DATE_TIME", pattern: "M/d/yyyy H:mm:ss" },   // timestamp_req
];

export const MAX_RETRY = 3;
export const RETRY_DELAY_MS = 3000;

// Penulisan ke Nationwide lambat karena rumus ARRAYFORMULA di P:W dihitung ulang tiap tulis,
// jadi retry-nya lebih sabar dan tiap request diberi batas waktu.
export const WRITE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000]; // 5 percobaan
export const WRITE_TIMEOUT_MS = 180_000;                          // batas waktu per request tulis
export const MAX_ATTEMPTS = 2;                                    // seluruh sync diulang sekali kalau gagal
export const ATTEMPT_PAUSE_MS = 30_000;
export const CHUNK_ROWS = 5000;      // baris per request tulis
export const ROW_BUFFER = 500;       // baris cadangan di bawah data
export const CELL_LIMIT = 10_000_000; // batas sel per spreadsheet Google Sheets
export const LOG_TAB = "LOG"; // riwayat sync, baris terbaru di atas (format sama dengan log Apps Script)
export const NOTIFY_EMAILS = ["astria.septiana@spxexpress.com"]; // di-mention di setiap notifikasi SeaTalk
export const ANOMALY_DROP = 0.30;    // region turun >= 30% dibanding run sebelumnya
export const TZ = "Asia/Jakarta";
