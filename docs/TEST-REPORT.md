# Test report — Figma Plugin MCP

Ghi lại **đã test gì, đã sửa gì, còn gì chưa**, để khi thêm/sửa tính năng chỉ cần chạy đúng phần
liên quan thay vì test lại toàn bộ (tốn thời gian và token). Cập nhật file này trong cùng commit
mỗi khi thêm test, sửa lỗi, hoặc thử thật trên Figma (xem [Cách cập nhật](#cách-cập-nhật-file-này)).

## Trạng thái hiện tại

| | |
|---|---|
| Commit đã kiểm | `d228f75` (PR #9: 4 lượt code review) + sửa lỗi lượt 5 (15 mục, cùng PR #9) |
| Bộ test | **1987 test / 144 file — tất cả qua** (`npm run verify` = typecheck + vitest) |
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
| `src/server/rest-hub.ts`, `src/shared/rest-token.ts` (token PAT, telemetry REST) | `tests/server/rest-hub.test.ts tests/server/review-fixes-pass2.test.ts tests/server/review-fixes-pass4.test.ts tests/server/figma-links.test.ts tests/server/export-assets.test.ts` |
| `src/plugin/rest-token-store.ts` (token trong clientStorage: savedAt, Clear) | `tests/plugin/rest-token-store.test.ts tests/plugin/ui-rest-token.test.ts` |
| `src/plugin/main.ts` (handler token / ngôn ngữ) | `tests/plugin/main-rest-token.test.ts` |
| `plugin/ui.html` ô REST Token, `src/plugin/main.ts` (clientStorage token) | `tests/plugin/ui-rest-token.test.ts tests/plugin/ui-socket.test.ts` |
| `src/server/rest-features.ts` (comments, versions, design.md qua REST) | `tests/server/rest-features.test.ts tests/server/figma-links.test.ts` |
| `src/shared/figjam/`, `src/plugin/handlers/surfaces.ts` (FigJam, Slides) | `tests/shared/figjam.test.ts tests/plugin/handlers/surfaces.test.ts tests/server/figjam-diagram.test.ts` |
| `src/plugin/motion-util.ts`, `serialize.ts` (motion) | `tests/plugin/motion-util.test.ts tests/plugin/serialize-design.test.ts` |
| `src/shared/code-connect.ts`, `src/server/design-index.ts`, `html-capture.ts`, `src/shared/html-to-figma.ts`, `byok.ts` | `tests/shared/code-connect.test.ts tests/shared/html-to-figma.test.ts tests/server/phase4-tools.test.ts` |
| `src/server/html-capture.ts`, `byok.ts` (`sanitizeSvg`), `src/shared/code-connect.ts` | `tests/server/review-fixes-phase4.test.ts tests/server/review-fixes-pass2.test.ts tests/server/review-fixes-pass4.test.ts tests/shared/code-connect.test.ts` |
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
| REST token (PAT) + REST hybrid | rest-hub (63), ui-rest-token (30), rest-token-store (6), main-rest-token (6), rest-features (25), review-fixes-pass2 (30), review-fixes-pass4 (16, gồm Code Connect / SVG / htmlToFigma lượt 4–5) | 176 |
| FigJam, Slides, motion | figjam (15), surfaces (20), figjam-diagram (13), motion-util (6), serialize-design: motion (2) | 56 |
| Code Connect, chỉ mục design system, html → Figma, BYOK | code-connect (5), html-to-figma (6), phase4-tools (31), review-fixes-phase4 (31) | 73 |
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
| REST token PAT thật (hạn 1 ngày, 15 scope) qua `RestHub` + `RestClient` | ✅ 2026-11-27 | `/v1/me` → Valid (@handle), dò được đủ 15 scope; thiếu scope → báo đúng scope cần + danh sách scope đang có, token vẫn Valid; token giả → invalid 401; 404 file → NODE_NOT_FOUND; không lần nào in ra token. Phát hiện & sửa: (1) 403 thiếu scope bị báo nhầm "Figma refused the token"; (2) không có cách biết hạn token qua API → thêm ô chọn hạn; (3) plugin dev trả `fileKey: null` → bật `enablePrivatePluginApi` |
| Đọc file **chưa mở** qua link thật (`figma_read` → REST, gói Starter) | ✅ 2026-11-27 | `get_document_info`, `get_node`, `get_design_context`, `generate_design_md`, `get_comments` (0 thread), `get_versions` (4 bản), `index_design_file` + `search_design_index`, `screenshot` — tất cả OK, mỗi call 0,3–6 s, mọi request có log `[REST]`. Phát hiện & sửa: font style ra `400` thay vì `Regular`; component set mất variant; log ghi `component_sets` thành `get_file`; **429 với `Retry-After: 399946` (4,6 ngày, `plan-tier: starter`, `limit-type: low`)** trước đây làm agent treo ~4 phút rồi báo lỗi chung → giờ dừng ngay với mã `RATE_LIMITED` |
| PAT thật thứ hai (tài khoản Starter khác) với code sau review | ✅ 2026-11-27 | `Valid (@handle)`, đủ 15 scope, `scope_probe` 403 đúng như mong đợi; `get_document_info`, `get_node`, `get_comments` (trả `linkNodeId`, không lọc ngầm), `get_versions` đều 200. **Panel thật kẹt "Checking…"**: leader MCP đang chạy là build 08:40 (protocol v6, chưa biết `set_rest_token`) trong khi plugin là 15:16 → sửa: badge báo "No answer from server" sau 12 s kèm hướng dẫn khởi động lại server (ui-rest-token "a server that never answers…") |
| `postComment` trên file thật | ❌ chưa | Chưa được phép post (comment hiện cho mọi người trong file) |
| Ô **REST Token** trong panel Figma Desktop thật | ❌ chưa | Cần chạy lại MCP server + plugin bản mới |
| FigJam (`figma_diagram` native), Slides (`get_slides` / `createSlide`) | ❌ chưa | Chỉ test với `figma` giả; cần mở plugin trong một FigJam board và một deck Slides |
| `motion` trên prototype thật | ❌ chưa | Đơn vị (ms trigger / s transition) theo tài liệu Plugin API — cần đối chiếu với 1 prototype thật |
| `htmlToFigma` (Playwright thật), `generateImage` / `generateSvg` (key thật) | ❌ chưa | Test với Playwright và provider giả |
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
| #9 | **Code review lượt 5 (2026-11-27) — 15 mục, trên diff lượt 4 (`d228f75`).** Index: file khoá chỉ chứa pid (bản build cũ chạy song song đọc được, không phá nhầm), quyền sở hữu theo inode (hard link dùng chung inode) thay cho token; ổ không có hard link (exFAT, SMB) dùng tạo file độc quyền thay vì luôn ghi không khoá; tên file tạm có thời gian + chuỗi ngẫu nhiên (không trùng khi pid bị dùng lại); khoá không có pid bị phá sau 3 s; docs ghi rõ là "best effort" và không hỗ trợ thư mục cache dùng chung giữa nhiều máy. FigJam: marker lưu id section → chỉ section NHÂN BẢN mới dùng tag (section gốc bị xoá hết shape vẫn giữ bản dán); quét connector theo Set, bỏ qua connector trong instance; section marker hỏng được `get_page_model` liệt kê `unreadable`; cảnh báo không còn nói "bị khoá". Server: nhận diện câu lỗi của plugin cũ không còn neo `$`. Panel: mất kết nối lúc đang kiểm giữ nguồn + bản che token, Save bị từ chối sau đó trả về badge trước. SVG: entity phân biệt hoa/thường như XML. Code Connect: dấu nháy chỉ mở chuỗi ở nơi biểu thức bắt đầu được (sau `(`, `,`, `=`, `:`… hoặc `return`/`case`…), hai dấu `'` trong chữ JSX không còn ghép thành chuỗi. htmlToFigma: dòng của `*-reverse` tìm theo hộp đo được (chồng lấn trục phụ), không theo `flex-wrap`; trùng vị trí giữ thứ tự DOM đảo. Test Retry-After kiểm đúng mốc `retryAt − 1` / `retryAt` | review-fixes-pass4 ("fifth pass"), phase4-tools ("holds just the pid", "names no pid"), surfaces ("redraw, fifth pass"), ui-rest-token ("fifth pass"), review-fixes-pass2 ("Retry-After longer than a timer") |
| #9 | **Code review lượt 4 (2026-11-27) — 17 mục, trên diff lượt 3 (`6985e88`).** Index: khoá được ghi đầy đủ vào file riêng rồi `link` vào chỗ (không còn lúc đọc thấy file rỗng rồi coi là tiến trình chết); chỉ phá khoá của tiến trình đã chết (khoá của tiến trình còn sống chỉ sau 30 s); sau khi rename thì kiểm lại và trả khoá về nếu vừa có người lấy; chỉ xoá khoá còn là của mình; không quay vòng khi lỗi khác ENOENT. Code Connect: dấu `'` không đóng (chữ JSX `Don't`, regex) là ký tự thường, không nuốt hết dòng; `props:` phải ở đầu từ. FigJam: connector của người dùng ở bất kỳ đâu trên page được nối lại, đầu không nối được thì cảnh báo thay vì lỗi giữa chừng; section nhân bản (danh sách `drawn` không khớp) dùng lại tag; marker hỏng vẫn là FigJam; plugin bản cũ (đúng câu lỗi cũ) không bị vẽ đè bằng khung Design. Token: `gen` bắt đầu ngẫu nhiên ở mỗi tiến trình (leader mới không trùng key cache), `tokenGen` có ngay từ đầu và được phát cho listener, follower không cache khi chưa biết token của leader; badge không kẹt "Checking…" khi socket đóng. SVG: tham chiếu ký tự XML không cho phép (`&#0;`, `&#xD800;`) bị escape. htmlToFigma: `*-reverse` một dòng chỉ sắp theo trục chính. Test: thay `_onTimeout` / gán field private bằng fake timer và `now`, pid "chết" thật lấy từ tiến trình con, thêm test EACCES thật | review-fixes-pass4, phase4-tools ("third pass: lock file…"), surfaces ("redraw, fourth pass"), figjam-diagram ("fourth pass"), ui-rest-token ("fourth pass"), review-fixes-pass2 ("third pass: rest-hub") |
| #9 | **Code review lượt 3 (2026-11-27) — 18 mục, trên diff lượt 2.** FigJam: `get_diagram_spec` trả `{ native: "figjam", spec: null }` có cấu trúc (không còn phân nhánh bằng regex trên message có tên node); section của bản build đầu vẽ lại TẠI CHỖ bằng spec đầy đủ; section ghi id các node đã vẽ (`drawn`) → bản copy người dùng dán và connector của người dùng được giữ / nối sang shape mới; lỗi đọc page model sau khi vẽ thành công chỉ là cảnh báo. Token: key cache của follower theo thế hệ token của leader (`tokenGen`, cả khi follower có `FIGMA_TOKEN`), timer `Retry-After` > 24,8 ngày không hết sớm, `anySignal` gỡ listener (Node 18), `rebroadcast` không phát 2 lần; badge "No answer" bị huỷ khi socket đóng. Index: khoá chỉ chờ khi `EEXIST`, phá khoá của tiến trình chết ngay và nguyên tử (rename), `index_design_file` với kit thiếu chỉ gộp. Code Connect: bộ quét bỏ qua template literal kể cả `${…}` lồng, tìm `props:` chỉ trong code, `collisions` tách khỏi `invalid` và chỉ giữa các tên có tạo file, cho phép `_`/`$` đầu tên. SVG: entity ngoài dải Unicode, `<svg/>` tự đóng, `&` trong text, độ sâu chỉ giảm khi thẻ đóng khớp. htmlToFigma: tên layer mặc định bỏ credentials / query; `*-reverse` nhiều dòng. Test: bỏ `sleep` cố định, test UI chặt hơn, hàm ghép trạng thái follower (`mergeFollowerRestStatus`) được test như server chạy | review-fixes-pass2 ("third pass…", "sanitizeSvg, third pass"), surfaces ("redraw, third pass"), figjam-diagram ("legacy FigJam sections, third pass"), phase4-tools ("third pass: lock file…"), review-fixes-phase4 ("htmlToFigma third pass"), ui-rest-token |
| #9 | **Code review lượt 2 (2026-11-27) — 27 mục + D4.** Token: token mới được kiểm ngay cả khi token cũ đang 429; mọi `set_rest_token` đều được trả `rest_status` (badge không kẹt rồi báo nhầm "No answer"); hết rate-limit được phát cho panel (timer), 429 không có `Retry-After` mặc định 60 s; dò scope lỗi được hỏi lại; follower không gửi lại POST bằng token riêng; token chỉ đi trên socket đã nhận `assigned`; giữ input khi bị từ chối; ngôn ngữ vừa bấm không bị đè; `anySignal` cho Node 18; `PROTOCOL_VERSION` 8. FigJam: vẽ lại vào section xong mới gỡ bản cũ, lỗi giữa chừng giữ nguyên bản cũ + model, giữ nội dung người dùng tự thêm; `get_page_model` và cross-check thấy section; key cũ `figjam-diagram` → "vẽ lại một lần"; lỗi `get_diagram_spec` không rơi sang nhánh vẽ Design. Index: không gộp 2 file trùng tên, khớp theo node id (đổi tên), khoá file khi ghi, đọc có giới hạn / kit thiếu chỉ gộp, bỏ component thư viện (`remote`). Code Connect: bỏ qua comment/chuỗi, dấu nháy trong comment, gộp giá trị enum, báo `conflicts`, tên phải là component JSX (chữ hoa, không từ khoá, không trùng hoa/thường). SVG: giải mã entity trước khi kiểm, chỉ lấy `<svg>` đầu, đóng thẻ còn mở. **D4 (quyết định của người dùng): `htmlToFigma` mở mọi host http(s), không chặn gì** (chỉ từ chối `file:`/`data:`/`javascript:`); cảnh báo không lặp; `*-reverse` không có gap đo đúng. Lỗi tìm thêm khi viết test: shape lỗi giữa chừng lúc vẽ lại không được gỡ (ghi nhận ngay khi append) | review-fixes-pass2, main-rest-token, ui-rest-token ("review fixes (second pass)", "a server that never answers…"), surfaces ("redraw into a section, second pass"), figjam-diagram ("second pass"), phase4-tools ("two files that share a NAME", "renamed", "lock file", "capped and incomplete"), review-fixes-phase4 ("opens any http(s) host") |
| #9 | **Code review 2026-11-27 (3 lớp: Blind / Edge Case / Acceptance) — 31 mục.** Token: không còn trong `hello` (chỉ gửi qua `set_rest_token` sau `assigned`), `savedAt` để cửa sổ cũ không đem token/Clear cũ về, Clear lúc mất kết nối được gửi lại, `invalid` hồi lại khi request thành công / lưu lại, input rác không đổi gì, hạn có thể xoá, ký tự vô hình bị từ chối, dò scope 1 lần/token, re-check 403 tối đa 1 lần/5 phút, 429 tự hết theo `retryAt`, timeout + `redirect:error`, `__rest_fetch__` chỉ GET + POST comments, follower fallback khi leader cũ, cache theo token của leader, badge vàng khi thiếu scope dù có hạn, ngôn ngữ lưu qua clientStorage. REST: `postComment` không còn ghi nhầm file khi link sai, comments không lọc ngầm theo `node-id` của link, `restDesignKit` ghi chú phần đọc lỗi + dừng khi 429 + gộp component local, `exportAssets` trên follower dùng token của leader, cửa sổ đích theo session đã gắn. Index: đọc một phần chỉ gộp, chữ không Latin, gộp file theo tên→key, design.md qua REST tự index. Code Connect: `() =>` cho component không prop, tên không phải identifier bị bỏ (chặn path traversal / chèn mã), parser quote-aware, gộp nhiều connection, `use:true` không xoá map. BYOK: `sanitizeSvg` theo allowlist, timeout, báo SVG bị cắt, NaN. htmlToFigma: (lượt 1 giới hạn localhost — đã bỏ ở lượt 2 theo D4, xem dòng dưới), màu oklch, `*-reverse`, phần tử absolute, root rỗng, lỗi Playwright có hướng dẫn. FigJam: thêm usecase/journey/persona, section lưu model (`get_diagram_spec`, `update`/`patch` vẽ lại đúng section), dọn khi lỗi giữa chừng, chiều cao theo dòng xuống, id trùng; `createSlide` col không row | rest-hub ("review fixes: …"), ui-rest-token, rest-token-store, rest-features ("review fixes"), phase4-tools ("review fixes: design index"), review-fixes-phase4, figjam, surfaces, figjam-diagram, serialize-design (motion) |
| (chưa có PR) | Thử PAT thật: lỗi thiếu scope (403 "Invalid scope") bị coi là token hỏng/không có quyền; thêm phân loại lỗi theo body thật, dò scope khi kiểm token, hạn token do người dùng chọn lúc Save, `enablePrivatePluginApi` cho `fileKey` | rest-hub ("reading Figma's failures…", "scopes and expiry…"), ui-rest-token ("token expiry…"), rest-features, export-assets |
| (chưa có PR) | Nâng cấp REST token / FigJam / Slides / Code Connect. Lỗi tìm được khi viết test: (1) token thay trong lúc đang kiểm `/v1/me` thì token mới không bao giờ được kiểm (dùng chung promise của lần kiểm cũ) — giờ mỗi token có lượt kiểm riêng; (2) `htmlToFigma` lấy khoảng cách trung vị trên (khoảng lớn hơn) khi chỉ có 2 khoảng — giờ lấy trung vị dưới | rest-hub ("drops the result of a check…"), html-to-figma ("block children that stack…") |

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

- **Hạn mức REST gói Starter rất nhỏ** cho các endpoint đọc file (Tier 1): khoảng một chục lệnh đọc khi test đã hết quota, `Retry-After` 4,6 ngày. `generate_design_md` qua REST tốn ~5 request Tier 1. Khi file đang mở, tool luôn ưu tiên đường plugin (không tốn quota); comments/versions thuộc tier khác, vẫn chạy được.
- Style chưa publish chỉ đọc được qua REST nếu đang được dùng trong 2 tầng node đầu (`/styles` chỉ trả style đã publish).
- Sự kiện `[REST]` của một **follower** dùng `FIGMA_TOKEN` riêng (khi leader không có token) chỉ phát trong process follower, không hiện ở panel (follower không có bridge). Request chạy qua token của leader thì hiện bình thường.
- FigJam: sequence và erd vẫn vẽ dạng frame Figma Design (có chủ đích — connector FigJam không giữ thứ tự lifeline, không có đầu crow's-foot). Slides chỉ đọc lưới + tạo slide. Chưa thử trên board / deck thật.
- `htmlToFigma` không chụp pixel ảnh (ảnh là placeholder), không đọc pseudo-element, gradient hay shadow; container có phần tử `position:absolute` giữ layout tuyệt đối (không auto-layout) vì `create()` chưa hỗ trợ `layoutPositioning`.
- `htmlToFigma` mở mọi host http(s) — kể cả mạng LAN và địa chỉ metadata — theo quyết định của người dùng (D4). Chưa thử với Playwright thật.
- Hoãn từ review lượt 5: (1) khoá index vẫn có khe hở rất nhỏ khi trả khoá về hoặc giải phóng (hệ thống file không có so-rồi-đổi-tên nguyên tử; index chỉ là cache); (2) thư mục cache dùng chung giữa nhiều máy (pid chỉ có nghĩa trên một máy); (3) plugin bản cũ + section FigJam có marker hỏng vẫn có thể bị vẽ khung Design; (4) follower không cache khi chưa biết token của leader (mỗi lần gọi một client mới).
- Hoãn từ review lượt 4: (1) section FigJam cũ (chưa có danh sách `drawn`): connector người dùng vẽ giữa hai shape của tool vẫn bị coi là của tool và bị gỡ khi vẽ lại; (2) `exportCodeConnect` với `overwrite: true` không so tên khác hoa/thường với file đã có trên đĩa (`button.figma.tsx` và `Button`); (3) `anySignal` trên Node 18 giữ listener tới khi timeout (luôn có timeout đi kèm nên rò rỉ có giới hạn).
- Index của file chưa có `fileKey` lưu theo tên: hai file "Untitled" không key dùng chung mục; mục theo tên tồn tại song song mục theo key (hoãn — plugin đã tự báo `fileKey` nhờ `enablePrivatePluginApi`, chỉ còn dữ liệu cũ).
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
