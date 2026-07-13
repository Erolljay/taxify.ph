/* ============================================================
   Txform.ph — account.js  (owner portal)

   Drives the auth + tenancy endpoints from server/auth-service.js.
   Vanilla, no framework. All user-supplied values go in via
   textContent (never innerHTML) so there's no injection surface.
   ============================================================ */
'use strict';

const $ = (id) => document.getElementById(id);

// fetch wrapper — always sends the session cookie.
async function api(method, path, body) {
  const res = await fetch(path, {
    method: method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch (e) { /* empty body */ }
  return { status: res.status, json: json };
}

function flash(el, kind, text) {
  el.className = 'alert ' + kind;
  el.textContent = text;
}
function clear(el) { el.className = ''; el.textContent = ''; }

let state = null;

// ── boot ──────────────────────────────────────────────────────────
async function init() {
  const me = await api('GET', '/api/auth/me');
  if (me.status !== 200) return showSignin();
  await loadDashboard();
}

function showSignin() {
  $('signin-view').hidden = false;
  $('dashboard-view').hidden = true;
  $('who').hidden = true;
}

$('signin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('signin-email').value.trim();
  const msg = $('signin-msg');
  flash(msg, 'ok', 'Sending…');
  const r = await api('POST', '/api/auth/request-link', { email: email });
  if (r.status === 429) return flash(msg, 'warn', 'Too many requests — please wait a moment and try again.');
  flash(msg, 'ok', (r.json && r.json.message) || 'Check your email for a sign-in link.');
});

async function loadDashboard() {
  const r = await api('GET', '/api/tenancy/overview');
  if (r.status === 403) { showSignin(); flash($('signin-msg'), 'warn', 'This console is for firm owners. Ask your firm owner for access.'); return; }
  if (r.status !== 200) return showSignin();
  state = r.json;
  render();
  $('signin-view').hidden = true;
  $('dashboard-view').hidden = false;
}

// ── render ────────────────────────────────────────────────────────
function render() {
  renderWho();
  renderBusinesses();
  renderStaff();
  renderMatrix();
}

function renderWho() {
  const who = $('who');
  who.hidden = false;
  who.textContent = '';
  const email = document.createElement('span');
  email.textContent = state.me.email;
  const badge = document.createElement('span');
  badge.className = 'badge ' + state.account.status;
  badge.textContent = state.account.status;
  who.append(email, badge);
}

function usage(el, used, limit) {
  el.textContent = used + ' / ' + limit;
  el.classList.toggle('full', used >= limit);
}

function renderBusinesses() {
  usage($('biz-use'), state.businesses.length, state.account.businesses_limit);
  const list = $('biz-list');
  list.textContent = '';
  if (!state.businesses.length) { list.append(emptyLi('No client businesses yet.')); return; }
  state.businesses.forEach((b) => {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = b.name;
    const guid = document.createElement('span');
    guid.className = 'role';
    guid.textContent = b.manager_business_guid;
    li.append(name, guid);
    list.append(li);
  });
}

function renderStaff() {
  usage($('seat-use'), state.users.length, state.account.seats_limit);
  const list = $('staff-list');
  list.textContent = '';
  state.users.forEach((u) => {
    const li = document.createElement('li');
    const email = document.createElement('span');
    email.textContent = u.email;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = u.role;
    li.append(email, role);
    list.append(li);
  });
}

function renderMatrix() {
  const staff = state.users.filter((u) => u.role === 'staff');
  const wrap = $('matrix');
  wrap.textContent = '';
  if (!staff.length || !state.businesses.length) {
    wrap.append(emptyDiv('Add at least one staff member and one business to assign access.'));
    return;
  }
  const granted = new Set(state.grants.map((g) => g.user_id + ':' + g.business_id));

  const table = document.createElement('table');
  table.className = 'matrix';
  // header
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.append(th('Staff', 'staff'));
  state.businesses.forEach((b) => hr.append(th(b.name)));
  thead.append(hr);
  table.append(thead);
  // rows
  const tbody = document.createElement('tbody');
  staff.forEach((u) => {
    const tr = document.createElement('tr');
    tr.append(td(u.email, 'staff'));
    state.businesses.forEach((b) => {
      const cell = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = granted.has(u.id + ':' + b.id);
      cb.addEventListener('change', () => toggleGrant(u, b, cb));
      cell.append(cb);
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
}

// ── actions ───────────────────────────────────────────────────────
$('biz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/tenancy/add-business', {
    name: $('biz-name').value.trim(), managerBusinessGuid: $('biz-guid').value.trim(),
  });
  if (r.status === 201 || r.status === 200) { $('biz-form').reset(); await reload('Business saved.'); }
  else flash($('dash-msg'), 'err', errText(r, 'Could not add business.'));
});

$('staff-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/tenancy/invite-staff', { email: $('staff-email').value.trim() });
  if (r.status === 201 || r.status === 200) { $('staff-form').reset(); await reload('Staff member added — they\'ll get Manager credentials once provisioned.'); }
  else flash($('dash-msg'), 'err', errText(r, 'Could not invite staff.'));
});

async function toggleGrant(user, business, cb) {
  const r = await api('POST', '/api/tenancy/user-business', {
    userId: user.id, businessId: business.id, grant: cb.checked,
  });
  if (r.status !== 200) { cb.checked = !cb.checked; flash($('dash-msg'), 'err', errText(r, 'Could not update access.')); }
  else flash($('dash-msg'), 'ok', (cb.checked ? 'Granted ' : 'Revoked ') + user.email + ' → ' + business.name + '.');
}

async function reload(okMsg) {
  const r = await api('GET', '/api/tenancy/overview');
  if (r.status === 200) { state = r.json; render(); if (okMsg) flash($('dash-msg'), 'ok', okMsg); }
}

// ── helpers ───────────────────────────────────────────────────────
function errText(r, fallback) {
  const e = r.json && r.json.error;
  if (e === 'seat_limit_reached') return 'Seat limit reached for your plan — upgrade to add more staff.';
  if (e === 'business_limit_reached') return 'Business limit reached for your plan — upgrade to add more clients.';
  if (e && /another account/.test(e)) return 'That business is already registered to another account.';
  return e ? String(e) : fallback;
}
function th(text, cls) { const el = document.createElement('th'); if (cls) el.className = cls; el.textContent = text; return el; }
function td(text, cls) { const el = document.createElement('td'); if (cls) el.className = cls; el.textContent = text; return el; }
function emptyLi(text) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; return li; }
function emptyDiv(text) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d; }

init();
