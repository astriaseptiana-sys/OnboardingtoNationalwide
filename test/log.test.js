import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLogRow, failureEntry, successEntry, toSheetSerial, windowLabel } from "../src/log.js";
import { appendLogRow, PartialWriteError } from "../src/sheets.js";
import { summarize } from "../src/transform.js";

test("toSheetSerial: jam dinding WIB, cocok dengan baris LOG asli (28 Okt 2026 20:56:27 = 46323,87253...)", () => {
  const serial = toSheetSerial(new Date("2026-10-28T13:56:27Z"));
  assert.ok(Math.abs(serial - 46323.87253472222) < 1e-9, String(serial));
});

test("windowLabel: aturan sama dengan script lama (Siang 11:00-12:30, Malam 16:00-13:00)", () => {
  assert.equal(windowLabel(new Date("2026-10-29T05:00:00Z")), "Siang");       // 12:00 WIB
  assert.equal(windowLabel(new Date("2026-10-29T04:00:00Z")), "Siang");       // 11:00 WIB
  assert.equal(windowLabel(new Date("2026-10-29T02:00:00Z")), "Malam");       // 09:00 WIB
  assert.equal(windowLabel(new Date("2026-10-28T20:00:00Z")), "Malam");       // 03:00 WIB
  assert.equal(windowLabel(new Date("2026-10-29T09:30:00Z")), "Malam");       // 16:30 WIB
  assert.equal(windowLabel(new Date("2026-10-29T07:00:00Z")), "Luar window"); // 14:00 WIB
});

test("buildLogRow: 5 kolom Waktu | Window | Status | Baris | Keterangan", () => {
  const row = buildLogRow({ date: new Date("2026-10-29T05:00:00Z"), status: "✅ SUKSES", rows: 124641 });
  assert.equal(row.length, 5);
  assert.deepEqual(row.slice(1), ["Siang", "✅ SUKSES", 124641, ""]);
});

const good = { name: "A", region: "Region A", ok: true, rows: [[1]], dropped: 0 };
const bad = { name: "Jabar", region: "Region Jabar", ok: false, rows: [], error: "timeout" };

test("successEntry: semua sumber ok -> SUKSES tanpa keterangan", () => {
  const row = successEntry(summarize([good], null), 1);
  assert.equal(row[2], "✅ SUKSES");
  assert.equal(row[3], 1);
  assert.equal(row[4], "");
});

test("successEntry: region gagal -> SEBAGIAN dengan nama dan alasan; percobaan ke-2 dicatat", () => {
  const row = successEntry(summarize([good, bad], null), 1, { attempt: 2 });
  assert.equal(row[2], "⚠️ SEBAGIAN");
  assert.ok(row[4].includes("Jabar (timeout)"));
  assert.ok(row[4].includes("percobaan ke-2"));
});

test("failureEntry: GAGAL, Baris 0, alasan dan info penulisan sebagian", () => {
  const row = failureEntry(new PartialWriteError("Gagal menulis baris 5002-10001 (HTTP 503): x", 5001), { attempts: 2 });
  assert.equal(row[2], "❌ GAGAL");
  assert.equal(row[3], 0);
  assert.ok(row[4].includes("HTTP 503"));
  assert.ok(row[4].includes("sampai baris 5001"));
  assert.ok(row[4].includes("dicoba 2x"));
});

test("appendLogRow: sisip baris 2 mewarisi format baris di bawahnya, lalu isi nilai", async () => {
  const calls = [];
  const api = { spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 5, title: "Nationwide" } }, { properties: { sheetId: 99, title: "LOG" } }] } }),
    batchUpdate: async (req) => { calls.push(req.requestBody.requests); return {}; },
  } };
  const row = [46323.87, "Siang", "✅ SUKSES", 124641, ""];
  assert.equal(await appendLogRow(api, row), true);
  const [insert, update] = calls[0];
  assert.deepEqual(insert.insertDimension.range, { sheetId: 99, dimension: "ROWS", startIndex: 1, endIndex: 2 });
  assert.equal(insert.insertDimension.inheritFromBefore, false);
  assert.equal(update.updateCells.start.rowIndex, 1);
  assert.deepEqual(update.updateCells.rows[0].values, [
    { userEnteredValue: { numberValue: 46323.87 } },
    { userEnteredValue: { stringValue: "Siang" } },
    { userEnteredValue: { stringValue: "✅ SUKSES" } },
    { userEnteredValue: { numberValue: 124641 } },
    {},
  ]);
});

test("appendLogRow: tab LOG tidak ada -> false, tidak throw", async () => {
  const api = { spreadsheets: { get: async () => ({ data: { sheets: [{ properties: { sheetId: 5, title: "Nationwide" } }] } }) } };
  assert.equal(await appendLogRow(api, [1, "a", "b", 0, ""]), false);
});
