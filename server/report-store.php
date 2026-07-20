<?php
declare(strict_types=1);
/* ============================================================
   Txform.ph — server/report-store.php  (shared include)

   Common data-access + authorization helpers for the frozen-filing
   snapshot endpoints (save-report.php / report-snapshots.php). Kept in
   one place so both endpoints enforce the SAME security model, which
   mirrors server/entitlement.php exactly:

     - validate the txfsid session cookie (sha256(cookie) vs
       session.session_hash, expires_at in the future), and
     - confirm the target business belongs to the caller's account
       (owner: all; staff: only ones granted via user_business).

   Defines functions only — no side effects — so a direct GET of this
   file does nothing.
   ============================================================ */

const TXFORM_MAX_BODY_BYTES = 262144; // 256 KB — a snapshot is a few KB

function txform_db_path(): string
{
    return __DIR__ . '/txform.db';
}

function txform_open_db(): PDO
{
    $path = txform_db_path();
    if (!file_exists($path)) {
        throw new RuntimeException('Subscriber database not initialized');
    }
    return new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    ]);
}

/**
 * Validate the session and confirm $business is visible to the caller.
 * On success returns
 *   ['business_id'=>int, 'account_id'=>int, 'user_id'=>int, 'email'=>string, 'role'=>string].
 * On failure returns ['error_code'=>int, 'error'=>string] — the caller
 * sets the HTTP status and echoes the message. Absent/expired/unknown
 * session all collapse to 401; a cross-account business is an
 * indistinguishable 404 (no enumeration oracle), same as entitlement.php.
 *
 * @return array<string,mixed>
 */
function txform_authorize_business(PDO $pdo, string $business, string $sid): array
{
    if ($business === '') {
        return ['error_code' => 400, 'error' => 'Missing business parameter'];
    }
    if ($sid === '') {
        return ['error_code' => 401, 'error' => 'Not signed in'];
    }

    $now = (int) round(microtime(true) * 1000); // epoch ms, matches auth-core

    $sess = $pdo->prepare(
        'SELECT u.id AS user_id, u.account_id, u.role, u.email
           FROM session s JOIN users u ON u.id = s.user_id
          WHERE s.session_hash = :h AND s.expires_at > :now
          LIMIT 1'
    );
    $sess->execute([':h' => hash('sha256', $sid), ':now' => $now]);
    $who = $sess->fetch(PDO::FETCH_ASSOC);
    if (!$who) {
        return ['error_code' => 401, 'error' => 'Session invalid or expired'];
    }

    $stmt = $pdo->prepare(
        'SELECT b.id AS business_id
           FROM businesses b
          WHERE b.manager_business_name = :bizname
            AND b.account_id = :acct
            AND ( :role = \'owner\'
                  OR EXISTS (SELECT 1 FROM user_business ub
                              WHERE ub.user_id = :uid AND ub.business_id = b.id) )
          LIMIT 1'
    );
    $stmt->execute([
        ':bizname' => $business,
        ':acct' => $who['account_id'],
        ':role' => $who['role'],
        ':uid'  => $who['user_id'],
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return ['error_code' => 404, 'error' => 'Business is not a subscriber'];
    }

    return [
        'business_id' => (int) $row['business_id'],
        'account_id'  => (int) $who['account_id'],
        'user_id'     => (int) $who['user_id'],
        'email'       => (string) $who['email'],
        'role'        => (string) $who['role'],
    ];
}

/**
 * Decode a report_snapshot row for the JSON response: parse the stored
 * headline/payload JSON strings back into structures and cast version.
 *
 * @param array<string,mixed> $row
 * @return array<string,mixed>
 */
function txform_decode_snapshot(array $row): array
{
    if (array_key_exists('headline', $row)) {
        $row['headline'] = ($row['headline'] !== null)
            ? json_decode((string) $row['headline'], true)
            : null;
    }
    if (array_key_exists('payload', $row)) {
        $row['payload'] = ($row['payload'] !== null)
            ? json_decode((string) $row['payload'], true)
            : null;
    }
    if (array_key_exists('version', $row)) {
        $row['version'] = (int) $row['version'];
    }
    return $row;
}
