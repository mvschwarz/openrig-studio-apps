// A small YAML reader for the observatory rig's own files, so their checks need no dependency.
// It handles the subset those files use: comments, nested mappings, sequences of scalars or
// mappings, [flow, lists], quoted strings and folded (>) blocks. Anything else is an error, so a
// file that drifts outside the subset fails loudly instead of being half-read.

function splitFlow(body) {
  const items = [];
  let cur = "", q = null;
  for (const c of body) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ",") { items.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());
  return items;
}

function scalar(raw) {
  const v = raw.trim();
  if (v === "") return null;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) return splitFlow(v.slice(1, -1)).map(scalar);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

export function parseYaml(text) {
  const lines = text.split("\n").map((l) => stripComment(l).replace(/\s+$/, "")).map((l, n) => ({ n: n + 1, indent: l.length - l.trimStart().length, text: l.trim() })).filter((l) => l.text !== "");
  let i = 0;

  function block(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith("- ") || lines[i].text === "-" ? seq(lines[i].indent) : map(lines[i].indent);
  }

  function folded(parentIndent) {
    const parts = [];
    while (i < lines.length && lines[i].indent > parentIndent) parts.push(lines[i++].text);
    return parts.join(" ");
  }

  function entry(obj, text, indent, n) {
    const m = text.match(/^("[^"]+"|'[^']+'|[^:]+?):(?:\s+(.*))?$/);
    if (!m) throw new Error(`line ${n}: not a mapping entry: ${text}`);
    const key = scalar(m[1]);
    const rest = m[2] ?? "";
    if (rest === ">" || rest === "|") obj[key] = folded(indent);
    else if (rest === "") obj[key] = i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ") ? seq(indent) : null);
    else obj[key] = scalar(rest);
  }

  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const { text, n } = lines[i++];
      entry(obj, text, indent, n);
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return obj;
  }

  function seq(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const { text, n } = lines[i++];
      const item = text.slice(2);
      if (/^("[^"]+"|'[^']+'|[^:\s"'[]+):(\s|$)/.test(item)) {
        const obj = {};
        const itemIndent = indent + 2;
        entry(obj, item, itemIndent, n);
        while (i < lines.length && lines[i].indent === itemIndent && !lines[i].text.startsWith("- ")) { const l = lines[i++]; entry(obj, l.text, itemIndent, l.n); }
        arr.push(obj);
      } else arr.push(scalar(item));
    }
    return arr;
  }

  const out = block(0);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: could not read past here`);
  return out;
}
