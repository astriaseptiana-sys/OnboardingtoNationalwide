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
export function createClient(env = process.env) {
  let auth;
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    auth = new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: SCOPES });
  } else if (env.GOOGLE_REFRESH_TOKEN) {
    auth = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
    auth.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  } else if (env.GOOGLE_ACCESS_TOKEN) {
    auth = new OAuth2Client();
    auth.setCredentials({ access_token: env.GOOGLE_ACCESS_TOKEN });
  } else {
    throw new Error("Kredensial Google tidak ada: set GOOGLE_SERVICE_ACCOUNT_JSON (atau GOOGLE_REFRESH_TOKEN)");
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

// Jumlah baris per label di kolom X Sheet6 (hasil run sebelumnya), untuk perbandingan laporan.
export async function readPreviousColumn(api) {
  const { spreadsheetId, tab, regionCol, firstRow } = DEST;
  const res = await withRetry(
    () => api.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!${regionCol}${firstRow}:${regionCol}` }),
    "Baca kolom X Sheet6",
  );
  return res.data.values ?? [];
}

async function getDestMeta(api) {
  const { spreadsheetId, tab } = DEST;
  const res = await withRetry(
    () => api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties)" }),
    "Baca metadata BPO Tracker",
  );
  let target = null;
  let otherCells = 0;
  for (const s of res.data.sheets) {
    const p = s.properties;
    if (p.title === tab) target = p;
    else otherCells += p.gridProperties.rowCount * p.gridProperties.columnCount;
  }
  if (!target) throw new Error(`Tab '${tab}' tidak ditemukan di BPO Tracker`);
  return {
    sheetId: target.sheetId,
    rowCount: target.gridProperties.rowCount,
    columnCount: target.gridProperties.columnCount,
    otherCells,
  };
}

// Tulis data ke Sheet6: A:O + X saja. Data baru ditulis dulu, baru sisa baris lama di bawahnya dibersihkan,
// jadi Sheet6 tidak sempat kosong. Kolom P:W tidak disentuh.
export async function writeDestination(api, { rows, regions }) {
  const { spreadsheetId, tab, dataFirstCol, dataLastCol, regionCol, firstRow } = DEST;
  const meta = await getDestMeta(api);
  const lastRow = rows.length + firstRow - 1;

  // 1) Pastikan grid cukup (hanya menambah, tidak pernah mengecilkan)
  const needRows = Math.max(meta.rowCount, lastRow + ROW_BUFFER);
  const needCols = Math.max(meta.columnCount, colIndex(regionCol) + 1);
  if (needRows > meta.rowCount || needCols > meta.columnCount) {
    const cellsAfter = meta.otherCells + needRows * needCols;
    if (cellsAfter > CELL_LIMIT) {
      throw new Error(
        `Batas ${CELL_LIMIT.toLocaleString("en-US")} sel spreadsheet terlewati ` +
        `(butuh ${cellsAfter.toLocaleString("en-US")}). Sheet6 tidak ditimpa — hapus tab/baris tak terpakai di BPO Tracker.`,
      );
    }
    await withRetry(() => api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{
        updateSheetProperties: {
          properties: { sheetId: meta.sheetId, gridProperties: { rowCount: needRows, columnCount: needCols } },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      }] },
    }), "Perbesar grid Sheet6");
    meta.rowCount = needRows;
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
    }), `Tulis Sheet6 baris ${r1}-${r2}`);
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
