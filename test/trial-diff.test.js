import assert from "node:assert/strict";
import { test } from "node:test";
import { TRIAL } from "../src/config.js";
import { identity, planIncremental, signature } from "../src/trial-diff.js";
import { applyIncremental, readTrialRows, verifyTrialTop } from "../src/trial-write.js";

// baris sumber/tab: 24 kolom, nilai di A:O menentukan identitas; M (index 12) = create_date
const mk = (id, m, extra = {}) => {
  const r = new Array(24).fill("");
  r[0] = `n${id}`; r[2] = `ktp-${id}`; r[10] = extra.driver ?? 123456; r[12] = m; r[13] = extra.req ?? m - 0.01;
  r[16] = extra.q ?? ""; r[23] = "Region X";
  return r;
};
const desc = (rows) => [...rows].sort((a, b) => b[12] - a[12]);
const plan = (table, target, o = {}) => planIncremental({ table: desc(table), target: desc(target), maxRows: 1000, ...o });
const keys = (rows) => rows.map((r) => r[12]);

test("signature: seluruh A:O, angka dan teks dibedakan, digit ke-16/17 tidak berpengaruh", () => {
  assert.equal(signature(mk(1, 46000.123456789012)), signature(mk(1, 46000.123456789016)));
  assert.notEqual(signature(mk(1, 46000)), signature(mk(2, 46000)));
  const a = mk(1, 46000); const b = mk(1, 46000); b[10] = "123456"; // angka vs teks bilangan bulat biasa = sama
  assert.equal(signature(a), signature(b));
  const ktpNum = mk(1, 46000); ktpNum[2] = 3311071702010001; const ktpText = mk(1, 46000); ktpText[2] = "3311071702010001";
  assert.notEqual(signature(ktpNum), signature(ktpText));                  // 16 digit: tetap dibedakan (tidak aman sebagai angka)
  const z1 = mk(1, 46000); z1[7] = "087819442664"; const z2 = mk(1, 46000); z2[7] = 87819442664;
  assert.notEqual(signature(z1), signature(z2));                           // nol di depan: tetap teks
  const c = mk(1, 46000); c[23] = "label lain"; c[16] = 99;       // kolom di luar A:O tidak ikut
  assert.equal(signature(mk(1, 46000)), signature(c));
});

test("tab kosong -> tulis ulang penuh", () => {
  const p = plan([mk(1, 46001)], []);
  assert.equal(p.mode, "full");
  assert.match(p.reason, /kosong/);
});

test("tidak ada baris baru -> mode none, stale 0", () => {
  const rows = [mk(1, 46005), mk(2, 46004), mk(3, 46003)];
  const p = plan(rows, rows);
  assert.equal(p.mode, "none");
  assert.equal(p.additions.length, 0);
  assert.equal(p.stale, 0);
  assert.equal(p.newestSource, 46005);
});

test("baris baru yang lebih baru disisipkan di atas (posisi 0); yang sudah ada tidak ditulis ulang", () => {
  const old = [mk(1, 46003), mk(2, 46002), mk(3, 46001)];
  const p = plan([...old, mk(4, 46005), mk(5, 46004)], old);
  assert.equal(p.mode, "incremental");
  assert.deepEqual(keys(p.additions), [46005, 46004]);
  assert.equal(p.groups.length, 1);
  assert.equal(p.groups[0].p, 0);
  assert.equal(p.totalAfter, 5);
});

test("data terlambat: baris dengan create_date lebih lama dari sebagian isi tab disisipkan di posisi tengah; kelompok diurut dari bawah ke atas", () => {
  const old = [mk(1, 46010), mk(2, 46008), mk(3, 46006), mk(4, 46004)];
  const late1 = mk(10, 46009), late2 = mk(11, 46005), fresh = mk(12, 46011);
  const p = plan([...old, late1, late2, fresh], old);
  assert.equal(p.mode, "incremental");
  assert.deepEqual(p.groups.map((g) => g.p), [3, 1, 0]); // posisi di tab LAMA; dari bawah ke atas
  assert.deepEqual(p.groups.map((g) => keys(g.rows)), [[46005], [46009], [46011]]);
});

test("identitas yang sudah ada di tab tidak ditarik lagi (jumlah kemunculan tidak dihitung); identitas baru yang muncul dua kali hanya diambil yang terbaru", () => {
  const dup = mk(1, 46003);
  const target = [dup, mk(2, 46002)];
  assert.equal(plan([dup, dup, mk(2, 46002)], target).additions.length, 0);      // kembaran lagi: akun sama -> lewati
  assert.equal(plan([dup, mk(2, 46002)], [dup, dup, mk(2, 46002)]).stale, 0);    // tab punya kembaran lebih banyak: tidak jadi masalah
  assert.equal(plan([dup, mk(2, 46002)], target).mode, "none");
  const baru1 = mk(9, 46008), baru2 = [...baru1]; baru2[12] = 46007; baru2[13] = 46006.99;   // akun baru yang sama muncul 2x dgn tanggal beda
  const p = plan([dup, mk(2, 46002), baru1, baru2], target);
  assert.equal(p.additions.length, 1);
  assert.equal(p.additions[0][12], 46008);                                       // yang terbaru dipilih
});

test("batas terlama tab: baris yang terpotong oleh batas ruang tidak dianggap baru; baris lebih lama dari batas diabaikan", () => {
  const target = [mk(1, 46010), mk(2, 46009), mk(3, 46008)];                 // terlama di tab = 46008
  const table = [mk(1, 46010), mk(2, 46009), mk(3, 46008), mk(30, 46008), mk(40, 46001)]; // 46008 kedua (terpotong) dan 46001 (lebih tua)
  const p = plan(table, target);
  assert.equal(p.mode, "none");
  assert.equal(p.additions.length, 0);
});

test("baris di tab yang hilang/berubah di sumber dilaporkan sebagai stale (tidak dihapus otomatis)", () => {
  const target = [mk(1, 46010), mk(2, 46009), mk(3, 46008)];
  const table = [mk(1, 46010), mk(2, 46009, { driver: "dikoreksi" }), mk(3, 46008)]; // baris 2 diedit di sumber
  const p = plan(table, target);
  assert.equal(p.stale, 1);
  assert.equal(p.additions.length, 1);   // versi hasil edit tampil sebagai baru; versi lama tinggal sampai full refresh
});

test("terlalu banyak baris baru atau terlalu tersebar -> kembali ke tulis ulang penuh", () => {
  const target = [mk(1, 46100), mk(2, 46000)];
  const many = Array.from({ length: 5 }, (_, i) => mk(100 + i, 46200 + i));
  assert.equal(plan([...target, ...many], target, { maxAdditions: 3 }).mode, "full");
  const scatter = Array.from({ length: 6 }, (_, i) => mk(200 + i, 46001 + i * 0.1)); // semua di antara dua baris -> satu posisi
  assert.equal(plan([...target, ...scatter], target, { maxGroups: 1 }).mode, "incremental");
  const t3 = [mk(1, 46100), mk(2, 46050), mk(3, 46000)];
  const two = [mk(300, 46080), mk(301, 46020)];
  assert.equal(plan([...t3, ...two], t3, { maxGroups: 1 }).mode, "full");
});

test("overflow: setelah sisip, baris terlama melebihi batas ruang dihitung untuk dibuang", () => {
  const old = [mk(1, 46003), mk(2, 46002), mk(3, 46001)];
  const p = plan([...old, mk(4, 46005), mk(5, 46004)], old, { maxRows: 4 });
  assert.equal(p.totalAfter, 5);
  assert.equal(p.overflow, 1);
});

// ---- simulasi acak: menerapkan rencana ke array lalu membandingkan dengan tabel sumber penuh ----
function simulate(target, p, maxRows) {
  const arr = [...target];
  for (const g of p.groups) arr.splice(g.p, 0, ...g.rows); // dari bawah ke atas, posisi di tab LAMA
  if (p.overflow > 0) arr.splice(maxRows, p.overflow);
  return arr;
}
test("simulasi acak: hasil penerapan = tabel sumber penuh yang sudah dipotong (urutan, jumlah, isi)", () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let trial = 0; trial < 200; trial++) {
    const n = 20 + Math.floor(rnd() * 60);
    const all = Array.from({ length: n }, (_, i) => mk(i, 46000 + Math.floor(rnd() * 30), { driver: i % 7 === 0 ? 123456 : i })); // banyak tanggal kembar
    const table = desc(all);
    const maxRows = Math.max(10, n - Math.floor(rnd() * 8));
    const cap = table.slice(0, maxRows);
    // tab lama = tabel dikurangi beberapa baris baru (di atas) dan beberapa terlambat (acak di tengah), dipotong sesuai batas
    const removed = new Set();
    for (let i = 0; i < Math.floor(rnd() * 6); i++) removed.add(i);                       // yang terbaru belum masuk
    for (let i = 0; i < Math.floor(rnd() * 4); i++) removed.add(Math.floor(rnd() * cap.length)); // terlambat
    const target = cap.filter((_, i) => !removed.has(i));
    if (target.length === 0) continue;
    const p = planIncremental({ table, target, maxRows, maxGroups: 1000, maxAdditions: 1000 });
    if (p.mode === "none") { assert.equal(p.additions.length, 0); continue; }
    assert.equal(p.mode, "incremental");
    const result = simulate(target, p, maxRows);
    // urutan menurun terjaga, jumlah tidak melewati batas, dan setiap baris hasil ada di sumber
    for (let i = 1; i < result.length; i++) assert.ok(result[i - 1][12] >= result[i][12], "urutan tetap menurun");
    assert.ok(result.length <= maxRows);
    const srcSigs = new Map(); for (const r of table) srcSigs.set(signature(r), (srcSigs.get(signature(r)) ?? 0) + 1);
    for (const r of result) { const s = signature(r); assert.ok((srcSigs.get(s) ?? 0) > 0, "baris hasil ada di sumber"); srcSigs.set(s, srcSigs.get(s) - 1); }
    // semua baris sumber dengan create_date di atas batas terlama hasil harus ada di hasil
    const oldest = result.at(-1)[12];
    const need = table.filter((r) => r[12] > oldest).length;
    const have = result.filter((r) => r[12] > oldest).length;
    assert.equal(have, need, "tidak ada baris baru yang terlewat");
  }
});

// ---- penerapan ke sheet (API palsu): atomik per kelompok, bawah ke atas, hanya tab trial ----
function fakeApi(values = []) {
  const calls = [];
  return {
    calls,
    spreadsheets: {
      batchUpdate: async (req) => { calls.push({ op: "batchUpdate", req }); return {}; },
      values: { get: async (req) => { calls.push({ op: "get", req }); return { data: { values } }; } },
    },
  };
}

test("applyIncremental: satu batchUpdate atomik per kelompok (sisip + isi), dari bawah ke atas, lalu buang baris terlama", async () => {
  const api = fakeApi();
  const p = { groups: [{ p: 3, rows: [mk(1, 46005)] }, { p: 0, rows: [mk(2, 46011), mk(3, 46010)] }], overflow: 2, totalAfter: 12 };
  await applyIncremental(api, 777, p, { maxRows: 10 });
  const calls = api.calls.filter((c) => c.op === "batchUpdate");
  assert.equal(calls.length, 3);
  const [g1, g2, trim] = calls.map((c) => c.req.requestBody.requests);
  assert.deepEqual(g1[0].insertDimension, { range: { sheetId: 777, dimension: "ROWS", startIndex: 4, endIndex: 5 }, inheritFromBefore: true });
  assert.equal(g1[1].updateCells.start.rowIndex, 4);
  assert.equal(g1[1].updateCells.rows.length, 1);
  assert.equal(g1[1].updateCells.rows[0].values.length, 24);
  assert.deepEqual(g2[0].insertDimension, { range: { sheetId: 777, dimension: "ROWS", startIndex: 1, endIndex: 3 }, inheritFromBefore: false }); // p=0: jangan mewarisi header
  assert.equal(g2[1].updateCells.rows.length, 2);
  assert.deepEqual(trim[0].deleteDimension.range, { sheetId: 777, dimension: "ROWS", startIndex: 11, endIndex: 13 });
  // semua target selalu sheetId trial
  for (const c of calls) for (const rq of c.req.requestBody.requests) {
    const sid = (rq.insertDimension ?? rq.updateCells?.start ?? rq.deleteDimension?.range)?.sheetId ?? rq.insertDimension?.range.sheetId;
    assert.ok(sid === 777 || rq.insertDimension?.range.sheetId === 777 || rq.deleteDimension?.range.sheetId === 777);
  }
});

test("applyIncremental: tipe nilai dipertahankan (angka tetap angka, teks tetap teks, kosong = sel kosong)", async () => {
  const api = fakeApi();
  const row = mk(1, 46005); row[2] = "3311071702010001"; row[10] = 123456;
  await applyIncremental(api, 1, { groups: [{ p: 0, rows: [row] }], overflow: 0, totalAfter: 1 }, { maxRows: 10 });
  const cells = api.calls[0].req.requestBody.requests[1].updateCells.rows[0].values;
  assert.deepEqual(cells[2], { userEnteredValue: { stringValue: "3311071702010001" } });
  assert.deepEqual(cells[10], { userEnteredValue: { numberValue: 123456 } });
  assert.deepEqual(cells[1], {});
});

test("readTrialRows: A:O dan X dalam satu permintaan; baris 15 kolom, baris kosong di ujung dibuang; verifyTrialTop: ok / tidak ok / error API tidak throw", async () => {
  const calls = [];
  const api = { spreadsheets: { values: { batchGet: async (req) => { calls.push(req); return { data: { valueRanges: [{ values: [["a", "b"], ["c"], [], []] }, { values: [["Region A"], ["Region B"]] }] } }; } } } };
  const { rows, labels } = await readTrialRows(api);
  assert.deepEqual(calls[0].ranges, [`'${TRIAL.tab}'!A2:O`, `'${TRIAL.tab}'!X2:X`]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].length, 15);
  assert.deepEqual(labels, ["Region A", "Region B"]);
  const top = (v) => ({ spreadsheets: { values: { get: async () => ({ data: { values: v } }) } } });
  assert.deepEqual((await verifyTrialTop(top([[46325.5]]), 46325.5)), { ok: true });
  assert.equal((await verifyTrialTop(top([[46000]]), 46325.5)).ok, false);
  const broken = { spreadsheets: { values: { get: async () => { throw Object.assign(new Error("x"), { response: { status: 403 } }); } } } };
  assert.equal((await verifyTrialTop(broken, 1)).ok, false);
});
