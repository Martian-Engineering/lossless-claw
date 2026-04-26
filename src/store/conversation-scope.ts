export function appendConversationScopeConstraint(params: {
  where: string[];
  args: Array<string | number>;
  columnExpr: string;
  conversationId?: number;
  conversationIds?: number[];
}): void {
  const normalizedConversationIds = [
    ...new Set(
      (params.conversationIds ?? [])
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.trunc(value)),
    ),
  ];

  if (normalizedConversationIds.length > 0) {
    if (normalizedConversationIds.length === 1) {
      params.where.push(`${params.columnExpr} = ?`);
      params.args.push(normalizedConversationIds[0]!);
      return;
    }

    params.where.push(
      `${params.columnExpr} IN (${normalizedConversationIds.map(() => "?").join(", ")})`,
    );
    params.args.push(...normalizedConversationIds);
    return;
  }

  if (params.conversationId != null) {
    params.where.push(`${params.columnExpr} = ?`);
    params.args.push(params.conversationId);
  }
}
