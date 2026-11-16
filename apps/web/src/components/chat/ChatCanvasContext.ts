import { createContext, useContext } from "react";
import type { ChatCanvasPreview, resolveChatCanvasLayout } from "./chatCanvasLayout";
import type { PreviewMiniPlayerObstacles } from "../preview/previewMiniPlayerLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  previewKey: string | null;
  reportPreview: (preview: ChatCanvasPreview) => void;
  clearPreview: (key: string) => void;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: PreviewMiniPlayerObstacles["detailsCard"]) => void;
  /** fwai: the requests card's height (#22); the details card gives up that much of the column. */
  requestsCardHeight: number | null;
  reportRequestsCard: (height: number | null) => void;
  detailsCardTopInset: number;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
