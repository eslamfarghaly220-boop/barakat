<?php
declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

try {
    if (setup_required()) {
        redirect_to('/setup');
    }

    if (current_user()) {
        redirect_to('/');
    }

    header('Content-Type: text/html; charset=utf-8');
    readfile(__DIR__ . '/login.html');
} catch (Throwable $error) {
    render_config_screen($error);
}

