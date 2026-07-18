import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const outputDir = '/Users/sssihms/Documents/Password Manager/outputs/purchase_orders';
const workbook = Workbook.create();
const summary = workbook.worksheets.add('PO Summary');
const lines = workbook.worksheets.add('Line Items');

const poRows = [
  ['M-PO-P2627-622', '18-Jun-2026', 'LIFETECH SCIENTIFIC INDIA PVT LIMITED', 'ALIZA BIN', 47250.00, 1],
  ['M-PO-P2627-612', '17-Jun-2026', 'LIFETECH SCIENTIFIC INDIA PVT LIMITED', 'SANDHYAKUMARI', 59640.00, 2],
  ['M-PO-P2627-605', '16-Jun-2026', 'LIFETECH SCIENTIFIC INDIA PVT LIMITED', 'KRISHNADAS', 71688.76, 3],
  ['M-PO-P2627-579', '12-Jun-2026', 'LIFETECH SCIENTIFIC INDIA PVT LIMITED', 'Multiple patients; see Line Items', 768652.50, 14],
  ['M-PO-P2627-602', '16-Jun-2026', 'KARDIO ENDOVAS', 'KRISHNADAS', 152250.00, 1],
  ['M-PO-P2627-582', '12-Jun-2026', 'MERU VENTURES', 'Not stated on PO', 51557.36, 3],
];

const lineRows = [
  ['M-PO-P2627-622', 1, 'KONAR MF VSD OCCLUDER 8-6 LT-MFO-8-6', 1, 45000, 'ALIZA BIN'],
  ['M-PO-P2627-612', 1, 'STEEREASE SHEATH INTRODUCER 12FR X 80CM SFA12F', 1, 16800, 'SANDHYAKUMARI'],
  ['M-PO-P2627-612', 2, 'HEARTR ASD OCCLUDER DEVICE 24MM XJFS24', 1, 40000, 'SANDHYAKUMARI'],
  ['M-PO-P2627-605', 1, 'CERA VASCULAR PLUG CABLE 3F LT-VP-3F', 1, 4000, 'KRISHNADAS'],
  ['M-PO-P2627-605', 2, 'STEEREASE SHEATH INTRODUCER 12FR X 80CM SFA12F', 1, 16800, 'KRISHNADAS'],
  ['M-PO-P2627-605', 3, 'HEART MUSCULAR VSD OCCLUDER DEVICE 22MM XJFVJ22', 1, 47475, 'KRISHNADAS'],
  ['M-PO-P2627-579', 1, 'HEART VSD OCCLUDER 18MM REF XJFVJ18', 1, 47250, 'KRISHNADAS R'],
  ['M-PO-P2627-579', 2, 'KONAR MF VSD OCCLUDER 5-3 LT-MFO-5-3', 1, 45000, 'DILEEPMITHRAN'],
  ['M-PO-P2627-579', 3, 'KONAR MF VSD OCCLUDER 6-4 LT-MFO-6-4', 1, 45000, 'SUMAN BAGDI (inferred from adjacent patient note)'],
  ['M-PO-P2627-579', 4, 'KONAR VSD OCCLUDER DEVICE 7-5 LT-MFO-7-5', 2, 45000, 'SAMANVITA; SUSHMITA MONDAL'],
  ['M-PO-P2627-579', 5, 'KONAR MF VSD OCCLUDER 8-6 LT-MFO-8-6', 2, 45000, 'ARUSHI JANA; DILEEPMITHRAN'],
  ['M-PO-P2627-579', 6, 'KONAR VSD OCCLUDER DEVICE 9-7 LT-MFO-9-7', 2, 45000, 'HARIHARAN; LAGNNA BISOI'],
  ['M-PO-P2627-579', 7, 'KONAR VSD OCCLUDER DEVICE 10-8 LT-MFO-10-8', 2, 45000, 'DEBAPRIYA SAU; LALAN KUMAR'],
  ['M-PO-P2627-579', 8, 'KONAR VSD OCCLUDER DEVICE 12-10 LT-MFO-12-10', 1, 45000, 'Explanted - no patient stated'],
  ['M-PO-P2627-579', 9, 'KONAR VSD OCCLUDER DEVICE 14-12 LT-MFO-14-12', 1, 45000, 'SANTOSHI KARAK'],
  ['M-PO-P2627-579', 10, 'HEARTR ASD OCCLUDER DEVICE 18MM XJFS18', 1, 40000, 'SREEJA MALIK'],
  ['M-PO-P2627-579', 11, 'HEARTR ASD OCCLUDER 20MM XJFS20', 1, 40000, 'PRABHAKARAN AP'],
  ['M-PO-P2627-579', 12, 'HEARTR ASD OCCLUDER 28MM XJFS28', 1, 40000, 'SONU KUMAR'],
  ['M-PO-P2627-579', 13, 'CERA VASCULAR PLUG CABLE 3F LT-VP-3F', 2, 4000, 'DILEEPMITHRAN P; LALAN KUMAR'],
  ['M-PO-P2627-579', 14, 'STEEREASE SHEATH INTRODUCER 10FR X 80CM SFA10F', 1, 16800, 'KRISHNA DAS'],
  ['M-PO-P2627-602', 1, 'BENTLEY BEGRAFT AORTIC STENT GRAFT SYSTEM 7FR REF BGP3710_2', 1, 145000, 'KRISHNADAS'],
  ['M-PO-P2627-582', 1, 'COCOON PDA ACCESSORY 7F COP7F', 2, 12275.56, 'Not stated on PO'],
  ['M-PO-P2627-582', 2, 'COCOON ASD ACCESSORY 12F COA12F', 1, 12275.56, 'Not stated on PO'],
  ['M-PO-P2627-582', 3, 'COCOON PDA ACCESSORY 8F COP8F', 1, 12275.56, 'Not stated on PO'],
];

summary.mergeCells('A1:F1');
summary.getRange('A1').values = [['Purchase Order Summary']];
summary.getRange('A2:F2').values = [['Purchase Order No.', 'PO Date', 'Vendor', 'Patient Name(s)', 'PO Total (Rs.)', 'No. of Line Items']];
summary.getRange(`A3:F${poRows.length + 2}`).values = poRows;
const summaryTotalRow = poRows.length + 3;
summary.getRange(`A${summaryTotalRow}:D${summaryTotalRow}`).merge();
summary.getRange(`A${summaryTotalRow}`).values = [['Grand Total']];
summary.getRange(`E${summaryTotalRow}`).formulas = [[`=SUM(E3:E${summaryTotalRow - 1})`]];
summary.getRange(`F${summaryTotalRow}`).formulas = [[`=SUM(F3:F${summaryTotalRow - 1})`]];
summary.getRange(`A${summaryTotalRow + 2}:F${summaryTotalRow + 2}`).merge();
summary.getRange(`A${summaryTotalRow + 2}`).values = [['Patient names are transcribed from the bottom/continuation pages where present. See Line Items for item-level mapping.']];

lines.mergeCells('A1:G1');
lines.getRange('A1').values = [['Purchase Order Line Items']];
lines.getRange('A2:G2').values = [['Purchase Order No.', 'Line No.', 'Item', 'Qty', 'Rate (Rs.)', 'Patient Name(s)', 'Line Amount (Rs.)']];
lines.getRange(`A3:F${lineRows.length + 2}`).values = lineRows;
lines.getRange('G3').formulas = [['=D3*E3']];
lines.getRange(`G3:G${lineRows.length + 2}`).fillDown();
const lineTotalRow = lineRows.length + 3;
lines.getRange(`A${lineTotalRow}:F${lineTotalRow}`).merge();
lines.getRange(`A${lineTotalRow}`).values = [['Calculated total before tax']];
lines.getRange(`G${lineTotalRow}`).formulas = [[`=SUM(G3:G${lineTotalRow - 1})`]];
lines.getRange(`A${lineTotalRow + 2}:G${lineTotalRow + 2}`).merge();
lines.getRange(`A${lineTotalRow + 2}`).values = [['Note: PO totals include 5% tax. The calculated line total is the pre-tax value (quantity x rate).']];

for (const sheet of [summary, lines]) {
  sheet.showGridLines = false;
  sheet.getRange('A1:G1').format = { fill: '#1F4E78', font: { bold: true, color: '#FFFFFF', size: 16 }, horizontalAlignment: 'center', verticalAlignment: 'center' };
  sheet.getRange('A1:G1').format.rowHeight = 28;
  sheet.getRange('A2:G2').format = { fill: '#D9EAF7', font: { bold: true, color: '#17365D' }, horizontalAlignment: 'center', verticalAlignment: 'center', wrapText: true, borders: { preset: 'all', style: 'thin', color: '#B4C7E7' } };
  sheet.getRange('A2:G2').format.rowHeight = 27;
}

summary.getRange(`A3:F${summaryTotalRow}`).format.borders = { preset: 'all', style: 'thin', color: '#D9E2F3' };
summary.getRange(`A3:F${summaryTotalRow}`).format.verticalAlignment = 'center';
summary.getRange(`D3:D${summaryTotalRow - 1}`).format.wrapText = true;
summary.getRange(`E3:E${summaryTotalRow}`).format.numberFormat = '#,##0.00';
summary.getRange(`F3:F${summaryTotalRow}`).format.numberFormat = '#,##0';
summary.getRange(`A${summaryTotalRow}:F${summaryTotalRow}`).format = { fill: '#D9EAD3', font: { bold: true, color: '#274E13' }, borders: { preset: 'all', style: 'thin', color: '#93C47D' } };
summary.getRange(`A${summaryTotalRow + 2}:F${summaryTotalRow + 2}`).format = { fill: '#FFF2CC', font: { italic: true, color: '#7F6000' }, wrapText: true };
summary.getRange(`A${summaryTotalRow + 2}:F${summaryTotalRow + 2}`).format.rowHeight = 28;
summary.getRange('A:A').format.columnWidth = 22;
summary.getRange('B:B').format.columnWidth = 14;
summary.getRange('C:C').format.columnWidth = 38;
summary.getRange('D:D').format.columnWidth = 38;
summary.getRange('E:E').format.columnWidth = 16;
summary.getRange('F:F').format.columnWidth = 17;
summary.freezePanes.freezeRows(2);

lines.getRange(`A3:G${lineTotalRow}`).format.borders = { preset: 'all', style: 'thin', color: '#D9E2F3' };
lines.getRange(`C3:C${lineTotalRow - 1}`).format.wrapText = true;
lines.getRange(`F3:F${lineTotalRow - 1}`).format.wrapText = true;
lines.getRange(`D3:D${lineTotalRow - 1}`).format.numberFormat = '#,##0';
lines.getRange(`E3:E${lineTotalRow}`).format.numberFormat = '#,##0.00';
lines.getRange(`G3:G${lineTotalRow}`).format.numberFormat = '#,##0.00';
lines.getRange(`A${lineTotalRow}:G${lineTotalRow}`).format = { fill: '#D9EAD3', font: { bold: true, color: '#274E13' }, borders: { preset: 'all', style: 'thin', color: '#93C47D' } };
lines.getRange(`A${lineTotalRow + 2}:G${lineTotalRow + 2}`).format = { fill: '#FFF2CC', font: { italic: true, color: '#7F6000' }, wrapText: true };
lines.getRange(`A${lineTotalRow + 2}:G${lineTotalRow + 2}`).format.rowHeight = 30;
lines.getRange('A:A').format.columnWidth = 22;
lines.getRange('B:B').format.columnWidth = 10;
lines.getRange('C:C').format.columnWidth = 54;
lines.getRange('D:D').format.columnWidth = 9;
lines.getRange('E:E').format.columnWidth = 14;
lines.getRange('F:F').format.columnWidth = 42;
lines.getRange('G:G').format.columnWidth = 17;
lines.freezePanes.freezeRows(2);

await fs.mkdir(outputDir, { recursive: true });
const file = await SpreadsheetFile.exportXlsx(workbook);
await file.save(`${outputDir}/purchase_orders.xlsx`);

const summaryCheck = await workbook.inspect({ kind: 'table', range: `PO Summary!A1:F${summaryTotalRow}`, include: 'values,formulas', tableMaxRows: 12, tableMaxCols: 6 });
const lineCheck = await workbook.inspect({ kind: 'table', range: 'Line Items!A1:G27', include: 'values,formulas', tableMaxRows: 30, tableMaxCols: 7 });
const errors = await workbook.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A', options: { useRegex: true, maxResults: 100 }, summary: 'formula error scan' });
console.log(summaryCheck.ndjson);
console.log(lineCheck.ndjson);
console.log(errors.ndjson);

for (const [sheetName, range, filename] of [['PO Summary', `A1:F${summaryTotalRow + 2}`, 'summary.png'], ['Line Items', `A1:G${lineTotalRow + 2}`, 'line_items.png']]) {
  const image = await workbook.render({ sheetName, range, scale: 1.5, format: 'png' });
  await fs.writeFile(`${outputDir}/${filename}`, new Uint8Array(await image.arrayBuffer()));
}
