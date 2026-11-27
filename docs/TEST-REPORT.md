# Test report — Figma Plugin MCP

Ghi lại **đã test gì, đã sửa gì, còn gì chưa**, để khi thêm/sửa tính năng chỉ cần chạy đúng phần
liên quan thay vì test lại toàn bộ (tốn thời gian và token). Cập nhật file này trong cùng commit
mỗi khi thêm test, sửa lỗi, hoặc thử thật trên Figma (xem [Cách cập nhật](#cách-cập-nhật-file-này)).

## Trạng thái hiện tại

| | |
|---|---|
| Commit đã kiểm | `05a3742` (main, 2026-11-27) |
| Bộ test | **1669 test / 129 file — tất cả qua** (`npm run verify` = typecheck + vitest) |
| CI | GitHub Actions `verify` trên Node 20 và 22, mỗi PR và mỗi push vào `main` |
| Dependency | `npm audit`: 0 lỗ hổng (zod 4, MCP SDK 1.32) |
| Thời gian chạy full | ~25–30 s; phần lớn nằm ở vài file chậm (xem [Test chậm](#test-chậm-và-chập-chờn)) |

## Sửa chỗ nào thì chạy test nào

Chạy một nhóm: `npx vitest run <file...>`. Trước khi commit vẫn chạy `npm run verify` (CI cũng chạy),
nhưng trong lúc làm chỉ cần nhóm liên quan.

| Sửa vào | Chạy |
|---|---|
| `src/server/bridge.ts`, `route.ts`, `session.ts` | `tests/server/bridge.test.ts tests/server/reconnect.test.ts tests/shared/routing-bughunt-2026-09-17.test.ts` |
| `src/server/leader.ts`, `follower.ts`, `paths.ts`, `shutdown.ts`, `is-main.ts` | `tests/server/election.test.ts tests/server/leader*.test.ts tests/server/follower-*.test.ts tests/server/shutdown.test.ts tests/server/is-main.test.ts` |
| `src/server/index.ts` (tool list, startup) | `tests/server/server-startup.test.ts tests/server/tool-schema.test.ts tests/server/docs-claims.test.ts tests/server/tools.test.ts` |
| `src/server/executor.ts` (sandbox, `figma.*`) | `tests/server/executor*.test.ts tests/server/write-cancel.test.ts tests/server/component-ops.test.ts tests/server/export-assets.test.ts tests/server/security.test.ts` |
| `src/server/validate.ts` | `tests/server/validate.test.ts tests/server/component-ops.test.ts tests/server/executor-review-fixes.test.ts` |
| `src/server/tools.ts` (read/diagram dispatch, links) | `tests/server/figma-links.test.ts tests/server/diagram-*.test.ts tests/server/tools.test.ts` |
| `src/server/rest-read.ts`, `src/shared/figma-url.ts` | `tests/server/figma-links.test.ts` |
| `src/server/assets-export.ts` | `tests/server/export-assets.test.ts tests/server/figma-links.test.ts` |
| `src/server/patch.ts` | `tests/server/diagram-patch.test.ts tests/server/patch-rename-cascade.test.ts` |
| `src/plugin/main.ts`, `plugin/ui.html` | `tests/plugin/ui-socket.test.ts tests/plugin/handlers.test.ts tests/server/build-stamp.test.ts` |
| `src/plugin/handlers/create.ts`, `write.ts`, `insert.ts`, `keep-clear.ts` | `tests/plugin/handlers/create-*.test.ts tests/plugin/handlers/write-edge-cases.test.ts tests/plugin/handlers/modify-leaf-nodes.test.ts tests/plugin/placement-cost.test.ts tests/plugin/handlers.test.ts` |
| `src/plugin/handlers/tokens.ts`, `styles.ts`, `fonts.ts`, `text.ts` | `tests/plugin/handlers/variables*.test.ts tests/plugin/handlers/variable-modes.test.ts tests/plugin/handlers/text-*.test.ts tests/plugin/handlers/effect-styles.test.ts tests/plugin/handlers/font-and-style-cost.test.ts tests/plugin/font-fallback.test.ts` |
| `src/plugin/handlers/audit.ts` | `tests/plugin/handlers/audit-*.test.ts tests/plugin/handlers/subtree-hints.test.ts` |
| `src/plugin/handlers/read.ts`, `export.ts`, `design-system.ts`, `serialize.ts` | `tests/plugin/handlers/read-budgets.test.ts tests/plugin/handlers/list-components-cost.test.ts tests/plugin/serialize-design.test.ts tests/shared/design-system.test.ts` |
| `src/plugin/handlers/components.ts`, `variant-grid.ts` | `tests/plugin/handlers/components.test.ts tests/plugin/variant-grid.test.ts tests/server/component-ops.test.ts` |
| `src/plugin/handlers/quality.ts`, `quality-util.ts` | `tests/plugin/handlers/quality.test.ts tests/plugin/quality-util.test.ts` |
| `src/shared/component-map.ts` | `tests/shared/component-map.test.ts tests/server/component-ops.test.ts` |
| `src/plugin/diagram-live.ts`, `diagram-apply.ts`, `diagram-reflow.ts`, `*-reflow.ts` | `tests/plugin/live-*.test.ts tests/plugin/reflow-*.test.ts tests/plugin/*-reflow.test.ts tests/plugin/diagram-*.test.ts tests/plugin/activity-draw.test.ts` |
| `src/shared/<graph kind>/` (activity, sequence, state, erd, sitemap, userflow) | `tests/shared/<kind>*.test.ts` + `tests/shared/diagram-*.test.ts tests/shared/connector.test.ts tests/shared/header-height.test.ts` |
| `src/shared/{usecase,journey,persona,board}/`, `src/server/board.ts`, `handlers/board.ts` | `tests/shared/boards.test.ts tests/plugin/board-draw.test.ts` |
| `src/shared/model/` (cross-check) | `tests/shared/model-consistency.test.ts tests/shared/sitemap-consistency.test.ts tests/shared/sitemap-coverage.test.ts tests/server/diagram-consistency.test.ts tests/shared/boards.test.ts` |
| Docs, README, skills, `figma_diagram` schema | `tests/server/docs-claims.test.ts tests/server/docs-sections.test.ts tests/server/skills-*.test.ts tests/server/tool-schema.test.ts` |

## Bộ test theo khu vực

| Khu vực | File test (số test) | Tổng |
|---|---|---|
| Kết nối: bridge, định tuyến, leader/follower, startup | bridge (37), reconnect (15), election (9), leader (4), leader-file (4), follower-forward (3), follower-status (7), server-startup (2), shutdown (4), is-main (5), port-config (7), build-stamp (7), timeout-hint (2), routing-bughunt (23), ui-socket (7) | 136 |
| Sandbox `figma_write`, validate, bảo mật | executor (42), executor-worker (9), executor-review-fixes (20), write-cancel (2), validate (37), security (5), hardening (19), bughunt-batch2 (18), oss-bughunt (14), tool-result (6), tools (3), icons (6) | 181 |
| Vẽ & sửa trên plugin | handlers (34), create-guards (14), create-bulk (5), create-token-bind (9), create-vector (15), create-visible-empty-text (2), write-edge-cases (7), modify-leaf-nodes (5), group-geometry (9), pages (4), cleanup (16), set-reactions (18), selection-colors-bound (1), placement-cost (9), layout-math (36), paints (18), color-util (17), edit-util (23), base64 (6), tree-walk (3), structure-sig (3), context (6), fuzzy (8), handlers/userflow (11) | 279 |
| Token, style, font, text | variables (19), variable-modes (13), variables-lookup (7), tokens-util (6), text-styles (16), text-defaults (9), text-align (8), effect-styles (5), font-and-style-cost (6), font-fallback (13), token-format (8) | 110 |
| Đọc, audit layout, design system | read-budgets (7), list-components-cost (4), serialize-design (10), audit-style (17), audit-truncation (10), subtree-hints (6), design-system (13) | 67 |
| Component & instance | components (23), component-ops (7), variant-grid (8), component-map (11) | 49 |
| Audit chất lượng (a11y, design system, responsive) | quality (11), quality-util (8) | 19 |
| Asset & link Figma | export-assets (11), figma-links (12) | 23 |
| Sơ đồ dạng đồ thị (6 loại) + định tuyến mũi tên + live reflow | activity (42), sequence (34), sequence-text (9), state (21), state-final-captions (6), erd (20), userflow (41), userflow-route (21), sitemap-layout (20), sitemap-check (19), sitemap-text (14), connector (119), diagram-overlap (13), diagram-place (9), diagram-text (11), diagram-labels (3), diagram-model (3), diagram-spec-keys (3), diagram-bughunt (20), diagram-review (12), header-height (28), metrics-wrap (3), policy-fill (9), activity-draw (16), diagram-pin (12), diagram-redraw (15), diagram-malformed-redraw (6), live-pause (13), live-undo-nested (6), live-delete-sweep (8), reflow-midwrite (10), reflow-restore-per-box (4), userflow-reflow (17), sitemap-reflow (11), marker-list (4), activity-tool (8), userflow-tool (6), sitemap-schema (11), diagram-patch (41), patch-rename-cascade (9), diagram-verify (11) | 688 |
| Sơ đồ dạng bảng (use case, journey, persona) | boards (21), board-draw (3) | 24 |
| Kiểm tra chéo giữa sơ đồ | model-consistency (28), sitemap-consistency (12), sitemap-coverage (12), diagram-consistency (8) | 60 |
| Docs, skill, schema tool | docs-claims (9), docs-sections (7), skills-claims (8), skills-examples (3), tool-schema (6) | 33 |

## Đã thử trên Figma thật

Test tự động dùng Figma giả lập. Những gì dưới đây đã chạy trên Figma Desktop thật (file "Untitled"):

| Tính năng | Trạng thái | Ghi chú |
|---|---|---|
| Kết nối lại sau khi server khởi động lại | ✅ 2026-11-26 | ~4 s, giữ nguyên channel (trước: 30 s – 3 phút) |
| Lệnh có `file` gửi khi plugin đang kết nối lại | ✅ | Chờ rồi chạy, không lỗi ngay |
| Component: set + variant + property, instantiate, override, chép override, swap, detach, reset, componentize | ✅ | Đã sửa 9 lỗi tìm được khi thử |
| `a11y_audit`, `audit_design_system`, `apply_design_system`, `responsive_audit` | ✅ | 12 token tự gắn, tuân thủ 0% → 80% |
| Component map: export / check / `render` | ✅ | Gồm tên tiếng Việt |
| Sơ đồ use case, journey, persona | ✅ | Kiểm bằng ảnh chụp |
| `exportAssets` (plugin, iOS + Android naming) | ✅ | 8 file / 102 ms |
| Đọc và export bằng link Figma (file đang mở) | ✅ | |
| Đọc / export qua **REST** (`FIGMA_TOKEN`) | ❌ chưa | Chỉ test với API giả lập — chưa có token thật |
| File lớn (ArtMate, 2469 component) | ⚠️ một phần | Chỉ `find_component` (đọc); chưa đo hiệu năng ghi |
| Nhiều cửa sổ / nhiều session cùng lúc sau các bản sửa kết nối | ⚠️ một phần | Có test tự động; chưa thử tay với 2 file mở cùng lúc |

## Lỗi đã sửa (theo PR)

Mỗi lỗi có test hồi quy; tên file test ở cột cuối để biết test nào canh nó.

| PR | Nội dung | Test canh |
|---|---|---|
| #1 | 17 thao tác component/instance; audit a11y / design system / responsive; component map; sơ đồ use case / journey / persona; 9 lỗi tìm khi thử thật (reset property, gợi ý tên, swap, id responsive, persona bị coi là màn hình, đường use case bị che, reconnect chậm) | components, quality, component-map, boards, board-draw |
| #2 | Review toàn bộ — 53 lỗi + 5 cải tiến kết nối (chi tiết bên dưới); zod 4, 0 lỗ hổng | xem từng nhóm |
| #3 | `exportAssets`: ghi asset thẳng vào thư mục code | export-assets |
| #4 | Đọc/export bằng link Figma; REST fallback nén về dạng gọn | figma-links |
| #5 | Test 401 chập chờn: cổng ngẫu nhiên chồng nhau → keep-alive cũ | bridge (dùng `listen(0)`) |
| #6 | Test startup chập chờn: cổng ngẫu nhiên đè dải cổng cố định | bughunt-batch2, follower-forward |

### Chi tiết PR #2 (review toàn bộ)

**Kết nối** — `reconnect`, `ui-socket`, `election`, `server-startup`:
reconnect/join làm socket cũ ghi đè socket mới · session bị chuyển sang file khác khi cửa sổ đang
kết nối lại · split brain khi leader bận · resume cướp channel của cửa sổ đang sống · lệnh có
`file` lỗi ngay trong lúc chờ kết nối · gợi ý lỗi sai trạng thái (đã gửi / chưa gửi) · đổi page và
op không nguyên tử · hello gửi trước khi có thông tin file · lệnh bị huỷ vẫn chạy · không timeout
handshake · retry cổng mặc định mỗi 0.5 s · follower takeover ngay · stdio kết nối trước bầu chọn ·
plugin chạy request tuần tự · follower đăng ký lại session sau takeover.

**Executor / validate** — `executor-review-fixes`, `write-cancel`:
batch nuốt cảnh báo · timeout batch 30 s/20 item bất kể op · `exportNode({nodeId})` bị từ chối ·
`loadIcon` bỏ tuỳ chọn vị trí · `undefined` thành `null` qua sandbox · `{key}` component ref ·
state do server ghi không thấy trong cùng lệnh · gợi ý timeout sai · `load_image` URL trong batch ·
một item `null` làm hỏng cả batch · op không `await` chạy tiếp sau khi trả kết quả · tải ảnh/icon
không huỷ được · `set_instance_properties` không nhận `props`.

**Lõi vẽ plugin (hiệu năng)** — `live-delete-sweep`, `variables-lookup`, `placement-cost`,
`audit-truncation`, `read-budgets`, `list-components-cost`, `font-and-style-cost`, `write-edge-cases`:
xoá 1 node làm tính lại mọi sơ đồ · tra variable chờ tuần tự từng cái · audit clone/xoá node mỗi
đoạn chữ · keep-clear/insert/flow-mark quét cả trang mỗi node (O(n²)) · tra node chậm bị bỏ ·
không giới hạn kích thước đọc/ảnh chụp · variant bị serialize 2 lần · font/style không cache ·
kiểm sibling O(k²) · xoá component set đang dùng không cần `force` · `modify` chỉ đổi nửa font ·
phát hiện chữ bị cắt sai · đổi màu chữ nhiều màu · rebind chữ rỗng lỗi.

**Component / audit / sơ đồ mới** — `components`, `quality`, `quality-util`, `component-map`, `boards`:
a11y bỏ sót nội dung trong "menu"/"tab" · nền sau chữ tính sai (chữ trắng trên hình chữ nhật
xanh) · variant ref bỏ qua `variant` · mỗi lần tra tên quét cả file · `createVariants` để lại
component mồ côi · `addComponentProperty` gắn nhầm layer trong instance lồng · text style "khớp"
nhưng khác line height · responsive clone trong auto-layout/set · đường «include» xuyên ellipse ·
actor đè nhau · `system-…` bị nuốt · id tiếng Việt bị cắt · component map hỏng với dấu tiếng Việt ·
persona-drift quá chặt/lỏng · chép override từ instance lồng · ghi chú journey đè chấm · map
không kiểm `fixed`.

## Còn chưa làm / hạn chế đã biết

- **REST với token thật** chưa thử (xem bảng trên).
- Các hàm reflow riêng từng loại sơ đồ vẫn parse graph thêm 1 lần (2 lần/lượt thay vì 4–6).
- Khoá lưu channel của plugin theo tên file: 2 file trùng tên mở cùng lúc → cửa sổ thứ hai nhận
  channel mới (không còn mất channel, nhưng không resume được channel cũ).
- Sơ đồ use case / journey / persona là hình tĩnh: kéo hình không tự nối lại mũi tên
  (sửa bằng `update` + `patch`).
- Chưa làm: BPMN, sinh design system / UI template (đã gác lại theo yêu cầu).

## Test chậm và chập chờn

- File chậm nhất (chạy riêng khi không đụng tới): `executor-review-fixes` (~10 s),
  `executor-worker` (~7 s), `election` (~5 s), `bridge` (~4 s), `follower-forward` / `bughunt-batch2`
  (~3 s), `reconnect` (~2.6 s), `figma-links` (~2 s). Các file còn lại < 0.5 s.
- **Quy tắc cổng** (nguồn của 2 lần CI đỏ chập chờn, PR #5 và #6): test nào chỉ cần "một cổng"
  thì dùng `bridge.listen(0)` / `server.listen(0)` rồi đọc cổng thật — **không chọn cổng ngẫu
  nhiên**. Test cần cổng liền kề cố định giữ dải riêng, không chồng nhau:
  `leader-file` 46101–46200, `election` 46320–46388, `server-startup` 46420–46439.
- Thư mục `.claude/worktrees/` bị loại khỏi vitest (`vitest.config.ts`) — worktree của agent chứa
  bản sao `tests/`.

## Cách cập nhật file này

Trong cùng commit với thay đổi:
1. Thêm test mới → cập nhật số ở **Trạng thái hiện tại** và dòng tương ứng ở **Bộ test theo khu vực**;
   nếu là khu vực code mới thì thêm dòng vào **Sửa chỗ nào thì chạy test nào**.
2. Sửa lỗi → thêm dòng vào **Lỗi đã sửa** kèm tên file test canh nó.
3. Thử trên Figma thật → cập nhật bảng **Đã thử trên Figma thật** (ngày + kết quả).
4. Lấy số test: `npx vitest run --reporter=json --outputFile=/tmp/vitest.json` rồi đếm
   `numTotalTests`, hoặc đọc dòng `Tests  N passed` của `npm test`.
