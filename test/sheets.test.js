import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, PartialWriteError, readSource, withRetry, writeDestination } from "../src/sheets.js";
import { buildFailureReport } from "../src/transform.js";

// Sheets API palsu: mencatat semua panggilan tulis.
function fakeApi({ rowCount = 1000, columnCount = 24, otherCells = 5_000_000, getValues } = {}) {
  const calls = [];
  return {
    calls,
    spreadsheets: {
      get: async () => ({
        data: { sheets: [
          { properties: { sheetId: 7, title: "Nationwide", gridProperties: { rowCount, columnCount } } },
          { properties: { sheetId: 8, title: "Sort by New", gridProperties: { rowCount: 1000, columnCount: 23 } } },
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
  // tab yang membaca Nationwide lewat formula spill ikut diperbesar (buffer 1000)
  const sortReq = grow.req.requestBody.requests[1].updateSheetProperties;
  assert.equal(sortReq.properties.sheetId, 8);
  assert.equal(sortReq.properties.gridProperties.rowCount, 12002 + 1000);

  const writes = api.calls.filter((c) => c.op === "values.batchUpdate");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].req.requestBody.data.map((d) => d.range), ["'Nationwide'!A2:O5001", "'Nationwide'!X2:X5001"]);
  assert.deepEqual(writes[2].req.requestBody.data.map((d) => d.range), ["'Nationwide'!A10002:O12002", "'Nationwide'!X10002:X12002"]);
  for (const w of writes) {
    assert.equal(w.req.requestBody.valueInputOption, "RAW");
    for (const d of w.req.requestBody.data) assert.doesNotMatch(d.range, /!(P|Q|R|S|T|U|V|W)\d/); // P:W tidak disentuh
  }

  const clear = api.calls.find((c) => c.op === "values.batchClear");
  assert.deepEqual(clear.req.requestBody.ranges, ["'Nationwide'!A12003:O", "'Nationwide'!X12003:X"]);

  // urutan: tulis dulu, bersihkan sisa terakhir
  const ops = api.calls.map((c) => c.op);
  assert.ok(ops.lastIndexOf("values.batchUpdate") < ops.indexOf("values.batchClear"));
});

test("writeDestination: format diterapkan ke kolom A, K, M, N", async () => {
  const api = fakeApi({ rowCount: 5000 });
  await writeDestination(api, makeData(10));
  const fmt = api.calls.find((c) => c.op === "sheets.batchUpdate" && c.req.requestBody.requests[0].repeatCell);
  const cols = fmt.req.requestBody.requests.map((r) => r.repeatCell.range.startColumnIndex);
  assert.deepEqual(cols, [0, 10, 12, 13]);
  assert.equal(fmt.req.requestBody.requests[0].repeatCell.range.endRowIndex, 11);
});

test("writeDestination: kolom rumus P:W dan tab lain tidak ikut ditulis atau dibersihkan", async () => {
  const api = fakeApi({ rowCount: 20000 });
  await writeDestination(api, makeData(100));
  for (const c of api.calls) {
    const ranges = [
      ...(c.req?.requestBody?.data ?? []).map((d) => d.range),
      ...(c.req?.requestBody?.ranges ?? []),
    ];
    for (const r of ranges) assert.match(r, /^'Nationwide'!(A\d+:O|X\d+:X)/, r);
  }
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

test("createClient: secret kosong -> pesan menyebut variabel mana yang KOSONG", () => {
  assert.throws(() => createClient({ GOOGLE_SERVICE_ACCOUNT_JSON: "  " }), /GOOGLE_SERVICE_ACCOUNT_JSON=KOSONG.*Repository secrets/);
});

test("createClient: isi bukan JSON -> pesan jelas", () => {
  assert.throws(() => createClient({ GOOGLE_SERVICE_ACCOUNT_JSON: "bukan json" }), /bukan JSON valid/);
});

test("createClient: JSON service account valid -> client dibuat", () => {
  const api = createClient({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "x" }) });
  assert.equal(typeof api.spreadsheets.values.get, "function");
});

test("withRetry: jeda bisa berupa array per percobaan", async () => {
  let n = 0;
  const v = await withRetry(async () => { if (++n < 4) throw Object.assign(new Error("503"), { response: { status: 503 } }); return "ok"; }, "t", 4, [1, 1, 1]);
  assert.equal(v, "ok");
  assert.equal(n, 4);
});

test("writeDestination: chunk kedua gagal terus -> PartialWriteError dengan posisi baris terakhir yang sudah baru", async () => {
  const api = fakeApi({ rowCount: 50000 });
  let writes = 0;
  const orig = api.spreadsheets.values.batchUpdate;
  api.spreadsheets.values.batchUpdate = async (req, opts) => {
    writes++;
    assert.equal(opts.timeout, 180000); // batas waktu per request dipasang
    if (writes >= 2) throw Object.assign(new Error("Service unavailable"), { response: { status: 503 } });
    return orig(req);
  };
  await assert.rejects(
    () => writeDestination(api, makeData(12001), { retryDelays: [1, 1] }),
    (e) => e instanceof PartialWriteError && e.writtenUntilRow === 5001 && e.message.includes("baris 5002-10001 (HTTP 503)"),
  );
  assert.equal(writes, 1 + 3); // chunk 1 sukses, chunk 2 dicoba 3x (1 + 2 retry)
});

test("buildFailureReport: laporan sebagian terupdate dan jumlah percobaan", () => {
  const err = new PartialWriteError("Gagal menulis baris 5002-10001 (HTTP 503): x", 5001);
  const text = buildFailureReport(err, { attempts: 2 });
  assert.match(text, /Sudah dicoba 2x/);
  assert.ok(text.includes("SEBAGIAN terupdate: baris 2-5.001"));
  assert.match(buildFailureReport(new PartialWriteError("x", 1)), /belum diubah/);
});
