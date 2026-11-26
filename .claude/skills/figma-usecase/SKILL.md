---
name: figma-usecase
description: Draw a UML use case diagram on Figma — actors outside the system boundary, use cases inside, association / «include» / «extend» / generalization between them. Reach for it at the start of a spec, to agree on WHO uses the system for WHAT before any flow is drawn.
allowed-tools: Read, Glob, Grep, AskUserQuestion, mcp__figma-plugin__figma_status, mcp__figma-plugin__figma_docs, mcp__figma-plugin__figma_read, mcp__figma-plugin__figma_diagram
user-invocable: true
argument-hint: "<system or feature> [source file or @tag]"
---

# /figma-usecase — Who uses the system for what

Read `../diagram-rules.md` first — connection gate, the four levels of correct, the findings
loop, frame placement, verification. This file carries only what is specific to a use case
diagram. Field tables: `figma_docs(section="usecase")`.

## Goal

Agree on scope. A spec lists features; a use case diagram says which actor starts each one,
which use cases always pull in another («include») and which are optional add-ons
(«extend»). Gaps show up as actors who use nothing and use cases nobody can start.

Output: one Figma frame `Use case · <title>`, plus the scope questions the diagram exposed.

## Constraints

### Hard rules — never violate

- **Actors are outside the boundary.** A person, a role, or an external system that starts or
  serves a use case. A database or "backend" is part of the system, never an actor.
- **Use cases are goals**, verb + object ("Đặt vé", "Huỷ đơn") — not screens, not buttons.
- **«include» = always needed, points from the base to the part. «extend» = sometimes,
  points from the optional part to the base.** Getting the direction wrong inverts the meaning.
- **Never invent an actor to silence "nobody can start".** That finding is a scope question
  for the user.

### Write it in the compact form

`text` is one line per thing; ids used only in links are created for you.

```
system "Ticketing app"
actor visitor "Khách"
actor pay "Cổng thanh toán" system     # secondary actor, drawn on the right
uc book "Đặt vé"
uc hold "Giữ ghế"
uc voucher "Áp mã giảm giá"
visitor - book
book => hold                            # «include»
voucher +> book                         # «extend»
member :> visitor                       # generalization
book - pay
```

## Procedure

1. Gate on `mcp__figma-plugin__figma_status` (see the shared rules).
2. Read the spec; list the actors and the goals each one has. Ask the user only about real
   ambiguity (is the payment gateway in scope? can a guest book?).
3. Draw with `mcp__figma-plugin__figma_diagram` `{ type: "usecase", title, text, options: { checkFirst: true } }`.
4. Act on every warning; the `audit` that comes back covers the drawing.
5. Report the scope questions the findings raised.

## What the machine does NOT check

- Whether a use case is at the right level (a goal, not a step).
- Whether an actor is really external to the system.
- Whether the «include» / «extend» choice matches the business rule — only that it joins two use cases.
