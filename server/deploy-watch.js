/* ============================================================
   Txform.ph — server/deploy-watch.js

   The runner for deploy-health.js: gathers the git facts, asks it what
   to do, emails if so, and remembers what it said.

   Deliberately thin — every decision lives in deploy-health.js, which is
   pure and unit-tested. This file only does the things that need the
   world: run git, read and write a state file, send mail.

   Install: server/txform-deploy-watch.{service,timer}. NOT cron —
   /etc/txform/auth.env is a systemd EnvironmentFile, and sourcing it from
   a shell dies on `SMTP_FROM=Txform.ph <hello@txform.ph>` (bash reads the
   `<` as a redirect), silently leaving every later variable unset.

   Env: the SAME variables the auth service's mailer uses, so the alert
   path is the path already known to deliver:
     SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM SMTP_SECURE SMTP_EHLO
   These live in /etc/txform/auth.env, NOT provisioner.env.
   Plus:
     DEPLOY_ALERT_TO   — where to send. No alerts are sent without it.
   ============================================================ */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./deploy-health.js');
const { buildMessage, sendMail, addressOnly } = require('./smtp-mailer.js');

const REPO = process.env.TXFORM_REPO || '/var/www/taxify';
const STATE_FILE = process.env.DEPLOY_WATCH_STATE || '/var/lib/txform/deploy-watch.json';
const BRANCH = 'main';

// `-c safe.directory` on every call, rather than relying on a global
// git config. The deploy repo is root-owned and this runs as root under
// ProtectHome=true, which hides /root/.gitconfig — so the usual
// `git config --global --add safe.directory` fix is invisible here and
// git refuses the repo with "dubious ownership". Carrying the exception
// in the command makes the watchdog independent of whose config is
// readable, which is what a watchdog should be.
function git(args) {
  return execFileSync('git', ['-c', 'safe.directory=' + REPO, '-C', REPO].concat(args), { encoding: 'utf8' }).trim();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return {};                       // first run, or unreadable — start clean
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  // `ls-remote`, deliberately NOT `fetch`.
  //
  // We only need to know what sha main points at. `fetch` would write
  // .git/FETCH_HEAD and update refs — and the unit runs under
  // ProtectSystem=strict with only /var/lib/txform writable, so it failed
  // with "Read-only file system". The fix is not to widen those
  // permissions: a tool that watches the deploy repo has no business
  // being able to modify it. `ls-remote` asks the question over the
  // network and writes nothing.
  //
  // A network blip must not masquerade as a stalled deploy, so a failure
  // here means staleness is simply unknown this run. It also exits
  // NON-ZERO, so a watchdog that cannot see is a visibly failed unit
  // rather than a quiet success — the disease it exists to detect.
  let originSha = null;
  try {
    const line = git(['ls-remote', 'origin', 'refs/heads/' + BRANCH]);
    originSha = (line.split(/\s+/)[0] || '').slice(0, 7) || null;
  } catch (e) {
    console.error('[deploy-watch] could not reach origin — staleness unknown this run: '
      + String(e.message).split('\n')[0]);
  }

  const head = git(['rev-parse', '--short', 'HEAD']);
  const prev = readState();
  const facts = {
    now: Date.now(),
    headSha: head,
    // Unreachable origin means staleness is unknowable, so report HEAD as
    // both — "not behind" — rather than alerting about a network problem.
    originSha: originSha || head,
    // Tracked files only. Untracked ones (backups, tax-rates artefacts)
    // are noise here and never block a fast-forward.
    dirtyTracked: git(['status', '--porcelain', '--untracked-files=no'])
      .split('\n').map(function (l) { return l.slice(3).trim(); }).filter(Boolean),
    behindSinceMs: prev.behindSinceMs || null,
    lastAlertKey: prev.lastAlertKey || null,
    lastAlertAtMs: prev.lastAlertAtMs || null,
  };

  const decision = H.assess(facts);
  console.log('[deploy-watch] ' + decision.kind
    + (decision.problem ? ' (' + decision.problem + ')' : '')
    + ' head=' + facts.headSha + ' origin=' + facts.originSha
    + ' dirty=' + facts.dirtyTracked.length);

  if (decision.alert) {
    const to = process.env.DEPLOY_ALERT_TO;
    if (!to) {
      // Say so loudly rather than pretending to monitor. A watchdog that
      // silently cannot bark is worse than none, because it is believed.
      console.error('[deploy-watch] WOULD ALERT but DEPLOY_ALERT_TO is unset: ' + decision.subject);
    } else {
      // Read EXACTLY the variables the working mailer reads, with the same
      // defaults. An alerting path configured differently from the path
      // that is known to deliver is a path nobody has tested — and the
      // first time it matters is the first time it runs.
      const port = Number(process.env.SMTP_PORT || 465);
      const from = process.env.SMTP_FROM || 'Txform.ph <hello@txform.ph>';
      const message = buildMessage({ from: from, to: to, subject: decision.subject, text: decision.body });
      try {
        await sendMail({
          host: process.env.SMTP_HOST,
          port: port,
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
          // 465 is implicit TLS, 587 is STARTTLS. Getting this wrong hangs
          // rather than errors, which in a cron job is silence.
          secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
          ehloName: process.env.SMTP_EHLO || 'txform.ph',
        }, { from: addressOnly(from), to: to }, message);
        console.log('[deploy-watch] alerted ' + to + ': ' + decision.subject);
      } catch (err) {
        // Do NOT persist the alert as sent — otherwise a failed send makes
        // the cooldown swallow the next hour's attempt too.
        console.error('[deploy-watch] alert FAILED: ' + err.message);
        writeState(H.nextState(facts, { alert: false, problem: decision.problem, kind: 'send-failed' }));
        process.exit(1);
      }
    }
  }

  writeState(H.nextState(facts, decision));

  // A blind watchdog must look broken, not healthy.
  if (!originSha) process.exit(1);
}

main().catch(function (e) {
  console.error('[deploy-watch] fatal: ' + e.message);
  process.exit(1);
});
