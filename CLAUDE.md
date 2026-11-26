# Figma Plugin MCP — working notes for agents

A local MCP server (`src/server`, Node ≥ 18, TypeScript) plus a Figma plugin
(`src/plugin` → `plugin/code.js`). Agents call six tools (`figma_status`,
`figma_read`, `figma_write`, `figma_diagram`, `figma_rules`, `figma_docs`);
the server validates every operation and forwards it over WebSocket to the
plugin, which runs it with the Figma Plugin API. Design rationale:
`ARCHITECTURE.md`. Full API: `docs/TOOLS.md`.

## Commands

```bash
npm run build       # dist/server/index.js + plugin/code.js (both stamped with a build time)
npm run typecheck   # server and plugin programs
npm test            # vitest
npm run verify      # typecheck + test — run before every commit
```

`plugin/code.js` is committed (Figma loads it from the repo); rebuild before
committing a plugin change. `dist/` is not committed.

## Adding a plugin operation

One op touches these, in this order — the tests fail if one is missed:

1. `src/shared/protocol.ts` — add the name to `READ_OPERATIONS` or
   `WRITE_OPERATIONS` (and `OP_TIMEOUTS` if it can take > 30 s). Bump
   `PROTOCOL_VERSION` when the plugin and server must be reloaded together.
2. `src/plugin/handlers/<area>.ts` — the handler `(ctx) => Promise<result>`;
   throw `err(ErrorCode.X, message, hint)` — every error carries a next step.
3. `src/plugin/handlers/registry.ts` — `HANDLERS` must cover every op.
4. `src/server/executor.ts` — `METHOD_TO_OP` (camelCase `figma.*` name) and,
   if the call takes positional args, a case in `argsToParams`.
5. `src/server/validate.ts` — a zod schema in `OP_SCHEMAS` (strict on ids,
   permissive on spec shape); `needsNodeId` for ops that need one.
6. Docs: a row in `docs/TOOLS.md` (every READ op must have one —
   `docs-claims.test.ts`), and the agent-facing `src/server/docs-content/api.md.ts`.

Keep pure logic (matching, layout, parsing) in figma-free modules
(`src/plugin/*-util.ts`, `src/shared/**`) and test it directly; handler tests
use small in-memory fakes of the Figma API (see `tests/plugin/handlers/`).

## Adding a diagram kind

Graph kinds (activity, sequence, state, erd, sitemap, userflow) have their own
layout, router, plugin handler and live re-routing. Board kinds (usecase,
journey, persona) are simpler: `src/shared/<kind>/index.ts` parses the compact
`text`, checks the model and emits ready create() specs; `src/server/board.ts`
runs them; one plugin op, `create_board`, draws them. A new board kind needs:
the shared module, `BOARD_KINDS` + `buildBoard`, a marker in
`src/plugin/diagram-mark.ts` (+ `MARKERS` in `handlers/board.ts`), the enum and
arrays in the `figma_diagram` schema (`src/server/index.ts`), a
`docs-content/<kind>.md.ts` with a `## Shape` section, a `### \`type: "<kind>"\``
section in `docs/TOOLS.md`, a `.claude/skills/figma-<kind>/SKILL.md`, and the
kind named in README / ARCHITECTURE (the docs tests count them in words).

## Guards that will fail your change

- `tests/server/tool-schema.test.ts` pins every tool's property list and the
  byte size of the tool list (paid in every session). Raise the budget only on
  purpose, with the reason in the test comment and the commit message.
- `tests/server/docs-claims.test.ts` / `skills-claims.test.ts` check that docs
  and skills name only tools, ops, kinds and sections that exist.

## Running it against Figma

The MCP server process keeps the `dist/` it started with; the plugin keeps the
`code.js` Figma loaded. After a rebuild, `figma_status` compares both build
stamps and says which half is stale. Restart the MCP server (new session, or
kill the `dist/server/index.js` process and call a tool to respawn it) and/or
re-run the plugin. With several sessions, the LEADER process holding port
38470 is the one that validates operations — a stale leader rejects new ops.
