window.onerror = function(msg, url, line) { console.error("Error:", msg, "line", line); };

const CLIENT_ID = '579760500373-h2p2lrbi5ahs7gor1d8288im50ttk8th.apps.googleusercontent.com';
const API_KEY = 'AIzaSyD7umqoJee8iyaXdzr43irea6gfvvGaXcM';
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email';
const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];

let tokenClient, gapiInited = false, gisInited = false, cloudFileId = null, cloudSyncTimeout = null, currentUser = null;
const statusInd = document.getElementById('cloudStatusIndicator');
const authBanner = document.getElementById('authBanner');

window.toggleAccountDropdown = function() {
    const dropdown = document.getElementById('accountDropdown');
    if (dropdown) dropdown.classList.toggle('open');
};

document.addEventListener('click', (e) => {
    const chip = document.getElementById('accountChip'), dropdown = document.getElementById('accountDropdown');
    if (chip && dropdown && !chip.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('open');
});

async function fetchUserProfile(accessToken) {
    try {
        const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
        return res.ok ? await res.json() : null;
    } catch(e) { return null; }
}

function renderUserUI(user) {
    if (!user) return;
    currentUser = user;
    const initial = (user.name || user.email || '?')[0].toUpperCase();
    const imgHtml = user.picture ? `<img src="${user.picture}" alt="" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : initial;
    
    ['chipAvatar', 'dropAvatar'].forEach(id => { const el = document.getElementById(id); if(el) el.innerHTML = imgHtml; });
    
    const chipName = document.getElementById('chipName'); if(chipName) chipName.textContent = user.given_name || user.name || 'Аккаунт';
    const dropName = document.getElementById('dropName'); if(dropName) dropName.textContent = user.name || '';
    const dropEmail = document.getElementById('dropEmail'); if(dropEmail) dropEmail.textContent = user.email || '';
    
    const chip = document.getElementById('accountChip'); if (chip) chip.style.display = 'flex';
    try { localStorage.setItem('focusflow_user_profile', JSON.stringify(user)); } catch(e) {}
}

window.signOut = function() {
    const dropdown = document.getElementById('accountDropdown'); if (dropdown) dropdown.classList.remove('open');
    if (typeof google !== 'undefined' && google.accounts) {
        const token = gapi.client.getToken();
        if (token && token.access_token) google.accounts.oauth2.revoke(token.access_token, () => {});
        google.accounts.id.disableAutoSelect();
        gapi.client.setToken(null);
    }
    ['focusflow_access_token', 'focusflow_token_expiry', 'focusflow_user_profile', 'focusflow_login_hint'].forEach(k => localStorage.removeItem(k));
    if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null; }
    currentUser = null; cloudFileId = null;
    const chip = document.getElementById('accountChip'); if (chip) chip.style.display = 'none';
    if (authBanner) authBanner.style.display = 'flex';
    if (statusInd) statusInd.style.display = 'none';
    const btnLogin = document.getElementById('btnForceLogin'); if (btnLogin) btnLogin.textContent = '🔑 Войти через Google';
};

window.manualSync = async function() {
    const dropdown = document.getElementById('accountDropdown'); if (dropdown) dropdown.classList.remove('open');
    await pushToDrive(true);
    tasks.forEach(t => { if(!t.done) t.needsSync = true; });
    await triggerCalendarSync(true);
};

// ... Auth ...
async function onTokenReceived(resp) {
    const btn = document.getElementById('btnForceLogin');
    if (resp.error !== undefined) {
        console.warn('Auth failed:', resp.error);
        if(authBanner) authBanner.style.display = 'flex';
        if(statusInd) statusInd.style.display = 'none';
        if(btn) btn.textContent = '🔑 Войти через Google';
        return; 
    }
    const expiryTime = Date.now() + ((resp.expires_in || 3600) * 1000);
    try {
        localStorage.setItem('focusflow_access_token', resp.access_token);
        localStorage.setItem('focusflow_token_expiry', expiryTime.toString());
    } catch(e) {}
    gapi.client.setToken({ access_token: resp.access_token });
    if(authBanner) authBanner.style.display = 'none';
    if(statusInd) { statusInd.style.display = 'inline'; statusInd.textContent = '☁️ (синхр...)'; }
    
    const profile = await fetchUserProfile(resp.access_token);
    if (profile) {
        renderUserUI(profile);
        try { localStorage.setItem('focusflow_login_hint', profile.email); } catch(e) {}
    }
    await initDriveSync();
    tasks.forEach(t => { if(!t.done) t.needsSync = true; });
    await triggerCalendarSync(false);
    scheduleTokenRefresh(expiryTime);
}

let tokenRefreshTimer = null;
function scheduleTokenRefresh(expiryTime) {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
    const msUntilRefresh = expiryTime - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh > 0) {
        tokenRefreshTimer = setTimeout(() => {
            const hint = localStorage.getItem('focusflow_login_hint');
            if (!tokenClient || !hint) return;
            google.accounts.id.prompt((n) => {
                if (n.isNotDisplayed() || n.isSkippedMoment()) tokenClient.requestAccessToken({ prompt: '', login_hint: hint });
            });
        }, msUntilRefresh);
    }
}

// Data structures
let tasks = [], projects = ['Работа', 'Личное', 'Учеба'], itemsCount = 0, focusMinsDone = 0, dailyGoalMins = 120, sortCol = null, sortAsc = true;
const prioWeight = { 'TOP 3': 1, 'High': 2, 'Moderate': 3, 'Low': 4 };
const projColors = ['#283593', '#00695c', '#4527a0', '#37474f', '#c62828', '#1565c0', '#2e7d32', '#ad1457', '#ef6c00', '#6d4c41'];
function getProjColor(str) {
    if(!str) return '#333333';
    let h = 0; for(let i=0; i<str.length; i++) h += str.charCodeAt(i);
    return projColors[h % projColors.length];
}

function checkDailyReset() {
    const currentDateStr = new Date().toDateString();
    const savedDate = localStorage.getItem('focusflow_date_sync');
    if (savedDate !== currentDateStr) {
        itemsCount = 0; focusMinsDone = 0;
        localStorage.setItem('focusflow_date_sync', currentDateStr); saveStats(); updateChestUI();
    } else {
        itemsCount = parseInt(localStorage.getItem('focusflow_v29_items')) || 0;
        focusMinsDone = parseInt(localStorage.getItem('focusflow_v29_mins')) || 0;
    }
}

function updateChestUI() {
    const ic = document.getElementById('itemsChest');
    if(ic) ic.textContent = `${itemsCount} сессий 🍅 | ${focusMinsDone} / ${dailyGoalMins} мин`;
}

try {
    let pTasks = JSON.parse(localStorage.getItem('focusflow_v28_tasks'));
    tasks = Array.isArray(pTasks) ? pTasks.filter(t => t && typeof t === 'object') : [];
    let pProj = JSON.parse(localStorage.getItem('focusflow_v28_projects'));
    projects = Array.isArray(pProj) ? pProj : ['Работа', 'Личное', 'Учеба'];
    dailyGoalMins = parseInt(localStorage.getItem('focusflow_v29_goal')) || 120;
    checkDailyReset(); 
    tasks = tasks.filter(t => !(t.done && t.completedAt && (Date.now() - t.completedAt) >= 30 * 24 * 60 * 60 * 1000));
} catch(e) {}

const dailyGoalInput = document.getElementById('dailyGoalInput');
if(dailyGoalInput) dailyGoalInput.value = dailyGoalMins;

function saveTasks() { try { localStorage.setItem('focusflow_v28_tasks', JSON.stringify(tasks)); } catch(e){} scheduleDriveSync(); }
function saveProjects() { try { localStorage.setItem('focusflow_v28_projects', JSON.stringify(projects)); } catch(e){} scheduleDriveSync(); }
function saveStats() { try { localStorage.setItem('focusflow_v29_items', itemsCount); localStorage.setItem('focusflow_v29_mins', focusMinsDone); localStorage.setItem('focusflow_v29_goal', dailyGoalInput.value); } catch(e){} }

const bindModal = (btnId, modalId, closeId) => {
    const m = document.getElementById(modalId);
    if(document.getElementById(btnId)) document.getElementById(btnId).addEventListener('click', () => { if(m) { m.style.display = 'flex'; if(modalId==='widgetsModal') updateWidgetsUI(); }});
    if(document.getElementById(closeId)) document.getElementById(closeId).addEventListener('click', () => { if(m) m.style.display = 'none'; });
};
bindModal('btnOpenAddTask', 'addTaskModal', 'btnCloseAddTask');
bindModal('btnOpenProjectManager', 'projectModal', 'btnCloseProjectManager');
bindModal('btnOpenTrash', 'trashModal', 'btnCloseTrash');
bindModal('btnOpenWidgets', 'widgetsModal', 'btnCloseWidgets');

if(document.getElementById('btnForceLogin')) document.getElementById('btnForceLogin').addEventListener('click', () => {
    if (typeof gapi === 'undefined' || !gapi.client || !tokenClient) return alert("Подождите, Google ещё загружается...");
    document.getElementById('btnForceLogin').textContent = '⏳ Ожидание Google...';
    tokenClient.requestAccessToken({ prompt: 'select_account' });
});

window.gapiLoaded = function() { gapi.load('client', async () => { await gapi.client.init({ apiKey: API_KEY, discoveryDocs: DISCOVERY_DOCS }); gapiInited = true; tryRestoreSession(); }); };
window.gisLoaded = function() {
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: onTokenReceived, prompt: '' });
    gisInited = true;
    google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onOneTapCredential, auto_select: true, cancel_on_tap_outside: false, context: 'signin' });
    tryRestoreSession();
};

async function onOneTapCredential(response) {
    if (!response.credential) return;
    try {
        const payload = JSON.parse(atob(response.credential.split('.')[1]));
        const profile = { name: payload.name, email: payload.email, picture: payload.picture, given_name: payload.given_name };
        renderUserUI(profile);
        localStorage.setItem('focusflow_login_hint', profile.email);
    } catch(e) {}
    if (tokenClient && gapiInited) tokenClient.requestAccessToken({ prompt: '', login_hint: localStorage.getItem('focusflow_login_hint') || '' });
}

async function tryRestoreSession() {
    if (!gapiInited || !gisInited) return;
    const savedToken  = localStorage.getItem('focusflow_access_token');
    const savedExpiry = parseInt(localStorage.getItem('focusflow_token_expiry') || '0');
    const savedHint   = localStorage.getItem('focusflow_login_hint');
    
    try { const p = JSON.parse(localStorage.getItem('focusflow_user_profile') || 'null'); if (p) renderUserUI(p); } catch(e) {}

    if (savedToken && savedExpiry > Date.now() + 60000) {
        gapi.client.setToken({ access_token: savedToken });
        if(authBanner) authBanner.style.display = 'none';
        if(statusInd) { statusInd.style.display = 'inline'; statusInd.textContent = '☁️ (синхр...)'; }
        await initDriveSync(); scheduleTokenRefresh(savedExpiry);
    } else if (savedHint) {
        if(authBanner) authBanner.style.display = 'none';
        if(statusInd) { statusInd.style.display = 'inline'; statusInd.textContent = '☁️ (вход...)'; }
        google.accounts.id.prompt((n) => { if (n.isNotDisplayed() || n.isSkippedMoment()) tokenClient.requestAccessToken({ prompt: '', login_hint: savedHint }); });
    } else {
        if(authBanner) authBanner.style.display = 'flex';
    }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cloudFileId && driveToken()) pullFromDrive(); });

// Drive Sync
function scheduleDriveSync() {
    if (!driveToken()) return;
    if(statusInd) { statusInd.textContent = '☁️ (изменено...)'; statusInd.classList.remove('synced', 'error'); statusInd.classList.add('syncing'); }
    if(cloudSyncTimeout) clearTimeout(cloudSyncTimeout);
    cloudSyncTimeout = setTimeout(() => { pushToDrive(); }, 2000);
}

function driveToken() { return (typeof gapi !== 'undefined' && gapi.client) ? (gapi.client.getToken()?.access_token || null) : null; }

let _refreshing = false, _refreshQueue = [];
async function apiFetch(url, opts = {}) {
    const doFetch = async () => fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + driveToken(), ...(opts.headers || {}) } });
    let res = await doFetch();
    if (res.status === 401) { await refreshTokenNow(); res = await doFetch(); }
    return res;
}

function refreshTokenNow() {
    if (_refreshing) return new Promise(resolve => _refreshQueue.push(resolve));
    _refreshing = true;
    return new Promise((resolve) => {
        if (!tokenClient) { _refreshing = false; resolve(); return; }
        const origCallback = tokenClient.callback;
        tokenClient.callback = (resp) => {
            tokenClient.callback = origCallback; _refreshing = false;
            if (!resp.error) {
                const expiry = Date.now() + ((resp.expires_in || 3600) * 1000);
                gapi.client.setToken({ access_token: resp.access_token });
                try { localStorage.setItem('focusflow_access_token', resp.access_token); localStorage.setItem('focusflow_token_expiry', expiry.toString()); } catch(e) {}
                scheduleTokenRefresh(expiry);
            }
            resolve(); _refreshQueue.forEach(r => r()); _refreshQueue = [];
        };
        tokenClient.requestAccessToken({ prompt: '', login_hint: localStorage.getItem('focusflow_login_hint') || '' });
    });
}

async function initDriveSync() {
    if (!driveToken()) return;
    try {
        if(statusInd) { statusInd.textContent = '☁️ (синхр...)'; statusInd.classList.remove('synced','error'); }
        const res = await apiFetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=' + encodeURIComponent("name='focusflow_data.json' and trashed=false") + '&fields=files(id)');
        if (!res.ok) throw new Error('list HTTP ' + res.status);
        const data = await res.json();
        if (data.files && data.files.length > 0) { cloudFileId = data.files[0].id; await pullFromDrive(); } else { await pushToDrive(); }
    } catch(e) { if(statusInd) { statusInd.textContent = '☁️ Ошибка: ' + e.message.slice(0,50); statusInd.classList.add('error'); } }
}

async function pullFromDrive() {
    if (!cloudFileId || !driveToken()) return;
    try {
        const res = await apiFetch('https://www.googleapis.com/drive/v3/files/' + cloudFileId + '?alt=media');
        if (!res.ok) throw new Error('get HTTP ' + res.status);
        const data = await res.json();
        if (data && Array.isArray(data.tasks)) {
            tasks = data.tasks; projects = Array.isArray(data.projects) ? data.projects : ['Работа','Личное','Учеба'];
            try { localStorage.setItem('focusflow_v28_tasks', JSON.stringify(tasks)); localStorage.setItem('focusflow_v28_projects', JSON.stringify(projects)); } catch(e){}
            renderProjectsUI(); renderTasks();
            if(statusInd) { statusInd.textContent = '☁️ Синхронизировано'; statusInd.classList.remove('syncing','error'); statusInd.classList.add('synced'); }
        }
    } catch(e) {}
}

async function pushToDrive(showSuccess = false) {
    if (!driveToken()) return;
    const body = JSON.stringify({ timestamp: Date.now(), tasks, projects });
    try {
        if(statusInd) statusInd.textContent = '☁️ (отправка...)';
        if (!cloudFileId) {
            const boundary = 'ff_b_' + Date.now();
            const meta = JSON.stringify({ name: 'focusflow_data.json', parents: ['appDataFolder'], mimeType: 'application/json' });
            const mp = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
            const res = await apiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: mp });
            if (!res.ok) throw new Error('create HTTP ' + res.status);
            cloudFileId = (await res.json()).id;
        } else {
            const res = await apiFetch('https://www.googleapis.com/upload/drive/v3/files/' + cloudFileId + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
            if (!res.ok) throw new Error('patch HTTP ' + res.status);
        }
        if(statusInd) { statusInd.textContent = '☁️ Синхронизировано'; statusInd.classList.remove('syncing','error'); statusInd.classList.add('synced'); }
        if(showSuccess) alert('✅ Сохранено в Google Drive!');
    } catch(e) {}
}

async function triggerCalendarSync(showSuccessAlert = false) {
    if (!driveToken()) return;
    const allToSync = tasks.filter(t => t && t.needsSync && !t.done);
    if (allToSync.length === 0) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let successCount = 0;
    for (let t of allToSync) {
        if (!t.deadline) { t.needsSync = false; continue; }
        const startDate = new Date(t.deadline), endDate = new Date(startDate.getTime() + 10 * 60000);
        const desc = [`Проект: ${t.project || 'Нет'}`, `Приоритет: ${t.priority}`, t.comment ? `Комментарий: ${t.comment}` : ''].filter(Boolean).join('\n');
        const payload = { summary: t.name, description: desc, start: { dateTime: startDate.toISOString(), timeZone: tz }, end: { dateTime: endDate.toISOString(), timeZone: tz }, reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } };
        try {
            if (t.googleEventId) {
                const res = await apiFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${t.googleEventId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (res.status === 404 || res.status === 410) t.googleEventId = null; else if (res.ok) { t.needsSync = false; successCount++; }
            }
            if (!t.googleEventId) {
                const res = await apiFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (res.ok) { t.googleEventId = (await res.json()).id; t.needsSync = false; successCount++; }
            }
        } catch(err) {}
    }
    saveTasks();
    if (showSuccessAlert && successCount > 0) alert(`✅ Добавлено в Google Календарь: ${successCount} событий!`);
}

function requestNotificationPermission() { if (window.Notification && Notification.permission !== "granted" && Notification.permission !== "denied") Notification.requestPermission(); }
function playNotificationSound() {
    try {
        if (audioCtx && audioCtx.state === 'running') {
            const now = audioCtx.currentTime, osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
            osc.type = 'sine'; osc.frequency.setValueAtTime(880, now); osc.frequency.setValueAtTime(1109.7, now + 0.12);
            gain.gain.setValueAtTime(0.6, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
            osc.connect(gain); gain.connect(audioCtx.destination); osc.start(now); osc.stop(now + 0.45);
        }
    } catch(e) {}
}
function triggerNotification(title, body) {
    playNotificationSound();
    if (window.Notification && Notification.permission === "granted") try { new Notification(title, { body: body }); } catch (e) {}
}
function checkDeadlines() {
    const now = new Date(); let updated = false;
    tasks.forEach(t => { 
        if (!t.done && t.deadline && !t.notified) { 
            if (now >= new Date(t.deadline)) { triggerNotification("⏱️ Дедлайн наступил!", t.name); t.notified = true; updated = true; } 
        } 
    });
    if (updated) saveTasks(); 
}
setInterval(checkDeadlines, 10000);

function getSortedTasks() {
    if (!sortCol || sortCol === 'none') return tasks;
    return [...tasks].sort((a, b) => {
        let valA, valB;
        if (sortCol === 'name') { valA = (a.name || '').toLowerCase(); valB = (b.name || '').toLowerCase(); }
        else if (sortCol === 'priority') { valA = prioWeight[a.priority] || 9; valB = prioWeight[b.priority] || 9; }
        else if (sortCol === 'project') { valA = (a.project || '').toLowerCase(); valB = (b.project || '').toLowerCase(); }
        else if (sortCol === 'deadline') { valA = a.deadline ? new Date(a.deadline).getTime() : Infinity; valB = b.deadline ? new Date(b.deadline).getTime() : Infinity; }
        if (valA < valB) return sortAsc ? -1 : 1; if (valA > valB) return sortAsc ? 1 : -1; return 0;
    });
}
function getPriorityOptions(current) { return ['TOP 3', 'High', 'Moderate', 'Low'].map(p => `<option value="${p}" ${p===current?'selected':''}>${p}</option>`).join(''); }

window.updateTaskField = (id, field, value) => { const t = tasks.find(x => x.id === id); if(t) { t[field] = value; if (field === 'deadline') t.notified = false; t.needsSync = true; saveTasks(); triggerCalendarSync(); } };
window.toggleTaskStatus = id => { const t = tasks.find(x => x.id === id); if(t) { t.done = !t.done; t.completedAt = t.done ? Date.now() : null; t.needsSync = true; saveTasks(); renderTasks(); triggerCalendarSync(); } };
window.deleteTask = async id => {
    const t = tasks.find(x => x.id === id);
    if (t && t.googleEventId && driveToken()) try { await apiFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${t.googleEventId}`, { method: 'DELETE' }); } catch(e) {}
    tasks = tasks.filter(x => x.id !== id); saveTasks(); renderTasks();
};

function renderTasks() {
    const taskListContainer = document.getElementById('taskListContainer'), trashListContainer = document.getElementById('trashListContainer'), trashBadgeCount = document.getElementById('trashBadgeCount');
    if(!taskListContainer || !trashListContainer) return;
    taskListContainer.innerHTML = ''; trashListContainer.innerHTML = '';
    const sorted = getSortedTasks(), activeTasks = sorted.filter(t => t && !t.done), trashTasks = tasks.filter(t => t && t.done);
    if(trashBadgeCount) trashBadgeCount.textContent = trashTasks.length;

    if (activeTasks.length === 0) {
        taskListContainer.innerHTML = '<div style="text-align:center; padding: 40px; color: var(--text-secondary);">Нет активных задач. Наслаждайся тишиной! 🎉</div>';
    } else {
        activeTasks.forEach(task => {
            const row = document.createElement('div'); row.className = 'task-row'; row.setAttribute('data-id', task.id);
            let prioC = task.priority === 'TOP 3' ? 'prio-top-3' : task.priority === 'High' ? 'prio-high' : task.priority === 'Moderate' ? 'prio-moderate' : 'prio-low';
            let ov = task.deadline && new Date() > new Date(task.deadline);
            row.innerHTML = `
                <div class="col-drag drag-handle" title="Перетащить (Сбрасывает сортировку)">☰</div>
                <div class="col-done"><div class="custom-checkbox" onclick="toggleTaskStatus(${task.id})"></div></div>
                <div class="col-name"><input type="text" class="inline-input" value="${task.name}" onchange="updateTaskField(${task.id}, 'name', this.value)" placeholder="Название задачи..."></div>
                <div class="col-prio"><select class="inline-select badge-priority ${prioC}" onchange="updateTaskField(${task.id}, 'priority', this.value); renderTasks();">${getPriorityOptions(task.priority)}</select></div>
                <div class="col-proj">
                    <select class="inline-select" style="background-color: ${getProjColor(task.project)};" onchange="updateTaskField(${task.id}, 'project', this.value); renderTasks();">
                        <option value="" style="background:#2d2d2d;">Без проекта</option>
                        ${projects.map(p => `<option value="${p}" style="background:${getProjColor(p)};" ${p===task.project?'selected':''}>${p}</option>`).join('')}
                    </select>
                </div>
                <div class="col-dead"><input type="datetime-local" class="inline-input inline-deadline ${ov ? 'overdue-input' : ''}" value="${task.deadline || ''}" onchange="updateTaskField(${task.id}, 'deadline', this.value); renderTasks();" style="${ov ? 'color: var(--prio-high-text) !important;' : ''}"></div>
                <div class="col-comm"><input type="text" class="inline-input" value="${task.comment || ''}" onchange="updateTaskField(${task.id}, 'comment', this.value)" placeholder="Коммент..."></div>
                <div class="col-del"><button class="btn-delete-task" onclick="deleteTask(${task.id})">✕</button></div>
            `;
            row.draggable = true; row.addEventListener('dragstart', handleDragStart); row.addEventListener('dragover', e=>e.preventDefault());
            row.addEventListener('drop', handleDrop); row.addEventListener('dragend', () => row.classList.remove('dragging'));
            taskListContainer.appendChild(row);
        });
    }
    
    trashTasks.forEach(task => {
        const row = document.createElement('div'); row.className = 'task-row completed-row'; row.style.borderLeft = '3px solid var(--text-disabled)';
        let daysLeft = Math.max(1, 30 - Math.floor((Date.now() - (task.completedAt || Date.now())) / 86400000));
        row.innerHTML = `
            <div class="col-drag"></div>
            <div class="col-done"><div class="custom-checkbox checked" onclick="toggleTaskStatus(${task.id})"></div></div>
            <div class="col-name"><input type="text" class="inline-input" value="${task.name}" disabled></div>
            <div class="col-prio"><span class="badge-priority" style="opacity:0.5; font-size:12px;">${task.priority}</span></div>
            <div class="col-proj">${task.project ? `<span style="background:${getProjColor(task.project)}; padding:4px 8px; border-radius:6px; font-size:11px; opacity:0.5;">${task.project}</span>` : ''}</div>
            <div class="col-dead" style="font-size:12px; color:var(--prio-high-text);">~${daysLeft} дн.</div>
            <div class="col-comm" style="opacity:0.5;"><input type="text" class="inline-input" value="${task.comment || ''}" disabled></div>
            <div class="col-del"><button class="btn-delete-task" onclick="deleteTask(${task.id})">✕</button></div>
        `;
        trashListContainer.appendChild(row);
    });
    updateChestUI();
    updateWidgetsUI();
}

let draggedId = null, dragEl = null;
function handleDragStart(e) { if(sortCol && sortCol !== 'none') { e.preventDefault(); return; } draggedId = parseInt(this.getAttribute('data-id')); dragEl = this; setTimeout(() => this.classList.add('dragging'), 0); }
function handleDrop(e) { e.stopPropagation(); this.classList.remove('drag-over'); if (dragEl !== this) { const targetId = parseInt(this.getAttribute('data-id')); const fromIdx = tasks.findIndex(t => t.id === draggedId); const toIdx = tasks.findIndex(t => t.id === targetId); if (fromIdx !== -1 && toIdx !== -1) { const [moved] = tasks.splice(fromIdx, 1); tasks.splice(toIdx, 0, moved); sortCol = 'none'; saveTasks(); renderTasks(); } } }
document.querySelectorAll('.sortable').forEach(header => { header.addEventListener('click', () => { const col = header.getAttribute('data-sort'); if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; } renderTasks(); }); });
const msSelect = document.getElementById('mobileSortSelect'); if(msSelect) msSelect.addEventListener('change', (e) => { sortCol = e.target.value; sortAsc = true; renderTasks(); });

document.getElementById('btnCreate')?.addEventListener('click', () => {
    requestNotificationPermission(); 
    const n = document.getElementById('taskName'), p = document.getElementById('taskPriority'), c = document.getElementById('taskComment'), d = document.getElementById('taskDeadline'), pr = document.getElementById('taskProject');
    if (!n || !n.value.trim()) return;
    tasks.push({ id: Date.now(), name: n.value.trim(), done: false, priority: p.value, project: pr.value, comment: c.value.trim(), deadline: d.value, notified: false, googleEventId: null, needsSync: true });
    saveTasks(); renderTasks(); n.value = ''; c.value = ''; d.value = ''; 
    document.getElementById('addTaskModal').style.display = 'none';
    triggerCalendarSync();
});

function renderProjectsUI() { 
    const projectSelect = document.getElementById('taskProject'); if(!projectSelect) return; projectSelect.innerHTML = '';
    const mpl = document.getElementById('manageProjectsList'); if(mpl) mpl.innerHTML = ''; 
    projects.forEach(p => { 
        const op = document.createElement('option'); op.value = p; op.textContent = p; projectSelect.appendChild(op); 
        if(mpl) mpl.innerHTML += `<div style="display:flex; justify-content:space-between; margin-bottom: 8px; padding:12px; background:var(--bg-surface-variant); border-radius:8px;"><span style="border-left: 4px solid ${getProjColor(p)}; padding-left: 8px;">${p}</span><button class="btn-delete-task" onclick="removeProj('${p}')">✕</button></div>`;
    }); 
}
window.removeProj = p => { projects = projects.filter(x => x !== p); saveProjects(); renderProjectsUI(); renderTasks(); };
document.getElementById('btnAddProject')?.addEventListener('click', () => { const inp = document.getElementById('newProjectName'); if(!inp || !inp.value.trim() || projects.includes(inp.value.trim())) return; projects.push(inp.value.trim()); saveProjects(); renderProjectsUI(); document.getElementById('taskProject').value = inp.value.trim(); inp.value = ''; });

// POMODORO & WIDGETS
let timerInt = null, isRunning = false, timeLeft = 25 * 60, isFocus = true;
const clockDisplay = document.getElementById('pomoClock'), statusPill = document.getElementById('pomoStatus');
const focusInput = document.getElementById('focusTimeInput'), breakInput = document.getElementById('breakTimeInput');

if(dailyGoalInput) dailyGoalInput.addEventListener('change', () => { dailyGoalMins = parseInt(dailyGoalInput.value) || 120; saveStats(); updateChestUI(); updateWidgetsUI(); });

function updClock() { 
    if(!clockDisplay) return; clockDisplay.textContent = `${Math.floor(timeLeft / 60).toString().padStart(2, '0')}:${(timeLeft % 60).toString().padStart(2, '0')}`; 
    const progressBar = document.getElementById('pomoProgressBar');
    if(progressBar) { 
        let totalS = (isFocus ? parseInt(focusInput.value)||25 : parseInt(breakInput.value)||5) * 60;
        const perc = Math.min(100, ((focusMinsDone * 60 + (isFocus && isRunning ? (totalS - timeLeft) : 0)) / (dailyGoalMins * 60)) * 100); 
        progressBar.style.width = `${perc}%`;
    }
    updateWidgetsUI();
}
function resetTimer() { if(!isRunning){ timeLeft = (isFocus ? parseInt(focusInput.value)||25 : parseInt(breakInput.value)||5) * 60; updClock(); } }
[focusInput, breakInput].forEach(inp => inp?.addEventListener('input', () => resetTimer() ));

const btnStart = document.getElementById('pomoStartBtn'), btnPause = document.getElementById('pomoPauseBtn'), btnReset = document.getElementById('pomoResetBtn');
btnStart?.addEventListener('click', function() {
    if(isRunning) return; isRunning = true; this.style.display = 'none'; document.getElementById('pomoPauseBtn').style.display = 'flex'; 
    startAudioEngine(document.getElementById('audioNoiseSelect')?.value || 'none');
    timerInt = setInterval(() => {
        if(timeLeft > 0) { timeLeft--; updClock(); } 
        else {
            clearInterval(timerInt); isRunning = false; btnStart.style.display = 'flex'; btnPause.style.display = 'none'; stopAudioEngine();
            if(isFocus) { checkDailyReset(); itemsCount++; focusMinsDone += parseInt(focusInput.value) || 25; saveStats(); updateChestUI(); triggerNotification("🍅 Фокус завершен!", "Время сделать перерыв."); isFocus = false; if(statusPill){ statusPill.textContent = 'Отдых'; } } 
            else { triggerNotification("🟢 Отдых завершен!", "Пора за работу."); isFocus = true; if(statusPill){ statusPill.textContent = 'Фокус'; } }
            resetTimer(); renderTasks();
        }
    }, 1000);
});
btnPause?.addEventListener('click', function() { clearInterval(timerInt); isRunning = false; btnStart.style.display = 'flex'; this.style.display = 'none'; stopAudioEngine(); });
btnReset?.addEventListener('click', () => { clearInterval(timerInt); isRunning = false; isFocus = true; if(btnStart) btnStart.style.display = 'flex'; if(btnPause) btnPause.style.display = 'none'; if(statusPill) statusPill.textContent = 'Фокус'; resetTimer(); stopAudioEngine(); });

// AUDIO GENRES (50 Tracks!)
const AUDIO_GENRES = [
    { id: 'lofi_beat', name: 'Lo-Fi Chill', baseBpm: 80, group: '🎵 Биты для фокуса', vars: 10 },
    { id: 'minimal_tech', name: 'Deep Tech', baseBpm: 120, group: '🎵 Биты для фокуса', vars: 9 },
    { id: 'binaural_alpha_10', name: 'Alpha Flow 10Hz', baseBpm: 100, group: '🧠 Flow State', vars: 8 },
    { id: 'binaural_gamma_40', name: 'Gamma 40Hz Drive', baseBpm: 140, group: '🧠 Deep Work', vars: 8 },
    { id: 'binaural_theta_6', name: 'Theta Zen 6Hz', baseBpm: 70, group: '🧘 Meditation', vars: 8 },
    { id: 'brown_noise', name: 'Brown Noise', baseBpm: null, group: '🧘 Ambient Textures', vars: 7 }
];

function renderAudioSelect() {
    const sel = document.getElementById('audioNoiseSelect'); if (!sel) return;
    let html = '<option value="none">Без звука</option>';
    AUDIO_GENRES.forEach(g => {
        html += `<optgroup label="${g.group}">`;
        for(let i=0; i<g.vars; i++) html += `<option value="${g.id}__var${i}">${g.name} v.${i+1}${g.baseBpm ? ` (${g.baseBpm + i*3} BPM)` : ''}</option>`;
        html += `</optgroup>`;
    });
    sel.innerHTML = html;
}
document.getElementById('audioNoiseSelect')?.addEventListener('change', e => { if(isRunning) startAudioEngine(e.target.value); });

let audioCtx = null, sequenceId = null, activeNodes = [];
function stopAudioEngine() { if (sequenceId) { clearInterval(sequenceId); sequenceId = null; } activeNodes.forEach(n => { try { n.stop(); } catch(e){} }); activeNodes = []; if (audioCtx) { try { audioCtx.close(); } catch(e){} audioCtx = null; } }

function startAudioEngine(typeRaw) {
    stopAudioEngine(); if (typeRaw === 'none' || !isRunning) return;
    const [type, varStr] = typeRaw.split('__var'); const varIdx = parseInt(varStr || '0');
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    audioCtx = new AC();

    const comp = audioCtx.createDynamicsCompressor(), gainMaster = audioCtx.createGain(); 
    comp.threshold.value = -14; comp.ratio.value = 4; gainMaster.gain.value = 0.82;
    comp.connect(gainMaster); gainMaster.connect(audioCtx.destination);
    
    function makeReverb(secs = 1.8, decay = 2.0, wet = 0.18) {
        const len = audioCtx.sampleRate * secs, buf = audioCtx.createBuffer(2, len, audioCtx.sampleRate);
        for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1-i/len, decay); }
        const conv = audioCtx.createConvolver(); conv.buffer = buf;
        const wg = audioCtx.createGain(); wg.gain.value = wet; const dg = audioCtx.createGain(); dg.gain.value = 1 - wet;
        conv.connect(wg); wg.connect(comp); dg.connect(comp); return { input: conv, dry: dg };
    }
    const keep = n => { activeNodes.push(n); return n; };
    const shiftArr = (arr, val) => arr.map(x => x ? x + val : 0);

    const bpmShift = varIdx * 3, pitchShift = varIdx * 5, wetMod = (varIdx % 3) * 0.05;

    // Primitives
    const kick = (t, freq=72, dec=0.38, vol=0.6) => { const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.setValueAtTime((freq+pitchShift)*3.5, t); o.frequency.exponentialRampToValueAtTime(freq+pitchShift, t+dec*0.35); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t+dec); o.connect(g); g.connect(comp); o.start(t); o.stop(t+dec); keep(o); };
    const hat = (t, vol=0.06, dec=0.045) => { const bs = audioCtx.createBufferSource(); const len = audioCtx.sampleRate*dec; const bb = audioCtx.createBuffer(1,len,audioCtx.sampleRate); const dt = bb.getChannelData(0); for(let i=0;i<len;i++) dt[i]=Math.random()*2-1; bs.buffer=bb; const bf = audioCtx.createBiquadFilter(); bf.type='highpass'; bf.frequency.value=10000; const bg = audioCtx.createGain(); bg.gain.setValueAtTime(vol,t); bg.gain.exponentialRampToValueAtTime(0.001,t+dec); bs.connect(bf); bf.connect(bg); bg.connect(comp); bs.start(t); bs.stop(t+dec); keep(bs); };
    const bass = (t, f, dur, vol) => { if(!f)return; const o = audioCtx.createOscillator(); o.type='triangle'; o.frequency.value=f+pitchShift; const g = audioCtx.createGain(); g.gain.setValueAtTime(vol,t); g.gain.linearRampToValueAtTime(0.001,t+dur); o.connect(g); g.connect(comp); o.start(t); o.stop(t+dur); keep(o); };
    const pad = (t, f, dur, vol, rev) => { if(!f)return; const o1=audioCtx.createOscillator(); o1.type='sine'; o1.frequency.value=f; const g=audioCtx.createGain(); g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+0.2); g.gain.setValueAtTime(vol,t+dur-0.2); g.gain.linearRampToValueAtTime(0,t+dur); o1.connect(g); if(rev){ g.connect(rev.input); g.connect(rev.dry); } else { g.connect(comp); } o1.start(t); o1.stop(t+dur); keep(o1); };

    if (type === 'lofi_beat') {
        const bpm=80+bpmShift, s=60/bpm/4, rev = makeReverb(2.2, 1.8, 0.22 + wetMod);
        const chords = [shiftArr([130.8, 155.6, 196, 233.1], pitchShift), shiftArr([174.6, 207.7, 261.6, 311.1], pitchShift)];
        let step=0;
        sequenceId = setInterval(() => {
            const t = audioCtx.currentTime+0.05, b16 = step%32, beat = b16%16;
            if(beat===0||beat===10) kick(t, 65, 0.35, 0.5);
            if(beat===8) hat(t, 0.2, 0.2); // thick snare-ish hat
            if(beat%2===0) hat(t, 0.08); 
            if(beat===0) chords[b16<16?0:1].forEach((f,i)=>pad(t, f, s*15.5, 0.04, rev));
            step++;
        }, s*1000);
    } else if (type === 'minimal_tech') {
        const bpm=120+bpmShift, s=60/bpm/4;
        let step=0;
        sequenceId = setInterval(() => {
            const t = audioCtx.currentTime+0.05, beat = (step%16);
            if(beat%4===0) kick(t, 55, 0.38, 0.6);
            if(beat%2===1) hat(t, 0.05);
            if(beat%4===2) bass(t, 65.4, s*1.5, 0.2);
            step++;
        }, s*1000);
    } else if (type === 'binaural_alpha_10' || type === 'binaural_theta_6' || type === 'binaural_gamma_40') {
        const freqDiff = type==='binaural_alpha_10'? 10 : (type==='binaural_theta_6'? 6 : 40);
        const bpm=(type==='binaural_gamma_40'?140:100)+bpmShift, s=60/bpm/4;
        const oL = audioCtx.createOscillator(), oR = audioCtx.createOscillator(), m = audioCtx.createChannelMerger(2);
        oL.frequency.value = 200+pitchShift; oR.frequency.value = 200+pitchShift+freqDiff;
        oL.connect(m,0,0); oR.connect(m,0,1); const g=audioCtx.createGain(); g.gain.value=0.05; m.connect(g); g.connect(comp);
        oL.start(); oR.start(); keep(oL); keep(oR);
        let step=0;
        sequenceId = setInterval(() => { const t = audioCtx.currentTime+0.05; if((step%16)===0 && freqDiff>10) kick(t, 60, 0.4, 0.5); step++; }, s*1000);
    } else if (type === 'brown_noise') {
        const buf = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate), data = buf.getChannelData(0);
        let last = 0; for(let i=0; i<audioCtx.sampleRate; i++) { const w = Math.random()*2-1; data[i] = (last = (last + 0.02 * w) / 1.02) * 3; }
        const bs = audioCtx.createBufferSource(); bs.buffer=buf; bs.loop=true;
        const g=audioCtx.createGain(); g.gain.value=0.4 + wetMod; bs.connect(g); g.connect(comp); bs.start(); keep(bs);
    }
}

// iOS WIDGETS LOGIC
function updateWidgetsUI() {
    const totalS = focusMinsDone * 60 + (isFocus && isRunning ? ((parseInt(focusInput?.value)||25)*60 - timeLeft) : 0);
    const tm = Math.floor(totalS / 60);
    if(document.getElementById('mwTime')) document.getElementById('mwTime').textContent = tm;
    if(document.getElementById('mwTasks')) document.getElementById('mwTasks').textContent = tasks.filter(t => t.done).length;
    
    const ring = document.getElementById('mwRing');
    if (ring) {
        const circ = 213.62, perc = Math.min(tm / (dailyGoalMins||0.1), 1);
        ring.style.strokeDashoffset = circ - (perc * circ);
        ring.style.stroke = perc >= 1 ? '#30d158' : '#0a84ff';
    }

    const lwTasks = document.getElementById('lwTasks');
    if(lwTasks) {
        const tops = tasks.filter(t => !t.done).sort((a,b) => (prioWeight[a.priority]||9) - (prioWeight[b.priority]||9)).slice(0, 5);
        lwTasks.innerHTML = tops.map(t => `<div class="w-task-item"><div class="w-task-dot" style="background:${getProjColor(t.project)}"></div><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.name}</span></div>`).join('') || '<div style="opacity:0.5; font-size: 13px; text-align:center; margin-top:20px;">Нет активных задач 😎</div>';
    }
    
    if(document.getElementById('lwStatus') && clockDisplay) document.getElementById('lwStatus').textContent = (isFocus ? "Фокус " : "Отдых ") + clockDisplay.textContent;
    if(document.getElementById('lwDateText')) document.getElementById('lwDateText').textContent = new Date().toLocaleDateString('ru-RU', {weekday: 'short', day: 'numeric', month: 'short'});
}

renderAudioSelect();
renderProjectsUI(); renderTasks(); updClock(); checkDeadlines(); requestNotificationPermission(); updateWidgetsUI();
