---
name: figma-persona
description: Draw a persona set on Figma — one card per person the product is for, with goals, pains, needs, behaviours and the research source behind them; one marked primary. Reach for it when a design decision depends on who the user is.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__figma-plugin__figma_status, mcp__figma-plugin__figma_docs, mcp__figma-plugin__figma_read, mcp__figma-plugin__figma_diagram
user-invocable: true
argument-hint: "<product or segment> [research notes or @tag]"
---

# /figma-persona — Who it is for

Read `../diagram-rules.md` first — connection gate, the four levels of correct, the findings
loop, frame placement, verification. Field tables: `figma_docs(section="persona")`.

## Goal

Make the user concrete enough to settle arguments. A persona card says what one kind of
person wants and what stops them; the primary persona is the tie-breaker when needs conflict.

Output: one Figma frame `Persona · <title>`, plus the assumptions that still need research.

## Constraints

### Hard rules — never violate

- **Name the source.** Interviews, surveys, analytics. Without one, every card is an
  assumption — the tool reports it, and the report should say so too.
- **Exactly one primary** when there are several personas.
- **Goals and pains, not demographics.** Age and job help recognition; goals and pains drive design.
- **Never invent research.** If the user has none, draw proto-personas and label them as such.

### Write it in the compact form

`text` — every line after a `persona` belongs to it:

```
source "4 phỏng vấn, 120 khảo sát (11/2026)"
persona thu "Thu Trang" primary
  tag Nhân viên văn phòng, 28
  quote "Tôi muốn đặt vé trong giờ nghỉ trưa"
  goal Chọn ghế đẹp thật nhanh
  pain Phí ẩn khi thanh toán
  need Thấy tổng tiền sớm
  behav Đặt vé phút chót
  level "Thành thạo công nghệ" 4
  app Shopee
```

## Procedure

1. Gate on `mcp__figma-plugin__figma_status`.
2. Read the research; ask the user for the source and which persona is primary.
3. Draw with `mcp__figma-plugin__figma_diagram` `{ type: "persona", title, text, options: { checkFirst: true } }`.
4. Act on every warning; check the `audit` that comes back.
5. Report what is assumption and what is evidence.

## What the machine does NOT check

- Whether the research behind `source` exists or supports the cards.
- Whether two personas are really one (similar goals, different names).
- Whether journeys on the page cover the primary persona.
