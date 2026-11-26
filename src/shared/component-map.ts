/**
 * The 1-to-1 map between components in CODE and components in FIGMA.
 *
 * A code component (`<Button tone="primary" size="lg">Save</Button>`) and its
 * Figma counterpart (set "Button", variants Tone=Primary / Size=Large, TEXT
 * property "Label#12:3") describe one thing in two vocabularies. The map says
 * how the words translate, so an agent that writes UI from the codebase draws
 * the SAME component in Figma — right variant, right property — instead of
 * something that merely resembles it.
 *
 * Kept as plain JSON so it can live in the codebase (e.g. figma.components.json)
 * and be reviewed like any other file. Pure: no figma globals, no fs.
 */

export interface PropMapping {
  /** The Figma property: a variant property name, or a TEXT/BOOLEAN/INSTANCE_SWAP property name (no #suffix). */
  figma: string;
  type?: "VARIANT" | "TEXT" | "BOOLEAN" | "INSTANCE_SWAP";
  /** Code value → Figma value. Omitted values pass through unchanged. */
  values?: Record<string, string>;
}

export interface ComponentMapping {
  /** Figma component / component set name, e.g. "Button" or "P/Nav/TopBar". */
  figma: string;
  props?: Record<string, PropMapping>;
  /** The Figma TEXT property that receives `children` (the label). */
  children?: string;
  /** Figma values to set whatever the code says, e.g. { State: "Default" }. */
  fixed?: Record<string, string | boolean>;
}

export interface ComponentMap {
  /** Format marker so a file can be recognised and migrated later. */
  version?: 1;
  components: Record<string, ComponentMapping>;
}

/** What a Figma component exposes — the shape find_component describes. */
export interface FigmaComponentInfo {
  id: string;
  name: string;
  type: "COMPONENT" | "COMPONENT_SET";
  variantOptions?: Record<string, string[]>;
  /** Non-variant properties, keyed by their full "#suffixed" key. */
  properties?: Record<string, { type: string; defaultValue?: unknown }>;
}

export function baseKey(key: string): string {
  const i = key.indexOf("#");
  return i < 0 ? key : key.slice(0, i);
}

function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** "Show icon" → "showIcon", "Size" → "size". */
export function camelCase(s: string): string {
  const w = words(s).map((x) => x.toLowerCase());
  if (!w.length) return "";
  return w[0]! + w.slice(1).map((x) => x[0]!.toUpperCase() + x.slice(1)).join("");
}

/** "P/Nav/TopBar" → "TopBar", "icon button" → "IconButton". */
export function pascalCase(s: string): string {
  const last = s.split("/").pop() ?? s;
  return words(last)
    .map((x) => x[0]!.toUpperCase() + x.slice(1))
    .join("");
}

/** "Primary" → "primary", "Extra Large" → "extra-large". */
export function codeValue(s: string): string {
  return words(s)
    .map((x) => x.toLowerCase())
    .join("-");
}

const LABEL_PROP = /^(label|text|title|content|children|caption|value)$/i;

/** A starting map from what Figma has — every name translated mechanically, ready to edit. */
export function mapFromFigma(infos: readonly FigmaComponentInfo[]): ComponentMap {
  const components: Record<string, ComponentMapping> = {};
  for (const info of infos) {
    let codeName = pascalCase(info.name) || `Component${info.id.replace(/\W/g, "")}`;
    if (components[codeName]) codeName = pascalCase(info.name.replace(/\//g, " "));
    if (components[codeName]) codeName = `${codeName}${info.id.replace(/\W/g, "")}`;
    const props: Record<string, PropMapping> = {};
    let children: string | undefined;
    for (const [prop, values] of Object.entries(info.variantOptions ?? {})) {
      const map: Record<string, string> = {};
      for (const v of values) map[codeValue(v) || v] = v;
      props[camelCase(prop) || prop] = { figma: prop, type: "VARIANT", values: map };
    }
    for (const [key, def] of Object.entries(info.properties ?? {})) {
      const name = baseKey(key);
      const t = String(def.type).toUpperCase();
      if (t !== "TEXT" && t !== "BOOLEAN" && t !== "INSTANCE_SWAP") continue;
      if (t === "TEXT" && !children && LABEL_PROP.test(name)) {
        children = name;
        continue;
      }
      props[camelCase(name) || name] = { figma: name, type: t as PropMapping["type"] };
    }
    components[codeName] = { figma: info.name, ...(Object.keys(props).length ? { props } : {}), ...(children ? { children } : {}) };
  }
  return { version: 1, components };
}

/** TypeScript prop types the map implies — paste next to the code components to keep them honest. */
export function mapToTypeScript(map: ComponentMap): string {
  const out: string[] = [];
  for (const [name, m] of Object.entries(map.components)) {
    out.push(`export interface ${name}Props {`);
    for (const [prop, pm] of Object.entries(m.props ?? {})) {
      const t =
        pm.type === "BOOLEAN"
          ? "boolean"
          : pm.values && Object.keys(pm.values).length
            ? Object.keys(pm.values).map((v) => JSON.stringify(v)).join(" | ")
            : "string";
      out.push(`  ${/^[A-Za-z_$][\w$]*$/.test(prop) ? prop : JSON.stringify(prop)}?: ${t};`);
    }
    if (m.children) out.push(`  children?: string;`);
    out.push(`}`, ``);
  }
  return out.join("\n");
}

export interface Translated {
  component: string;
  variant: Record<string, string>;
  properties: Record<string, string | boolean>;
  /** Code props the map does not know — reported, never guessed. */
  unmapped: string[];
}

/** Code props → the instantiate() arguments for the Figma component. */
export function translateProps(map: ComponentMap, codeName: string, props: Record<string, unknown> = {}): Translated {
  const m = map.components?.[codeName];
  if (!m) {
    const known = Object.keys(map.components ?? {});
    throw new Error(`The component map has no "${codeName}"${known.length ? ` (it has: ${known.slice(0, 20).join(", ")})` : ""}.`);
  }
  const variant: Record<string, string> = {};
  const properties: Record<string, string | boolean> = {};
  const unmapped: string[] = [];
  for (const [k, v] of Object.entries(m.fixed ?? {})) {
    if (typeof v === "boolean") properties[k] = v;
    else properties[k] = v;
  }
  for (const [prop, raw] of Object.entries(props)) {
    if (raw === undefined || raw === null) continue;
    if (prop === "children") {
      if (m.children) properties[m.children] = String(raw);
      else unmapped.push(prop);
      continue;
    }
    const pm = m.props?.[prop];
    if (!pm) {
      unmapped.push(prop);
      continue;
    }
    const value = typeof raw === "boolean" && pm.type !== "VARIANT" ? raw : (pm.values?.[String(raw)] ?? String(raw));
    if (pm.type === "VARIANT") variant[pm.figma] = String(value);
    else properties[pm.figma] = pm.type === "BOOLEAN" ? value === true || value === "true" : value;
  }
  // A fixed variant value belongs in the variant, not the properties.
  for (const k of Object.keys(m.fixed ?? {})) {
    const isVariantProp = Object.values(m.props ?? {}).some((pm) => pm.figma === k && pm.type === "VARIANT");
    if (isVariantProp && !(k in variant)) {
      variant[k] = String(properties[k]);
      delete properties[k];
    }
  }
  return { component: m.figma, variant, properties, unmapped };
}

export interface MapFinding {
  component: string;
  severity: "error" | "warning";
  message: string;
}

/**
 * Does the map still describe the Figma file? A renamed variant value or a
 * deleted property is exactly what makes generated UI drift, and it is silent
 * until somebody looks at the canvas.
 */
export function checkMap(map: ComponentMap, figmaByName: (name: string) => FigmaComponentInfo | undefined): MapFinding[] {
  const out: MapFinding[] = [];
  for (const [codeName, m] of Object.entries(map.components ?? {})) {
    const info = figmaByName(m.figma);
    if (!info) {
      out.push({ component: codeName, severity: "error", message: `Figma has no component "${m.figma}".` });
      continue;
    }
    const variants = info.variantOptions ?? {};
    const props = new Map(Object.entries(info.properties ?? {}).map(([k, d]) => [baseKey(k).toLowerCase(), String(d.type).toUpperCase()]));
    for (const [prop, pm] of Object.entries(m.props ?? {})) {
      if (pm.type === "VARIANT" || (pm.type === undefined && variants[pm.figma])) {
        const options = variants[pm.figma];
        if (!options) {
          out.push({ component: codeName, severity: "error", message: `${codeName}.${prop} → variant "${pm.figma}", which "${m.figma}" does not have (it has: ${Object.keys(variants).join(", ") || "none"}).` });
          continue;
        }
        for (const [cv, fv] of Object.entries(pm.values ?? {})) {
          if (!options.includes(fv)) out.push({ component: codeName, severity: "error", message: `${codeName}.${prop}="${cv}" → "${fv}", not a value of "${pm.figma}" (${options.join(" | ")}).` });
        }
        const mapped = new Set(Object.values(pm.values ?? {}));
        const missing = options.filter((o) => !mapped.has(o));
        if (pm.values && missing.length) out.push({ component: codeName, severity: "warning", message: `${codeName}.${prop} has no code value for ${missing.map((o) => `"${o}"`).join(", ")}.` });
      } else {
        const t = props.get(pm.figma.toLowerCase());
        if (!t) out.push({ component: codeName, severity: "error", message: `${codeName}.${prop} → property "${pm.figma}", which "${m.figma}" does not have.` });
        else if (pm.type && pm.type !== t) out.push({ component: codeName, severity: "warning", message: `${codeName}.${prop} is mapped as ${pm.type} but "${pm.figma}" is ${t}.` });
      }
    }
    if (m.children && props.get(m.children.toLowerCase()) !== "TEXT") {
      out.push({ component: codeName, severity: "error", message: `${codeName}.children → "${m.children}", which is not a TEXT property of "${m.figma}".` });
    }
    // Figma properties nobody maps: the code side cannot set them.
    const mappedFigma = new Set([...Object.values(m.props ?? {}).map((pm) => pm.figma.toLowerCase()), ...(m.children ? [m.children.toLowerCase()] : []), ...Object.keys(m.fixed ?? {}).map((k) => k.toLowerCase())]);
    const unmappedFigma = [...Object.keys(variants), ...[...props.keys()]].filter((k) => !mappedFigma.has(k.toLowerCase()));
    if (unmappedFigma.length) out.push({ component: codeName, severity: "warning", message: `"${m.figma}" has properties the map never sets: ${unmappedFigma.join(", ")}.` });
  }
  return out;
}
