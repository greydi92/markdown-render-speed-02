# marked-faster

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/greydi92/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/greydi92/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for marked: byte-exact CommonMark + GFM rendering in dependency-free JavaScript.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=qgn48q27&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>

---

## How it works

### Architecture

- **Two phases.** Block phase (`renderBlocks`): a single line-index scan that emits block HTML and collects link reference definitions; inline text is deferred (placeholder tokens) and rendered only after the whole block pass, so forward references resolve. Inline phase (`tokenizeInline`): a single left-to-right index-cursor scan over each inline string — the input is never split into regex tokens. The core constructs (code spans, delimiter runs, links) are scanned by hand-written loops that advance a cursor; regexes are used only for a few bounded patterns (inline HTML tags, `<...>` autolinks, bare scheme/www/email autolinks).
- **Jump-scan inline tokenizer (the hot path).** Instead of testing every character, the tokenizer jumps straight to the next special character with one shared `/g` regex (`SPECIAL_RE`), and plain runs with no autolink trigger are appended in a single rope concat. Bare-URL/email attempts are bounded to the current word (`wordEndWithAt`, `urlEnd`, `schemeLen` with a 128-entry charset table), so a long paragraph is no longer O(n²).
- **Plain-text fast path.** An inline string with no inline-construct starter, no hard break, and no autolink trigger skips node building, emphasis scanning, and masking entirely and returns `escapeHtml(src)` directly.
- **IndexOf-jump masking.** `otNormalize` and `computeMask` jump between span-start candidates with `indexOf` instead of walking every character, and masking is skipped entirely for inline strings with no `*`, `_` or `~` delimiter at all (the common case in long READMEs); the mask is a `Uint8Array`.
- **Lookup tables and first-char dispatch.** Punctuation and whitespace tests use tables (`PUNCT_ASCII`, `isWs`) instead of per-character regexes. Block dispatch computes each line's first non-whitespace char once and gates ATX, fence, HR, HTML-block, blockquote, and list tests on it. Escaping uses a single C-level `replace` when no `&` is present.
- **Emphasis:** an opener-driven delimiter engine following marked's algorithm — opener scan with m/f counters, the `%3` rule, and split-and-retry (a failing opener longer than 1 is split off as literal text and retried), plus opposite-pair skipping. Delimiter nodes carry their flanking context (prev/next chars) computed at tokenize time.
- **Emphasis masking:** before scanning, the inline string is masked the way marked masks it — code spans and link/HTML spans are replaced by same-length placeholders, so delimiters inside them cannot open or close emphasis. This is what makes the parser byte-exact on emphasis inside links and code.
- **Document-level lexer state:** an unclosed `<a ...>` tag suppresses all later bare-URL/email autolinks in the whole document (marked's `state.inLink`), threaded through every inline render in document order. A tab-only line inside a table body is a real (empty) row, not a blank line.
- **Marked-quirk fidelity.** Byte-exactness required matching marked's actual behavior, not the spec, in several places: tilde fences keep their content indentation verbatim while backtick fences dedent by character count (marked's `Dt`); a list item's lazy continuation is decided by the previous line (a fence opener, heading, HTML block, HR, or 4+-indented line ends the item — a fence's *content* lines do not); HTML-block trailing newlines follow different rules by block type and container; link-label scanning skips `<...>` tags/autolinks and treats a double backtick before `]` as marked's label token.
- **No dependencies, no network, no caching across cases, no case-output lookups.** Deterministic: two full runs produce byte-identical output.

### Honest assessment

This parser is a hand-written port of marked 18.1.3's algorithms, tuned for byte-exactness — the emphasis engine, masking, and block rules deliberately follow marked. What is genuinely distinct is the hot-path rebuild: the jump-scan tokenizer, bounded autolink/email, indexOf-jump masking, the plain-text fast path, lookup tables, and first-char block dispatch replace the per-position slicing and per-node regex tests of a naive port. The 1.5x target was **not** reached — measured medians are ~1.2x end-to-end (see below); the fixed driver overhead (Node startup + JSON parse/stringify + file IO, identical for both parsers) and a noisy shared VM dilute the ratio, and the warmed in-process ratio varies run to run. Correctness is complete (720/720); speed is a real but modest win.

### Benchmark (measured, full 720-case practice set)

Measured 2026-11-16 on this shared VM. End-to-end: `MAKEFUN_INPUT_DIR=<kit>/practice/input`, `MAKEFUN_OUTPUT_DIR=/tmp/mrs02-out`, `date +%s%N` before/after `node main.ts`, 7 repeats each, median:

| Parser | Median (ms) | Range (ms) |
|---|---|---|
| This parser (`parse.js` via repo `main.ts`) | 1480 | 1395–1698 |
| marked 18.1.3 baseline (kit `baselines/main.ts`) | 1786 | 1694–1841 |
| Speedup | **1.21x** | |

Same work on both sides (read `cases.json`, render each case alone, write `html.json`). Two more methods, same conclusion: warmed in-process (7 full runs each, twice): medians 707 vs 1015 ms (1.44x) and 727 vs 883 ms (1.21x); cold single-run fresh process (5 each): medians 1107 vs 1268 ms (1.15x). The box is noisy — individual runs swing ±30% — but every method's median favors this parser, and the end-to-end 1.21x is the number to quote. The 1.5x target was not reached.

### Byte-exactness verification

- Practice set: 720 cases (680 CommonMark spec cases + 40 generated README docs), kit `practice/input/cases.json` vs `practice/reference/expected.json`.
- Method: a comparator runs the repo `main.ts` on the practice set and diffs every output byte-for-byte against the reference.
- Result: **720/720** match. All **680/680** spec cases pass; all 40 generated docs pass. Determinism verified: two full runs produce byte-identical `html.json`.

