import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPanel, setPanelError, updateControlPanel } from "../src/panel.js";
import { summarize } from "../src/transform.js";

const mk = (name, n, ok = true) => ({ name, region: `Region ${name}`, ok, rows: ok ? Array.from({ length: n }, () => [1]) : [], dropped: 0, error: ok ? undefined : "timeout" });

test("buildPanel: semua normal -> All STABLE hijau, persen dan total terisi", () => {
  const s = summarize([mk("Jateng", 60), mk("Jabar", 40)], { "Region Jateng": 60, "Region Jabar": 40 });
  const p = buildPanel(s, { finishedAt: new Date("2026-10-29T05:07:56Z") });
  assert.equal(p.status.text, "✅ All STABLE");
  assert.equal(p.status.fg, "#0F6E56");
  assert.equal(p.total, 100);
  assert.equal(p.regions.Jateng.rows, 60);
  assert.equal(p.regions.Jateng.pct, 0.6);
  assert.equal(p.regions.Jateng.status, "✅ STABLE");
  assert.equal(p.totalRow.pct, 1);
  assert.ok(Math.abs(p.updated - 46324.50550925926) < 1e-9); // 29 Okt 2026 12:07:56 WIB
});

test("buildPanel: region gagal -> Error merah, baris '—', total ADA ERROR; turun >=30% -> Anomali", () => {
  const s = summarize([mk("Jateng", 50), mk("Jabar", 0, false)], { "Region Jateng": 100, "Region Jabar": 40 });
  const p = buildPanel(s);
  assert.equal(p.regions.Jabar.rows, "—");
  assert.equal(p.regions.Jabar.pct, "");
  assert.equal(p.regions.Jabar.status, "❌ Error");
  assert.equal(p.regions.Jabar.bg, "#FCEBEB");
  assert.equal(p.regions.Jateng.status, "⚠️ Anomali"); // 100 -> 50
  assert.equal(p.status.text, "❌ ADA ERROR — Jabar tidak terambil"); // kartu status menyebut region yang gagal
  assert.equal(p.totalRow.status, "❌ ADA ERROR");
  assert.equal(p.regions.Jabar.change, "Tidak terambil: timeout");    // keterangan alasan di kolom Change
  assert.equal(p.regions.Jateng.change, "-50 (-50,0%)");              // region sukses tetap menampilkan perubahan
});

test("buildPanel dengan sheetCounts: angka dari Sumber_Region, cocok dengan sumber -> All STABLE", () => {
  const s = summarize([mk("Jateng", 60), mk("Jabar", 40)], null);
  const p = buildPanel(s, { sheetCounts: { "Region Jateng": 60, "Region Jabar": 40 } });
  assert.equal(p.regions.Jateng.rows, 60);
  assert.equal(p.regions.Jateng.pct, 0.6);
  assert.equal(p.regions.Jabar.status, "✅ STABLE");
  assert.equal(p.status.text, "✅ All STABLE");
  assert.equal(p.total, 100);
});

test("buildPanel dengan sheetCounts: sheet tidak sama dengan sumber -> Tidak sinkron + keterangan, PERLU DICEK", () => {
  const s = summarize([mk("Jateng", 60), mk("Jabar", 40)], null);
  const p = buildPanel(s, { sheetCounts: { "Region Jateng": 60, "Region Jabar": 25 } }); // Jabar baru separuh tertulis
  assert.equal(p.regions.Jabar.status, "⚠️ Tidak sinkron");
  assert.equal(p.regions.Jabar.rows, 25);
  assert.equal(p.regions.Jabar.change, "Sheet 25 ≠ sumber 40");
  assert.equal(p.regions.Jabar.bg, "#FAEEDA");
  assert.equal(p.status.text, "⚠️ PERLU DICEK");
  assert.equal(p.total, 85); // total dari isi sheet
});

test("buildPanel dengan sheetCounts: region gagal tetap Error, tidak dianggap sinkron", () => {
  const s = summarize([mk("Jateng", 5), mk("Jabar", 0, false)], null);
  const p = buildPanel(s, { sheetCounts: { "Region Jateng": 5 } });
  assert.equal(p.regions.Jabar.status, "❌ Error");
  assert.equal(p.regions.Jabar.rows, "—");
  assert.equal(p.status.text, "❌ ADA ERROR — Jabar tidak terambil");
});

function fakeApi({ names, failBatch = false }) {
  const calls = [];
  return {
    calls,
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 7, title: "Nationwide" } }, { properties: { sheetId: 42, title: "Control Panel" } }] } }),
      values: { get: async (req) => { calls.push({ op: "get", req }); return { data: { values: names.map((n) => [n]) } }; } },
      batchUpdate: async (req) => { if (failBatch) throw Object.assign(new Error("boom"), { response: { status: 403 } }); calls.push({ op: "batch", reqs: req.requestBody.requests }); return {}; },
    },
  };
}
const names = ["Jabodetabek & Banten", "Sumatera", "Kalsumal", "Jatim-Balnus", "Jateng", "Jabar", "Jabo Recycle Pipeline", "TOTAL"];
const place = (reqs) => reqs.map((r) => `${"ABCDEFGHI"[r.updateCells.start.columnIndex]}${r.updateCells.start.rowIndex + 1}`);

test("updateControlPanel: kartu status, baris region berdasarkan nama, TOTAL; baris yang bukan sumber tidak disentuh", async () => {
  const api = fakeApi({ names });
  const s = summarize([mk("Jabodetabek & Banten", 10), mk("Jateng", 5)], null);
  const res = await updateControlPanel(api, buildPanel(s));
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, []); // semua nama region ada di kolom B panel

  assert.equal(api.calls[0].req.range, "'Control Panel'!B13:B26");
  const cells = place(api.calls.find((c) => c.op === "batch").reqs);
  for (const c of ["B9", "D9", "F9", "C13", "D13", "E13", "F13", "C17", "F17", "C20", "D20", "E20", "F20"]) assert.ok(cells.includes(c), c);
  for (const c of ["C19", "F19", "C14", "F18"]) assert.ok(!cells.includes(c), `${c} tidak boleh disentuh`); // Jabo Recycle, Sumatera, Jabar
  // hanya sel nilai/warna status yang ditulis; G (sparkline) dan B (nama) tidak
  assert.ok(!cells.some((c) => c.startsWith("G") || (c.startsWith("B") && c !== "B9")));
});

test("updateControlPanel: warna hanya di sel Status (F) dan B9, persen kosong untuk region gagal", async () => {
  const api = fakeApi({ names });
  const s = summarize([mk("Jateng", 5), mk("Jabar", 0, false)], null);
  await updateControlPanel(api, buildPanel(s));
  const reqs = api.calls.find((c) => c.op === "batch").reqs;
  const by = Object.fromEntries(reqs.map((r) => [`${"ABCDEFGHI"[r.updateCells.start.columnIndex]}${r.updateCells.start.rowIndex + 1}`, r.updateCells]));
  assert.ok(by.F17.fields.includes("userEnteredFormat.backgroundColor"));
  assert.ok(by.F18.rows[0].values[0].userEnteredValue.stringValue === "❌ Error");
  assert.ok(by.B9.fields.includes("foregroundColor"));
  assert.equal(by.C17.fields, "userEnteredValue"); // nilai biasa, tanpa ubah format
  assert.deepEqual(by.D18.rows[0].values[0], {});   // persen kosong -> sel dikosongkan
  assert.equal(by.C18.rows[0].values[0].userEnteredValue.stringValue, "—");
});

test("updateControlPanel: nama region yang tidak ada di panel dilaporkan sebagai missing (bukan gagal diam-diam)", async () => {
  const api = fakeApi({ names: ["Jateng", "TOTAL"] });
  const s = summarize([mk("Jateng", 5), mk("Jabar", 5)], null);
  const res = await updateControlPanel(api, buildPanel(s));
  assert.equal(res.ok, true);
  assert.deepEqual(res.missing, ["Jabar"]);
});

test("buildReport dan buildFailureReport memuat peringatan penulisan LOG/panel", async () => {
  const { buildReport, buildFailureReport } = await import("../src/transform.js");
  const s = summarize([mk("Jateng", 5)], null);
  const rep = buildReport(s, { warnings: ["Tab LOG gagal dicatat (HTTP 503: timeout)", "Control Panel gagal diisi (HTTP 429: quota)"] });
  assert.ok(rep.includes("⚠️ Tab LOG gagal dicatat (HTTP 503: timeout)"));
  assert.ok(rep.includes("⚠️ Control Panel gagal diisi (HTTP 429: quota)"));
  assert.equal(buildReport(s).includes("gagal dicatat"), false);
  const fail = buildFailureReport(new Error("x"), { warnings: ["Tab LOG gagal dicatat (HTTP 503)"] });
  assert.ok(fail.includes("⚠️ Tab LOG gagal dicatat (HTTP 503)"));
});

test("updateControlPanel/setPanelError: gagal menulis tidak throw", async () => {
  const api = fakeApi({ names, failBatch: true });
  const s = summarize([mk("Jateng", 5)], null);
  const a = await updateControlPanel(api, buildPanel(s));
  assert.equal(a.ok, false);
  assert.ok(a.error.includes("HTTP 403") && a.error.includes("boom")); // alasan ikut dikembalikan untuk laporan
  assert.equal((await setPanelError(api)).ok, false);
});
