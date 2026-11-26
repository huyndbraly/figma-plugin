export const PERSONA = `# Persona set — figma_diagram type:"persona"

The people the product is for, one card each: who they are, what they want,
what gets in their way, how they behave — and where that knowledge comes
from. One persona is \`primary\`: the one you design for when needs conflict.

## Shape

\`\`\`json
{
  "type": "persona",
  "title": "Người xem phim",
  "source": "4 phỏng vấn, 120 khảo sát (11/2026)",
  "personas": [
    { "id": "thu", "name": "Thu Trang", "primary": true, "tag": "Nhân viên văn phòng, 28",
      "quote": "Tôi muốn đặt vé trong giờ nghỉ trưa", "bio": "Sống ở Hà Nội, xem phim 2 lần/tháng",
      "facts": [{ "label": "Thiết bị", "value": "iPhone 13" }],
      "goals": ["Chọn ghế đẹp thật nhanh"], "pains": ["Phí ẩn khi thanh toán"],
      "needs": ["Thấy tổng tiền sớm"], "wants": ["Tích điểm"], "behaviors": ["Đặt vé phút chót"],
      "levels": [{ "label": "Thành thạo công nghệ", "value": 4 }], "apps": ["Shopee", "Grab"] }
  ]
}
\`\`\`

### Compact \`text\`

\`\`\`
source "4 phỏng vấn, 120 khảo sát (11/2026)"
persona thu "Thu Trang" primary
  tag Nhân viên văn phòng, 28
  quote "Tôi muốn đặt vé trong giờ nghỉ trưa"
  bio Sống ở Hà Nội, xem phim 2 lần/tháng
  fact Thiết bị: iPhone 13
  goal Chọn ghế đẹp thật nhanh
  pain Phí ẩn khi thanh toán
  need Thấy tổng tiền sớm
  want Tích điểm
  behav Đặt vé phút chót
  level "Thành thạo công nghệ" 4
  app Shopee
\`\`\`

Persona ids may be in any script (\`persona thư "Thư"\`). A journey's
\`persona\` matches a card by whole words of the name before its first comma:
"Thu, 28" walks the journey of "Thu Trang".

### Fields

| field | meaning |
| --- | --- |
| \`source\` | the research behind the cards |
| \`personas[]\` | \`id\`, \`name\`, \`primary\`, \`tag\`, \`quote\`, \`bio\`, \`facts[{label,value}]\`, \`goals[]\`, \`pains[]\`, \`needs[]\`, \`wants[]\`, \`behaviors[]\`, \`levels[{label,value 1–5}]\`, \`apps[]\` |

## What it reports

- No source (the cards are assumptions); no primary among several, or more than one.
- A persona with no goal or no pain; duplicate names; a level outside 1–5.
- Cross-check: a journey on the page whose persona has no card here.
`;
