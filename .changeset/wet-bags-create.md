---
"@martian-engineering/lossless-claw": patch
---

Teach `lcm_grep` to search the contents of externalized `large_files` rows via the new `scope="files"` option. Add an optional `fileIds` parameter to restrict the search to specific file IDs. Each match reports the file ID, line number, byte offset, matched text, and a contextual snippet. Update `lcm_describe` to give accurate guidance when inlined content is truncated. Honor `allConversations=true` for `scope="files"` by searching large files across all conversations.
