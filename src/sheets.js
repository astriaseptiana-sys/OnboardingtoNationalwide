import { sheets } from "@googleapis/sheets";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import {
  CELL_LIMIT, CHUNK_ROWS, DATE_COLUMNS, DEST, MAX_RETRY, RETRY_DELAY_MS, ROW_BUFFER,
  SOURCE_LAST_COL, SOURCE_TAB, SOURCE_WIDTH,
} from "./config.js";
import { cleanRows, colIndex } from "./transform.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Urutan prioritas kredensial: service account -> OAuth refresh token -> access token (debug lokal).
const filled = (v) => typeof v === "string" && v.trim() !== "";

export function createClient(env = process.env) {
  let auth;
  if (filled(env.GOOGLE_SERVICE_ACCOUNT_JSON)) {
    let credentials;
    try {
      credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON valid — tempel ulang seluruh isi file key (dari { sampai })");
    }
    auth = new GoogleAuth({ credentials, scopes: SCOPES });
  } else if (filled(env.GOOGLE_REFRESH_TOKEN)) {
    auth = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  } else if (filled(env.GOOGLE_ACCESS_TOKEN)) {
    auth = new OAuth2Client();
    auth.setCredentials({ access_token: env.GOOGLE_ACCESS_TOKEN });
  } else {
    const status = ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_REFRESH_TOKEN"]
      .map((k) => `${k}=${filled(env[k]) ? "terisi" : "KOSONG"}`)
      .join(", ");
    throw new Error(
      `Kredensial Google tidak sampai ke script (${status}). ` +
      "Cek Settings > Secrets and variables > Actions > tab Secrets > Repository secrets: " +
      "nama harus persis GOOGLE_SERVICE_ACCOUNT_JSON dan dibuat di repo ini (bukan Variables / Environment secrets).",
    );
  }
  return sheets({ version: "v4", auth });
}

// Retry untuk error sementara (429/5xx/timeout). Error izin/not-found tidak di-retry.
export async function withRetry(fn, label, attempts = MAX_RETRY, delayMs = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = Number(e.response?.status ?? e.status ?? e.code);
      console.warn(`⚠️ ${label}: percobaan ${i}/${attempts} gagal: ${e.message}`);
      if ([400, 401, 403, 404].includes(status) || i === attempts) break;
      await sleep(delayMs * i);
    }
  }
  throw lastErr;
}

// Baca Success!A2:O dari satu sumber. Tidak pernah throw: hasil ditandai ok true/false.
export async function readSource(api, source) {
  try {
    const rawRows = await withRetry(async () => {
      const res = await api.spreadsheets.values.get({
        spreadsheetId: source.id,
        range: `'${SOURCE_TAB}'!A2:${SOURCE_LAST_COL}`,
        valueRenderOption: "UNFORMATTED_VALUE", // tipe asli: teks tetap teks, tanggal = angka serial
      });
      return res.data.values ?? [];
    }, `Baca '${source.name}'`);
    const { rows, dropped } = cleanRows(rawRows, SOURCE_WIDTH);
    return { ...source, ok: true, rows, dropped };
  } catch (e) {
    console.error(`❌ Sumber '${source.name}' gagal total: ${e.message}`);
    return { ...source, ok: false, rows: [], dropped: 0, error: e.message };
  }
}

// Jumlah baris per label di kolom X Nationwide (hasil run sebelumnya), untuk perbandingan laporan.
export async function readPreviousColumn(api) {
  const { spreadsheetId, tab, regionCol, firstRow } = DEST;
  const res = await withRetry(
    () => api.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!${regionCol}${firstRow}:${regionCol}` }),
    "Baca kolom X Nationwide",
  );
  return res.data.values ?? [];
}

async function getDestMeta(api) {
  const { spreadsheetId, tab } = DEST;
  const res = await withRetry(
    () => api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties)" }),
    "Baca metadata BPO Tracker",
  );
  const byTitle = {};
  let totalCells = 0;
  for (const s of res.data.sheets) {
    const p = s.properties;
    byTitle[p.title] = { sheetId: p.sheetId, rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount };
    totalCells += p.gridProperties.rowCount * p.gridProperties.columnCount;
  }
  const target = byTitle[tab];
  if (!target) throw new Error(`Tab '${tab}' tidak ditemukan di BPO Tracker`);
  return { ...target, byTitle, totalCells };
}

// Tulis data ke tab tujuan (Nationwide): A:O + X saja. Data baru ditulis dulu, baru sisa baris lama di bawahnya
// dibersihkan, jadi tab tidak sempat kosong. Kolom P:W (rumus) tidak disentuh.
export async function writeDestination(api, { rows, regions }) {
  const { spreadsheetId, tab, dataFirstCol, dataLastCol, regionCol, firstRow, companionTabs = [] } = DEST;
  const meta = await getDestMeta(api);
  const lastRow = rows.length + firstRow - 1;

  // 1) Pastikan grid cukup (hanya menambah, tidak pernah mengecilkan): tab tujuan + tab yang membaca dari sana
  const needRows = Math.max(meta.rowCount, lastRow + ROW_BUFFER);
  const needCols = Math.max(meta.columnCount, colIndex(regionCol) + 1);
  const growth = [];
  if (needRows > meta.rowCount || needCols > meta.columnCount) {
    growth.push({ label: tab, sheetId: meta.sheetId, rowCount: needRows, columnCount: needCols, before: meta.rowCount * meta.columnCount });
  }
  for (const c of companionTabs) {
    const t = meta.byTitle[c.tab];
    if (!t) { console.warn(`Tab pendamping '${c.tab}' tidak ditemukan — dilewati`); continue; }
    const rc = Math.max(t.rowCount, lastRow + c.buffer);
    if (rc > t.rowCount) growth.push({ label: c.tab, sheetId: t.sheetId, rowCount: rc, columnCount: t.columnCount, before: t.rowCount * t.columnCount });
  }
  if (growth.length) {
    const cellsAfter = meta.totalCells + growth.reduce((a, g) => a + g.rowCount * g.columnCount - g.before, 0);
    if (cellsAfter > CELL_LIMIT) {
      throw new Error(
        `Batas ${CELL_LIMIT.toLocaleString("en-US")} sel spreadsheet terlewati ` +
        `(butuh ${cellsAfter.toLocaleString("en-US")}). ${tab} tidak ditimpa — hapus tab/baris tak terpakai di BPO Tracker.`,
      );
    }
    await withRetry(() => api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: growth.map((g) => ({
        updateSheetProperties: {
          properties: { sheetId: g.sheetId, gridProperties: { rowCount: g.rowCount, columnCount: g.columnCount } },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      })) },
    }), `Perbesar grid ${growth.map((g) => g.label).join(", ")}`);
    if (growth[0].label === tab) meta.rowCount = needRows;
  }

  // 2) Tulis per chunk. RAW = nilai persis seperti sumber (id_ktp tetap teks, tanggal tetap angka serial).
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
    const end = Math.min(start + CHUNK_ROWS, rows.length);
    const r1 = start + firstRow;
    const r2 = end + firstRow - 1;
    await withRetry(() => api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: [
          { range: `'${tab}'!${dataFirstCol}${r1}:${dataLastCol}${r2}`, values: rows.slice(start, end) },
          { range: `'${tab}'!${regionCol}${r1}:${regionCol}${r2}`, values: regions.slice(start, end) },
        ],
      },
    }), `Tulis Nationwide baris ${r1}-${r2}`);
    console.log(`  ditulis baris ${r1}-${r2}`);
  }

  // 3) Format tanggal untuk kolom bertipe tanggal
  await withRetry(() => api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: DATE_COLUMNS.map((c) => ({
      repeatCell: {
        range: { sheetId: meta.sheetId, startRowIndex: firstRow - 1, endRowIndex: lastRow, startColumnIndex: c.index, endColumnIndex: c.index + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: c.type, pattern: c.pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    })) },
  }), "Format kolom tanggal");

  // 4) Bersihkan sisa baris lama di bawah data baru (hanya A:O dan X)
  if (lastRow + 1 <= meta.rowCount) {
    await withRetry(() => api.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [
        `'${tab}'!${dataFirstCol}${lastRow + 1}:${dataLastCol}`,
        `'${tab}'!${regionCol}${lastRow + 1}:${regionCol}`,
      ] },
    }), "Bersihkan sisa baris lama");
  }

  return { sheetId: meta.sheetId, lastRow };
}
