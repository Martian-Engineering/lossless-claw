---
"@martian-engineering/lossless-claw": minor
---

`/lossless doctor apply` now accepts an optional conversation id: `doctor apply [<conversation-id>] [confirm-offline]`. This lets operators repair a specific conversation without needing that session to be the current active one. The existing current-conversation behavior is unchanged when no id is provided.
