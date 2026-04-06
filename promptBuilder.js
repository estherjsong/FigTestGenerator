const INPUT_TYPE_HINT = {
    flow: `These are mobile/app UI screens connected by user flow arrows. Each frame represents one screen. Interpret annotations as functional descriptions.`,
    document: `These are planning documents (기획서). Extract functional requirements, business rules, and user scenarios from the text content.`,
    mixed: `Input contains both UI flow screens and planning document pages. Screens tagged as "ui_screen" are interactive UI flows. Screens tagged as "document_page" are planning documents. Interpret each type accordingly.`
};
export function buildPrompt(inputType, scenario, screens, flows, columns, examples) {
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
## Task:\nGenerate 5~10 test cases for this scenario.\n## Rules:\n- Output MUST be a valid JSON array ONLY. No explanation, no markdown, no code fences.\n- Each object MUST use EXACT column names as keys. Never add or rename columns.\n- Missing values → use empty string ""\n- Scenario ID column (if exists) → fill with "${scenario.id}"\n- Focus on: realistic user behavior, step-by-step actions, clear expected results.`;
}
