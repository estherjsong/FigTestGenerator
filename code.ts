import { SandboxToUI, UIToSandbox, FigmaData, ScreenNode, FlowEdge } from "./types";

figma.showUI(__html__, { width: 520, height: 640 });

function sendFigmaData() {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({
        type: "ERROR",
        message: "Figma에서 화면(Frame)을 선택하세요."
      } as SandboxToUI);
      figma.ui.postMessage({ type: "FIGMA_DATA", payload: null } as any);
      return;
    }

    const screens: ScreenNode[] = [];
    const flows: FlowEdge[] = [];

    // 커넥터 먼저 수집 (분류에 필요)
    const connectors = figma.currentPage.findAll(n => n.type === "CONNECTOR") as ConnectorNode[];

    for (const node of selection) {
      if (node.type === "FRAME" || node.type === "SECTION" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE" || node.type === "COMPONENT_SET") {
        const textNodes = ('findAll' in node) ? (node.findAll(n => n.type === "TEXT") as TextNode[]) : [];
        
        // Annotation 수집
        const annotations = textNodes.map(n => n.characters);

        // 텍스트 계층구조 (기획 장표용 - fontSize 내림차순 정렬)
        textNodes.sort((a, b) => {
          const sizeA = typeof a.fontSize === "number" ? a.fontSize : 0;
          const sizeB = typeof b.fontSize === "number" ? b.fontSize : 0;
          return sizeB - sizeA;
        });

        let textContent = textNodes.map(n => n.characters).join("\n");
        if (textContent.length > 3000) {
          textContent = textContent.slice(0, 3000) + "\n[텍스트 일부 생략됨]";
        }

        // 혼합형 자동 분류 (Connector 연결 여부)
        const hasConnector = connectors.some(c => {
          const startId = c.connectorStart && 'endpointNodeId' in c.connectorStart ? c.connectorStart.endpointNodeId : null;
          const endId = c.connectorEnd && 'endpointNodeId' in c.connectorEnd ? c.connectorEnd.endpointNodeId : null;
          return startId === node.id || endId === node.id;
        });
        const type = hasConnector ? "ui_screen" : "document_page";

        screens.push({
          id: node.id,
          name: node.name,
          type,
          annotations,
          textContent
        });
      } else if (node.type === "CONNECTOR") {
        // Flow Edge 추출
        const connector = node as ConnectorNode;
        const startId = connector.connectorStart && 'endpointNodeId' in connector.connectorStart ? connector.connectorStart.endpointNodeId : null;
        const endId = connector.connectorEnd && 'endpointNodeId' in connector.connectorEnd ? connector.connectorEnd.endpointNodeId : null;
        
        if (startId && endId) {
          const fromNode = figma.getNodeById(startId);
          const toNode = figma.getNodeById(endId);
          if (fromNode && toNode) {
             flows.push({ from: fromNode.name, to: toNode.name });
          }
        }
      }
    }

    if (screens.length === 0) {
      figma.ui.postMessage({
        type: "ERROR",
        message: "선택된 요소 중 유효한 화면(Frame 등)이 없습니다."
      } as SandboxToUI);
      figma.ui.postMessage({ type: "FIGMA_DATA", payload: null } as any);
      return;
    }

    figma.ui.postMessage({ type: "FIGMA_DATA", payload: { screens, flows } } as SandboxToUI);
}

figma.on("selectionchange", sendFigmaData);

figma.ui.onmessage = async (msg: UIToSandbox) => {
  if (msg.type === "READY") {
    // 1. 저장된 API 키 로드
    const savedKey = await figma.clientStorage.getAsync("gemini_api_key");
    figma.ui.postMessage({ type: "API_KEY_LOADED", key: savedKey || "" } as SandboxToUI);
    
    // 2. 초기 데이터 수집
    sendFigmaData();
  } else if (msg.type === "SAVE_KEY") {
    await figma.clientStorage.setAsync("gemini_api_key", msg.key);
  } else if (msg.type === "CLOSE") {
    figma.closePlugin();
  }
};