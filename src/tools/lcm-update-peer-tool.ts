import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const LcmUpdatePeerSchema = Type.Object({
  peerId: Type.String({
    description: "Peer ID (e.g., user:ou_xxx, chat:xxx)",
  }),
  peerName: Type.Optional(
    Type.String({
      description: "Human-readable peer name",
    })
  ),
  channel: Type.Optional(
    Type.String({
      description: "Channel name (e.g., feishu, telegram)",
    })
  ),
  chatType: Type.Optional(
    Type.String({
      description: "Chat type: dm or group",
      enum: ["dm", "group"],
    })
  ),
});

export function createLcmUpdatePeerTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_update_peer",
    label: "LCM Update Peer",
    description:
      "Update the current conversation with peer information. " +
      "Creates or updates the contact record and associates it with the conversation. " +
      "Called automatically when inbound message metadata is available.",
    parameters: LcmUpdatePeerSchema,
    async execute(_toolCallId, params) {
      const sessionId = input.sessionId;
      if (!sessionId) {
        return jsonResult({ success: false, error: "No session ID available" });
      }

      const p = params as Record<string, unknown>;
      const peerId = p.peerId as string;
      const peerName = p.peerName as string | undefined;
      const channel = p.channel as string | undefined;
      const chatType = p.chatType as "dm" | "group" | undefined;

      try {
        await input.lcm.updateConversationPeer({
          sessionId,
          peerId,
          peerName,
          channel,
          chatType,
        });
        return jsonResult({ success: true, peerId, peerName, channel, chatType });
      } catch (error) {
        return jsonResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
