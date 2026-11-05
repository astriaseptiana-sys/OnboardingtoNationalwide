import assert from "node:assert/strict";
import { test } from "node:test";
import { writePanelAndLog } from "../src/prewrite.js";
import { summarize } from "../src/transform.js";

const summary = summarize([{ name: "Jateng", region: "Region Jateng", ok: true, rows: [[1], [2], [3]], dropped: 0 }], null);

// API palsu: batchUpdate "menggantung" (sampai dibatalkan) selama api.hang = true, seperti sheet yang sibuk menghitung ulang rumus.
function fakeApi() {
  const api = { hang: false, batches: [], logTop: [] };
  // permintaan yang masuk saat sheet sibuk menunggu sampai sheet pulih (api.hang = false) atau dibatalkan lewat signal
  const maybeHang = (opts) => (api.hang
    ? new Promise((resolve, rej) => {
      const timer = setInterval(() => { if (!api.hang) { clearInterval(timer); resolve(); } }, 10);
      opts?.signal?.addEventListener("abort", () => { clearInterval(timer); rej(Object.assign(new Error("dibatalkan"), { status: 400 })); });
    })
    : null);
  api.spreadsheets = {
    get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: "Control Panel" } }, { properties: { sheetId: 99, title: "LOG" } }] } }),
    values: { get: async (req) => ({ data: { values: String(req.range).startsWith("'LOG'") ? api.logTop : [["Jateng"], ["TOTAL"]] } }) },
    batchUpdate: async (req, opts) => {
      const h = maybeHang(opts); if (h) await h;
      api.batches.push(req.requestBody.requests);
      return {};
    },
  };
  return api;
}
const isLog = (reqs) => reqs.some((r) => r.insertDimension);
const isPanel = (reqs) => reqs.some((r) => r.updateCells && !r.insertDimension) && !isLog(reqs);

test("writePanelAndLog: sheet tenang -> panel dan LOG masing-masing ditulis sekali, tanpa peringatan", async () => {
  const api = fakeApi();
  const warnings = await writePanelAndLog(api, { summary, rowCount: 3, firstMs: 1000, secondMs: 1000 });
  assert.deepEqual(warnings, []);
  assert.equal(api.batches.filter(isLog).length, 1);
  assert.equal(api.batches.filter(isPanel).length, 1);
});

test("writePanelAndLog: putaran pertama menggantung, sheet pulih sebelum putaran kedua habis -> keduanya tertulis, tidak ganda", async () => {
  const api = fakeApi();
  api.hang = true;
  setTimeout(() => { api.hang = false; }, 150);
  const warnings = await writePanelAndLog(api, { summary, rowCount: 3, firstMs: 60, secondMs: 3000 });
  assert.deepEqual(warnings, []);
  assert.equal(api.batches.filter(isLog).length, 1);
  assert.equal(api.batches.filter(isPanel).length, 1);
});

test("writePanelAndLog: sheet tidak pulih -> peringatan untuk keduanya, tidak throw", async () => {
  const api = fakeApi();
  api.hang = true;
  const warnings = await writePanelAndLog(api, { summary, rowCount: 3, firstMs: 40, secondMs: 80 });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.startsWith("Control Panel gagal diisi")));
  assert.ok(warnings.some((w) => w.startsWith("Tab LOG gagal dicatat")));
  assert.equal(api.batches.length, 0);
});

test("writePanelAndLog: skipPanel -> hanya LOG yang ditulis", async () => {
  const api = fakeApi();
  assert.deepEqual(await writePanelAndLog(api, { summary, rowCount: 3, skipPanel: true, firstMs: 1000, secondMs: 1000 }), []);
  assert.equal(api.batches.filter(isLog).length, 1);
  assert.equal(api.batches.filter(isPanel).length, 0);
});
