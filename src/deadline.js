// Balapan antara pekerjaan dan batas waktu. Yang kalah tidak menahan proses (timer dibersihkan).
// Hasil saat batas waktu lewat: { ok: false, error }.
export function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `belum selesai dalam ${ms / 1000} dtk` }), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Jalankan pekerjaan tambahan (BUKAN penulisan data utama) dengan batas waktu dan TANPA PERNAH throw.
// Hasil: { ok: true, value } atau { ok: false, error }. Error/bug di pekerjaan tambahan tidak boleh sampai
// menggagalkan atau mengulang sync data.
//
// `fn` menerima AbortSignal. Saat batas waktu lewat, signal DIBATALKAN supaya permintaan yang sedang berjalan dan
// retry-nya benar-benar berhenti, tidak lanjut diam-diam di latar belakang dan menambah beban ke Google.
export function bounded(fn, ms) {
  const controller = new AbortController();
  const work = Promise.resolve()
    .then(() => fn(controller.signal))
    .then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e?.message ?? e).slice(0, 160) }));
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: `belum selesai dalam ${ms / 1000} dtk` });
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
