/**
 * HTML sanitizer for markdown rendered from crawled repos.
 *
 * `renderMarkdown` turns `marked.parse(...)` output into `innerHTML`, and
 * `marked` passes raw HTML embedded in markdown straight through. The
 * markdown source comes from a caller-supplied `repoRoot` that isn't
 * necessarily "the operator's own" — a mistyped path, a shared/symlinked
 * root, or a vendored third-party file all turn arbitrary markdown into
 * arbitrary HTML rendered in this page. This module strips that down to an
 * inert subset before it reaches a live DOM.
 *
 * Sanitization here works by PARSING and walking the tree, not by regex.
 * Regex-based HTML sanitizers are broken by construction: HTML's grammar
 * (nesting, attribute quoting, entity decoding, tag-soup recovery rules)
 * isn't regular, so there is always a malformed-but-browser-parseable input
 * that slips past any hand-written pattern. The DOM parser already
 * implements that grammar correctly, so we let it do the parsing and just
 * remove what we don't trust from the resulting tree.
 */

// Elements that are dangerous just by existing — removed together with
// their entire subtree, never re-parented or unwrapped.
const DANGEROUS_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
]);

// Every attribute markdown actually produces. Everything else is stripped —
// which is what kills `onclick`, `onerror`, `onload`, and every other event
// handler (and every future/experimental attribute) by construction. We
// never enumerate the dangerous set, so there is nothing to forget.
const ATTR_ALLOWLIST = new Set([
  "href",
  "src",
  "alt",
  "title",
  "class",
  "id",
  "lang",
  "dir",
  "colspan",
  "rowspan",
  "start",
  "type",
  "width",
  "height",
  "align",
]);

const URL_ATTRS = new Set(["href", "src"]);

// data: is rejected outright, including data:image/* — SVG data URIs can
// carry <script>, and there is no markdown feature that needs data: URLs.
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * True if `raw` is safe to use as an href/src value: relative, a
 * fragment (#foo), or an explicit http:/https:/mailto: scheme.
 *
 * Exported for testing: this is the security-critical decision in the module
 * and it is pure, so it can be exercised without a DOM.
 */
export function isSafeUrl(raw: string): boolean {
  // Strip control characters and all whitespace before testing the scheme.
  // Browsers ignore embedded tabs/newlines/control chars when resolving a
  // URL scheme, so "java\tscript:alert(1)" *is* a javascript: URL as far as
  // the browser is concerned even though a naive `startsWith("javascript:")`
  // check would miss it. Stripping first closes that bypass.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (cleaned === "") return true; // empty is inert
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) return true; // no scheme => relative path or #fragment
  const scheme = schemeMatch[1].toLowerCase() + ":";
  return ALLOWED_SCHEMES.has(scheme);
}

function sanitizeAttributes(el: Element, tag: string): void {
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!ATTR_ALLOWLIST.has(name)) {
      el.removeAttribute(attr.name);
      continue;
    }
    // "type" is only meaningful (and only markdown-produced) on ol/li, for
    // the "1"/"a"/"i" numbering style — drop it everywhere else.
    if (name === "type" && tag !== "ol" && tag !== "li") {
      el.removeAttribute(attr.name);
      continue;
    }
    if (URL_ATTRS.has(name) && !isSafeUrl(attr.value)) {
      el.removeAttribute(attr.name);
    }
  }
}

function sanitizeChildren(parent: Node): void {
  // Snapshot first: we mutate (remove) nodes while iterating.
  for (const child of Array.from(parent.childNodes)) {
    switch (child.nodeType) {
      case Node.ELEMENT_NODE: {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();
        if (DANGEROUS_TAGS.has(tag)) {
          el.remove(); // removes the element AND its entire subtree
          continue;
        }
        sanitizeAttributes(el, tag);
        sanitizeChildren(el);
        break;
      }
      case Node.TEXT_NODE:
        break; // text is always inert, keep it
      case Node.COMMENT_NODE:
      default:
        // Drop comments (and anything else parsing left behind, e.g. stray
        // processing-instruction-like nodes) defensively.
        parent.removeChild(child);
        break;
    }
  }
}

/**
 * Parse `html` and return a sanitized DocumentFragment safe to attach to a
 * live document.
 *
 * `DOMParser.parseFromString(html, "text/html")` builds a detached document
 * that is never inserted into the page: it does not execute <script>, does
 * not load images/iframes/stylesheets, and cannot navigate. That inertness
 * is exactly why it's the right primitive here — we get a real, spec-correct
 * HTML tree to walk, with zero side effects from the untrusted input, and
 * only the parts we explicitly keep ever reach the live DOM.
 *
 * Never throws: malformed input degrades to an empty (or partial) fragment
 * rather than propagating an exception to the caller.
 */
export function sanitizeHtml(html: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    sanitizeChildren(doc.body);
    while (doc.body.firstChild) {
      fragment.appendChild(doc.body.firstChild);
    }
  } catch {
    // Fall through and return whatever (possibly empty) fragment we have.
  }
  return fragment;
}
