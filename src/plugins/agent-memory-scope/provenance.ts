import type { SessionMeta } from "../../types.js";

export type ScopeResultProvenance = {
  conversationId: number;
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  chatType?: string;
};

export function makeScopeResultProvenance(params: {
  conversationId: number;
  sessionId?: string;
  meta?: SessionMeta;
}): ScopeResultProvenance {
  return {
    conversationId: params.conversationId,
    sessionId: params.sessionId,
    sessionKey: params.meta?.sessionKey,
    channel: params.meta?.channel,
    chatType: params.meta?.chatType,
  };
}
