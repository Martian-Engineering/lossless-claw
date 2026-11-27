# Host-bound disclosure capability

Status: **proposed, optional seam.** No OpenClaw release is known to emit it
(a GitHub code search of `openclaw/openclaw` for `hostDisclosure` on 2026-11-21
found nothing; latest stable npm tag was `2026.11.6`; that is not proof of absence). When a call carries no capability, Lossless Claw behaves exactly as
before. Nothing here changes `peerDependencies.openclaw`, `openclaw.compat.*`, the
declared `acceptedHostParams`, or any config key.

## Why

One LCM database can serve several authenticated people and several destination
audiences (a DM per person, a shared room, a child session relaying to either).
Only the host knows who is authenticated and which audience a result goes to.
Tool parameters, conversation/summary/file IDs, session display names, session-key
shapes and owner defaults are not authority.

## Contract

```ts
type LcmDisclosureCapability = {
  version: 1;
  requesterId: string;   // authenticated person (opaque to LCM)
  audienceId: string;    // destination the result is released to (opaque to LCM)
  authorizeConversations(
    targets: { conversationId: number; sessionKey: string | null; sessionId: string | null; active: boolean }[],
  ): boolean[] | Promise<boolean[]>;   // one decision per target, evaluated live
};
```

The host supplies it as:

- `ctx.hostDisclosure` on the tool-factory context for `lcm_grep`, `lcm_describe`,
  `lcm_expand` and `lcm_expand_query`;
- `runtimeContext.hostDisclosure` (or `hostDisclosure`) on `assemble()`. The
  `runtimeContext` route needs no new accepted host param.

Lossless Claw stores no grants and keeps no membership table. The host (and
Knowledge, as owner of durable knowledge and evidence) stays the policy owner;
Lossless Claw stays the owner of history, compaction and context assembly.

## Behavior when a capability is present

- **Fail closed.** A capability that is malformed, lacks `requesterId` or
  `audienceId`, throws, returns the wrong number of decisions, or returns anything
  other than `true` denies.
- **Targets before content.** Conversation, summary and file targets are
  authorized before any body, title, name, count, lineage, path or file read. A
  forbidden target gets the same response as a nonexistent one.
- **IDs select, never grant.** Explicit or guessed `conversationId`, `sum_*` and
  `file_*` values, and `allConversations`, only choose among conversations the
  capability currently allows. `allConversations` means "all authorized".
- **Delegation intersects.** A delegated child's scope is
  `expansion grant ∩ host authority`. A capability never widens a grant, and a
  grant never widens host authority. `lcm_expand_query` authorizes the requester's
  own-conversation fallback and explicit summary IDs the same way.
- **Derived references.** Parent/child summary IDs, subtree nodes and attached
  file IDs owned by a denied conversation are removed from `lcm_describe` output.
  `lcm_grep` also post-filters every row.
- **Release re-check.** Every tool result and every `assemble()` result is
  re-authorized after its awaits. If authority was revoked, the sender or audience
  changed, or the host now denies, the result is withheld
  ("Result withheld: disclosure authority changed…"). Each call asks the host
  again, so a revoked handle gets no new disclosures.
- **Automatic context.** `assemble()` builds derived context (summaries, replayed
  history, file references) only for an authorized conversation. On denial it
  returns the host's live messages only. Stored history is never deleted or
  truncated; an authorized audience sees it again.

Revocation stops future disclosure. It does not retract what an earlier,
then-authorized audience already received, and it does not erase LCM history.

## Not covered by this change

- Host emission of the capability, channel authentication, and Knowledge
  publication with an explicit actor and audience belong to the OpenClaw host and
  Knowledge plugin (see openclaw/openclaw#186067, #189822, #186455).
- Summaries are produced per conversation. A summary is not re-derived per
  audience, so a conversation shared by several people (for example a DM session
  collapsed into one `main` key) is authorized as a unit. Separating people means
  separating their conversations at the host's session scoping.
- The `lcm` CLI/TUI and the doctor/maintenance commands read the database
  directly and are not gated here.
- Delegated child sessions gain the intersection only when the host also supplies
  a capability on the child's tool context; the parent's check at release still
  withholds results the parent's audience may no longer see.
- Relationship to open PRs: #1257 (opt-in principal scoping from session-key
  shape) and #1261 (full source-message bodies in delegated expansion) are
  separate and independent of this seam; this change does not depend on them.
