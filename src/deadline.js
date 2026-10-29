// Balapan antara pekerjaan dan batas waktu. Yang kalah tidak menahan proses (timer dibersihkan).
// Hasil saat batas waktu lewat: { ok: false, error } — pekerjaan aslinya dibiarkan berjalan di latar belakang
// dan dihentikan saat proses keluar.
export function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `belum selesai dalam ${ms / 1000} dtk` }), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Jalankan pekerjaan tambahan (bukan penulisan data utama) dengan batas waktu dan TANPA PERNAH throw.
// Hasil: { ok: true, value } atau { ok: false, error }. Error/bug di pekerjaan tambahan tidak boleh sampai
// menggagalkan atau mengulang sync data.
export function bounded(fn, ms) {
  const work = Promise.resolve()
    .then(fn)
    .then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) }));
  return withDeadline(work, ms);
}
