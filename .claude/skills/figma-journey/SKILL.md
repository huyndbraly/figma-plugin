---
name: figma-journey
description: Draw a customer journey map on Figma — one persona through one scenario, phase by phase, with actions, touchpoints, thoughts, an emotion curve, pain points and opportunities. Reach for it before a redesign, to decide what to change.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__figma-plugin__figma_status, mcp__figma-plugin__figma_docs, mcp__figma-plugin__figma_read, mcp__figma-plugin__figma_diagram
user-invocable: true
argument-hint: "<persona + scenario> [research notes or @tag]"
---

# /figma-journey — Where it hurts, phase by phase

Read `../diagram-rules.md` first — connection gate, the four levels of correct, the findings
loop, frame placement, verification. Field tables: `figma_docs(section="journey")`.

## Goal

Find the low points. A journey map lines up what one person does, thinks and feels across a
scenario so the moments that hurt — and what would fix them — are visible side by side.

Output: one Figma frame `Journey · <title>`, plus the opportunities ranked by how low the curve goes.

## Constraints

### Hard rules — never violate

- **One persona, one scenario per map.** If the persona cards exist on the page, use one of
  their names — the cross-check reports a journey walked by someone no card describes.
- **Feelings come from evidence** (interviews, reviews, support tickets). If there is none,
  say the curve is an assumption.
- **Every low point names its pain; every pain names an opportunity.** The tool reports both gaps.

### Write it in the compact form

`text` — every line after a `phase` belongs to it:

```
persona "Thu Trang"
phase find "Tìm phim"
  do Mở app, lướt danh sách
  at Trang chủ
  think "Phim nào đang hot?"
  feel 1 Tò mò
phase pay "Thanh toán"
  do Nhập thẻ
  feel -2 Lo lắng
  pain Không rõ phí dịch vụ
  fix Hiện tổng tiền trước bước nhập thẻ
```

## Procedure

1. Gate on `mcp__figma-plugin__figma_status`.
2. Collect the phases from the research or the userflow; ask the user for the source of the feelings.
3. Draw with `mcp__figma-plugin__figma_diagram` `{ type: "journey", title, text, options: { checkFirst: true } }`.
4. Act on every warning; check the `audit` that comes back.
5. Report the opportunities, worst phase first.

## What the machine does NOT check

- Whether the feelings are backed by research.
- Whether the phases match the real userflow (draw both on one page and compare).
- Whether an opportunity actually addresses its pain.
