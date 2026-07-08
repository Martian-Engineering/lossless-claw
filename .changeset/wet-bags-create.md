---
"@martian-engineering/lossless-claw": patch
---

Teach `lcm_grep` to search the first 512,000 bytes of externalized `large_files` text rows via the new `scope="files"` option. Add an optional `fileIds` parameter to restrict the search to specific file IDs. Each match reports the file ID, line number, byte offset, matched text, and a contextual snippet. Update `lcm_describe` to give accurate bounded-search guidance when inlined content is truncated. Honor `allConversations=true` for `scope="files"` by searching large files across all conversations.
