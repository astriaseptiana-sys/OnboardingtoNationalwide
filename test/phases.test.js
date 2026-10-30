import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded } from "../src/deadline.js";
import { verifyLastRow, withRetry, writeDestination } from "../src/sheets.js";

const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

// Sheets API palsu: mencatat urutan semua panggilan; `failFormat` membuat request format gagal (403 = tanpa retry).
function fakeApi({ rowCount = 50000, failFormat = false, batchGet } = {}) {
  const calls = [];
  const isFormat = (req) => req.requestBody.requests?.[0]?.repeatCell;
  return {
    calls,
    spreadsheets: {
      get: async () => ({
        data: { sheets: [
          { properties: { sheetId: 7, title: "Nationwide", gridProperties: { rowCount, columnCount: 24 } } },
          { properties: { sheetId: 8, title: "Sort by New", gridProperties: { rowCount: 1000, columnCount: 23 } } },
        ] },
      }),
      batchUpdate: async (req) => {
        if (isFormat(req) && failFormat) throw Object.assign(new Error("Internal error encountered."), { response: { status: 403 } });
        calls.push({ op: isFormat(req) ? "format" : "sheets.batchUpdate", req });
        return {};
      },
      values: {
        batchUpdate: async (req) => { calls.push({ op: "write", req }); return {}; },
        batchClear: async (req) => { calls.push({ op: "clear", req }); return {}; },
        batchGet: async (req) => { calls.push({ op: "get", req }); return batchGet(req); },
      },
    },
  };
}
const makeData = (n) => ({
  rows: Array.from({ length: n }, (_, i) => Array.from({ length: 15 }, (_, c) => `${i}-${c}`)),
  regions: Array.from({ length: n }, () => ["Region Test"]),
});
const fmtRange = (api) => api.calls.find((c) => c.op === "format").req.requestBody.requests[0].repeatCell.range;

test("writeDestination: pembersihan sisa baris dijalankan SEBELUM format", async () => {
  const api = fakeApi();
  await writeDestination(api, makeData(100), { prevLastRow: 90 });
  const ops = api.calls.map((c) => c.op);
  assert.ok(ops.indexOf("clear") > ops.lastIndexOf("write"), "bersihkan setelah semua potongan tulis");
  assert.ok(ops.indexOf("clear") < ops.indexOf("format"), "bersihkan sebelum format");
});

test("writeDestination: format HANYA baris baru (di bawah baris terakhir run sebelumnya)", async () => {
  const api = fakeApi();
  const res = await writeDestination(api, makeData(100), { prevLastRow: 90 }); // data terakhir di row 101
  const range = fmtRange(api);
  assert.equal(range.startRowIndex, 90); // row 91 (index 90) = prevLastRow + 1
  assert.equal(range.endRowIndex, 101);
  assert.deepEqual(res.warnings, []);
  // 4 kolom tanggal/angka, masing-masing satu repeatCell
  assert.equal(api.calls.find((c) => c.op === "format").req.requestBody.requests.length, 4);
});

test("writeDestination: tidak ada baris baru -> format dilewati sama sekali", async () => {
  const api = fakeApi();
  await writeDestination(api, makeData(100), { prevLastRow: 150 }); // data lebih sedikit dari sebelumnya
  assert.equal(api.calls.some((c) => c.op === "format"), false);
  assert.equal(api.calls.some((c) => c.op === "clear"), true); // sisa baris lama tetap dibersihkan
});

test("writeDestination: baris terakhir sebelumnya tidak diketahui -> format 3.000 baris terakhir saja", async () => {
  const api = fakeApi();
  await writeDestination(api, makeData(20000), {});
  const range = fmtRange(api);
  assert.equal(range.endRowIndex, 20001);
  assert.equal(range.endRowIndex - range.startRowIndex, 3000);
});

test("writeDestination: format gagal TIDAK menggagalkan penulisan; hanya jadi peringatan", async () => {
  const api = fakeApi({ failFormat: true });
  const res = await writeDestination(api, makeData(100), { prevLastRow: 90, retryDelays: [1] });
  assert.equal(res.lastRow, 101);
  assert.equal(res.warnings.length, 1);
  assert.ok(res.warnings[0].includes("Format tanggal baris 91-101 gagal"));
  assert.ok(res.warnings[0].includes("data tetap tertulis"));
  // data dan pembersihan sisa baris sudah terjadi
  assert.equal(api.calls.filter((c) => c.op === "write").length, 1);
  assert.equal(api.calls.some((c) => c.op === "clear"), true);
});

test("writeDestination: jalur data tidak berubah (rentang tulis A:O dan X, RAW, sisa baris dibersihkan dari baris berikutnya)", async () => {
  const api = fakeApi();
  await writeDestination(api, makeData(12001), { prevLastRow: 12000 });
  const writes = api.calls.filter((c) => c.op === "write");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].req.requestBody.data.map((d) => d.range), ["'Nationwide'!A2:O5001", "'Nationwide'!X2:X5001"]);
  assert.equal(writes[0].req.requestBody.valueInputOption, "RAW");
  const clear = api.calls.find((c) => c.op === "clear");
  assert.deepEqual(clear.req.requestBody.ranges, ["'Nationwide'!A12003:O", "'Nationwide'!X12003:X"]);
});

test("verifyLastRow: baris terakhir terisi dan baris sesudahnya kosong -> ok; request hanya 2 rentang kecil", async () => {
  const api = fakeApi({ batchGet: () => ({ data: { valueRanges: [{ values: [["29-Oct-2026"]] }, { values: [["Region Jateng"]] }] } }) });
  assert.deepEqual(await verifyLastRow(api, 124574), { ok: true });
  assert.deepEqual(api.calls[0].req.ranges, ["'Nationwide'!A124574:A124575", "'Nationwide'!X124574:X124575"]);
});

test("verifyLastRow: ada isi di bawah baris terakhir, atau baris terakhir kosong -> tidak ok; error API -> tidak throw", async () => {
  const stale = fakeApi({ batchGet: () => ({ data: { valueRanges: [{ values: [["a"], ["sisa lama"]] }, { values: [["x"]] }] } }) });
  assert.equal((await verifyLastRow(stale, 10)).ok, false);
  const empty = fakeApi({ batchGet: () => ({ data: { valueRanges: [{}, {}] } }) });
  assert.equal((await verifyLastRow(empty, 10)).ok, false);
  const broken = fakeApi({ batchGet: () => { throw Object.assign(new Error("boom"), { response: { status: 403 } }); } });
  const res = await verifyLastRow(broken, 10);
  assert.equal(res.ok, false);
  assert.ok(res.error.includes("HTTP 403"));
});

test("bounded: fn menerima signal; lewat batas waktu -> signal DIBATALKAN; selesai tepat waktu -> tidak dibatalkan", async () => {
  let seen;
  const slow = await bounded((signal) => { seen = signal; return sleep(500, 1); }, 20);
  assert.equal(slow.ok, false);
  assert.equal(seen.aborted, true);

  let seen2;
  const fast = await bounded((signal) => { seen2 = signal; return sleep(1, "ok"); }, 500);
  assert.deepEqual(fast, { ok: true, value: "ok" });
  assert.equal(seen2.aborted, false);
});

test("withRetry: signal dibatalkan -> tidak ada percobaan baru dan jeda langsung berhenti", async () => {
  const controller = new AbortController();
  let n = 0;
  const t0 = Date.now();
  const p = withRetry(async () => { n++; throw Object.assign(new Error("503"), { response: { status: 503 } }); }, "t", 5, [60_000], controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(p, /503/);
  assert.equal(n, 1);                       // hanya satu percobaan
  assert.ok(Date.now() - t0 < 2000, "jeda 60 detik tidak ditunggu");
});
