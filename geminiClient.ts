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

  return { data: validated, truncated };
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

  return rows.map((row, i) => {
    const no = startNo + i;
    const updated = { ...row };
    
    if (noCol) updated[noCol] = String(no);
    if (idCol) updated[idCol] = `${prefix}${String(no).padStart(digits, "0")}`;
    return updated;
  });
}

function deduplicateByStep(rows: GeneratedTestCase[]): GeneratedTestCase[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = row["테스트 스텝"] || row["테스트케이스 명"] || JSON.stringify(row);
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