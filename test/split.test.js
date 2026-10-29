import assert from "node:assert/strict";
import { test } from "node:test";
import { REGION_SPLIT } from "../src/config.js";
import { successEntry } from "../src/log.js";
import { buildPanel } from "../src/panel.js";
import { readRegionMap } from "../src/sheets.js";
import { buildOutput, buildReport, splitResult, summarize } from "../src/transform.js";

// baris A:O dengan nama_hub di kolom J (index 9)
const row = (hub) => { const r = new Array(15).fill(""); r[0] = 1; r[9] = hub; return r; };
const jabo = (hubs, ok = true) => ({ name: "Jabodetabek & Banten", region: "Region Jabodetabek & Banten", ok, rows: ok ? hubs.map(row) : [], dropped: 0, error: ok ? undefined : "timeout" });
const hubMap = new Map([["anyar hub", "West Jabo"], ["babakan madang hub", "South Jabo"], ["babelan 2 hub", "East Jabo"], ["cengkareng 3 hub", "North Jabo"]]);

test("splitResult: label per hub, huruf besar/kecil dan spasi tidak masalah, tak terpetakan dihitung", () => {
  const r = splitResult(jabo(["Anyar Hub", " ANYAR HUB ", "Babakan Madang Hub", "Babelan 2 Hub", "Cengkareng 3 Hub", "Hub Baru"]), hubMap, REGION_SPLIT);
  assert.deepEqual(r.rowLabels, [
    "Region West Jabo", "Region West Jabo", "Region South Jabo", "Region East Jabo", "Region North Jabo", "Region Jabodetabek & Banten",
  ]);
  assert.deepEqual(r.split.labels.map((l) => [l.name, l.count]), [["West Jabo", 2], ["South Jabo", 1], ["East Jabo", 1], ["North Jabo", 1]]);
  assert.equal(r.split.unmapped, 1);
});

test("splitResult: peta tidak tersedia -> semua baris tak terpetakan, label sumber asli", () => {
  const r = splitResult(jabo(["Anyar Hub", "Babelan 2 Hub"]), null, REGION_SPLIT);
  assert.deepEqual(r.rowLabels, ["Region Jabodetabek & Banten", "Region Jabodetabek & Banten"]);
  assert.equal(r.split.unmapped, 2);
});

test("buildOutput: kolom X memakai label pecahan; sumber lain tetap label sumbernya", () => {
  const other = { name: "Jateng", region: "Region Jateng", ok: true, rows: [row("x")], dropped: 0 };
  const out = buildOutput([splitResult(jabo(["Anyar Hub", "Babelan 2 Hub"]), hubMap, REGION_SPLIT), other]);
  assert.deepEqual(out.regions, [["Region West Jabo"], ["Region East Jabo"], ["Region Jateng"]]);
});

test("summarize: sumber dipecah menjadi 4 item (West/South/East/North), total tetap jumlah baris", () => {
  const r = splitResult(jabo(["Anyar Hub", "Anyar Hub", "Babakan Madang Hub", "Babelan 2 Hub", "Cengkareng 3 Hub"]), hubMap, REGION_SPLIT);
  const s = summarize([r], null);
  assert.deepEqual(s.items.map((i) => [i.name, i.count, i.status]), [["West Jabo", 2, "ok"], ["South Jabo", 1, "ok"], ["East Jabo", 1, "ok"], ["North Jabo", 1, "ok"]]);
  assert.equal(s.items[0].region, "Region West Jabo");
  assert.equal(s.total, 5);
  assert.equal(s.unmapped, 0);
  assert.equal(s.overall, "✅ SUKSES");
});

test("summarize: perubahan dibandingkan label pecahan run sebelumnya; turun >=30% -> anomali", () => {
  const r = splitResult(jabo(["Anyar Hub"]), hubMap, REGION_SPLIT);
  const s = summarize([r], { "Region West Jabo": 10 });
  assert.equal(s.items[0].status, "anomaly");
  assert.equal(s.items[0].change, "-9 (-90,0%)");
});

test("summarize: sumber Jabo gagal -> keempat label error; ada hub tak terpetakan -> PERLU DICEK + peringatan di laporan", () => {
  const failed = summarize([splitResult(jabo([], false), hubMap, REGION_SPLIT)], null);
  assert.ok(failed.items.every((i) => i.status === "error" && i.count === null));
  assert.equal(failed.items.length, 4);

  const s = summarize([splitResult(jabo(["Anyar Hub", "Hub Baru"]), hubMap, REGION_SPLIT)], null);
  assert.equal(s.unmapped, 1);
  assert.equal(s.overall, "⚠️ PERLU DICEK");
  assert.ok(buildReport(s).includes("1 baris Jabo dengan hub yang belum ada di tab Region"));
  assert.ok(successEntry(s, 2)[4].includes("1 baris Jabo belum terpetakan"));
});

test("buildPanel: empat baris Jabo dari Sumber_Region, total dari semua label termasuk tak terpetakan", () => {
  const r = splitResult(jabo(["Anyar Hub", "Anyar Hub", "Babakan Madang Hub", "Babelan 2 Hub", "Cengkareng 3 Hub", "Hub Baru"]), hubMap, REGION_SPLIT);
  const s = summarize([r], null);
  const p = buildPanel(s, { sheetCounts: { "Region West Jabo": 2, "Region South Jabo": 1, "Region East Jabo": 1, "Region North Jabo": 1, "Region Jabodetabek & Banten": 1 } });
  assert.deepEqual(Object.keys(p.regions), ["West Jabo", "South Jabo", "East Jabo", "North Jabo"]);
  assert.equal(p.regions["West Jabo"].rows, 2);
  assert.equal(p.total, 6);
  assert.equal(p.status.text, "⚠️ PERLU DICEK — 1 baris Jabo belum terpetakan");
});

test("readRegionMap: hanya region yang dipecah, nama hub huruf kecil", async () => {
  const api = { spreadsheets: { values: { get: async (req) => {
    assert.equal(req.range, "'Region'!A2:B");
    return { data: { values: [["Anyar Hub", "West Jabo"], ["Abang Hub", "Bali-Nusra"], [" Babelan 2 Hub ", "East Jabo"], ["", "West Jabo"]] } };
  } } } };
  const m = await readRegionMap(api);
  assert.deepEqual([...m.entries()], [["anyar hub", "West Jabo"], ["babelan 2 hub", "East Jabo"]]);
});
