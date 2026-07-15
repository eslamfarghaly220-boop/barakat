<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';

date_default_timezone_set('UTC');

class AppHttpException extends Exception
{
    public int $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

class AppConfigException extends Exception
{
}

function start_app_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $isSecure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

    session_name('barakat_session');
    session_set_cookie_params([
        'lifetime' => 28800,
        'path' => '/',
        'secure' => $isSecure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    session_start();
}

start_app_session();

function config_is_ready(): bool
{
    foreach ([DB_NAME, DB_USER, DB_PASS] as $value) {
        if ($value === '' || strpos($value, 'PUT_') !== false) {
            return false;
        }
    }
    return true;
}

function require_config_ready(): void
{
    if (!config_is_ready()) {
        throw new AppConfigException('لم يتم ضبط بيانات قاعدة البيانات بعد. افتح ملف config.php واكتب بيانات MySQL من Hostinger.');
    }
}

function app_pdo(): PDO
{
    static $pdo = null;
    static $schemaReady = false;

    if ($pdo === null) {
        require_config_ready();
        $dsn = 'mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4';
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
    }

    if (!$schemaReady) {
        ensure_schema($pdo);
        $schemaReady = true;
    }

    return $pdo;
}

function ensure_schema(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(36) PRIMARY KEY,
            name VARCHAR(180) NOT NULL,
            email VARCHAR(190) NOT NULL UNIQUE,
            role VARCHAR(20) NOT NULL,
            department VARCHAR(180) NOT NULL DEFAULT 'عام',
            password_hash VARCHAR(255) NOT NULL,
            active TINYINT(1) NOT NULL DEFAULT 1,
            created_at VARCHAR(40) NOT NULL,
            INDEX users_role_idx (role),
            INDEX users_active_idx (active)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS tickets (
            id VARCHAR(36) PRIMARY KEY,
            number VARCHAR(40) NOT NULL UNIQUE,
            requester_id VARCHAR(36) NOT NULL,
            type VARCHAR(40) NOT NULL,
            title VARCHAR(220) NOT NULL,
            details TEXT NOT NULL,
            priority VARCHAR(20) NOT NULL DEFAULT 'medium',
            status VARCHAR(20) NOT NULL DEFAULT 'new',
            assignee_id VARCHAR(36) NULL,
            solution TEXT NULL,
            reopened_count INT NOT NULL DEFAULT 0,
            due_at VARCHAR(40) NOT NULL,
            created_at VARCHAR(40) NOT NULL,
            updated_at VARCHAR(40) NOT NULL,
            completed_at VARCHAR(40) NULL,
            confirmed_at VARCHAR(40) NULL,
            INDEX tickets_status_idx (status),
            INDEX tickets_requester_idx (requester_id),
            INDEX tickets_assignee_idx (assignee_id),
            CONSTRAINT tickets_requester_fk FOREIGN KEY (requester_id) REFERENCES users(id),
            CONSTRAINT tickets_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS attachments (
            id VARCHAR(36) PRIMARY KEY,
            ticket_id VARCHAR(36) NOT NULL,
            uploader_id VARCHAR(36) NOT NULL,
            kind VARCHAR(20) NOT NULL DEFAULT 'attachment',
            original_name VARCHAR(255) NOT NULL,
            stored_name VARCHAR(255) NOT NULL UNIQUE,
            mime_type VARCHAR(120) NOT NULL,
            size BIGINT NOT NULL,
            created_at VARCHAR(40) NOT NULL,
            INDEX attachments_ticket_idx (ticket_id),
            CONSTRAINT attachments_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
            CONSTRAINT attachments_uploader_fk FOREIGN KEY (uploader_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS ticket_events (
            id VARCHAR(36) PRIMARY KEY,
            ticket_id VARCHAR(36) NOT NULL,
            actor_id VARCHAR(36) NOT NULL,
            action VARCHAR(40) NOT NULL,
            old_value TEXT NULL,
            new_value TEXT NULL,
            message TEXT NULL,
            created_at VARCHAR(40) NOT NULL,
            INDEX ticket_events_ticket_idx (ticket_id),
            CONSTRAINT ticket_events_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
            CONSTRAINT ticket_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS notifications (
            id VARCHAR(36) PRIMARY KEY,
            user_id VARCHAR(36) NOT NULL,
            ticket_id VARCHAR(36) NULL,
            title VARCHAR(180) NOT NULL,
            body TEXT NOT NULL,
            read_at VARCHAR(40) NULL,
            created_at VARCHAR(40) NOT NULL,
            INDEX notifications_user_idx (user_id),
            CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
            CONSTRAINT notifications_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
}

function now_iso(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

function uuid(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function status_labels(): array
{
    return [
        'new' => 'جديد',
        'review' => 'قيد المراجعة',
        'progress' => 'جاري التنفيذ',
        'completed' => 'مكتمل',
        'confirmed' => 'تم تأكيد الاستلام',
        'reopened' => 'معاد فتحه',
    ];
}

function role_labels(): array
{
    return [
        'admin' => 'مدير البرنامج',
        'manager' => 'مشرف فريق',
        'agent' => 'عضو فريق',
        'employee' => 'موظف',
    ];
}

function ticket_type_labels(): array
{
    return [
        'it_support' => 'دعم تقني',
        'design' => 'تصميم',
        'access' => 'صلاحيات',
        'device' => 'جهاز',
        'email' => 'بريد إلكتروني',
        'website' => 'تعديل موقع',
        'other' => 'أخرى',
    ];
}

function priority_hours(): array
{
    return [
        'urgent' => 8,
        'high' => 24,
        'medium' => 48,
        'low' => 96,
    ];
}

function is_staff(array $user): bool
{
    return in_array($user['role'] ?? '', ['admin', 'manager', 'agent'], true);
}

function can_manage_users(array $user): bool
{
    return ($user['role'] ?? '') === 'admin';
}

function public_user(array $user): array
{
    $roles = role_labels();
    return [
        'id' => $user['id'],
        'name' => $user['name'],
        'email' => $user['email'],
        'role' => $user['role'],
        'role_label' => $roles[$user['role']] ?? $user['role'],
        'department' => $user['department'],
        'active' => (bool) $user['active'],
        'created_at' => $user['created_at'],
    ];
}

function setup_required(): bool
{
    $stmt = app_pdo()->query('SELECT COUNT(*) AS count FROM users');
    return (int) $stmt->fetch()['count'] === 0;
}

function current_user(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }

    $stmt = app_pdo()->prepare('
        SELECT id, name, email, role, department, active, created_at
        FROM users
        WHERE id = ? AND active = 1
    ');
    $stmt->execute([$_SESSION['user_id']]);
    $user = $stmt->fetch();
    if (!$user) {
        unset($_SESSION['user_id']);
        return null;
    }
    return $user;
}

function login_user(string $userId): void
{
    session_regenerate_id(true);
    $_SESSION['user_id'] = $userId;
}

function logout_user(): void
{
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'] ?? '', (bool) $params['secure'], (bool) $params['httponly']);
    }
    session_destroy();
}

function create_admin_user(array $data): array
{
    $admin = [
        'id' => uuid(),
        'name' => trim((string) ($data['name'] ?? 'مدير البرنامج')) ?: 'مدير البرنامج',
        'email' => strtolower(trim((string) ($data['email'] ?? ''))),
        'role' => 'admin',
        'department' => trim((string) ($data['department'] ?? 'إدارة البرنامج')) ?: 'إدارة البرنامج',
        'active' => 1,
        'created_at' => now_iso(),
    ];

    $stmt = app_pdo()->prepare('
        INSERT INTO users (id, name, email, role, department, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([
        $admin['id'],
        $admin['name'],
        $admin['email'],
        $admin['role'],
        $admin['department'],
        password_hash((string) $data['password'], PASSWORD_DEFAULT),
        $admin['created_at'],
    ]);

    return $admin;
}

function generate_ticket_number(): string
{
    $year = gmdate('Y');
    $prefix = "BRK-$year-";
    $stmt = app_pdo()->prepare('SELECT COUNT(*) AS count FROM tickets WHERE number LIKE ?');
    $stmt->execute([$prefix . '%']);
    $count = (int) $stmt->fetch()['count'];
    return $prefix . str_pad((string) ($count + 1), 4, '0', STR_PAD_LEFT);
}

function list_tickets(array $user): array
{
    $sql = '
        SELECT
            t.*,
            requester.name AS requester_name,
            requester.email AS requester_email,
            requester.department AS requester_department,
            assignee.name AS assignee_name,
            assignee.email AS assignee_email
        FROM tickets t
        JOIN users requester ON requester.id = t.requester_id
        LEFT JOIN users assignee ON assignee.id = t.assignee_id
    ';

    if (!is_staff($user)) {
        $stmt = app_pdo()->prepare($sql . ' WHERE t.requester_id = ? ORDER BY t.created_at DESC');
        $stmt->execute([$user['id']]);
        return $stmt->fetchAll();
    }

    return app_pdo()->query($sql . ' ORDER BY t.created_at DESC')->fetchAll();
}

function get_ticket_for_user(string $ticketId, array $user): ?array
{
    $stmt = app_pdo()->prepare('
        SELECT
            t.*,
            requester.name AS requester_name,
            requester.email AS requester_email,
            requester.department AS requester_department,
            assignee.name AS assignee_name,
            assignee.email AS assignee_email
        FROM tickets t
        JOIN users requester ON requester.id = t.requester_id
        LEFT JOIN users assignee ON assignee.id = t.assignee_id
        WHERE t.id = ?
    ');
    $stmt->execute([$ticketId]);
    $ticket = $stmt->fetch();

    if (!$ticket) {
        return null;
    }
    if (is_staff($user) || $ticket['requester_id'] === $user['id']) {
        return $ticket;
    }
    return null;
}

function rows_by_ticket(string $table, array $ticketIds): array
{
    if (!$ticketIds) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($ticketIds), '?'));
    if ($table === 'attachments') {
        $sql = "
            SELECT id, ticket_id, kind, original_name, mime_type, size, created_at
            FROM attachments
            WHERE ticket_id IN ($placeholders)
            ORDER BY created_at DESC
        ";
    } else {
        $sql = "
            SELECT e.*, u.name AS actor_name
            FROM ticket_events e
            JOIN users u ON u.id = e.actor_id
            WHERE e.ticket_id IN ($placeholders)
            ORDER BY e.created_at DESC
        ";
    }

    $stmt = app_pdo()->prepare($sql);
    $stmt->execute($ticketIds);
    $grouped = [];
    foreach ($stmt->fetchAll() as $row) {
        $grouped[$row['ticket_id']][] = $row;
    }
    return $grouped;
}

function normalize_ticket(array $ticket, array $attachmentsByTicket, array $eventsByTicket): array
{
    $types = ticket_type_labels();
    $statuses = status_labels();
    $ticket['type_label'] = $types[$ticket['type']] ?? $ticket['type'];
    $ticket['status_label'] = $statuses[$ticket['status']] ?? $ticket['status'];
    $ticket['reopened_count'] = (int) $ticket['reopened_count'];
    $ticket['attachments'] = $attachmentsByTicket[$ticket['id']] ?? [];
    $ticket['events'] = $eventsByTicket[$ticket['id']] ?? [];
    return $ticket;
}

function build_stats(array $tickets): array
{
    $now = time();
    $openStatuses = ['new', 'review', 'progress', 'reopened'];
    $completed = array_values(array_filter($tickets, fn ($ticket) => in_array($ticket['status'], ['completed', 'confirmed'], true)));
    $completedWithTime = array_values(array_filter($completed, fn ($ticket) => !empty($ticket['completed_at'])));
    $totalHours = 0.0;

    foreach ($completedWithTime as $ticket) {
        $totalHours += (strtotime($ticket['completed_at']) - strtotime($ticket['created_at'])) / 3600;
    }

    $byAssignee = [];
    foreach ($tickets as $ticket) {
        $key = $ticket['assignee_name'] ?: 'غير مسند';
        if (!isset($byAssignee[$key])) {
            $byAssignee[$key] = ['name' => $key, 'open' => 0, 'completed' => 0, 'overdue' => 0];
        }
        if (in_array($ticket['status'], ['completed', 'confirmed'], true)) {
            $byAssignee[$key]['completed']++;
        }
        if (in_array($ticket['status'], $openStatuses, true)) {
            $byAssignee[$key]['open']++;
            if (strtotime($ticket['due_at']) < $now) {
                $byAssignee[$key]['overdue']++;
            }
        }
    }

    return [
        'total' => count($tickets),
        'new' => count(array_filter($tickets, fn ($ticket) => $ticket['status'] === 'new')),
        'active' => count(array_filter($tickets, fn ($ticket) => in_array($ticket['status'], ['review', 'progress', 'reopened'], true))),
        'completed' => count($completed),
        'overdue' => count(array_filter($tickets, fn ($ticket) => in_array($ticket['status'], $openStatuses, true) && strtotime($ticket['due_at']) < $now)),
        'avgHours' => count($completedWithTime) ? round($totalHours / count($completedWithTime), 1) : 0,
        'byAssignee' => array_values($byAssignee),
    ];
}

function add_event(string $ticketId, string $actorId, string $action, ?string $oldValue, ?string $newValue, string $message = ''): void
{
    $stmt = app_pdo()->prepare('
        INSERT INTO ticket_events (id, ticket_id, actor_id, action, old_value, new_value, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([uuid(), $ticketId, $actorId, $action, $oldValue, $newValue, $message, now_iso()]);
}

function notify_user(string $userId, ?string $ticketId, string $title, string $body): void
{
    $stmt = app_pdo()->prepare('
        INSERT INTO notifications (id, user_id, ticket_id, title, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([uuid(), $userId, $ticketId, $title, $body, now_iso()]);
}

function notify_users(array $userIds, ?string $ticketId, string $title, string $body, array $excludeUserIds = []): void
{
    $exclude = array_flip(array_filter($excludeUserIds));
    $ids = array_values(array_unique(array_filter($userIds)));

    foreach ($ids as $id) {
        if (isset($exclude[$id])) {
            continue;
        }
        notify_user((string) $id, $ticketId, $title, $body);
    }
}

function user_ids_for_roles(array $roles): array
{
    if (!$roles) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($roles), '?'));
    $stmt = app_pdo()->prepare("SELECT id FROM users WHERE active = 1 AND role IN ($placeholders)");
    $stmt->execute($roles);
    return array_column($stmt->fetchAll(), 'id');
}

function notify_roles(array $roles, string $ticketId, string $title, string $body): void
{
    notify_users(user_ids_for_roles($roles), $ticketId, $title, $body);
}

function clean_file_name(string $name): string
{
    $base = basename(str_replace('\\', '/', $name ?: 'file'));
    $base = preg_replace('/[^\p{L}\p{N}._ -]+/u', '_', $base) ?: 'file';
    return substr($base, 0, 120) ?: 'file';
}

function uploaded_files_for_field(string $field): array
{
    if (empty($_FILES[$field])) {
        return [];
    }

    $file = $_FILES[$field];
    if (is_array($file['name'])) {
        $files = [];
        foreach ($file['name'] as $index => $name) {
            $files[] = [
                'name' => $name,
                'type' => $file['type'][$index] ?? 'application/octet-stream',
                'tmp_name' => $file['tmp_name'][$index] ?? '',
                'error' => $file['error'][$index] ?? UPLOAD_ERR_NO_FILE,
                'size' => $file['size'][$index] ?? 0,
            ];
        }
        return $files;
    }

    return [$file];
}

function save_attachment(string $ticketId, string $uploaderId, array $file, string $kind = 'attachment'): ?string
{
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        return null;
    }
    if (($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK || empty($file['tmp_name'])) {
        throw new AppHttpException(400, 'تعذر رفع الملف. تأكد من حجم الملف ونوعه.');
    }
    if ((int) ($file['size'] ?? 0) <= 0) {
        return null;
    }

    $uploadDir = __DIR__ . '/uploads';
    if (!is_dir($uploadDir)) {
        mkdir($uploadDir, 0755, true);
    }

    $originalName = clean_file_name((string) ($file['name'] ?? 'file'));
    $extension = pathinfo($originalName, PATHINFO_EXTENSION);
    $storedName = uuid() . ($extension ? '.' . $extension : '');
    $target = $uploadDir . '/' . $storedName;

    if (!move_uploaded_file($file['tmp_name'], $target)) {
        throw new AppHttpException(500, 'تعذر حفظ الملف على الاستضافة.');
    }

    $mimeType = $file['type'] ?: 'application/octet-stream';
    if (function_exists('finfo_open')) {
        $finfo = finfo_open(FILEINFO_MIME_TYPE);
        if ($finfo) {
            $detected = finfo_file($finfo, $target);
            if ($detected) {
                $mimeType = $detected;
            }
            finfo_close($finfo);
        }
    }

    $id = uuid();
    $stmt = app_pdo()->prepare('
        INSERT INTO attachments (id, ticket_id, uploader_id, kind, original_name, stored_name, mime_type, size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ');
    $stmt->execute([$id, $ticketId, $uploaderId, $kind, $originalName, $storedName, $mimeType, (int) $file['size'], now_iso()]);
    return $id;
}

function json_response(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function redirect_to(string $path): void
{
    header('Location: ' . $path, true, 302);
    exit;
}

function render_config_screen(Throwable $error): void
{
    http_response_code(500);
    header('Content-Type: text/html; charset=utf-8');
    $message = htmlspecialchars($error->getMessage(), ENT_QUOTES, 'UTF-8');
    echo "<!doctype html><html lang=\"ar\" dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><title>إعداد قاعدة البيانات</title><link rel=\"stylesheet\" href=\"/styles.css\"></head><body class=\"login-body\"><main class=\"login-panel\" style=\"max-width:760px;margin:auto\"><section class=\"login-card\"><h1>يلزم ضبط قاعدة البيانات</h1><p>$message</p><p>افتح ملف <strong>config.php</strong> داخل <strong>public_html</strong> واكتب بيانات قاعدة MySQL من Hostinger ثم حدث الصفحة.</p></section></main></body></html>";
    exit;
}
