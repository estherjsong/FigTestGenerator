import { GeminiError } from "./types";
import { buildPrompt } from "./promptBuilder";
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function classifyError(err, httpStatus) {
    if (err instanceof DOMException && err.name === "AbortError")
        return "TIMEOUT";
    if (err instanceof TypeError && err.message.includes("fetch"))
        return "NETWORK_ERROR";
    if (httpStatus === 401 || httpStatus === 403)
        return "API_KEY_INVALID";
    if (httpStatus === 429)
        return "RATE_LIMIT";
    if (httpStatus === 500 || httpStatus === 503)
        return "SERVER_ERROR";
    return "UNKNOWN";
}
async function callGeminiAndParse(screens, flows, scenario, columns, examples, inputTypeHint, apiKey, context) {
    let prompt = buildPrompt(inputTypeHint, scenario, screens, flows, columns, examples);
    if (context) {
        prompt += `\n\n## Continuation Context (IMPORTANT):\nThis is a continuation. The previous chunk already generated test cases.\n- Last NO assigned: ${context.lastNo}\n- Last Test Case ID assigned: ${context.lastId}\n\nRules for this chunk:\n- Start NO from ${context.lastNo + 1}\n- Continue the Test Case ID sequence after "${context.lastId}"\n- Do NOT restart numbering from 1 or regenerate IDs from the beginning`;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    let res;
    try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 65536 }
            })
        });
    }
    catch (err) {
        clearTimeout(timeoutId);
        throw new GeminiError(classifyError(err), "");
    }
    clearTimeout(timeoutId);
    if (!res.ok)
        throw new GeminiError(classifyError(null, res.status), `HTTP ${res.status}`);
    const responseJson = await res.json();
    const truncated = responseJson?.candidates?.[0]?.finishReason === "MAX_TOKENS";
    const raw = responseJson.candidates[0].content.parts[0].text;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let parsed = [];
    try {
        parsed = JSON.parse(cleaned);
    }
    catch {
        throw new GeminiError("PARSE_ERROR", "");
    }
    const validated = parsed.map(row => {
        const result = {};
        for (const col of columns)
            result[col] = row[col] ?? "";
        return result;
    });
    return { data: validated, truncated };
}
function extractLastContext(rows, columns) {
    if (rows.length === 0)
        return { lastNo: 0, lastId: "" };
    const last = rows[rows.length - 1];
    const noCol = columns.find((c) => c.toUpperCase() === "NO") ?? "NO";
    const lastNo = parseInt(last[noCol] ?? "0", 10) || rows.length;
    const idCol = columns.find((c) => c.includes("케이스 ID") || c.includes("케이스ID") || c.toLowerCase().includes("testcase id") || c.toLowerCase() === "id") ?? "";
    const lastId = idCol ? (last[idCol] ?? "") : "";
    return { lastNo, lastId };
}
function detectIdPattern(rows, idCol) {
    const sample = rows.find(r => r[idCol])?.[idCol] ?? "";
    if (!sample)
        return null;
    const match = sample.match(/^(.*?)(\d+)$/);
    if (!match)
        return null;
    return { prefix: match[1], digits: match[2].length };
}
function normalizeIds(rows, columns, startNo = 1) {
    const noCol = columns.find((c) => c.toUpperCase() === "NO");
    const idCol = columns.find((c) => c.includes("케이스 ID") || c.includes("케이스ID") || c.toLowerCase().includes("testcase id"));
    const idPattern = idCol ? detectIdPattern(rows, idCol) : null;
    return rows.map((row, i) => {
        const no = startNo + i;
        const updated = { ...row };
        if (noCol)
            updated[noCol] = String(no);
        if (idCol && idPattern)
            updated[idCol] = `${idPattern.prefix}${String(no).padStart(idPattern.digits, "0")}`;
        return updated;
    });
}
function deduplicateByStep(rows) {
    const seen = new Set();
    return rows.filter(row => {
        const key = row["테스트 스텝"] || row["테스트케이스 명"] || JSON.stringify(row);
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
export async function callWithChunkFallback(screens, flows, scenario, columns, examples, inputType, apiKey, onProgress) {
    let result;
    try {
        result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey);
    }
    catch (err) {
        if (err instanceof GeminiError && err.errorType === "PARSE_ERROR") {
            // 1회 재시도 (재시도 실패시 빈 배열 반환 후 throw를 호출자에게 넘기거나 무시)
            try {
                result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey);
            }
            catch {
                return [];
            }
        }
        else {
            throw err;
        }
    }
    if (!result?.truncated)
        return normalizeIds(result.data, columns, 1);
    onProgress("출력 토큰 초과 감지 — 화면을 나눠 순차 재시도 중...");
    const half = Math.ceil(screens.length / 2);
    const chunkA = screens.slice(0, half);
    const chunkB = screens.slice(half);
    const resultA = await callGeminiAndParse(chunkA, flows, scenario, columns, examples, inputType, apiKey);
    const contextForB = extractLastContext(resultA.data, columns);
    const resultB = await callGeminiAndParse(chunkB, flows, scenario, columns, examples, inputType, apiKey, contextForB);
    if (!resultA.truncated && !resultB.truncated) {
        const merged = [...resultA.data, ...resultB.data];
        return normalizeIds(deduplicateByStep(merged), columns, 1);
    }
    onProgress("여전히 초과 — annotation을 압축하여 재시도 중...");
    const compressedScreens = screens.map(s => ({
        ...s,
        annotations: s.annotations.map((a) => a.slice(0, 50)),
        textContent: s.textContent?.slice(0, 500)
    }));
    const compressedA = compressedScreens.slice(0, half);
    const compressedB = compressedScreens.slice(half);
    const resultCA = await callGeminiAndParse(compressedA, flows, scenario, columns, examples, inputType, apiKey);
    const contextForCB = extractLastContext(resultCA.data, columns);
    const resultCB = await callGeminiAndParse(compressedB, flows, scenario, columns, examples, inputType, apiKey, contextForCB);
    if (!resultCA.truncated && !resultCB.truncated) {
        const merged = [...resultCA.data, ...resultCB.data];
        return normalizeIds(deduplicateByStep(merged), columns, 1);
    }
    throw new GeminiError("OUTPUT_TOO_LONG", "선택하신 화면 수가 너무 많습니다. Figma에서 화면을 절반으로 나눠 두 번 실행해 주세요.");
}
export async function processSequentially(scenarios, screens, flows, columns, examples, inputType, apiKey, onScenarioComplete, onProgressMessage) {
    for (const scenario of scenarios) {
        const cases = await callWithChunkFallback(screens, flows, scenario, columns, examples, inputType, apiKey, (msg) => onProgressMessage(scenario.id, msg));
        onScenarioComplete(scenario.id, cases);
        await delay(4000); // 4초 Rate Limit 대기
    }
}
