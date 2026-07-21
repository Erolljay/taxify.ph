/* ============================================================
   Txform.ph — server/deploy-health.js

   Notices when deploys have quietly stopped happening, and says so
   somewhere a human will see.

   ── Why ──
   The deploy runs from cron every two minutes under `set -euo pipefail`.
   When it fails it exits, writes a line to a log nobody reads, and the
   site simply stays on the old code. Every symptom of "deployed" is
   present except the deploying.

   That is this project's recurring failure shape, and it has bitten
   repeatedly:
     - the auth service not restarting, so merged code never ran
     - SPF silently eating external mail while every send "succeeded"
     - a failed offboarding sitting unnoticed in the database
     - and on 2026-07-21, a hand-applied nginx fix left the working tree
       dirty, which would have aborted `git merge --ff-only` on the next
       real deploy — silently, indefinitely

   Two conditions are worth waking someone for:

     dirty  — tracked files are modified on the server, so the next
              fast-forward will abort. This is ALWAYS wrong: the server
              is a deploy target, not somewhere to edit.
     stale  — HEAD has been behind origin/main for longer than a deploy
              could reasonably take. Something is failing every tick.

   Alerts are deliberately dull: one per distinct problem, then at most
   one an hour while it persists, and a single all-clear when it lifts. A
   monitor that cries wolf gets filtered to junk, and then it may as well
   not exist.
   ============================================================ */
'use strict';

// A deploy tick is 2 minutes. Being behind for a moment is normal — the
// cron simply has not run yet. Ten minutes means five ticks have passed
// without landing, which is not a race, it is a fault.
const STALE_AFTER_MS = 10 * 60 * 1000;

// While a problem persists, repeat at most hourly.
const REPEAT_AFTER_MS = 60 * 60 * 1000;

// What is wrong, if anything. Order matters: `dirty` is reported first
// because it is both the more specific diagnosis and the likely CAUSE of
// the staleness, so leading with "behind by 3 commits" would send someone
// looking in the wrong place.
function diagnose(facts) {
  const f = facts || {};
  if ((f.dirtyTracked || []).length > 0) return 'dirty';

  const behind = Boolean(f.headSha && f.originSha && f.headSha !== f.originSha);
  if (!behind) return null;

  // Behind, but only just: the next tick will very likely fix it.
  const since = f.behindSinceMs;
  if (!since) return null;                       // first sighting — start the clock
  return (f.now - since) >= STALE_AFTER_MS ? 'stale' : null;
}

// Should we actually send something, given what we last said?
function assess(facts) {
  const f = facts || {};
  const problem = diagnose(f);
  const last = f.lastAlertKey || null;

  if (!problem) {
    // Recovered: say so once, so a silent inbox means "fine" rather than
    // "possibly still broken and I stopped listening".
    if (last) return { alert: true, kind: 'resolved', problem: null, subject: subjectFor('resolved', f), body: bodyFor('resolved', f) };
    return { alert: false, kind: 'healthy', problem: null };
  }

  const isNew = problem !== last;
  const dueAgain = f.lastAlertAtMs ? (f.now - f.lastAlertAtMs) >= REPEAT_AFTER_MS : true;
  if (!isNew && !dueAgain) return { alert: false, kind: 'suppressed', problem: problem };

  return { alert: true, kind: isNew ? 'new' : 'repeat', problem: problem, subject: subjectFor(problem, f), body: bodyFor(problem, f) };
}

function subjectFor(problem, f) {
  if (problem === 'resolved') return 'Txform: deploys are working again';
  if (problem === 'dirty') return 'Txform: DEPLOYS BLOCKED — the server has uncommitted changes';
  return 'Txform: deploys have stalled — the site is behind main';
}

// Written for whoever reads it at 7am, and it says what to DO. A monitor
// that only reports a state leaves the reader to work out the action,
// which is the part they are least able to do under pressure.
function bodyFor(problem, f) {
  const facts = f || {};
  if (problem === 'resolved') {
    return 'The server is back in sync with main and deploys are landing again.\n\n'
      + 'Now at: ' + (facts.headSha || 'unknown') + '\n';
  }
  if (problem === 'dirty') {
    return 'The live server has local edits to files that git tracks, so the next\n'
      + 'deploy will abort with "Your local changes would be overwritten by merge".\n'
      + 'Until this is cleared, NOTHING you merge will reach the site.\n\n'
      + 'Modified:\n  ' + (facts.dirtyTracked || []).join('\n  ') + '\n\n'
      + 'Usually this means someone (or something) patched a file on the server by\n'
      + 'hand. Get the change into the repo, then on the server:\n\n'
      + '  cd /var/www/taxify\n'
      + '  sudo git checkout -- <the files above>\n'
      + '  sudo bash scripts/deploy.sh\n';
  }
  return 'The site has been behind main for over ' + Math.round(STALE_AFTER_MS / 60000) + ' minutes,\n'
    + 'so the deploy is failing every time it runs.\n\n'
    + 'Server is at : ' + (facts.headSha || 'unknown') + '\n'
    + 'main is at   : ' + (facts.originSha || 'unknown') + '\n\n'
    + 'Check what it is complaining about:\n\n'
    + '  sudo tail -40 /var/log/txform-deploy.log\n'
    + '  cd /var/www/taxify && sudo bash scripts/deploy.sh\n';
}

// The state we carry between runs, so repeats can be suppressed.
function nextState(facts, decision) {
  const f = facts || {};
  const problem = decision.problem;
  const behind = Boolean(f.headSha && f.originSha && f.headSha !== f.originSha);
  return {
    // Keep the original sighting so the clock is not reset every tick.
    behindSinceMs: behind ? (f.behindSinceMs || f.now) : null,
    lastAlertKey: decision.alert ? (decision.kind === 'resolved' ? null : problem) : (f.lastAlertKey || null),
    lastAlertAtMs: decision.alert ? f.now : (f.lastAlertAtMs || null),
  };
}

module.exports = { STALE_AFTER_MS, REPEAT_AFTER_MS, diagnose, assess, nextState, subjectFor, bodyFor };
