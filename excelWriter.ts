import { ColumnSchema, GeneratedTestCase, ScenarioItem } from "./types";

import * as XLSX from "xlsx";

function safeSheetName(name: string): string {
  return name.slice(0, 31).replace(new RegExp("[:\\\\/?*\\[\\]]", "g"), "_");
}

export function exportToExcel(
  originalWorkbook: { SheetNames: string[]; Sheets: Record<string, unknown> }, 
  results: Map<ScenarioItem, GeneratedTestCase[]>, 
  columns: ColumnSchema,
  allScenarios: ScenarioItem[],
  templateSheetName: string,
  dataStartRow: number,
  fileName: string,
  colIndices: number[]
) {
  const wb = XLSX.utils.book_new();
  for (const sheetName of originalWorkbook.SheetNames) {
    XLSX.utils.book_append_sheet(wb, originalWorkbook.Sheets[sheetName] as any, sheetName);
  }

  const templateSheet = templateSheetName ? originalWorkbook.Sheets[templateSheetName] as any : null;
  const colsToMerge = columns.map((col, idx) => {
    const lower = col.toLowerCase();
    if (lower === "no" || lower === "순번" || lower === "번호") return -1; // NO는 절대 병합하지 않음
    if (lower.includes("id") || lower.includes("명") || lower.includes("name") || lower.includes("전제") || lower.includes("조건") || lower.includes("결함")) {
      return idx;
    }
    return -1;
  }).filter(idx => idx !== -1);
  
  const idColIdx = columns.findIndex(c => c.includes("케이스 ID") || c.includes("케이스ID") || c.toLowerCase().includes("testcase id"));

  for (const [scenario, testCases] of results) {
    const finalName = safeSheetName(scenario.id);
    
    // 1. 원본 템플릿 깊은 복사 (열 너비 및 서식 완벽 유지)
    const ws = templateSheet ? JSON.parse(JSON.stringify(templateSheet)) : {};
    
    if (templateSheet) {
      // 기존 템플릿의 예시 데이터 행 삭제
      for (const key in ws) {
        if (key.match(/^[A-Z]+(\d+)$/)) {
          const rowNum = parseInt(RegExp.$1, 10) - 1;
          if (rowNum >= dataStartRow) delete ws[key];
        }
      }
    }
    
    // 2. 템플릿의 정확한 열(Column) 위치에 맞춰 배열(AOA)로 맵핑 (열 밀림 방지)
    const maxColIdx = Math.max(...colIndices, 0);
    const aoaData = testCases.map(tc => {
      const rowArr = new Array(maxColIdx + 1).fill(null);
      columns.forEach((colName, i) => {
        rowArr[colIndices[i]] = tc[colName] || "";
      });
      return rowArr;
    });

    XLSX.utils.sheet_add_aoa(ws, aoaData, { origin: { r: dataStartRow, c: 0 } });

    // 3. 다중 스텝 셀 병합 (Merging) - 같은 ID 및 동일 텍스트 묶기
    ws["!merges"] = ws["!merges"] || [];
    
    colsToMerge.forEach(cIdx => {
      const sheetColIdx = colIndices[cIdx];
      let startIdx = 0;
      let currentVal = testCases[0] ? testCases[0][columns[cIdx]] : null;
      let currentId = idColIdx !== -1 && testCases[0] ? testCases[0][columns[idColIdx]] : null;

      for (let i = 1; i <= testCases.length; i++) {
        const row = testCases[i];
        const val = row ? row[columns[cIdx]] : null;
        const id = idColIdx !== -1 && row ? row[columns[idColIdx]] : null;

        if (val !== currentVal || (idColIdx !== -1 && id !== currentId) || i === testCases.length) {
          if (i - 1 > startIdx && currentVal) {
            ws["!merges"].push({ s: { r: startIdx + dataStartRow, c: sheetColIdx }, e: { r: i - 1 + dataStartRow, c: sheetColIdx } });
            for (let clearR = startIdx + 1; clearR <= i - 1; clearR++) {
              const cellRef = XLSX.utils.encode_cell({ r: clearR + dataStartRow, c: sheetColIdx });
              if (ws[cellRef]) ws[cellRef].v = ""; // 중복 텍스트 안 보이게 빈칸 처리
            }
          }
          startIdx = i;
          currentVal = val;
          currentId = id;
        }
      }
    });

    wb.Sheets[finalName] = ws;

    // 4. 시나리오 목록 순서에 맞게 시트 위치(Index) 찾기
    let insertIdx = wb.SheetNames.length;
    const currentIdx = allScenarios.findIndex(s => s.id === scenario.id);
    
    if (currentIdx !== -1) {
      let foundAnchor = false;
      
      // 조건 A: 나보다 '앞선' 시나리오가 이미 엑셀에 있는지 역순 탐색
      for (let i = currentIdx - 1; i >= 0; i--) {
        const prevBase = safeSheetName(allScenarios[i].id);
        const lastIdx = wb.SheetNames.lastIndexOf(prevBase);
        if (lastIdx !== -1) {
          insertIdx = lastIdx + 1; // 앞선 시나리오의 바로 '뒤'에 삽입
          foundAnchor = true;
          break;
        }
      }
      
      // 조건 B: 앞선 시나리오가 없다면, 나보다 '뒤에 올' 시나리오가 있는지 정순 탐색
      if (!foundAnchor) {
        for (let i = currentIdx + 1; i < allScenarios.length; i++) {
          const nextBase = safeSheetName(allScenarios[i].id);
          const firstIdx = wb.SheetNames.indexOf(nextBase);
          if (firstIdx !== -1) {
            insertIdx = firstIdx; // 뒤에 올 시나리오의 바로 '앞'에 삽입
            break;
          }
        }
      }
    }
    
    // 3. 찾아낸 알맞은 위치에 시트 이름 삽입
    wb.SheetNames.splice(insertIdx, 0, finalName);
  }
  XLSX.writeFile(wb as any, fileName);
}