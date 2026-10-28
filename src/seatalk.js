// Kirim notifikasi ke grup SeaTalk lewat webhook. Tidak pernah throw: gagal kirim tidak boleh menggagalkan sync.
export async function sendSeaTalk(text, webhookUrl = process.env.SEATALK_WEBHOOK_URL) {
  if (!webhookUrl) {
    console.log("SEATALK_WEBHOOK_URL tidak diset — notifikasi SeaTalk dilewati");
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "text", text: { content: text } }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`Gagal kirim SeaTalk: HTTP ${res.status} ${body.slice(0, 200)}`);
      return false;
    }
    console.log("Notifikasi SeaTalk terkirim");
    return true;
  } catch (e) {
    console.error(`Gagal kirim SeaTalk: ${e.message}`);
    return false;
  }
}
