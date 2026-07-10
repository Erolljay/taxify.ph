<?php
/* ============================================================
   Txform.ph — save-tax-rates.php

   Overwrites tax-rates-data.json with the posted JSON body. This
   script trusts anything that reaches it — access control happens one
   layer up, in nginx (see the auth_basic block in the deploy notes),
   so nginx must always sit in front of this in production.

   Keeps a timestamped backup before every overwrite, so a mistaken
   save is one file copy away from being undone without touching git.
   ============================================================ */

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST only']);
    exit;
}

$body = file_get_contents('php://input');
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
}

$pretty = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
if (file_put_contents($targetFile, $pretty) === false) {
    http_response_code(500);
    echo json_encode(['error' => 'Could not write file — check that the web server user can write to this directory']);
    exit;
}

echo json_encode(['ok' => true]);
