<?php
declare(strict_types=1);
/* ============================================================
   Txform.ph — server/entitlement.php

   The read half of the entitlement gate. Deliberately THIN: validate
   the caller's session, confirm the business belongs to their account,
   and return the current billing status. All *decision* logic (grace /
   suspended / 72h fail-open / deadline-aware grace) lives in
   entitlement-core.js on the client — this endpoint only answers
   "what is this account's billing state, and are you allowed to ask?".

   GET /server/entitlement.php?business=<manager_business_guid>
     (cookie: txfsid=<session secret>)
     → 200 { status }             billing status of the caller's account
     → 401 { error }              no / expired session
     → 404 { error }              GUID isn't a business this caller may see
     → 400 { error }              missing/!invalid params

   SECURITY MODEL:
   - Phase 1.3 closed the old enumeration oracle: this now REQUIRES a
     valid session (written by the Node auth service into the shared
     `session` table) and only returns status for a business in the
     caller's own account — owners see all their businesses, staff only
     ones granted via user_business. An unauthenticated probe gets 401,
     a cross-account probe gets an indistinguishable 404.
   - The gate this drives is still UX-only: report generation is client
     side, so real enforcement is the provisioner (1.4) revoking the
     Manager user. A 200 here is not "authorized to file".
   - Session validation mirrors auth-core.js: sha256(cookie) vs
     session_hash, expires_at (epoch ms) in the future. Keep in sync.
   ============================================================ */

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(['error' => 'GET only']);
    exit;
}

$business = (isset($_GET['business']) && is_string($_GET['business']))
    ? trim($_GET['business'])
    : '';
if ($business === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Missing business parameter']);
    exit;
}

$sid = (isset($_COOKIE['txfsid']) && is_string($_COOKIE['txfsid'])) ? $_COOKIE['txfsid'] : '';
if ($sid === '') {
    http_response_code(401);
    echo json_encode(['error' => 'Not signed in']);
    exit;
}

$dbPath = __DIR__ . '/txform.db';
if (!file_exists($dbPath)) {
    http_response_code(500);
    echo json_encode(['error' => 'Subscriber database not initialized']);
    exit;
}

try {
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);

    $now = (int) round(microtime(true) * 1000); // epoch ms, matches auth-core

    // 1. Validate the session (hash-only lookup + expiry). No enumeration:
    //    absent/expired/unknown all collapse to 401.
    $sess = $pdo->prepare(
        'SELECT u.id AS user_id, u.account_id, u.role
           FROM session s JOIN users u ON u.id = s.user_id
          WHERE s.session_hash = :h AND s.expires_at > :now
          LIMIT 1'
    );
    $sess->execute([':h' => hash('sha256', $sid), ':now' => $now]);
    $who = $sess->fetch(PDO::FETCH_ASSOC);
    if (!$who) {
        http_response_code(401);
        echo json_encode(['error' => 'Session invalid or expired']);
        exit;
    }

    // 2. Business must be in the caller's account, and visible to them
    //    (owner: all; staff: only granted via user_business). Anything
    //    else is an indistinguishable 404 — no cross-account probing.
    $stmt = $pdo->prepare(
        'SELECT a.status
           FROM businesses b
           JOIN account a ON a.id = b.account_id
          WHERE b.manager_business_guid = :guid
            AND b.account_id = :acct
            AND ( :role = \'owner\'
                  OR EXISTS (SELECT 1 FROM user_business ub
                              WHERE ub.user_id = :uid AND ub.business_id = b.id) )
          LIMIT 1'
    );
    $stmt->execute([
        ':guid' => $business,
        ':acct' => $who['account_id'],
        ':role' => $who['role'],
        ':uid'  => $who['user_id'],
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        http_response_code(404);
        echo json_encode(['error' => 'Business is not a subscriber']);
        exit;
    }

    echo json_encode(['status' => $row['status']]);
} catch (Throwable $e) {
    error_log('[entitlement] lookup failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode(['error' => 'Entitlement lookup failed']);
}
