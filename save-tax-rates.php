<?php
/* ============================================================
   Txform.ph — save-tax-rates.php

   Overwrites tax-rates-data.json with the posted JSON body. Two
   independent gates guard this endpoint:

     1. nginx basic-auth (see nginx-tax-rates-snippet.conf) — the
        primary gate, prompts for the admin password in the browser.
     2. A shared-secret header (X-Txform-Token) checked below against
        /etc/txform/tax-rates.token — defense-in-depth, so a dropped or
        mis-scoped nginx auth block alone can't expose this write. The
        admin tool prompts for this token once per browser and caches it.

   Keeps a timestamped backup before every overwrite (pruned to the
   most recent MAX_BACKUPS), so a mistaken save is one file copy away
   from being undone without touching git.
   ============================================================ */

const MAX_BODY_BYTES = 262144; // 256 KB — a tax-rates payload is a few KB
const MAX_BACKUPS     = 50;
const TOKEN_FILE      = '/etc/txform/tax-rates.token';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST only']);
    exit;
}

// ── Gate 2: shared-secret header ─────────────────────────────────────
// Token lives in a file outside the web root (preferred) or the
// TXFORM_TAXRATES_TOKEN env var. Missing token = fail closed, never open.
$expectedToken = '';
if (is_readable(TOKEN_FILE)) {
    $expectedToken = trim((string) file_get_contents(TOKEN_FILE));
}
if ($expectedToken === '') {
    $expectedToken = trim((string) getenv('TXFORM_TAXRATES_TOKEN'));
}
if ($expectedToken === '') {
    http_response_code(500);
    echo json_encode(['error' => 'Server not configured: admin token missing. See DEPLOY-TAX-RATES-SAVE.md step 3.']);
    exit;
}
$providedToken = $_SERVER['HTTP_X_TXFORM_TOKEN'] ?? '';
if (!is_string($providedToken) || !hash_equals($expectedToken, $providedToken)) {
    http_response_code(401);
    echo json_encode(['error' => 'Invalid or missing admin token']);
    exit;
}

// ── Body size cap (before reading the full stream) ───────────────────
$declaredLen = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
if ($declaredLen > MAX_BODY_BYTES) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}
// Read at most one byte past the cap so an under-reported Content-Length
// can't sneak a huge body through.
$body = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($body === false || strlen($body) > MAX_BODY_BYTES) {
    http_response_code(413);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}

$data = json_decode($body);

if ($data === null) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid JSON']);
    exit;
}

// Shape check so a stray/malformed request can't clobber the file with
// something the report pages can't read.
$requiredKeys = ['vat', 'pt', 'ptNonbank', 'eightPct', 'osd', 'thirteenthCap', 'incomeTax', 'corporate', 'mcit'];
foreach ($requiredKeys as $key) {
    if (!property_exists($data, $key) || !is_array($data->$key)) {
        http_response_code(400);
        echo json_encode(['error' => "Missing or invalid category: $key"]);
        exit;
    }
}

$targetFile = __DIR__ . '/tax-rates-data.json';
$backupDir  = __DIR__ . '/tax-rates-backups';

if (!is_dir($backupDir)) {
    mkdir($backupDir, 0755, true);
}
if (file_exists($targetFile)) {
    copy($targetFile, $backupDir . '/tax-rates-data.' . date('Ymd-His') . '.json');

    // Prune oldest backups. Filenames sort chronologically (Ymd-His),
    // so a lexical sort puts the oldest first.
    $backups = glob($backupDir . '/tax-rates-data.*.json');
    if ($backups !== false && count($backups) > MAX_BACKUPS) {
        sort($backups);
        foreach (array_slice($backups, 0, count($backups) - MAX_BACKUPS) as $stale) {
            @unlink($stale);
        }
    }
}

$pretty = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if (file_put_contents($targetFile, $pretty) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Could not write file — check that the web server user can write to this directory']);
    exit;
}

echo json_encode(['ok' => true]);
