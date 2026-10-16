import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertValidState,
  createInitialState,
  createNapkin,
  deleteNapkin,
  getActiveNapkin,
  renameNapkin,
  setNapkinDoc,
  switchNapkin,
  validateState
} from '../../src/domain/model.js';
import { emptyDoc, docSnippet, docWithTitle, nameFromDoc } from '../../src/domain/document.js';

function ids(...values) {
  let index = 0;
  return () => values[index++];
}

const hello = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

test('creates one active untitled napkin with one empty paragraph', () => {
  const state = createInitialState({ idFactory: ids('napkin-1') });

  assert.equal(state.schemaVersion, 3);
  assert.equal(state.activeNapkinId, 'napkin-1');
  assert.deepEqual(state.napkins, [{ id: 'napkin-1', name: 'Untitled note', doc: emptyDoc() }]);
});

test('creates and switches between independent napkins without mutating prior state', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const created = createNapkin(initial, '  Scratch work  ', { idFactory: ids('napkin-2') });

  assert.notEqual(created, initial);
  assert.equal(initial.napkins.length, 1);
  assert.equal(created.activeNapkinId, 'napkin-2');
  assert.equal(getActiveNapkin(created).name, 'Scratch work');
  assert.deepEqual(getActiveNapkin(created).doc, docWithTitle(emptyDoc(), 'Scratch work'));

  const switched = switchNapkin(created, 'napkin-1');
  assert.equal(switched.activeNapkinId, 'napkin-1');
});

test('deletes a napkin immutably, including the final napkin', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const second = createNapkin(initial, 'Second napkin', { idFactory: ids('napkin-2') });
  const third = createNapkin(second, 'Third napkin', { idFactory: ids('napkin-3') });

  const withoutThird = deleteNapkin(third, 'napkin-3');
  assert.equal(third.napkins.length, 3);
  assert.deepEqual(withoutThird.napkins.map(({ id }) => id), ['napkin-1', 'napkin-2']);
  assert.equal(withoutThird.activeNapkinId, 'napkin-2');

  const withoutFirst = deleteNapkin(withoutThird, 'napkin-1');
  assert.deepEqual(withoutFirst.napkins.map(({ id }) => id), ['napkin-2']);
  assert.equal(withoutFirst.activeNapkinId, 'napkin-2');

  const empty = deleteNapkin(withoutFirst, 'napkin-2');
  assert.deepEqual(empty.napkins, []);
  assert.equal(empty.activeNapkinId, null);
  assert.deepEqual(validateState(empty), { ok: true, issues: [] });
});

test('rejects a blank napkin name', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  assert.throws(() => createNapkin(initial, '   '), /Note name is required/);
});

test('renames a napkin immutably, trimming the name and leaving other napkins alone', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const withSecond = createNapkin(initial, 'Second napkin', { idFactory: ids('napkin-2') });

  const renamed = renameNapkin(withSecond, 'napkin-1', '  Proof ideas  ');
  assert.notEqual(renamed, withSecond);
  assert.equal(withSecond.napkins[0].name, 'Untitled note');
  assert.equal(renamed.napkins.find(({ id }) => id === 'napkin-1').name, 'Proof ideas');
  assert.equal(renamed.napkins.find(({ id }) => id === 'napkin-2').name, 'Second napkin');
  assert.equal(renamed.activeNapkinId, withSecond.activeNapkinId);
});

test('rejects a blank rename and an unknown napkin id', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  assert.throws(() => renameNapkin(initial, 'napkin-1', '   '), /Note name is required/);
  assert.throws(() => renameNapkin(initial, 'missing', 'New name'), /Napkin not found/);
});

test('setNapkinDoc replaces one body and leaves the others and the input alone', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const withSecond = createNapkin(initial, 'Second', { idFactory: ids('napkin-2') });

  const next = setNapkinDoc(withSecond, 'napkin-1', hello);
  assert.notEqual(next, withSecond);
  assert.deepEqual(next.napkins[0].doc, hello);
  assert.deepEqual(next.napkins[1].doc, docWithTitle(emptyDoc(), 'Second'));
  assert.deepEqual(withSecond.napkins[0].doc, emptyDoc());
  assert.equal(next.activeNapkinId, 'napkin-2');
});

test('setNapkinDoc refuses a bad document and an unknown napkin', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  assert.throws(() => setNapkinDoc(initial, 'napkin-1', { type: 'doc', content: [] }), /at least one paragraph/);
  assert.throws(() => setNapkinDoc(initial, 'missing', hello), /Napkin not found/);
});

test('validation rejects duplicate IDs and a dangling active id', () => {
  const state = createInitialState({ idFactory: ids('napkin-1') });
  const duplicate = { ...state, napkins: [...state.napkins, { ...state.napkins[0] }] };
  assert.match(validateState(duplicate).issues.join(';'), /Duplicate napkin id: napkin-1/);
  assert.match(validateState({ ...state, activeNapkinId: 'nope' }).issues.join(';'), /activeNapkinId/);
});

test('validation rejects other schema versions, items-style napkins and bad docs', () => {
  const state = createInitialState({ idFactory: ids('napkin-1') });
  assert.match(validateState({ ...state, schemaVersion: 2 }).issues.join(';'), /schemaVersion must be 3/);
  const old = { ...state, napkins: [{ id: 'napkin-1', name: 'Old', items: [] }] };
  assert.match(validateState(old).issues.join(';'), /type doc/);
  const bad = { ...state, napkins: [{ ...state.napkins[0], doc: { type: 'doc', content: [{ type: 'heading' }] } }] };
  assert.match(validateState(bad).issues.join(';'), /must be a paragraph/);
  assert.throws(() => assertValidState(bad), /Invalid application state/);
});

test('a note takes its name from the first line, and keeps it when the body has no title', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const titled = docWithTitle(hello, 'Algebra', { replace: true });
  const next = setNapkinDoc(initial, 'napkin-1', titled);
  assert.equal(next.napkins[0].name, 'Algebra');
  assert.equal(nameFromDoc(docWithTitle(hello, '')), 'Untitled note', 'an empty title gets the default name');
  const untitled = setNapkinDoc(next, 'napkin-1', hello);
  assert.equal(untitled.napkins[0].name, 'Algebra', 'a body with no title leaves the name alone');
});

test('renaming also writes the new name into the title', () => {
  const initial = createInitialState({ idFactory: ids('napkin-1') });
  const renamed = renameNapkin(setNapkinDoc(initial, 'napkin-1', docWithTitle(hello, 'Old')), 'napkin-1', 'New name');
  assert.equal(renamed.napkins[0].doc.content[0].content[0].text, 'New name');
});

test('the list preview is the first line of the body, with equations as a word, never their source', () => {
  const doc = docWithTitle({ type: 'doc', content: [
    { type: 'paragraph' },
    { type: 'paragraph', content: [
      { type: 'text', text: 'Roots of ' },
      { type: 'math', attrs: { mathml: '<math/>', source: 'a \\neq 0', sourceKind: 'latex' } }
    ] }
  ] }, 'Quadratic');
  assert.equal(docSnippet(doc), 'Roots of [equation]');
});

test('the list preview keeps a first line that is exactly as long as the limit', () => {
  const line = 'a'.repeat(80);
  const doc = docWithTitle({ type: 'doc', content: [
    { type: 'paragraph' },
    { type: 'paragraph', content: [{ type: 'text', text: line }] }
  ] }, 'Long line');
  assert.equal(docSnippet(doc), line);
  assert.equal(docSnippet(doc, 79), `${'a'.repeat(78)}…`);
});
