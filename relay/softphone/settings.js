// The settings page (D-37, D-39): reads and saves the relay's household settings through /api/settings.
const $ = (id) => document.getElementById(id);
let data = null; let devices = []; let dirty = false;

const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'group';
function message(text, bad = false) { $('message').textContent = text; $('message').className = bad ? 'bad' : ''; }
function changed() { dirty = true; message('Unsaved changes'); }

// --- Household
function fillHousehold(h) {
  $('location').value = h.location ?? '';
  const zones = Intl.supportedValuesOf('timeZone');
  if (h.timezone && !zones.includes(h.timezone)) zones.unshift(h.timezone);
  $('timezone').replaceChildren(...zones.map((z) => el('option', { value: z, textContent: z.replaceAll('_', ' ') })));
  $('timezone').value = h.timezone;
  for (const r of document.querySelectorAll('input[name=unit]')) r.checked = r.value === (h.temperatureUnit ?? 'fahrenheit');
  $('keywords').value = (h.transcribeKeywords ?? []).join(', ');
}
async function checkLocation() {
  const found = $('found'); found.className = 'found'; found.textContent = 'Looking…';
  const res = await fetch(`/api/place?q=${encodeURIComponent($('location').value)}`);
  if (!res.ok) { found.className = 'found bad'; found.textContent = "Couldn't find that place. Try adding the state or country."; return; }
  const place = await res.json();
  found.className = 'found ok'; found.textContent = `Found: ${place.name}`;
  if (place.timezone && place.timezone !== $('timezone').value) {
    const use = el('button', { className: 'quiet', textContent: `Use its time zone (${place.timezone.replaceAll('_', ' ')})` });
    use.onclick = () => { $('timezone').value = place.timezone; use.remove(); changed(); };
    found.append(' ', use);
  }
}

// --- Groups of blinds and curtains
function groupCard(g) {
  const card = el('div', { className: 'group' }); card.group = g;
  const title = el('strong', { textContent: g.name || 'New group' });
  const remove = el('button', { className: 'quiet', textContent: 'Remove' });
  remove.onclick = () => { if (confirm(`Remove ${g.name || 'this group'}?`)) { card.remove(); refreshOffers(); changed(); } };
  const name = el('input', { type: 'text', value: g.name ?? '', placeholder: 'e.g. the living room blinds' });
  name.oninput = () => { title.textContent = name.value || 'New group'; refreshOffers(); };
  const where = el('input', { type: 'text', value: g.where ?? '', placeholder: 'e.g. the three blinds across the front' });
  const says = el('input', { type: 'text', value: (g.callersSay ?? []).join(', '), placeholder: 'e.g. the blinds, the front blinds' });
  // Devices: every blind and curtain on the account, plus any saved ones the account no longer lists.
  const mine = new Map((g.devices ?? []).map((d) => [d.id, d]));
  const all = [...devices, ...[...mine.values()].filter((d) => !devices.some((x) => x.id === d.id))];
  const checks = el('div', { className: 'checks' }, ...all.map((d) => {
    const box = el('input', { type: 'checkbox', checked: mine.has(d.id) }); box.device = mine.get(d.id) ?? d;
    // The household's name for it if saved, with SwitchBot's name alongside so the device can be told apart.
    const ours = mine.get(d.id)?.name; const theirs = devices.find((x) => x.id === d.id)?.name;
    return el('label', {}, box, `${ours ?? d.name} `,
      el('span', { className: 'devname', textContent: `(${ours && theirs && ours !== theirs ? `${theirs}, ` : ''}${d.kind})` }));
  }));
  checks.className = 'checks devices';
  const offers = el('div', { className: 'checks offers' });
  card.append(
    el('div', { className: 'group-head' }, title, remove),
    el('label', { className: 'field', textContent: 'Name' }), name,
    el('label', { className: 'field', textContent: 'Where it is' }), where,
    el('label', { className: 'field', textContent: 'Callers might say' }), says,
    el('div', { className: 'hint', textContent: 'Separated by commas. Say "the blinds" here for the group meant when no room is named.' }),
    el('label', { className: 'field', textContent: 'Devices' }), checks,
    el('label', { className: 'field', textContent: 'After moving these, Doris offers' }), offers);
  card.read = () => ({
    id: g.id || slug(name.value), name: name.value.trim(), where: where.value.trim(), callersSay: list(says.value),
    offerNext: [...offers.querySelectorAll('input:checked')].map((b) => b.value),
    devices: [...checks.querySelectorAll('input:checked')].map((b) => b.device),
  });
  return card;
}
// The "offers" checkboxes list the other groups, by their current names.
function refreshOffers() {
  const cards = [...document.querySelectorAll('.group')];
  for (const card of cards) {
    const box = card.querySelector('.offers');
    const was = new Set([...box.querySelectorAll('input:checked')].map((b) => b.value).concat(box.dataset.loaded ? [] : card.group.offerNext ?? []));
    box.dataset.loaded = '1';
    const others = cards.filter((c) => c !== card).map((c) => c.read());
    box.replaceChildren(...(others.length ? others.map((o) => el('label', {}, el('input', { type: 'checkbox', value: o.id, checked: was.has(o.id) }), o.name || o.id))
      : [el('span', { className: 'hint', textContent: 'No other groups yet.' })]));
  }
}

// --- News feeds
function feedRow(f = {}) {
  const name = el('input', { type: 'text', value: f.name ?? '', placeholder: 'e.g. WRAL, Raleigh' });
  const url = el('input', { type: 'text', value: f.url ?? '', placeholder: 'https://… (RSS feed address)', className: 'url' });
  const remove = el('button', { className: 'quiet', textContent: 'Remove' });
  const row = el('div', { className: 'feed' }, name, url, remove);
  remove.onclick = () => { row.remove(); changed(); };
  row.read = () => ({ name: name.value.trim(), url: url.value.trim() });
  return row;
}

// --- Load and save
function read() {
  return {
    household: {
      location: $('location').value.trim(), timezone: $('timezone').value,
      temperatureUnit: document.querySelector('input[name=unit]:checked')?.value ?? 'fahrenheit',
      transcribeKeywords: list($('keywords').value),
    },
    home: { ...data.home, layout: $('layout').value.trim(), groups: [...document.querySelectorAll('.group')].map((c) => c.read()) },
    news: { feeds: [...document.querySelectorAll('.feed')].map((r) => r.read()).filter((f) => f.name || f.url) },
    access: { emails: list($('emails').value) },
  };
}
async function save() {
  message('Saving…');
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(read()) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { message(body.error ?? 'Couldn\'t save.', true); return; }
  data = body; dirty = false; message('Saved. The phone uses these from the next call.');
}

async function load() {
  data = await (await fetch('/api/settings')).json();
  fillHousehold(data.household ?? {});
  $('layout').value = data.home?.layout ?? '';
  $('feeds').replaceChildren(...(data.news?.feeds ?? []).map(feedRow));
  $('emails').value = (data.access?.emails ?? []).join(', ');
  fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => { if (me) $('me').textContent = me.email; }).catch(() => {});
  try {
    const res = await fetch('/api/devices'); if (!res.ok) throw new Error((await res.json()).error);
    devices = await res.json();
  } catch (err) { $('devices-note').textContent = `Couldn't reach SwitchBot to list devices (${err.message}); showing saved ones only.`; }
  $('groups').replaceChildren(...(data.home?.groups ?? []).map(groupCard));
  refreshOffers();
  message('');
}

$('check').onclick = checkLocation;
$('add').onclick = () => { const c = groupCard({}); $('groups').append(c); refreshOffers(); c.querySelector('input').focus(); changed(); };
$('add-feed').onclick = () => { const r = feedRow(); $('feeds').append(r); r.querySelector('input').focus(); changed(); };
$('save').onclick = save;
document.addEventListener('input', changed);
document.addEventListener('change', changed);
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
load().catch((err) => message(`Couldn't load settings: ${err.message}`, true));
