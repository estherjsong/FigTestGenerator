import { ColumnSchema, GeneratedTestCase, ScenarioItem } from "./types";

import * as XLSX from "xlsx";

function safeSheetName(name: string): string {
  return name.slice(0, 31).replace(new RegExp("[:\\\\/?*\\[\\]]", "g"), "_");
}

export function exportToExcel(
  originalWorkbook: { SheetNames: string[]; Sheets: Record<string, unknown> }, 
  results: Map<ScenarioItem, GeneratedTestCase[]>, 
  columns: ColumnSchema
) {
  const wb = XLSX.utils.book_new();
  for (const sheetName of originalWorkbook.SheetNames) {
    XLSX.utils.book_append_sheet(wb, originalWorkbook.Sheets[sheetName] as any, sheetName);
  }

  for (const [scenario, testCases] of results) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(testCases, { header: columns }), safeSheetName(scenario.id));
  }
  XLSX.writeFile(wb as any, "test_scenarios_output.xlsx");
}