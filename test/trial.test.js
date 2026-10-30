import assert from "node:assert/strict";
import { test } from "node:test";
import { CELL_LIMIT, TRIAL } from "../src/config.js";
import { buildRegionLookup, buildTrialTable, computeDerived, sheetsRound, TRIAL_HEADER } from "../src/trial.js";
import { ensureTrialTab, planTrialTab, writeTrialRows } from "../src/trial-write.js";

const DAY = 46000;                         // tanggal dasar (serial)
const hm = (h, m = 0, s = 0) => (h * 3600 + m * 60 + s) / 86400;
const row = ({ a = "x", hub = "Hub A", m, n }) => { const r = new Array(15).fill(""); r[0] = a; r[9] = hub; r[12] = m ?? ""; r[13] = n ?? ""; return r; };
const lookup = buildRegionLookup([["Hub A", "West Jabo", "BANTEN", "KAB. SERANG"], ["hub b", "South Jabo", "JAWA BARAT", "KOTA DEPOK"], ["Hub A", "DUPLIKAT", "X", "Y"]]);
const derived = (rows) => computeDerived(rows, lookup);

test("ROUND ala Sheets: bulatkan ke 15 digit signifikan dulu, setengah menjauhi nol", () => {
  assert.equal(sheetsRound(3997276316.4999995), 3997276317); // kasus nyata yang membuat Q selisih 1 menit di JavaScript biasa
  assert.equal(sheetsRound(2.5), 3);
  assert.equal(sheetsRound(-2.5), -3);
  assert.equal(sheetsRound(2.4), 2);
  assert.equal(sheetsRound(0), 0);
});

test("Q/R: permintaan di luar jendela 09-11 dan 12:30-16 dengan pembuatan wajar (15 menit - 2 jam) -> Q kosong, R = jam permintaan", () => {
  const n = DAY + hm(17, 0), m = n + hm(0, 30);
  const [p, q, r, s, t] = derived([row({ m, n })])[0];
  assert.equal(p, "");
  assert.equal(q, "");
  assert.equal(r, n);
  assert.ok(Math.abs(s - hm(0, 30)) < 1e-9); // toleransi pecahan desimal biner (serial tanggal ±46000)
  assert.ok(Math.abs(t - hm(0, 30)) < 1e-9);
});

test("Q/R: permintaan jam 09:00-11:00 digeser ke 11:00; kalau pembuatan wajar, Q = jam permintaan asli", () => {
  const n = DAY + hm(10, 0);                // base = 11:00
  const m = DAY + hm(11, 30);               // s = 1,5 jam -> keep; base != N -> Q = N
  const [, q, r] = derived([row({ m, n })])[0];
  assert.equal(q, n);
  assert.equal(r, n);
});

test("Q/R: permintaan jam 12:30-16:00 digeser ke 16:00; pembuatan wajar -> Q = jam permintaan asli", () => {
  const n = DAY + hm(14, 0), m = n + hm(0, 30);            // s = 30 menit (keep), base = 16:00 != N
  const [, q, r] = derived([row({ m, n })])[0];
  assert.equal(q, n);
  assert.equal(r, n);
});

test("Q: baris 'bad' mendapat jam permintaan sintetis = create_date - (15 menit + (detik mod 96) menit)", () => {
  const n = DAY + hm(10, 0);                // base 11:00
  const m = DAY + hm(10, 1, 40);            // s = 100 dtk (<900) dan ds negatif -> bad
  const [, q, r, , t] = derived([row({ m, n })])[0];
  const sec = Math.round(m * 86400);
  const want = m - (900 / 86400 + (sec % 96) / 1440);
  assert.ok(Math.abs(q - want) < 1e-12);
  assert.equal(r, q);
  assert.ok(Math.abs(t - (m - q)) < 1e-12);
});

test("Q: baris tidak-keep yang BUKAN bad ikut terisi hanya kalau detik pembuatannya sama dengan baris bad lain", () => {
  const nBad = DAY + hm(10, 0);
  const mBad = DAY + hm(10, 1, 40);                            // bad
  const nOk = DAY + hm(14, 0);                                 // base = N
  const mSame = mBad;                                          // detik pembuatan sama dengan baris bad
  const nFar = DAY + hm(8, 0);                                 // s = 1 hari -> tidak keep; ds > 6600 -> bad? (ds besar -> bad)
  const rows = [row({ m: mBad, n: nBad }), row({ m: mSame, n: nOk }), row({ m: DAY + hm(20, 0), n: nFar })];
  const d = derived(rows);
  assert.notEqual(d[0][1], "");
  assert.notEqual(d[1][1], "");   // s = 8 jam (tidak keep), tidak bad, tapi detik pembuatannya ada di himpunan bad
  assert.ok(Math.abs(d[0][1] - d[1][1]) < 1e-12); // rumus sama karena m sama
});

test("R kosong kalau nhe_release kosong; S dan T menganggap sel kosong = 0", () => {
  const n = DAY + hm(14, 0), m = n + hm(0, 30);
  const [, , r] = derived([row({ a: "", m, n })])[0];
  assert.equal(r, "");
});

test("U:W: XLOOKUP tanpa peduli huruf besar-kecil, kecocokan pertama, tidak ketemu = #N/A", () => {
  const n = DAY + hm(14, 0), m = n + hm(0, 30);
  const d = derived([row({ hub: "HUB A", m, n }), row({ hub: "Hub B", m, n }), row({ hub: "Mobile Hub - X", m, n })]);
  assert.deepEqual(d[0].slice(5), ["West Jabo", "BANTEN", "KAB. SERANG"]);   // bukan "DUPLIKAT"
  assert.deepEqual(d[1].slice(5), ["South Jabo", "JAWA BARAT", "KOTA DEPOK"]);
  assert.deepEqual(d[2].slice(5), ["#N/A", "#N/A", "#N/A"]);
});

test("buildTrialTable: baris tanpa create_date dibuang, urut terbaru dulu (stabil), kolom 24, label Sumber_Region di X, bisa dipotong", () => {
  const n = DAY + hm(14, 0);
  const rows = [
    row({ a: "tua", m: n + 1, n }), row({ a: "kosong", m: undefined, n }), row({ a: "baru", m: n + 5, n }),
    row({ a: "sama1", m: n + 3, n }), row({ a: "sama2", m: n + 3, n }),
  ];
  const labels = ["L1", "L2", "L3", "L4", "L5"];
  const t = buildTrialTable(rows, labels, lookup);
  assert.deepEqual(t.rows.map((r) => r[0]), ["baru", "sama1", "sama2", "tua"]);  // "kosong" dibuang; tanggal sama: urutan asal
  assert.ok(t.rows.every((r) => r.length === TRIAL.columns && r.length === TRIAL_HEADER.length));
  assert.deepEqual(t.rows.map((r) => r[23]), ["L3", "L4", "L5", "L1"]);
  assert.equal(t.total, 4);
  const cut = buildTrialTable(rows, labels, lookup, { maxRows: 2 });
  assert.deepEqual(cut.rows.map((r) => r[0]), ["baru", "sama1"]);
  assert.equal(cut.cut, 2);
});

// ---- penulisan: hanya boleh menyentuh tab trial ----
function fakeApi({ trialExists = false, sheets } = {}) {
  const calls = [];
  const list = sheets ?? [
    { properties: { sheetId: 1, title: "Nationwide", gridProperties: { rowCount: 125000, columnCount: 24 } } },
    { properties: { sheetId: 2, title: "Sort by New", gridProperties: { rowCount: 125000, columnCount: 34 } } },
    { properties: { sheetId: 3, title: "Control Panel", gridProperties: { rowCount: 1000, columnCount: 9 } } },
  ];
  if (trialExists) list.push({ properties: { sheetId: 99, title: TRIAL.tab, gridProperties: { rowCount: 500, columnCount: 24 } } });
  return {
    calls,
    spreadsheets: {
      get: async (req) => {
        calls.push({ op: "get", req });
        const fmt = (n) => ({ userEnteredFormat: { numberFormat: { type: "TEXT", pattern: n } } });
        const grid = { rowData: [{ values: [fmt("hdr0"), fmt("hdr1")] }, { values: [fmt("dat0"), fmt("dat1")] }], columnMetadata: [{ pixelSize: 120 }, { pixelSize: 90 }] };
        return { data: { sheets: list.map((s) => ({ ...s, data: [grid] })) } };
      },
      batchUpdate: async (req) => {
        calls.push({ op: "batchUpdate", req });
        const added = req.requestBody.requests.find((r) => r.addSheet);
        return { data: { replies: added ? [{ addSheet: { properties: { sheetId: 555 } } }] : [] } };
      },
      values: {
        update: async (req) => { calls.push({ op: "update", req }); return {}; },
        batchUpdate: async (req) => { calls.push({ op: "write", req }); return {}; },
        batchClear: async (req) => { calls.push({ op: "clear", req }); return {}; },
      },
    },
  };
}
const dataRows = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: 24 }, (_, c) => `${i}-${c}`));

test("planTrialTab: baris maksimum dihitung dari sisa sel (dikurangi cadangan, header, buffer); ruang kurang = error", async () => {
  const plan = await planTrialTab(fakeApi());
  const others = 125000 * 24 + 125000 * 34 + 1000 * 9;
  const expected = Math.floor((CELL_LIMIT - others - TRIAL.reserveCells) / TRIAL.columns) - 1 - TRIAL.rowBuffer;
  assert.equal(plan.maxRows, expected);
  assert.equal(plan.trial, null);
  assert.equal((await planTrialTab(fakeApi(), { maxRowsOverride: 5000 })).maxRows, 5000);
  const full = [{ properties: { sheetId: 1, title: "Nationwide", gridProperties: { rowCount: 400000, columnCount: 24 } } }];
  await assert.rejects(() => planTrialTab(fakeApi({ sheets: full })), /Ruang spreadsheet tidak cukup/);
});

test("ensureTrialTab + writeTrialRows: SEMUA penulisan hanya ke tab trial; Nationwide/tab lain hanya jadi sumber salin format", async () => {
  const api = fakeApi();
  const plan = await planTrialTab(api, { maxRowsOverride: 12001 });
  const tab = await ensureTrialTab(api, plan, 12001);
  assert.equal(tab.created, true);
  assert.equal(tab.sheetId, 555);
  await writeTrialRows(api, dataRows(12001), tab.rowCount);

  // semua alamat tulis (A1) memakai nama tab trial
  const ranges = [];
  for (const c of api.calls) {
    if (c.op === "update") ranges.push(c.req.range);
    if (c.op === "write") ranges.push(...c.req.requestBody.data.map((d) => d.range));
    if (c.op === "clear") ranges.push(...c.req.requestBody.ranges);
  }
  assert.ok(ranges.length >= 5);
  for (const r of ranges) assert.ok(r.startsWith(`'${TRIAL.tab}'!`), `rentang di luar tab trial: ${r}`);

  // semua request batchUpdate: tujuan/target selalu sheetId trial (555); sumber salin boleh Nationwide (1)
  for (const c of api.calls.filter((x) => x.op === "batchUpdate")) {
    for (const rq of c.req.requestBody.requests) {
      if (rq.addSheet) assert.equal(rq.addSheet.properties.title, TRIAL.tab);
      if (rq.repeatCell) assert.equal(rq.repeatCell.range.sheetId, 555);              // format hanya ke tab trial
      if (rq.updateDimensionProperties) assert.equal(rq.updateDimensionProperties.range.sheetId, 555);
      assert.ok(!rq.copyPaste, "tidak lagi menyalin jutaan sel");
      assert.ok(!rq.insertDimension && !rq.deleteSheet && !rq.updateCells, "tidak ada operasi lain");
    }
  }
  // potongan 5.000 baris: 12.001 baris -> 3 potongan, lalu pembersihan sisa di bawahnya
  const writes = api.calls.filter((c) => c.op === "write");
  assert.equal(writes.length, 3);
  assert.equal(writes[0].req.requestBody.valueInputOption, "RAW");
  assert.equal(writes[0].req.requestBody.data[0].range, `'${TRIAL.tab}'!A2:X5001`);
  assert.equal(api.calls.find((c) => c.op === "clear").req.requestBody.ranges[0], `'${TRIAL.tab}'!A12003:X`);
});

test("ensureTrialTab: tab sudah ada -> tidak dibuat ulang, hanya diperbesar kalau perlu", async () => {
  const api = fakeApi({ trialExists: true });
  const plan = await planTrialTab(api, { maxRowsOverride: 3000 });
  const tab = await ensureTrialTab(api, plan, 3000);
  assert.equal(tab.created, false);
  assert.equal(tab.sheetId, 99);
  assert.equal(api.calls.some((c) => c.op === "batchUpdate" && c.req.requestBody.requests.some((r) => r.addSheet)), false);
  const grow = api.calls.find((c) => c.op === "batchUpdate").req.requestBody.requests[0].updateSheetProperties;
  assert.equal(grow.properties.sheetId, 99);
  assert.equal(grow.properties.gridProperties.rowCount, 3000 + 1 + TRIAL.rowBuffer);
});
