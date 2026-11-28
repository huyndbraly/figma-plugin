**[Tiếng Việt](./README.md)** | [English](./README.en.md)

# Figma Plugin MCP

**Một MCP server cho phép các AI agent đọc và vẽ trực tiếp lên canvas Figma — một cách an toàn.** Mã nguồn mở (MIT).

Figma Plugin MCP kết hợp một MCP server chạy cục bộ (local) với một plugin đồng hành trên Figma Desktop. Khi kết nối Claude Code, Cursor, Codex hoặc bất kỳ agent nào hỗ trợ MCP, agent có thể kiểm tra file Figma và vẽ lên canvas bằng cách thực thi JavaScript thông qua proxy API `figma.*` — trong đó lớp plugin sẽ tự động chặn các lỗi thường biến "AI vẽ màn hình" thành "AI vẽ một mớ bị tràn viền, cắt xén lung tung". Công cụ này tạo và sử dụng component thật (variants, properties, instances), kiểm tra khả năng truy cập (accessibility), độ tuân thủ design system và tính responsive, đồng thời vẽ các sơ đồ BA mà một bản spec cần — userflow, activity, sequence, ERD, sitemap, state machine, use case, journey map, persona set — và tự động rà soát (proof-read) mô hình dữ liệu đằng sau mỗi sơ đồ.

Dự án này ra đời vì phần lớn các Figma MCP khác đẩy trách nhiệm kỷ luật về phía agent — những thứ mà agent thường không làm tốt: nhớ không được phủ một frame bán trong suốt đè lên trên, khai báo lại map token ở mỗi lần gọi, tự tính tay tọa độ x/y, hay nhìn ảnh chụp màn hình để đoán xem chữ có bị cắt không. Dự án này đưa toàn bộ kỷ luật đó vào server và plugin, đồng thời cung cấp cho agent một cơ chế có cấu trúc để tự kiểm chứng kết quả của mình.

## Tính năng nổi bật

| Nhóm tính năng | Bạn nhận được gì |
|---|---|
| **Kết nối** | Cầu nối Figma kèm chẩn đoán chi tiết và gợi ý bước tiếp theo (`hints`); hỗ trợ nhiều cửa sổ Figma và nhiều AI agent cùng lúc (leader/follower); một lệnh khởi chạy cho Claude Code, Cursor và Codex; cầu nối cục bộ được bảo vệ (JS sandbox, chuyển tiếp có xác thực); bảng quy tắc và tài liệu theo yêu cầu cho agent |
| **Đọc và vẽ** | Trang (pages), layers, vùng chọn (selection), ảnh chụp màn hình và xuất file; frames, text, shapes và streaming theo batch; kiểm tra layout (`layout_audit` phát hiện tràn khung, bị cắt, text bị rút gọn); nội dung mới không bao giờ đè lên nội dung cũ |
| **Design system** | Tokens và variables (tạo, gán/bind, sửa, import/export); text và effect styles; đọc design system hiện có và xuất ra `design-kit.md`; kiểm tra tuân thủ (cái nào đã bind, cái nào trùng giá trị token, cái nào nằm ngoài hệ thống) và tự động bind chỉ với một lần gọi |
| **Components** | Tìm theo tên, tìm-hoặc-tạo, chuyển frame thành component (và đổi các bản sao thành instances), sắp xếp variants theo lưới, gán component properties tới các layer trong mọi variant, tạo instance kèm variant + properties, ghi đè instance (overrides), hoán đổi (swap), tách (detach), đặt lại (reset) |
| **Chất lượng** | Kiểm tra Accessibility (độ tương phản WCAG, vùng chạm 44pt, chữ quá nhỏ, nút chưa đặt tên); kiểm tra Responsive (tạo bản sao màn hình, kéo giãn theo kích thước điện thoại / máy tính bảng / desktop và kiểm tra từng màn hình) |
| **Code ↔ Figma** | Bản đồ ánh xạ giữa code component và Figma component (props ↔ variants và properties): xuất bản đồ khởi đầu, đối chiếu với file Figma, và dùng `render("Button", { tone, size, children })` để vẽ đúng variant Figma tương ứng |
| **Tài nguyên (Assets)** | Icons, hình ảnh, overlays, gradients, đổi màu (recolor), prototype reactions; xóa pages và styles, dọn dẹp styles không dùng. Chèn ảnh bằng `loadImage({ filePath })` / `{ imageUrl }` — server tự đọc/tải, agent không phải cầm chuỗi base64; ảnh nền trong suốt do AI tự tách bằng `generateImage(prompt, { transparent: true })`; tự vẽ icon/minh họa bằng SVG thành vector chỉnh sửa được (`create({ type: "ICON", svg })`) |
| **Sơ đồ BA / UX** | Userflow, activity có swimlanes, sequence, ERD, sitemap, state machine, use case, journey map, persona set; mũi tên tự bám theo khối hộp; chỉnh sửa sơ đồ tại chỗ; kiểm tra chéo mâu thuẫn giữa các sơ đồ |
| **REST hybrid (PAT)** | Dán Figma personal access token ngay trong panel plugin (ô `REST Token`, Save/Clear, badge `Valid (@handle)` / `Expired / Invalid` / `Rate-limited`); token chỉ lưu trên máy bạn (`figma.clientStorage`), server giữ trong RAM, không ghi file, không log, không trả về cho agent. Đọc comments, trả lời/tạo comment, lịch sử phiên bản, đọc file **chưa mở** qua link hoặc `fileKey` (kể cả `generate_design_md`); mọi request REST hiện trong ACTIVITY với nhãn `[REST]` |
| **FigJam · Slides · Motion** | Trong FigJam, `figma_diagram` vẽ bằng node gốc: userflow / activity / state / sitemap / usecase bằng shape + connector tự bám, persona / journey bằng sticky; section lưu model nên `update`/`patch` và kiểm tra chéo vẫn dùng được (sequence / erd giữ dạng frame). Đọc/tạo slide trong Figma Slides; đọc `motion` của prototype (trigger, SMART_ANIMATE, duration, easing bezier/spring, chuỗi CSS) để sinh code animation — cả với file **chưa mở** đọc qua REST (`url` / `fileKey`) |
| **Mở rộng** | Xuất/đọc file Code Connect `.figma.tsx` từ component map; chỉ mục design system đa file cục bộ (`.figma-cache/`, `search_design_index`); `htmlToFigma(url)` dựng trang web đang chạy thành cây auto-layout (Playwright tùy chọn); sinh ảnh (OpenAI / Gemini / Flux) và SVG (Anthropic) bằng API key của bạn (BYOK) — dán key ngay trong ô **AI Image Key** của panel plugin — rồi chèn lên canvas |
| **Claude skills** | `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-erd`, `/figma-sitemap`, `/figma-state`, `/figma-usecase`, `/figma-journey`, `/figma-persona` |

## Tại sao chọn dự án này

| | Figma MCP thông thường | Figma Plugin MCP |
|---|---|---|
| Kiểm chứng kết quả | Chỉ dựa vào ảnh chụp — agent tự nhìn pixel để đoán | `layout_audit` trả về kích thước khai báo vs. kích thước render thực tế, `overflowsParent`, `clippedBy`, `textTruncated` cho từng node; ảnh chụp chỉ dùng cho bước duyệt cuối của con người |
| Lớp phủ / Scrims | Agent làm mờ màn hình bằng cách chỉnh opacity của FRAME (làm mờ toàn bộ cây con bên trong) | `figma.overlay()` tạo một RECTANGLE đúng lớp — lỗi này bị loại bỏ ngay từ cấu trúc |
| Trạng thái phiên (Session state) | Phải khai báo lại token maps và bảng ID ở mỗi lần gọi | `state` là object lưu xuyên suốt phiên làm việc; thiết lập token một lần, dùng lại ở mọi lần gọi sau |
| Components | Agent tự copy frame hoặc phải tự nhớ/xử lý component ID giữa các lần gọi | Component được gọi theo **tên**; `instantiate("Button", { variant, properties })` tự động giải mã component set, variant và các key property dạng `#1:2` |
| Kết nối | Chỉ trả về boolean im lặng, hoặc WebSocket chết không rõ lý do | `figma_status` trả về thông tin chẩn đoán kèm danh sách `hints` theo thứ tự các bước xử lý cụ thể |
| Nhiều cửa sổ IDE | Server thứ hai tranh giành cổng (port) hoặc âm thầm lỗi | Cơ chế bầu chọn Leader/Follower; các follower chuyển tiếp qua `/rpc` có xác thực tới một leader duy nhất đang giữ kết nối plugin |
| Thao tác hàng loạt (Batch) | Giới hạn cứng (ví dụ 50 ops) và lỗi một chỗ là hỏng toàn bộ | Streaming theo từng chunk, commit từng phần, báo lỗi chính xác theo từng chỉ mục (index), không giới hạn cứng |
| Frame cấu trúc (Wrapper) | Màu nền trắng mặc định của Figma biến các wrapper layout thành các mảng trắng vô duyên | FRAME/COMPONENT không khai báo fill sẽ mặc định trong suốt; bề mặt có nền phải tự khai báo rõ |
| Sandbox JS | Cú pháp cũ/hạn chế (không có `?.`, `??`, spread) | Node `vm` — hỗ trợ đầy đủ ES hiện đại (optional chaining, nullish coalescing, spread, async/await) |
| Báo lỗi | Ngoại lệ thô (bare exceptions) | Mọi lỗi đều có `{code, message, hint}` — `hint` chỉ rõ bước tiếp theo cần làm |
| Chỉnh sửa tại chỗ | Tập trung vẽ mới từ đầu; thao tác rời rạc dễ xung đột với plugin đơn luồng | Quy trình ưu tiên vùng chọn (`readSelection` → sửa → `layout_audit`), sao chép instance-override, đổi màu đệ quy, sửa text an toàn với mixed-font; các lệnh ghi được tuần tự hóa theo từng kết nối để không bao giờ bị race condition |
| Sơ đồ (Diagrams) | Render chữ Mermaid/PlantUML thành ảnh — mỗi sơ đồ là một ốc đảo tách biệt | Mỗi frame sơ đồ **lưu giữ mô hình dữ liệu gốc**: chỉnh sửa bằng `update` + `patch` thay vì vẽ lại từ đầu, và công cụ tự kiểm tra xem các sơ đồ trên cùng một trang có mâu thuẫn nhau không |
| Quy tắc nghiệp vụ có con số | Con số `10 phút` bị gõ lặp lại ở 4 sơ đồ; sửa một chỗ, ba chỗ kia quên sửa | `options.policies` giữ giá trị tại một nơi duy nhất và nhãn tham chiếu qua `@hold-minutes` — nhãn không thể lệch khỏi giá trị gốc |

Xem [`ARCHITECTURE.md`](./ARCHITECTURE.md) để hiểu đầy đủ lý do thiết kế và các cơ chế xử lý tận gốc đằng sau những mặc định này.

## So sánh: REST API vs. Figma MCP vs. Figma Plugin MCP

| Nhóm & Tính năng | Figma REST API (PAT) | Official / Typical Figma MCP | Figma Plugin MCP (Repo này) |
|---|---|---|---|
| **Cài đặt, Xác thực & Kiến trúc** | | | |
| Xác thực bằng Personal Access Token (PAT) / OAuth | ✅ (High) — PAT / OAuth | ✅ (High) — OAuth / Tài khoản Figma | ✅ (Medium) — Cầu nối local + phiên Figma Desktop; **PAT tùy chọn** dán trong panel plugin (lưu trên máy bạn, badge báo hợp lệ / scope / hạn / 429, không lộ cho AI); dự phòng `FIGMA_TOKEN`. Chưa có OAuth |
| Truy cập từ xa qua URL Figma (không cần cài plugin local) | ✅ (High) | ✅ (High) — Remote MCP qua URL | ⚠️ (Medium, cần PAT) — Đọc file **chưa mở** qua link/`fileKey` (`get_node`, `get_design_context`, `generate_design_md`, `screenshot`, `exportAssets`, comments, versions); MCP server vẫn chạy local, thao tác ghi vẫn cần plugin. Phụ thuộc hạn mức REST của gói |
| Chạy Headless / CI-CD (không cần mở Figma Desktop) | ✅ (High) | ✅ (Medium — với Remote MCP đọc file) | ⚠️ (Low–Medium, cần PAT / `FIGMA_TOKEN`) — Đọc, render, xuất asset, comments, versions chạy được không cần Figma Desktop; mọi thao tác ghi canvas vẫn cần mở plugin. Bị giới hạn quota ở gói Starter |
| Hỗ trợ nhiều IDE / nhiều AI agent cùng lúc | ✅ (High) — HTTP không trạng thái | ✅ (Medium — Remote MCP) / ❌ (Low — Desktop local) | ✅ (High) — Cơ chế Leader/Follower qua `/rpc` |
| Quản trị Enterprise SSO, phân quyền seat & audit log | ✅ (High) | ✅ (High) — Chuẩn quyền Figma Cloud | ❌ (Chạy cầu nối cục bộ, không qua cloud governance) |
| Độ đơn giản khi cài đặt | ✅ (High) — Chỉ cần HTTP token | ✅ (High) — Hosted / bật 1 chạm trong Figma | ✅ (Medium) — Clone, build server + import manifest |
| Chịu tải / không lo bị giới hạn Rate-limit | ❌ (Low — giới hạn chặt theo REST quota) | ✅ (Medium) | ✅ (High — đường plugin qua WebSocket cục bộ, không tốn quota REST; luôn được ưu tiên khi file đang mở). Đường REST tùy chọn chịu quota của gói — **rất nhỏ ở Starter** (đo thực tế: `429`, `Retry-After` ≈ 4,6 ngày sau khoảng chục lệnh đọc file) — và báo ngay `RATE_LIMITED` kèm thời điểm thử lại thay vì treo |
| **Agent Đọc dữ liệu & Mức độ sử dụng Token** | | | |
| Đọc pages, layers, styles & metadata | ✅ (High) — JSON toàn bộ file | ✅ (High) | ✅ (High) |
| Đọc vùng đang chọn trên canvas (`read_selection`) | ❌ (Phải tự truyền thủ công node ID) | ✅ (Medium) | ✅ (High — quy trình selection-first) |
| Tối ưu Token (chi phí ngữ cảnh cho LLM) | ❌ (Low — JSON thô cực lớn, tốn rất nhiều token) | ✅ (Medium — ngữ cảnh đã cấu trúc) | ✅ (High — các `op` gọn nhẹ, `maxOutputChars`, sơ đồ dạng text) |
| Lưu trạng thái xuyên suốt phiên (`state`) | ❌ | ❌ (Phải khai báo lại map ở mỗi lần gọi) | ✅ (High — `state` lưu bền vững theo phiên) |
| Đọc quy tắc & tài liệu theo nhu cầu (`figma_rules`, `figma_docs`) | ❌ | ✅ (Medium — rules/skills) | ✅ (High — rule sheet từ design system thật + 16 chủ đề doc) |
| Xuất bản snapshot `design-kit.md` chuẩn xác cho code | ❌ | ❌ | ✅ (High — `generate_design_md` kèm đầy đủ ID & cách dùng) |
| **Ghi & Thao tác trực tiếp trên Canvas** | | | |
| Tạo / sửa / xóa frames, text & shapes | ❌ (REST API chỉ đọc canvas) | ✅ (Medium — qua `use_figma` / tools) | ✅ (High — đầy đủ proxy `figma.*` + ES VM hiện đại) |
| Auto-layout & mặc định cấu trúc an toàn | ❌ | ✅ (Low — dễ vướng bẫy Plugin API gốc) | ✅ (High — frame bọc trong suốt, text tự xuống dòng) |
| Lớp phủ / Scrims an toàn (không làm mờ cả cụm con) | ❌ | ❌ (Dễ mắc lỗi chỉnh opacity của Frame) | ✅ (High — `figma.overlay()` ép tạo Rectangle an toàn) |
| Tự động đặt vị trí không đè lên thiết kế cũ | ❌ | ❌ (Phải tự tính tọa độ x/y) | ✅ (High — tự né các vùng đã có nội dung) |
| Streaming theo batch & commit từng phần | ❌ | ❌ (Giới hạn cứng / lỗi một là hủy hết) | ✅ (High — stream từng chunk, báo lỗi theo từng index) |
| Chỉnh sửa tại chỗ & sửa text an toàn với mixed-font | ❌ | ✅ (Low) | ✅ (High — tuần tự hóa lệnh ghi, recolor đệ quy) |
| Tạo Prototype reactions & tương tác | ❌ | ✅ (Medium) | ✅ (High) |
| **Components & Design Systems** | | | |
| Đọc Variables / Design Tokens (không cần gói Enterprise) | ❌ (Variables REST API bắt buộc gói Enterprise) | ✅ (Medium) | ✅ (High — chạy trên mọi gói Figma qua Plugin API) |
| Tạo & gắn (bind) Variables / Text & Effect Styles | ❌ | ✅ (Medium) | ✅ (High — `setupTokens`, `applyVariable`, import/export) |
| Tạo Component Sets, Variants & Properties | ❌ | ✅ (Medium) | ✅ (High — xếp lưới + tự bind property vào layer) |
| Tạo Instance theo tên (tự giải mã variant & key `#id`) | ❌ | ❌ (Phải dùng ID/key thô) | ✅ (High — `instantiate("Button", { variant, properties })`) |
| Tìm kiếm thư viện Design System toàn team/org trên Cloud | ✅ (Medium) — Team/file endpoints | ✅ (High) — `search_design_system`, `get_libraries` | ⚠️ (Low–Medium) — Chỉ mục đa file cục bộ (`search_design_index`) gồm mọi file máy này đã đọc; thêm file chưa mở qua PAT (`index_design_file`). Không tìm toàn org trên cloud |
| Ánh xạ Code ↔ Figma component | ❌ | ✅ (High) — Code Connect đồng bộ Cloud Dev Mode | ✅ (Medium) — `export_component_map` + `render()` cục bộ, xuất/đọc file Code Connect `.figma.tsx` (không publish lên cloud) |
| Kiểm tra tuân thủ Design System & tự động bind | ❌ | ❌ | ✅ (High — `audit_design_system` + auto-bind 1 lệnh) |
| **Kiểm chứng & Chất lượng Sản phẩm Đầu ra** | | | |
| Xuất ảnh / Chụp màn hình (Screenshot) | ✅ (High — render PNG/SVG từ server) | ✅ (High) | ✅ (High) — render qua plugin; file chưa mở render qua REST bằng PAT |
| Kiểm tra layout bằng code (tràn khung / cắt chữ) | ❌ | ❌ (Agent tự nhìn ảnh chụp để đoán) | ✅ (High — `layout_audit` trả về tọa độ & cờ lỗi từng node) |
| Kiểm tra Accessibility (độ tương phản WCAG, nút 44pt) | ❌ | ❌ | ✅ (High — `a11y_audit`) |
| Kiểm tra Responsive đa màn hình | ❌ | ❌ | ✅ (High — tự kéo giãn bản sao sang phone/tablet/desktop) |
| Chẩn đoán lỗi kèm hướng dẫn (`code`, `message`, `hint`) | ❌ (Chỉ có HTTP status code) | ✅ (Low) | ✅ (High — gợi ý bước xử lý tiếp theo) |
| **Chất lượng đầu ra: UI / Thiết kế trong Figma** | ❌ (Không vẽ được) | ✅ (Medium — dễ bị đè khung/cắt chữ) | ✅ (High — layout, token và component đã được kiểm chứng) |
| **Chất lượng đầu ra: Code do Agent sinh ra** | ✅ (Low — JSON thô nhiễu, thiếu ngữ cảnh a11y/layout) | ✅ (High — Code Connect & ngữ cảnh tốt) | ✅ (High — `design-kit.md` + token chính xác + `render()`) |
| **Sơ đồ BA / UX & Tài liệu Đặc tả** | | | |
| Vẽ sơ đồ BA/UX (9 loại) | ❌ | ✅ (Medium — FigJam Mermaid) | ✅ (High — Userflow, Activity, Sequence, ERD, Sitemap, State, Use Case, Journey, Persona) |
| Sơ đồ gắn với mô hình dữ liệu & sửa tại chỗ (`update`/`patch`) | ❌ | ❌ (Ảnh tĩnh / phải vẽ lại toàn bộ) | ✅ (High — lưu model trong frame, vá trực tiếp) |
| Kiểm tra logic nghiệp vụ & kiểm tra chéo giữa các sơ đồ | ❌ | ❌ | ✅ (High — bắt ngõ cụt, thiếu PK/FK, lệch luồng...) |
| Quy tắc nghiệp vụ tập trung một nguồn (`@policies`) | ❌ | ❌ | ✅ (High — chống lệch số liệu giữa các sơ đồ) |
| Đường nối thông minh (kéo hộp thì mũi tên tự chạy theo) | ❌ | ✅ (Medium — connector của FigJam) | ✅ (High — tự động định tuyến lại khi di chuyển) |
| **Sáng tạo AI, Media & Đa nền tảng Figma (Bản chính thức / Trả phí)** | | | |
| Tạo ảnh AI & minh họa vector AI (`generate_image`, `generate_vector_illustration`) | ❌ | ✅ (High) | ✅ (Medium, BYOK) — `generateImage` (key OpenAI / Gemini / Flux của bạn, dán trong panel plugin) / `generateSvg` (key Anthropic, SVG đã làm sạch), chèn thẳng lên canvas |
| Đọc ngữ cảnh Motion / Animation & keyframes (`get_motion_context`) | ❌ | ✅ (High) | ✅ (Medium) — transition của prototype dạng `motion` (SMART_ANIMATE, duration, bezier/spring, CSS); chưa có keyframes |
| Tạo Custom Shaders, Generative Plugins & Weave AI workflows | ❌ | ✅ (High) | ❌ |
| Chuyển Web/HTML chạy thực tế thành Figma Design (`generate_figma_design`) | ❌ | ✅ (High) | ✅ (Medium) — `htmlToFigma(url)` với Playwright tùy chọn: flex → auto-layout, font/màu theo CSS thật; ảnh là placeholder; mở mọi host http(s) (localhost, LAN, công khai) |
| Xuất Video (`export_video`) | ❌ | ✅ (High) | ❌ |
| Hỗ trợ FigJam, Figma Slides, tạo file mới & Branching (`create_branch`) | ❌ (Chỉ đọc) | ✅ (High) — Hỗ trợ gốc FigJam, Slides, Branching | ✅ (Medium) — Sơ đồ FigJam bằng node gốc cho 7/9 loại (shape + connector, sticky cho persona/journey), lưu model để patch; đọc/tạo slide cơ bản; chưa tạo file mới / branching |
| **Cộng tác & Dữ liệu Đám mây (Cloud Metadata)** | | | |
| Bình luận (comments), lịch sử phiên bản & webhooks | ✅ (High) | ✅ (High) — Đọc/tương tác comments & cloud metadata | ✅ (Medium) — Đọc/đăng comments & lịch sử phiên bản qua PAT dán trong panel plugin; chưa có webhooks |

### Tóm tắt lựa chọn theo nhu cầu sử dụng

- **Dùng hệ sinh thái Figma Cloud, AI sáng tạo & làm việc đa bề mặt:** **Official / Paid Figma MCP** vẫn mạnh hơn khi cần truy cập từ xa không cần cài đặt, tìm thư viện Design System toàn công ty (`search_design_system`), Code Connect đồng bộ cloud, shader / video / motion keyframe và Branching. **Figma Plugin MCP** nay đã có bản cơ bản chạy local cho nhiều mục trong số đó — sơ đồ FigJam gốc, Slides, motion của prototype, file Code Connect, HTML → Figma, sinh ảnh/SVG BYOK — ở mức hoàn thiện thấp hơn.
- **Agent đọc Figma để viết code từ file hiện tại:** Cả **Official Figma MCP** và **Figma Plugin MCP** đều vượt trội hoàn toàn so với **REST API** vì tránh được việc tải các cục JSON thô khổng lồ làm cháy token của LLM. **Figma Plugin MCP** có thêm lợi thế xuất file snapshot `design-kit.md` ổn định và đọc được Variables ngay cả khi không dùng gói Enterprise.
- **Agent thiết kế UI chính xác & vẽ sơ đồ BA/UX trên Figma Design:** **REST API** không vẽ được lên canvas. **Figma Plugin MCP** cho sản phẩm đầu ra ít lỗi bố cục hơn hẳn nhờ `layout_audit`, `a11y_audit`, `audit_design_system`, các mặc định an toàn (chống đè khung, chống mờ frame) và hệ thống sơ đồ gắn model giúp bắt lỗi cắt chữ, tương phản màu và logic nghiệp vụ trước khi con người xem ảnh chụp.
- **Tự động hóa không cần giao diện (CI/CD, webhooks, lịch sử phiên bản):** **Figma REST API (PAT)** là lựa chọn phù hợp khi không có sẵn phiên Figma Desktop đang mở.
- **Figma Plugin MCP + PAT tùy chọn:** plugin vẫn là đường chính (không tốn quota, ghi được canvas, đọc đủ design system); token bổ sung comments, lịch sử phiên bản và đọc file chưa mở. Lưu ý gói tài khoản: ở **Starter**, quota đọc file qua REST hết sau vài lệnh (phải chờ nhiều ngày), nên hãy mở file khi có thể và coi REST là đường dự phòng thỉnh thoảng mới dùng.

## Bắt đầu nhanh (Quickstart)

1. Cài đặt và build MCP server.
2. Đăng ký server vào trình soạn thảo của bạn (Cursor, Claude Code, Codex).
3. Import plugin vào Figma Desktop và giữ cửa sổ plugin luôn mở.
4. Yêu cầu agent gọi `figma_status`, sau đó là `figma_read` / `figma_write` / `figma_diagram`, rồi kiểm tra bằng `layout_audit`.

```bash
git clone https://github.com/huyndbraly/figma-plugin.git
cd figma-plugin
npm install
npm run build
```

Lệnh trên sẽ build server vào `dist/` và bundle plugin vào `plugin/code.js`.

**Đăng ký MCP server** — cùng lúc cho mọi trình soạn thảo (Cursor, Claude Code, Codex):

```bash
npm run install:mcp
```

hoặc cài thủ công cho từng công cụ:

```bash
claude mcp add figma-plugin -s user -- /absolute/path/to/figma-plugin/scripts/figma-plugin-mcp.sh
```

**Import plugin vào Figma Desktop:** menu → **Plugins → Development → Import plugin from manifest…** → chọn `plugin/manifest.json`. Chạy plugin từ **Plugins → Development → Figma Plugin MCP** và giữ cửa sổ plugin luôn mở.

**Kiểm tra kết nối:** yêu cầu agent gọi `figma_status`. Hướng dẫn chi tiết và cách xử lý sự cố: [`docs/SETUP.md`](./docs/SETUP.md) và [`docs/INSTALL.md`](./docs/INSTALL.md). Chạy nhiều IDE cùng lúc: [`docs/MULTI-AGENT.md`](./docs/MULTI-AGENT.md).

**(Tùy chọn) REST token:** trong panel plugin, dán Figma personal access token (`figd_…`) vào ô **REST Token (PAT)** → **Save**. Badge chuyển sang `Valid (@handle)` khi server kiểm tra xong qua `GET /v1/me`. Token dùng cho comments, lịch sử phiên bản và đọc file chưa mở; thay cho biến môi trường `FIGMA_TOKEN` (vẫn dùng làm dự phòng).

> **Mỗi phiên làm việc:** mở file Figma của bạn → **Plugins → Development → Figma Plugin MCP** → giữ nguyên cửa sổ đó. Figma không tự động khởi chạy plugin.

## Công cụ (Tools)

| Công cụ | Mục đích |
|---|---|
| `figma_status` | Chẩn đoán kết nối chi tiết — trạng thái kết nối plugin, chế độ leader/follower, heartbeat, hàng đợi, sessions, trạng thái REST token (`restToken`: state/handle/bản che `figd_…a1b2`, không bao giờ là token) và danh sách `hints` theo thứ tự. Không bao giờ chỉ trả về mỗi boolean. |
| `figma_read` | Đọc canvas thông qua tham số `op` (`get_document_info`, `get_selection`, `read_selection`, `get_design_context`, `get_design_system_kit`, `generate_design_md`, `search_nodes`, `find_component`, `get_instance_overrides`, `a11y_audit`, `audit_design_system`, `export_component_map`, `screenshot`, `layout_audit`, `get_diagram_spec`, `get_page_model`, `get_slides`, REST: `get_comments`, `get_versions`, chỉ mục cục bộ: `search_design_index`, `index_design_file`, ...) với phản hồi tiết kiệm token. Truyền `{ url }` hoặc `{ fileKey }` để đọc file chưa mở qua REST. |
| `figma_write` | Thực thi JavaScript (ES hiện đại) thông qua proxy `figma.*` để tạo/chỉnh sửa canvas — bao gồm components, variants, properties và instances. Biến `state` được giữ lại xuyên suốt phiên. |
| `figma_rules` | Bảng quy tắc design system chỉ với một lần gọi (styles + variables + components) dưới dạng markdown — đọc trước khi vẽ để tái sử dụng thay vì hardcode. Để lưu đặc tả lâu dài, dùng `figma_read` với `op: "generate_design_md"` và lưu kết quả thành `design-kit.md`. |
| `figma_diagram` | Vẽ **chín** loại sơ đồ từ mô hình mà **bạn** rút trích từ spec, mỗi loại đều kèm kiểm tra lỗi về *nội dung*, không chỉ là hình vẽ. `type:"activity"` — quy trình nghiệp vụ, có hoặc không có swimlanes: mỗi làn một chủ thể, luồng bàn giao giữa các làn; báo cáo chuyển giao chưa gắn nhãn, bước không có người phụ trách, nhánh rẽ không hợp nhất. `type:"sequence"` — trao đổi theo thời gian: các thành phần theo cột, thông điệp theo thứ tự liệt kê, thanh kích hoạt tự suy từ lời gọi và phản hồi, khối alt/loop; báo cáo lời gọi không có phản hồi, phản hồi không có lời gọi, alt thiếu else. `type:"state"` — vòng đời của MỘT thực thể: các trạng thái có thể giữ và mọi chuyển đổi hợp lệ viết theo `event [guard] / action`; báo cáo trạng thái không thể đi tới, trạng thái không thể thoát ra, hai chuyển đổi xung đột trên cùng một sự kiện. `type:"erd"` — mô hình dữ liệu: bảng, cột, khóa, quan hệ crow's-foot; báo cáo các lỗi dễ sập sau migration (thiếu khóa chính, khóa ngoại trỏ tới cột không tồn tại, quan hệ nhiều-nhiều thiếu bảng trung gian). `type:"userflow"` — các màn hình người dùng đi qua, từ đồ thị hoặc mermaid `flowchart`; báo cáo câu hỏi chỉ có một lối ra, ngõ cụt, màn hình không thể truy cập. `type:"sitemap"` — cấu trúc trang của sản phẩm và quan hệ chứa nhau, vẽ dạng cây gọn gàng; báo cáo trang mồ côi, mục rỗng không có trang con, độ sâu quá lớn khó điều hướng, và đối chiếu chéo với userflows trên cùng trang. `type:"usecase"` — tác nhân (actors), use cases trong ranh giới hệ thống, `«include»`/`«extend»`/kế thừa; báo cáo actor không dùng gì và use case không ai khởi tạo được. `type:"journey"` — hành trình một persona qua một kịch bản kèm đường cong cảm xúc; báo cáo điểm trũng cảm xúc chưa có pain point và pain point chưa có cơ hội cải thiện. `type:"persona"` — thẻ chân dung người dùng mục tiêu; báo cáo thiếu nguồn nghiên cứu, thiếu persona chính, persona thiếu mục tiêu hoặc nỗi đau. Có thể viết ở dạng `text` rút gọn chỉ tốn ~1/3 lượng token, vẽ cả bộ trong một lần gọi (`diagrams: [...]`, tự động sắp xếp vị trí), và **chỉnh sửa** bằng `update` + `patch` thay vì vẽ lại từ đầu. Mọi lần vẽ đều được kiểm tra chéo với các sơ đồ khác trên trang. Với 6 loại sơ đồ đồ thị, mũi tên luôn tự bám vào hộp: kéo hộp đi đâu, các đường nối tự định tuyến lại theo đó. |
| `figma_docs` | Tài liệu tra cứu theo nhu cầu: `rules` \| `layout` \| `api` \| `tokens` \| `icons` \| `recipes` \| `style` \| `userflow` \| `activity` \| `erd` \| `sequence` \| `sitemap` \| `state` \| `usecase` \| `journey` \| `persona`. Đọc `style` khi chưa có design system sẵn — đây là bộ thang đo/bảng màu/độ nổi trung tính mặc định để dùng thay cho việc tự bịa giá trị. |

Tham khảo đầy đủ tham số cho mọi thao tác và mọi phương thức `figma.*`: [`docs/TOOLS.md`](./docs/TOOLS.md).

## Diagram skills

Thư mục [`.claude/skills/`](./.claude/skills/) cung cấp sẵn một skill cho mỗi loại sơ đồ — `/figma-userflow`, `/figma-activity`, `/figma-sequence`, `/figma-state`, `/figma-erd`, `/figma-sitemap`, `/figma-usecase`, `/figma-journey`, `/figma-persona` — cùng các quy tắc chung (kiểm tra kết nối trước khi chạy, 4 mức độ "đúng", vòng lặp xử lý findings, bước kiểm chứng). Hãy copy chúng vào `.claude/skills/` trong dự án của bạn. Xem [`.claude/skills/README.md`](./.claude/skills/README.md).

## Ví dụ: `figma_write`

```js
// Thiết lập token một lần — chúng được lưu lại trong `state.tokens` của phiên này.
await figma.setupTokens({
  colors: { primary: "#2563EB", surface: "#0B0B0F" },
  numbers: { "radius-md": 8 },
});

// Vẽ một card có text tự xuống dòng, tái sử dụng chiều rộng của node cha.
const card = await figma.create({
  type: "FRAME", name: "Card", parentId: state.rootId,
  width: 320, layoutMode: "VERTICAL",
});
await figma.applyVariable(card.id, "fills", "surface");
await figma.create({
  type: "TEXT", parentId: card.id, wrap: true,
  characters: "A long paragraph that must wrap inside the card.",
});

// Kiểm tra bằng code trước khi chụp ảnh cho con người duyệt.
const audit = await figma.layoutAudit(card.id);
if (audit.summary.issues.length) console.warn(audit.summary.issues);
```

## Ví dụ: components

```js
// Bộ nút bấm: 2 sắc thái × 2 kích thước, tự động xếp thành lưới.
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

// Một TEXT property, tự động gắn vào layer "Label" trong mọi variant.
await figma.addComponentProperty(button.id, { name: "Label", type: "TEXT", defaultValue: "Button", bind: "Label" });

// Dùng theo tên — variant và property keys được tự động giải mã.
await figma.instantiate("Button", { variant: { Size: "lg" }, properties: { Label: "Save" }, parentId: state.formId });
```

## Ví dụ: chụp snapshot design system ra `design-kit.md`

Yêu cầu agent gọi:

```json
{ "op": "generate_design_md", "params": { "depth": 3, "includeAnatomy": true, "includeScreens": true } }
```

Kết quả trả về là một bản snapshot markdown bám sát dữ liệu gốc trong file Figma: độ phủ trích xuất, bảng màu, typography, tần suất layout quan sát được, cấu trúc màn hình thực tế, mức độ sử dụng component nội bộ và từ thư viện ngoài, node IDs/keys/variant IDs/property keys chính xác, ví dụ `instantiate` chạy được ngay, quy tắc tái sử dụng, dữ liệu responsive và các khoảng trống còn thiếu. Hãy lưu file này vào codebase đích dưới tên **`design-kit.md`** trước khi yêu cầu agent tạo UI từ hệ thống component Figma hiện có. Dữ liệu sự thật được tách bạch khỏi các nhận xét quan sát và phần ngữ nghĩa UX chưa rõ. Với file rất lớn, có thể tinh chỉnh `maxComponents`, `maxScreens`, `maxInstances` hoặc `maxOutputChars`; khi chạm giới hạn, công cụ sẽ bỏ qua trọn vẹn từng mục thay vì cắt ngang giữa bảng hoặc khối code Markdown.

> **`design.md` và `design-kit.md` là hai file khác nhau** — ý đồ thiết kế của con người vs.
> bản snapshot do máy trích xuất, tương tự `package.json` vs. `package-lock.json`. Các công cụ
> không bao giờ ghi đè `design.md`. Xem
> [quy trình hai file](./docs/RECIPES.md#the-two-file-design-system-workflow).

## Kiến trúc

```
MCP client (Claude Code / Cursor)
      │ stdio (MCP)
      ▼
 Figma Plugin MCP server (Node ≥ 18, TypeScript)
      │  quản lý HTTP+WS server tại localhost:38470 (fallback +1..+9)
      │    GET  /health    → JSON chẩn đoán kết nối
      │    POST /rpc       → chuyển tiếp follower → leader (kèm auth token)
      │    WS   /ws        → kết nối với UI của Figma plugin
      ▼
 Figma Desktop plugin
   ├── ui.html   (WebSocket client, heartbeat, tự kết nối lại theo backoff)
   └── code.js   (Bộ thực thi Plugin API, các handler mặc định an toàn)
```

Mọi thao tác — dù đi thẳng qua leader hay chuyển tiếp từ follower — đều đi qua một điểm kiểm soát duy nhất `validateOperation()` trước khi tới plugin. Toàn bộ cấu trúc mạng, giao thức leader/follower và các cơ chế mặc định an toàn được ghi chi tiết tại [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Tài liệu

- [`docs/SETUP.md`](./docs/SETUP.md) — **bắt đầu tại đây**: cài đặt, quy trình dùng hàng ngày, xử lý sự cố
- [`docs/INSTALL.md`](./docs/INSTALL.md) — tham khảo cài đặt: biến môi trường, cơ chế port, leader/follower
- [`docs/TOOLS.md`](./docs/TOOLS.md) — tài liệu đầy đủ về các tool + `figma.*` API, mã lỗi
- [`docs/MIGRATION.md`](./docs/MIGRATION.md) — hướng dẫn chuyển đổi từ `figma-ui-mcp`
- [`docs/RECIPES.md`](./docs/RECIPES.md) — sổ tay công thức thực hành
- [`docs/DEMO-PROMPT.md`](./docs/DEMO-PROMPT.md) — prompt mẫu chạy thử mọi loại sơ đồ kèm màn hình mobile
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — mục tiêu thiết kế và cấu trúc bên trong

## Giấy phép

MIT — xem [`LICENSE`](./LICENSE).
