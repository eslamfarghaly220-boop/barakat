<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

function request_path(): string
{
    return parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
}

function require_user(): array
{
    $user = current_user();
    if (!$user) {
        json_response(401, ['error' => 'سجل الدخول أولًا.']);
    }
    return $user;
}

function api_login(): void
{
    if (setup_required()) {
        json_response(409, ['error' => 'أكمل إعداد أول مدير للنظام قبل تسجيل الدخول.']);
    }

    $body = read_json_body();
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $password = (string) ($body['password'] ?? '');

    $stmt = app_pdo()->prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND active = 1');
    $stmt->execute([$email]);
    $user = $stmt->fetch();

    if (!$user || !password_verify($password, $user['password_hash'])) {
        json_response(401, ['error' => 'البريد أو كلمة المرور غير صحيحة.']);
    }

    login_user($user['id']);
    json_response(200, ['user' => public_user($user)]);
}

function api_logout(): void
{
    logout_user();
    json_response(200, ['ok' => true]);
}

function api_setup(): void
{
    if (!setup_required()) {
        json_response(409, ['error' => 'تم إعداد النظام بالفعل.']);
    }

    $body = read_json_body();
    $name = trim((string) ($body['name'] ?? ''));
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $department = trim((string) ($body['department'] ?? 'إدارة البرنامج')) ?: 'إدارة البرنامج';
    $password = (string) ($body['password'] ?? '');
    $confirmPassword = (string) ($body['confirm_password'] ?? '');

    if ($name === '' || $email === '' || $password === '') {
        json_response(400, ['error' => 'أكمل اسم المدير والبريد وكلمة المرور.']);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_response(400, ['error' => 'اكتب بريدًا إلكترونيًا صحيحًا.']);
    }
    if (strlen($password) < 10) {
        json_response(400, ['error' => 'كلمة المرور يجب ألا تقل عن 10 أحرف.']);
    }
    if ($password !== $confirmPassword) {
        json_response(400, ['error' => 'تأكيد كلمة المرور غير مطابق.']);
    }

    try {
        $admin = create_admin_user([
            'name' => $name,
            'email' => $email,
            'department' => $department,
            'password' => $password,
        ]);
    } catch (PDOException $error) {
        if ($error->getCode() === '23000') {
            json_response(409, ['error' => 'هذا البريد مستخدم بالفعل.']);
        }
        throw $error;
    }

    login_user($admin['id']);
    json_response(201, ['ok' => true, 'user' => public_user($admin)]);
}

function api_health(): void
{
    app_pdo()->query('SELECT 1');
    json_response(200, [
        'ok' => true,
        'service' => 'barakat-helpdesk',
        'database' => true,
        'uploads' => is_dir(__DIR__ . '/uploads'),
    ]);
}

function api_state(array $user): void
{
    $tickets = list_tickets($user);
    $ticketIds = array_map(fn ($ticket) => $ticket['id'], $tickets);
    $attachmentsByTicket = rows_by_ticket('attachments', $ticketIds);
    $eventsByTicket = rows_by_ticket('events', $ticketIds);
    $normalizedTickets = array_map(
        fn ($ticket) => normalize_ticket($ticket, $attachmentsByTicket, $eventsByTicket),
        $tickets
    );

    if (is_staff($user)) {
        $users = app_pdo()->query('
            SELECT id, name, email, role, department, active, created_at
            FROM users
            ORDER BY role, name
        ')->fetchAll();
    } else {
        $users = [$user];
    }

    $stmt = app_pdo()->prepare('
        SELECT n.*, t.number AS ticket_number
        FROM notifications n
        LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC
        LIMIT 12
    ');
    $stmt->execute([$user['id']]);

    json_response(200, [
        'user' => public_user($user),
        'users' => array_map('public_user', $users),
        'tickets' => $normalizedTickets,
        'stats' => build_stats($tickets),
        'notifications' => $stmt->fetchAll(),
        'dictionaries' => [
            'statusLabels' => status_labels(),
            'roleLabels' => role_labels(),
            'ticketTypeLabels' => ticket_type_labels(),
        ],
    ]);
}

function api_notifications(array $user): void
{
    $stmt = app_pdo()->prepare('
        SELECT n.*, t.number AS ticket_number
        FROM notifications n
        LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC
        LIMIT 12
    ');
    $stmt->execute([$user['id']]);
    json_response(200, ['notifications' => $stmt->fetchAll()]);
}

function api_mark_notifications_read(array $user): void
{
    $stmt = app_pdo()->prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL');
    $stmt->execute([now_iso(), $user['id']]);
    json_response(200, ['ok' => true]);
}

function api_create_ticket(array $user): void
{
    $title = trim((string) ($_POST['title'] ?? ''));
    $details = trim((string) ($_POST['details'] ?? ''));
    $type = (string) ($_POST['type'] ?? 'other');
    $priority = (string) ($_POST['priority'] ?? 'medium');

    if ($title === '' || $details === '') {
        json_response(400, ['error' => 'اكتب عنوان الطلب وتفاصيله.']);
    }
    if (!array_key_exists($type, ticket_type_labels())) {
        $type = 'other';
    }
    if (!array_key_exists($priority, priority_hours())) {
        $priority = 'medium';
    }

    $id = uuid();
    $createdAt = now_iso();
    $dueAt = gmdate('Y-m-d\TH:i:s\Z', time() + priority_hours()[$priority] * 3600);
    $number = generate_ticket_number();

    $pdo = app_pdo();
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('
            INSERT INTO tickets (id, number, requester_id, type, title, details, priority, status, due_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, "new", ?, ?, ?)
        ');
        $stmt->execute([$id, $number, $user['id'], $type, $title, $details, $priority, $dueAt, $createdAt, $createdAt]);

        foreach (uploaded_files_for_field('attachments') as $file) {
            save_attachment($id, $user['id'], $file, 'attachment');
        }

        add_event($id, $user['id'], 'created', null, 'new', 'تم إنشاء الطلب.');
        notify_roles(['admin', 'manager', 'agent'], $id, 'طلب جديد', "تم إنشاء الطلب $number: $title");
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }

    json_response(201, ['ok' => true, 'id' => $id, 'number' => $number]);
}

function api_assign_ticket(array $user, string $ticketId): void
{
    if (!is_staff($user)) {
        json_response(403, ['error' => 'ليس لديك صلاحية إسناد الطلبات.']);
    }

    $ticket = get_ticket_for_user($ticketId, $user);
    if (!$ticket) {
        json_response(404, ['error' => 'الطلب غير موجود.']);
    }

    $body = read_json_body();
    $assigneeId = (string) ($body['assignee_id'] ?? '');
    $stmt = app_pdo()->prepare('
        SELECT id, name FROM users
        WHERE id = ? AND active = 1 AND role IN ("admin", "manager", "agent")
    ');
    $stmt->execute([$assigneeId]);
    $assignee = $stmt->fetch();

    if (!$assignee) {
        json_response(400, ['error' => 'اختر مسؤولًا صحيحًا من الفريق.']);
    }

    $statuses = status_labels();
    $nextStatus = in_array($ticket['status'], ['new', 'reopened'], true) ? 'review' : $ticket['status'];
    $updatedAt = now_iso();

    $stmt = app_pdo()->prepare('UPDATE tickets SET assignee_id = ?, status = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$assignee['id'], $nextStatus, $updatedAt, $ticketId]);

    add_event($ticketId, $user['id'], 'assigned', $ticket['assignee_id'], $assignee['id'], 'تم إسناد الطلب إلى ' . $assignee['name'] . '.');
    if ($ticket['status'] !== $nextStatus) {
        add_event($ticketId, $user['id'], 'status', $ticket['status'], $nextStatus, 'تغيرت الحالة إلى ' . $statuses[$nextStatus] . '.');
        notify_user($ticket['requester_id'], $ticketId, 'تحديث على طلبك', 'أصبحت حالة الطلب ' . $ticket['number'] . ': ' . $statuses[$nextStatus] . '.');
    }
    notify_user($assignee['id'], $ticketId, 'طلب مسند إليك', 'تم إسناد الطلب ' . $ticket['number'] . ' إليك.');

    json_response(200, ['ok' => true]);
}

function api_set_status(array $user, string $ticketId): void
{
    if (!is_staff($user)) {
        json_response(403, ['error' => 'ليس لديك صلاحية تغيير حالة الطلب.']);
    }

    $ticket = get_ticket_for_user($ticketId, $user);
    if (!$ticket) {
        json_response(404, ['error' => 'الطلب غير موجود.']);
    }

    $body = read_json_body();
    $status = (string) ($body['status'] ?? '');
    if (!in_array($status, ['review', 'progress'], true)) {
        json_response(400, ['error' => 'الحالة غير متاحة من هذا الإجراء.']);
    }

    $statuses = status_labels();
    $updatedAt = now_iso();
    $stmt = app_pdo()->prepare('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$status, $updatedAt, $ticketId]);

    add_event($ticketId, $user['id'], 'status', $ticket['status'], $status, 'تغيرت الحالة إلى ' . $statuses[$status] . '.');
    notify_user($ticket['requester_id'], $ticketId, 'تحديث على طلبك', 'أصبحت حالة الطلب ' . $ticket['number'] . ': ' . $statuses[$status] . '.');

    json_response(200, ['ok' => true]);
}

function api_complete_ticket(array $user, string $ticketId): void
{
    if (!is_staff($user)) {
        json_response(403, ['error' => 'ليس لديك صلاحية إكمال الطلب.']);
    }

    $ticket = get_ticket_for_user($ticketId, $user);
    if (!$ticket) {
        json_response(404, ['error' => 'الطلب غير موجود.']);
    }

    $solution = trim((string) ($_POST['solution'] ?? ''));
    if ($solution === '') {
        json_response(400, ['error' => 'اكتب ملخص الحل قبل إغلاق الطلب.']);
    }

    $completedAt = now_iso();
    $stmt = app_pdo()->prepare('
        UPDATE tickets
        SET status = "completed", solution = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
    ');
    $stmt->execute([$solution, $completedAt, $completedAt, $ticketId]);

    foreach (uploaded_files_for_field('final_file') as $file) {
        save_attachment($ticketId, $user['id'], $file, 'final');
    }

    add_event($ticketId, $user['id'], 'completed', $ticket['status'], 'completed', $solution);
    notify_user(
        $ticket['requester_id'],
        $ticketId,
        'تم الانتهاء من طلبك',
        'تم الانتهاء من الطلب ' . $ticket['number'] . '. يمكنك تأكيد الاستلام أو إعادة فتحه.'
    );

    json_response(200, ['ok' => true]);
}

function api_confirm_ticket(array $user, string $ticketId): void
{
    $ticket = get_ticket_for_user($ticketId, $user);
    if (!$ticket) {
        json_response(404, ['error' => 'الطلب غير موجود.']);
    }
    if ($ticket['requester_id'] !== $user['id']) {
        json_response(403, ['error' => 'تأكيد الاستلام متاح لصاحب الطلب فقط.']);
    }
    if ($ticket['status'] !== 'completed') {
        json_response(400, ['error' => 'لا يمكن تأكيد هذا الطلب في حالته الحالية.']);
    }

    $confirmedAt = now_iso();
    $stmt = app_pdo()->prepare('UPDATE tickets SET status = "confirmed", confirmed_at = ?, updated_at = ? WHERE id = ?');
    $stmt->execute([$confirmedAt, $confirmedAt, $ticketId]);
    add_event($ticketId, $user['id'], 'confirmed', 'completed', 'confirmed', 'أكد الموظف استلام الحل.');

    if (!empty($ticket['assignee_id'])) {
        notify_user($ticket['assignee_id'], $ticketId, 'تم تأكيد الاستلام', 'أكد الموظف استلام الطلب ' . $ticket['number'] . '.');
    }

    json_response(200, ['ok' => true]);
}

function api_reopen_ticket(array $user, string $ticketId): void
{
    $ticket = get_ticket_for_user($ticketId, $user);
    if (!$ticket) {
        json_response(404, ['error' => 'الطلب غير موجود.']);
    }
    if ($ticket['requester_id'] !== $user['id']) {
        json_response(403, ['error' => 'إعادة الفتح متاحة لصاحب الطلب فقط.']);
    }
    if (!in_array($ticket['status'], ['completed', 'confirmed'], true)) {
        json_response(400, ['error' => 'يمكن إعادة فتح الطلب بعد اكتماله فقط.']);
    }

    $body = read_json_body();
    $message = trim((string) ($body['message'] ?? '')) ?: 'تمت إعادة فتح الطلب من الموظف.';
    $updatedAt = now_iso();

    $stmt = app_pdo()->prepare('
        UPDATE tickets
        SET status = "reopened", reopened_count = reopened_count + 1, updated_at = ?
        WHERE id = ?
    ');
    $stmt->execute([$updatedAt, $ticketId]);

    add_event($ticketId, $user['id'], 'reopened', $ticket['status'], 'reopened', $message);
    notify_roles(['admin', 'manager', 'agent'], $ticketId, 'طلب معاد فتحه', 'أعاد الموظف فتح الطلب ' . $ticket['number'] . '.');

    json_response(200, ['ok' => true]);
}

function api_create_user(array $user): void
{
    if (!can_manage_users($user)) {
        json_response(403, ['error' => 'إضافة الأشخاص متاحة لمدير البرنامج أو المشرف فقط.']);
    }

    $body = read_json_body();
    $name = trim((string) ($body['name'] ?? ''));
    $email = strtolower(trim((string) ($body['email'] ?? '')));
    $role = (string) ($body['role'] ?? 'employee');
    $department = trim((string) ($body['department'] ?? 'عام')) ?: 'عام';
    $password = (string) ($body['password'] ?? '');

    if ($name === '' || $email === '' || $password === '') {
        json_response(400, ['error' => 'أكمل الاسم والبريد وكلمة المرور.']);
    }
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        json_response(400, ['error' => 'اكتب بريدًا إلكترونيًا صحيحًا.']);
    }
    if (!array_key_exists($role, role_labels())) {
        json_response(400, ['error' => 'الدور غير صحيح.']);
    }

    try {
        $stmt = app_pdo()->prepare('
            INSERT INTO users (id, name, email, role, department, password_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        ');
        $stmt->execute([uuid(), $name, $email, $role, $department, password_hash($password, PASSWORD_DEFAULT), now_iso()]);
    } catch (PDOException $error) {
        if ($error->getCode() === '23000') {
            json_response(409, ['error' => 'هذا البريد مستخدم بالفعل.']);
        }
        throw $error;
    }

    json_response(201, ['ok' => true]);
}

function api_toggle_user(array $user, string $userId): void
{
    if (!can_manage_users($user)) {
        json_response(403, ['error' => 'تعديل الأشخاص متاح لمدير البرنامج أو المشرف فقط.']);
    }
    if ($userId === $user['id']) {
        json_response(400, ['error' => 'لا يمكن تعطيل حسابك الحالي.']);
    }

    $body = read_json_body();
    $active = !empty($body['active']) ? 1 : 0;
    $stmt = app_pdo()->prepare('UPDATE users SET active = ? WHERE id = ?');
    $stmt->execute([$active, $userId]);

    if ($stmt->rowCount() === 0) {
        json_response(404, ['error' => 'المستخدم غير موجود.']);
    }

    json_response(200, ['ok' => true]);
}

try {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $path = request_path();

    if ($path === '/api/health' && $method === 'GET') {
        api_health();
    }
    if ($path === '/api/setup' && $method === 'POST') {
        api_setup();
    }
    if ($path === '/api/login' && $method === 'POST') {
        api_login();
    }

    $user = require_user();

    if ($path === '/api/logout' && $method === 'POST') {
        api_logout();
    }
    if ($path === '/api/state' && $method === 'GET') {
        api_state($user);
    }
    if ($path === '/api/notifications' && $method === 'GET') {
        api_notifications($user);
    }
    if ($path === '/api/notifications/read' && $method === 'POST') {
        api_mark_notifications_read($user);
    }
    if ($path === '/api/tickets' && $method === 'POST') {
        api_create_ticket($user);
    }
    if ($path === '/api/users' && $method === 'POST') {
        api_create_user($user);
    }

    if ($method === 'POST' && preg_match('#^/api/tickets/([^/]+)/([^/]+)$#', $path, $match)) {
        $ticketId = $match[1];
        $action = $match[2];
        if ($action === 'assign') {
            api_assign_ticket($user, $ticketId);
        }
        if ($action === 'status') {
            api_set_status($user, $ticketId);
        }
        if ($action === 'complete') {
            api_complete_ticket($user, $ticketId);
        }
        if ($action === 'confirm') {
            api_confirm_ticket($user, $ticketId);
        }
        if ($action === 'reopen') {
            api_reopen_ticket($user, $ticketId);
        }
    }

    if ($method === 'POST' && preg_match('#^/api/users/([^/]+)/active$#', $path, $match)) {
        api_toggle_user($user, $match[1]);
    }

    json_response(404, ['error' => 'المسار غير موجود.']);
} catch (AppHttpException $error) {
    json_response($error->status, ['error' => $error->getMessage()]);
} catch (AppConfigException $error) {
    json_response(500, ['error' => $error->getMessage()]);
} catch (Throwable $error) {
    error_log($error);
    json_response(500, ['error' => 'حدث خطأ غير متوقع.']);
}

