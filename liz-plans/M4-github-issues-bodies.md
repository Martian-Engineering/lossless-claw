# M4 — GitHub issue bodies (3 issues)

Repo: `lapal0ma/LCM-PG`

**Created (2026-03-23):**

- P0: https://github.com/lapal0ma/LCM-PG/issues/4
- P1: https://github.com/lapal0ma/LCM-PG/issues/5
- P2: https://github.com/lapal0ma/LCM-PG/issues/6

To recreate locally after `gh auth login`, from repo root:

```bash
gh issue create --title "M4 follow-up (P0): SK DB URL resolution + pgcrypto on managed Postgres" --body-file liz-plans/gh-issue-m4-p0.md --label m4
gh issue create --title "M4 follow-up (P1): knowledge_roles RLS, mirror search errors, ILIKE wildcards" --body-file liz-plans/gh-issue-m4-p1.md --label m4
gh issue create --title "M4 follow-up (P2): SK/mirror defaults, assemble timeout, mirror-search admin docs" --body-file liz-plans/gh-issue-m4-p2.md --label m4
```

If label `m4` does not exist, omit `--label m4` or create the label in the repo UI first.
