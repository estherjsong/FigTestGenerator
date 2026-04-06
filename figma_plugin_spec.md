# Figma Plugin — 테스트 시나리오 자동 생성 툴
## Vibe Coding 명세서 (Complete)

---

## 1. 프로젝트 한 줄 요약

> Figma에서 화면을 선택하고 Excel 템플릿을 업로드하면, AI(Gemini)가 테스트케이스를 자동 생성하고 시나리오 ID별로 Excel 시트를 만들어주는 Figma 플러그인

---

## 2. 기술 스택

| 항목 | 선택 |
|---|---|
| 플랫폼 | Figma Plugin (Sandbox + UI iframe 구조) |
| UI 프레임워크 | HTML / CSS / Vanilla JS |
| Excel 처리 | SheetJS (`xlsx` 라이브러리) |
| AI | Gemini API (`gemini-2.5-flash-lite`, Google AI Studio 무료 티어) |
| 언어 | TypeScript |

---

## 3. 파일 구조

```
figma-plugin/
├── manifest.json
├── code.ts                  # Figma sandbox: 노드 수집, postMessage 처리
├── ui.html                  # Plugin UI 진입점
├── ui.ts                    # UI 로직 총괄
└── utils/
    ├── figmaParser.ts       # Figma 노드 → FigmaData 변환
    ├── excelParser.ts       # Excel → 컬럼·예시·시나리오 목록 추출
    ├── promptBuilder.ts     # 동적 프롬프트 생성
    ├── geminiClient.ts      # Gemini API 호출 및 응답 파싱
    └── excelWriter.ts       # 테스트케이스 결과 → Excel 시트 생성
```

---

## 4. manifest.json 필수 설정

Gemini API 호출을 위해 `networkAccess` 권한을 반드시 명시해야 한다.
없으면 외부 API 호출 자체가 Figma sandbox에 의해 차단된다.

```json
{
  "name": "Test Scenario Generator",
  "id": "your-plugin-id",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "networkAccess": {
    "allowedDomains": [
      "https://generativelanguage.googleapis.com"
    ]
  }
}
```

---

## 5. Sandbox ↔ UI 메시지 통신 구조

Figma Plugin은 Sandbox(`code.ts`)와 UI iframe(`ui.ts`)이 분리되어 있으며,
`postMessage`로만 통신한다. 아래 타입을 기준으로 구현한다.

```ts
// ── Sandbox → UI ──────────────────────────────────────────
type SandboxToUI =
  | { type: "FIGMA_DATA"; payload: FigmaData }
  | { type: "ERROR"; message: string };

// ── UI → Sandbox ──────────────────────────────────────────
type UIToSandbox =
  | { type: "READY" }          // UI 로드 완료 신호
  | { type: "CLOSE" };         // 플러그인 닫기

// code.ts 송신 예시
figma.ui.postMessage({ type: "FIGMA_DATA", payload: figmaData });

// ui.ts 수신 예시
window.onmessage = (event) => {
  const msg: SandboxToUI = event.data.pluginMessage;
  if (msg.type === "FIGMA_DATA") { ... }
};

// ui.ts 송신 예시
parent.postMessage({ pluginMessage: { type: "READY" } }, "*");
```

---

## 6. 전체 처리 플로우

```
[Step 1] Figma 화면 선택 + 플러그인 실행
    ↓
[Step 2] Plugin UI 표시
    ├── Excel 파일 업로드
    ├── Figma 화면 유형 선택
    └── Gemini API Key 입력
    ↓
[Step 3] Excel 분석
    ├── 3-1. 테스트케이스 컬럼 구조 추출
    ├── 3-2. 테스트케이스 예시 추출
    └── 3-3. 시나리오 목록 추출 (ID + 시나리오명 + 설명)
    ↓
[Step 4] 시나리오 선택 UI 표시
    (ID / 시나리오명 / 설명 테이블 + 체크박스)
    ↓
[Step 5] Figma 데이터 파싱 (유형별 전략)
    ↓
[Step 6] 시나리오 ID별 순차 처리
    ├── 프롬프트 동적 생성
    ├── Gemini API 호출
    └── JSON 검증 및 컬럼 보정
    ↓
[Step 7] Excel 파일 생성 및 다운로드
    (시나리오 ID 1개 = 시트 1개)
```

---

## 7. Step 1 — Figma 노드 수집 (`code.ts`)

플러그인 실행 시 `figma.currentPage.selection`에서 선택된 노드를 수집한다.

**수집 대상:**
- `type === "FRAME"` → 화면(Screen)으로 인식
- Frame 자식 중 `type === "TEXT"` → Annotation으로 수집
- `type === "CONNECTOR"` → 화면 간 흐름(Flow)으로 수집 (from / to frameId 추출)

```ts
type FigmaData = {
  screens: {
    id: string;
    name: string;
    type: "ui_screen" | "document_page"; // 혼합형일 때 자동 분류
    annotations: string[];
    textContent?: string; // 장표형일 때 계층적 텍스트 (fontSize 내림차순 구조화)
  }[];
  flows: {
    from: string; // screen name
    to: string;   // screen name
  }[];
};
```

**선택된 Frame이 없을 경우:** 플러그인 실행 즉시 에러 메시지를 표시하고 종료한다.

```ts
if (figma.currentPage.selection.length === 0) {
  figma.ui.postMessage({ type: "ERROR", message: "Figma에서 Frame을 선택 후 실행하세요." });
  return;
}
```

---

## 8. Step 2 — Plugin UI 구성

### 8-1. Step 1 화면: Excel 업로드 + 설정

```
┌─────────────────────────────────────────────┐
│  Excel 파일 업로드                            │
│  [ 파일을 드래그하거나 클릭하여 선택 (.xlsx) ]  │
│                                              │
│  Figma 화면 유형                              │
│  ● 모바일/앱 화면 + 플로우                    │
│    (Frame, Connector, Annotation)            │
│  ○ 기획 장표 (문서형)                         │
│    (표, 텍스트, 정책 설명 등)                  │
│  ○ 혼합형 (두 가지 모두 포함)                  │
│                                              │
│  Gemini API Key                              │
│  [ ••••••••••••••••••••••  ] [저장]          │
│                                              │
│                            [다음 →]          │
└─────────────────────────────────────────────┘
```

### 8-2. Step 2 화면: 시나리오 선택

```
┌─────────────────────────────────────────────────────────────────┐
│  선택된 Figma 화면 (3개)                                          │
│  [로그인 화면 · ui_screen]  [홈 화면 · ui_screen]  [설정 · doc]   │
│                                                                  │
│  생성할 시나리오를 선택하세요          [전체 선택]  [전체 해제]      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ☑  SCN-001  로그인 플로우      아이디/비밀번호 로그인 및 예외  │   │
│  │ ☑  SCN-002  회원가입           신규 사용자 가입 전체 플로우    │   │
│  │ □   SCN-003  비밀번호 찾기     이메일 인증 기반 재설정         │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│                                            [← 이전]  [생성 시작]  │
└─────────────────────────────────────────────────────────────────┘
```

- 각 행: 체크박스 + ID + 시나리오명 + 설명(muted 텍스트)
- 설명이 길면 말줄임 처리 (`text-overflow: ellipsis`)
- 선택된 Figma 화면 목록은 타입 배지(ui_screen / document_page)와 함께 표시

### 8-3. Step 3 화면: 진행 상태 및 완료

```
┌─────────────────────────────────────────────┐
│  테스트케이스 생성 중...                       │
│                                              │
│  ✓ SCN-001  완료 (8개 생성)                   │
│  ⟳ SCN-002  처리 중...                       │
│  ─ SCN-003  대기 중                          │
│                                              │
│  ━━━━━━━━━━━━━━━━━━━━━━ 1 / 3               │
│                                              │
│                      [Excel 다운로드] (비활성) │
└─────────────────────────────────────────────┘
```

- 모든 시나리오 완료 시 [Excel 다운로드] 버튼 활성화
- 실패한 시나리오는 `✕ SCN-XXX  오류: [메시지]` 형태로 표시

---

## 9. Step 3 — Excel 분석 (`excelParser.ts`)

### 9-1. 테스트케이스 컬럼 구조 추출

**탐색 순서:**
1. 시트명에 `"템플릿"` / `"template"` / `"케이스"` 포함 → 해당 시트 사용
2. 없으면 기본 템플릿 사용

해당 시트의 첫 번째 Row를 헤더로 인식해 컬럼 리스트 추출.

```ts
type ColumnSchema = string[];
// 예: ["NO", "테스트케이스 ID", "테스트케이스 명", "테스트 스텝", "입력 데이터", "예상 결과"]
```

**Fallback (컬럼이 없거나 시트가 없을 경우):**

```ts
const DEFAULT_COLUMNS = [
  "NO", "테스트케이스 ID", "테스트케이스 명", "테스트 스텝",
  "테스트 전제(사전조건)", "입력 데이터", "예상 결과",
  "실제 결과", "테스트 결과", "수행자", "수행일자",
  "결함 여부", "결함ID", "참고자료"
];
```

### 9-2. 테스트케이스 예시 추출

- 헤더 Row 다음 Row부터 데이터가 있는 Row를 예시로 수집
- 최대 3개 Row만 수집 (프롬프트 토큰 절약)
- AI 프롬프트에 few-shot example로 포함

```ts
type ExampleRow = { [columnName: string]: string };
```

### 9-3. 시나리오 목록 추출

**탐색 순서:**
1. 시트명에 `"목록"` / `"list"` / `"시나리오"` 포함 → 해당 시트 사용
2. 없으면 두 번째 시트 사용

**추출 필드 및 컬럼명 탐색 우선순위:**

| 필드 | 탐색할 컬럼명 후보 (순서대로) |
|---|---|
| ID | `"시나리오 ID"`, `"ID"`, `"id"`, `"NO"` |
| 시나리오명 | `"시나리오명"`, `"시나리오 명"`, `"이름"`, `"name"`, `"Name"` |
| 설명 | `"설명"`, `"목적"`, `"description"`, `"내용"`, `"비고"` |

```ts
type ScenarioItem = {
  id: string;
  name: string;        // 없으면 ""
  description: string; // 없으면 ""
};
```

- 후보 컬럼명을 순서대로 탐색해 처음 발견된 컬럼 사용
- 해당 컬럼이 없으면 빈 문자열 처리
- 시나리오명과 설명은 선택 UI 표시 및 프롬프트에도 포함

---

## 10. Step 4 — Figma 데이터 파싱 (`figmaParser.ts`)

사용자가 선택한 Figma 화면 유형에 따라 파싱 전략이 달라진다.

### 10-1. 유형별 파싱 전략

| 유형 | 파싱 우선 대상 | 특이사항 |
|---|---|---|
| 모바일/앱 화면 + 플로우 | Frame 이름, Connector, 자식 TEXT 노드 | 기본 전략 |
| 기획 장표 | 모든 TEXT 노드 계층 구조 | fontSize 클수록 상위 헤딩 처리 |
| 혼합형 | 위 두 가지 모두 | Connector 유무로 자동 분류 |

### 10-2. 혼합형 자동 분류 기준

```ts
function classifyFrame(frame: FrameNode): "ui_screen" | "document_page" {
  const hasConnector = figma.currentPage.findAll(
    n => n.type === "CONNECTOR" &&
    (n.connectorStart.endpointNodeId === frame.id ||
     n.connectorEnd.endpointNodeId === frame.id)
  ).length > 0;
  return hasConnector ? "ui_screen" : "document_page";
}
```

### 10-3. 기획 장표 텍스트 수집 전략

- Frame 내 TEXT 노드를 fontSize 내림차순으로 정렬
- 가장 큰 fontSize → H1, 그 다음 → H2, 나머지 → body
- 구조화된 텍스트를 `textContent` 필드에 저장

**토큰 초과 대응:** 수집된 전체 텍스트가 3,000자를 초과하면 앞에서부터 3,000자로 잘라 사용.
잘린 경우 프롬프트에 `[텍스트 일부 생략됨]` 명시.

---

## 11. Step 5 — Gemini API 호출 (`geminiClient.ts`)

### 11-1. Rate Limit 대응 (무료 티어)

Gemini 무료 티어는 분당 15회 제한이 있다.
시나리오 ID별 API 호출은 **순차 처리**하며 호출 간 4초 딜레이를 둔다.

```ts
async function processSequentially(scenarioIds: ScenarioItem[]) {
  for (const scenario of scenarioIds) {
    await callGemini(scenario);
    await delay(4000); // 4초 딜레이
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

### 11-2. 유형별 프롬프트 힌트

```ts
const INPUT_TYPE_HINT: Record<FigmaInputType, string> = {
  flow: `These are mobile/app UI screens connected by user flow arrows.
Each frame represents one screen. Interpret annotations as functional descriptions.`,

  document: `These are planning documents (기획서).
Extract functional requirements, business rules, and user scenarios from the text content.`,

  mixed: `Input contains both UI flow screens and planning document pages.
Screens tagged as "ui_screen" are interactive UI flows.
Screens tagged as "document_page" are planning documents.
Interpret each type accordingly.`
};
```

### 11-3. 동적 프롬프트 생성 (`promptBuilder.ts`)

```
You are a QA engineer.

## Input Type:
{inputTypeHint}

## Scenario Info:
- ID: {scenarioId}
- Name: {scenarioName}
- Description: {scenarioDescription}

## Figma Screen Data:
{JSON.stringify(screens)}

## User Flow:
{JSON.stringify(flows)}

## Excel Column Schema:
{JSON.stringify(columns)}

## Example Test Cases (format reference only):
{JSON.stringify(exampleRows)}

## Task:
Generate 5~10 test cases for this scenario.

## Rules:
- Output MUST be a valid JSON array ONLY. No explanation, no markdown, no code fences.
- Each object MUST use EXACT column names as keys. Never add or rename columns.
- Missing values → use empty string ""
- Scenario ID column (if exists) → fill with "{scenarioId}"
- Focus on: realistic user behavior, step-by-step actions, clear expected results
```

### 11-4. API 호출

`maxOutputTokens`는 항상 최대값으로 설정한다. 그럼에도 초과가 발생할 수 있으며, 이는 별도 로직으로 처리한다(11-6 참고).

```ts
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

async function callGeminiRaw(prompt: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60초 타임아웃

  try {
    const res = await fetch(GEMINI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 65536  // gemini-2.5-flash-lite 최대값
        }
      })
    });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

### 11-5. 에러 분류 및 사용자 메시지

API 호출 실패 원인을 명확히 구분해서 사용자에게 표시한다.

```ts
type GeminiErrorType =
  | "NETWORK_ERROR"      // fetch 자체 실패 (오프라인, DNS 등)
  | "TIMEOUT"            // 60초 초과
  | "API_KEY_INVALID"    // 401 / 403
  | "RATE_LIMIT"         // 429
  | "SERVER_ERROR"       // 500 / 503
  | "OUTPUT_TOO_LONG"    // finishReason === "MAX_TOKENS"
  | "PARSE_ERROR"        // JSON 파싱 실패
  | "UNKNOWN";

const ERROR_MESSAGES: Record<GeminiErrorType, string> = {
  NETWORK_ERROR:    "네트워크 오류 — 인터넷 연결을 확인해 주세요.",
  TIMEOUT:          "시간 초과 — 요청이 60초를 초과했습니다. 잠시 후 다시 시도해 주세요.",
  API_KEY_INVALID:  "API 키 오류 — Gemini API Key가 유효하지 않습니다. 키를 확인해 주세요.",
  RATE_LIMIT:       "요청 한도 초과 (429) — 잠시 후 자동으로 재시도합니다.",
  SERVER_ERROR:     "Gemini 서버 오류 — Google 서버에 일시적인 문제가 있습니다. 잠시 후 다시 시도해 주세요.",
  OUTPUT_TOO_LONG:  "출력 토큰 초과 — 선택한 화면의 데이터가 너무 많아 응답이 잘렸습니다. 자동으로 화면을 나눠 재시도합니다.",
  PARSE_ERROR:      "응답 파싱 오류 — AI 응답이 올바른 JSON 형식이 아닙니다. 자동으로 재시도합니다.",
  UNKNOWN:          "알 수 없는 오류가 발생했습니다."
};

function classifyError(err: unknown, httpStatus?: number): GeminiErrorType {
  if (err instanceof DOMException && err.name === "AbortError") return "TIMEOUT";
  if (err instanceof TypeError && err.message.includes("fetch")) return "NETWORK_ERROR";
  if (httpStatus === 401 || httpStatus === 403) return "API_KEY_INVALID";
  if (httpStatus === 429) return "RATE_LIMIT";
  if (httpStatus === 500 || httpStatus === 503) return "SERVER_ERROR";
  return "UNKNOWN";
}
```

### 11-6. 출력 토큰 초과 대응 (단계적 청크 분할)

Gemini가 `finishReason: "MAX_TOKENS"`를 반환하면 응답이 중간에 잘린 것이다.
`maxOutputTokens`를 최대로 설정해도 입력 데이터가 과도하게 많으면 발생한다.
이 경우 화면 데이터를 절반씩 나눠 순차적으로 호출 후 결과를 병합하는 전략을 사용한다.

> ⚠️ **청크 분할 시 ID 연속성 문제**
> 청크를 나눠 Gemini를 별도 호출하면, 두 번째 호출은 첫 번째 결과를 알지 못한다.
> 따라서 두 번째 청크가 테스트케이스 ID와 NO를 `001`부터 다시 시작하는 문제가 반드시 발생한다.
> 이를 두 가지 방법으로 이중 방어한다:
> 1. **프롬프트에 이전 청크의 마지막 상태를 명시** → Gemini가 이어서 생성하도록 유도
> 2. **병합 후 코드가 ID/NO를 강제로 재부여** → Gemini가 힌트를 무시해도 항상 올바른 결과 보장

**감지 방법:**

```ts
function isOutputTruncated(responseJson: any): boolean {
  return responseJson?.candidates?.[0]?.finishReason === "MAX_TOKENS";
}
```

**단계적 처리 전략:**

```
1단계: 전체 화면 데이터로 호출
       ↓ finishReason === "MAX_TOKENS" 감지 시
2단계: 화면을 절반(A → B) 순차 호출
       - A 호출 완료 후 마지막 NO/ID를 추출
       - B 호출 프롬프트에 "이전 마지막 NO/ID" 컨텍스트 주입
       - A + B 결과 병합 → ID/NO 강제 재부여
       ↓ 어느 한 쪽이 여전히 MAX_TOKENS 발생 시
3단계: annotation을 첫 50자로 압축 후 동일 방식으로 재시도
       ↓ 최종 실패 시
4단계: 사용자에게 안내 메시지 표시 후 빈 시트 생성
       "선택하신 화면 수가 너무 많습니다.
        Figma에서 화면을 절반으로 나눠 두 번 실행해 주세요."
```

**청크 호출 시 프롬프트 컨텍스트 주입:**

2단계부터는 `callGeminiAndParse`에 `previousContext`를 전달한다.
이 값이 있으면 프롬프트 하단에 아래 섹션이 추가된다:

```
## Continuation Context (IMPORTANT):
This is a continuation. The previous chunk already generated test cases.
- Last NO assigned: {previousContext.lastNo}
- Last Test Case ID assigned: {previousContext.lastId}

Rules for this chunk:
- Start NO from {previousContext.lastNo + 1}
- Continue the Test Case ID sequence after "{previousContext.lastId}"
- Do NOT restart numbering from 1 or regenerate IDs from the beginning
```

```ts
type ChunkContext = {
  lastNo: number;      // 이전 청크의 마지막 NO (숫자)
  lastId: string;      // 이전 청크의 마지막 테스트케이스 ID (문자열)
};
```

**구현 예시:**

```ts
async function callWithChunkFallback(
  screens: ScreenNode[],
  flows: FlowEdge[],
  scenario: ScenarioItem,
  columns: ColumnSchema,
  exampleRows: ExampleRow[],
  inputTypeHint: string,
  apiKey: string
): Promise<GeneratedTestCase[]> {

  // 1단계: 전체 시도
  const result = await callGeminiAndParse(
    screens, flows, scenario, columns, exampleRows, inputTypeHint, apiKey
  );
  if (!result.truncated) return normalizeIds(result.data, columns, 1);

  // 2단계: 순차 청크 분할 (A → B 순서 보장, 병렬 호출 금지)
  reportProgress(scenario.id, "출력 토큰 초과 감지 — 화면을 나눠 순차 재시도 중...");
  const half = Math.ceil(screens.length / 2);
  const chunkA = screens.slice(0, half);
  const chunkB = screens.slice(half);

  // A 먼저 호출
  const resultA = await callGeminiAndParse(
    chunkA, flows, scenario, columns, exampleRows, inputTypeHint, apiKey
  );

  // A 결과에서 마지막 NO/ID 추출 → B 프롬프트에 주입
  const contextForB = extractLastContext(resultA.data, columns);
  const resultB = await callGeminiAndParse(
    chunkB, flows, scenario, columns, exampleRows, inputTypeHint, apiKey,
    contextForB  // ← 이전 청크 컨텍스트 주입
  );

  if (!resultA.truncated && !resultB.truncated) {
    const merged = [...resultA.data, ...resultB.data];
    return normalizeIds(deduplicateByStep(merged), columns, 1);
  }

  // 3단계: annotation 압축 후 동일 방식으로 재시도
  reportProgress(scenario.id, "여전히 초과 — annotation을 압축하여 재시도 중...");
  const compressedScreens = screens.map(s => ({
    ...s,
    annotations: s.annotations.map(a => a.slice(0, 50)),
    textContent: s.textContent?.slice(0, 500)
  }));

  const compressedA = compressedScreens.slice(0, half);
  const compressedB = compressedScreens.slice(half);

  const resultCA = await callGeminiAndParse(
    compressedA, flows, scenario, columns, exampleRows, inputTypeHint, apiKey
  );
  const contextForCB = extractLastContext(resultCA.data, columns);
  const resultCB = await callGeminiAndParse(
    compressedB, flows, scenario, columns, exampleRows, inputTypeHint, apiKey,
    contextForCB
  );

  if (!resultCA.truncated && !resultCB.truncated) {
    const merged = [...resultCA.data, ...resultCB.data];
    return normalizeIds(deduplicateByStep(merged), columns, 1);
  }

  // 4단계: 최종 실패
  throw new GeminiError(
    "OUTPUT_TOO_LONG",
    "선택하신 화면 수가 너무 많습니다. Figma에서 화면을 절반으로 나눠 두 번 실행해 주세요."
  );
}
```

**이전 청크 마지막 상태 추출:**

```ts
function extractLastContext(
  rows: GeneratedTestCase[],
  columns: ColumnSchema
): ChunkContext {
  if (rows.length === 0) return { lastNo: 0, lastId: "" };

  const last = rows[rows.length - 1];

  // NO 컬럼 탐색 (대소문자 무관)
  const noCol = columns.find(c => c.toUpperCase() === "NO") ?? "NO";
  const lastNo = parseInt(last[noCol] ?? "0", 10) || rows.length;

  // 테스트케이스 ID 컬럼 탐색
  const idCol = columns.find(c =>
    c.includes("케이스 ID") || c.includes("케이스ID") ||
    c.toLowerCase().includes("testcase id") || c.toLowerCase() === "id"
  ) ?? "";
  const lastId = idCol ? (last[idCol] ?? "") : "";

  return { lastNo, lastId };
}
```

**병합 후 ID/NO 강제 재부여 (핵심 안전장치):**

Gemini가 컨텍스트 힌트를 무시하거나 잘못 이어붙인 경우를 대비해,
병합 완료 후 반드시 코드가 `NO`와 테스트케이스 ID를 순서대로 덮어쓴다.
이것이 ID 연속성을 보장하는 최종 방어선이다.

```ts
function normalizeIds(
  rows: GeneratedTestCase[],
  columns: ColumnSchema,
  startNo: number = 1
): GeneratedTestCase[] {
  // NO 컬럼과 테스트케이스 ID 컬럼을 찾는다
  const noCol = columns.find(c => c.toUpperCase() === "NO");
  const idCol = columns.find(c =>
    c.includes("케이스 ID") || c.includes("케이스ID") ||
    c.toLowerCase().includes("testcase id")
  );

  // ID 패턴 감지: 첫 번째 Row의 ID에서 패턴 추출
  // 예) "TE-DT-OR-01-014" → prefix="TE-DT-OR-01-", digits=3
  const idPattern = idCol ? detectIdPattern(rows, idCol) : null;

  return rows.map((row, i) => {
    const no = startNo + i;
    const updated = { ...row };

    if (noCol) {
      updated[noCol] = String(no);
    }
    if (idCol && idPattern) {
      updated[idCol] = `${idPattern.prefix}${String(no).padStart(idPattern.digits, "0")}`;
    }

    return updated;
  });
}

type IdPattern = { prefix: string; digits: number };

function detectIdPattern(rows: GeneratedTestCase[], idCol: string): IdPattern | null {
  // 비어있지 않은 첫 번째 ID에서 패턴 감지
  const sample = rows.find(r => r[idCol])?.[ idCol] ?? "";
  if (!sample) return null;

  // 마지막 숫자 블록을 분리 (예: "TE-DT-OR-01-014" → prefix="TE-DT-OR-01-", digits=3)
  const match = sample.match(/^(.*?)(\d+)$/);
  if (!match) return null;

  return { prefix: match[1], digits: match[2].length };
}
```

**중복 제거:**

```ts
function deduplicateByStep(rows: GeneratedTestCase[]): GeneratedTestCase[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = row["테스트 스텝"] || row["테스트케이스 명"] || JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // ※ NO/ID 재부여는 이 함수가 아닌 normalizeIds()에서 담당
}
```

### 11-7. 응답 파싱 및 검증

```ts
const raw = responseJson.candidates[0].content.parts[0].text;

// 마크다운 코드 펜스 제거
const cleaned = raw.replace(/```json|```/g, "").trim();

let parsed: Record<string, string>[];
try {
  parsed = JSON.parse(cleaned);
} catch {
  // PARSE_ERROR: 재시도 1회 (프롬프트에 "JSON만 반환" 재강조)
  // 재시도도 실패 시 빈 배열로 처리
  parsed = [];
}

// 컬럼 검증 및 보정: 정의된 컬럼 기준으로 누락 컬럼 빈 문자열 채움
const validated = parsed.map(row => {
  const result: Record<string, string> = {};
  for (const col of columns) {
    result[col] = row[col] ?? "";
  }
  return result;
});
```

---

## 12. Step 6 — Excel 파일 생성 (`excelWriter.ts`)

### 12-1. 시트명 길이 제한 처리

SheetJS는 시트명이 31자를 초과하면 에러가 발생한다.
시나리오 ID가 길 경우 잘라서 사용한다.

```ts
function safeSheetName(name: string): string {
  return name.slice(0, 31).replace(/[:\\\/\?\*\[\]]/g, "_");
}
```

### 12-2. 파일 생성 로직

```ts
// 원본 Excel 파일 파싱
const originalWorkbook = XLSX.read(uploadedFileBuffer, { type: "array" });

// 원본 기반으로 새 워크북 생성 (기존 시트 유지)
const wb = XLSX.utils.book_new();
for (const sheetName of originalWorkbook.SheetNames) {
  XLSX.utils.book_append_sheet(wb, originalWorkbook.Sheets[sheetName], sheetName);
}

// 선택된 시나리오 ID별로 새 시트 추가
for (const [scenario, testCases] of results) {
  const ws = XLSX.utils.json_to_sheet(testCases, { header: columns });
  const sheetName = safeSheetName(scenario.id);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
}

// 다운로드
XLSX.writeFile(wb, "test_scenarios_output.xlsx");
```

---

## 13. Gemini API Key 저장

Figma Plugin에서는 `localStorage` 대신 `figma.clientStorage`를 사용해야 한다.
`figma.clientStorage`는 Sandbox 환경에서만 접근 가능하므로 UI ↔ Sandbox 메시지로 처리한다.

```ts
// UI → Sandbox: 저장 요청
parent.postMessage({ pluginMessage: { type: "SAVE_KEY", key: apiKey } }, "*");

// Sandbox: 저장 및 로드
case "SAVE_KEY":
  await figma.clientStorage.setAsync("gemini_api_key", msg.key);
  break;

// Sandbox: UI 초기화 시 키 로드 후 전송
const savedKey = await figma.clientStorage.getAsync("gemini_api_key");
figma.ui.postMessage({ type: "API_KEY_LOADED", key: savedKey ?? "" });
```

---

## 14. 에러 처리

모든 에러는 원인을 명확히 구분해서 사용자에게 표시한다. 에러 유형이 불명확한 "오류가 발생했습니다" 메시지는 사용하지 않는다.

| 상황 | 에러 유형 | 사용자 표시 메시지 |
|---|---|---|
| Figma Frame 선택 없음 | — | "Figma에서 Frame을 선택 후 실행하세요." |
| Excel 업로드 없음 | — | [다음] 버튼 비활성화 + "Excel 파일을 업로드해 주세요." |
| 시나리오 목록 시트 미발견 | — | "시나리오 목록 시트를 찾을 수 없습니다." (진행 불가) |
| 시나리오명/설명 컬럼 미발견 | — | 해당 필드 빈 문자열 처리, 나머지 계속 진행 |
| Gemini API Key 없음 | — | [생성 시작] 버튼 비활성화 + "API Key를 입력해 주세요." |
| fetch 자체 실패 (오프라인 등) | `NETWORK_ERROR` | "네트워크 오류 — 인터넷 연결을 확인해 주세요." |
| 요청 60초 초과 | `TIMEOUT` | "시간 초과 — 요청이 60초를 초과했습니다. 잠시 후 다시 시도해 주세요." |
| HTTP 401 / 403 | `API_KEY_INVALID` | "API 키 오류 — Gemini API Key가 유효하지 않습니다. 키를 확인해 주세요." |
| HTTP 429 | `RATE_LIMIT` | "요청 한도 초과 — 잠시 후 자동으로 재시도합니다." (10초 대기 후 1회 재시도) |
| HTTP 500 / 503 | `SERVER_ERROR` | "Gemini 서버 오류 — 일시적인 문제입니다. 잠시 후 다시 시도해 주세요." |
| `finishReason: "MAX_TOKENS"` | `OUTPUT_TOO_LONG` | "출력 토큰 초과 — 화면을 나눠 자동 재시도합니다." → 청크 분할 로직 진입 (11-6 참고) |
| 청크 분할 후도 실패 | `OUTPUT_TOO_LONG` | "선택하신 화면 수가 너무 많습니다. Figma에서 화면을 절반으로 나눠 두 번 실행해 주세요." |
| JSON 파싱 실패 | `PARSE_ERROR` | "응답 파싱 오류 — 자동으로 재시도합니다." (1회 재시도 후 실패 시 빈 시트 생성) |
| 컬럼 불일치 | — | 누락 컬럼 → 빈 문자열 자동 보정, 추가 컬럼 → 무시 |
| 장표 텍스트 3,000자 초과 | — | 앞에서부터 잘라 사용, 프롬프트에 `[텍스트 일부 생략됨]` 명시 |
| 시트명 31자 초과 | — | 31자로 잘라 사용 |

---

## 15. 핵심 제약사항

- AI 출력은 **반드시 JSON 배열**만 반환하도록 프롬프트 강제
- 컬럼 이름은 **절대 변경·추가 금지** (Excel 정의 기준)
- Gemini API는 **시나리오 ID당 1회 호출** (순차 처리, 4초 딜레이)
- API Key는 **코드에 하드코딩 금지**, `figma.clientStorage` 사용
- 모든 처리는 **클라이언트 사이드**에서 완결 (서버 없음)
- Figma Plugin `networkAccess` 설정 필수

---

## 16. 공통 타입 정의 (`types.ts`)

```ts
type FigmaInputType = "flow" | "document" | "mixed";

type ScreenNode = {
  id: string;
  name: string;
  type: "ui_screen" | "document_page";
  annotations: string[];
  textContent?: string;
};

type FlowEdge = {
  from: string;
  to: string;
};

type FigmaData = {
  screens: ScreenNode[];
  flows: FlowEdge[];
};

type ScenarioItem = {
  id: string;
  name: string;
  description: string;
};

type ColumnSchema = string[];

type ExampleRow = { [columnName: string]: string };

type GeneratedTestCase = { [columnName: string]: string };

type GeminiErrorType =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "API_KEY_INVALID"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "OUTPUT_TOO_LONG"
  | "PARSE_ERROR"
  | "UNKNOWN";

class GeminiError extends Error {
  constructor(public errorType: GeminiErrorType, message: string) {
    super(message);
  }
}

type GeminiResult = {
  data: GeneratedTestCase[];
  truncated: boolean;
};

type ChunkContext = {
  lastNo: number;   // 이전 청크의 마지막 NO (숫자)
  lastId: string;   // 이전 청크의 마지막 테스트케이스 ID (문자열)
};

type IdPattern = {
  prefix: string;   // 예: "TE-DT-OR-01-"
  digits: number;   // 숫자 자릿수, 예: 3 → "001"
};

type SandboxToUI =
  | { type: "FIGMA_DATA"; payload: FigmaData }
  | { type: "API_KEY_LOADED"; key: string }
  | { type: "ERROR"; message: string };

type UIToSandbox =
  | { type: "READY" }
  | { type: "SAVE_KEY"; key: string }
  | { type: "CLOSE" };
```

---

## 17. 성공 기준 체크리스트

- [ ] Figma에서 Frame 선택 후 플러그인 실행 시 화면 목록 정상 수집
- [ ] Excel 업로드 후 컬럼 구조·예시·시나리오 목록(ID + 시나리오명 + 설명) 자동 추출
- [ ] 시나리오 선택 UI에 ID / 시나리오명 / 설명이 함께 표시됨
- [ ] Figma 화면 유형 선택(3가지)이 동작하고 프롬프트에 반영됨
- [ ] 혼합형 선택 시 Frame 자동 분류(ui_screen / document_page) 동작
- [ ] 선택한 시나리오 ID별로 Gemini API 순차 호출 및 테스트케이스 생성
- [ ] 생성 진행 상황이 시나리오 ID별로 실시간 표시됨
- [ ] 생성된 결과가 원본 Excel에 시트 추가 형태로 다운로드
- [ ] 어떤 컬럼 구조의 Excel이든 동적 대응 가능
- [ ] API Key가 `figma.clientStorage`에 안전하게 저장·불러오기 됨
- [ ] 청크 분할로 생성된 테스트케이스를 병합할 때 NO와 테스트케이스 ID가 끊김 없이 연속됨
- [ ] 에러 원인(네트워크/API키/시간초과/토큰초과 등)이 명확한 메시지로 표시됨
- [ ] 출력 토큰 초과 시 청크 분할 → annotation 압축 → 사용자 안내 순으로 단계적 대응됨
- [ ] Rate Limit / 파싱 실패 등 에러 상황에서 플러그인이 중단되지 않고 계속 처리됨
