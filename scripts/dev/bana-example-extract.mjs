import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = process.env.BANA_SOURCE_TEXT ?? '/private/tmp/Nemeth_2022.txt';
const output = process.argv[2] ?? 'docs/bana-official-examples.json';
const lines = (await readFile(sourcePath, 'utf8')).split(/\r?\n/);
const bodyStart = lines.findIndex((line, index) => index > 300 && /^\s*Rule 1\s*$/.test(line));
const bodyEnd = lines.findIndex((line, index) => index > bodyStart && /^\s*Appendix A\s*$/.test(line));
const pageFor = [];
let page = 1;
for (let i = 0; i < lines.length; i += 1) {
  pageFor[i] = page;
  if (lines[i].includes('\f')) page += 1;
}
const headings = [];
// Reviewed BRF lines that are mathematical but do not use the `_ % ... _:`
// passage wrapper recognized by the general PDF-text extractor. These exact
// strings come from the corresponding printed example blocks below.
const reviewedSourceNotation = new Map([
  ['15-8', ';"x<`:]",a1'],
  // PDF text extracts `"x%_%]` incorrectly because the inverted-caret code
  // embeds `_%` inside the payload and the page footer `15-17` contaminates
  // the candidate line.
  ['15-72', '"x%_%]'],
  ['20-49', '#g_/#d_/#gf']
]);
let currentRule = null;
let currentProvision = null;
for (let i = bodyStart; i >= 0 && i < (bodyEnd > 0 ? bodyEnd : lines.length); i += 1) {
  const ruleMatch = lines[i].trim().match(/^Rule\s+(\d+)\s*$/i);
  if (ruleMatch) {
    currentRule = ruleMatch[1];
    currentProvision = null;
  }
  const provisionMatch = lines[i].trim().match(/^(\d{1,2}(?:\.\d+){1,3}(?:\.[a-z])?)\s+(?!\d)(.+)/i);
  if (provisionMatch && currentRule && (Number(provisionMatch[1].split('.')[0]) === Number(currentRule) || provisionMatch[1] === '4.6.8.c') && !/^\d+\.\d+\s+/.test(lines[i].trim().slice(provisionMatch[0].length - provisionMatch[2].length)) && (!/\bfor rules regarding\b/i.test(provisionMatch[2]) || provisionMatch[1] === '4.6.8.c')) currentProvision = provisionMatch[1];
  const match = lines[i].trim().match(/^Example\s+(\d{1,2}-\d+):?\s*(.*)$/i);
  if (match) headings.push({ number: match[1], title: match[2].trim(), start: i, parent: currentProvision ? `bana-2022:${currentProvision}` : `bana-2022:rule-${currentRule}` });
}
const extracted = headings.map((heading, index) => {
  const end = headings[index + 1]?.start ?? (bodyEnd > 0 ? bodyEnd : lines.length);
  const block = lines.slice(heading.start, end);
  const normalizedBlock = block.map((line) => line.replace(/·/g, ' '));
  const brailleLines = normalizedBlock.filter((line) => /(?:_%|_\s*%|;?%|_?:)/.test(line) || /[⠁-⣿]{2,}/u.test(line));
  const candidate = brailleLines
    .map((line) => line.trim())
    .filter((line) => !/^Example\b/i.test(line) && !/^the following circumstances:/i.test(line));
  const rule = heading.number.split('-')[0];
  const payloads = [];
  for (let lineIndex = 0; lineIndex < normalizedBlock.length; lineIndex += 1) {
    if (!normalizedBlock[lineIndex].includes('_%')) continue;
    let text = normalizedBlock[lineIndex].split('_%')[1] ?? '';
    while (!text.includes('_:') && lineIndex + 1 < normalizedBlock.length) text += ` ${normalizedBlock[++lineIndex]}`;
    text = text.split('_:')[0].replace(/\s+/g, ' ').trim();
    if (text && !/^[-—]+$/.test(text)) payloads.push(text);
  }
  const sourceBraille = payloads[0] ?? reviewedSourceNotation.get(heading.number) ?? null;
  const sourceNotation = sourceBraille && !/[·•]/.test(sourceBraille) ? sourceBraille : null;
  return {
    id: `bana-2022:example-${heading.number}`,
    kind: 'example',
    parentId: heading.parent,
    title: heading.title || `Example ${heading.number}`,
    exampleNumber: heading.number,
    printedPage: null,
    pdfPage: pageFor[heading.start],
    sourceLines: [heading.start + 1, end],
    printAndBraille: block.join('\n').trim(),
    candidateBrailleLines: candidate,
    expectedWholeBraille: sourceBraille,
    sourceNotation,
    inputPolicy: null,
    sourceRows: [heading.parent.replace(/^bana-2022:/, '')],
    creationEvents: [],
    electronCreationCaseIds: [],
    electronEditingCaseIds: [],
    verified: { source: true, implementation: false, creation: false, editing: false, navigation: false, wholeBraille: false, focusedBraille: false, undoRedo: false, persistence: false },
    transcriberReview: 'pending'
  };
});
const examples = [...new Map(extracted.map((example) => [example.id, example])).values()];
const result = {
  schemaVersion: 1,
  source: { textPath: sourcePath },
  counts: { examples: examples.length, withCandidateBraille: examples.filter((example) => example.candidateBrailleLines.length > 0).length },
  examples
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(`BANA official examples written: ${output} (${examples.length} examples)`);
