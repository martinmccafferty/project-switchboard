// The household's shopping list (D-58, Andy's idea): one list, kept by the exchange. Doris and the porter can read it,
// add to it, take things off and clear it; the list page (numberplease.app/list) and the softphone show it live, and
// the page can tick things off while shopping. The tools are deliberately plain (items in, items out): Claude does the
// thinking, so "eggs, bread and milk" becomes three items and "all the dairy" becomes the butter and the milk.
// Stored in data/shopping.json (git-ignored; on Railway the volume).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.SHOPPING_FILE || 'data/shopping.json';
const MAX_ITEMS = 200;
let items = [];   // [{ id, text, done, added }]
try { items = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* none yet */ }
const watchers = new Set(); // called with the list whenever it changes (softphones, the list page)
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(items, null, 2));
  fs.renameSync(`${FILE}.tmp`, FILE); // atomic: a crash never leaves half a file
  for (const w of watchers) { try { w(listItems()); } catch { /* a closed page */ } }
}
export const listItems = () => items.map(({ id, text, done }) => ({ id, text, done }));
export const watchList = (fn) => { watchers.add(fn); return () => watchers.delete(fn); };

const tidy = (t) => String(t ?? '').trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 80);
const same = (a, b) => a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// --- Used by the tools and the page alike.
export function addItems(texts = []) {
  const added = []; const already = [];
  for (const raw of texts) {
    const text = tidy(raw);
    if (!text) continue;
    const was = items.find((i) => same(i.text, text));
    if (was && !was.done) { already.push(was.text); continue; }
    if (was) { was.done = false; added.push(was.text); continue; } // ticked off earlier: back on the list
    if (items.length >= MAX_ITEMS) break;
    items.push({ id: crypto.randomUUID(), text, done: false, added: Date.now() }); added.push(text);
  }
  if (added.length) save();
  return { added, already };
}
export function removeItems(texts = []) {
  const removed = []; const notFound = [];
  for (const raw of texts) {
    const i = items.findIndex((x) => same(x.text, tidy(raw)));
    if (i < 0) { notFound.push(tidy(raw)); continue; }
    removed.push(items[i].text); items.splice(i, 1);
  }
  if (removed.length) save();
  return { removed, not_on_list: notFound };
}
export function setDone(id, done) { const i = items.find((x) => x.id === id); if (i) { i.done = !!done; save(); } return !!i; }
export function removeById(id) { const n = items.length; items = items.filter((x) => x.id !== id); if (items.length !== n) save(); }
export function clearDone() { const n = items.length; items = items.filter((x) => !x.done); if (items.length !== n) save(); }
export function clearAll() { const n = items.length; items = []; if (n) save(); return n; }

// --- Tools, for Doris and the porter.
export const shoppingTools = [
  {
    name: 'shopping_list',
    description: "Read the household's shopping list. Items already ticked off on the list page are shown separately.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_shopping_list',
    description: 'Add items to the shopping list, one entry per thing ("eggs, bread and milk" is three). Keep a quantity or '
      + 'detail with its item ("two pints of milk", "a dozen eggs"). Items already on the list are not added twice.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['items'] },
  },
  {
    name: 'remove_from_shopping_list',
    description: 'Take items off the shopping list, named exactly as the list shows them. For a kind of thing ("all the '
      + 'dairy"), read the list first and pass the matching items; if it is unclear which are meant, ask.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['items'] },
  },
  {
    name: 'clear_shopping_list',
    description: 'Empty the whole shopping list. Only after the caller has said yes to clearing all of it.',
    input_schema: { type: 'object', properties: { caller_confirmed: { type: 'boolean', description: 'True only if the caller said yes to clearing it all.' } }, required: ['caller_confirmed'] },
  },
];
export const shoppingHandlers = {
  shopping_list: () => {
    const open = items.filter((i) => !i.done).map((i) => i.text); const done = items.filter((i) => i.done).map((i) => i.text);
    return { on_the_list: open, ...(done.length ? { ticked_off: done } : {}) };
  },
  add_to_shopping_list: ({ items: t = [] }) => ({ ...addItems(t), now_on_list: items.filter((i) => !i.done).length }),
  remove_from_shopping_list: ({ items: t = [] }) => ({ ...removeItems(t), now_on_list: items.filter((i) => !i.done).length }),
  clear_shopping_list: ({ caller_confirmed }) => (caller_confirmed ? { cleared: clearAll() } : { error: 'Ask the caller to confirm clearing the whole list first.' }),
};

// For the characters.
export const shoppingForPersona = () => '- The household\'s shopping list: read it out, add to it, take things off, or clear it. One entry per '
  + 'thing; "we\'re out of milk" means add milk. Before saying what is on it, always look at the list afresh: someone may have '
  + 'changed it on the list page since. Read it naturally ("Five things: eggs, bread, …"); for a long list give the '
  + 'count and ask whether to read it all. Clear the whole list only after a yes. It\'s also on the list page'
  + `${process.env.PUBLIC_HOST ? ` (said aloud: "${(process.env.PUBLIC_HOST_SPOKEN || process.env.PUBLIC_HOST.replaceAll('.', ' dot ')).trim()} slash list")` : ''}, `
  + 'where it can be ticked off while shopping.';
