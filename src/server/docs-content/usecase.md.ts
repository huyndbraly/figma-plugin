export const USECASE = `# Use case diagram — figma_diagram type:"usecase"

WHO uses the system for WHAT. Actors stand outside the system boundary, use
cases sit inside it as ellipses; lines say who starts which use case, and
«include» / «extend» / generalization say how use cases and actors relate.
Reach for it at the start of a spec, to agree on scope before any flow.

| question | tool |
| --- | --- |
| who can do what with the system | \`figma_diagram\` type:"usecase" |
| what the user sees next | \`figma_diagram\` type:"userflow" |
| who does each step of a process | \`figma_diagram\` type:"activity" |

## Shape

\`\`\`json
{
  "type": "usecase",
  "title": "Đặt vé xem phim",
  "system": "Ticketing app",
  "actors": [
    { "id": "visitor", "name": "Khách" },
    { "id": "member", "name": "Thành viên" },
    { "id": "pay", "name": "Cổng thanh toán", "kind": "system" }
  ],
  "useCases": [
    { "id": "book", "label": "Đặt vé" },
    { "id": "hold", "label": "Giữ ghế" },
    { "id": "voucher", "label": "Áp mã giảm giá" }
  ],
  "links": [
    { "from": "visitor", "to": "book" },
    { "from": "book", "to": "hold", "kind": "include" },
    { "from": "voucher", "to": "book", "kind": "extend" },
    { "from": "member", "to": "visitor", "kind": "generalization" },
    { "from": "pay", "to": "book" }
  ]
}
\`\`\`

### Compact \`text\`

\`\`\`
system "Ticketing app"
actor visitor "Khách"
actor pay "Cổng thanh toán" system
uc book "Đặt vé"
uc hold "Giữ ghế"
visitor - book          # association (actor — use case)
book => hold            # book «include» hold  (always needed)
voucher +> book         # voucher «extend» book (sometimes)
member :> visitor       # member is a kind of visitor
\`\`\`

An id used only in a link is created for you when the other end makes its
type obvious. \`actor … system\` draws a box on the right (a secondary actor);
\`left\` / \`right\` force a side. \`/ text\` after a label adds a detail line.

### Fields

| field | meaning |
| --- | --- |
| \`actors[]\` | \`id\`, \`name\`, \`kind\`: human (default, stick figure) or system, \`side\`, \`detail\` |
| \`useCases[]\` | \`id\`, \`label\` (verb + object: "Đặt vé"), \`detail\` |
| \`links[]\` | \`from\`, \`to\`, \`kind\`: association (default) / include / extend / generalization, \`label\` |
| \`system\` | the boundary's name |

## What it reports

- An actor that uses nothing; a use case nobody can start (no actor, not included or extended from one that has).
- An association between two use cases or two actors, an «include» touching an actor, a generalization across types — dropped and reported.
- An «include» cycle.

## Notation traps

- «include» points from the BASE to the always-needed part; «extend» points from the OPTIONAL part to the base.
- A system layer (database, API) is not an actor — an actor is someone or something OUTSIDE the boundary that starts or serves a use case.
- Use cases are goals, not screens or clicks: "Đặt vé", not "Bấm nút Thanh toán".
`;
