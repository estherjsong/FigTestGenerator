const DEFAULT_COLUMNS = [
    "NO", "테스트케이스 ID", "테스트케이스 명", "테스트 스텝",
    "테스트 전제(사전조건)", "입력 데이터", "예상 결과",
    "실제 결과", "테스트 결과", "수행자", "수행일자",
    "결함 여부", "결함ID", "참고자료"
];
export function parseExcelFile(arrayBuffer) {
    // @ts-ignore (Assuming XLSX is available globally via CDN)
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    // 1. 컬럼 및 예시 추출 (템플릿 시트)
    let templateSheetName = wb.SheetNames.find((name) => name.includes("템플릿") || name.toLowerCase().includes("template") || name.includes("케이스")) || wb.SheetNames[0];
    const templateSheet = wb.Sheets[templateSheetName];
    // @ts-ignore
    const templateData = XLSX.utils.sheet_to_json(templateSheet, { header: 1 });
    let columns = DEFAULT_COLUMNS;
    let exampleRows = [];
    if (templateData && templateData.length > 0) {
        columns = templateData[0].map(c => String(c).trim());
        // 두번째 Row부터 예시로 최대 3개 수집
        // @ts-ignore
        const rawExamples = XLSX.utils.sheet_to_json(templateSheet);
        exampleRows = rawExamples.slice(0, 3).map(row => {
            const ex = {};
            for (const col of columns)
                ex[col] = row[col] ? String(row[col]) : "";
            return ex;
        });
    }
    // 2. 시나리오 목록 추출 (목록 시트)
    let listSheetName = wb.SheetNames.find((name) => name.includes("목록") || name.toLowerCase().includes("list") || name.includes("시나리오")) || (wb.SheetNames.length > 1 ? wb.SheetNames[1] : wb.SheetNames[0]);
    const listSheet = wb.Sheets[listSheetName];
    // @ts-ignore
    const listData = XLSX.utils.sheet_to_json(listSheet);
    const scenarios = [];
    const idCandidates = ["시나리오 ID", "ID", "id", "NO"];
    const nameCandidates = ["시나리오명", "시나리오 명", "이름", "name", "Name"];
    const descCandidates = ["설명", "목적", "description", "내용", "비고"];
    for (const row of listData) {
        const getVal = (candidates) => {
            const col = candidates.find(c => row[c] !== undefined);
            return col ? String(row[col]).trim() : "";
        };
        const id = getVal(idCandidates);
        if (!id)
            continue; // ID가 없으면 스킵
        scenarios.push({
            id,
            name: getVal(nameCandidates),
            description: getVal(descCandidates)
        });
    }
    return { wb, columns, exampleRows, scenarios };
}
