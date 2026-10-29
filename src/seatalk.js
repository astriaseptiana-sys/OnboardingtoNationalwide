import { NOTIFY_EMAILS } from "./config.js";

// Email yang di-mention di setiap notifikasi. Bisa ditimpa lewat env SEATALK_MENTION_EMAILS (dipisah koma).
export function mentionEmails(env = process.env) {
  const raw = env.SEATALK_MENTION_EMAILS;
  if (typeof raw === "string" && raw.trim()) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return NOTIFY_EMAILS;
}

// Kirim notifikasi ke grup SeaTalk lewat webhook. Tidak pernah throw: gagal kirim tidak boleh menggagalkan sync.
export async function sendSeaTalk(text, { webhookUrl = process.env.SEATALK_WEBHOOK_URL, emails = mentionEmails() } = {}) {
  if (!webhookUrl) {
    console.log("SEATALK_WEBHOOK_URL tidak diset — notifikasi SeaTalk dilewati");
    return false;
  }
  const textBody = { content: text };
  if (emails.length) textBody.mentioned_email_list = emails;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "text", text: textBody }),
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* bukan JSON */ }
    if (!res.ok || (json && json.code !== 0)) {
      console.error(`Gagal kirim SeaTalk: HTTP ${res.status} ${raw.slice(0, 200)}`);
      return false;
    }
    if (json?.not_mentioned?.length) console.warn(`SeaTalk: tidak bisa mention ${json.not_mentioned.join(", ")}`);
    console.log("Notifikasi SeaTalk terkirim");
    return true;
  } catch (e) {
    console.error(`Gagal kirim SeaTalk: ${e.message}`);
    return false;
  }
}
