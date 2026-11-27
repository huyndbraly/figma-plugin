/**
 * FigJam shape and colour vocabulary, kept apart from the layout (which pulls
 * in dagre) so the plugin bundle can import it for free.
 */
/** FigJam ShapeWithText shape types this module uses, plus STICKY. */
export type FigjamShape = "ROUNDED_RECTANGLE" | "SQUARE" | "ELLIPSE" | "DIAMOND" | "PARALLELOGRAM_RIGHT" | "TRIANGLE_DOWN" | "STICKY";

export type FigjamColor = "gray" | "blue" | "green" | "yellow" | "orange" | "red" | "violet" | "teal" | "white";

/** FigJam colour names → hex, as the plugin fills them. */
export const FIGJAM_FILL: Record<FigjamColor, string> = {
  gray: "#E6E6E6",
  blue: "#C2E5FF",
  green: "#CDF4D3",
  yellow: "#FFF0B3",
  orange: "#FFE0C2",
  red: "#FFC7C2",
  violet: "#DCCCFF",
  teal: "#C6FAF6",
  white: "#FFFFFF",
};


/**
 * The marker a FigJam-native diagram's SECTION carries:
 * `{ kind, title, source, native: "figjam" }` — the same model a Figma Design
 * frame stores, so get_diagram_spec, get_page_model, crossCheck and
 * update/patch work on it. Its own key (not in DIAGRAM_MARKERS): the live
 * arrow re-router must never treat a section of FigJam connectors as a frame
 * of vectors to re-route.
 */
export const FIGJAM_MARKER = "figma-plugin.figjam";

/** What the first FigJam build wrote on its sections ({ kind, title }, no model). */
export const LEGACY_FIGJAM_MARKER = "figjam-diagram";
