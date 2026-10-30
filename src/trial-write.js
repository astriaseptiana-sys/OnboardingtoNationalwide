// Penulisan tab "Sort by New (Trial)". PENTING: modul ini hanya boleh MENULIS ke tab trial. Tab lain
// (Nationwide, Sort by New, Control Panel, LOG, Region) hanya dibaca (metadata ukuran dan format sumber salinan).
import { CELL_LIMIT, CHUNK_ROWS, DEST, TRIAL } from "./config.js";
import { describeError, retryLong, withRetry } from "./sheets.js";
import { TRIAL_HEADER } from "./trial.js";

const colLetter = (i) => String.fromCharCode(65 + i); // A..X (24 kolom)
const LAST_COL = colLetter(TRIAL.columns - 1);

// Rencana ukuran tab: berapa baris yang muat tanpa melewati batas 10 juta sel (dengan sisa cadangan untuk produksi).
export async function planTrialTab(api, { maxRowsOverride } = {}) {
  const res = await withRetry(
    () => api.spreadsheets.get({ spreadsheetId: DEST.spreadsheetId, fields: "sheets.properties(sheetId,title,gridProperties)" }),
    "Baca metadata BPO Tracker",
  );
  let others = 0;
  let trial = null;
  let source = null;
  for (const s of res.data.sheets) {
    const p = s.properties;
    const cells = p.gridProperties.rowCount * p.gridProperties.columnCount;
    if (p.title === TRIAL.tab) trial = { sheetId: p.sheetId, rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount };
    else others += cells;
    if (p.title === TRIAL.formatSourceTab) source = { sheetId: p.sheetId };
  }
  const available = CELL_LIMIT - others - TRIAL.reserveCells;
  let maxRows = Math.floor(available / TRIAL.columns) - 1 - TRIAL.rowBuffer; // dikurangi baris header dan cadangan
  if (Number.isFinite(maxRowsOverride)) maxRows = Math.min(maxRows, maxRowsOverride);
  if (maxRows < 1000) {
    throw new Error(`Ruang spreadsheet tidak cukup untuk tab trial (sisa ${available.toLocaleString("en-US")} sel setelah cadangan). Tab lain tidak diubah.`);
  }
  return { trial, source, maxRows, othersCells: others };
}

// Pastikan tab trial ada. Dibuat dengan header yang sama, frozen 1 baris 2 kolom, dan format kolom disalin dari
// tab Nationwide (hanya dibaca). Pemformatan bersifat kosmetik: gagal = peringatan, bukan kegagalan.
export async function ensureTrialTab(api, plan, dataRows) {
  const { spreadsheetId } = DEST;
  const needRows = dataRows + 1 + TRIAL.rowBuffer;
  const warnings = [];

  if (plan.trial) {
    // Tab sudah ada: hanya perbesar (kalau perlu) tab trial itu sendiri.
    if (plan.trial.rowCount < needRows) {
      await retryLong(() => api.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ updateSheetProperties: {
          properties: { sheetId: plan.trial.sheetId, gridProperties: { rowCount: needRows } }, fields: "gridProperties.rowCount",
        } }] },
      }), "Perbesar tab trial");
      plan.trial.rowCount = needRows;
    }
    return { sheetId: plan.trial.sheetId, rowCount: plan.trial.rowCount, created: false, warnings };
  }

  const added = await retryLong(() => api.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: {
      title: TRIAL.tab,
      gridProperties: { rowCount: needRows, columnCount: TRIAL.columns, frozenRowCount: 1, frozenColumnCount: 2 },
    } } }] },
  }), "Buat tab trial");
  const sheetId = added.data.replies[0].addSheet.properties.sheetId;

  await retryLong(() => api.spreadsheets.values.update({
    spreadsheetId, range: `'${TRIAL.tab}'!A1:${LAST_COL}1`, valueInputOption: "RAW", requestBody: { values: [TRIAL_HEADER] },
  }), "Tulis header tab trial");

  // Format: dibaca dari Nationwide (baris 1 = header, baris 2 = contoh sel data) lalu diterapkan PER KOLOM ke tab trial
  // (satu permintaan kecil per kolom, bukan menyalin jutaan sel). Lebar kolom disamakan. Kosmetik, tidak fatal.
  try {
    const meta = await withRetry(() => api.spreadsheets.get({
      spreadsheetId, ranges: [`'${TRIAL.formatSourceTab}'!A1:${LAST_COL}2`], includeGridData: true,
      fields: "sheets(properties(title),data(rowData(values(userEnteredFormat)),columnMetadata(pixelSize)))",
    }), "Baca format Nationwide", 2, [5000]);
    const grid = meta.data.sheets.find((s) => s.properties.title === TRIAL.formatSourceTab)?.data?.[0];
    if (!grid) throw new Error(`Tab '${TRIAL.formatSourceTab}' tidak ditemukan untuk membaca format`);
    const headerFormats = grid.rowData?.[0]?.values ?? [];
    const dataFormats = grid.rowData?.[1]?.values ?? [];
    const requests = [];
    for (let i = 0; i < TRIAL.columns; i++) {
      const cols = { startColumnIndex: i, endColumnIndex: i + 1 };
      if (headerFormats[i]?.userEnteredFormat) {
        requests.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, ...cols }, cell: { userEnteredFormat: headerFormats[i].userEnteredFormat }, fields: "userEnteredFormat" } });
      }
      if (dataFormats[i]?.userEnteredFormat) { // tanpa endRowIndex = sampai ujung kolom
        requests.push({ repeatCell: { range: { sheetId, startRowIndex: 1, ...cols }, cell: { userEnteredFormat: dataFormats[i].userEnteredFormat }, fields: "userEnteredFormat" } });
      }
      const px = grid.columnMetadata?.[i]?.pixelSize;
      if (px) requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
    }
    if (requests.length) {
      await withRetry(() => api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, { timeout: 120_000 }), "Terapkan format tab trial", 2, [5000]);
    }
  } catch (e) {
    warnings.push(`Format tab trial belum rapi (${describeError(e)}); isi data tidak terpengaruh`);
  }
  return { sheetId, rowCount: needRows, created: true, warnings };
}

// Tulis seluruh isi tab trial (nilai apa adanya) per potongan, lalu bersihkan sisa baris lama di bawahnya.
// Tidak ada langkah lain: tidak ada format ulang, tidak menyentuh tab lain.
export async function writeTrialRows(api, rows, rowCount) {
  const { spreadsheetId } = DEST;
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
    const end = Math.min(start + CHUNK_ROWS, rows.length);
    const r1 = start + 2; // baris 1 = header
    const r2 = end + 1;
    const t0 = Date.now();
    await retryLong(() => api.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: [{ range: `'${TRIAL.tab}'!A${r1}:${LAST_COL}${r2}`, values: rows.slice(start, end) }] },
    }), `Tulis tab trial baris ${r1}-${r2}`);
    console.log(`  tab trial: baris ${r1}-${r2} (${((Date.now() - t0) / 1000).toFixed(1)} dtk)`);
  }
  const lastRow = rows.length + 1;
  if (lastRow + 1 <= rowCount) {
    await retryLong(() => api.spreadsheets.values.batchClear({
      spreadsheetId, requestBody: { ranges: [`'${TRIAL.tab}'!A${lastRow + 1}:${LAST_COL}`] },
    }), "Bersihkan sisa baris lama tab trial");
  }
  return { lastRow };
}
