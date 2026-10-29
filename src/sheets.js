import { sheets } from "@googleapis/sheets";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import {
  CELL_LIMIT, CHUNK_ROWS, DATE_COLUMNS, DEST, LOG_TAB, MAX_RETRY, REGION_SPLIT, RETRY_DELAY_MS, ROW_BUFFER,
  SOURCE_LAST_COL, SOURCE_TAB, SOURCE_WIDTH, WRITE_RETRY_DELAYS_MS, WRITE_TIMEOUT_MS,
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

const httpStatus = (e) => {
  const n = Number(e?.response?.status ?? e?.status ?? e?.code);
  return Number.isFinite(n) ? n : null;
};

// Retry untuk error sementara (429/5xx/timeout). Error izin/not-found tidak di-retry.
// `delay` = angka (jeda dikali nomor percobaan) atau array jeda per percobaan.
export async function withRetry(fn, label, attempts = MAX_RETRY, delay = RETRY_DELAY_MS) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = httpStatus(e);
      console.warn(`⚠️ ${label}: percobaan ${i}/${attempts} gagal${status ? ` (HTTP ${status})` : ""}: ${e.message}`);
      if ([400, 401, 403, 404].includes(status) || i === attempts) break;
      await sleep(Array.isArray(delay) ? delay[Math.min(i - 1, delay.length - 1)] : delay * i);
    }
  }
  throw lastErr;
}

// Penulisan berhenti di tengah: baris 2..writtenUntilRow sudah data baru, sisanya masih data lama.
export class PartialWriteError extends Error {
  constructor(message, writtenUntilRow, options) {
    super(message, options);
    this.name = "PartialWriteError";
    this.writtenUntilRow = writtenUntilRow;
  }
}

const makeWriteRetry = (delays) => (fn, label) => withRetry(fn, label, delays.length + 1, delays);
const writeOpts = { timeout: WRITE_TIMEOUT_MS };

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

// Peta nama hub (huruf kecil) -> region untuk region yang dipecah, dari tab Region di BPO Tracker.
export async function readRegionMap(api, split = REGION_SPLIT) {
  const res = await withRetry(
    () => api.spreadsheets.values.get({ spreadsheetId: DEST.spreadsheetId, range: `'${split.mapTab}'!A2:B` }, { timeout: 180_000 }),
    `Baca peta hub tab ${split.mapTab}`,
  );
  const wanted = new Set(split.regions);
  const map = new Map();
  for (const r of res.data.values ?? []) {
    const hub = String(r[0] ?? "").trim().toLowerCase();
    const region = String(r[1] ?? "").trim();
    if (hub && wanted.has(region)) map.set(hub, region);
  }
  return map;
}

// Jumlah baris per label di kolom X Nationwide (hasil run sebelumnya), untuk perbandingan laporan.
export async function readPreviousColumn(api) {
  const { spreadsheetId, tab, regionCol, firstRow } = DEST;
  const res = await withRetry(
    () => api.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'!${regionCol}${firstRow}:${regionCol}` }, { timeout: 180_000 }),
    "Baca kolom Sumber_Region Nationwide",
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

// Sisipkan satu baris di paling atas tab LOG (di bawah header), format kolom diwarisi dari baris di bawahnya.
// Tidak pernah throw: gagal mencatat log tidak boleh menggagalkan sync.
export async function appendLogRow(api, row) {
  const { spreadsheetId } = DEST;
  try {
    const sheetId = await withRetry(async () => {
      const res = await api.spreadsheets.get({ spreadsheetId, fields: "sheets.properties(sheetId,title)" });
      const s = res.data.sheets.find((x) => x.properties.title === LOG_TAB);
      if (!s) throw Object.assign(new Error(`Tab '${LOG_TAB}' tidak ditemukan`), { status: 404 });
      return s.properties.sheetId;
    }, "Cari tab LOG");

    const cell = (v) => (typeof v === "number" ? { userEnteredValue: { numberValue: v } }
      : v === "" || v == null ? {} : { userEnteredValue: { stringValue: String(v) } });

    await withRetry(() => api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [
        { insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, inheritFromBefore: false } },
        { updateCells: { start: { sheetId, rowIndex: 1, columnIndex: 0 }, rows: [{ values: row.map(cell) }], fields: "userEnteredValue" } },
      ] },
    }, { timeout: 60_000 }), "Tulis baris LOG");
    return true;
  } catch (e) {
    console.warn(`⚠️ Gagal mencatat ke tab ${LOG_TAB}: ${e.message}`);
    return false;
  }
}

// Tulis data ke tab tujuan (Nationwide): A:O + X saja. Data baru ditulis dulu, baru sisa baris lama di bawahnya
// dibersihkan, jadi tab tidak sempat kosong. Kolom P:W (rumus) tidak disentuh.
export async function writeDestination(api, { rows, regions }, { retryDelays = WRITE_RETRY_DELAYS_MS } = {}) {
  const { spreadsheetId, tab, dataFirstCol, dataLastCol, regionCol, firstRow, companionTabs = [] } = DEST;
  const writeRetry = makeWriteRetry(retryDelays);
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
    await writeRetry(() => api.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: growth.map((g) => ({
        updateSheetProperties: {
          properties: { sheetId: g.sheetId, gridProperties: { rowCount: g.rowCount, columnCount: g.columnCount } },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      })) },
    }, writeOpts), `Perbesar grid ${growth.map((g) => g.label).join(", ")}`);
    if (growth[0].label === tab) meta.rowCount = needRows;
  }

  // 2) Tulis per chunk. RAW = nilai persis seperti sumber (id_ktp tetap teks, tanggal tetap angka serial).
  //    Menulis idempotent, jadi aman diulang. Kalau satu chunk akhirnya gagal, kabarkan sampai baris mana yang sudah baru.
  let writtenUntil = firstRow - 1;
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
    const end = Math.min(start + CHUNK_ROWS, rows.length);
    const r1 = start + firstRow;
    const r2 = end + firstRow - 1;
    const t0 = Date.now();
    try {
      await writeRetry(() => api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: [
            { range: `'${tab}'!${dataFirstCol}${r1}:${dataLastCol}${r2}`, values: rows.slice(start, end) },
            { range: `'${tab}'!${regionCol}${r1}:${regionCol}${r2}`, values: regions.slice(start, end) },
          ],
        },
      }, writeOpts), `Tulis ${tab} baris ${r1}-${r2}`);
    } catch (e) {
      const status = httpStatus(e);
      throw new PartialWriteError(
        `Gagal menulis baris ${r1}-${r2}${status ? ` (HTTP ${status})` : ""}: ${e.message}`,
        writtenUntil,
        { cause: e },
      );
    }
    writtenUntil = r2;
    console.log(`  ditulis baris ${r1}-${r2} (${((Date.now() - t0) / 1000).toFixed(1)} dtk)`);
  }

  // 3) Format kolom (disamakan dengan format yang sudah ada di Nationwide)
  await writeRetry(() => api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: DATE_COLUMNS.map((c) => ({
      repeatCell: {
        range: { sheetId: meta.sheetId, startRowIndex: firstRow - 1, endRowIndex: lastRow, startColumnIndex: c.index, endColumnIndex: c.index + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: c.type, pattern: c.pattern } } },
        fields: "userEnteredFormat.numberFormat",
      },
    })) },
  }, writeOpts), "Format kolom tanggal");

  // 4) Bersihkan sisa baris lama di bawah data baru (hanya A:O dan X)
  if (lastRow + 1 <= meta.rowCount) {
    await writeRetry(() => api.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: [
        `'${tab}'!${dataFirstCol}${lastRow + 1}:${dataLastCol}`,
        `'${tab}'!${regionCol}${lastRow + 1}:${regionCol}`,
      ] },
    }, writeOpts), "Bersihkan sisa baris lama");
  }

  return { sheetId: meta.sheetId, lastRow };
}
