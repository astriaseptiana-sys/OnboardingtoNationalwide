import assert from "node:assert/strict";
import { test } from "node:test";
import { readSource, withRetry, writeDestination } from "../src/sheets.js";

// Sheets API palsu: mencatat semua panggilan tulis.
function fakeApi({ rowCount = 1000, columnCount = 24, otherCells = 5_000_000, getValues } = {}) {
  const calls = [];
  return {
    calls,
    spreadsheets: {
      get: async () => ({
        data: { sheets: [
          { properties: { sheetId: 7, title: "Sheet6", gridProperties: { rowCount, columnCount } } },
          { properties: { sheetId: 1, title: "Lain", gridProperties: { rowCount: otherCells / 10, columnCount: 10 } } },
        ] },
      }),
      batchUpdate: async (req) => { calls.push({ op: "sheets.batchUpdate", req }); return {}; },
      values: {
        get: async (req) => { calls.push({ op: "values.get", req }); return { data: { values: getValues } }; },
        batchUpdate: async (req) => { calls.push({ op: "values.batchUpdate", req }); return {}; },
        batchClear: async (req) => { calls.push({ op: "values.batchClear", req }); return {}; },
      },
    },
  };
}

const makeData = (n) => ({
  rows: Array.from({ length: n }, (_, i) => Array.from({ length: 15 }, (_, c) => `${i}-${c}`)),
  regions: Array.from({ length: n }, () => ["Region Test"]),
});

test("writeDestination: chunk, hanya A:O dan X, RAW, grid diperbesar, sisa lama dibersihkan", async () => {
  const api = fakeApi({ rowCount: 1000 });
  const { lastRow } = await writeDestination(api, makeData(12001));
  assert.equal(lastRow, 12002);

  const grow = api.calls.find((c) => c.op === "sheets.batchUpdate" && c.req.requestBody.requests[0].updateSheetProperties);
  assert.equal(grow.req.requestBody.requests[0].updateSheetProperties.properties.gridProperties.rowCount, 12002 + 500);

  const writes = api.calls.filter((c) => c.op === "values.batchUpdate");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].req.requestBody.data.map((d) => d.range), ["'Sheet6'!A2:O5001", "'Sheet6'!X2:X5001"]);
  assert.deepEqual(writes[2].req.requestBody.data.map((d) => d.range), ["'Sheet6'!A10002:O12002", "'Sheet6'!X10002:X12002"]);
  for (const w of writes) {
    assert.equal(w.req.requestBody.valueInputOption, "RAW");
    for (const d of w.req.requestBody.data) assert.doesNotMatch(d.range, /!(P|Q|R|S|T|U|V|W)\d/); // P:W tidak disentuh
  }

  const clear = api.calls.find((c) => c.op === "values.batchClear");
  assert.deepEqual(clear.req.requestBody.ranges, ["'Sheet6'!A12003:O", "'Sheet6'!X12003:X"]);

  // urutan: tulis dulu, bersihkan sisa terakhir
  const ops = api.calls.map((c) => c.op);
  assert.ok(ops.lastIndexOf("values.batchUpdate") < ops.indexOf("values.batchClear"));
});

test("writeDestination: format tanggal diterapkan ke kolom A, M, N", async () => {
  const api = fakeApi({ rowCount: 5000 });
  await writeDestination(api, makeData(10));
  const fmt = api.calls.find((c) => c.op === "sheets.batchUpdate" && c.req.requestBody.requests[0].repeatCell);
  const cols = fmt.req.requestBody.requests.map((r) => r.repeatCell.range.startColumnIndex);
  assert.deepEqual(cols, [0, 12, 13]);
  assert.equal(fmt.req.requestBody.requests[0].repeatCell.range.endRowIndex, 11);
});

test("writeDestination: lewat batas 10 juta sel -> throw sebelum menulis apa pun", async () => {
  const api = fakeApi({ rowCount: 1000, otherCells: 9_900_000 });
  await assert.rejects(() => writeDestination(api, makeData(50_000)), /Batas 10\.000\.000|Batas 10,000,000/);
  assert.equal(api.calls.filter((c) => c.op.startsWith("values.batch")).length, 0);
});

test("readSource: baris dilengkapi 15 kolom dan baris kosong dibuang", async () => {
  const api = fakeApi({ getValues: [["a", "b"], [], ["c"]] });
  const r = await readSource(api, { name: "X", region: "Region X", id: "abc" });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].length, 15);
  assert.equal(r.dropped, 1);
  const req = api.calls[0].req;
  assert.equal(req.range, "'Success'!A2:O");
  assert.equal(req.valueRenderOption, "UNFORMATTED_VALUE");
});

test("readSource: error izin (403) -> ok false tanpa retry berulang, tidak throw", async () => {
  const err = Object.assign(new Error("no access"), { response: { status: 403 } });
  let n = 0;
  const api = { spreadsheets: { values: { get: async () => { n++; throw err; } } } };
  const r = await readSource(api, { name: "X", region: "Region X", id: "abc" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "no access");
  assert.equal(n, 1);
});

test("withRetry: coba ulang untuk error sementara lalu berhasil", async () => {
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw Object.assign(new Error("5xx"), { response: { status: 503 } }); return "ok"; }, "t", 3, 1);
  assert.equal(v, "ok");
  assert.equal(n, 3);
});
