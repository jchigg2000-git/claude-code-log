import { marked } from "marked";

type Attrs = Record<string, string | number | boolean | EventListener>;

/** Tiny hyperscript helper. Event handlers are passed as on* attributes. */
export function el(tag: string, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      node.className = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else if (v !== false) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Render Markdown from local spec files. Content is local and trusted. */
export function renderMarkdown(src: string): HTMLElement {
  const div = el("div", { class: "md" });
  div.innerHTML = marked.parse(src, { async: false }) as string;
  return div;
}
