function safeSheetName(name) {
    return name.slice(0, 31).replace(/[:\\\/\?\*\[\]]/g, "_");
}
export function exportToExcel(originalWorkbook, results, columns) {
    // @ts-ignore
    const wb = XLSX.utils.book_new();
    for (const sheetName of originalWorkbook.SheetNames) {
        // @ts-ignore
        XLSX.utils.book_append_sheet(wb, originalWorkbook.Sheets[sheetName], sheetName);
    }
    for (const [scenario, testCases] of results) {
        // @ts-ignore
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(testCases, { header: columns }), safeSheetName(scenario.id));
    }
    // @ts-ignore
    XLSX.writeFile(wb, "test_scenarios_output.xlsx");
}
