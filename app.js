const state = {
  user: null,
  users: [],
  tickets: [],
  stats: null,
  notifications: [],
  dictionaries: {},
  view: "dashboard",
  selectedTicketId: null,
  filters: { status: "all", type: "all", q: "" }
};

const root = document.querySelector("#viewRoot");
const pageTitle = document.querySelector("#pageTitle");
const toast = document.querySelector("#toast");
const notificationsRoot = document.querySelector("#notifications");
const seenNotificationIds = new Set();
let notificationsInitialized = false;

const titles = {
  dashboard: "لوحة التحكم",
  tickets: "الطلبات",
  newTicket: "طلب جديد",
  reports: "التقارير",
  users: "الأشخاص والصلاحيات"
};

const priorityLabels = {
  urgent: "عاجل",
  high: "مرتفع",
  medium: "متوسط",
  low: "منخفض"
};

const statusMessages = {
  new: "تم استلام الطلب وإرساله للفريق المختص. في انتظار المراجعة والإسناد.",
  review: "الطلب قيد المراجعة الآن، وسيتم تحديد المسؤول أو الخطوة التالية.",
  progress: "الطلب جاري تنفيذه من المسؤول المحدد، وسيتم إشعار صاحب الطلب عند الانتهاء.",
  completed: "تم تسجيل الحل وإغلاق التنفيذ. في انتظار تأكيد استلام صاحب الطلب.",
  confirmed: "أكد صاحب الطلب استلام الحل، وتم إغلاق الطلب نهائيًا.",
  reopened: "تمت إعادة فتح الطلب ويحتاج إلى متابعة إضافية من الفريق."
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function dateText(value) {
  if (!value) return "غير محدد";
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function hoursLeft(ticket) {
  const diff = new Date(ticket.due_at) - new Date();
  if (["completed", "confirmed"].includes(ticket.status)) return "منتهي";
  if (diff < 0) return "متأخر";
  const hours = Math.ceil(diff / 36e5);
  return `${hours} ساعة متبقية`;
}

function isStaff() {
  return ["admin", "manager", "agent"].includes(state.user?.role);
}

function canManageUsers() {
  return ["admin", "manager"].includes(state.user?.role);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof result === "object" ? result.error : result;
    throw new Error(message || "حدث خطأ أثناء تنفيذ العملية.");
  }
  return result;
}

async function loadState() {
  const data = await api("/api/state");
  Object.assign(state, data);
  state.notifications.forEach((item) => seenNotificationIds.add(item.id));
  notificationsInitialized = true;
  if (!state.selectedTicketId && state.tickets[0]) state.selectedTicketId = state.tickets[0].id;
  renderShell();
  render();
}

async function pollNotifications() {
  if (!state.user) return;
  try {
    const data = await api("/api/notifications");
    const incoming = data.notifications || [];
    const fresh = incoming
      .filter((item) => !item.read_at && !seenNotificationIds.has(item.id))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    incoming.forEach((item) => seenNotificationIds.add(item.id));
    state.notifications = incoming;
    renderNotifications();

    if (notificationsInitialized) {
      fresh.forEach((item) => showToast(`${item.title}: ${item.body}`));
    }
  } catch (error) {
    if (error.message.includes("سجل الدخول")) window.location.href = "/login";
  }
}

function renderShell() {
  document.querySelector("#userName").textContent = state.user.name;
  document.querySelector("#userEmail").textContent = state.user.email;
  document.querySelector("#userRole").textContent = state.user.role_label;
  document.querySelectorAll(".nav button").forEach((button) => {
    const view = button.dataset.view;
    button.classList.toggle("active", view === state.view);
    if (view === "users") button.classList.toggle("hidden", !canManageUsers());
    if (view === "reports") button.classList.toggle("hidden", !isStaff());
  });
  renderNotifications();
}

function renderNotifications() {
  const unread = state.notifications.filter((item) => !item.read_at).slice(0, 3);
  notificationsRoot.classList.toggle("visible", unread.length > 0);
  notificationsRoot.innerHTML = unread
    .map((item) => `
      <div class="notification-item">
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.body)}</span>
        </div>
        <small>${dateText(item.created_at)}</small>
      </div>
    `)
    .join("");
}

function setView(view) {
  if (view === "users" && !canManageUsers()) return;
  if (view === "reports" && !isStaff()) return;
  state.view = view;
  pageTitle.textContent = titles[view];
  renderShell();
  render();
}

function statusClass(status) {
  return `status-${status}`;
}

function priorityClass(priority) {
  return `priority-${priority}`;
}

function statusNotice(ticket) {
  return statusMessages[ticket.status] || "تم تحديث حالة الطلب.";
}

function isTicketOverdue(ticket) {
  return !["completed", "confirmed"].includes(ticket.status) && new Date(ticket.due_at) < new Date();
}

function weekStart(dateValue) {
  const date = new Date(dateValue);
  date.setHours(0, 0, 0, 0);
  const day = date.getDay();
  const diff = (day + 6) % 7;
  date.setDate(date.getDate() - diff);
  return date;
}

function weekKey(dateValue) {
  return weekStart(dateValue).toISOString().slice(0, 10);
}

function weekLabel(key) {
  const start = new Date(`${key}T00:00:00`);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const formatter = new Intl.DateTimeFormat("ar-EG", { day: "numeric", month: "short", year: "numeric" });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function weeklyReports() {
  const weeks = new Map();
  const ensureWeek = (key) => {
    if (!weeks.has(key)) weeks.set(key, { key, completed: [], overdue: [] });
    return weeks.get(key);
  };

  state.tickets.forEach((ticket) => {
    if (["completed", "confirmed"].includes(ticket.status)) {
      ensureWeek(weekKey(ticket.completed_at || ticket.updated_at || ticket.created_at)).completed.push(ticket);
    }
    if (isTicketOverdue(ticket)) {
      ensureWeek(weekKey(ticket.due_at || ticket.created_at)).overdue.push(ticket);
    }
  });

  return [...weeks.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function csvValue(value) {
  const text = String(value ?? "").replaceAll('"', '""');
  return `"${text}"`;
}

function downloadCsv(filename, rows) {
  const csv = rows.map((row) => row.map(csvValue).join(",")).join("\r\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function reportRows(tickets) {
  return [
    ["رقم الطلب", "العنوان", "النوع", "الحالة", "الأولوية", "صاحب الطلب", "المسؤول", "تاريخ الإنشاء", "موعد الإنجاز", "تاريخ الإكمال", "ملاحظة الحالة"],
    ...tickets.map((ticket) => [
      ticket.number,
      ticket.title,
      ticket.type_label,
      ticket.status_label,
      priorityLabels[ticket.priority] || ticket.priority,
      ticket.requester_name,
      ticket.assignee_name || "غير مسند",
      dateText(ticket.created_at),
      dateText(ticket.due_at),
      ticket.completed_at ? dateText(ticket.completed_at) : "",
      statusNotice(ticket)
    ])
  ];
}

function downloadWeeklyReport(kind, key) {
  const week = weeklyReports().find((item) => item.key === key);
  if (!week) {
    showToast("لا توجد بيانات لهذا الأسبوع.");
    return;
  }
  const tickets = kind === "completed"
    ? week.completed
    : kind === "overdue"
      ? week.overdue
      : [...week.completed, ...week.overdue];
  if (!tickets.length) {
    showToast("لا توجد طلبات في هذا التقرير.");
    return;
  }
  const names = { completed: "المنجزة", overdue: "المتاخرة", all: "الكامل" };
  downloadCsv(`تقرير-${names[kind] || "الاسبوع"}-${key}.csv`, reportRows(tickets));
}

function filteredTickets() {
  return state.tickets.filter((ticket) => {
    const statusMatch = state.filters.status === "all" || ticket.status === state.filters.status;
    const typeMatch = state.filters.type === "all" || ticket.type === state.filters.type;
    const q = state.filters.q.trim().toLowerCase();
    const searchMatch = !q || [ticket.number, ticket.title, ticket.requester_name, ticket.assignee_name, ticket.details]
      .filter(Boolean)
      .some((item) => String(item).toLowerCase().includes(q));
    return statusMatch && typeMatch && searchMatch;
  });
}

function ticketRow(ticket) {
  return `
    <button class="ticket-row ${state.selectedTicketId === ticket.id ? "selected" : ""}" data-ticket-id="${ticket.id}">
      <div class="ticket-row-head">
        <span class="ticket-title">${escapeHtml(ticket.title)}</span>
        <span class="ticket-number">${ticket.number}</span>
      </div>
      <div class="ticket-row-meta">
        <span class="status-pill ${statusClass(ticket.status)}">${ticket.status_label}</span>
        <span class="priority-pill ${priorityClass(ticket.priority)}">${priorityLabels[ticket.priority] || ticket.priority}</span>
        <span class="pill">${ticket.type_label}</span>
        <span class="muted">المسؤول: ${escapeHtml(ticket.assignee_name || "غير مسند")}</span>
        <span class="muted">${hoursLeft(ticket)}</span>
      </div>
      <div class="ticket-status-alert ${statusClass(ticket.status)}">
        <strong>إشعار الحالة</strong>
        <span>${escapeHtml(statusNotice(ticket))}</span>
      </div>
    </button>
  `;
}

function renderTicketList(tickets) {
  return `
    <div class="ticket-list">
      ${tickets.length ? tickets.map(ticketRow).join("") : `<div class="detail-empty">لا توجد طلبات بهذه المعايير.</div>`}
    </div>
  `;
}

function renderDashboard() {
  const stats = state.stats;
  const newTickets = state.tickets.filter((ticket) => ticket.status === "new").slice(0, 6);
  const overdueTickets = state.tickets
    .filter((ticket) => !["completed", "confirmed"].includes(ticket.status) && new Date(ticket.due_at) < new Date())
    .slice(0, 6);
  root.innerHTML = `
    <div class="grid stats-grid">
      <div class="stat-card"><span>طلبات جديدة</span><strong>${stats.new}</strong></div>
      <div class="stat-card"><span>قيد العمل</span><strong>${stats.active}</strong></div>
      <div class="stat-card"><span>متأخرة</span><strong>${stats.overdue}</strong></div>
      <div class="stat-card"><span>مكتملة</span><strong>${stats.completed}</strong></div>
      <div class="stat-card"><span>متوسط الإنجاز</span><strong>${stats.avgHours} س</strong></div>
    </div>

    <div class="grid two-column" style="margin-top:14px">
      <section class="panel">
        <div class="panel-header">
          <h2>الطلبات الجديدة</h2>
          <button class="outline-button" data-view-jump="tickets">عرض الكل</button>
        </div>
        ${renderTicketList(newTickets)}
      </section>
      <section class="panel">
        <div class="panel-header">
          <h2>الطلبات المتأخرة</h2>
          <span class="pill">${overdueTickets.length} طلب</span>
        </div>
        ${renderTicketList(overdueTickets)}
      </section>
    </div>
  `;
}

function renderTickets() {
  const tickets = filteredTickets();
  const selected = state.tickets.find((ticket) => ticket.id === state.selectedTicketId) || tickets[0] || null;
  if (selected) state.selectedTicketId = selected.id;
  root.innerHTML = `
    <div class="grid two-column">
      <section class="panel">
        <div class="panel-header">
          <h2>قائمة الطلبات</h2>
          <span class="pill">${tickets.length} طلب</span>
        </div>
        <div class="filters">
          <select id="statusFilter">
            <option value="all">كل الحالات</option>
            ${Object.entries(state.dictionaries.statusLabels).map(([value, label]) => `<option value="${value}" ${state.filters.status === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <select id="typeFilter">
            <option value="all">كل الأنواع</option>
            ${Object.entries(state.dictionaries.ticketTypeLabels).map(([value, label]) => `<option value="${value}" ${state.filters.type === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
          <input id="searchFilter" value="${escapeHtml(state.filters.q)}" placeholder="بحث برقم الطلب أو العنوان" />
        </div>
        ${renderTicketList(tickets)}
      </section>
      ${renderTicketDetail(selected)}
    </div>
  `;
}

function attachmentsHtml(ticket, kind = null) {
  const files = kind ? ticket.attachments.filter((file) => file.kind === kind) : ticket.attachments;
  if (!files.length) return `<span class="muted">لا توجد ملفات.</span>`;
  return files.map((file) => `<a href="/files/${file.id}" target="_blank">${escapeHtml(file.original_name)}</a>`).join("");
}

function renderTicketDetail(ticket) {
  if (!ticket) {
    return `<aside class="ticket-detail detail-empty">اختر طلبًا من القائمة لعرض التفاصيل.</aside>`;
  }
  return `
    <aside class="ticket-detail">
      <div>
        <span class="ticket-number">${ticket.number}</span>
        <h2>${escapeHtml(ticket.title)}</h2>
      </div>
      <div class="detail-meta">
        <span class="status-pill ${statusClass(ticket.status)}">${ticket.status_label}</span>
        <span class="priority-pill ${priorityClass(ticket.priority)}">${priorityLabels[ticket.priority] || ticket.priority}</span>
        <span class="pill">${ticket.type_label}</span>
      </div>
      <div class="status-notice-card ${statusClass(ticket.status)}">
        <strong>إشعار الحالة الحالية</strong>
        <span>${escapeHtml(statusNotice(ticket))}</span>
      </div>
      <div class="detail-block">
        <p>${escapeHtml(ticket.details)}</p>
        <span class="muted">صاحب الطلب: ${escapeHtml(ticket.requester_name)} - ${escapeHtml(ticket.requester_department)}</span>
        <span class="muted">المسؤول: ${escapeHtml(ticket.assignee_name || "غير مسند")}</span>
        <span class="muted">تاريخ الإنشاء: ${dateText(ticket.created_at)}</span>
        <span class="muted">موعد الإنجاز المتوقع: ${dateText(ticket.due_at)} (${hoursLeft(ticket)})</span>
      </div>
      <div class="detail-block">
        <strong>المرفقات</strong>
        <div class="attachment-list">${attachmentsHtml(ticket, "attachment")}</div>
      </div>
      ${ticket.solution ? `
        <div class="detail-block">
          <strong>الحل المسجل</strong>
          <p>${escapeHtml(ticket.solution)}</p>
          <div class="attachment-list">${attachmentsHtml(ticket, "final")}</div>
        </div>
      ` : ""}
      ${renderTicketActions(ticket)}
      <div class="detail-block">
        <strong>سجل الحركة</strong>
        <div class="event-list">
          ${ticket.events.map((event) => `
            <div class="event-item">
              <strong>${escapeHtml(event.actor_name)}</strong>
              <span>${escapeHtml(event.message || event.action)}</span>
              <small class="muted">${dateText(event.created_at)}</small>
            </div>
          `).join("")}
        </div>
      </div>
    </aside>
  `;
}

function renderTicketActions(ticket) {
  const assignees = state.users.filter((user) => ["admin", "manager", "agent"].includes(user.role) && user.active);
  if (isStaff()) {
    return `
      <div class="detail-block actions-grid">
        <strong>إجراءات الفريق</strong>
        <label>
          المسؤول عن الطلب
          <select id="assigneeSelect">
            <option value="">اختر المسؤول</option>
            ${assignees.map((user) => `<option value="${user.id}" ${ticket.assignee_id === user.id ? "selected" : ""}>${escapeHtml(user.name)} - ${user.role_label}</option>`).join("")}
          </select>
        </label>
        <button class="outline-button" data-action="assign" data-ticket-id="${ticket.id}">إسناد الطلب</button>
        <div class="form-grid two">
          <button class="ghost-button" data-action="status" data-status="review" data-ticket-id="${ticket.id}">قيد المراجعة</button>
          <button class="ghost-button" data-action="status" data-status="progress" data-ticket-id="${ticket.id}">جاري التنفيذ</button>
        </div>
        <form class="actions-grid" id="completeForm" data-ticket-id="${ticket.id}">
          <label>
            الحل أو ملاحظات الإغلاق
            <textarea name="solution" placeholder="اكتب الحل الذي تم تنفيذه أو الملفات التي تم تسليمها">${escapeHtml(ticket.solution || "")}</textarea>
          </label>
          <label>
            الملف النهائي
            <input name="final_file" type="file" />
          </label>
          <button class="primary-button" type="submit">تم الانتهاء</button>
        </form>
      </div>
    `;
  }

  if (ticket.requester_id === state.user.id && ticket.status === "completed") {
    return `
      <div class="detail-block actions-grid">
        <strong>تأكيد الموظف</strong>
        <button class="primary-button" data-action="confirm" data-ticket-id="${ticket.id}">تأكيد الاستلام</button>
        <button class="danger-button" data-action="reopen" data-ticket-id="${ticket.id}">إعادة فتح الطلب</button>
      </div>
    `;
  }
  return "";
}

function renderNewTicket() {
  root.innerHTML = `
    <section class="panel new-ticket-form">
      <div class="panel-header">
        <h2>إنشاء طلب خدمة جديد</h2>
        <span class="pill">سيتم إنشاء رقم طلب تلقائي</span>
      </div>
      <form id="ticketForm" class="form-grid">
        <div class="form-grid two">
          <label>
            نوع الطلب
            <select name="type" required>
              ${Object.entries(state.dictionaries.ticketTypeLabels).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
            </select>
          </label>
          <label>
            الأولوية
            <select name="priority" required>
              <option value="medium">متوسط</option>
              <option value="high">مرتفع</option>
              <option value="urgent">عاجل</option>
              <option value="low">منخفض</option>
            </select>
          </label>
        </div>
        <label>
          عنوان الطلب
          <input name="title" required placeholder="مثال: لا يمكنني الدخول إلى البريد" />
        </label>
        <label>
          تفاصيل الطلب
          <textarea name="details" required placeholder="اكتب المشكلة أو المطلوب، القسم، الموعد المطلوب، وأي تفاصيل تساعد الفريق."></textarea>
        </label>
        <label>
          صور أو ملفات مساعدة
          <input name="attachments" type="file" multiple />
        </label>
        <button class="primary-button" type="submit">إرسال الطلب</button>
      </form>
    </section>
  `;
}

function renderUsers() {
  if (!canManageUsers()) {
    root.innerHTML = `<section class="panel detail-empty">ليست لديك صلاحية إدارة الأشخاص.</section>`;
    return;
  }
  root.innerHTML = `
    <div class="grid two-column">
      <section class="panel">
        <div class="panel-header">
          <h2>الأشخاص والصلاحيات</h2>
          <span class="pill">${state.users.length} حساب</span>
        </div>
        <div class="user-list">
          ${state.users.map((user) => `
            <div class="user-row">
              <div class="user-main">
                <strong>${escapeHtml(user.name)}</strong>
                <span class="muted">${escapeHtml(user.email)} - ${escapeHtml(user.department)}</span>
              </div>
              <div class="ticket-row-meta">
                <span class="pill">${user.role_label}</span>
                <span class="pill">${user.active ? "نشط" : "معطل"}</span>
                ${user.id !== state.user.id ? `<button class="${user.active ? "danger-button" : "ghost-button"}" data-action="toggle-user" data-user-id="${user.id}" data-active="${user.active ? "0" : "1"}">${user.active ? "تعطيل" : "تفعيل"}</button>` : ""}
              </div>
            </div>
          `).join("")}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>إضافة شخص جديد</h2></div>
        <form id="userForm" class="form-grid">
          <label>الاسم<input name="name" required /></label>
          <label>البريد الإلكتروني<input name="email" type="email" required /></label>
          <label>القسم<input name="department" required value="عام" /></label>
          <label>
            الصلاحية
            <select name="role">
              <option value="employee">موظف</option>
              <option value="agent">عضو فريق</option>
              <option value="manager">مشرف فريق</option>
              <option value="admin">مدير البرنامج</option>
            </select>
          </label>
          <label>كلمة المرور المؤقتة<input name="password" type="password" required /></label>
          <button class="primary-button" type="submit">إضافة الشخص</button>
        </form>
      </section>
    </div>
  `;
}

function renderReports() {
  if (!isStaff()) {
    root.innerHTML = `<section class="panel detail-empty">التقارير متاحة للفريق فقط.</section>`;
    return;
  }
  const maxCount = Math.max(...state.stats.byAssignee.map((item) => item.open + item.completed + item.overdue), 1);
  const weeks = weeklyReports();
  root.innerHTML = `
    <div class="grid report-grid">
      <section class="report-card">
        <h2>أداء الفريق</h2>
        <div class="grid" style="margin-top:14px">
          ${state.stats.byAssignee.map((item) => {
            const total = item.open + item.completed + item.overdue;
            return `
              <div class="report-line">
                <strong style="min-width:110px">${escapeHtml(item.name)}</strong>
                <div class="bar"><span style="width:${Math.max(8, (total / maxCount) * 100)}%"></span></div>
                <span class="muted">مفتوح ${item.open} / مكتمل ${item.completed} / متأخر ${item.overdue}</span>
              </div>
            `;
          }).join("")}
        </div>
      </section>
      <section class="report-card">
        <h2>ملخص الخدمة</h2>
        <div class="grid stats-grid" style="grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top:14px">
          <div class="stat-card"><span>كل الطلبات</span><strong>${state.stats.total}</strong></div>
          <div class="stat-card"><span>طلبات متأخرة</span><strong>${state.stats.overdue}</strong></div>
          <div class="stat-card"><span>مكتملة</span><strong>${state.stats.completed}</strong></div>
          <div class="stat-card"><span>متوسط الإنجاز</span><strong>${state.stats.avgHours} س</strong></div>
        </div>
      </section>
    </div>
    <section class="panel weekly-report-panel">
      <div class="panel-header">
        <div>
          <h2>تنزيل التقارير الأسبوعية</h2>
          <span class="muted">تقارير واضحة لكل أسبوع للطلبات المنجزة والمتأخرة.</span>
        </div>
        <span class="pill">${weeks.length} أسبوع</span>
      </div>
      <div class="weekly-report-list">
        ${weeks.length ? weeks.map((week) => `
          <div class="weekly-report-row">
            <div class="weekly-report-summary">
              <strong>${weekLabel(week.key)}</strong>
              <span>منجزة: ${week.completed.length} / متأخرة: ${week.overdue.length}</span>
            </div>
            <div class="weekly-report-actions">
              <button class="outline-button" data-action="download-report" data-report-kind="completed" data-week="${week.key}">تنزيل المنجزة</button>
              <button class="danger-button" data-action="download-report" data-report-kind="overdue" data-week="${week.key}">تنزيل المتأخرة</button>
              <button class="ghost-button" data-action="download-report" data-report-kind="all" data-week="${week.key}">تنزيل تقرير الأسبوع</button>
            </div>
          </div>
        `).join("") : `<div class="detail-empty">لا توجد طلبات منجزة أو متأخرة حتى الآن.</div>`}
      </div>
    </section>
  `;
}

function render() {
  pageTitle.textContent = titles[state.view];
  if (state.view === "dashboard") renderDashboard();
  if (state.view === "tickets") renderTickets();
  if (state.view === "newTicket") renderNewTicket();
  if (state.view === "users") renderUsers();
  if (state.view === "reports") renderReports();
}

document.addEventListener("click", async (event) => {
  const navButton = event.target.closest("[data-view], [data-view-jump]");
  if (navButton) {
    setView(navButton.dataset.view || navButton.dataset.viewJump);
    return;
  }

  const ticketRowButton = event.target.closest("[data-ticket-id].ticket-row");
  if (ticketRowButton) {
    state.selectedTicketId = ticketRowButton.dataset.ticketId;
    setView("tickets");
    return;
  }

  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "download-report") {
    downloadWeeklyReport(action.dataset.reportKind, action.dataset.week);
    return;
  }
  const ticketId = action.dataset.ticketId;
  try {
    if (action.dataset.action === "assign") {
      const assigneeId = document.querySelector("#assigneeSelect").value;
      await api(`/api/tickets/${ticketId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_id: assigneeId })
      });
      showToast("تم إسناد الطلب.");
    }
    if (action.dataset.action === "status") {
      await api(`/api/tickets/${ticketId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action.dataset.status })
      });
      showToast("تم تحديث الحالة.");
    }
    if (action.dataset.action === "confirm") {
      await api(`/api/tickets/${ticketId}/confirm`, { method: "POST" });
      showToast("تم تأكيد الاستلام.");
    }
    if (action.dataset.action === "reopen") {
      const message = window.prompt("اكتب سبب إعادة فتح الطلب") || "يحتاج الطلب إلى متابعة إضافية.";
      await api(`/api/tickets/${ticketId}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      showToast("تمت إعادة فتح الطلب.");
    }
    if (action.dataset.action === "toggle-user") {
      await api(`/api/users/${action.dataset.userId}/active`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: action.dataset.active === "1" })
      });
      showToast("تم تحديث حالة الحساب.");
    }
    await loadState();
  } catch (error) {
    showToast(error.message);
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "statusFilter") {
    state.filters.status = event.target.value;
    renderTickets();
  }
  if (event.target.id === "typeFilter") {
    state.filters.type = event.target.value;
    renderTickets();
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "searchFilter") {
    state.filters.q = event.target.value;
    renderTickets();
  }
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    if (event.target.id === "ticketForm") {
      await api("/api/tickets", { method: "POST", body: new FormData(event.target) });
      showToast("تم إرسال الطلب بنجاح.");
      event.target.reset();
      await loadState();
      setView("tickets");
    }
    if (event.target.id === "completeForm") {
      await api(`/api/tickets/${event.target.dataset.ticketId}/complete`, { method: "POST", body: new FormData(event.target) });
      showToast("تم إكمال الطلب وإشعار الموظف.");
      await loadState();
    }
    if (event.target.id === "userForm") {
      const payload = Object.fromEntries(new FormData(event.target).entries());
      await api("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      showToast("تمت إضافة الشخص.");
      event.target.reset();
      await loadState();
    }
  } catch (error) {
    showToast(error.message);
  }
});

document.querySelector("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

document.querySelector("#refreshButton").addEventListener("click", () => loadState().then(() => showToast("تم التحديث.")));

loadState().catch(() => {
  window.location.href = "/login";
});

window.setInterval(pollNotifications, 5000);
