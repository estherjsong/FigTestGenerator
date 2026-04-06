import { ColumnSchema, ExampleRow, ScenarioItem } from "./types";

import * as XLSX from "xlsx";

const DEFAULT_COLUMNS = [
  "NO", "테스트케이스 ID", "테스트케이스 명", "테스트 스텝",
  "테스트 전제(사전조건)", "입력 데이터", "예상 결과",
  "실제 결과", "테스트 결과", "수행자", "수행일자",
  "결함 여부", "결함ID", "참고자료"
];

export function parseExcelFile(data: Uint8Array) {
  const wb = XLSX.read(data, { type: "array", cellStyles: true, cellNF: true });
  
  // 1. 시나리오 목록 먼저 추출 (이 데이터를 기반으로 템플릿을 찾음)
  const listSheetName = wb.SheetNames.find((name: string) => name.includes("목록") || name.toLowerCase().includes("list") || name.includes("시나리오")) || wb.SheetNames[0];
  const listSheet = wb.Sheets[listSheetName];
  const listAOA = XLSX.utils.sheet_to_json(listSheet, { header: 1 }) as unknown[][];

  let listHeaderIdx = 0;
  for (let i = 0; i < Math.min(listAOA.length, 15); i++) {
    const row1 = listAOA[i] || [];
    const row2 = listAOA[i + 1] || [];
    const joined = [...row1, ...row2].map(String).join("").replace(/\s/g, "").toLowerCase();
    if (joined.includes("id") || joined.includes("시나리오명") || joined.includes("이름")) {
      listHeaderIdx = i;
      break;
    }
  }

  const listHeaderRow1 = listAOA[listHeaderIdx] || [];
  const listHeaderRow2 = listAOA[listHeaderIdx + 1] || [];
  const listCols: { name: string; idx: number }[] = [];
  
  const listMaxLen = Math.max(listHeaderRow1.length, listHeaderRow2.length);
  for (let c = 0; c < listMaxLen; c++) {
    const val1 = String(listHeaderRow1[c] || "").trim();
    const val2 = String(listHeaderRow2[c] || "").trim();
    let finalColName = val1;
    if (val2 && val1 !== val2) {
      finalColName = val1 ? `${val1}${val2}` : val2;
    }
    finalColName = finalColName.replace(/\n/g, "").trim();
    if (finalColName && !finalColName.includes("__EMPTY")) {
      listCols.push({ name: finalColName, idx: c });
    }
  }

  const scenarios: ScenarioItem[] = [];
  const normalize = (str: string) => String(str).toLowerCase().replace(/\s/g, "");

  const idCandidates = ["시나리오id", "테스트시나리오id", "scenarioid", "id"];
  const nameCandidates = ["시나리오명", "테스트시나리오명", "테스트시나리오", "시나리오", "이름", "name"];
  const descCandidates = ["설명", "개요", "시나리오개요", "목적", "description", "내용", "비고", "시나리오설명", "테스트목적", "상세", "상세설명", "테스트내용"];

  const listDataStart = listHeaderIdx + (listHeaderRow2.length > 0 ? 2 : 1);

  for (let r = listDataStart; r < listAOA.length; r++) {
    const row = listAOA[r];
    if (!Array.isArray(row)) continue;
    
    const getVal = (candidates: string[]) => {
      for (const candidate of candidates) {
        const colDef = listCols.find(c => normalize(c.name) === candidate);
        if (colDef && row[colDef.idx] !== undefined && row[colDef.idx] !== null && String(row[colDef.idx]).trim() !== "") {
          return String(row[colDef.idx]).trim();
        }
      }
      for (const candidate of candidates) {
        const colDef = listCols.find(c => normalize(c.name).includes(candidate));
        if (colDef && row[colDef.idx] !== undefined && row[colDef.idx] !== null && String(row[colDef.idx]).trim() !== "") {
          return String(row[colDef.idx]).trim();
        }
      }
      return "";
    };

    const id = getVal(idCandidates);
    const name = getVal(nameCandidates);
    
    if (!id && !name) continue;

    scenarios.push({
      id: id || `SCN-${scenarios.length + 1}`,
      name: name || "이름 없음",
      description: getVal(descCandidates)
    });
  }

  // 2. 테스트케이스 템플릿(컬럼) 시트 찾기
  let columns: ColumnSchema = DEFAULT_COLUMNS;
  let exampleRows: ExampleRow[] = [];
  let foundValidTemplate = false;
  let templateSheetNameToReturn = "";
  let dataStartRowToReturn = 1;
  let colIndicesToReturn: number[] = [];

  let candidateSheets = wb.SheetNames.filter(n => n !== listSheetName);
  if (candidateSheets.length === 0) candidateSheets = [listSheetName]; // 시트가 1개뿐인 경우 예외처리

  // 시나리오 ID 이름으로 된 시트도 템플릿 후보에 강력하게 포함!
  const templateKeywords = ["템플릿", "template", "케이스", "명세서", "case", ...scenarios.map(s => s.id)];
  const sortedSheetNames = candidateSheets.sort((a, b) => {
    const aMatch = templateKeywords.some(k => a.toLowerCase().includes(k)) ? 1 : 0;
    const bMatch = templateKeywords.some(k => b.toLowerCase().includes(k)) ? 1 : 0;
    return bMatch - aMatch;
  });

  for (const sheetName of sortedSheetNames) {
    const templateSheet = wb.Sheets[sheetName];
    const templateAOA = XLSX.utils.sheet_to_json(templateSheet, { header: 1 }) as unknown[][];
    
    if (templateAOA && templateAOA.length > 0) {
      let tplHeaderIdx = -1;
      for (let i = 0; i < Math.min(templateAOA.length, 15); i++) {
        const row1 = templateAOA[i] || [];
        const row2 = templateAOA[i + 1] || [];
        // 병합된 2줄의 헤더를 합쳐서 검사 (정확도 200% 상승)
        const joined = [...row1, ...row2].map(String).join("").replace(/\s/g, "").toLowerCase();
        
        if (joined.includes("테스트") && (joined.includes("결과") || joined.includes("스텝") || joined.includes("데이터") || joined.includes("조건") || joined.includes("입력"))) {
          tplHeaderIdx = i;
          break;
        }
      }
      
      if (tplHeaderIdx !== -1) {
        const headerRow1 = templateAOA[tplHeaderIdx] || [];
        const headerRow2 = templateAOA[tplHeaderIdx + 1] || [];
        const validCols: { name: string; idx: number }[] = [];
        
        const maxLen = Math.max(headerRow1.length, headerRow2.length);
        for (let c = 0; c < maxLen; c++) {
          const val1 = String(headerRow1[c] || "").trim();
          const val2 = String(headerRow2[c] || "").trim();
          
          let finalColName = val1;
          if (val2 && val1 !== val2) {
            finalColName = val1 ? `${val1} ${val2}` : val2;
          }
          
          // __EMPTY 쓰레기값 완벽 제거
          finalColName = finalColName.replace(/\n/g, " ").trim();
          if (finalColName && !finalColName.includes("__EMPTY")) {
            validCols.push({ name: finalColName, idx: c });
          }
        }

        if (validCols.length >= 3) {
          columns = validCols.map(c => c.name);
          colIndicesToReturn = validCols.map(c => c.idx);
          
          // 예시 데이터는 찐 헤더 다음 줄부터 추출
          const dataStart = tplHeaderIdx + (headerRow2.length > 0 ? 2 : 1);
          const dataRows = templateAOA.slice(dataStart, dataStart + 3);
          exampleRows = dataRows.map(row => {
            const ex: ExampleRow = {};
            if (Array.isArray(row)) {
              for (const col of validCols) {
                ex[col.name] = row[col.idx] !== undefined && row[col.idx] !== null ? String(row[col.idx]) : "";
              }
            }
            return ex;
          }).filter(ex => Object.values(ex).some(v => v !== "")); // 빈 예시 제외
          
          foundValidTemplate = true;
          templateSheetNameToReturn = sheetName;
          dataStartRowToReturn = dataStart;
          break;
        }
      }
    }
  }
  
  // 적절한 컬럼을 못 찾았거나 컬럼 수가 너무 적으면 무조건 기본 템플릿(DEFAULT_COLUMNS) 사용
  if (!foundValidTemplate || columns.length < 3) {
    columns = DEFAULT_COLUMNS;
    colIndicesToReturn = columns.map((_, i) => i);
    exampleRows = [];
  }

  return { wb, columns, exampleRows, scenarios, templateSheetName: templateSheetNameToReturn, dataStartRow: dataStartRowToReturn, colIndices: colIndicesToReturn };
}