// OpenRig UI kit: <or-icon name="more" size="16" label="…">, the one element for placing an icon in plain HTML. Dependency-free: it draws
// the inline SVG from the registry (kit/icons.mjs), so it follows the registry when the set is swapped. Without `label` the icon is hidden
// from assistive tech (name the control around it instead); with one it is an image with that name. Changing an attribute redraws it.
// Importing this module defines the element once (in a browser; on a server it does nothing). Server-built pages can skip it and emit
// icon(name) from kit/icons.mjs directly, which is the same markup.
import { icon } from "./icons.mjs";

export function defineOrIcon(registry = globalThis.customElements) {
  if (!registry || registry.get("or-icon")) return;
  registry.define("or-icon", class OrIcon extends HTMLElement {
    static get observedAttributes() { return ["name", "size", "label"]; }
    connectedCallback() { this.draw(); }
    attributeChangedCallback() { if (this.isConnected) this.draw(); }
    draw() {
      const name = this.getAttribute("name") || "", size = Number(this.getAttribute("size")) || 16, label = this.getAttribute("label") || "";
      try { this.innerHTML = icon(name, { size, label }); } catch { this.innerHTML = ""; }   // an unknown name draws nothing, never a glyph
    }
  });
}
defineOrIcon();
