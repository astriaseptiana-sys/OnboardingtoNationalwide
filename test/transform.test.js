import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFailureReport, buildOutput, buildReport, changeText, cleanRows, colIndex,
  fmtRibuan, normalizeRow, summarize, tallyRegions,
} from "../src/transform.js";

const ok = (name, region, n) => ({ name, region, ok: true, rows: Array.from({ length: n }, (_, i) => [i, "x"]), dropped: 0 });
const bad = (name, region) => ({ name, region, ok: false, rows: [], error: "timeout" });

test("colIndex", () => {
  assert.equal(colIndex("A"), 0);
  assert.equal(colIndex("O"), 14);
  assert.equal(colIndex("X"), 23);
});

test("normalizeRow melengkapi sel kosong di kanan dan memotong kelebihan", () => {
  assert.deepEqual(normalizeRow([1, "a"], 4), [1, "a", "", ""]);
  assert.deepEqual(normalizeRow([1, 2, 3], 2), [1, 2]);
});

test("normalizeRow mempertahankan 0 dan false", () => {
  assert.deepEqual(normalizeRow([0, false], 3), [0, false, ""]);
});

test("cleanRows membuang baris yang seluruhnya kosong", () => {
  const { rows, dropped } = cleanRows([["a"], [], [""], [0]], 2);
  assert.deepEqual(rows, [["a", ""], [0, ""]]);
  assert.equal(dropped, 2);
});

test("buildOutput menandai region per baris, urutan sumber dijaga, sumber gagal dilewati", () => {
  const out = buildOutput([ok("A", "Region A", 2), bad("B", "Region B"), ok("C", "Region C", 1)]);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.regions, [["Region A"], ["Region A"], ["Region C"]]);
});

test("tallyRegions menghitung per label dan mengabaikan sel kosong", () => {
  assert.deepEqual(tallyRegions([["Region A"], ["Region A"], [""], [], ["Region B"]]), { "Region A": 2, "Region B": 1 });
  assert.deepEqual(tallyRegions(undefined), {});
});

test("fmtRibuan dan changeText", () => {
  assert.equal(fmtRibuan(1234567), "1.234.567");
  assert.equal(changeText(110, 100), "+10 (+10,0%)");
  assert.equal(changeText(90, 100), "-10 (-10,0%)");
  assert.equal(changeText(5, 0), "baseline");
});

test("summarize: semua normal -> SUKSES", () => {
  const s = summarize([ok("A", "Region A", 100), ok("B", "Region B", 100)], { "Region A": 100, "Region B": 100 });
  assert.equal(s.overall, "✅ SUKSES");
  assert.equal(s.total, 200);
  assert.equal(s.items[0].share, 0.5);
});

test("summarize: region turun >= 30% -> anomali", () => {
  const s = summarize([ok("A", "Region A", 60)], { "Region A": 100 });
  assert.equal(s.items[0].status, "anomaly");
  assert.equal(s.overall, "⚠️ PERLU DICEK");
});

test("summarize: sumber gagal -> SEBAGIAN GAGAL dan total hanya dari yang sukses", () => {
  const s = summarize([ok("A", "Region A", 10), bad("B", "Region B")], null);
  assert.equal(s.overall, "⚠️ SEBAGIAN GAGAL");
  assert.equal(s.total, 10);
  assert.equal(s.items[1].count, null);
});

test("buildReport memuat region gagal dan alasannya", () => {
  const s = summarize([ok("A", "Region A", 10), bad("Jabar", "Region Jabar")], null);
  const text = buildReport(s, { durationSec: 12, sheetUrl: "https://example.test" });
  assert.match(text, /SEBAGIAN GAGAL/);
  assert.match(text, /🔴 Jabar/);
  assert.match(text, /timeout/);
  assert.match(text, /Durasi: 12 dtk/);
});

test("buildFailureReport", () => {
  assert.match(buildFailureReport(new Error("boom"), { runUrl: "https://run.test" }), /boom[\s\S]*https:\/\/run\.test/);
});
