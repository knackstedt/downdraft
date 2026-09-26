// ============================================================================
// mini-xml.ts — minimal XML parser for runtimes without a real DOMParser.
//
// The native runtime's DOMParser is a Pixi stub that returns empty results.
// COLLADA (.dae) parsing needs a small DOM surface: getElementsByTagName,
// getElementById, getAttribute, textContent, children, tagName. This parser
// produces exactly that — it is not a general XML implementation (no
// namespaces, DTDs, or mixed-content fidelity beyond text concatenation).
// ============================================================================

export interface MiniXmlElement {
  tagName: string;
  attributes: Map<string, string>;
  children: MiniXmlElement[];
  /** Concatenated character data of this element and its descendants. */
  textContent: string;
  ownerDocument: MiniXmlDocument | null;
  getAttribute(name: string): string | null;
  getElementsByTagName(name: string): MiniXmlElement[];
}

export interface MiniXmlDocument {
  documentElement: MiniXmlElement;
  getElementsByTagName(name: string): MiniXmlElement[];
  getElementById(id: string): MiniXmlElement | null;
}

class El implements MiniXmlElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: El[] = [];
  textParts: string[] = [];
  parent: El | null = null;
  ownerDocument: MiniXmlDocument | null = null;

  constructor(tag: string) {
    this.tagName = tag;
  }

  get textContent(): string {
    let s = this.textParts.join("");
    this.children.forEach((c) => { s += c.textContent;; });
    return s;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getElementsByTagName(name: string): MiniXmlElement[] {
    const out: MiniXmlElement[] = [];
    const lower = name.toLowerCase();
    const walk = (el: El) => {
      el.children.forEach((c) => {
        if (c.tagName.toLowerCase() === lower) out.push(c);
        walk(c);
      });
    };
    walk(this);
    return out;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

const ATTR_RE = /([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g;

/**
 * Parse well-formed XML into a MiniXmlDocument. Throws on malformed input.
 * Tag matching for getElementsByTagName is case-insensitive and ignores
 * namespace prefixes (`x:foo` matches "foo").
 */
export function parseMiniXml(text: string): MiniXmlDocument {
  const root = new El("#document");
  const stack: El[] = [root];
  const byId = new Map<string, El>();
  let i = 0;
  const n = text.length;

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      top().textParts.push(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) top().textParts.push(decodeEntities(text.slice(i, lt)));

    // Comments / CDATA / processing instructions / doctype.
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt);
      top().textParts.push(text.slice(lt + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const gt = text.indexOf(">", lt);
    if (gt < 0) throw new Error("mini-xml: unterminated tag");

    const inner = text.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      // Pop to the matching open tag (tolerates mis-nested content).
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tagName.toLowerCase() === name) {
          stack.length = s;
          break;
        }
      }
      i = gt + 1;
      continue;
    }

    const selfClose = inner.endsWith("/");
    const body = selfClose ? inner.slice(0, -1) : inner;
    const sp = body.search(/[\s]/);
    const tag = (sp < 0 ? body : body.slice(0, sp)).trim();
    // Strip namespace prefix so getElementsByTagName("source") matches <ns:source>.
    const local = tag.includes(":") ? tag.slice(tag.indexOf(":") + 1) : tag;
    const el = new El(local);
    el.parent = top();

    const attrText = sp < 0 ? "" : body.slice(sp + 1);
    ATTR_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = ATTR_RE.exec(attrText))) {
      const key = am[1].includes(":") ? am[1].slice(am[1].indexOf(":") + 1) : am[1];
      const val = decodeEntities(am[2].slice(1, -1));
      el.attributes.set(key, val);
      if (key === "id") byId.set(val, el);
    }

    top().children.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }

  const docEl = root.children[0];
  if (!docEl) throw new Error("mini-xml: no document element");

  const doc: MiniXmlDocument = {
    documentElement: docEl,
    getElementsByTagName: (name) => root.getElementsByTagName(name),
    getElementById: (id) => byId.get(id) ?? null,
  };
  const attach = (el: El) => { el.ownerDocument = doc; el.children.forEach(attach); };
  attach(docEl);
  return doc;
}
