import { ScreenNode, FlowEdge, ScenarioItem, ColumnSchema, ExampleRow, GeneratedTestCase, GeminiError, GeminiErrorType, FigmaInputType } from "./types";
import { buildPrompt } from "./promptBuilder";

type ChunkContext = { lastNo: number; lastId: string; };

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function classifyError(err: unknown, httpStatus?: number): GeminiErrorType {
  if (err instanceof DOMException && err.name === "AbortError") return "TIMEOUT";
  if (err instanceof TypeError && err.message.includes("fetch")) return "NETWORK_ERROR";
  if (httpStatus === 401 || httpStatus === 403) return "API_KEY_INVALID";
  if (httpStatus === 429) return "RATE_LIMIT";
  if (httpStatus === 500 || httpStatus === 503) return "SERVER_ERROR";
  return "UNKNOWN";
}

function splitMultiStepRows(rows: GeneratedTestCase[], columns: ColumnSchema): GeneratedTestCase[] {
  // 어떤 형태의 숫자 넘버링(1. 2) [3] Step 4 등)이든 완벽하게 찢어발겨서 없애버리는 강력한 정규식
  const stripNumbering = (str: string) => str.replace(/^["']/, '').replace(/["']$/, '').trim().replace(/^(?:스텝\s*|step\s*|단계\s*)?\d+[\.\)\]\>:-]?\s*/i, '').replace(/^[-*•]\s*/, '').trim();

  const out: GeneratedTestCase[] = [];
  for (const row of rows) {
    let maxLines = 1;
    const splitCols: Record<string, string[]> = {};
    
    // 각 컬럼의 데이터를 줄바꿈(\n) 기준으로 강제 분할
    for (const col of columns) {
      const val = String(row[col] || "");
      const isStepOrResult = col.includes("스텝") || col.toLowerCase().includes("step") || col.includes("결과") || col.toLowerCase().includes("result");
      
      if (isStepOrResult) {
        // 스텝과 결과는 줄바꿈 기준으로 분할 (AI가 뭉쳐놓은 경우 대비)
        const lines = val.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
        splitCols[col] = lines;
        if (lines.length > maxLines) {
          maxLines = lines.length;
        }
      } else {
        // 전제조건, 입력 데이터 등은 줄바꿈이 있어도 절대 찢지 않고 한 셀(배열 길이 1)로 유지
        splitCols[col] = [val.trim()];
      }
    }

    if (maxLines > 1) {
      // AI가 뭉쳐놓은 데이터를 maxLines 개수만큼의 독립된 행(Row)으로 찢어버림
      for (let i = 0; i < maxLines; i++) {
        const newRow: GeneratedTestCase = { ...row };
        for (const col of columns) {
          const isIdOrNameOrCond = col.toUpperCase().includes("ID") || col.includes("명") || col.toLowerCase().includes("name") || col.includes("전제") || col.includes("조건");
          const isStepOrResult = col.includes("스텝") || col.toLowerCase().includes("step") || col.includes("결과") || col.toLowerCase().includes("result");
          
          if (splitCols[col].length > 1) {
            let lineVal = splitCols[col][i] || "";
            newRow[col] = isStepOrResult ? stripNumbering(lineVal) : lineVal;
          } else if (splitCols[col].length === 1) {
             const lineVal = splitCols[col][0];
             // 테스트케이스 ID, 이름 등은 모든 행에 똑같이 반복 부여 (그래야 나중에 같은 케이스로 묶임)
             newRow[col] = (isIdOrNameOrCond || i === 0) ? (isStepOrResult ? stripNumbering(lineVal) : lineVal) : "";
          } else {
             newRow[col] = "";
          }
        }
        out.push(newRow);
      }
    } else {
      // 한 줄짜리 데이터라도 앞에 붙은 넘버링 쓰레기값("1. ") 청소
      const newRow: GeneratedTestCase = { ...row };
      for (const col of columns) {
        const isStepOrResult = col.includes("스텝") || col.toLowerCase().includes("step") || col.includes("결과") || col.toLowerCase().includes("result");
        if (newRow[col]) {
           const val = String(newRow[col]).trim();
           newRow[col] = isStepOrResult ? stripNumbering(val) : val;
        }
      }
      out.push(newRow);
    }
  }
  return out;
}

async function callGeminiAndParse(
  screens: ScreenNode[], flows: FlowEdge[], scenario: ScenarioItem, columns: ColumnSchema,
  examples: ExampleRow[], inputTypeHint: FigmaInputType, apiKey: string, context?: ChunkContext
): Promise<{ data: GeneratedTestCase[], truncated: boolean }> {
  
  let prompt = buildPrompt(inputTypeHint, scenario, screens, flows, columns, examples);
  
  if (context) {
    prompt += `\n\n## Continuation Context (IMPORTANT):\nThis is a continuation. The previous chunk already generated test cases.\n- Last NO assigned: ${context.lastNo}\n- Last Test Case ID assigned: ${context.lastId}\n\nRules for this chunk:\n- Start NO from ${context.lastNo + 1}\n- Continue the Test Case ID sequence after "${context.lastId}"\n- Do NOT restart numbering from 1 or regenerate IDs from the beginning`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  let res: Response;
  
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 65536, responseMimeType: "application/json" }
      })
    });
  } catch (err) {
    clearTimeout(timeoutId);
    throw new GeminiError(classifyError(err), "");
  }
  clearTimeout(timeoutId);

  if (!res.ok) throw new GeminiError(classifyError(null, res.status), `HTTP ${res.status}`);

  const responseJson = await res.json();
  const truncated = responseJson?.candidates?.[0]?.finishReason === "MAX_TOKENS";
  const raw = responseJson.candidates[0].content.parts[0].text;
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: Record<string, string>[] = [];
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new GeminiError("PARSE_ERROR", "");
  }

  const validated = parsed.map(row => {
    const result: Record<string, string> = {};
    for (const col of columns) result[col] = row[col] ?? "";
    return result;
  });

  // AI가 응답한 직후에 후처리기를 돌려서 뭉친 셀들을 모조리 행으로 찢음
  const splitted = splitMultiStepRows(validated, columns);

  return { data: splitted, truncated };
}

function extractLastContext(rows: GeneratedTestCase[], columns: ColumnSchema): ChunkContext {
  if (rows.length === 0) return { lastNo: 0, lastId: "" };
  const last = rows[rows.length - 1];
  const noCol = columns.find((c: string) => c.toUpperCase() === "NO") ?? "NO";
  const lastNo = parseInt(last[noCol] ?? "0", 10) || rows.length;
  const idCol = columns.find((c: string) => c.includes("케이스 ID") || c.includes("케이스ID") || c.toLowerCase().includes("testcase id") || c.toLowerCase() === "id") ?? "";
  const lastId = idCol ? (last[idCol] ?? "") : "";

  return { lastNo, lastId };
}

function detectIdPattern(rows: GeneratedTestCase[], idCol: string) {
  const sample = rows.find(r => r[idCol])?.[idCol] ?? "";
  if (!sample) return null;
  const match = sample.match(/^(.*?)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], digits: match[2].length };
}

function normalizeIds(rows: GeneratedTestCase[], columns: ColumnSchema, scenario: ScenarioItem, startNo: number = 1): GeneratedTestCase[] {
  const noCol = columns.find((c: string) => c.toUpperCase() === "NO" || c === "순번" || c === "번호");
  const idCol = columns.find((c: string) => c.includes("케이스 ID") || c.includes("케이스ID") || c.toLowerCase().includes("testcase id"));
  const nameCol = columns.find((c: string) => c.includes("케이스 명") || c.includes("케이스명") || c.toLowerCase().includes("name"));
  
  let prefix = `${scenario.id}-`;
  let digits = 3; // 기본은 001, 002 형태
  
  if (idCol) {
    const sample = rows.find(r => r[idCol])?.[idCol] ?? "";
    const match = sample.match(/^(.*?)(\d+)$/);
    if (match && match[1].includes(scenario.id)) {
      prefix = match[1];
      digits = match[2].length;
    }
  }

  let currentTcNumber = 0;
  let prevName = "";
  let prevRawId = "";

  return rows.map((row, i) => {
    const no = startNo + i; // NO는 무조건 모든 행마다 증가
    const updated = { ...row };
    
    const currentName = nameCol ? String(row[nameCol] || "").trim() : "";
    const currentRawId = idCol ? String(row[idCol] || "").trim() : "";

    let isNewTestCase = false;
    if (i === 0) {
      isNewTestCase = true;
    } else {
      if (currentRawId !== "" && currentRawId !== prevRawId) {
        isNewTestCase = true; // AI가 명시적으로 새로운 ID를 줌
      } else if (currentRawId === "" && currentName !== "" && currentName !== prevName) {
        isNewTestCase = true; // ID는 비웠지만 이름이 바뀜
      }
    }

    if (isNewTestCase) {
      currentTcNumber++;
      if (currentRawId) prevRawId = currentRawId;
      if (currentName) prevName = currentName;
    } else {
      if (currentName) prevName = currentName; // 같은 케이스 내에서도 이름이 바뀔 수 있으므로 업데이트
    }

    if (noCol) updated[noCol] = String(no);
    if (idCol) updated[idCol] = `${prefix}${String(currentTcNumber).padStart(digits, "0")}`;
    if (nameCol && !isNewTestCase && currentName === "") updated[nameCol] = prevName;

    return updated;
  });
}

function deduplicateByStep(rows: GeneratedTestCase[]): GeneratedTestCase[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function callWithChunkFallback(
  screens: ScreenNode[], flows: FlowEdge[], scenario: ScenarioItem, columns: ColumnSchema,
  examples: ExampleRow[], inputType: FigmaInputType, apiKey: string, 
  onProgress: (msg: string) => void
): Promise<GeneratedTestCase[]> {
  
  let result;
  try {
    result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey);
  } catch (err: unknown) {
    if (err instanceof GeminiError && err.errorType === "PARSE_ERROR") {
       // 1회 재시도 (재시도 실패시 빈 배열 반환 후 throw를 호출자에게 넘기거나 무시)
       try { result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey); }
       catch { return []; }
    } else { throw err; }
  }

  if (!result?.truncated) return normalizeIds(result!.data, columns, scenario, 1);

  onProgress("출력 토큰 초과 감지 — 화면을 나눠 순차 재시도 중...");
  const half = Math.ceil(screens.length / 2);
  const chunkA = screens.slice(0, half);
  const chunkB = screens.slice(half);

  const resultA = await callGeminiAndParse(chunkA, flows, scenario, columns, examples, inputType, apiKey);
  const contextForB = extractLastContext(resultA.data, columns);
  const resultB = await callGeminiAndParse(chunkB, flows, scenario, columns, examples, inputType, apiKey, contextForB);

  if (!resultA.truncated && !resultB.truncated) {
    const merged = [...resultA.data, ...resultB.data];
    return normalizeIds(deduplicateByStep(merged), columns, scenario, 1);
  }

  onProgress("여전히 초과 — annotation을 압축하여 재시도 중...");
  const compressedScreens = screens.map(s => ({
    ...s,
    annotations: s.annotations.map((a: string) => a.slice(0, 50)),
    textContent: s.textContent?.slice(0, 500)
  }));

  const compressedA = compressedScreens.slice(0, half);
  const compressedB = compressedScreens.slice(half);

  const resultCA = await callGeminiAndParse(compressedA, flows, scenario, columns, examples, inputType, apiKey);
  const contextForCB = extractLastContext(resultCA.data, columns);
  const resultCB = await callGeminiAndParse(compressedB, flows, scenario, columns, examples, inputType, apiKey, contextForCB);

  if (!resultCA.truncated && !resultCB.truncated) {
    const merged = [...resultCA.data, ...resultCB.data];
    return normalizeIds(deduplicateByStep(merged), columns, scenario, 1);
  }

  throw new GeminiError("OUTPUT_TOO_LONG", "선택하신 화면 수가 너무 많습니다. Figma에서 화면을 절반으로 나눠 두 번 실행해 주세요.");
}

export async function processSequentially(
  scenarios: ScenarioItem[], screens: ScreenNode[], flows: FlowEdge[], columns: ColumnSchema,
  examples: ExampleRow[], inputType: FigmaInputType, apiKey: string,
  onScenarioComplete: (scenarioId: string, data: GeneratedTestCase[]) => void,
  onProgressMessage: (scenarioId: string, msg: string) => void
) {
  for (const scenario of scenarios) {
    const cases = await callWithChunkFallback(screens, flows, scenario, columns, examples, inputType, apiKey, (msg) => onProgressMessage(scenario.id, msg));
    onScenarioComplete(scenario.id, cases);
    await delay(4000); // 4초 Rate Limit 대기
  }
}