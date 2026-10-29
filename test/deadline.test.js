import assert from "node:assert/strict";
import { test } from "node:test";
import { bounded, withDeadline } from "../src/deadline.js";

const sleep = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));

test("withDeadline: pekerjaan selesai lebih dulu -> hasilnya dikembalikan apa adanya", async () => {
  assert.deepEqual(await withDeadline(sleep(5, { ok: true }), 500), { ok: true });
});

test("withDeadline: melewati batas waktu -> ok false dengan alasan, tanpa menunggu pekerjaan", async () => {
  const t0 = Date.now();
  const res = await withDeadline(sleep(1000, { ok: true }), 30);
  assert.equal(res.ok, false);
  assert.equal(res.error, "belum selesai dalam 0.03 dtk");
  assert.ok(Date.now() - t0 < 500, "tidak menunggu pekerjaan yang lambat");
});

test("bounded: sukses -> { ok, value }; throw (termasuk bug sinkron) dan lewat batas -> { ok:false } tanpa pernah throw", async () => {
  assert.deepEqual(await bounded(async () => 42, 500), { ok: true, value: 42 });
  const thrown = await bounded(async () => { throw new Error("bug di buildPanel"); }, 500);
  assert.deepEqual(thrown, { ok: false, error: "bug di buildPanel" });
  const syncThrow = await bounded(() => { throw new TypeError("salah"); }, 500);
  assert.equal(syncThrow.ok, false);
  const slow = await bounded(() => sleep(1000, 1), 20);
  assert.equal(slow.ok, false);
  assert.ok(slow.error.startsWith("belum selesai"));
});

test("withDeadline: timer dibersihkan setelah selesai (tidak menahan proses)", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await withDeadline(sleep(1, 1), 60_000);
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `timer tersisa: ${before} -> ${after}`);
});
