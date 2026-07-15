# Hostinger VPS Deployment

هذا المسار يشغل النظام كاملًا على سيرفر Hostinger VPS:

- Node.js app
- SQLite database
- file uploads
- first admin setup screen
- persistent storage

## 1. الدخول للسيرفر

من جهازك افتح SSH على السيرفر:

```bash
ssh root@SERVER_IP
```

استبدل `SERVER_IP` بعنوان IP الخاص بسيرفر Hostinger.

## 2. تثبيت Docker

على Ubuntu نفذ:

```bash
apt update
apt install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## 3. تنزيل المشروع

```bash
cd /opt
git clone https://github.com/eslamfarghaly220-boop/barakat.git
cd /opt/barakat
cp deploy/hostinger/hostinger.env.example .env
```

## 4. تشغيل رابط مؤقت للعمل

هذا يشغل النظام على IP السيرفر:

```bash
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml up -d --build
```

افتح:

```text
http://SERVER_IP:3000
```

عند أول فتح ستظهر صفحة إعداد أول مدير للنظام.

## 5. إنشاء أول مدير

من صفحة الإعداد اكتب:

- اسم مدير البرنامج
- البريد الإلكتروني
- القسم
- كلمة المرور
- تأكيد كلمة المرور

بعدها تدخل لوحة التحكم وتضيف الفريق والموظفين.

## 6. ربط الدومين لاحقًا

عندما تشتري الدومين:

1. أضف A record يشير إلى `SERVER_IP`.
2. عدل ملف `.env`:

```bash
BARAKAT_BIND=127.0.0.1
BARAKAT_PORT=3000
COOKIE_SECURE=true
```

3. أعد تشغيل التطبيق:

```bash
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml up -d
```

4. ثبت Nginx و Certbot:

```bash
apt install -y nginx certbot python3-certbot-nginx
cp deploy/hostinger/nginx.conf.example /etc/nginx/sites-available/barakat-helpdesk
nano /etc/nginx/sites-available/barakat-helpdesk
ln -s /etc/nginx/sites-available/barakat-helpdesk /etc/nginx/sites-enabled/barakat-helpdesk
nginx -t
systemctl reload nginx
certbot --nginx -d your-domain.com -d www.your-domain.com
```

استبدل `your-domain.com` بالدومين الحقيقي.

## 7. النسخ الاحتياطي

```bash
bash deploy/hostinger/backup.sh
```

ينشئ ملف backup لقاعدة البيانات والمرفقات داخل مجلد `backups`.

## أوامر مفيدة

```bash
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml ps
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml logs -f
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml restart
docker compose --env-file .env -f deploy/hostinger/docker-compose.yml down
```
