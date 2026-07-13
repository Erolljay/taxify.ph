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
