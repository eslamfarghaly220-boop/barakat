const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

function runtimePath(value, fallback) {
  if (!value) return fallback;
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

const STORAGE_DIR = runtimePath(process.env.STORAGE_DIR, ROOT);
const DATA_DIR = runtimePath(process.env.DATA_DIR, path.join(STORAGE_DIR, "data"));
const UPLOAD_DIR = runtimePath(process.env.UPLOAD_DIR, path.join(STORAGE_DIR, "uploads"));
const DB_PATH = path.join(DATA_DIR, "helpdesk.sqlite");
const MAX_BODY_SIZE = 25 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

const sessions = new Map();

const statusLabels = {
  new: "جديد",
  review: "قيد المراجعة",
  progress: "جاري التنفيذ",
  completed: "مكتمل",
  confirmed: "تم تأكيد الاستلام",
  reopened: "معاد فتحه"
};

const roleLabels = {
  admin: "مدير البرنامج",
  manager: "مشرف فريق",
  agent: "عضو فريق",
  employee: "موظف"
};

const ticketTypeLabels = {
  it_support: "دعم تقني",
  design: "تصميم",
  access: "صلاحيات",
  device: "جهاز",
  email: "بريد إلكتروني",
  website: "تعديل موقع",
  other: "أخرى"
};

const priorityHours = {
  urgent: 8,
  high: 24,
  medium: 48,
  low: 96
};

function nowIso() {
  return new Date().toISOString();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || "").split(":");
  if (!salt || !expected) return false;
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function initDb() {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('admin','manager','agent','employee')),
      department TEXT NOT NULL DEFAULT 'عام',
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      requester_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      details TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'new',
      assignee_id TEXT,
      solution TEXT,
      reopened_count INTEGER NOT NULL DEFAULT 0,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      confirmed_at TEXT,
      FOREIGN KEY(requester_id) REFERENCES users(id),
      FOREIGN KEY(assignee_id) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      uploader_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'attachment',
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY(uploader_id) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_id) REFERENCES users(id)
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ticket_id TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      read_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
    )
  `).run();

  db.prepare("CREATE INDEX IF NOT EXISTS tickets_status_idx ON tickets(status)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS tickets_requester_idx ON tickets(requester_id)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS tickets_assignee_idx ON tickets(assignee_id)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS attachments_ticket_idx ON attachments(ticket_id)").run();

  const usersCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
  if (usersCount === 0) {
    const createdAt = nowIso();
    const generatedPassword = crypto.randomBytes(18).toString("base64url");
    const initialAdmin = {
      id: "u-admin",
      name: String(process.env.INITIAL_ADMIN_NAME || "مدير البرنامج").trim() || "مدير البرنامج",
      email: String(process.env.INITIAL_ADMIN_EMAIL || "admin@barakat.local").trim().toLowerCase(),
      department: String(process.env.INITIAL_ADMIN_DEPARTMENT || "إدارة البرنامج").trim() || "إدارة البرنامج",
      password: String(process.env.INITIAL_ADMIN_PASSWORD || "").trim() || generatedPassword
    };

    db.prepare(`
      INSERT INTO users (id, name, email, role, department, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      initialAdmin.id,
      initialAdmin.name,
      initialAdmin.email,
      "admin",
      initialAdmin.department,
      hashPassword(initialAdmin.password),
      createdAt
    );

    if (!process.env.INITIAL_ADMIN_PASSWORD) {
      console.warn(`[setup] Initial admin created for ${initialAdmin.email}. Generated password: ${initialAdmin.password}`);
      console.warn("[setup] Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD before the first production run to choose your own credentials.");
    }
  }
}

initDb();

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function getSessionUser(req) {
  const sessionId = parseCookies(req.headers.cookie || "").barakat_session;
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  const user = db.prepare(`
    SELECT id, name, email, role, department, active, created_at
    FROM users
    WHERE id = ? AND active = 1
  `).get(session.userId);
  if (!user) {
    sessions.delete(sessionId);
    return null;
  }
  session.expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  return user;
}

function isStaff(user) {
  return ["admin", "manager", "agent"].includes(user.role);
}

function canManageUsers(user) {
  return ["admin", "manager"].includes(user.role);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function json(res, status, payload, headers = {}) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
}

function redirect(res, location) {
  send(res, 302, "", { Location: location });
}

function readBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("الملف أو البيانات أكبر من الحد المسموح."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 2 * 1024 * 1024);
  if (body.length === 0) return {};
  return JSON.parse(body.toString("utf8"));
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw Object.assign(new Error("صيغة المرفقات غير صحيحة."), { status: 400 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundary);

  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;

    const next = buffer.indexOf(boundary, cursor);
    if (next === -1) break;
    let part = buffer.subarray(cursor, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString("latin1");
      const content = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/i.exec(headerText);
      const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
      if (nameMatch) {
        const name = nameMatch[1];
        if (filenameMatch && filenameMatch[1]) {
          files.push({
            field: name,
            filename: filenameMatch[1],
            mimeType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
            content
          });
        } else {
          fields[name] = content.toString("utf8");
        }
      }
    }
    cursor = next;
  }

  return { fields, files };
}

async function readForm(req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    return parseMultipart(await readBody(req), contentType);
  }
  return { fields: await readJson(req), files: [] };
}

function cleanFileName(name) {
  const base = path.basename(String(name || "file").replaceAll("\\", "/"));
  return base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 120) || "file";
}

function saveAttachment(ticketId, uploaderId, file, kind = "attachment") {
  if (!file || file.content.length === 0) return null;
  const originalName = cleanFileName(file.filename);
  const extension = path.extname(originalName);
  const storedName = `${crypto.randomUUID()}${extension}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), file.content);
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO attachments (id, ticket_id, uploader_id, kind, original_name, stored_name, mime_type, size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, ticketId, uploaderId, kind, originalName, storedName, file.mimeType, file.content.length, nowIso());
  return id;
}

function addEvent(ticketId, actorId, action, oldValue, newValue, message) {
  db.prepare(`
    INSERT INTO ticket_events (id, ticket_id, actor_id, action, old_value, new_value, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), ticketId, actorId, action, oldValue, newValue, message || "", nowIso());
}

function notifyUser(userId, ticketId, title, body) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, ticket_id, title, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, ticketId, title, body, nowIso());
}

function notifyRoles(roles, ticketId, title, body) {
  const users = db.prepare(`
    SELECT id FROM users
    WHERE active = 1 AND role IN (${roles.map(() => "?").join(",")})
  `).all(...roles);
  for (const user of users) notifyUser(user.id, ticketId, title, body);
}

function generateTicketNumber() {
  const year = new Date().getFullYear();
  const prefix = `BRK-${year}-`;
  const row = db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE number LIKE ?").get(`${prefix}%`);
  return `${prefix}${String(row.count + 1).padStart(4, "0")}`;
}

function getTicketForUser(ticketId, user) {
  const ticket = db.prepare(`
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
  `).get(ticketId);
  if (!ticket) return null;
  if (isStaff(user) || ticket.requester_id === user.id) return ticket;
  return null;
}

function listTickets(user) {
  const where = isStaff(user) ? "" : "WHERE t.requester_id = ?";
  const params = isStaff(user) ? [] : [user.id];
  return db.prepare(`
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
    ${where}
    ORDER BY t.created_at DESC
  `).all(...params);
}

function getAttachmentsForTickets(ticketIds) {
  if (ticketIds.length === 0) return {};
  const rows = db.prepare(`
    SELECT id, ticket_id, kind, original_name, mime_type, size, created_at
    FROM attachments
    WHERE ticket_id IN (${ticketIds.map(() => "?").join(",")})
    ORDER BY created_at DESC
  `).all(...ticketIds);
  return rows.reduce((acc, row) => {
    acc[row.ticket_id] ||= [];
    acc[row.ticket_id].push(row);
    return acc;
  }, {});
}

function getEventsForTickets(ticketIds) {
  if (ticketIds.length === 0) return {};
  const rows = db.prepare(`
    SELECT e.*, u.name AS actor_name
    FROM ticket_events e
    JOIN users u ON u.id = e.actor_id
    WHERE e.ticket_id IN (${ticketIds.map(() => "?").join(",")})
    ORDER BY e.created_at DESC
  `).all(...ticketIds);
  return rows.reduce((acc, row) => {
    acc[row.ticket_id] ||= [];
    acc[row.ticket_id].push(row);
    return acc;
  }, {});
}

function buildStats(tickets) {
  const now = new Date();
  const openStatuses = new Set(["new", "review", "progress", "reopened"]);
  const completed = tickets.filter((ticket) => ["completed", "confirmed"].includes(ticket.status));
  const completedWithTime = completed.filter((ticket) => ticket.completed_at);
  const totalHours = completedWithTime.reduce((sum, ticket) => {
    return sum + (new Date(ticket.completed_at) - new Date(ticket.created_at)) / 36e5;
  }, 0);
  const byAssignee = {};
  for (const ticket of tickets) {
    const key = ticket.assignee_name || "غير مسند";
    byAssignee[key] ||= { name: key, open: 0, completed: 0, overdue: 0 };
    if (["completed", "confirmed"].includes(ticket.status)) byAssignee[key].completed += 1;
    if (openStatuses.has(ticket.status)) byAssignee[key].open += 1;
    if (openStatuses.has(ticket.status) && new Date(ticket.due_at) < now) byAssignee[key].overdue += 1;
  }
  return {
    total: tickets.length,
    new: tickets.filter((ticket) => ticket.status === "new").length,
    active: tickets.filter((ticket) => ["review", "progress", "reopened"].includes(ticket.status)).length,
    completed: completed.length,
    overdue: tickets.filter((ticket) => openStatuses.has(ticket.status) && new Date(ticket.due_at) < now).length,
    avgHours: completedWithTime.length ? Math.round((totalHours / completedWithTime.length) * 10) / 10 : 0,
    byAssignee: Object.values(byAssignee)
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    role_label: roleLabels[user.role],
    department: user.department,
    active: Boolean(user.active),
    created_at: user.created_at
  };
}

function normalizeTicket(ticket, attachmentsByTicket, eventsByTicket) {
  return {
    ...ticket,
    type_label: ticketTypeLabels[ticket.type] || ticket.type,
    status_label: statusLabels[ticket.status] || ticket.status,
    attachments: attachmentsByTicket[ticket.id] || [],
    events: eventsByTicket[ticket.id] || []
  };
}

function handleStatic(req, res, pathname) {
  const relative = decodeURIComponent(pathname.slice(1) || "index.html");
  if (!relative || relative.includes("..")) return false;
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon"
  }[ext] || "application/octet-stream";
  send(res, 200, fs.readFileSync(filePath), { "Content-Type": mime });
  return true;
}

function serveFile(req, res, attachmentId, user) {
  const attachment = db.prepare(`
    SELECT a.*, t.requester_id
    FROM attachments a
    JOIN tickets t ON t.id = a.ticket_id
    WHERE a.id = ?
  `).get(attachmentId);
  if (!attachment || (!isStaff(user) && attachment.requester_id !== user.id)) {
    return json(res, 404, { error: "الملف غير موجود." });
  }
  const filePath = path.join(UPLOAD_DIR, attachment.stored_name);
  if (!fs.existsSync(filePath)) return json(res, 404, { error: "الملف غير موجود على الخادم." });
  send(res, 200, fs.readFileSync(filePath), {
    "Content-Type": attachment.mime_type || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.original_name)}`
  });
}

async function apiLogin(req, res) {
  const { email, password } = await readJson(req);
  const user = db.prepare("SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1").get(String(email || "").trim());
  if (!user || !verifyPassword(String(password || ""), user.password_hash)) {
    return json(res, 401, { error: "البريد أو كلمة المرور غير صحيحة." });
  }
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
  json(res, 200, { user: publicUser(user) }, {
    "Set-Cookie": `barakat_session=${encodeURIComponent(sessionId)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=28800`
  });
}

function apiLogout(req, res) {
  const sessionId = parseCookies(req.headers.cookie || "").barakat_session;
  if (sessionId) sessions.delete(sessionId);
  json(res, 200, { ok: true }, {
    "Set-Cookie": "barakat_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0"
  });
}

function apiState(req, res, user) {
  const tickets = listTickets(user);
  const ticketIds = tickets.map((ticket) => ticket.id);
  const attachmentsByTicket = getAttachmentsForTickets(ticketIds);
  const eventsByTicket = getEventsForTickets(ticketIds);
  const normalizedTickets = tickets.map((ticket) => normalizeTicket(ticket, attachmentsByTicket, eventsByTicket));
  const users = isStaff(user)
    ? db.prepare(`
        SELECT id, name, email, role, department, active, created_at
        FROM users
        ORDER BY role, name
      `).all()
    : [user];
  const notifications = db.prepare(`
    SELECT n.*, t.number AS ticket_number
    FROM notifications n
    LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 12
  `).all(user.id);
  json(res, 200, {
    user: publicUser(user),
    users: users.map(publicUser),
    tickets: normalizedTickets,
    stats: buildStats(tickets),
    notifications,
    dictionaries: { statusLabels, roleLabels, ticketTypeLabels }
  });
}

function apiNotifications(req, res, user) {
  const notifications = db.prepare(`
    SELECT n.*, t.number AS ticket_number
    FROM notifications n
    LEFT JOIN tickets t ON t.id = n.ticket_id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC
    LIMIT 12
  `).all(user.id);
  json(res, 200, { notifications });
}

async function apiCreateTicket(req, res, user) {
  const { fields, files } = await readForm(req);
  const title = String(fields.title || "").trim();
  const details = String(fields.details || "").trim();
  const type = String(fields.type || "other");
  const priority = String(fields.priority || "medium");
  if (!title || !details) {
    return json(res, 400, { error: "اكتب عنوان الطلب وتفاصيله." });
  }
  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const dueAt = new Date(Date.now() + (priorityHours[priority] || 48) * 60 * 60 * 1000).toISOString();
  const number = generateTicketNumber();
  db.prepare(`
    INSERT INTO tickets (id, number, requester_id, type, title, details, priority, status, due_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
  `).run(id, number, user.id, type, title, details, priority, dueAt, createdAt, createdAt);

  for (const file of files.filter((item) => item.field === "attachments")) {
    saveAttachment(id, user.id, file, "attachment");
  }

  addEvent(id, user.id, "created", null, "new", "تم إنشاء الطلب.");
  notifyRoles(["admin", "manager", "agent"], id, "طلب جديد", `تم إنشاء الطلب ${number}: ${title}`);
  json(res, 201, { ok: true, id, number });
}

async function apiAssignTicket(req, res, user, ticketId) {
  if (!isStaff(user)) return json(res, 403, { error: "ليس لديك صلاحية إسناد الطلبات." });
  const ticket = getTicketForUser(ticketId, user);
  if (!ticket) return json(res, 404, { error: "الطلب غير موجود." });
  const { assignee_id: assigneeId } = await readJson(req);
  const assignee = db.prepare(`
    SELECT id, name FROM users
    WHERE id = ? AND active = 1 AND role IN ('admin','manager','agent')
  `).get(assigneeId);
  if (!assignee) return json(res, 400, { error: "اختر مسؤولًا صحيحًا من الفريق." });
  const nextStatus = ["new", "reopened"].includes(ticket.status) ? "review" : ticket.status;
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE tickets
    SET assignee_id = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(assignee.id, nextStatus, updatedAt, ticketId);
  addEvent(ticketId, user.id, "assigned", ticket.assignee_id, assignee.id, `تم إسناد الطلب إلى ${assignee.name}.`);
  if (ticket.status !== nextStatus) addEvent(ticketId, user.id, "status", ticket.status, nextStatus, `تغيرت الحالة إلى ${statusLabels[nextStatus]}.`);
  notifyUser(assignee.id, ticketId, "طلب مسند إليك", `تم إسناد الطلب ${ticket.number} إليك.`);
  json(res, 200, { ok: true });
}

async function apiSetStatus(req, res, user, ticketId) {
  if (!isStaff(user)) return json(res, 403, { error: "ليس لديك صلاحية تغيير حالة الطلب." });
  const ticket = getTicketForUser(ticketId, user);
  if (!ticket) return json(res, 404, { error: "الطلب غير موجود." });
  const { status } = await readJson(req);
  if (!["review", "progress"].includes(status)) {
    return json(res, 400, { error: "الحالة غير متاحة من هذا الإجراء." });
  }
  const updatedAt = nowIso();
  db.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, ticketId);
  addEvent(ticketId, user.id, "status", ticket.status, status, `تغيرت الحالة إلى ${statusLabels[status]}.`);
  notifyUser(ticket.requester_id, ticketId, "تحديث على طلبك", `أصبحت حالة الطلب ${ticket.number}: ${statusLabels[status]}.`);
  json(res, 200, { ok: true });
}

async function apiCompleteTicket(req, res, user, ticketId) {
  if (!isStaff(user)) return json(res, 403, { error: "ليس لديك صلاحية إكمال الطلب." });
  const ticket = getTicketForUser(ticketId, user);
  if (!ticket) return json(res, 404, { error: "الطلب غير موجود." });
  const { fields, files } = await readForm(req);
  const solution = String(fields.solution || "").trim();
  if (!solution) return json(res, 400, { error: "اكتب ملخص الحل قبل إغلاق الطلب." });
  const completedAt = nowIso();
  db.prepare(`
    UPDATE tickets
    SET status = 'completed', solution = ?, updated_at = ?, completed_at = ?
    WHERE id = ?
  `).run(solution, completedAt, completedAt, ticketId);
  const finalFile = files.find((file) => file.field === "final_file");
  if (finalFile) saveAttachment(ticketId, user.id, finalFile, "final");
  addEvent(ticketId, user.id, "completed", ticket.status, "completed", solution);
  notifyUser(ticket.requester_id, ticketId, "تم الانتهاء من طلبك", `تم الانتهاء من الطلب ${ticket.number}. يمكنك تأكيد الاستلام أو إعادة فتحه.`);
  json(res, 200, { ok: true });
}

async function apiConfirmTicket(req, res, user, ticketId) {
  const ticket = getTicketForUser(ticketId, user);
  if (!ticket) return json(res, 404, { error: "الطلب غير موجود." });
  if (ticket.requester_id !== user.id) return json(res, 403, { error: "تأكيد الاستلام متاح لصاحب الطلب فقط." });
  if (ticket.status !== "completed") return json(res, 400, { error: "لا يمكن تأكيد هذا الطلب في حالته الحالية." });
  const confirmedAt = nowIso();
  db.prepare("UPDATE tickets SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?").run(confirmedAt, confirmedAt, ticketId);
  addEvent(ticketId, user.id, "confirmed", "completed", "confirmed", "أكد الموظف استلام الحل.");
  if (ticket.assignee_id) notifyUser(ticket.assignee_id, ticketId, "تم تأكيد الاستلام", `أكد الموظف استلام الطلب ${ticket.number}.`);
  json(res, 200, { ok: true });
}

async function apiReopenTicket(req, res, user, ticketId) {
  const ticket = getTicketForUser(ticketId, user);
  if (!ticket) return json(res, 404, { error: "الطلب غير موجود." });
  if (ticket.requester_id !== user.id) return json(res, 403, { error: "إعادة الفتح متاحة لصاحب الطلب فقط." });
  if (!["completed", "confirmed"].includes(ticket.status)) return json(res, 400, { error: "يمكن إعادة فتح الطلب بعد اكتماله فقط." });
  const { message } = await readJson(req);
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE tickets
    SET status = 'reopened', reopened_count = reopened_count + 1, updated_at = ?
    WHERE id = ?
  `).run(updatedAt, ticketId);
  addEvent(ticketId, user.id, "reopened", ticket.status, "reopened", String(message || "تمت إعادة فتح الطلب من الموظف."));
  notifyRoles(["admin", "manager", "agent"], ticketId, "طلب معاد فتحه", `أعاد الموظف فتح الطلب ${ticket.number}.`);
  json(res, 200, { ok: true });
}

async function apiCreateUser(req, res, user) {
  if (!canManageUsers(user)) return json(res, 403, { error: "إضافة الأشخاص متاحة لمدير البرنامج أو المشرف فقط." });
  const body = await readJson(req);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const role = String(body.role || "employee");
  const department = String(body.department || "عام").trim();
  const password = String(body.password || "");
  if (!name || !email || !password) return json(res, 400, { error: "أكمل الاسم والبريد وكلمة المرور." });
  if (!["admin", "manager", "agent", "employee"].includes(role)) return json(res, 400, { error: "الدور غير صحيح." });
  try {
    db.prepare(`
      INSERT INTO users (id, name, email, role, department, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), name, email, role, department, hashPassword(password), nowIso());
    json(res, 201, { ok: true });
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) return json(res, 409, { error: "هذا البريد مستخدم بالفعل." });
    throw error;
  }
}

async function apiToggleUser(req, res, user, userId) {
  if (!canManageUsers(user)) return json(res, 403, { error: "تعديل الأشخاص متاح لمدير البرنامج أو المشرف فقط." });
  if (userId === user.id) return json(res, 400, { error: "لا يمكن تعطيل حسابك الحالي." });
  const body = await readJson(req);
  const active = body.active ? 1 : 0;
  const result = db.prepare("UPDATE users SET active = ? WHERE id = ?").run(active, userId);
  if (result.changes === 0) return json(res, 404, { error: "المستخدم غير موجود." });
  json(res, 200, { ok: true });
}

function markNotificationsRead(user) {
  db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(nowIso(), user.id);
}

async function handleApi(req, res, pathname, user) {
  if (pathname === "/api/login" && req.method === "POST") return apiLogin(req, res);
  if (!user) return json(res, 401, { error: "سجل الدخول أولًا." });
  if (pathname === "/api/logout" && req.method === "POST") return apiLogout(req, res);
  if (pathname === "/api/state" && req.method === "GET") return apiState(req, res, user);
  if (pathname === "/api/notifications" && req.method === "GET") return apiNotifications(req, res, user);
  if (pathname === "/api/notifications/read" && req.method === "POST") {
    markNotificationsRead(user);
    return json(res, 200, { ok: true });
  }
  if (pathname === "/api/tickets" && req.method === "POST") return apiCreateTicket(req, res, user);
  if (pathname === "/api/users" && req.method === "POST") return apiCreateUser(req, res, user);

  const ticketAction = /^\/api\/tickets\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (ticketAction && req.method === "POST") {
    const [, ticketId, action] = ticketAction;
    if (action === "assign") return apiAssignTicket(req, res, user, ticketId);
    if (action === "status") return apiSetStatus(req, res, user, ticketId);
    if (action === "complete") return apiCompleteTicket(req, res, user, ticketId);
    if (action === "confirm") return apiConfirmTicket(req, res, user, ticketId);
    if (action === "reopen") return apiReopenTicket(req, res, user, ticketId);
  }

  const userAction = /^\/api\/users\/([^/]+)\/active$/.exec(pathname);
  if (userAction && req.method === "POST") return apiToggleUser(req, res, user, userAction[1]);

  json(res, 404, { error: "المسار غير موجود." });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const user = getSessionUser(req);

  try {
    if (pathname === "/login" && req.method === "GET") {
      if (user) return redirect(res, "/");
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "login.html")), {
        "Content-Type": "text/html; charset=utf-8"
      });
    }

    if (pathname.startsWith("/api/")) return handleApi(req, res, pathname, user);

    if (pathname.startsWith("/files/") && req.method === "GET") {
      if (!user) return redirect(res, "/login");
      return serveFile(req, res, pathname.replace("/files/", ""), user);
    }

    if (["/brand-logo.png", "/styles.css", "/app.js", "/login.js"].includes(pathname)) {
      if (handleStatic(req, res, pathname)) return;
    }

    if (pathname === "/" && req.method === "GET") {
      if (!user) return redirect(res, "/login");
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "index.html")), {
        "Content-Type": "text/html; charset=utf-8"
      });
    }

    if (handleStatic(req, res, pathname)) return;
    json(res, 404, { error: "الصفحة غير موجودة." });
  } catch (error) {
    const status = error.status || 500;
    console.error(error);
    json(res, status, { error: status === 500 ? "حدث خطأ غير متوقع." : error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Barakat Help Desk running at http://localhost:${PORT}`);
});
