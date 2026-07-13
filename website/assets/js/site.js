/* Txform.ph — light progressive enhancement. Site works fully without JS. */
(function () {
  'use strict';

  // Mobile nav toggle
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') { links.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); }
    });
  }

  // Scroll reveal (skips when the user prefers reduced motion)
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var reveals = document.querySelectorAll('.reveal');
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  }

  // Magic-link sign-in. Posts to the live auth service and shows a
  // "check your email" state. The service always returns a generic 200
  // (no account enumeration), so the UI never reveals whether the email exists.
  var linkForms = document.querySelectorAll('form[data-magiclink]');
  linkForms.forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var email = (input && input.value || '').trim();
      if (!email || email.indexOf('@') === -1) { if (input) input.focus(); return; }
      var btn = form.querySelector('button');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

      fetch('/api/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function (r) { return r.ok ? r : Promise.reject(); })
        .then(function () {
          var panel = form.closest('[data-auth-panel]') || form.parentNode;
          panel.innerHTML =
            '<div class="auth-sent"><svg width="40" height="40" fill="none" stroke="var(--green)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="32" height="24" rx="3"/><path d="M5 10l15 11 15-11"/></svg>' +
            '<h1>Check your email</h1><p>If <strong>' + email.replace(/</g, '&lt;') +
            '</strong> has a Txform account, a secure sign-in link is on its way. It expires shortly, so open it soon.</p></div>';
        })
        .catch(function () {
          if (btn) { btn.disabled = false; btn.textContent = 'Send me a sign-in link'; }
          var err = form.querySelector('.auth-error');
          if (err) { err.textContent = 'Something went wrong — please try again, or email hello@txform.ph.'; err.hidden = false; }
        });
    });
  });

  // Early-access capture. Tries the API; falls back to email so a lead is never dropped.
  var forms = document.querySelectorAll('form[data-signup]');
  forms.forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = form.querySelector('input[type="email"]');
      var email = (input && input.value || '').trim();
      if (!email || email.indexOf('@') === -1) { if (input) input.focus(); return; }

      var done = function (msg) {
        form.innerHTML = '<p class="form-note" role="status" style="font-size:1rem;color:var(--mint)">' + msg + '</p>';
      };

      fetch('/api/early-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      }).then(function (r) {
        if (r.ok) { done('Thanks — you’re on the list. We’ll be in touch with onboarding details.'); }
        else { throw new Error('no endpoint'); }
      }).catch(function () {
        // Graceful fallback: open the user's mail client pre-addressed.
        window.location.href = 'mailto:hello@txform.ph?subject=' +
          encodeURIComponent('Early access — Txform.ph') +
          '&body=' + encodeURIComponent('Please add me to the early-access list: ' + email);
        done('Opening your email app so you can send us your request — or write to hello@txform.ph.');
      });
    });
  });
})();
