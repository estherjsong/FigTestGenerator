import { FigmaData, FigmaInputType, ScreenNode } from "./types";

export function filterFigmaData(data: FigmaData, inputType: FigmaInputType): FigmaData {
  // 혼합형(mixed)이면 원본 그대로 반환
  if (inputType === "mixed") return data;
  
  // 플로우(flow)면 문서형(document_page) 화면 제외
  if (inputType === "flow") {
    return { ...data, screens: data.screens.filter((s: ScreenNode) => s.type === "ui_screen") };
  }
  
  // 문서(document)면 플로우형(ui_screen) 화면 제외
  return { ...data, screens: data.screens.filter((s: ScreenNode) => s.type === "document_page") };
}