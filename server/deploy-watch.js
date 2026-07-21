/* ============================================================
   Txform.ph — server/deploy-watch.js

   The runner for deploy-health.js: gathers the git facts, asks it what
   to do, emails if so, and remembers what it said.

   Deliberately thin — every decision lives in deploy-health.js, which is
   pure and unit-tested. This file only does the things that need the
   world: run git, read and write a state file, send mail.

   Install: a root cron entry running this every five minutes. The exact
   line is in docs/instruction.md — deliberately not repeated here,
   because a cron expression contains the characters that end a block
   comment and silently truncated this file when it was.

   Env (shares the mailer's existing config):
     SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM
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

function git(args) {
  return execFileSync('git', ['-C', REPO].concat(args), { encoding: 'utf8' }).trim();
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
  // Fetch quietly so `origin/main` is current. A network blip must not
  // masquerade as a stalled deploy, so a failure here exits without
  // judging anything.
  try {
    git(['fetch', '--quiet', 'origin', BRANCH]);
  } catch (e) {
    console.error('[deploy-watch] could not fetch: ' + e.message);
    process.exit(0);
  }

  const prev = readState();
  const facts = {
    now: Date.now(),
    headSha: git(['rev-parse', '--short', 'HEAD']),
    originSha: git(['rev-parse', '--short', 'origin/' + BRANCH]),
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
      const from = process.env.MAIL_FROM || 'Txform <no-reply@txform.ph>';
      const message = buildMessage({ from: from, to: to, subject: decision.subject, text: decision.body });
      try {
        await sendMail({
          host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
          user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
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
}

main().catch(function (e) {
  console.error('[deploy-watch] fatal: ' + e.message);
  process.exit(1);
});
