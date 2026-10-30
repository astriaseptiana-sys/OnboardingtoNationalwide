# OnboardingtoNationalwide

Mengambil data tab **Success** (kolom **A:O**, mulai **row 2**) dari 6 spreadsheet Account Creation (BPOM), menggabungkannya, lalu menempelkannya ke tab **Nationwide** di BPO Tracker mulai **row 2**. Kolom **X** diisi nama region sumber setiap baris. Jalan otomatis **3x sehari** lewat GitHub Actions dan mengirim laporan ke SeaTalk.

## Jadwal

| WIB | UTC (cron) |
|---|---|
| 09:00 | `0 2 * * *` |
| 12:00 | `0 5 * * *` |
| 03:00 (dini hari) | `0 20 * * *` |

> GitHub Actions tidak menjamin tepat waktu. Saat beban GitHub tinggi, eksekusi bisa mundur beberapa menit sampai puluhan menit.
> Bisa dijalankan manual: tab **Actions** → **Sync Success ke Nationwide** → **Run workflow** (ada opsi *dry run* yang hanya membaca dan tidak menulis).

## Sumber dan label kolom X

| Sumber | Isi kolom X |
|---|---|
| Jabodetabek & Banten | `Region Jabodetabek & Banten` |
| Sumatera | `Region Sumatera` |
| Jatim-Balnus | `Region Jatim Bal-Nus` |
| Kalsumal | `Region Kalsumal` |
| Jateng | `Region Jateng` |
| Jabar | `Region Jabar` |

Daftar ID sheet ada di [`src/config.js`](src/config.js).

## Perilaku

- **Refresh penuh tiap jadwal:** data lama di Nationwide (A:O dan X) diganti dengan data terbaru dari sumber. Data baru ditulis dulu, baru sisa baris lama dibersihkan, jadi Nationwide tidak sempat kosong.
- **Hanya A:O dan X yang ditulis.** Kolom P:W (rumus `ARRAYFORMULA`) dan header row 1 tidak disentuh.
- **Nilai persis seperti sumber:** teks tetap teks (mis. `id_ktp` 16 digit tidak berubah jadi angka), tanggal tetap tanggal. Format kolom A, K, M, N disamakan dengan format yang sudah ada di Nationwide.
- **Tab `Sort by New` ikut dijaga:** barisnya ditambah supaya selalu ≥ jumlah data + 1000, agar formula spill tidak `#REF!` (menggantikan `pastikanBarisCukup` di Apps Script).
- **Jangan jalankan bersamaan dengan script Apps Script lama** yang juga menulis A:O di tab Nationwide. Matikan trigger `refresh` di Apps Script kalau repo ini dipakai sebagai penggantinya.
- **Satu sumber gagal:** sumber itu dicoba 3x, kalau tetap gagal dilewati dan sumber lain tetap ditulis. Data region yang gagal **tidak ikut** di Nationwide pada run itu, dan SeaTalk memberi tahu.
- **Semua sumber gagal / kosong:** Nationwide tidak ditimpa sama sekali, workflow ditandai gagal, SeaTalk memberi tahu.
- **Laporan SeaTalk tiap run:** status, total baris, perubahan dibanding run sebelumnya (dibaca dari kolom X), rincian per region, dan penanda ⚠️ kalau satu region turun ≥ 30%.
- **Tab `LOG` di BPO Tracker:** tiap sync (bukan dry run) menyisipkan satu baris di paling atas dengan format yang sama seperti log Apps Script lama: `Waktu | Window | Status | Baris | Keterangan`. Status: `✅ SUKSES`, `⚠️ SEBAGIAN` (ada region gagal, nama dan alasannya di Keterangan), atau `❌ GAGAL` (alasan di Keterangan). Kalau mencatat log gagal, sync tidak ikut gagal.
- **Jabodetabek dipecah per hub:** baris dari sheet Jabodetabek & Banten diberi label di `Sumber_Region` berdasarkan `nama_hub` yang dicocokkan ke tab `Region` (kolom A = Station Name, B = For Nationwide): `Region West Jabo`, `Region South Jabo`, `Region East Jabo`, `Region North Jabo`. Hub yang belum ada di tab `Region` tetap berlabel `Region Jabodetabek & Banten` dan dilaporkan sebagai "belum terpetakan". Kalau peta gagal dibaca, sync tetap jalan dengan label lama dan ada peringatan. **Total Jabo** (subtotal seluruh baris Jabodetabek, termasuk yang belum terpetakan) ikut ditampilkan di Control Panel (baris tepat di atas West Jabo) dan di laporan SeaTalk, dengan perubahan dibandingkan jumlah Jabodetabek di run sebelumnya.
- **Tab `Control Panel`:** diisi seperti script Apps Script lama. B9 menunjukkan `🔄 Sedang Diproses...` saat sync berjalan, lalu status akhir (`✅ All STABLE`, `⚠️ PERLU DICEK`, `❌ ADA ERROR`) atau `❌ Error — cek LOG` kalau gagal total. D9 = total baris, F9 = waktu update. Tabel region (C:F, dicari berdasarkan nama di kolom B) berisi Rows, % of Total, Change, dan Status berwarna. Nama yang tidak ada di sumber (mis. "Jabo Recycle Pipeline"), kolom G (sparkline), dan tabel B26:E33 tidak disentuh. Kalau gagal mengisi panel atau LOG, sync tidak ikut gagal. Penulisan kecil ini (Control Panel + LOG, dikerjakan bersamaan) dicoba sampai 5 kali dengan jeda 5-60 detik karena Google sering masih sibuk menghitung ulang rumus tepat setelah penulisan data, tetapi dibatasi **90 detik total** supaya run tidak molor. Kalau belum selesai atau tetap gagal, peringatan beserta alasannya ikut masuk ke pesan SeaTalk.
- **Urutan setelah data utama tertulis:** (1) sisa baris lama di bawah data dibersihkan (wajib), (2) format tanggal **hanya untuk baris baru** (di bawah baris terakhir run sebelumnya; tidak wajib, gagal = peringatan saja karena format baris lama tetap melekat), (3) pemeriksaan ringan baris terakhir (3 sel), Control Panel, dan LOG dikerjakan bersamaan dengan batas total 90 detik. Pekerjaan tambahan yang melewati batas waktu **dibatalkan**, tidak lanjut di latar belakang.
- **Pengaturan opsional (variabel lingkungan di workflow):** `SKIP_PANEL=true` mematikan semua penulisan ke Control Panel; `FULL_READBACK=true` membaca ulang seluruh kolom `Sumber_Region` setelah menulis (verifikasi penuh per region, berat; bawaannya pemeriksaan ringan saja).
- **Batas 10 juta sel Google Sheets:** kalau memperbesar Nationwide akan melewati batas, proses berhenti sebelum menulis dan SeaTalk memberi tahu.

## Setup (sekali saja)

1. **Buat service account** di Google Cloud (aktifkan *Google Sheets API*), lalu buat key JSON.
2. **Bagikan** ke email service account itu: 6 sheet sumber (cukup *Viewer*) dan BPO Tracker (*Editor*).
3. Di repo ini: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Isi |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` (atau `ONBOARDING_TO_NATIONALWIDE`, keduanya dibaca) | isi lengkap file key JSON |
| `SEATALK_WEBHOOK_URL` | URL webhook grup SeaTalk |

Alternatif tanpa service account: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (OAuth atas nama satu akun pengguna).

4. Jalankan workflow manual dengan **dry run** untuk memastikan semua sumber terbaca, lalu jalankan tanpa dry run.

## Pengembangan lokal

```bash
npm ci
npm test                 # unit test (Sheets API dipalsukan)
npm run dry-run          # baca saja, butuh env kredensial Google
```

Struktur: `src/config.js` (sumber dan konstanta), `src/sheets.js` (baca/tulis + retry), `src/transform.js` (gabung data dan laporan), `src/seatalk.js`, `src/sync.js` (alur utama), `.github/workflows/sync.yml` (jadwal).
