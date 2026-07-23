/* ============================================================
   Txform.ph — signup.js

   Drives the self-serve sign-up form: the quantity stepper, the live
   order summary, inline field validation, and the submit that hands off
   to Xendit's hosted checkout. The server (auth-service → billing-service)
   is authoritative on price and on every rule; this file's job is to make
   the choice clear and the errors legible, then POST and redirect.
   ============================================================ */
'use strict';

// Display rate only — the server computes the real charge (auth-core
// RATE_CENTAVOS). Kept here just to render the summary as the user picks.
var RATE_PESOS = 500;
var MIN_BUSINESSES = 1;
var MAX_BUSINESSES = 500;

var $ = function (id) { return document.getElementById(id); };
var form = $('signup-form');
var qtyInput = $('businesses');
var submitBtn = $('submit-btn');

// ── peso formatting (tabular, grouped) ───────────────────────────
function peso(n) { return '₱' + Number(n).toLocaleString('en-PH'); }

// ── order summary ────────────────────────────────────────────────
function clampQty(v) {
  var n = Math.floor(Number(v));
  if (!Number.isFinite(n)) n = MIN_BUSINESSES;
  return Math.max(MIN_BUSINESSES, Math.min(MAX_BUSINESSES, n));
}

function currentQty() { return clampQty(qtyInput.value); }

function renderSummary() {
  var n = currentQty();
  var total = n * RATE_PESOS;
  $('sum-line').textContent = n + (n === 1 ? ' client business' : ' client businesses') + ' × ' + peso(RATE_PESOS) + ' / mo';
  $('sum-sub').textContent = peso(total);
  $('sum-total').textContent = peso(total);
  $('qty-minus').disabled = n <= MIN_BUSINESSES;
  $('qty-plus').disabled = n >= MAX_BUSINESSES;
}

function setQty(v) {
  qtyInput.value = clampQty(v);
  renderSummary();
  clearFieldError('businesses');
}

$('qty-minus').addEventListener('click', function () { setQty(currentQty() - 1); });
$('qty-plus').addEventListener('click', function () { setQty(currentQty() + 1); });
qtyInput.addEventListener('input', renderSummary);
qtyInput.addEventListener('blur', function () { setQty(qtyInput.value); });

Array.prototype.forEach.call(document.querySelectorAll('.presets [data-preset]'), function (b) {
  b.addEventListener('click', function () { setQty(b.getAttribute('data-preset')); });
});

// Firm code: uppercase live and strip anything that isn't a letter/digit,
// so the field only ever holds what the server will accept.
$('firmCode').addEventListener('input', function () {
  var pos = this.selectionStart;
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  try { this.setSelectionRange(pos, pos); } catch (e) {}
});

// ── field-level error rendering ──────────────────────────────────
var FIELD_IDS = ['firmName', 'firmCode', 'email', 'businesses'];

function setFieldError(field, message) {
  var wrap = $('f-' + field);
  if (!wrap) return;
  wrap.classList.add('err');
  var msg = wrap.querySelector('.msg');
  if (msg) msg.textContent = message || '';
}

function clearFieldError(field) {
  var wrap = $('f-' + field);
  if (!wrap) return;
  wrap.classList.remove('err');
  var msg = wrap.querySelector('.msg');
  if (msg) msg.textContent = '';
}

function clearAllErrors() {
  FIELD_IDS.forEach(clearFieldError);
  banner('banner-error', null);
}

// Clear a field's error as soon as the user starts fixing it.
FIELD_IDS.forEach(function (f) {
  var el = $(f);
  if (el) el.addEventListener('input', function () { clearFieldError(f); });
});

// ── banners ──────────────────────────────────────────────────────
function banner(id, html) {
  var el = $(id);
  if (!el) return;
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = html;
  el.hidden = false;
}

// ── submit ───────────────────────────────────────────────────────
function setLoading(on) {
  submitBtn.disabled = on;
  var label = submitBtn.querySelector('.label');
  var arrow = submitBtn.querySelector('.arrow');
  var spin = submitBtn.querySelector('.spinner');
  if (on) {
    if (label) label.textContent = 'Setting up checkout…';
    if (arrow) arrow.style.display = 'none';
    if (!spin) {
      spin = document.createElement('span');
      spin.className = 'spinner';
      submitBtn.appendChild(spin);
    }
  } else {
    if (label) label.textContent = 'Continue to secure payment';
    if (arrow) arrow.style.display = '';
    if (spin) spin.remove();
  }
}

// A first line of defence so obvious mistakes get caught before a round
// trip. The server re-validates everything — this is UX, not security.
function clientValidate(data) {
  var errs = {};
  if (!data.firmName) errs.firmName = 'Your firm name is required.';
  if (!/^[A-Z0-9]{2,12}$/.test(data.firmCode)) errs.firmCode = 'Use 2–12 letters or digits, e.g. TALLO.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) errs.email = 'Enter a valid email address.';
  if (!(data.businesses >= MIN_BUSINESSES && data.businesses <= MAX_BUSINESSES)) errs.businesses = 'Choose at least one client business.';
  return errs;
}

function focusFirstError(errs) {
  for (var i = 0; i < FIELD_IDS.length; i++) {
    if (errs[FIELD_IDS[i]]) { var el = $(FIELD_IDS[i]); if (el) el.focus(); return; }
  }
}

form.addEventListener('submit', async function (e) {
  e.preventDefault();
  clearAllErrors();

  var data = {
    firmName: $('firmName').value.trim(),
    firmCode: $('firmCode').value.trim().toUpperCase(),
    email: $('email').value.trim().toLowerCase(),
    businesses: currentQty(),
  };

  var errs = clientValidate(data);
  if (Object.keys(errs).length) {
    Object.keys(errs).forEach(function (f) { setFieldError(f, errs[f]); });
    focusFirstError(errs);
    return;
  }

  setLoading(true);
  var res, body;
  try {
    res = await fetch('/api/auth/sign-up', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    body = await res.json().catch(function () { return {}; });
  } catch (netErr) {
    setLoading(false);
    banner('banner-error', 'We couldn’t reach the server. Please check your connection and try again.');
    return;
  }

  // Success — off to Xendit's hosted checkout page.
  if ((res.status === 200 || res.status === 201) && body && body.invoiceUrl) {
    // Keep the button in its loading state through the redirect so it can't
    // be double-submitted while the browser navigates away.
    window.location.href = body.invoiceUrl;
    return;
  }

  setLoading(false);

  // Field-keyed validation errors from the server.
  if (res.status === 400 && body && body.fields) {
    Object.keys(body.fields).forEach(function (f) { setFieldError(f, body.fields[f]); });
    focusFirstError(body.fields);
    return;
  }

  if (res.status === 409 && body && body.error === 'code_taken') {
    setFieldError('firmCode', body.message || 'That firm code is taken. Please choose another.');
    $('firmCode').focus();
    return;
  }

  if (res.status === 409 && body && body.error === 'email_in_use') {
    banner('banner-error', 'That email already has an account. <a href="/account">Sign in instead →</a>');
    return;
  }

  banner('banner-error', (body && body.message) || 'Something went wrong setting up checkout. Please try again in a moment.');
});

// ── on load ──────────────────────────────────────────────────────
(function boot() {
  renderSummary();
  // A cancelled/expired Xendit checkout returns here as ?status=cancelled.
  var params = new URLSearchParams(window.location.search);
  if (params.get('status') === 'cancelled') {
    $('banner-cancelled').hidden = false;
    history.replaceState(null, '', window.location.pathname);
  }
})();
