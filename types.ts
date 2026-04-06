export type FigmaInputType = "flow" | "document" | "mixed";

export type ScreenNode = {
  id: string;
  name: string;
  type: "ui_screen" | "document_page";
  annotations: string[];
  textContent?: string;
};

export type FlowEdge = {
  from: string;
  to: string;
};

export type FigmaData = {
  screens: ScreenNode[];
  flows: FlowEdge[];
};

export type ScenarioItem = {
  id: string;
  name: string;
  description: string;
};

export type ColumnSchema = string[];

export type ExampleRow = { [columnName: string]: string };

export type GeneratedTestCase = { [columnName: string]: string };

export type GeminiErrorType =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "API_KEY_INVALID"
  | "RATE_LIMIT"
  | "SERVER_ERROR"
  | "OUTPUT_TOO_LONG"
  | "PARSE_ERROR"
  | "UNKNOWN";

export class GeminiError extends Error {
  constructor(public errorType: GeminiErrorType, message: string) {
    super(message);
  }
}

export type SandboxToUI =
  | { type: "FIGMA_DATA"; payload: FigmaData }
  | { type: "API_KEY_LOADED"; key: string }
  | { type: "ERROR"; message: string };

export type UIToSandbox =
  | { type: "READY" }
  | { type: "SAVE_KEY"; key: string }
  | { type: "CLOSE" };