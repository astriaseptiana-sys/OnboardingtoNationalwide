import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBalance, formatBalance } from "../src/trial-balance.js";

const mk = (id, m, { driver = 1000 + id, label = "Region A" } = {}) => {
  const r = new Array(24).fill("");
  r[0] = 1; r[1] = `nama-${id}`; r[2] = `ktp-${id}`; r[10] = driver; r[12] = m; r[13] = m - 0.01; r[23] = label;
  return r;
};
const desc = (rows) => [...rows].sort((a, b) => b[12] - a[12]);
const tabOf = (rows) => { const d = desc(rows); return { tabRows: d.map((r) => r.slice(0, 15)), tabLabels: d.map((r) => r[23]) }; };
const bal = (src, tabSrc) => buildBalance({ table: desc(src), ...tabOf(tabSrc ?? src) });

test("tab memuat semua baris sumber sampai yang terlama -> BALANCE PENUH", () => {
  const src = [mk(1, 46001), mk(2, 46002), mk(3, 46003)];
  const b = bal(src);
  assert.equal(b.status, "balance-penuh");
  assert.equal(b.complete, true);
  assert.equal(b.missing, 0);
  assert.equal(b.extra, 0);
  assert.equal(b.cellsNeeded, 0);
  assert.equal(b.maxIdSrc, 1003);
  assert.equal(b.maxIdTab, 1003);
});

test("ada akun sumber yang belum masuk tab -> TIDAK BALANCE", () => {
  const src = [mk(1, 46001), mk(2, 46002), mk(3, 46003)];
  const b = bal(src, [mk(1, 46001), mk(3, 46003)]);   // akun 2 (di tengah) tidak ada
  assert.equal(b.status, "tidak-balance");
  assert.equal(b.missing, 1);
});

test("akun terbaru belum masuk (id dan tanggal terbaru) -> TIDAK BALANCE dan id terbesar berbeda", () => {
  const src = [mk(1, 46001), mk(2, 46002), mk(9, 46009)];
  const b = bal(src, [mk(1, 46001), mk(2, 46002)]);
  assert.equal(b.status, "tidak-balance");
  assert.equal(b.maxIdSrc, 1009);
  assert.equal(b.maxIdTab, 1002);
});

test("akun di tab yang sudah tidak ada di sumber -> TIDAK BALANCE (extra)", () => {
  const src = [mk(1, 46001), mk(2, 46002)];
  const b = bal(src, [mk(1, 46001), mk(2, 46002), mk(7, 46001.5)]);
  assert.equal(b.status, "tidak-balance");
  assert.equal(b.extra, 1);
});

test("tab hanya memuat rentang terbaru (ruang terbatas) -> BALANCE DALAM RENTANG, dengan jumlah yang tidak muat dan sel yang dibutuhkan", () => {
  const src = Array.from({ length: 10 }, (_, i) => mk(i + 1, 46000 + i));
  const b = bal(src, src.filter((r) => r[12] >= 46005));  // tab: 5 baris terbaru
  assert.equal(b.status, "balance-rentang");
  assert.equal(b.complete, false);
  assert.equal(b.missing, 0);
  assert.equal(b.notInTab, 5);                        // 46000..46004 lebih lama dari batas
  assert.equal(b.cellsNeeded, 5 * 24);
});

test("identitas kembar (id sama, data sama, tanggal beda): jumlah baris tab boleh antara unik dan total; tetap balance", () => {
  const dup = mk(1, 46003); const dup2 = [...dup]; dup2[12] = 46005; dup2[13] = 46004.99;   // akun sama, tanggal lebih baru
  const src = [dup, dup2, mk(2, 46002)];
  assert.equal(bal(src, [dup, mk(2, 46002)]).status, "balance-penuh");          // tab hanya satu dari kembaran
  assert.equal(bal(src).status, "balance-penuh");                               // tab memuat semuanya
  assert.equal(bal(src).scopeDistinct, 2);
  assert.equal(bal(src).scopeTotal, 3);
});

test("per label dan format laporan memuat status, total, dan id terbesar", () => {
  const src = [mk(1, 46001, { label: "Region A" }), mk(2, 46002, { label: "Region B" }), mk(3, 46003, { label: "Region B" })];
  const b = bal(src);
  assert.deepEqual(b.perLabel["Region B"], { src: 2, tab: 2 });
  const text = formatBalance(b);
  assert.ok(text.includes("BALANCE PENUH"));
  assert.ok(text.includes("id_driver terbesar"));
  assert.ok(text.includes("Region B"));
  assert.ok(formatBalance(bal(src, [mk(1, 46001)])).includes("TIDAK BALANCE"));
});

test("tab kosong -> TIDAK BALANCE (semua akun sumber belum ada)", () => {
  const b = buildBalance({ table: desc([mk(1, 46001)]), tabRows: [], tabLabels: [] });
  assert.equal(b.status, "tidak-balance");
  assert.equal(b.missing, 1);
});

test("cakupan tanggal: baris sumber di luar cakupan tidak dihitung terlewat dan dilaporkan", () => {
  const all = [mk(1, 46100), mk(2, 46300), mk(3, 46301)];
  const inScope = all.filter((r) => r[12] >= 46200);
  const b = buildBalance({ table: desc(inScope), ...tabOf(inScope), startSerial: 46200, outOfScope: 1 });
  assert.equal(b.status, "balance-penuh");
  assert.equal(b.outOfScope, 1);
  const text = formatBalance(b);
  assert.match(text, /Cakupan data: sejak .* 1 baris sumber yang lebih lama/);
  assert.match(text, /SELURUH data dalam cakupan/);
});
