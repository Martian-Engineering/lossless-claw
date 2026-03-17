export function buildOrientationPrompt(): string {
  return `<memory-orientation>
Memory system active. Guidelines:
- lcm_grep / lcm_expand / lcm_describe / lcm_search → conversation history and project memory
- Do not store directly to any memory system — lossless-claude manages persistence automatically
- When uncertain what was discussed or decided, use lcm_search before asking the user
</memory-orientation>`;
}
