import { SandboxToUI, FigmaData, ScenarioItem, ColumnSchema, ExampleRow, GeneratedTestCase, FigmaInputType, GeminiError } from "./types";
import { parseExcelFile } from "./excelParser";
import { processSequentially } from "./geminiClient";
import { exportToExcel } from "./excelWriter";
import { filterFigmaData } from "./figmaParser";

let figmaData: FigmaData | null = null;
let parsedColumns: ColumnSchema = [];
let parsedExamples: ExampleRow[] = [];
let parsedScenarios: ScenarioItem[] = [];
let originalWorkbook: { SheetNames: string[]; Sheets: Record<string, unknown> } | null = null;
const results = new Map<ScenarioItem, GeneratedTestCase[]>();

const el = (id: string) => document.getElementById(id) as HTMLElement;
const showError = (msg: string) => {
  const banner = el("error-banner");
  banner.textContent = msg;
  banner.classList.remove("hidden");
};
const hideError = () => el("error-banner").classList.add("hidden");

const logDebug = (msg: string) => {
  console.log(msg);
  const panel = el("debug-panel");
  if (panel) {
    const time = new Date().toLocaleTimeString();
    panel.innerHTML += `<div><span style="color:#888">[${time}]</span> ${msg}</div>`;
    panel.scrollTop = panel.scrollHeight;
  }
};

// Figma(code.ts) 로부터 메시지 수신
window.onmessage = (event) => {
  const msg = event.data.pluginMessage as SandboxToUI;
  if (!msg) return;

  if (msg.type === "ERROR") {
    showError(msg.message);
  } else if (msg.type === "API_KEY_LOADED") {
    (el("api-key") as HTMLInputElement).value = msg.key;
    checkStep1Validity();
  } else if (msg.type === "FIGMA_DATA") {
    figmaData = msg.payload || null;
    if (figmaData && figmaData.screens.length > 0) {
      hideError();
      el("screen-info").innerHTML = `선택된 Figma 화면 (${figmaData.screens.length}개)`;
    } else {
      el("screen-info").innerHTML = "선택된 화면 없음";
    }
    checkStep1Validity();
  }
};

// 초기화
parent.postMessage({ pluginMessage: { type: "READY" } }, "*");

const fileInput = el("excel-file") as HTMLInputElement;
const apiKeyInput = el("api-key") as HTMLInputElement;
const btnNext = el("btn-next") as HTMLButtonElement;
const btnStart = el("btn-start") as HTMLButtonElement;

const checkStep1Validity = () => {
  const hasFile = fileInput.files && fileInput.files.length > 0;
  const hasKey = apiKeyInput.value.trim().length > 0;
  const hasScreens = figmaData !== null && figmaData.screens.length > 0;
  
  logDebug(`상태 업데이트 - 엑셀:${hasFile}, 키:${hasKey}, 화면:${hasScreens}`);
  
  const missing = [];
  if (!hasFile) missing.push("엑셀");
  if (!hasKey) missing.push("API키");
  if (!hasScreens) missing.push("화면");
  
  if (missing.length > 0) {
    btnNext.textContent = `${missing.join(", ")} 필요`;
    btnNext.style.opacity = "0.6"; // 잠긴 것처럼 보이게 투명도 조절
  } else {
    btnNext.textContent = "🚀 다음 단계로";
    btnNext.style.opacity = "1";
  }
};

fileInput.addEventListener("change", checkStep1Validity);
apiKeyInput.addEventListener("input", checkStep1Validity);
apiKeyInput.addEventListener("change", checkStep1Validity);

el("btn-save-key").addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "SAVE_KEY", key: apiKeyInput.value } }, "*");
  alert("저장되었습니다.");
});

btnNext.onclick = async () => {
  logDebug("1. 버튼 클릭됨! 검사 시작");
  alert("다음 버튼이 정상적으로 눌렸습니다! 엑셀 분석을 시작합니다.");
  hideError();
  
  // 클릭하는 순간에 실시간으로 강제 검사
  const hasFile = fileInput.files && fileInput.files.length > 0;
  const hasKey = apiKeyInput.value.trim().length > 0;
  const hasScreens = figmaData !== null && figmaData.screens.length > 0;
  
  logDebug(`2. 변수 확인 - 엑셀:${hasFile}, 키:${hasKey}, 화면:${hasScreens}`);

  if (!hasFile || !hasKey || !hasScreens) {
    const missingInfo = [];
    if (!hasFile) missingInfo.push("엑셀 파일");
    if (!hasKey) missingInfo.push("API Key");
    if (!hasScreens) missingInfo.push("Figma 화면(Frame)");
    logDebug("3. 검사 실패 (항목 누락): " + missingInfo.join(", "));
    return showError(`진행할 수 없습니다. 다음 항목을 확인해 주세요: [${missingInfo.join(", ")}]`);
  }

  const file = fileInput.files?.[0];
  if (!file) return;
  
  // --- 로딩 UI 시작 ---
  logDebug("4. 로딩 스피너 렌더링 시도");
  const originalText = btnNext.textContent || "다음 →";
  btnNext.innerHTML = '<span class="spinner"></span> 엑셀 분석 중...';
  btnNext.disabled = true;
  btnNext.style.opacity = "1";
  
  // 브라우저가 렌더링할 수 있도록 100ms 강제 대기
  await new Promise(resolve => setTimeout(resolve, 100));
  logDebug("5. 엑셀 파일 분석(Parsing) 진입");

  try {
    // 과거 성공했던 FileReader + Uint8Array 방식 복원
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (evt) => resolve(new Uint8Array(evt.target?.result as ArrayBuffer));
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
    const parsed = parseExcelFile(data);
    
    logDebug(`6. 파싱 성공! 시나리오 ${parsed.scenarios.length}개 발견`);
    logDebug(`   -> 적용된 템플릿 컬럼 수: ${parsed.columns.length}개`);

    if (parsed.scenarios.length === 0) {
      btnNext.textContent = originalText;
      btnNext.disabled = false;
      logDebug("에러: 시나리오 목록을 찾을 수 없음");
      showError("시나리오 목록 시트를 찾을 수 없거나 데이터가 없습니다.");
      return;
    }
    parsedColumns = parsed.columns;
    parsedExamples = parsed.exampleRows;
    parsedScenarios = parsed.scenarios;
    originalWorkbook = parsed.wb as { SheetNames: string[]; Sheets: Record<string, unknown> };
    
    logDebug("7. 화면 전환(Step 2) 성공!");
    renderScenarios();
    el("step-1").classList.add("hidden");
    el("step-2").classList.remove("hidden");
    
    // 만약 이전 단계로 돌아올 때를 대비해 버튼 원상복구
    btnNext.textContent = originalText;
    btnNext.disabled = false;
  } catch (err) {
    console.error(err);
    logDebug(`[치명적 에러 발생] ${String(err)}`);
    btnNext.textContent = originalText;
    btnNext.disabled = false;
    showError("엑셀 파일을 파싱하는 중 오류가 발생했습니다.");
  }
};

const renderScenarios = () => {
  const tbody = el("scenario-list");
  tbody.innerHTML = "";
  parsedScenarios.forEach((sc, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="scenario-cb" value="${i}" checked></td>
      <td>${sc.id}</td>
      <td>
        <div>${sc.name}</div>
        <div class="desc">${sc.description}</div>
      </td>
    `;
    tbody.appendChild(tr);
  });
};

el("btn-select-all").addEventListener("click", () => {
  document.querySelectorAll(".scenario-cb").forEach(cb => (cb as HTMLInputElement).checked = true);
});

el("btn-deselect-all").addEventListener("click", () => {
  document.querySelectorAll(".scenario-cb").forEach(cb => (cb as HTMLInputElement).checked = false);
});

el("btn-prev-1").addEventListener("click", () => { 
  el("step-2").classList.add("hidden"); 
  el("step-1").classList.remove("hidden"); 
});

btnStart.addEventListener("click", async () => {
  hideError();
  const selectedIndices = Array.from(document.querySelectorAll(".scenario-cb:checked")).map(cb => parseInt((cb as HTMLInputElement).value));
  if (selectedIndices.length === 0) return showError("최소 1개의 시나리오를 선택하세요.");
  
  const selectedScenarios = selectedIndices.map(i => parsedScenarios[i]);
  const inputType = (document.querySelector('input[name="figma-type"]:checked') as HTMLInputElement).value as FigmaInputType;
  const apiKey = apiKeyInput.value.trim();
  
  const filteredData = filterFigmaData(figmaData!, inputType);

  el("step-2").classList.add("hidden");
  el("step-3").classList.remove("hidden");
  
  const progressList = el("progress-list");
  progressList.innerHTML = selectedScenarios.map(sc => `<li id="prog-${sc.id}">─ ${sc.id}: 대기 중</li>`).join("");

  results.clear();

  try {
    await processSequentially(
      selectedScenarios, filteredData.screens, filteredData.flows, parsedColumns, parsedExamples, inputType, apiKey,
      (scenarioId, data) => {
        results.set(selectedScenarios.find(s => s.id === scenarioId)!, data);
        el(`prog-${scenarioId}`).innerHTML = `✓ ${scenarioId}: 완료 (${data.length}개 생성)`;
      },
      (scenarioId, msg) => {
        el(`prog-${scenarioId}`).innerHTML = `⟳ ${scenarioId}: ${msg}`;
      }
    );
  } catch (err: unknown) {
    const errorMsgs: Record<string, string> = {
      NETWORK_ERROR: "네트워크 오류 — 인터넷 연결을 확인해 주세요.",
      TIMEOUT: "시간 초과 — 요청이 60초를 초과했습니다. 잠시 후 다시 시도해 주세요.",
      API_KEY_INVALID: "API 키 오류 — Gemini API Key가 유효하지 않습니다. 키를 확인해 주세요.",
      RATE_LIMIT: "요청 한도 초과 (429) — 잠시 후 자동으로 재시도합니다.",
      SERVER_ERROR: "Gemini 서버 오류 — Google 서버에 일시적인 문제가 있습니다.",
      OUTPUT_TOO_LONG: "출력 토큰 초과 — 화면이 너무 많습니다.",
      PARSE_ERROR: "응답 파싱 오류 — 올바른 JSON 형식이 아닙니다."
    };
    if (err instanceof GeminiError) {
      showError(errorMsgs[err.errorType] || err.message);
    } else {
      showError("알 수 없는 오류가 발생했습니다.");
    }
  } finally {
    (el("btn-download") as HTMLButtonElement).disabled = false;
  }
});

el("btn-download").addEventListener("click", () => {
  if (originalWorkbook) {
    exportToExcel(originalWorkbook, results, parsedColumns);
  }
});