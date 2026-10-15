import { canonicalizeMathML } from './math-tree.js';

// Plain-JSON shape of a napkin's body in schema v3. It is the same shape the
// editor (ProseMirror) reads and writes, but nothing here imports it, so the
// domain stays importable on its own.
//
//   { type: 'doc', content: [ title?, paragraph, ... ] }
//   title:     { type: 'title', content?: [ text ] }     the first line, the note's name
//   paragraph: { type: 'paragraph', content?: [ text | math, ... ] }
//   text:      { type: 'text', text: '<non-empty string>' }
//   math:      { type: 'math', attrs: { mathml, source, sourceKind } }
//
// A speakable label for a math node is derived when it is shown. It is not stored.

export const MATH_SOURCE_KINDS = ['latex', 'nemeth'];

export function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** The name a note has while its title is empty. */
export const DEFAULT_NOTE_NAME = 'Untitled note';

const isTitle = (block) => block?.type === 'title';

/** The text of the title, or '' when there is none. */
export function docTitle(doc) {
  const block = doc?.content?.[0];
  return isTitle(block) ? (block.content ?? []).map((n) => n.text ?? '').join('') : '';
}

/**
 * The same doc with its first line as the title. A doc saved before titles
 * existed has none, so the note's name becomes it. Passing the default name
 * leaves the title empty, so a new note shows a placeholder, not "Untitled note".
 * `replace` swaps an existing title, for a rename.
 */
export function docWithTitle(doc, name, { replace = false } = {}) {
  const text = name === DEFAULT_NOTE_NAME ? '' : String(name ?? '').replace(/\s+/g, ' ').trim();
  const block = text === '' ? { type: 'title' } : { type: 'title', content: [{ type: 'text', text }] };
  const content = doc?.content ?? [];
  if (isTitle(content[0])) {
    return replace ? { ...doc, content: [block, ...content.slice(1)] } : doc;
  }
  return { ...doc, content: [block, ...content] };
}

/** The name a note should have, given its title. */
export function nameFromDoc(doc) {
  return docTitle(doc).replace(/\s+/g, ' ').trim() || DEFAULT_NOTE_NAME;
}

/** The first line of the body that has any text, for the notes list. */
export function docSnippet(doc, max = 80) {
  for (const block of doc?.content ?? []) {
    if (isTitle(block)) continue;
    const text = (block.content ?? []).map((n) => (n.type === 'text' ? n.text : '[equation]')).join('').trim();
    if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  return '';
}

export function mathNode({ mathml, source = '', sourceKind = 'latex' }) {
  if (typeof mathml !== 'string' || !mathml.trim().startsWith('<math')) {
    throw new TypeError('Math nodes require MathML');
  }
  return {
    type: 'math',
    attrs: { mathml: canonicalizeMathML(mathml, { keepLatex: true }), source, sourceKind },
  };
}

function textNodes(text) {
  return text === '' ? [] : [{ type: 'text', text }];
}

function paragraph(children) {
  return children.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content: children };
}

// A v2 text item can hold line breaks. A text node cannot, so each line is a paragraph.
function paragraphsFromText(source) {
  return String(source).split(/\r?\n/).map((line) => paragraph(textNodes(line)));
}

/**
 * Convert a v2 `items` list to a v3 doc.
 *  - text item      -> one paragraph per line
 *  - equation item  -> a paragraph holding one math node (it shows as a display equation)
 *  - note text      -> its own paragraph after the item. The note field is gone in v3,
 *                      and a note is the user's own writing, so it is kept as text.
 * An equation whose MathML cannot be read is kept as a paragraph of text that
 * says so, instead of being dropped.
 */
export function itemsToDoc(items) {
  const content = [];
  for (const item of items ?? []) {
    if (item?.type === 'text') {
      content.push(...paragraphsFromText(item.source ?? ''));
    } else if (item?.type === 'equation') {
      try {
        content.push(paragraph([mathNode({ mathml: item.math?.mathml ?? item.mathml })]));
      } catch {
        content.push(paragraph(textNodes('[An equation here could not be converted.]')));
      }
    }
    if (typeof item?.note === 'string' && item.note.trim() !== '') {
      content.push(...paragraphsFromText(item.note));
    }
  }
  return content.length === 0 ? emptyDoc() : { type: 'doc', content };
}

export function validateDoc(doc) {
  const issues = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.type !== 'doc') {
    return ['Document must be an object of type doc'];
  }
  if (!Array.isArray(doc.content) || doc.content.length === 0
      || (isTitle(doc.content[0]) && doc.content.length === 1)) {
    return ['Document needs at least one paragraph'];
  }
  doc.content.forEach((block, i) => {
    if (i === 0 && isTitle(block)) {
      const only = block.content === undefined
        || (Array.isArray(block.content) && block.content.length > 0
          && block.content.every((n) => n?.type === 'text' && typeof n.text === 'string' && n.text !== ''));
      if (!only) issues.push('The title may hold only text');
      return;
    }
    if (!block || block.type !== 'paragraph') {
      issues.push(`Block ${i} must be a paragraph`);
      return;
    }
    if (block.content === undefined) return;
    if (!Array.isArray(block.content) || block.content.length === 0) {
      issues.push(`Paragraph ${i} content must be a non-empty array when present`);
      return;
    }
    for (const node of block.content) {
      if (node?.type === 'text') {
        if (typeof node.text !== 'string' || node.text === '') {
          issues.push(`Paragraph ${i} has an empty text node`);
        }
      } else if (node?.type === 'math') {
        const a = node.attrs;
        if (!a || typeof a.mathml !== 'string' || !a.mathml.trim().startsWith('<math')) {
          issues.push(`Paragraph ${i} has a math node without MathML`);
        } else if (typeof a.source !== 'string') {
          issues.push(`Paragraph ${i} has a math node whose source is not a string`);
        } else if (!MATH_SOURCE_KINDS.includes(a.sourceKind)) {
          issues.push(`Paragraph ${i} has a math node with an unknown sourceKind`);
        }
      } else {
        issues.push(`Paragraph ${i} holds a node that is neither text nor math`);
      }
    }
  });
  return issues;
}

/** Plain text of a doc, with equations as their source text, for counts and search. */
export function docPlainText(doc) {
  return (doc?.content ?? [])
    .filter((block) => !isTitle(block))
    .map((block) => (block.content ?? []).map((n) => (n.type === 'text' ? n.text : n.attrs?.source ?? '')).join(''))
    .join('\n');
}
