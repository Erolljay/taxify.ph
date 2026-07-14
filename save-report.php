<?php
declare(strict_types=1);
/* ============================================================
   Txform.ph — save-report.php  (web root)

   Freezes a filing: stores the report figures + manual inputs as a
   point-in-time snapshot when a preparer marks a period "Filed", so later
   edits to that period's books no longer rewrite the filed return.

   POST /save-report.php   (cookie: txfsid=<session secret>)

   Served from the WEB ROOT (not server/) because the nginx web-root
   hardening 404s the whole /server/ path on extension.txform.ph — same
   placement as save-tax-rates.php. The shared backend logic stays hidden
   in server/report-store.php (a filesystem require, unaffected by the
   HTTP-level /server/ block).
     body JSON: { business, workflowKey, periodKey, form?, headline?, payload }
     → 200 { ok:true, version }   snapshot stored (version = 1 filed, 2+ amendment)
     → 400 { error }              missing/invalid params
     → 401 { error }              no / expired session  (client shows "sign in to freeze")
     → 404 { error }              business isn't the caller's
     → 413 { error }              payload too large

   Storage is server-only (per the roadmap decision) and per-tenant: the
   snapshot is scoped to a business the caller's account owns. Each freeze
   is append-only — an amendment inserts version+1 and marks prior filed
   rows 'superseded', preserving history. Every freeze writes an audit_log
   row (RA 10173 accountability).
   ============================================================ */

require __DIR__ . '/server/report-store.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST only']);
    exit;
}

// ── Body size cap (before reading the full stream) ───────────────────
$declaredLen = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
if ($declaredLen > TXFORM_MAX_BODY_BYTES) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}
$body = file_get_contents('php://input', false, null, 0, TXFORM_MAX_BODY_BYTES + 1);
if ($body === false || strlen($body) > TXFORM_MAX_BODY_BYTES) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}

$in = json_decode($body, true);
if (!is_array($in)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

// ── Validate params ──────────────────────────────────────────────────
$business    = (isset($in['business']) && is_string($in['business'])) ? trim($in['business']) : '';
$workflowKey = (isset($in['workflowKey']) && is_string($in['workflowKey'])) ? trim($in['workflowKey']) : '';
$periodKey   = (isset($in['periodKey']) && is_string($in['periodKey'])) ? trim($in['periodKey']) : '';
$form        = (isset($in['form']) && is_string($in['form'])) ? trim($in['form']) : null;
$headline    = array_key_exists('headline', $in) ? $in['headline'] : null;
$payload     = array_key_exists('payload', $in) ? $in['payload'] : null;

$allowedWorkflows = ['vat', 'expanded', 'compensation', 'individual', 'nonindividual'];
if ($workflowKey === '' || !in_array($workflowKey, $allowedWorkflows, true)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid workflowKey']);
    exit;
}
// e.g. quarterly:2026:1 / monthly:2026:3 / annual:2026
if ($periodKey === '' || !preg_match('/^[a-z]+:\d{4}(:\d{1,2})?$/', $periodKey)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid periodKey']);
    exit;
}
if (!is_array($payload)) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing payload']);
    exit;
}

$sid = (isset($_COOKIE['txfsid']) && is_string($_COOKIE['txfsid'])) ? $_COOKIE['txfsid'] : '';

try {
    $pdo = txform_open_db();
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Subscriber database not initialized']);
    exit;
}

$auth = txform_authorize_business($pdo, $business, $sid);
if (isset($auth['error_code'])) {
    http_response_code((int) $auth['error_code']);
    echo json_encode(['error' => $auth['error']]);
    exit;
}

try {
    $pdo->beginTransaction();

    $verStmt = $pdo->prepare(
        'SELECT COALESCE(MAX(version), 0) AS v FROM report_snapshot
          WHERE business_id = :bid AND workflow_key = :wf AND period_key = :pk'
    );
    $verStmt->execute([':bid' => $auth['business_id'], ':wf' => $workflowKey, ':pk' => $periodKey]);
    $nextVersion = ((int) $verStmt->fetchColumn()) + 1;

    // An amendment supersedes the prior filed version(s) for this filing.
    $sup = $pdo->prepare(
        "UPDATE report_snapshot SET status = 'superseded'
          WHERE business_id = :bid AND workflow_key = :wf AND period_key = :pk AND status = 'filed'"
    );
    $sup->execute([':bid' => $auth['business_id'], ':wf' => $workflowKey, ':pk' => $periodKey]);

    $ins = $pdo->prepare(
        'INSERT INTO report_snapshot
           (business_id, workflow_key, period_key, form, version, status, headline, payload, filed_by)
         VALUES (:bid, :wf, :pk, :form, :ver, \'filed\', :headline, :payload, :by)'
    );
    $ins->execute([
        ':bid'      => $auth['business_id'],
        ':wf'       => $workflowKey,
        ':pk'       => $periodKey,
        ':form'     => $form,
        ':ver'      => $nextVersion,
        ':headline' => ($headline === null) ? null : json_encode($headline, JSON_UNESCAPED_UNICODE),
        ':payload'  => json_encode($payload, JSON_UNESCAPED_UNICODE),
        ':by'       => $auth['email'],
    ]);

    $aud = $pdo->prepare(
        'INSERT INTO audit_log (account_id, actor, action, target)
         VALUES (:acct, :actor, :action, :target)'
    );
    $aud->execute([
        ':acct'   => $auth['account_id'],
        ':actor'  => $auth['email'],
        ':action' => 'report.filed',
        ':target' => $workflowKey . '/' . $periodKey . ' v' . $nextVersion,
    ]);

    $pdo->commit();
    echo json_encode(['ok' => true, 'version' => $nextVersion]);
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[save-report] ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Could not save snapshot']);
}
