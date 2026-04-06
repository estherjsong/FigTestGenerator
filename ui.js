"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));

  // types.ts
  var GeminiError = class extends Error {
    constructor(errorType, message) {
      super(message);
      this.errorType = errorType;
    }
  };

  // excelParser.ts
  var DEFAULT_COLUMNS = [
    "NO",
    "\uD14C\uC2A4\uD2B8\uCF00\uC774\uC2A4 ID",
    "\uD14C\uC2A4\uD2B8\uCF00\uC774\uC2A4 \uBA85",
    "\uD14C\uC2A4\uD2B8 \uC2A4\uD15D",
    "\uD14C\uC2A4\uD2B8 \uC804\uC81C(\uC0AC\uC804\uC870\uAC74)",
    "\uC785\uB825 \uB370\uC774\uD130",
    "\uC608\uC0C1 \uACB0\uACFC",
    "\uC2E4\uC81C \uACB0\uACFC",
    "\uD14C\uC2A4\uD2B8 \uACB0\uACFC",
    "\uC218\uD589\uC790",
    "\uC218\uD589\uC77C\uC790",
    "\uACB0\uD568 \uC5EC\uBD80",
    "\uACB0\uD568ID",
    "\uCC38\uACE0\uC790\uB8CC"
  ];
  function parseExcelFile(data) {
    const wb = XLSX.read(data, { type: "array" });
    const templateSheetName = wb.SheetNames.find((name) => name.includes("\uD15C\uD50C\uB9BF") || name.toLowerCase().includes("template") || name.includes("\uCF00\uC774\uC2A4")) || wb.SheetNames[0];
    const templateSheet = wb.Sheets[templateSheetName];
    const templateData = XLSX.utils.sheet_to_json(templateSheet, { header: 1 });
    let columns = DEFAULT_COLUMNS;
    let exampleRows = [];
    if (templateData && templateData.length > 0) {
      columns = templateData[0].map((c) => String(c).trim());
      const rawExamples = XLSX.utils.sheet_to_json(templateSheet);
      exampleRows = rawExamples.slice(0, 3).map((row) => {
        const ex = {};
        for (const col of columns)
          ex[col] = row[col] ? String(row[col]) : "";
        return ex;
      });
    }
    const listSheetName = wb.SheetNames.find((name) => name.includes("\uBAA9\uB85D") || name.toLowerCase().includes("list") || name.includes("\uC2DC\uB098\uB9AC\uC624")) || (wb.SheetNames.length > 1 ? wb.SheetNames[1] : wb.SheetNames[0]);
    const listSheet = wb.Sheets[listSheetName];
    const listData = XLSX.utils.sheet_to_json(listSheet);
    const scenarios = [];
    const idCandidates = ["\uC2DC\uB098\uB9AC\uC624 ID", "ID", "id", "NO"];
    const nameCandidates = ["\uC2DC\uB098\uB9AC\uC624\uBA85", "\uC2DC\uB098\uB9AC\uC624 \uBA85", "\uC774\uB984", "name", "Name"];
    const descCandidates = ["\uC124\uBA85", "\uBAA9\uC801", "description", "\uB0B4\uC6A9", "\uBE44\uACE0"];
    for (const row of listData) {
      const getVal = (candidates) => {
        const col = candidates.find((c) => row[c] !== void 0);
        return col ? String(row[col]).trim() : "";
      };
      const id = getVal(idCandidates);
      if (!id)
        continue;
      scenarios.push({
        id,
        name: getVal(nameCandidates),
        description: getVal(descCandidates)
      });
    }
    return { wb, columns, exampleRows, scenarios };
  }

  // promptBuilder.ts
  var INPUT_TYPE_HINT = {
    flow: `These are mobile/app UI screens connected by user flow arrows. Each frame represents one screen. Interpret annotations as functional descriptions.`,
    document: `These are planning documents (\uAE30\uD68D\uC11C). Extract functional requirements, business rules, and user scenarios from the text content.`,
    mixed: `Input contains both UI flow screens and planning document pages. Screens tagged as "ui_screen" are interactive UI flows. Screens tagged as "document_page" are planning documents. Interpret each type accordingly.`
  };
  function buildPrompt(inputType, scenario, screens, flows, columns, examples) {
    return `You are a QA engineer.
## Input Type:
${INPUT_TYPE_HINT[inputType]}
## Scenario Info:
- ID: ${scenario.id}
- Name: ${scenario.name}
- Description: ${scenario.description}
## Figma Screen Data:
${JSON.stringify(screens)}
## User Flow:
${JSON.stringify(flows)}
## Excel Column Schema:
${JSON.stringify(columns)}
## Example Test Cases (format reference only):
${JSON.stringify(examples)}
## Task:
Generate 5~10 test cases for this scenario.
## Rules:
- Output MUST be a valid JSON array ONLY. No explanation, no markdown, no code fences.
- Each object MUST use EXACT column names as keys. Never add or rename columns.
- Missing values \u2192 use empty string ""
- Scenario ID column (if exists) \u2192 fill with "${scenario.id}"
- Focus on: realistic user behavior, step-by-step actions, clear expected results.`;
  }

  // geminiClient.ts
  var delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    var _a, _b;
    let prompt = buildPrompt(inputTypeHint, scenario, screens, flows, columns, examples);
    if (context) {
      prompt += `

## Continuation Context (IMPORTANT):
This is a continuation. The previous chunk already generated test cases.
- Last NO assigned: ${context.lastNo}
- Last Test Case ID assigned: ${context.lastId}

Rules for this chunk:
- Start NO from ${context.lastNo + 1}
- Continue the Test Case ID sequence after "${context.lastId}"
- Do NOT restart numbering from 1 or regenerate IDs from the beginning`;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6e4);
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
    } catch (err) {
      clearTimeout(timeoutId);
      throw new GeminiError(classifyError(err), "");
    }
    clearTimeout(timeoutId);
    if (!res.ok)
      throw new GeminiError(classifyError(null, res.status), `HTTP ${res.status}`);
    const responseJson = await res.json();
    const truncated = ((_b = (_a = responseJson == null ? void 0 : responseJson.candidates) == null ? void 0 : _a[0]) == null ? void 0 : _b.finishReason) === "MAX_TOKENS";
    const raw = responseJson.candidates[0].content.parts[0].text;
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let parsed = [];
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      throw new GeminiError("PARSE_ERROR", "");
    }
    const validated = parsed.map((row) => {
      var _a2;
      const result = {};
      for (const col of columns)
        result[col] = (_a2 = row[col]) != null ? _a2 : "";
      return result;
    });
    return { data: validated, truncated };
  }
  function extractLastContext(rows, columns) {
    var _a, _b, _c, _d;
    if (rows.length === 0)
      return { lastNo: 0, lastId: "" };
    const last = rows[rows.length - 1];
    const noCol = (_a = columns.find((c) => c.toUpperCase() === "NO")) != null ? _a : "NO";
    const lastNo = parseInt((_b = last[noCol]) != null ? _b : "0", 10) || rows.length;
    const idCol = (_c = columns.find((c) => c.includes("\uCF00\uC774\uC2A4 ID") || c.includes("\uCF00\uC774\uC2A4ID") || c.toLowerCase().includes("testcase id") || c.toLowerCase() === "id")) != null ? _c : "";
    const lastId = idCol ? (_d = last[idCol]) != null ? _d : "" : "";
    return { lastNo, lastId };
  }
  function detectIdPattern(rows, idCol) {
    var _a, _b;
    const sample = (_b = (_a = rows.find((r) => r[idCol])) == null ? void 0 : _a[idCol]) != null ? _b : "";
    if (!sample)
      return null;
    const match = sample.match(/^(.*?)(\d+)$/);
    if (!match)
      return null;
    return { prefix: match[1], digits: match[2].length };
  }
  function normalizeIds(rows, columns, startNo = 1) {
    const noCol = columns.find((c) => c.toUpperCase() === "NO");
    const idCol = columns.find((c) => c.includes("\uCF00\uC774\uC2A4 ID") || c.includes("\uCF00\uC774\uC2A4ID") || c.toLowerCase().includes("testcase id"));
    const idPattern = idCol ? detectIdPattern(rows, idCol) : null;
    return rows.map((row, i) => {
      const no = startNo + i;
      const updated = __spreadValues({}, row);
      if (noCol)
        updated[noCol] = String(no);
      if (idCol && idPattern)
        updated[idCol] = `${idPattern.prefix}${String(no).padStart(idPattern.digits, "0")}`;
      return updated;
    });
  }
  function deduplicateByStep(rows) {
    const seen = /* @__PURE__ */ new Set();
    return rows.filter((row) => {
      const key = row["\uD14C\uC2A4\uD2B8 \uC2A4\uD15D"] || row["\uD14C\uC2A4\uD2B8\uCF00\uC774\uC2A4 \uBA85"] || JSON.stringify(row);
      if (seen.has(key))
        return false;
      seen.add(key);
      return true;
    });
  }
  async function callWithChunkFallback(screens, flows, scenario, columns, examples, inputType, apiKey, onProgress) {
    let result;
    try {
      result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey);
    } catch (err) {
      if (err instanceof GeminiError && err.errorType === "PARSE_ERROR") {
        try {
          result = await callGeminiAndParse(screens, flows, scenario, columns, examples, inputType, apiKey);
        } catch (e) {
          return [];
        }
      } else {
        throw err;
      }
    }
    if (!(result == null ? void 0 : result.truncated))
      return normalizeIds(result.data, columns, 1);
    onProgress("\uCD9C\uB825 \uD1A0\uD070 \uCD08\uACFC \uAC10\uC9C0 \u2014 \uD654\uBA74\uC744 \uB098\uB220 \uC21C\uCC28 \uC7AC\uC2DC\uB3C4 \uC911...");
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
    onProgress("\uC5EC\uC804\uD788 \uCD08\uACFC \u2014 annotation\uC744 \uC555\uCD95\uD558\uC5EC \uC7AC\uC2DC\uB3C4 \uC911...");
    const compressedScreens = screens.map((s) => {
      var _a;
      return __spreadProps(__spreadValues({}, s), {
        annotations: s.annotations.map((a) => a.slice(0, 50)),
        textContent: (_a = s.textContent) == null ? void 0 : _a.slice(0, 500)
      });
    });
    const compressedA = compressedScreens.slice(0, half);
    const compressedB = compressedScreens.slice(half);
    const resultCA = await callGeminiAndParse(compressedA, flows, scenario, columns, examples, inputType, apiKey);
    const contextForCB = extractLastContext(resultCA.data, columns);
    const resultCB = await callGeminiAndParse(compressedB, flows, scenario, columns, examples, inputType, apiKey, contextForCB);
    if (!resultCA.truncated && !resultCB.truncated) {
      const merged = [...resultCA.data, ...resultCB.data];
      return normalizeIds(deduplicateByStep(merged), columns, 1);
    }
    throw new GeminiError("OUTPUT_TOO_LONG", "\uC120\uD0DD\uD558\uC2E0 \uD654\uBA74 \uC218\uAC00 \uB108\uBB34 \uB9CE\uC2B5\uB2C8\uB2E4. Figma\uC5D0\uC11C \uD654\uBA74\uC744 \uC808\uBC18\uC73C\uB85C \uB098\uB220 \uB450 \uBC88 \uC2E4\uD589\uD574 \uC8FC\uC138\uC694.");
  }
  async function processSequentially(scenarios, screens, flows, columns, examples, inputType, apiKey, onScenarioComplete, onProgressMessage) {
    for (const scenario of scenarios) {
      const cases = await callWithChunkFallback(screens, flows, scenario, columns, examples, inputType, apiKey, (msg) => onProgressMessage(scenario.id, msg));
      onScenarioComplete(scenario.id, cases);
      await delay(4e3);
    }
  }

  // excelWriter.ts
  function safeSheetName(name) {
    return name.slice(0, 31).replace(new RegExp("[:\\\\/?*\\[\\]]", "g"), "_");
  }
  function exportToExcel(originalWorkbook2, results2, columns) {
    const wb = XLSX.utils.book_new();
    for (const sheetName of originalWorkbook2.SheetNames) {
      XLSX.utils.book_append_sheet(wb, originalWorkbook2.Sheets[sheetName], sheetName);
    }
    for (const [scenario, testCases] of results2) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(testCases, { header: columns }), safeSheetName(scenario.id));
    }
    XLSX.writeFile(wb, "test_scenarios_output.xlsx");
  }

  // figmaParser.ts
  function filterFigmaData(data, inputType) {
    if (inputType === "mixed")
      return data;
    if (inputType === "flow") {
      return __spreadProps(__spreadValues({}, data), { screens: data.screens.filter((s) => s.type === "ui_screen") });
    }
    return __spreadProps(__spreadValues({}, data), { screens: data.screens.filter((s) => s.type === "document_page") });
  }

  // ui.ts
  var figmaData = null;
  var parsedColumns = [];
  var parsedExamples = [];
  var parsedScenarios = [];
  var originalWorkbook = null;
  var results = /* @__PURE__ */ new Map();
  var el = (id) => document.getElementById(id);
  var showError = (msg) => {
    const banner = el("error-banner");
    banner.textContent = msg;
    banner.classList.remove("hidden");
  };
  var hideError = () => el("error-banner").classList.add("hidden");
  var logDebug = (msg) => {
    console.log(msg);
    const panel = el("debug-panel");
    if (panel) {
      const time = (/* @__PURE__ */ new Date()).toLocaleTimeString();
      panel.innerHTML += `<div><span style="color:#888">[${time}]</span> ${msg}</div>`;
      panel.scrollTop = panel.scrollHeight;
    }
  };
  window.onmessage = (event) => {
    const msg = event.data.pluginMessage;
    if (!msg)
      return;
    if (msg.type === "ERROR") {
      showError(msg.message);
    } else if (msg.type === "API_KEY_LOADED") {
      el("api-key").value = msg.key;
      checkStep1Validity();
    } else if (msg.type === "FIGMA_DATA") {
      figmaData = msg.payload || null;
      if (figmaData && figmaData.screens.length > 0) {
        hideError();
        el("screen-info").innerHTML = `\uC120\uD0DD\uB41C Figma \uD654\uBA74 (${figmaData.screens.length}\uAC1C)`;
      } else {
        el("screen-info").innerHTML = "\uC120\uD0DD\uB41C \uD654\uBA74 \uC5C6\uC74C";
      }
      checkStep1Validity();
    }
  };
  parent.postMessage({ pluginMessage: { type: "READY" } }, "*");
  var fileInput = el("excel-file");
  var apiKeyInput = el("api-key");
  var btnNext = el("btn-next");
  var btnStart = el("btn-start");
  var checkStep1Validity = () => {
    const hasFile = fileInput.files && fileInput.files.length > 0;
    const hasKey = apiKeyInput.value.trim().length > 0;
    const hasScreens = figmaData !== null && figmaData.screens.length > 0;
    logDebug(`\uC0C1\uD0DC \uC5C5\uB370\uC774\uD2B8 - \uC5D1\uC140:${hasFile}, \uD0A4:${hasKey}, \uD654\uBA74:${hasScreens}`);
    const missing = [];
    if (!hasFile)
      missing.push("\uC5D1\uC140");
    if (!hasKey)
      missing.push("API\uD0A4");
    if (!hasScreens)
      missing.push("\uD654\uBA74");
    if (missing.length > 0) {
      btnNext.textContent = `${missing.join(", ")} \uD544\uC694`;
      btnNext.style.opacity = "0.6";
    } else {
      btnNext.textContent = "\u{1F680} \uB2E4\uC74C \uB2E8\uACC4\uB85C";
      btnNext.style.opacity = "1";
    }
  };
  fileInput.addEventListener("change", checkStep1Validity);
  apiKeyInput.addEventListener("input", checkStep1Validity);
  apiKeyInput.addEventListener("change", checkStep1Validity);
  el("btn-save-key").addEventListener("click", () => {
    parent.postMessage({ pluginMessage: { type: "SAVE_KEY", key: apiKeyInput.value } }, "*");
    alert("\uC800\uC7A5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
  });
  btnNext.onclick = async () => {
    var _a;
    logDebug("1. \uBC84\uD2BC \uD074\uB9AD\uB428! \uAC80\uC0AC \uC2DC\uC791");
    alert("\uB2E4\uC74C \uBC84\uD2BC\uC774 \uC815\uC0C1\uC801\uC73C\uB85C \uB20C\uB838\uC2B5\uB2C8\uB2E4! \uC5D1\uC140 \uBD84\uC11D\uC744 \uC2DC\uC791\uD569\uB2C8\uB2E4.");
    hideError();
    const hasFile = fileInput.files && fileInput.files.length > 0;
    const hasKey = apiKeyInput.value.trim().length > 0;
    const hasScreens = figmaData !== null && figmaData.screens.length > 0;
    logDebug(`2. \uBCC0\uC218 \uD655\uC778 - \uC5D1\uC140:${hasFile}, \uD0A4:${hasKey}, \uD654\uBA74:${hasScreens}`);
    if (!hasFile || !hasKey || !hasScreens) {
      const missingInfo = [];
      if (!hasFile)
        missingInfo.push("\uC5D1\uC140 \uD30C\uC77C");
      if (!hasKey)
        missingInfo.push("API Key");
      if (!hasScreens)
        missingInfo.push("Figma \uD654\uBA74(Frame)");
      logDebug("3. \uAC80\uC0AC \uC2E4\uD328 (\uD56D\uBAA9 \uB204\uB77D): " + missingInfo.join(", "));
      return showError(`\uC9C4\uD589\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. \uB2E4\uC74C \uD56D\uBAA9\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694: [${missingInfo.join(", ")}]`);
    }
    const file = (_a = fileInput.files) == null ? void 0 : _a[0];
    if (!file)
      return;
    logDebug("4. \uB85C\uB529 \uC2A4\uD53C\uB108 \uB80C\uB354\uB9C1 \uC2DC\uB3C4");
    const originalText = btnNext.textContent || "\uB2E4\uC74C \u2192";
    btnNext.innerHTML = '<span class="spinner"></span> \uC5D1\uC140 \uBD84\uC11D \uC911...';
    btnNext.disabled = true;
    btnNext.style.opacity = "1";
    await new Promise((resolve) => setTimeout(resolve, 100));
    logDebug("5. \uC5D1\uC140 \uD30C\uC77C \uBD84\uC11D(Parsing) \uC9C4\uC785");
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          var _a2;
          return resolve(new Uint8Array((_a2 = evt.target) == null ? void 0 : _a2.result));
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
      });
      const parsed = parseExcelFile(data);
      logDebug(`6. \uD30C\uC2F1 \uC131\uACF5! \uC2DC\uB098\uB9AC\uC624 ${parsed.scenarios.length}\uAC1C \uBC1C\uACAC`);
      if (parsed.scenarios.length === 0) {
        btnNext.textContent = originalText;
        btnNext.disabled = false;
        logDebug("\uC5D0\uB7EC: \uC2DC\uB098\uB9AC\uC624 \uBAA9\uB85D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        showError("\uC2DC\uB098\uB9AC\uC624 \uBAA9\uB85D \uC2DC\uD2B8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uAC70\uB098 \uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return;
      }
      parsedColumns = parsed.columns;
      parsedExamples = parsed.exampleRows;
      parsedScenarios = parsed.scenarios;
      originalWorkbook = parsed.wb;
      logDebug("7. \uD654\uBA74 \uC804\uD658(Step 2) \uC131\uACF5!");
      renderScenarios();
      el("step-1").classList.add("hidden");
      el("step-2").classList.remove("hidden");
      btnNext.textContent = originalText;
      btnNext.disabled = false;
    } catch (err) {
      console.error(err);
      logDebug(`[\uCE58\uBA85\uC801 \uC5D0\uB7EC \uBC1C\uC0DD] ${String(err)}`);
      btnNext.textContent = originalText;
      btnNext.disabled = false;
      showError("\uC5D1\uC140 \uD30C\uC77C\uC744 \uD30C\uC2F1\uD558\uB294 \uC911 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
    }
  };
  var renderScenarios = () => {
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
    document.querySelectorAll(".scenario-cb").forEach((cb) => cb.checked = true);
  });
  el("btn-deselect-all").addEventListener("click", () => {
    document.querySelectorAll(".scenario-cb").forEach((cb) => cb.checked = false);
  });
  el("btn-prev-1").addEventListener("click", () => {
    el("step-2").classList.add("hidden");
    el("step-1").classList.remove("hidden");
  });
  btnStart.addEventListener("click", async () => {
    hideError();
    const selectedIndices = Array.from(document.querySelectorAll(".scenario-cb:checked")).map((cb) => parseInt(cb.value));
    if (selectedIndices.length === 0)
      return showError("\uCD5C\uC18C 1\uAC1C\uC758 \uC2DC\uB098\uB9AC\uC624\uB97C \uC120\uD0DD\uD558\uC138\uC694.");
    const selectedScenarios = selectedIndices.map((i) => parsedScenarios[i]);
    const inputType = document.querySelector('input[name="figma-type"]:checked').value;
    const apiKey = apiKeyInput.value.trim();
    const filteredData = filterFigmaData(figmaData, inputType);
    el("step-2").classList.add("hidden");
    el("step-3").classList.remove("hidden");
    const progressList = el("progress-list");
    progressList.innerHTML = selectedScenarios.map((sc) => `<li id="prog-${sc.id}">\u2500 ${sc.id}: \uB300\uAE30 \uC911</li>`).join("");
    results.clear();
    try {
      await processSequentially(
        selectedScenarios,
        filteredData.screens,
        filteredData.flows,
        parsedColumns,
        parsedExamples,
        inputType,
        apiKey,
        (scenarioId, data) => {
          results.set(selectedScenarios.find((s) => s.id === scenarioId), data);
          el(`prog-${scenarioId}`).innerHTML = `\u2713 ${scenarioId}: \uC644\uB8CC (${data.length}\uAC1C \uC0DD\uC131)`;
        },
        (scenarioId, msg) => {
          el(`prog-${scenarioId}`).innerHTML = `\u27F3 ${scenarioId}: ${msg}`;
        }
      );
    } catch (err) {
      const errorMsgs = {
        NETWORK_ERROR: "\uB124\uD2B8\uC6CC\uD06C \uC624\uB958 \u2014 \uC778\uD130\uB137 \uC5F0\uACB0\uC744 \uD655\uC778\uD574 \uC8FC\uC138\uC694.",
        TIMEOUT: "\uC2DC\uAC04 \uCD08\uACFC \u2014 \uC694\uCCAD\uC774 60\uCD08\uB97C \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.",
        API_KEY_INVALID: "API \uD0A4 \uC624\uB958 \u2014 Gemini API Key\uAC00 \uC720\uD6A8\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. \uD0A4\uB97C \uD655\uC778\uD574 \uC8FC\uC138\uC694.",
        RATE_LIMIT: "\uC694\uCCAD \uD55C\uB3C4 \uCD08\uACFC (429) \u2014 \uC7A0\uC2DC \uD6C4 \uC790\uB3D9\uC73C\uB85C \uC7AC\uC2DC\uB3C4\uD569\uB2C8\uB2E4.",
        SERVER_ERROR: "Gemini \uC11C\uBC84 \uC624\uB958 \u2014 Google \uC11C\uBC84\uC5D0 \uC77C\uC2DC\uC801\uC778 \uBB38\uC81C\uAC00 \uC788\uC2B5\uB2C8\uB2E4.",
        OUTPUT_TOO_LONG: "\uCD9C\uB825 \uD1A0\uD070 \uCD08\uACFC \u2014 \uD654\uBA74\uC774 \uB108\uBB34 \uB9CE\uC2B5\uB2C8\uB2E4.",
        PARSE_ERROR: "\uC751\uB2F5 \uD30C\uC2F1 \uC624\uB958 \u2014 \uC62C\uBC14\uB978 JSON \uD615\uC2DD\uC774 \uC544\uB2D9\uB2C8\uB2E4."
      };
      if (err instanceof GeminiError) {
        showError(errorMsgs[err.errorType] || err.message);
      } else {
        showError("\uC54C \uC218 \uC5C6\uB294 \uC624\uB958\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
      }
    } finally {
      el("btn-download").disabled = false;
    }
  });
  el("btn-download").addEventListener("click", () => {
    if (originalWorkbook) {
      exportToExcel(originalWorkbook, results, parsedColumns);
    }
  });
})();
