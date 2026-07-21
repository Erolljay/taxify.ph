/* ============================================================
   Txform.ph — account.js  (firm portal)

   Drives the auth + tenancy endpoints from server/auth-service.js.
   Vanilla, no framework. All user-supplied values go in via
   textContent (never innerHTML) so there's no injection surface.

   Shaped by role. Every signed-in user gets a useful screen:
     owner  — five tabs; the whole firm.
     staff  — their granted businesses, nothing else.
     client — the single business they were invited for, read-only.
   The server already scopes the payload (overview()); this file only
   decides what to draw with what it was given, so a tampered client
   cannot reveal anything the server didn't send.

   Clients is the landing tab for everyone. Almost every session is
   "open a client and file something" — firm admin is the rare task.
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

let state = null;
let activeTab = 'clients';

// ── tab definitions ───────────────────────────────────────────────
// `owner` marks a tab as requiring the manageFirm capability. Clients is
// the only tab staff and clients ever see, so they get no tab bar at all.
const TABS = [
  { id: 'clients',  label: 'Clients',  owner: false },
  { id: 'team',     label: 'Team',     owner: true  },
  { id: 'access',   label: 'Access',   owner: true  },
  { id: 'billing',  label: 'Billing',  owner: true  },
  { id: 'activity', label: 'Activity', owner: true  },
];

const isOwner = () => !!(state && state.me && state.me.capabilities && state.me.capabilities.manageFirm);

// A failed magic-link click lands here as /account?error=<code> (see
// verifyLink). Read it once, then strip it from the URL so a refresh or a
// later successful sign-in doesn't keep showing the stale error.
function takeLinkError() {
  const code = new URLSearchParams(window.location.search).get('error');
  if (!code) return null;
  history.replaceState(null, '', window.location.pathname);
  return code;
}

function linkErrorMessage(code) {
  if (code === 'link_expired') return 'That sign-in link has expired. Enter your email to get a fresh one.';
  if (code === 'link_used') return 'That sign-in link was already used. Enter your email to get a new one.';
  return 'That sign-in link is invalid. Enter your email to get a new one.';
}

// ── boot ──────────────────────────────────────────────────────────
async function init() {
  const linkError = takeLinkError();
  const me = await api('GET', '/api/auth/me');
  if (me.status !== 200) {
    showSignin();
    if (linkError) flash($('signin-msg'), 'warn', linkErrorMessage(linkError));
    return;
  }
  await loadDashboard();
}

function showSignin() {
  $('signin-view').hidden = false;
  $('dashboard-view').hidden = true;
  $('who').hidden = true;
  $('tabs').hidden = true;
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
  if (r.status !== 200) return showSignin();
  state = r.json;
  if (!isOwner()) activeTab = 'clients';
  render();
  $('signin-view').hidden = true;
  $('dashboard-view').hidden = false;
}

// ── chrome ────────────────────────────────────────────────────────
function render() {
  renderWho();
  renderTabs();
  renderPanel();
}

function renderWho() {
  $('firm-name').textContent = state.account.firm_name || '';
  const who = $('who');
  who.hidden = false;
  who.textContent = '';
  const email = document.createElement('span');
  email.textContent = state.me.email;
  const role = document.createElement('span');
  role.className = 'badge role';
  role.textContent = state.me.role;
  who.append(email, role);
  if (state.account.status && state.account.status !== 'active') {
    const st = document.createElement('span');
    st.className = 'badge ' + state.account.status;
    st.textContent = state.account.status;
    who.append(st);
  }
}

function renderTabs() {
  const nav = $('tabs');
  nav.textContent = '';
  // Staff and clients have exactly one screen — a single-tab bar is noise.
  if (!isOwner()) { nav.hidden = true; return; }
  nav.hidden = false;
  TABS.forEach((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(t.id === activeTab));
    b.addEventListener('click', () => { activeTab = t.id; renderTabs(); renderPanel(); });
    nav.append(b);
  });
}

function renderPanel() {
  const panel = $('panel');
  panel.textContent = '';
  $('dash-msg').className = '';
  $('dash-msg').textContent = '';
  if (activeTab === 'clients') return renderClients(panel);
  if (activeTab === 'team') return renderTeam(panel);
  if (activeTab === 'access') return renderAccess(panel);
  if (activeTab === 'billing') return renderBilling(panel);
  if (activeTab === 'activity') return renderActivity(panel);
}

function heading(title, sub) {
  $('panel-title').textContent = title;
  $('panel-sub').textContent = sub;
}

// ── Clients ───────────────────────────────────────────────────────
function renderClients(panel) {
  if (isOwner()) heading('Clients', 'The businesses your firm keeps books for.');
  else if (state.me.role === 'client') heading('Your business', 'Filed returns for your business.');
  else heading('Your clients', 'The businesses you have been given access to.');

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'Businesses';
  if (isOwner()) {
    const active = state.businesses.filter((b) => b.status === 'active').length;
    const use = document.createElement('span');
    use.className = 'use' + (active >= state.account.businesses_limit ? ' full' : '');
    use.textContent = active + ' / ' + state.account.businesses_limit;
    h.append(use);
  }
  card.append(h);

  const list = el('ul', 'rows');
  const visible = state.businesses.filter((b) => isOwner() || b.status === 'active');
  if (!visible.length) {
    list.append(emptyLi(isOwner()
      ? 'No client businesses yet — add your first below.'
      : 'No businesses have been shared with you yet. Ask your firm owner for access.'));
  }
  visible.forEach((b) => list.append(businessRow(b)));
  card.append(list);

  if (isOwner()) {
    const form = document.createElement('form');
    form.className = 'inline';
    const name = input('text', 'biz-name', 'Business name');
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.textContent = 'Register business';
    form.append(name, btn);
    form.addEventListener('submit', onAddBusiness);
    card.append(form);

    // Be honest about what this does. Right now it only registers a
    // business that ALREADY exists in Manager — nothing here creates one,
    // and a name that doesn't match is an orphaned row whose access grants
    // will queue against books Manager has never heard of.
    const note = el('div', 'note');
    note.textContent = 'Registers books that already exist in Manager — type the name exactly as it appears there. '
      + 'Creating new businesses from the portal comes with the provisioner.';
    card.append(note);
  }
  panel.append(card);
}

function businessRow(b) {
  const li = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = b.name;
  li.append(name);

  // The Manager-side name normally matches, so showing it would be noise.
  // It differs only when another firm already registered this client name
  // and ours was given a suffix — worth surfacing, because that's the name
  // they'll actually see in Manager's business list.
  if (b.manager_business_name && b.manager_business_name !== b.name) {
    const alias = document.createElement('span');
    alias.className = 'role';
    alias.textContent = 'in Manager: ' + b.manager_business_name;
    li.append(alias);
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  li.append(spacer);

  if (b.status === 'archived') {
    const badge = document.createElement('span');
    badge.className = 'badge cancelled';
    badge.textContent = 'archived';
    li.append(badge);
  } else if (isOwner()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'danger';
    btn.textContent = 'Archive';
    btn.addEventListener('click', () => onArchive(b));
    li.append(btn);
  }
  return li;
}

async function onAddBusiness(e) {
  e.preventDefault();
  const r = await api('POST', '/api/tenancy/add-business', {
    name: $('biz-name').value.trim(),
  });
  if (r.status === 201 || r.status === 200) {
    e.target.reset();
    await reload(r.json.reactivated ? 'Business restored — its filed returns came back with it.' : 'Business added.');
  } else {
    flash($('dash-msg'), 'err', errText(r, 'Could not add business.'));
  }
}

async function onArchive(b) {
  // Archiving revokes real people's access to real books — worth a beat.
  const ok = window.confirm(
    'Archive "' + b.name + '"?\n\n' +
    'Everyone loses access to it in Manager, but its filed returns are kept.\n' +
    'You can restore it later by adding the same name again.'
  );
  if (!ok) return;
  const r = await api('POST', '/api/tenancy/archive-business', { businessId: b.id });
  if (r.status === 200) await reload('Archived ' + b.name + '. Access revoked for ' + (r.json.revoked || 0) + ' user(s).');
  else flash($('dash-msg'), 'err', errText(r, 'Could not archive.'));
}

// ── Team ──────────────────────────────────────────────────────────
function renderTeam(panel) {
  heading('Team', 'Staff work on the clients you grant them. Clients see only their own books, read-only.');

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'People';
  const seats = state.users.filter((u) => u.role === 'owner' || u.role === 'staff').length;
  const use = document.createElement('span');
  use.className = 'use' + (seats >= state.account.seats_limit ? ' full' : '');
  use.textContent = seats + ' / ' + state.account.seats_limit + ' seats';
  h.append(use);
  card.append(h);

  const list = el('ul', 'rows');
  state.users.forEach((u) => {
    const li = document.createElement('li');
    const email = document.createElement('span');
    email.textContent = u.email;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = u.role + (u.role === 'client' ? ' · free' : '');
    li.append(email, role);

    const spacer = el('span', 'spacer');
    li.append(spacer);

    if (u.provisioned && u.role !== 'owner') {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'ghost';
      reset.textContent = 'Reset password';
      reset.addEventListener('click', () => onResetPassword(u));
      li.append(reset);
    }
    list.append(li);

    // Shown ONCE. The owner hands it over through whatever channel they
    // already use with their staff — we never email it, because a working
    // credential to client books should not sit in a mailbox.
    if (u.initialPassword) list.append(passwordRow(u));
  });
  card.append(list);

  const form = document.createElement('form');
  form.className = 'inline';
  const email = input('email', 'inv-email', 'name@firm.ph');
  email.autocomplete = 'off';

  const role = document.createElement('select');
  role.id = 'inv-role';
  [['staff', 'Staff'], ['client', 'Client (read-only)']].forEach(([v, t]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    role.append(o);
  });

  // A client is scoped to exactly one business, so the picker only appears
  // for them — and only lists active businesses.
  const biz = document.createElement('select');
  biz.id = 'inv-biz';
  biz.hidden = true;
  state.businesses.filter((b) => b.status === 'active').forEach((b) => {
    const o = document.createElement('option');
    o.value = String(b.id); o.textContent = b.name;
    biz.append(o);
  });
  role.addEventListener('change', () => { biz.hidden = role.value !== 'client'; });

  const btn = document.createElement('button');
  btn.type = 'submit';
  btn.textContent = 'Send invite';
  form.append(email, role, biz, btn);
  form.addEventListener('submit', onInvite);
  card.append(form);
  panel.append(card);
}

function passwordRow(u) {
  const li = document.createElement('li');
  const box = el('div', 'handover');

  const head = document.createElement('strong');
  head.textContent = 'Manager password for ' + u.email;

  const pw = el('code', 'pw');
  pw.textContent = u.initialPassword;

  const note = el('div', 'note');
  note.textContent = 'Shown once. Give it to them directly — do not email it. '
    + 'They will be asked to set up an authenticator app the first time they sign in to the books.';

  const actions = el('div', 'handover-actions');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(u.initialPassword);
      copy.textContent = 'Copied';
    } catch (err) {
      // Clipboard is blocked on insecure origins and in some browsers —
      // select it instead so they can copy by hand rather than being stuck.
      const range = document.createRange();
      range.selectNodeContents(pw);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copy.textContent = 'Selected — press Ctrl+C';
    }
  });

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'ghost';
  done.textContent = 'I have saved it';
  done.addEventListener('click', () => onClearPassword(u));

  actions.append(copy, done);
  box.append(head, pw, note, actions);
  li.append(box);
  return li;
}

async function onClearPassword(u) {
  const ok = window.confirm('Hide the password for ' + u.email + '?\n\n'
    + 'It cannot be shown again. If it is lost, use Reset password to issue a new one.');
  if (!ok) return;
  const r = await api('POST', '/api/tenancy/clear-password', { userId: u.id });
  if (r.status === 200) await reload('Password hidden.');
  else flash($('dash-msg'), 'err', errText(r, 'Could not hide it.'));
}

async function onResetPassword(u) {
  const ok = window.confirm('Issue a new Manager password for ' + u.email + '?\n\n'
    + 'Their current password stops working immediately. The new one appears here once it is set.');
  if (!ok) return;
  const r = await api('POST', '/api/tenancy/reset-password', { userId: u.id });
  if (r.status === 200) await reload('New password queued — it will appear here shortly.');
  else flash($('dash-msg'), 'err', errText(r, 'Could not reset the password.'));
}

async function onInvite(e) {
  e.preventDefault();
  const role = $('inv-role').value;
  const body = { email: $('inv-email').value.trim(), role: role };
  if (role === 'client') body.businessId = Number($('inv-biz').value);
  const r = await api('POST', '/api/tenancy/invite-staff', body);
  if (r.status === 201 || r.status === 200) {
    e.target.reset();
    $('inv-biz').hidden = true;
    await reload(r.json.alreadyMember
      ? 'That person is already on your team.'
      : 'Invited — they get Manager credentials once provisioning finishes.');
  } else {
    flash($('dash-msg'), 'err', errText(r, 'Could not send invite.'));
  }
}

// ── Access ────────────────────────────────────────────────────────
function renderAccess(panel) {
  heading('Access', 'Who can open which books. Changes reach Manager within a couple of minutes.');

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'Clients × staff';
  card.append(h);

  const staff = state.users.filter((u) => u.role === 'staff');
  const businesses = state.businesses.filter((b) => b.status === 'active');
  if (!staff.length || !businesses.length) {
    card.append(emptyDiv('Add at least one staff member and one business to assign access.'));
    panel.append(card);
    return;
  }

  const granted = new Set(state.grants.map((g) => g.user_id + ':' + g.business_id));
  const table = document.createElement('table');
  table.className = 'matrix';

  // Businesses run DOWN the left, staff ACROSS the top. A firm accumulates
  // far more clients than staff, so this is the axis that grows — and it
  // grows vertically, which the page already scrolls.
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.append(th('Client', 'rowhead'));
  staff.forEach((u) => hr.append(th(u.email)));
  thead.append(hr);
  table.append(thead);

  const tbody = document.createElement('tbody');
  businesses.forEach((b) => {
    const tr = document.createElement('tr');
    tr.append(td(b.name, 'rowhead'));
    staff.forEach((u) => {
      const cell = document.createElement('td');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = granted.has(u.id + ':' + b.id);
      cb.setAttribute('aria-label', u.email + ' can open ' + b.name);
      cb.addEventListener('change', () => toggleGrant(u, b, cb));
      cell.append(cb);
      // The provisioner runs on a timer, so a checkbox that flips instantly
      // would imply Manager already knows. Say what's actually true.
      const job = pendingJob(u.id, b.id);
      if (job) {
        const s = document.createElement('span');
        s.className = 'sync ' + (job.status === 'failed' ? 'failed' : 'pending');
        s.textContent = job.status === 'failed' ? 'failed' : 'syncing…';
        cell.append(s);
      }
      tr.append(cell);
    });
    tbody.append(tr);
  });
  table.append(tbody);

  const scroll = el('div', 'scroll');
  scroll.append(table);
  card.append(scroll);

  const legend = el('div', 'legend');
  ['Ticked and clear — live in Manager', 'syncing… — queued, usually under two minutes',
    'failed — the robot could not apply it; it retries'].forEach((t) => {
    const s = document.createElement('span');
    s.textContent = t;
    legend.append(s);
  });
  card.append(legend);
  panel.append(card);
}

// The newest unfinished job for this pair, if any. 'failed' outranks a
// queued retry so the grid surfaces the problem rather than hiding it.
function pendingJob(userId, businessId) {
  const mine = (state.jobs || []).filter((j) => j.user_id === userId && j.business_id === businessId);
  return mine.find((j) => j.status === 'failed') || mine[0] || null;
}

async function toggleGrant(user, business, cb) {
  const r = await api('POST', '/api/tenancy/user-business', {
    userId: user.id, businessId: business.id, grant: cb.checked,
  });
  if (r.status !== 200) {
    cb.checked = !cb.checked;
    flash($('dash-msg'), 'err', errText(r, 'Could not update access.'));
    return;
  }
  flash($('dash-msg'), 'ok',
    (cb.checked ? 'Granted ' : 'Revoked ') + user.email + ' → ' + business.name + '. Syncing to Manager…');
  await reload();
}

// ── Billing ───────────────────────────────────────────────────────
const peso = (centavos) => '₱' + (centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderBilling(panel) {
  heading('Billing', 'One invoice a month. A business is billed for any month it was active at any point.');
  const b = state.billing || {};

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'This month';
  const use = document.createElement('span');
  use.className = 'use';
  use.textContent = b.periodKey || '';
  h.append(use);
  card.append(h);

  const inv = el('div', 'invoice');
  inv.append(invoiceRow('Businesses billed', String(b.businesses || 0)));
  inv.append(invoiceRow('Subtotal', peso(b.gross || 0)));
  if (b.discount) inv.append(invoiceRow('Discount (' + b.percentOff + '%)', '−' + peso(b.discount)));
  inv.append(invoiceRow('Total', peso(b.net || 0), true));
  card.append(inv);

  if (b.reason) {
    const v = el('div', 'voucher');
    v.textContent = 'Voucher applied: ' + b.reason + '. Your businesses are counted and invoiced as normal — the total is just discounted.';
    card.append(v);
  }
  panel.append(card);
}

function invoiceRow(label, amount, isTotal) {
  const row = document.createElement('div');
  if (isTotal) row.className = 'total';
  const l = document.createElement('span');
  l.textContent = label;
  const a = document.createElement('span');
  a.className = 'amt';
  a.textContent = amount;
  row.append(l, a);
  return row;
}

// ── Activity ──────────────────────────────────────────────────────
function renderActivity(panel) {
  heading('Activity', 'Every change to people, businesses and access — the record your clients may one day ask for.');

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'Recent activity';
  card.append(h);

  const log = el('ul', 'log');
  const rows = state.activity || [];
  if (!rows.length) log.append(emptyLi('Nothing recorded yet.'));
  rows.forEach((a) => {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = (a.at || '').replace('T', ' ').slice(0, 16);
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = (a.action || '').replace(/_/g, ' ');
    const who = document.createElement('span');
    who.className = 'target';
    who.textContent = [a.actor, a.target].filter(Boolean).join(' · ');
    li.append(when, what, who);
    log.append(li);
  });
  card.append(log);
  panel.append(card);
}

// ── shared ────────────────────────────────────────────────────────
async function reload(okMsg) {
  const r = await api('GET', '/api/tenancy/overview');
  if (r.status === 200) {
    state = r.json;
    render();
    if (okMsg) flash($('dash-msg'), 'ok', okMsg);
  }
}

function errText(r, fallback) {
  const e = r.json && r.json.error;
  if (e === 'seat_limit_reached') return 'Seat limit reached — clients are free, but staff seats are capped on your plan.';
  if (e === 'business_limit_reached') return 'You have used every business on your plan. Archive one, or ask us to raise the limit.';
  if (e === 'name_unavailable') return 'You already have a client with that name — give this one a distinct name.';
  if (e === 'client_requires_own_business') return 'Pick which business this client should see.';
  if (e === 'wrong_account') return 'That does not belong to your firm.';
  if (e === 'not_owner') return 'Only the firm owner can do that.';
  return e ? String(e) : fallback;
}

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function th(text, cls) { const n = document.createElement('th'); if (cls) n.className = cls; n.textContent = text; return n; }
function td(text, cls) { const n = document.createElement('td'); if (cls) n.className = cls; n.textContent = text; return n; }
function emptyLi(text) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; return li; }
function emptyDiv(text) { const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; return d; }
function input(type, id, placeholder) {
  const n = document.createElement('input');
  n.type = type; n.id = id; n.placeholder = placeholder; n.required = true;
  return n;
}

init();
