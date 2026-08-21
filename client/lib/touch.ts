// client/lib/touch.ts
//
// Primary-pointer detection for input ergonomics (issue #28). On phones and
// tablets the software keyboard's Enter key must insert a newline — sending is
// the visible Send button's job — while on desktop Enter-to-send is the
// expected chat affordance. `(pointer: coarse)` matches the PRIMARY pointing
// device, so laptops with touchscreens keep Enter-to-send.
export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    // Defensive: some embedders throw on unknown media queries.
    return false;
  }
}
