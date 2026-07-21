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

// Where a firm's books live. Opening one deep-links straight into it.
const BOOKS_URL = 'https://books.txform.ph';

// Books addresses a business as /start?<param>, where the param is a
// length-prefixed envelope in unpadded base64url — tag bytes 0xa2 0x06,
// then the length, then the utf8 name. Observed live:
//   /start?ogYOMDAwMCB0eGZvcm0ucGg  ->  a2 06 0e "0000 txform.ph"
// Note the tag differs per endpoint (the user form uses 0x0a), so this
// encoding is specific to business links and not reusable as-is.
function booksBusinessUrl(managerBusinessName) {
  const name = new TextEncoder().encode(String(managerBusinessName || ''));
  if (!name.length || name.length > 127) return null;
  const bytes = new Uint8Array(3 + name.length);
  bytes[0] = 0xa2; bytes[1] = 0x06; bytes[2] = name.length;
  bytes.set(name, 3);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  const param = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return BOOKS_URL + '/start?' + param;
}

// Per-tab search text. Kept out of `state` so a reload of firm data
// doesn't wipe what the user typed.
const search = { clients: '', team: '', access: '' };

const matches = (needle, ...haystack) => {
  const q = needle.trim().toLowerCase();
  return !q || haystack.filter(Boolean).some((h) => String(h).toLowerCase().indexOf(q) !== -1);
};

// A search box that filters as you type. Re-rendering the panel would
// steal focus mid-word, so this re-renders and then restores the caret.
function searchBox(key, placeholder, count) {
  const wrap = el('div', 'searchbar');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'search-' + key;
  input.placeholder = placeholder;
  input.value = search[key];
  input.setAttribute('aria-label', placeholder);
  input.addEventListener('input', () => {
    search[key] = input.value;
    renderPanel();
    const again = $('search-' + key);
    if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
  });
  wrap.append(input);
  if (search[key]) {
    const hits = el('span', 'hits');
    hits.textContent = count === 1 ? '1 match' : count + ' matches';
    wrap.append(hits);
  }
  return wrap;
}

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
  // Whether this is a sign-out or an expired session, keep no timer
  // polling an endpoint that will only answer 401.
  stopWatching();
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
  // Arriving mid-sync (a reload while jobs are queued) must also settle
  // on its own, not just actions taken in this session.
  watch();
}

// ── chrome ────────────────────────────────────────────────────────
function render() {
  renderWho();
  renderFailures();
  renderTabs();
  renderPanel();
}

// Failed provisioner jobs, above the title and outside the tabs.
//
// These used to be visible only as a `job_failed` line in Activity, which
// is a place you go looking rather than a place you land. A failed
// offboarding — someone removed here who still holds the client's books —
// is the highest-consequence failure in the system, and it was the
// quietest. One sat unnoticed in the database until somebody queried the
// table by hand.
function renderFailures() {
  const host = $('failures');
  host.textContent = '';
  const failures = Sync.sortFailures((state && state.failures) || []);
  host.hidden = failures.length === 0;
  if (!failures.length) return;

  failures.forEach((f) => {
    const bar = el('div', 'failbar ' + f.severity);

    const icon = el('span', 'icon');
    icon.textContent = f.severity === 'critical' ? '⚠️' : 'ℹ️';
    icon.setAttribute('aria-hidden', 'true');
    bar.append(icon);

    const body = el('div', 'body');
    const head = el('div', 'headline');
    // Screen readers should hear the urgency, not infer it from a colour.
    head.textContent = (f.severity === 'critical' ? 'Needs attention: ' : '') + f.headline;
    body.append(head);

    const why = el('div', 'meaning');
    why.textContent = f.meaning;
    body.append(why);

    if (f.detail) {
      const d = el('div', 'detail');
      d.textContent = f.detail;
      body.append(d);
    }
    bar.append(body);

    const act = el('div', 'act');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Try again';
    btn.addEventListener('click', () => retryFailure(f, btn));
    act.append(btn);
    if (f.attempts) {
      const tries = el('span', 'tries');
      tries.textContent = f.attempts === 1 ? '1 attempt' : f.attempts + ' attempts';
      act.append(tries);
    }
    bar.append(act);

    host.append(bar);
  });
}

// Re-queue a failed job. Previously this required SQL on the live server,
// which is not something an owner can do — and it is the fix for most of
// these, since the usual cause (an expired Books session, a Manager
// upgrade) is already gone by the time anyone looks.
async function retryFailure(failure, btn) {
  btn.disabled = true;
  btn.textContent = 'Queued…';
  const r = await api('POST', '/api/tenancy/retry-job', { jobId: failure.id });
  if (r.status !== 200) {
    btn.disabled = false;
    btn.textContent = 'Try again';
    return flash($('dash-msg'), 'err', errText(r, 'Could not queue that again.'));
  }
  // reload() picks up the job now being 'pending', which drops it out of
  // `failures` and starts the watcher — so the bar disappears on its own
  // and the result shows up without a refresh.
  await reload('Queued again. This usually completes within two minutes.');
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
  // Every role gets a way out — the header identity is the one thing on every
  // screen, so the sign-out lives beside it rather than in a per-tab menu.
  const out = document.createElement('button');
  out.type = 'button';
  out.className = 'signout';
  out.textContent = 'Sign out';
  out.addEventListener('click', onSignOut);
  who.append(out);
}

async function onSignOut() {
  // Fire-and-return: the server drops the session row and clears the cookie.
  // Even if the request fails (offline), we still return to the sign-in view —
  // a stuck "signing out…" would be worse than an optimistic reset.
  try { await api('POST', '/api/auth/sign-out'); } catch (e) { /* reset anyway */ }
  state = null;
  $('firm-name').textContent = '';
  showSignin();
  flash($('signin-msg'), 'ok', 'You have been signed out.');
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

  const all = state.businesses.filter((b) => isOwner() || b.status === 'active');
  const visible = all.filter((b) => matches(search.clients, b.name));
  if (all.length > 5 || search.clients) card.append(searchBox('clients', 'Search clients…', visible.length));

  const list = el('ul', 'rows');
  if (!all.length) {
    list.append(emptyLi(isOwner()
      ? 'No client businesses yet — add your first below.'
      : 'No businesses have been shared with you yet. Ask your firm owner for access.'));
  } else if (!visible.length) {
    list.append(emptyLi('No client matches “' + search.clients + '”.'));
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
    note.textContent = 'Registers books that already exist in Books — type the name exactly as it appears there. '
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

  // The Books-side name is deliberately NOT shown. Every business now
  // carries its firm's code as a prefix, so it always differs from what
  // the firm typed — showing it would put "TALLO-" on every row for no
  // reason. It stays in the payload because the Open link needs it.

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  li.append(spacer);

  if (b.status === 'archived') {
    const badge = document.createElement('span');
    badge.className = 'badge cancelled';
    badge.textContent = 'archived';
    li.append(badge);
    return li;
  }

  // Straight into the books. Every role gets this — it is the whole point
  // of the screen — and it only appears once the books actually exist,
  // since a link to a business still being created would 404.
  const url = b.manager_business_name ? booksBusinessUrl(b.manager_business_name) : null;
  if (url) {
    const open = document.createElement('a');
    open.className = 'btn-link';
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open';
    open.title = 'Open ' + b.name + ' in Books';
    li.append(open);
  } else {
    const pending = el('span', 'role');
    pending.textContent = 'setting up…';
    li.append(pending);
  }

  if (isOwner()) {
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
    'Everyone loses access to it in Books, but its filed returns are kept.\n' +
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
  const seats = state.users.filter((u) => (u.role === 'owner' || u.role === 'staff') && u.status !== 'removed').length;
  const use = document.createElement('span');
  use.className = 'use' + (seats >= state.account.seats_limit ? ' full' : '');
  use.textContent = seats + ' / ' + state.account.seats_limit + ' seats';
  h.append(use);
  card.append(h);

  const shown = state.users.filter((u) => matches(search.team, u.email, u.role));
  if (state.users.length > 5 || search.team) card.append(searchBox('team', 'Search people…', shown.length));

  const list = el('ul', 'rows');
  if (!shown.length) list.append(emptyLi('Nobody matches “' + search.team + '”.'));
  shown.forEach((u) => {
    const li = document.createElement('li');
    const email = document.createElement('span');
    email.textContent = u.email;
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = u.role + (u.role === 'client' ? ' · free' : '');
    li.append(email, role);

    const spacer = el('span', 'spacer');
    li.append(spacer);

    // A removed person stays listed rather than vanishing, so an offboard
    // is something you can see rather than infer from an absence.
    if (u.status === 'removed') {
      const badge = document.createElement('span');
      badge.className = 'badge cancelled';
      badge.textContent = 'removed';
      li.append(badge);
      list.append(li);
      return;
    }

    if (u.provisioned && u.role !== 'owner') {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'ghost';
      reset.textContent = 'Reset password';
      reset.addEventListener('click', () => onResetPassword(u));
      li.append(reset);
    }
    // The owner cannot remove themselves — it would leave the firm with
    // nobody able to manage it, and no way back in from the portal.
    if (u.role !== 'owner') {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'danger';
      rm.textContent = 'Remove';
      rm.addEventListener('click', () => onRemoveUser(u));
      li.append(rm);
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
  head.textContent = 'Books password for ' + u.email;

  const pw = el('code', 'pw');
  pw.textContent = u.initialPassword;

  const note = el('div', 'note');
  note.textContent = 'Shown once. Give it to them directly — do not email it.';

  // The pairing steps live here, beside the password, rather than in the
  // invite email. Two reasons: they are needed sitting in front of Books,
  // not days earlier in an inbox — and an email full of QR codes, 6-digit
  // codes and "ignore the security warning" reads exactly like phishing,
  // which is why the long version was never delivered to an external
  // address while the short sign-in mail always arrived.
  const steps = el('details', 'pairing');
  const sum = document.createElement('summary');
  sum.textContent = 'Authenticator setup — send these steps with the password';
  const list = document.createElement('ol');
  [
    'Sign in to the books; a QR code is shown.',
    'Scan it with an authenticator app (Google Authenticator, Microsoft Authenticator or Authy).',
    'Type the 6-digit code and press Update.',
    'It will say "invalid authentication code" — ignore it, the pairing was saved.',
    'Log out, then log back in and enter the current 6-digit code.',
  ].forEach((t) => {
    const li2 = document.createElement('li');
    li2.textContent = t;
    list.append(li2);
  });
  const warn = el('div', 'note');
  warn.textContent = 'Step 4 is a quirk of the books software. Do not rescan or start over — '
    + 'that replaces the pairing and their codes will stop working.';

  const copySteps = document.createElement('button');
  copySteps.type = 'button';
  copySteps.className = 'ghost';
  copySteps.textContent = 'Copy steps';
  copySteps.addEventListener('click', async () => {
    const text = [...list.querySelectorAll('li')].map((n, i) => (i + 1) + '. ' + n.textContent).join('\n')
      + '\n\n' + warn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      copySteps.textContent = 'Copied';
    } catch (err) {
      copySteps.textContent = 'Select the steps above and copy';
    }
  });

  steps.append(sum, list, warn, copySteps);

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
  box.append(head, pw, note, actions, steps);
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

async function onRemoveUser(u) {
  // Offboarding revokes a real person's access to real client books.
  const ok = window.confirm(
    'Remove ' + u.email + '?\n\n' +
    'They lose every set of books in Books and can no longer sign in — any' +
    ' open session ends immediately. Their history is kept.\n\n' +
    'You can invite them again later; they come back with no client access.'
  );
  if (!ok) return;
  const r = await api('POST', '/api/tenancy/remove-user', { userId: u.id });
  if (r.status === 200) {
    await reload('Removed ' + u.email + '. Revoking their access in Books…');
  } else {
    flash($('dash-msg'), 'err', errText(r, 'Could not remove.'));
  }
}

async function onResetPassword(u) {
  const ok = window.confirm('Issue a new Books password for ' + u.email + '?\n\n'
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
      : 'Invited — they get Books credentials once provisioning finishes.');
  } else {
    flash($('dash-msg'), 'err', errText(r, 'Could not send invite.'));
  }
}

// ── Access ────────────────────────────────────────────────────────
function renderAccess(panel) {
  heading('Access', 'Who can open which books. Changes reach Books within a couple of minutes.');

  const card = el('div', 'card');
  const h = document.createElement('h2');
  h.textContent = 'Clients × staff';
  card.append(h);

  const staff = state.users.filter((u) => u.role === 'staff');
  const allBiz = state.businesses.filter((b) => b.status === 'active');
  if (!staff.length || !allBiz.length) {
    card.append(emptyDiv('Add at least one staff member and one business to assign access.'));
    panel.append(card);
    return;
  }

  // Filters the ROWS (clients), which is the axis that grows. Staff stay
  // across the top so you can still see who has what.
  const businesses = allBiz.filter((b) => matches(search.access, b.name));
  if (allBiz.length > 5 || search.access) card.append(searchBox('access', 'Search clients…', businesses.length));
  if (!businesses.length) {
    card.append(emptyDiv('No client matches “' + search.access + '”.'));
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
  ['Ticked and clear — live in Books', 'syncing… — queued, usually under two minutes',
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
    (cb.checked ? 'Granted ' : 'Revoked ') + user.email + ' → ' + business.name + '. Syncing to Books…');
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

// The portal must survive an auxiliary script failing to load.
//
// shared/portal-sync.js is served by its own nginx rule, and when that
// rule did not exist yet the 404 took the ENTIRE dashboard down: render()
// threw on the first `PortalSync.` reference, before anything was drawn,
// so the owner got a blank page rather than a page missing one feature
// (2026-07-21). A missing enhancement must cost only the enhancement.
//
// The fallback degrades to exactly the behaviour that existed before the
// banner and the auto-refresh: no failures shown, no polling.
const Sync = (typeof PortalSync !== 'undefined') ? PortalSync : {
  WATCH_EVERY_MS: 5000,
  WATCH_MAX_MS: 6 * 60 * 1000,
  outstandingWork: function () { return false; },
  shouldDeferRender: function () { return false; },
  sortFailures: function () { return []; },
  hasCritical: function () { return false; },
};
if (typeof PortalSync === 'undefined') {
  console.warn('[portal] shared/portal-sync.js did not load — the failed-job banner '
    + 'and auto-refresh are disabled. Everything else still works.');
}

// ── keeping the page honest while the provisioner catches up ──────
//
// The provisioner runs on a two-minute timer, so an action taken here is
// NOT finished when the request returns. The page used to render once and
// never again: a granted checkbox sat on "syncing…" and a new member's
// password and authenticator steps stayed hidden until someone pressed
// F5 — working software that looked broken.
//
// So: poll while the provisioner owes us something, and stop the moment
// it does not. No websocket and no server change — the overview endpoint
// already carries everything needed to tell (see shared/portal-sync.js).
let watchTimer = null;
let watchDeadline = 0;

function stopWatching() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

// Safe to call after any action, and after the first load. Idempotent:
// calling it while already watching just extends the deadline.
function watch() {
  if (!Sync.outstandingWork(state)) return stopWatching();
  watchDeadline = Date.now() + Sync.WATCH_MAX_MS;
  if (!watchTimer) watchTimer = setInterval(watchTick, Sync.WATCH_EVERY_MS);
}

async function watchTick() {
  if (Date.now() > watchDeadline) return stopWatching();
  if (document.hidden) return;                    // a background tab helps nobody

  const r = await api('GET', '/api/tenancy/overview');
  if (r.status !== 200) return stopWatching();    // signed out, or the server is unwell
  state = r.json;

  // Never yank the caret out from under someone mid-word; try again next
  // tick. The data is already updated, only the repaint waits.
  if (Sync.shouldDeferRender(document.activeElement)) return;

  render();
  if (!Sync.outstandingWork(state)) stopWatching();
}

// ── shared ────────────────────────────────────────────────────────
async function reload(okMsg) {
  const r = await api('GET', '/api/tenancy/overview');
  if (r.status === 200) {
    state = r.json;
    render();
    if (okMsg) flash($('dash-msg'), 'ok', okMsg);
    watch();   // an action usually queues provisioner work — follow it
  }
}

function errText(r, fallback) {
  const e = r.json && r.json.error;
  if (e === 'seat_limit_reached') return 'Seat limit reached — clients are free, but staff seats are capped on your plan.';
  if (e === 'business_limit_reached') return 'You have used every business on your plan. Archive one, or ask us to raise the limit.';
  if (e === 'name_unavailable') return 'You already have a client with that name — give this one a distinct name.';
  if (e === 'client_requires_own_business') return 'Pick which business this client should see.';
  if (e === 'wrong_account') return 'That does not belong to your firm.';
  if (e === 'cannot_remove_self') return 'You cannot remove yourself — that would leave the firm with no one to manage it.';
  if (e === 'cannot_remove_owner') return 'The firm owner cannot be removed.';
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
