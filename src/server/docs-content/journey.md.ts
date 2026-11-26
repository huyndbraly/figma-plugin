export const JOURNEY = `# Customer journey map — figma_diagram type:"journey"

ONE persona through ONE scenario, phase by phase: what they do, where it
happens, what they think, how they feel, what hurts and what could fix it.
Drawn as a grid with an emotion curve — the low points are where design
effort pays. Reach for it before a redesign, to decide WHAT to change.

## Shape

\`\`\`json
{
  "type": "journey",
  "title": "Đặt vé lần đầu",
  "persona": "Thu Trang",
  "phases": [
    { "id": "find", "label": "Tìm phim", "actions": ["Mở app", "Lướt danh sách"], "touchpoints": ["Trang chủ"],
      "thoughts": ["Phim nào đang hot?"], "feeling": 1, "feelingNote": "Tò mò" },
    { "id": "pay", "label": "Thanh toán", "actions": ["Nhập thẻ"], "feeling": -2, "feelingNote": "Lo lắng",
      "pains": ["Không rõ phí dịch vụ"], "ideas": ["Hiện tổng tiền trước bước nhập thẻ"] }
  ]
}
\`\`\`

### Compact \`text\`

\`\`\`
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
\`\`\`

Every line after a \`phase\` belongs to it; repeat a word for several items.
Phase ids may be in any script (\`phase tìm "Tìm phim"\`).

### Fields

| field | meaning |
| --- | --- |
| \`persona\` | who walks it (also cross-checked against persona cards on the page) |
| \`phases[]\` | \`id\`, \`label\`, \`actions[]\`, \`touchpoints[]\`, \`thoughts[]\`, \`feeling\` (-2 … 2), \`feelingNote\`, \`pains[]\`, \`ideas[]\` |

## What it reports

- No persona; fewer than two phases; a phase where the persona does nothing.
- A bad feeling (≤ -1) with no pain to explain it; a pain with no opportunity.
- Phases missing from the emotion curve.
`;
