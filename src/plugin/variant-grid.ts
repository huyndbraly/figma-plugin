/**
 * Pure helpers for component sets: variant names and the grid a set's
 * variants are laid out in. NO figma globals, so the logic is testable
 * without the plugin runtime.
 */

/** Figma's variant name format: "Size=sm, State=default". */
export function variantName(props: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(props)) {
    const key = k.trim();
    const value = String(raw).trim();
    if (!key) throw new Error("A variant property needs a non-empty name.");
    if (!value) throw new Error(`Variant property "${key}" needs a non-empty value.`);
    if (/[=,]/.test(key) || /[=,]/.test(value)) {
      throw new Error(
        `Variant property "${key}=${value}" may not contain "=" or "," — Figma uses them to separate properties.`,
      );
    }
    parts.push(`${key}=${value}`);
  }
  if (parts.length === 0) throw new Error("A variant needs at least one property, e.g. { State: \"default\" }.");
  return parts.join(", ");
}

/** Parse "Size=sm, State=default" back into { Size: "sm", State: "default" }. */
export function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Does a variant match the requested properties? Keys and values compare
 * case-insensitively; a requested key the variant does not have is a miss.
 */
export function variantMatches(
  variant: Record<string, string>,
  wanted: Record<string, unknown>,
): boolean {
  const lower = new Map(Object.entries(variant).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
  for (const [k, v] of Object.entries(wanted)) {
    const have = lower.get(k.trim().toLowerCase());
    if (have === undefined || have !== String(v).trim().toLowerCase()) return false;
  }
  return true;
}

export interface GridItem {
  id: string;
  w: number;
  h: number;
  props: Record<string, string>;
}

export interface GridOptions {
  /** Property whose values become rows. Default: the first property. */
  rowsBy?: string;
  /** Property whose values become columns. Default: every other property combined. */
  columnsBy?: string;
  gap?: number;
  padding?: number;
  /** Order of values per property (variantGroupProperties). Missing → first-seen order. */
  valueOrder?: Record<string, string[]>;
}

export interface GridLayout {
  positions: Array<{ id: string; x: number; y: number }>;
  width: number;
  height: number;
  rowsBy: string | null;
  columnsBy: string | null;
}

function ordered(values: string[], order: string[] | undefined): string[] {
  const seen = [...new Set(values)];
  if (!order) return seen;
  const known = order.filter((v) => seen.includes(v));
  return [...known, ...seen.filter((v) => !known.includes(v))];
}

/**
 * Lay variants out in a grid: one row per value of `rowsBy`, one column per
 * value (or combination of values) of the rest. Each column is as wide as its
 * widest cell and each row as tall as its tallest, so mixed sizes line up.
 */
export function layoutVariantGrid(items: GridItem[], opts: GridOptions = {}): GridLayout {
  const gap = opts.gap ?? 24;
  const padding = opts.padding ?? 24;
  if (items.length === 0) {
    return { positions: [], width: padding * 2, height: padding * 2, rowsBy: null, columnsBy: null };
  }
  const propNames: string[] = [];
  for (const it of items) for (const k of Object.keys(it.props)) if (!propNames.includes(k)) propNames.push(k);

  const rowsBy = opts.rowsBy && propNames.includes(opts.rowsBy) ? opts.rowsBy : propNames[0] ?? null;
  const columnsBy =
    opts.columnsBy && propNames.includes(opts.columnsBy) && opts.columnsBy !== rowsBy ? opts.columnsBy : null;
  const colProps = columnsBy ? [columnsBy] : propNames.filter((p) => p !== rowsBy);

  const rowKey = (it: GridItem) => (rowsBy ? it.props[rowsBy] ?? "" : "");
  const colKey = (it: GridItem) => colProps.map((p) => it.props[p] ?? "").join(" / ");

  const rowKeys = ordered(items.map(rowKey), rowsBy ? opts.valueOrder?.[rowsBy] : undefined);
  // Column order: by each column property's own value order, in sequence.
  const colKeys = [...new Set(items.map(colKey))].sort((a, b) => {
    const pa = a.split(" / ");
    const pb = b.split(" / ");
    for (let i = 0; i < colProps.length; i++) {
      const order = ordered(items.map((it) => it.props[colProps[i]!] ?? ""), opts.valueOrder?.[colProps[i]!]);
      const d = order.indexOf(pa[i] ?? "") - order.indexOf(pb[i] ?? "");
      if (d !== 0) return d;
    }
    return 0;
  });

  const colW = colKeys.map(() => 0);
  const rowH = rowKeys.map(() => 0);
  const cell = new Map<string, { r: number; c: number }>();
  // Two variants can land in the same cell (duplicate props); later ones go
  // into extra columns at the end of their row so nothing is stacked.
  const taken = new Set<string>();
  const extraCols: number[] = [];
  for (const it of items) {
    const r = rowKeys.indexOf(rowKey(it));
    let c = colKeys.indexOf(colKey(it));
    if (taken.has(`${r}:${c}`)) {
      c = colKeys.length + extraCols.length;
      extraCols.push(c);
      colW.push(0);
    }
    taken.add(`${r}:${c}`);
    cell.set(it.id, { r, c });
    colW[c] = Math.max(colW[c] ?? 0, it.w);
    rowH[r] = Math.max(rowH[r] ?? 0, it.h);
  }

  const colX: number[] = [];
  let x = padding;
  for (const w of colW) {
    colX.push(x);
    x += w + gap;
  }
  const rowY: number[] = [];
  let y = padding;
  for (const h of rowH) {
    rowY.push(y);
    y += h + gap;
  }

  return {
    positions: items.map((it) => {
      const { r, c } = cell.get(it.id)!;
      return { id: it.id, x: colX[c]!, y: rowY[r]! };
    }),
    width: Math.max(padding * 2, x - gap + padding),
    height: Math.max(padding * 2, y - gap + padding),
    rowsBy,
    columnsBy: columnsBy ?? (colProps.length ? colProps.join(" / ") : null),
  };
}
