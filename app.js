'use strict';

const API = '';
const $ = (id) => document.getElementById(id);

let entries = [];
let settings = { name: '', founder: '', defaultRate: 85, startDate: '2026-03-01' };
let currentUserRole = null;
let csrfToken = null;

const ALLOWED_CATEGORIES = new Set([
  'Engineering / Development', 'Design', 'Research & Experimentation',
  'Product / Strategy', 'Marketing / Growth', 'Ops / Admin / Legal',
  'Fundraising / Investor Relations', 'Customer / Sales'
]);
const ALLOWED_CLASSIFICATIONS = new Set(['sweat', 'bill', 'internal']);
const ALLOWED_RD = new Set(['no', 'yes', 'maybe']);
const ALLOWED_STATUS = new Set(['Unpaid', 'Invoiced', 'Paid (W-2)', 'Paid (1099)', 'Converted to equity']);
const ALLOWED_RATE_BASIS = new Set([
  'Market replacement rate', 'Personal W-2 rate (sanity check)',
  'Contractor / 1099 rate', 'Agreed equity-value rate'
]);
const ALLOWED_CONFIDENCE = new Set([
  'High — from contemporaneous log', 'Medium — from calendar/commits', 'Low — reconstructed estimate'
]);

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.style.display = 'block';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-CSRF-Token', csrfToken);

  const response = await fetch(API + path, {
    ...options,
    headers,
    credentials: 'same-origin'
  });

  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || 'Invalid server response' }; }

  if (!response.ok) {
    if (response.status === 401) {
      currentUserRole = null;
      csrfToken = null;
      $('login-modal').classList.remove('hide');
    }
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

async function attemptLogin() {
  const role = $('loginRole').value;
  const password = $('loginPass').value;
  $('loginErr').style.display = 'none';

  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ role, password })
    });
    currentUserRole = data.role;
    csrfToken = data.csrfToken;
    $('login-modal').classList.add('hide');
    $('loginPass').value = '';
    applyRolePermissions();
    await loadState();
  } catch (error) {
    $('loginErr').textContent = error.message;
    $('loginErr').style.display = 'block';
  }
}

async function bootstrapSession() {
  try {
    const me = await api('/api/me');
    currentUserRole = me.role;
    csrfToken = me.csrfToken;
    $('login-modal').classList.add('hide');
    applyRolePermissions();
    await loadState();
  } catch {
    currentUserRole = null;
    csrfToken = null;
    $('login-modal').classList.remove('hide');
  }
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); }
  catch {}
  currentUserRole = null;
  csrfToken = null;
  entries = [];
  $('login-modal').classList.remove('hide');
  $('roleDisplay').textContent = 'Logged Out';
  applyRolePermissions();
  renderAll();
}

function applyRolePermissions() {
  $('roleDisplay').textContent = currentUserRole ? `Role: ${currentUserRole.toUpperCase()}` : 'Logged Out';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hide', currentUserRole !== 'admin');
  });
}

async function loadState() {
  try {
    const d = await api('/api/state');
    entries = Array.isArray(d.entries) ? d.entries : [];
    settings = { ...settings, ...(d.settings || {}) };
  } catch (error) {
    showToast(error.message);
    return;
  }

  initSettings();
  $('date').value = $('date').value || todayStr();
  $('rate').value = settings.defaultRate ?? 85;
  validateAndCalc();
  renderAll();
}

async function persistEntries() {
  try {
    await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify(entries)
    });
    showToast('Entries saved.');
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

async function persistSettings() {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        name: settings.name || '',
        founder: settings.founder || '',
        defaultRate: settings.defaultRate,
        startDate: settings.startDate
      })
    });
    showToast('Settings saved.');
    return true;
  } catch (error) {
    showToast(error.message);
    return false;
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tabName));
  document.querySelectorAll('.tabc').forEach((c) => c.classList.add('hide'));
  $('t-' + tabName).classList.remove('hide');
}

function initSettings() {
  settings.defaultRate = Number.isFinite(Number(settings.defaultRate)) ? Number(settings.defaultRate) : 85;
  settings.startDate = settings.startDate || '2026-03-01';
  $('setName').value = settings.name || '';
  $('setFounder').value = settings.founder || '';
  $('setDefaultRate').value = settings.defaultRate;
  $('setStartDate').value = settings.startDate;
  if (settings.name) $('subhead').textContent = `${settings.name} — tracking since ${settings.startDate}`;
}

async function saveSettings() {
  const rateVal = Number($('setDefaultRate').value);
  const startDate = $('setStartDate').value;
  if (!Number.isFinite(rateVal) || rateVal < 0 || rateVal > 500) {
    showToast('Default rate must be between $0 and $500/hr.');
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    showToast('Tracking start date is required.');
    return;
  }
  settings = {
    name: $('setName').value.trim(),
    founder: $('setFounder').value.trim(),
    defaultRate: rateVal,
    startDate
  };
  if (await persistSettings()) {
    initSettings();
    $('rate').value = settings.defaultRate;
    validateAndCalc();
    renderAll();
  }
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function calcHours() {
  const s = $('start').value;
  const e = $('end').value;
  if (s && e) {
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 1440;
    $('hours').value = (mins / 60).toFixed(2);
  }
  validateAndCalc();
}

function validateAndCalc() {
  const h = Number($('hours').value);
  const r = Number($('rate').value);
  const validH = Number.isFinite(h) && h >= 0;
  const validR = Number.isFinite(r) && r >= 0 && r <= 500;

  $('hoursErr').style.display = validH ? 'none' : 'block';
  $('rateErr').style.display = validR ? 'none' : 'block';

  if (validH && validR) $('value').value = '$' + (h * r).toFixed(2);
  else $('value').value = 'Invalid Input';

  return validH && validR;
}

function resetForm() {
  ['editId', 'start', 'end', 'project', 'task', 'evidence', 'notes'].forEach((i) => { $(i).value = ''; });
  $('date').value = todayStr();
  $('hours').value = '';
  $('category').selectedIndex = 0;
  $('classification').value = 'sweat';
  $('rd').value = 'no';
  $('status').selectedIndex = 0;
  $('confidence').selectedIndex = 1;
  $('rate').value = settings.defaultRate || '';
  $('rateBasis').selectedIndex = 0;
  $('formTitle').textContent = 'Add Time Entry';
  validateAndCalc();
}

function formToEntry(existingId = null) {
  return {
    id: existingId || crypto.randomUUID(),
    date: $('date').value,
    start: $('start').value,
    end: $('end').value,
    hours: Number($('hours').value),
    project: $('project').value.trim(),
    task: $('task').value.trim(),
    category: $('category').value,
    classification: $('classification').value,
    rate: Number($('rate').value),
    rateBasis: $('rateBasis').value,
    rd: $('rd').value,
    status: $('status').value,
    confidence: $('confidence').value,
    evidence: $('evidence').value.trim(),
    notes: $('notes').value.trim()
  };
}

function loadForm(entry) {
  $('formTitle').textContent = 'Edit Entry';
  $('editId').value = entry.id;
  $('date').value = entry.date || '';
  $('start').value = entry.start || '';
  $('end').value = entry.end || '';
  $('hours').value = entry.hours ?? '';
  $('project').value = entry.project || '';
  $('task').value = entry.task || '';
  $('category').value = entry.category || 'Engineering / Development';
  $('classification').value = entry.classification || 'sweat';
  $('rate').value = entry.rate ?? settings.defaultRate;
  $('rateBasis').value = entry.rateBasis || 'Market replacement rate';
  $('rd').value = entry.rd || 'no';
  $('status').value = entry.status || 'Unpaid';
  $('confidence').value = entry.confidence || 'Medium — from calendar/commits';
  $('evidence').value = entry.evidence || '';
  $('notes').value = entry.notes || '';
  validateAndCalc();
  switchTab('add');
}

async function saveEntry() {
  if (!validateAndCalc()) {
    showToast('Please fix validation errors before saving.');
    return;
  }
  const id = $('editId').value || crypto.randomUUID();
  const entry = formToEntry(id);

  if (!entry.date) {
    showToast('Date required.');
    return;
  }

  const idx = entries.findIndex((x) => x.id === id);
  const previous = idx >= 0 ? entries[idx] : null;
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);

  if (await persistEntries()) {
    resetForm();
    renderAll();
    switchTab('entries');
  } else if (previous) {
    entries[idx] = previous;
  } else {
    entries = entries.filter((x) => x.id !== id);
  }
}

async function del(id) {
  if (!confirm('Delete this entry?')) return;
  const previous = entries.find((e) => e.id === id);
  entries = entries.filter((e) => e.id !== id);
  if (!(await persistEntries())) entries.push(previous);
  renderAll();
}

async function clearAll() {
  if (currentUserRole !== 'admin') {
    showToast('Admin role required for bulk deletion.');
    return;
  }
  if (!confirm('Delete ALL entries? This cannot be undone.')) return;
  try {
    await api('/api/entries', { method: 'DELETE' });
    entries = [];
    renderAll();
    showToast('All entries deleted.');
  } catch (error) { showToast(error.message); }
}

async function bulkAdd() {
  if (currentUserRole !== 'admin') {
    showToast('Admin role required for bulk adding.');
    return;
  }
  const raw = $('bulk').value.trim();
  if (!raw) return;

  const additions = [];
  for (const line of raw.split(/\r?\n/)) {
    const p = line.split('|').map((x) => x.trim());
    if (p.length < 3 || !p[0]) continue;

    const hrs = Number(p[2]);
    if (!Number.isFinite(hrs) || hrs < 0) continue;

    additions.push({
      id: crypto.randomUUID(),
      date: p[0],
      start: '',
      end: '',
      hours: hrs,
      project: p[1] || '',
      task: '',
      category: p[3] || 'Engineering / Development',
      classification: 'sweat',
      rate: Number(settings.defaultRate) || 0,
      rateBasis: 'Market replacement rate',
      rd: 'no',
      status: 'Unpaid',
      confidence: 'Medium — from calendar/commits',
      evidence: '',
      notes: ''
    });
  }

  if (!additions.length) {
    showToast('No valid lines found.');
    return;
  }

  const original = entries.slice();
  entries.push(...additions);
  if (await persistEntries()) {
    $('bulk').value = '';
    renderAll();
    showToast(`${additions.length} entries added.`);
  } else {
    entries = original;
  }
}

function exportCSV() {
  const hdr = ['id','date','start','end','hours','project','task','category','classification','rate','rateBasis','rd','status','confidence','evidence','notes','value'];
  const lines = [hdr.map(csvEscape).join(',')];
  for (const e of entries) {
    const val = (Number(e.hours) * Number(e.rate || 0)).toFixed(2);
    const row = hdr.map((h) => csvEscape(h === 'value' ? val : (e[h] ?? '')));
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `startup-hours-${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  let v = String(value);
  if (/^[=+\-@]/.test(v)) v = "'" + v; // spreadsheet-formula defense
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') { field += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { row.push(field); field = ''; continue; }
    if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  row.push(field);
  if (row.some((v) => v.length)) rows.push(row);
  return rows;
}

async function importCSV(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  const text = await file.text();
  const rows = parseCSV(text);
  if (rows.length < 2) {
    showToast('CSV contains no data rows.');
    return;
  }

  const headers = rows[0].map((h) => h.trim());
  const imported = [];

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i];
    const obj = {};
    headers.forEach((h, idx) => obj[h] = values[idx] ?? '');
    const hours = Number(obj.hours);
    const rate = Number(obj.rate);

    if (!Number.isFinite(hours) || hours < 0) continue;
    if (!Number.isFinite(rate) || rate < 0 || rate > 500) continue;

    imported.push({
      id: crypto.randomUUID(),
      date: obj.date || '',
      start: obj.start || '',
      end: obj.end || '',
      hours,
      project: obj.project || '',
      task: obj.task || '',
      category: obj.category || 'Engineering / Development',
      classification: obj.classification || 'sweat',
      rate,
      rateBasis: obj.rateBasis || 'Market replacement rate',
      rd: obj.rd || 'no',
      status: obj.status || 'Unpaid',
      confidence: obj.confidence || 'Medium — from calendar/commits',
      evidence: obj.evidence || '',
      notes: obj.notes || ''
    });
  }

  if (!imported.length) {
    showToast('No valid CSV rows found.');
    return;
  }

  const original = entries.slice();
  entries.push(...imported);
  if (await persistEntries()) {
    renderAll();
    showToast(`${imported.length} rows imported.`);
  } else {
    entries = original;
  }
}

function addText(parent, tag, text, className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text ?? '';
  parent.appendChild(el);
  return el;
}

function makeButton(text, className, handler) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = className;
  b.addEventListener('click', handler);
  return b;
}

function renderAll() {
  renderStats();
  renderTable();
  renderProjList();
  renderByMonth();
  renderByProject();
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function money(n) {
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function renderStats() {
  const total = entries.reduce((s, e) => s + Number(e.hours || 0), 0);
  const sweat = entries.filter((e) => e.classification === 'sweat').reduce((s, e) => s + Number(e.hours || 0), 0);
  const rd = entries.filter((e) => e.rd === 'yes' || e.rd === 'maybe').reduce((s, e) => s + Number(e.hours || 0), 0);
  const val = entries.reduce((s, e) => s + Number(e.hours || 0) * Number(e.rate || 0), 0);

  const stats = $('stats');
  stats.replaceChildren();
  const cards = [
    [fmt(total), 'Total Hours', 'accent'],
    [fmt(sweat), 'Sweat Equity Hrs', ''],
    [fmt(rd), 'R&D-Flagged Hrs', 'amber'],
    [money(val), 'Imputed Value', 'green']
  ];
  for (const [n, l, cls] of cards) {
    const stat = document.createElement('div');
    stat.className = 'stat';
    addText(stat, 'div', n, `n ${cls}`.trim());
    addText(stat, 'div', l, 'l');
    stats.appendChild(stat);
  }
}

function addPill(parent, text, className) {
  const span = document.createElement('span');
  span.className = `pill ${className}`;
  span.textContent = text;
  parent.appendChild(span);
}

function renderTable() {
  const tbody = $('tbody');
  tbody.replaceChildren();

  if (!entries.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 10;
    td.className = 'empty';
    td.textContent = 'No entries yet.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const sorted = [...entries].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  for (const e of sorted) {
    const tr = document.createElement('tr');
    addText(tr, 'td', e.date);
    addText(tr, 'td', e.project);
    addText(tr, 'td', e.task);
    addText(tr, 'td', e.category);
    addText(tr, 'td', fmt(e.hours));

    const classTd = document.createElement('td');
    const classLabels = { sweat: ['Sweat', 'p-sweat'], bill: ['Billable', 'p-bill'], internal: ['Internal', 'p-internal'] };
    if (classLabels[e.classification]) addPill(classTd, classLabels[e.classification][0], classLabels[e.classification][1]);
    tr.appendChild(classTd);

    const rdTd = document.createElement('td');
    if (e.rd === 'yes') addPill(rdTd, 'R&D', 'p-rd');
    if (e.rd === 'maybe') addPill(rdTd, 'R&D?', 'p-rd');
    tr.appendChild(rdTd);

    addText(tr, 'td', money(Number(e.hours || 0) * Number(e.rate || 0)));
    addText(tr, 'td', e.status);

    const actions = document.createElement('td');
    actions.appendChild(makeButton('Edit', 'ghost', () => loadForm(e)));
    actions.appendChild(document.createTextNode(' '));
    actions.appendChild(makeButton('Del', 'danger', () => del(e.id)));
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

function renderProjList() {
  const list = $('projList');
  list.replaceChildren();
  const projects = [...new Set(entries.map((e) => e.project).filter(Boolean))];
  projects.sort((a, b) => String(a).localeCompare(String(b)));
  for (const p of projects) {
    const option = document.createElement('option');
    option.value = p;
    list.appendChild(option);
  }
}

function makeBarRow(label, value, max, suffix = 'h') {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px';

  const labelEl = document.createElement('div');
  labelEl.style.cssText = 'width:140px;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  labelEl.textContent = label;

  const track = document.createElement('div');
  track.style.cssText = 'flex:1;background:var(--panel2);border-radius:6px;height:22px;overflow:hidden';

  const bar = document.createElement('div');
  bar.style.cssText = `height:100%;background:var(--accent);width:${max ? (value / max * 100) : 0}%;border-radius:6px`;
  track.appendChild(bar);

  const val = document.createElement('div');
  val.style.cssText = 'width:60px;text-align:right;font-size:13px;font-weight:600';
  val.textContent = `${fmt(value)}${suffix}`;

  row.append(labelEl, track, val);
  return row;
}

function renderByMonth() {
  const target = $('byMonth');
  target.replaceChildren();
  const m = {};
  entries.forEach((e) => {
    const k = String(e.date || '').slice(0, 7);
    if (k) m[k] = (m[k] || 0) + Number(e.hours || 0);
  });
  const keys = Object.keys(m).sort();
  if (!keys.length) { addText(target, 'div', 'No data', 'empty'); return; }
  const max = Math.max(...Object.values(m));
  keys.forEach((k) => target.appendChild(makeBarRow(k, m[k], max, 'h')));
}

function renderByProject() {
  const target = $('byProject');
  target.replaceChildren();
  const m = {};
  entries.forEach((e) => {
    const k = e.project || '(none)';
    m[k] = (m[k] || 0) + Number(e.hours || 0);
  });
  const keys = Object.keys(m).sort((a, b) => m[b] - m[a]);
  if (!keys.length) { addText(target, 'div', 'No data', 'empty'); return; }
  const max = Math.max(...Object.values(m));
  keys.forEach((k) => target.appendChild(makeBarRow(k, m[k], max, 'h')));
}

document.addEventListener('DOMContentLoaded', () => {
  $('loginButton').addEventListener('click', attemptLogin);
  $('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
  $('logoutButton').addEventListener('click', logout);
  $('end').addEventListener('input', calcHours);
  $('start').addEventListener('input', calcHours);
  $('hours').addEventListener('input', validateAndCalc);
  $('rate').addEventListener('input', validateAndCalc);
  $('saveEntryButton').addEventListener('click', saveEntry);
  $('clearFormButton').addEventListener('click', resetForm);
  $('clearAllButton').addEventListener('click', clearAll);
  $('bulkAddButton').addEventListener('click', bulkAdd);
  $('exportCsvButton').addEventListener('click', exportCSV);
  $('csvFile').addEventListener('change', importCSV);
  $('saveSettingsButton').addEventListener('click', saveSettings);
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  resetForm();
  bootstrapSession();
});
