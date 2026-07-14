<?php
declare(strict_types=1);
/* ============================================================
   Txform.ph — server/report-snapshots.php

   Reads frozen filing snapshots for a business the caller's account owns.
   Two shapes:

   GET /server/report-snapshots.php?business=<guid>&workflow=<wf>&period=<pk>
     → 200 { snapshots:[...] }   full version history for ONE filing
                                  (newest version first, payload included)

   GET /server/report-snapshots.php?business=<guid>
     → 200 { filings:[...] }     latest FILED snapshot per filing across the
                                  whole business (no payload — light, for the
                                  Filing overview + Deadline Tracker batch)

   Error contract mirrors entitlement.php: 401 no/expired session, 404 for a
   business outside the caller's account (indistinguishable — no enumeration).
   ============================================================ */

require __DIR__ . '/report-store.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'GET only']);
    exit;
}

$business    = (isset($_GET['business']) && is_string($_GET['business'])) ? trim($_GET['business']) : '';
$workflowKey = (isset($_GET['workflow']) && is_string($_GET['workflow'])) ? trim($_GET['workflow']) : '';
$periodKey   = (isset($_GET['period']) && is_string($_GET['period'])) ? trim($_GET['period']) : '';

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
    if ($workflowKey !== '' && $periodKey !== '') {
        // Full version history for a single filing (payload included).
        $stmt = $pdo->prepare(
            'SELECT workflow_key, period_key, form, version, status, headline, payload, filed_by, filed_at
               FROM report_snapshot
              WHERE business_id = :bid AND workflow_key = :wf AND period_key = :pk
              ORDER BY version DESC'
        );
        $stmt->execute([':bid' => $auth['business_id'], ':wf' => $workflowKey, ':pk' => $periodKey]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['snapshots' => array_map('txform_decode_snapshot', $rows)]);
    } else {
        // Current filed status per filing across the business. No payload —
        // the batch view only needs status + headline for the overview.
        $stmt = $pdo->prepare(
            "SELECT workflow_key, period_key, form, version, headline, filed_by, filed_at
               FROM report_snapshot
              WHERE business_id = :bid AND status = 'filed'
              ORDER BY filed_at DESC"
        );
        $stmt->execute([':bid' => $auth['business_id']]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['filings' => array_map('txform_decode_snapshot', $rows)]);
    }
} catch (Throwable $e) {
    error_log('[report-snapshots] ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Lookup failed']);
}
