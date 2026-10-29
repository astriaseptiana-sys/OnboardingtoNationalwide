import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mentionEmails, sendSeaTalk } from "../src/seatalk.js";
import { buildFailureReport, buildReport, summarize } from "../src/transform.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeFetch(responseBody, { ok = true, status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status, text: async () => JSON.stringify(responseBody) };
  };
  return calls;
}

test("mentionEmails: default dari config, bisa ditimpa env", () => {
  assert.deepEqual(mentionEmails({}), ["astria.septiana@spxexpress.com"]);
  assert.deepEqual(mentionEmails({ SEATALK_MENTION_EMAILS: " a@x.com, b@x.com " }), ["a@x.com", "b@x.com"]);
});

test("sendSeaTalk: payload memuat mentioned_email_list", async () => {
  const calls = fakeFetch({ code: 0, not_mentioned: [] });
  const ok = await sendSeaTalk("halo", { webhookUrl: "https://hook.test", emails: ["astria.septiana@spxexpress.com"] });
  assert.equal(ok, true);
  assert.deepEqual(calls[0].body, { tag: "text", text: { content: "halo", mentioned_email_list: ["astria.septiana@spxexpress.com"] } });
});

test("sendSeaTalk: tanpa email -> tidak ada field mention", async () => {
  const calls = fakeFetch({ code: 0 });
  await sendSeaTalk("halo", { webhookUrl: "https://hook.test", emails: [] });
  assert.equal("mentioned_email_list" in calls[0].body.text, false);
});

test("sendSeaTalk: code != 0 dianggap gagal, tidak throw", async () => {
  fakeFetch({ code: 1, msg: "invalid" });
  assert.equal(await sendSeaTalk("x", { webhookUrl: "https://hook.test", emails: [] }), false);
});

test("sendSeaTalk: tanpa webhook dilewati", async () => {
  assert.equal(await sendSeaTalk("x", { webhookUrl: "", emails: [] }), false);
});

test("buildFailureReport memuat alasan dan link run ulang", () => {
  const text = buildFailureReport(new Error("HTTP 503 boom"), {
    runUrl: "https://gh.test/runs/1", rerunUrl: "https://gh.test/workflows/sync.yml", attempts: 2,
  });
  assert.ok(text.includes("HTTP 503 boom"));
  assert.ok(text.includes("Silakan run ulang di sini: https://gh.test/workflows/sync.yml"));
  assert.ok(text.includes("Log: https://gh.test/runs/1"));
});

test("buildReport: link run ulang hanya muncul kalau ada region gagal", () => {
  const good = { name: "A", region: "Region A", ok: true, rows: [[1]], dropped: 0 };
  const bad = { name: "B", region: "Region B", ok: false, rows: [], error: "timeout" };
  const url = "https://gh.test/workflows/sync.yml";
  assert.equal(buildReport(summarize([good], null), { rerunUrl: url }).includes("run ulang"), false);
  assert.equal(buildReport(summarize([good, bad], null), { rerunUrl: url }).includes("run ulang"), true);
});
