<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

try {
    $user = current_user();
    if (!$user) {
        redirect_to('/login');
    }

    $attachmentId = (string) ($_GET['id'] ?? '');
    if ($attachmentId === '') {
        http_response_code(404);
        exit('الملف غير موجود.');
    }

    $stmt = app_pdo()->prepare('
        SELECT a.*, t.requester_id
        FROM attachments a
        JOIN tickets t ON t.id = a.ticket_id
        WHERE a.id = ?
    ');
    $stmt->execute([$attachmentId]);
    $attachment = $stmt->fetch();

    if (!$attachment || (!is_staff($user) && $attachment['requester_id'] !== $user['id'])) {
        http_response_code(404);
        exit('الملف غير موجود.');
    }

    $path = __DIR__ . '/uploads/' . $attachment['stored_name'];
    if (!is_file($path)) {
        http_response_code(404);
        exit('الملف غير موجود على الاستضافة.');
    }

    header('Content-Type: ' . ($attachment['mime_type'] ?: 'application/octet-stream'));
    header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($attachment['original_name']));
    header('Content-Length: ' . filesize($path));
    readfile($path);
} catch (Throwable $error) {
    http_response_code(500);
    exit('حدث خطأ أثناء تحميل الملف.');
}

