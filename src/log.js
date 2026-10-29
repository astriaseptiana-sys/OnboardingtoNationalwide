// Baris untuk tab LOG di BPO Tracker, format sama dengan log Apps Script lama:
// Waktu | Window | Status | Baris | Keterangan   (terbaru di atas)
const WIB_OFFSET_MS = 7 * 3600 * 1000; // WIB = UTC+7, tanpa DST
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const NOTE_MAX = 500;

// Angka seri tanggal-jam Google Sheets untuk jam dinding WIB.
export function toSheetSerial(date = new Date()) {
  return (date.getTime() + WIB_OFFSET_MS - SHEETS_EPOCH_MS) / 86400000;
}

// Aturan yang sama dengan script lama: Siang 11:00-12:30, Malam 16:00-13:00, selain itu "Luar window".
export function windowLabel(date = new Date()) {
  const local = new Date(date.getTime() + WIB_OFFSET_MS);
  const jam = local.getUTCHours() + local.getUTCMinutes() / 60;
  if (jam >= 11 && jam < 12.5) return "Siang";
  if (jam >= 16 || jam < 13) return "Malam";
  return "Luar window";
}

const cap = (s) => String(s ?? "").slice(0, NOTE_MAX);

export function buildLogRow({ date = new Date(), status, rows = 0, note = "" }) {
  return [toSheetSerial(date), windowLabel(date), status, rows, cap(note)];
}

// Sync selesai menulis. Ada region gagal -> "SEBAGIAN" (data region itu tidak ikut), selain itu "SUKSES".
export function successEntry(summary, rowCount, { attempt = 1, date } = {}) {
  const failed = summary.items.filter((i) => i.status === "error");
  const dropped = summary.items.filter((i) => i.status === "anomaly");
  const notes = [];
  if (failed.length) notes.push(`Region gagal diambil: ${failed.map((i) => `${i.name} (${String(i.error ?? "").slice(0, 80)})`).join(", ")}`);
  if (dropped.length) notes.push(`Turun >= 30%: ${dropped.map((i) => i.name).join(", ")}`);
  if (summary.unmapped > 0) notes.push(`${summary.unmapped} baris Jabo belum terpetakan ke West/South/East/North`);
  if (attempt > 1) notes.push(`berhasil di percobaan ke-${attempt}`);
  return buildLogRow({ date, status: failed.length ? "⚠️ SEBAGIAN" : "✅ SUKSES", rows: rowCount, note: notes.join("; ") });
}

export function failureEntry(err, { attempts = 1, date } = {}) {
  let note = String(err?.message ?? err);
  if (err?.writtenUntilRow > 1) note += ` | Nationwide sebagian terupdate sampai baris ${err.writtenUntilRow}`;
  if (attempts > 1) note += ` | sudah dicoba ${attempts}x`;
  return buildLogRow({ date, status: "❌ GAGAL", rows: 0, note });
}
