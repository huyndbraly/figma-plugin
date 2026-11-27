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

