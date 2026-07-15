# Production Deployment

## Normal Hostinger hosting

If you bought normal Hostinger Hosting, not a VPS/server, use the PHP + MySQL package:

```text
hostinger/public_html
```

Upload the contents of this folder to Hostinger `public_html`, then edit `config.php` with the MySQL database details from hPanel. Use `hostinger/README-AR.md` for the Arabic step-by-step guide.

هذه النسخة مجهزة للتشغيل على سيرفر VPS مثل Hostinger، وأيضًا على أي استضافة تدعم Docker.

للنشر على Hostinger VPS استخدم التعليمات الموجودة هنا:

```text
deploy/hostinger/README.md
```

## المطلوب قبل ربط الدومين

1. افتح زر النشر المباشر:
   `https://render.com/deploy?repo=https://github.com/eslamfarghaly220-boop/barakat`
2. استخدم ملف `render.yaml` الموجود في المستودع لإنشاء الخدمة.
3. تأكد من وجود مساحة تخزين ثابتة على المسار `/var/data`.
4. بعد أول تشغيل، افتح رابط الاستضافة وسيظهر لك إعداد أول مدير للنظام.
5. أنشئ حساب مدير البرنامج من الواجهة، ثم أضف الفريق والموظفين من داخل النظام.

## قاعدة البيانات والمرفقات

- قاعدة البيانات والمرفقات تحفظ داخل `STORAGE_DIR`.
- في إعداد Render الحالي يتم ضبط `STORAGE_DIR=/var/data`.
- لا يتم رفع قاعدة البيانات أو المرفقات إلى GitHub.

## ربط الدومين

بعد نجاح تشغيل الخدمة:

1. افتح إعدادات الخدمة في الاستضافة.
2. أضف الدومين الخاص بك من قسم Custom Domains.
3. انسخ قيم DNS التي تعرضها الاستضافة إلى لوحة تحكم الدومين.
4. انتظر تفعيل شهادة HTTPS.

بعد تفعيل الدومين، افتحه مباشرة وسجل الدخول بحساب مدير البرنامج.
