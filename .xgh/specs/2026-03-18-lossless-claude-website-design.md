# lossless-claude.com — Website Design Spec

**Date:** 2026-03-18
**Domain:** lossless-claude.com
**Hosting:** GitHub Pages (static)

---

## Goals

- **Educate and convert equally** — explain the problem and solution, then drive installs
- **Primary audience:** Claude Code users who've hit the context window limit
- **Secondary audience:** AI developers curious about the DAG/LCM architecture

---

## Visual Tone

Clean, minimal, light background. Approachable OSS project page feel. Not dark/terminal-coded.

---

## Structure

Single scrolling page. No sub-pages.

---

## Page Sections

### 1 · Hero (above the fold)

**Headline:**
> "Claude Code has a memory problem. lossless-claude fixes it — nothing is ever lost."

**Subhead:**
> Every message, forever. Built natively for Claude Code.

**Primary CTA:**
```
claude plugins install @ipedro/lossless-claude
```

---

### 2 · Value bullets (scannable)

Three differentiators at a glance:

- **Lossless by design** — every message persists in SQLite; summaries link back to raw source; agents can always drill in
- **Long-term memory via Cipher** *(Cipher: the embedded semantic memory store)* — high-signal moments (decisions, fixes, architecture) promoted to persistent storage, recalled across sessions
- **Claude Code native** — plugin manifest, lifecycle hooks, MCP tools; not a bolt-on

---

### 3 · How it works

**losslesscontext.ai is currently inaccessible.** This section must be self-contained.

Build a self-contained DAG diagram inline on the page — pure HTML/CSS/JS, no framework.

**Interaction model:** A static SVG/HTML diagram with 5 numbered steps, where each step fades/highlights in sequence on scroll entry (IntersectionObserver). No user interaction required — it plays through automatically as the user scrolls past it. Steps:

1. Messages arrive → stored in SQLite
2. Compaction groups older messages into leaf summaries
3. Leaf summaries condense into higher-level DAG nodes
4. High-signal nodes promoted to Cipher (long-term memory)
5. Context assembly: recent raw messages + summaries + Cipher recall

**Fallback:** If the animated version proves too time-consuming, fall back to a static annotated SVG diagram with numbered callouts — same 5 steps, no animation.

Heading: *"How it works"*

---

### 4 · What's different (for the curious)

Short comparison explaining that lossless-claude is built on lossless-claw's DAG architecture, with the following additions:

| Feature | lossless-claw | lossless-claude |
|---|---|---|
| Long-term memory | ✗ | Cipher integration — semantic promotion across sessions |
| Smart promotion | ✗ | Auto-detects high-signal summaries (decisions, fixes, architecture) |
| Background daemon | ✗ | Compaction runs automatically without blocking your session |
| Multi-LLM | Generic abstraction | Anthropic-native + any OpenAI-compatible endpoint (local models, custom servers) |
| Claude Code integration | Script-based / manual setup | Plugin manifest + lifecycle hooks + MCP tools |

**Tone:** Respectful attribution, confident about our additions. Credit Martian Engineering's work prominently and warmly.

---

### 5 · Install + config

**Quick start block:**
```
claude plugins install @ipedro/lossless-claude
```

**Secondary CTA:** "View on GitHub" button → `https://github.com/ipedro/lossless-claude`

Links to full docs and configuration reference on GitHub.

---

### 6 · Footer / Attribution

Full, warm attribution:

- **[lossless-claw](https://github.com/Martian-Engineering/lossless-claude)** by [Martian Engineering](https://martian.engineering) — the DAG architecture, LCM model, and foundational design decisions originate there *(note: the upstream repo is named `lossless-claude` on GitHub; the project concept is called lossless-claw)*
- **[LCM paper](https://papers.voltropy.com/LCM)** by [Voltropy](https://x.com/Voltropy)
- MIT License
- GitHub link

---

## Implementation Notes

- **Static site** hosted on GitHub Pages — plain HTML/CSS, no JS framework, no build step
- **No build complexity** — the site is marketing copy, not an app
- Lives in a dedicated `gh-pages` branch of the `lossless-claude` repo
- The DAG visualization is built inline (see Section 3) — losslesscontext.ai is not currently accessible
- **Performance budget:** total page weight under 200KB; no external CDN dependencies (inline or self-host all assets)
- **Docs link target:** `https://github.com/ipedro/lossless-claude#readme` for the quick start / configuration reference

## SEO / Meta

- `<title>`: `lossless-claude — permanent memory for Claude Code`
- `<meta name="description">`: `DAG-based summarization that preserves every message. Built natively for Claude Code. Nothing is ever lost.`
- `og:title`: same as `<title>`
- `og:description`: same as meta description
- `og:url`: `https://lossless-claude.com`
- `og:image`: a social preview card — create a simple 1200×630px image with the project name and tagline (dark text on light background, matching site tone). File: `og-image.png` in repo root of gh-pages branch.
- `twitter:card`: `summary_large_image`
- `<link rel="canonical">`: `https://lossless-claude.com`
- `favicon.ico` and `favicon.svg`: minimal — wordmark or simple logomark
- `robots.txt`: allow all

## Hosting Setup (GitHub Pages + Custom Domain)

1. Create a `CNAME` file in the root of the `gh-pages` branch containing: `lossless-claude.com`
2. Configure DNS at the domain registrar:
   - A records pointing to GitHub Pages IPs: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - Or a CNAME record `www` → `ipedro.github.io`
3. Enable HTTPS in GitHub repo Settings → Pages after DNS propagates
