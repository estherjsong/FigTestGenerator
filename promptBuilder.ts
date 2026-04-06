import { FigmaInputType, ScreenNode, FlowEdge, ScenarioItem, ColumnSchema, ExampleRow } from "./types";

const INPUT_TYPE_HINT: Record<FigmaInputType, string> = {
  flow: `These are mobile/app UI screens connected by user flow arrows. Each frame represents one screen. Interpret annotations as functional descriptions.`,
  document: `These are planning documents (기획서). Extract functional requirements, business rules, and user scenarios from the text content.`,
  mixed: `Input contains both UI flow screens and planning document pages. Screens tagged as "ui_screen" are interactive UI flows. Screens tagged as "document_page" are planning documents. Interpret each type accordingly.`
};

export function buildPrompt(
  inputType: FigmaInputType,
  scenario: ScenarioItem,
  screens: ScreenNode[],
  flows: FlowEdge[],
  columns: ColumnSchema,
  examples: ExampleRow[]
): string {
  return `You are a QA engineer.
## Input Type:
${INPUT_TYPE_HINT[inputType]}
## Scenario Info:
- Scenario ID: ${scenario.id}
- Name: ${scenario.name}
- Description: ${scenario.description}
## Figma Screen Data:
${JSON.stringify(screens)}
## User Flow:
${JSON.stringify(flows)}
## Excel Column Schema (MUST USE EXACTLY THESE KEYS):
${JSON.stringify(columns)}
## Example Test Cases (format reference only):
${JSON.stringify(examples)}
## Task:
Generate 5~10 test cases for this scenario.
## Rules:
- Output MUST be a valid JSON array ONLY. No explanation, no markdown, no code fences.
- Each object MUST use EXACT column names as keys from the "Excel Column Schema". Never add or rename columns.
- Missing values → use empty string ""
- If a Test Case ID column exists, format it dynamically (e.g. "${scenario.id}-001").
- Focus on: realistic user behavior, step-by-step actions, clear expected results.`;
}