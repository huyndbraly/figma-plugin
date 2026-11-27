import { describe, expect, it } from "vitest";
import { describeMotion, describeEasing } from "../../src/plugin/motion-util.js";

/**
 * Prototype reactions → motion. The units are the trap: trigger delays are
 * MILLISECONDS in the Plugin API, transition durations SECONDS. A test that
 * only checked "a number came back" would let either one be off by 1000×.
 */

describe("describeMotion", () => {
  it("SMART_ANIMATE after a delay: seconds everywhere, named easing as a bezier, a CSS timing string", () => {
    const m = describeMotion([
      {
        trigger: { type: "AFTER_TIMEOUT", timeout: 1799.9999 },
        actions: [{ type: "NODE", destinationId: "12:3", navigation: "NAVIGATE", transition: { type: "SMART_ANIMATE", duration: 0.3, easing: { type: "EASE_IN_AND_OUT" }, matchLayers: true } }],
      },
    ]);
    expect(m).toEqual([
      {
        trigger: { type: "AFTER_TIMEOUT", timeout: 1.8 },
        actions: [
          {
            type: "NODE",
            destinationId: "12:3",
            navigation: "NAVIGATE",
            transition: { type: "SMART_ANIMATE", duration: 0.3, easing: { type: "EASE_IN_AND_OUT", bezier: [0.42, 0, 0.58, 1] }, matchLayers: true, css: "300ms cubic-bezier(0.42, 0, 0.58, 1)" },
          },
        ],
      },
    ]);
  });

  it("a custom cubic-bezier is read from the curve, not the name", () => {
    expect(describeEasing({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0.8, x2: 0.3, y2: 1 } })).toEqual({ type: "CUSTOM_CUBIC_BEZIER", bezier: [0.2, 0.8, 0.3, 1] });
  });

  it("springs carry mass/stiffness/damping and no CSS (CSS cannot express a spring)", () => {
    const m = describeMotion([{ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: "1:1", transition: { type: "MOVE_IN", direction: "LEFT", duration: 0.8, easing: { type: "GENTLE" } } }] }]);
    const t = m[0]!.actions[0]!.transition!;
    expect(t.easing).toEqual({ type: "GENTLE", spring: { mass: 1, stiffness: 100, damping: 15 } });
    expect(t.direction).toBe("LEFT");
    expect(t.css).toBeUndefined();
  });

  it("the legacy single `action` is read when `actions` is absent, and not doubled when both are", () => {
    expect(describeMotion([{ trigger: { type: "ON_HOVER" }, action: { type: "BACK" } }])[0]!.actions).toEqual([{ type: "BACK" }]);
    expect(describeMotion([{ trigger: { type: "ON_CLICK" }, action: { type: "BACK" }, actions: [{ type: "BACK" }] }])[0]!.actions).toHaveLength(1);
  });

  it("URL and key triggers", () => {
    const m = describeMotion([{ trigger: { type: "ON_KEY_DOWN", keyCodes: [13], device: "KEYBOARD" }, actions: [{ type: "URL", url: "https://x.dev" }] }]);
    expect(m[0]).toEqual({ trigger: { type: "ON_KEY_DOWN", keyCodes: [13], device: "KEYBOARD" }, actions: [{ type: "URL", url: "https://x.dev" }] });
  });

  it("no reactions → []", () => {
    expect(describeMotion(undefined)).toEqual([]);
  });
});
