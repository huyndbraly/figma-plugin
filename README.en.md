[Tiếng Việt](./README.md) | **[English](./README.en.md)**

# Figma Plugin MCP

**An MCP server that lets AI agents read and draw on the Figma canvas — safely.** Open source (MIT).

Figma Plugin MCP pairs a local MCP server with a companion Figma plugin. Point Claude Code, Cursor, Codex or any MCP-capable agent at it, and the agent can inspect a Figma file and draw into it by executing JavaScript against a `figma.*` proxy API — with the plugin layer catching the mistakes that usually turn "AI draws a screen" into "AI draws an overflowing, half-clipped mess." It builds and uses real components (variants, properties, instances), it audits accessibility, design-system compliance and responsiveness, and it draws the BA diagrams a spec needs — userflow, activity, sequence, ERD, sitemap, state machine, use case, journey map, persona set — and proof-reads the model behind each one.

It exists because most Figma MCPs make agents responsible for discipline they don't have: remembering never to overlay a semi-transparent frame, re-declaring token maps every call, manually computing x/y offsets, eyeballing screenshots to check for clipping. This project moves that discipline into the server and plugin, and gives the agent a structured way to verify its own work.

## Features

| Area | What you get |
|---|---|
| **Connection** | Figma bridge with rich diagnostics and next-step hints; several Figma windows and several AI agents at once (leader/follower); one launcher for Claude Code, Cursor and Codex; hardened local bridge (sandboxed JS, authenticated forwarding); rule sheet and on-demand docs for the agent |
| **Read and draw** | Pages, layers, selection, screenshots and exports; frames, text, shapes and streaming batches; layout audit (overflow, clipping, truncated text); new work never lands on top of existing work |
| **Design system** | Tokens and variables (create, bind, edit, import/export); text and effect styles; read an existing design system and export `design-kit.md`; compliance audit (what is bound, what equals a token, what is off-system) and one-call auto-binding |
| **Components** | Find by name, find-or-create, componentize a frame (and swap its copies for instances), variants laid out in a grid, component properties bound to layers in every variant, instances with variant + properties, instance overrides, swap, detach, reset |
| **Quality** | Accessibility audit (WCAG contrast, 44pt tap targets, small text, unnamed controls); responsive audit (a copy of the screen stretched to phone / tablet / desktop viewports and audited at each) |
| **Code ↔ Figma** | A component map between code components and Figma components (props ↔ variants and properties): export a starting map, check it against the file, and `render("Button", { tone, size, children })` the exact Figma variant |
| **Assets** | Icons, images, overlays, gradients, recolor, prototype reactions; delete pages and styles, sweep unused styles. Place images with `loadImage({ filePath })` / `{ imageUrl }` — the server reads or downloads them, so the agent never handles base64; transparent-background images cut out by the model itself with `generateImage(prompt, { transparent: true })`; draw icons / illustrations as SVG into editable vectors (`create({ type: "ICON", svg })`) |
| **BA / UX diagrams** | Userflow, activity with swimlanes, sequence, ERD, sitemap, state machine, use case, journey map, persona set; arrows follow the boxes; edit a diagram in place; cross-check diagrams against each other |
| **REST hybrid (PAT)** | Paste a Figma personal access token right in the plugin panel (`REST Token` field, Save/Clear, live badge `Valid (@handle)` / `Expired / Invalid` / `Rate-limited`); stored on your machine only (`figma.clientStorage`), held in RAM by the server, never written to a file, logged or returned to an agent. Read comments, reply / post comments, version history, read files that are **not open** from a link or `fileKey` (`generate_design_md` included); every REST request shows in ACTIVITY tagged `[REST]` |
| **FigJam · Slides · Motion** | In FigJam, `figma_diagram` draws with native nodes: userflow / activity / state / sitemap / usecase as shapes + self-attaching connectors, persona / journey as stickies; the section stores the model, so `update`/`patch` and cross-checks still work (sequence / erd keep their frame drawing). Read and add slides in Figma Slides; read prototype `motion` (trigger, SMART_ANIMATE, duration, bezier/spring easing, a CSS timing string) to generate animation code — also for a file that is **not open**, read through REST (`url` / `fileKey`) |
| **Extensions** | Export / read Code Connect `.figma.tsx` files from the component map; a local multi-file design-system index (`.figma-cache/`, `search_design_index`); `htmlToFigma(url)` rebuilds a running web page as an auto-layout tree (optional Playwright); generate images (OpenAI / Gemini / Flux) and SVGs (Anthropic) with your own API key (BYOK) — pasted into the plugin panel's **AI Image Key** field — and place them on the canvas |
| **Claude skills** | `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-erd`, `/figma-sitemap`, `/figma-state`, `/figma-usecase`, `/figma-journey`, `/figma-persona` |

## Why this one

| | Typical Figma MCP | Figma Plugin MCP |
|---|---|---|
| Verification | Screenshot only — agent eyeballs pixels | `layout_audit` returns declared vs. rendered bounds, `overflowsParent`, `clippedBy`, `textTruncated` per node; screenshots stay for final human review |
| Overlays / scrims | Agent dims a screen with an opacity'd FRAME (dims the whole subtree) | `figma.overlay()` creates a correctly layered RECTANGLE — the mistake is structurally unavailable |
| Session state | Token maps and id registries re-declared every call | `state` is a persistent object per session; set up tokens once, reuse across calls |
| Components | Agent copies frames around, or juggles component ids between calls | Components are addressed by **name**; `instantiate("Button", { variant, properties })` resolves the set, the variant and the `#1:2`-suffixed property keys for you |
| Connection | Silent boolean, or a dead WS with no explanation | `figma_status` returns diagnostics plus an ordered `hints` list of concrete next steps |
| Multiple IDE windows | Second server instance fights for the port or silently fails | Leader/follower election; followers forward through an authenticated `/rpc` to the one leader holding the plugin connection |
| Batch operations | Hard caps (e.g. 50 ops) with all-or-nothing failure | Chunked streaming, partial commit, exact per-index error reporting, no hard cap |
| Structural frames | Figma's default white fill turns layout wrappers into accidental white slabs | FRAME/COMPONENT without an explicit fill defaults to transparent; visible surfaces opt in |
| Sandbox JS | Restricted/older syntax (no `?.`, `??`, spread) | Node `vm` — full modern ES (optional chaining, nullish coalescing, spread, async/await) |
| Errors | Bare exceptions | Every failure carries `{code, message, hint}` — the hint is the next concrete step |
| Edit-in-place | Draw-from-scratch focus; per-op fights the single-threaded plugin | Selection-first workflow (`readSelection` → modify → `layout_audit`), instance-override copying, recursive recolor, mixed-font-safe text edits; writes serialized per connection so mutations never race |
| Diagrams | Mermaid/plantuml text rendered to an image — each diagram an island | Every diagram frame **stores the model it was drawn from**: change one with `update` + `patch` instead of re-authoring it, and let the tools ask whether the diagrams on the page contradict each other |
| Business rules with a number | The `10 minutes` retyped into four diagrams; one gets updated, the others don't | `options.policies` holds the value once and labels reference it as `@hold-minutes` — a label cannot drift from a number it doesn't hold |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design rationale and the root-cause fixes behind these defaults.

## Comparison: REST API vs. Figma MCP vs. Figma Plugin MCP

| Category & Feature | Figma REST API (PAT) | Official / Typical Figma MCP | Figma Plugin MCP (This Repo) |
|---|---|---|---|
| **Setup, Auth & Architecture** | | | |
| Auth via Personal Access Token (PAT) / OAuth | ✅ (High) — PAT / OAuth | ✅ (High) — OAuth / Account | ✅ (Medium) — Local bridge + Figma Desktop session; **optional PAT** pasted in the plugin panel (stored on your machine, live badge for validity / scopes / expiry / 429, never shown to the AI); `FIGMA_TOKEN` fallback. No OAuth |
| Remote / Cloud access by Figma URL (no local plugin) | ✅ (High) | ✅ (High) — Remote MCP via URL | ⚠️ (Medium, with PAT) — Read a **closed** file by link/`fileKey` (`get_node`, `get_design_context`, `generate_design_md`, `screenshot`, `exportAssets`, comments, versions); the MCP server is still local, and writes still need the plugin. Subject to the plan's REST quota |
| Headless / CI-CD (no Figma Desktop needed) | ✅ (High) | ✅ (Medium — with Remote MCP reads) | ⚠️ (Low–Medium, with PAT / `FIGMA_TOKEN`) — Reads, renders, asset export, comments and versions work without Figma Desktop; any canvas write needs the plugin window open. Quota-bound on Starter plans |
| Multi-IDE / Multi-agent concurrency | ✅ (High) — Stateless HTTP | ✅ (Medium — Remote MCP) / ❌ (Low — Desktop local) | ✅ (High) — Leader/follower `/rpc` forwarding |
| Enterprise SSO, seat permissions & audit logs | ✅ (High) | ✅ (High) — Official Figma Cloud permissions | ❌ (Local bridge, no cloud org governance) |
| Setup simplicity | ✅ (High) — Just an HTTP token | ✅ (High) — Hosted / 1-click toggle in Figma | ✅ (Medium) — Clone, build server + import manifest |
| Rate-limit resilience | ❌ (Low — strict REST API quotas) | ✅ (Medium) | ✅ (High — plugin path over local WebSocket, no REST quota; used whenever the file is open). The optional REST path has the plan's quota — **very small on Starter** (measured: `429`, `Retry-After` ≈ 4.6 days after ~a dozen file reads) — and fails fast with `RATE_LIMITED` + retry time instead of hanging |
| **Agent Reading & Token Usage** | | | |
| Read pages, layers, styles & metadata | ✅ (High) — Full file JSON | ✅ (High) | ✅ (High) |
| Read current canvas selection (`read_selection`) | ❌ (Requires node IDs manually) | ✅ (Medium) | ✅ (High — selection-first workflow) |
| Token efficiency (LLM context cost) | ❌ (Low — raw JSON tree is huge) | ✅ (Medium — structured context) | ✅ (High — compact ops, `maxOutputChars`, text diagrams) |
| Persistent session state across calls | ❌ | ❌ (Re-declares maps every call) | ✅ (High — persistent `state` per session) |
| On-demand rules & docs (`figma_rules`, `figma_docs`) | ❌ | ✅ (Medium — rules/skills) | ✅ (High — live design-system rule sheet + 16 doc topics) |
| Machine-grounded `design-kit.md` snapshot | ❌ | ❌ | ✅ (High — `generate_design_md` with exact IDs & usage) |
| **Writing & Canvas Manipulation** | | | |
| Create / edit / delete frames, text & shapes | ❌ (Read-only canvas) | ✅ (Medium — via `use_figma` / tools) | ✅ (High — full `figma.*` proxy + modern ES VM) |
| Auto-layout & safe structural defaults | ❌ | ✅ (Low — raw Plugin API pitfalls) | ✅ (High — transparent wrapper frames, auto-wrap text) |
| Safe overlays / scrims (no subtree dimming) | ❌ | ❌ (Prone to frame-opacity mistakes) | ✅ (High — `figma.overlay()` enforces safe rectangle) |
| Non-overlapping placement on canvas | ❌ | ❌ (Manual x/y calculations) | ✅ (High — auto-places away from existing work) |
| Chunked batch streaming & partial commit | ❌ | ❌ (Hard caps / all-or-nothing) | ✅ (High — streaming batches, per-index errors) |
| Edit-in-place & mixed-font-safe text edits | ❌ | ✅ (Low) | ✅ (High — serialized writes, recursive recolor) |
| Prototype reactions & interactions | ❌ | ✅ (Medium) | ✅ (High) |
| **Components & Design Systems** | | | |
| Read Variables / Design Tokens (no Enterprise plan) | ❌ (Variables REST API is Enterprise-only) | ✅ (Medium) | ✅ (High — works on any Figma plan via Plugin API) |
| Create & bind Variables / Text & Effect Styles | ❌ | ✅ (Medium) | ✅ (High — `setupTokens`, `applyVariable`, import/export) |
| Create Component Sets, Variants & Properties | ❌ | ✅ (Medium) | ✅ (High — grid layout + auto-bound properties) |
| Instantiate by name (auto-resolve variant & `#id` keys) | ❌ | ❌ (Requires raw IDs/keys) | ✅ (High — `instantiate("Button", { variant, properties })`) |
| Search org/team Design System libraries in the Cloud | ✅ (Medium) — Team/file endpoints | ✅ (High) — `search_design_system`, `get_libraries` | ⚠️ (Low–Medium) — Local multi-file index (`search_design_index`) of every file this machine has read; closed files added via PAT (`index_design_file`). No org-wide cloud search |
| Code ↔ Figma component mapping | ❌ | ✅ (High) — Cloud-synced Dev Mode Code Connect | ✅ (Medium) — Local `export_component_map` + `render()`, export/read Code Connect `.figma.tsx` files (no cloud publish) |
| Design system compliance audit & auto-bind | ❌ | ❌ | ✅ (High — `audit_design_system` + one-call auto-bind) |
| **Verification & Output Product Quality** | | | |
| Screenshot / image export | ✅ (High — server-rendered PNG/SVG) | ✅ (High) | ✅ (High) — plugin render; closed files rendered through REST with the PAT |
| Programmatic layout audit (overflow/clip/truncate) | ❌ | ❌ (Agent eyeballs screenshots) | ✅ (High — `layout_audit` returns exact node bounds & flags) |
| Accessibility audit (WCAG contrast, 44pt targets) | ❌ | ❌ | ✅ (High — `a11y_audit`) |
| Responsive multi-viewport audit | ❌ | ❌ | ✅ (High — stretches copy to phone/tablet/desktop) |
| Actionable error diagnostics (`code`, `message`, `hint`) | ❌ (HTTP status codes) | ✅ (Low) | ✅ (High — structured next-step hints) |
| **Output quality: UI / Design in Figma** | ❌ (Cannot draw) | ✅ (Medium — prone to overlap/clipping) | ✅ (High — verified layout, tokens, real components) |
| **Output quality: Generated Code by Agent** | ✅ (Low — noisy raw JSON, no a11y/layout hints) | ✅ (High — strong Code Connect & context) | ✅ (High — `design-kit.md` + exact tokens + `render()`) |
| **BA / UX Diagrams & Specs** | | | |
| Generate BA/UX diagrams (9 types) | ❌ | ✅ (Medium — FigJam Mermaid) | ✅ (High — Userflow, Activity, Sequence, ERD, Sitemap, State, Use Case, Journey, Persona) |
| Model-backed diagrams & in-place `update`/`patch` | ❌ | ❌ (Static/re-authored) | ✅ (High — model stored in frame, patch in-place) |
| Semantic content linting & cross-diagram checks | ❌ | ❌ | ✅ (High — catches dead ends, missing PK/FK, etc.) |
| Single-source business policies (`@policies`) | ❌ | ❌ | ✅ (High — prevents number/rule drift across diagrams) |
| Smart connectors (arrows stay attached) | ❌ | ✅ (Medium — FigJam connectors) | ✅ (High — re-routes automatically on move) |
| **AI Creative, Media & Multi-Surface Figma (Official / Paid)** | | | |
| AI Image & Vector Illustration generation (`generate_image`, `generate_vector_illustration`) | ❌ | ✅ (High) | ✅ (Medium, BYOK) — `generateImage` (your OpenAI / Gemini / Flux key, pasted in the plugin panel) / `generateSvg` (your Anthropic key, sanitised SVG), placed on the canvas |
| Motion / Animation context & keyframes (`get_motion_context`) | ❌ | ✅ (High) | ✅ (Medium) — prototype transitions as `motion` (SMART_ANIMATE, duration, bezier/spring, CSS); no keyframes |
| Custom Shaders, Generative Plugins & Weave AI workflows | ❌ | ✅ (High) | ❌ |
| Live Web / HTML → Editable Figma Design (`generate_figma_design`) | ❌ | ✅ (High) | ✅ (Medium) — `htmlToFigma(url)` with optional Playwright: flex → auto-layout, computed fonts/colours; images as placeholders; opens any http(s) host (localhost, LAN, public) |
| Video export (`export_video`) | ❌ | ✅ (High) | ❌ |
| FigJam, Figma Slides, new file creation & Branching (`create_branch`) | ❌ (Read-only) | ✅ (High) — Native FigJam, Slides, Branching | ✅ (Medium) — Native FigJam drawing for 7 of 9 diagram kinds (shapes + connectors, stickies for persona/journey), model stored for patches; basic Slides read/create; no new files or branching |
| **Collaboration & Cloud Metadata** | | | |
| Comments, version history & webhooks | ✅ (High) | ✅ (High) — Read/manage comments & cloud metadata | ✅ (Medium) — Read/post comments & version history through the plugin-panel PAT; no webhooks |

### Key Takeaways by Use Case

- **Cloud ecosystem, AI creative tools & multi-surface Figma:** **Official / Paid Figma MCP** is still stronger for zero-setup remote access, org-wide Design System library search (`search_design_system`), cloud-synced Dev Mode Code Connect, shaders / video / keyframe motion, and Branching. **Figma Plugin MCP** now covers the basics of several of these locally — FigJam-native diagrams, Slides, prototype motion, Code Connect files, HTML → Figma, BYOK image/SVG — at a lower level of polish.
- **Agent reading Figma to write code from an open file:** Both **Official Figma MCP** and **Figma Plugin MCP** outperform the **REST API** by avoiding huge raw JSON payloads that burn LLM context tokens. **Figma Plugin MCP** additionally exports a deterministic `design-kit.md` snapshot and reads Variables on non-Enterprise plans.
- **Agent designing accurate UI & BA/UX diagrams on Figma Design:** **REST API** cannot write to the canvas at all. **Figma Plugin MCP** produces cleaner layout outputs than typical MCPs because `layout_audit`, `a11y_audit`, `audit_design_system`, safe defaults, and model-backed diagrams catch clipping, contrast, and logic errors before a human reviews a screenshot.
- **Headless automation & cloud metadata (CI/CD, webhooks, version history):** **Figma REST API (PAT)** is the right tool when no Figma Desktop session is available.
- **Figma Plugin MCP + optional PAT:** the plugin stays the main path (no quota, writes, full design-system access); the token adds comments, version history and reads of files that are not open. Mind the plan: on **Starter** the REST file-read quota runs out after a handful of calls (days to reset), so open the file whenever you can and treat REST as the occasional fallback.

## Quickstart

1. Install and build the MCP server.
2. Register it in your editor (Cursor, Claude Code, Codex).
3. Import the plugin into Figma Desktop and keep its window open.
4. Ask the agent to call `figma_status`, then `figma_read` / `figma_write` / `figma_diagram`, then `layout_audit`.

```bash
git clone https://github.com/huyndbraly/figma-plugin.git
cd figma-plugin
npm install
npm run build
```

This builds the server to `dist/` and the plugin bundle to `plugin/code.js`.

**Register the MCP server** — all editors at once (Cursor, Claude Code, Codex):

```bash
npm run install:mcp
```

or one editor by hand:

```bash
claude mcp add figma-plugin -s user -- /absolute/path/to/figma-plugin/scripts/figma-plugin-mcp.sh
```

**Import the plugin into Figma Desktop:** menu → **Plugins → Development → Import plugin from manifest…** → select `plugin/manifest.json`. Run it from **Plugins → Development → Figma Plugin MCP** and keep its window open.

**Check the connection:** ask your agent to call `figma_status`. Full walkthrough and troubleshooting: [`docs/SETUP.md`](./docs/SETUP.md) and [`docs/INSTALL.md`](./docs/INSTALL.md). Several editors at once: [`docs/MULTI-AGENT.md`](./docs/MULTI-AGENT.md).

**(Optional) REST token:** in the plugin panel, paste a Figma personal access token (`figd_…`) into **REST Token (PAT)** → **Save**. The badge turns `Valid (@handle)` once the server has checked it with `GET /v1/me`. It powers comments, version history and reads of files that are not open, and replaces the `FIGMA_TOKEN` environment variable (still used as a fallback).

> **Every session:** open your Figma file → **Plugins → Development → Figma Plugin MCP** → leave the window open. Figma doesn't auto-start plugins.

## Tools

| Tool | Purpose |
|---|---|
| `figma_status` | Rich connection diagnostics — plugin connection, leader/follower mode, heartbeat, queue, sessions, the REST token's state (`restToken`: state/handle/masked `figd_…a1b2`, never the token), and an ordered `hints` list. Never a bare boolean. |
| `figma_read` | Read the canvas via an `op` enum (`get_document_info`, `get_selection`, `read_selection`, `get_design_context`, `get_design_system_kit`, `generate_design_md`, `search_nodes`, `find_component`, `get_instance_overrides`, `a11y_audit`, `audit_design_system`, `export_component_map`, `screenshot`, `layout_audit`, `get_diagram_spec`, `get_page_model`, `get_slides`, REST: `get_comments`, `get_versions`, local index: `search_design_index`, `index_design_file`, ...) with token-frugal responses. Pass `{ url }` or `{ fileKey }` to read a file that is not open through REST. |
| `figma_write` | Execute modern-ES JavaScript against the `figma.*` proxy to create/modify the canvas — including components, variants, properties and instances. `state` persists per session. |
| `figma_rules` | One-call design-system rule sheet (styles + variables + components) as markdown — read before drawing so you reuse instead of hardcode. For a durable spec, use `figma_read` op `generate_design_md` and save the returned markdown as `design-kit.md`. |
| `figma_diagram` | Draw **nine** diagram kinds from a model **you** derived from the spec, each with findings on the *content*, not the drawing. `type:"activity"` — a business process, with swimlanes or without: one band per owner, the handoffs between bands; reports an unlabelled handoff, a step nobody owns, a fork that never joins. `type:"sequence"` — an exchange over time: participants as columns, messages in the order you list them, activation bars derived from the calls and their replies, alt/loop blocks; reports a call nobody answers, a reply with no call, an alt with no else. `type:"state"` — the lifecycle of ONE entity: the values it can hold and every change that is allowed, written `event [guard] / action`; reports a state nothing can reach, a state nothing can leave, two transitions racing on one event. `type:"erd"` — a data model: tables, columns, keys, crow's-foot cardinality; reports what bites after a migration (no primary key, a foreign key to a column that does not exist, a many-to-many with no join table). `type:"userflow"` — the screens a user moves through, from a graph or a mermaid `flowchart`; reports a question with one way out, a dead end, an unreachable screen. `type:"sitemap"` — the pages a product is made of and what contains what, drawn as a tidy tree; reports an orphan page, a section with nothing under it, a depth nobody will navigate, and cross-checks against the userflows on the page. `type:"usecase"` — actors, use cases inside a system boundary, «include»/«extend»/generalization; reports an actor that uses nothing and a use case nobody can start. `type:"journey"` — one persona through one scenario with an emotion curve; reports a low point with no pain and a pain with no opportunity. `type:"persona"` — one card per person the product is for; reports a missing research source, no primary, a persona with no goal or pain. Write any of them in the compact `text` form at ~a third of the tokens, draw a whole set in one call (`diagrams: [...]`, placed for you), and **change** one with `update` + `patch` instead of re-authoring it. Every draw is cross-checked against the other diagrams on the page. On the six graph kinds arrows stay attached: drag a box and every line touching it re-routes. |
| `figma_docs` | On-demand documentation: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes` \| `style` \| `userflow` \| `activity` \| `erd` \| `sequence` \| `sitemap` \| `state` \| `usecase` \| `journey` \| `persona`. Read `style` when there's no design system to reuse — it's the brand-neutral default scale/palette/elevation to fall back on instead of inventing values. |

Full parameter reference for every operation and every `figma.*` method: [`docs/TOOLS.md`](./docs/TOOLS.md).

## Diagram skills

[`.claude/skills/`](./.claude/skills/) ships a skill per diagram kind — `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-state`, `/figma-erd`, `/figma-sitemap`, `/figma-usecase`, `/figma-journey`, `/figma-persona` — plus the discipline they share (the connection gate, the four levels of "correct", the findings loop, verification). Copy them into `.claude/skills/` in your project. See [`.claude/skills/README.md`](./.claude/skills/README.md).

## Example: `figma_write`

```js
// Set tokens once — they persist in this session's `state.tokens`.
await figma.setupTokens({
  colors: { primary: "#2563EB", surface: "#0B0B0F" },
  numbers: { "radius-md": 8 },
});

// Draw a card with wrapping text, reusing the parent's width.
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, layoutMode: "VERTICAL",
});
await figma.applyVariable(card.id, "fills", "surface");
await figma.create({
  type: "TEXT", parentId: card.id, wrap: true,
  characters: "A long paragraph that must wrap inside the card.",
});

// Verify before screenshotting for a human.
const audit = await figma.layoutAudit(card.id);
if (audit.summary.issues.length) console.warn(audit.summary.issues);
```

## Example: components

```js
// A button set: two tones × two sizes, laid out in a grid.
const button = await figma.createVariants({
  name: "Button",
  variants: ["primary", "secondary"].flatMap((tone) => ["sm", "lg"].map((size) => ({
    props: { Tone: tone, Size: size },
    spec: {
      layoutMode: "HORIZONTAL", padding: size === "sm" ? 8 : 14,
      fill: tone === "primary" ? "#2563EB" : "#E5E7EB",
      children: [{ type: "TEXT", name: "Label", characters: "Button",
                   fill: tone === "primary" ? "#FFFFFF" : "#111827" }],
    },
  }))),
});

// One TEXT property, wired to the "Label" layer in every variant.
await figma.addComponentProperty(button.id, { name: "Label", type: "TEXT", defaultValue: "Button", bind: "Label" });

// Use it by name — variant and property keys are resolved for you.
await figma.instantiate("Button", { variant: { Size: "lg" }, properties: { Label: "Save" }, parentId: state.formId });
```

## Example: snapshot a design system to `design-kit.md`

Ask your agent to call:

```json
{ "op": "generate_design_md", "params": { "depth": 3, "includeAnatomy": true, "includeScreens": true } }
```

The response contains a source-grounded markdown snapshot: extraction coverage, colors,
typography, observed layout frequencies, screen composition evidence, local and
remote component usage, exact node ids/keys/variant ids/property keys, ready-to-run
instantiate examples, reuse rules, responsive evidence and known gaps. Save
it in the target codebase as **`design-kit.md`** before asking the agent to create UI
from an existing Figma component system. Facts are separated from observations and
unknown UX semantics. For a very large file, tune `maxComponents`, `maxScreens`,
`maxInstances` or `maxOutputChars`; output limits omit complete sections rather
than cutting Markdown mid-table/code-block.

> **`design.md` and `design-kit.md` are two different files** — human intent vs.
> machine snapshot, like `package.json` vs. `package-lock.json`. The tools never
> overwrite `design.md`. See the
> [two-file workflow](./docs/RECIPES.md#the-two-file-design-system-workflow).

## Architecture

```
MCP client (Claude Code / Cursor)
      │ stdio (MCP)
      ▼
 Figma Plugin MCP server (Node ≥ 18, TypeScript)
      │  owns HTTP+WS server on localhost:38470 (fallback +1..+9)
      │    GET  /health    → diagnostics JSON
      │    POST /rpc       → follower → leader forwarding (auth token)
      │    WS   /ws        → Figma plugin UI connection
      ▼
 Figma Desktop plugin
   ├── ui.html   (WebSocket client, heartbeat, reconnect w/ backoff)
   └── code.js   (Plugin API executor, safe-default handlers)
```

Every operation — leader-direct or follower-forwarded — passes through one `validateOperation()` choke point before it reaches the plugin. Full topology, the leader/follower protocol, and the safe-default fixes are documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Documentation

- [`docs/SETUP.md`](./docs/SETUP.md) — **start here**: install, daily routine, troubleshooting
- [`docs/INSTALL.md`](./docs/INSTALL.md) — installation reference: env vars, port behaviour, leader/follower
- [`docs/TOOLS.md`](./docs/TOOLS.md) — full tool + `figma.*` API reference, error codes
- [`docs/MIGRATION.md`](./docs/MIGRATION.md) — migrating from `figma-ui-mcp`
- [`docs/RECIPES.md`](./docs/RECIPES.md) — practical cookbook
- [`docs/DEMO-PROMPT.md`](./docs/DEMO-PROMPT.md) — a paste-ready prompt that demos every diagram kind plus mobile screens
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — design goals and internals

## License

MIT — see [`LICENSE`](./LICENSE).
