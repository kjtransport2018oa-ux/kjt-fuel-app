let sessionToken = null;
let currentUser = null;
let editingUsername = null; // null = creating new user

/* =========================================================================
   API SHIM — จำลอง google.script.run ให้ทำงานผ่าน fetch() ไปยัง Apps Script
   Web App แทน เพื่อให้โค้ดเดิมที่เขียนด้วยแพทเทิร์น
     google.script.run.withSuccessHandler(fn).withFailureHandler(fn).xxx(args)
   ทำงานได้เหมือนเดิมทุกจุด โดยไม่ต้องแก้โค้ดส่วนอื่นเลย
   ========================================================================= */

// แก้เป็น URL เว็บแอป Apps Script ที่ deploy ไว้ (เหมือนเดิม ไม่เปลี่ยน)
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbwCfj9OYb3CZQZLxt0bmxA1fIcsPuP_Djz5yTH00kyFORFcqgNjJQsbeZXUOUlkt5l1/exec';
const API_TIMEOUT_MS_ = 15000; // ถ้าเซิร์ฟเวอร์ไม่ตอบภายใน 15 วิ ถือว่า "ช้าผิดปกติ" ตัดจบไม่ให้ค้างรอไม่มีที่สิ้นสุด
// คำสั่งที่ "ช้าเป็นปกติ" (ส่งข้อมูลทีละร้อยคน + อัปโหลดไฟล์ขึ้น Drive) ต้องให้เวลามากกว่า 15 วิ
// ไม่งั้นจะถูกตัดทิ้งกลางคันทั้งที่ฝั่งเซิร์ฟเวอร์กำลังเขียนข้อมูลอยู่
const API_LONG_TIMEOUT_MS_ = 180000;
const API_LONG_TIMEOUT_FNS_ = ['previewHealthImport', 'confirmHealthImport'];

/** fetch พร้อม timeout — กันปัญหา "เซิร์ฟเวอร์ตอบสนองช้า" ที่ทำให้หน้าเว็บหมุนค้างไม่รู้จบ */
function fetchWithTimeout_(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, Object.assign({}, options, { signal: controller.signal }))
    .finally(function () { clearTimeout(timer); });
}

function callGasApi_(functionName, args) {
  const timeoutMs = API_LONG_TIMEOUT_FNS_.indexOf(functionName) !== -1 ? API_LONG_TIMEOUT_MS_ : API_TIMEOUT_MS_;
  return fetchWithTimeout_(API_BASE_URL, {
    method: 'POST',
    // ใช้ text/plain เพื่อให้เป็น "simple request" เลี่ยง CORS preflight (OPTIONS) ที่ Apps Script รองรับได้ไม่ดี
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: functionName, args: args })
  }, timeoutMs).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

function createScriptRunProxy_(successHandler, failureHandler) {
  return new Proxy({}, {
    get: function (target, prop) {
      if (prop === 'withSuccessHandler') {
        return function (fn) { return createScriptRunProxy_(fn, failureHandler); };
      }
      if (prop === 'withFailureHandler') {
        return function (fn) { return createScriptRunProxy_(successHandler, fn); };
      }
      // การเรียกฟังก์ชันจริง เช่น .loginUser(u, p) — ยิง fetch ไปที่ Apps Script
      return function () {
        const args = Array.prototype.slice.call(arguments);
        callGasApi_(String(prop), args)
          .then(function (result) { if (successHandler) successHandler(result); })
          .catch(function (err) {
            if (failureHandler) failureHandler(err);
            else console.error('API error (' + String(prop) + '):', err);
          });
      };
    }
  });
}

window.google = window.google || {};
window.google.script = window.google.script || {};
Object.defineProperty(window.google.script, 'run', {
  get: function () { return createScriptRunProxy_(null, null); }
});

/* =========================================================================
   OFFLINE QUEUE — บันทึกการเติมน้ำมันไว้ใน localStorage ชั่วคราว
   เผื่อกรณี Google Sheets/Apps Script ล่ม, เน็ตหลุด, หรือตอบสนองช้าผิดปกติ
   ตอนนี้ครอบคลุมเฉพาะ "บันทึกการเติมน้ำมัน" (submitFuelLog) ซึ่งเป็นจุดเสี่ยงหน้างานที่สุด
   ที่เขียนเป็นระบบกลางแบบนี้เพื่อให้ต่อยอดครอบคลุม action อื่นได้ในอนาคตถ้าต้องการ
   ========================================================================= */
const OFFLINE_QUEUE_KEY_ = 'kjtHub_offlineFuelQueue_v1';
let offlineSyncInFlight_ = false;

function genClientRequestId_() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'cid-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function loadOfflineQueue_() {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY_);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function saveOfflineQueue_(queue) {
  try { localStorage.setItem(OFFLINE_QUEUE_KEY_, JSON.stringify(queue)); } catch (e) { /* localStorage เต็ม/ถูกปิด — ไม่ critical แค่จะไม่รอด browser ปิด */ }
}

function queueFuelLogOffline_(payload) {
  const queue = loadOfflineQueue_();
  queue.push({
    clientRequestId: payload.clientRequestId,
    payload: payload,
    queuedAt: new Date().toISOString(),
    // เก็บชื่อคนที่คีย์จริง ณ ตอนนั้นไว้ด้วย — กันเวลาเครื่องเดียวกันสลับกันใช้หลายคน (เช่น เปลี่ยนกะ)
    // แล้วอีกคน login ทับก่อนจะ sync จะได้ไม่ยิงข้อมูลออกไปในนามคนที่ login อยู่ปัจจุบันผิดคน
    queuedByUsername: currentUser ? currentUser.username : null
  });
  saveOfflineQueue_(queue);
  renderOfflineBanner_();
}

function removeFromOfflineQueue_(clientRequestId) {
  const queue = loadOfflineQueue_().filter(function (item) { return item.clientRequestId !== clientRequestId; });
  saveOfflineQueue_(queue);
  renderOfflineBanner_();
}

/** วาดแถบเตือนเหลือง — แสดงเฉพาะตอนมีรายการค้างซิงค์เท่านั้น ไม่มีก็ไม่โชว์อะไรเลย
 *  แยกนับรายการของ "ผู้ใช้ปัจจุบัน" กับ "ผู้ใช้อื่นที่ค้างจากรอบก่อน" (กรณีเครื่องเดียวกันสลับกันใช้หลายคน) */
function renderOfflineBanner_() {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;
  const queue = loadOfflineQueue_();
  if (queue.length === 0) { banner.classList.remove('show'); banner.innerHTML = ''; return; }

  const myUsername = currentUser ? currentUser.username : null;
  const mine = queue.filter(function (item) { return !item.queuedByUsername || item.queuedByUsername === myUsername; });
  const others = queue.length - mine.length;

  banner.classList.add('show');
  let text = '⚠ กำลังบันทึกแบบออฟไลน์ รอซิงค์ข้อมูล (' + mine.length + ' รายการ)';
  if (others > 0) text += ' และมีอีก ' + others + ' รายการจากผู้ใช้อื่นที่ค้างอยู่ในเครื่องนี้';

  banner.innerHTML =
    '<span class="offline-banner-text">' + text + '</span>' +
    (mine.length > 0 ? '<button type="button" class="offline-banner-btn" onclick="trySyncOfflineQueue_(true)">ซิงค์ตอนนี้</button>' : '');
}

/** ส่งข้อมูลที่ค้างอยู่เข้า Google Sheets ทีละรายการตามลำดับที่บันทึกไว้ (กันข้อมูลสลับลำดับ)
 *  ฝั่ง Code.gs มีการเช็ค clientRequestId ซ้ำให้แล้ว ต่อให้ sync ซ้ำ 2 รอบก็จะไม่มีข้อมูลซ้ำเข้าชีท
 *  sync เฉพาะรายการที่ "ผู้ใช้ปัจจุบัน" เป็นคนคีย์ไว้เองเท่านั้น — ถ้าเครื่องเดียวกันมีรายการค้างจากคนอื่น
 *  (เช่น สลับกะกันใช้เครื่อง) จะข้ามไปก่อน ไม่ยิงออกไปในนามคนที่ login อยู่ตอนนี้ผิดคน */
function trySyncOfflineQueue_(manual) {
  if (offlineSyncInFlight_) return;
  const queue = loadOfflineQueue_();
  if (queue.length === 0) { if (manual) showToast('ไม่มีรายการค้างซิงค์'); return; }
  if (!sessionToken || !currentUser) { if (manual) showToast('กรุณาเข้าสู่ระบบก่อนซิงค์ข้อมูล', true); return; } // ยังไม่ login — รอรอบถัดไปหลัง login สำเร็จ ไม่ตัดคิวทิ้ง
  if (!navigator.onLine) { if (manual) showToast('อุปกรณ์ยังไม่ได้เชื่อมต่ออินเทอร์เน็ต', true); return; }

  const item = queue.find(function (it) { return !it.queuedByUsername || it.queuedByUsername === currentUser.username; });
  if (!item) {
    if (manual) showToast('รายการที่ค้างอยู่เป็นของผู้ใช้อื่น กรุณาเข้าสู่ระบบด้วยบัญชีนั้นเพื่อซิงค์', true);
    return;
  }

  offlineSyncInFlight_ = true;

  callGasApi_('submitFuelLog', [sessionToken, item.payload])
    .then(function (res) {
      offlineSyncInFlight_ = false;
      if (res && res.success) {
        removeFromOfflineQueue_(item.clientRequestId);
        showToast('ซิงค์ข้อมูลออฟไลน์สำเร็จ' + (loadOfflineQueue_().length ? ' (เหลืออีก ' + loadOfflineQueue_().length + ' รายการ)' : ''));
        trySyncOfflineQueue_(false); // มีคิวต่อ ให้ทยอยส่งต่อทันที
      } else if (res && res.message && res.message.indexOf('เซสชันหมดอายุ') !== -1) {
        // session หมดอายุระหว่างที่ข้อมูลค้างอยู่ในคิว — ไม่ใช่ข้อมูลผิด ห้ามลบทิ้ง ให้รอ login ใหม่แล้วค่อยลองอีกครั้ง
        if (manual) showToast('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่ก่อนซิงค์ข้อมูลที่ค้างอยู่', true);
      } else {
        // เซิร์ฟเวอร์ตอบกลับมาแล้วแต่ไม่สำเร็จจริง (เช่น validation ไม่ผ่าน) — ไม่ใช่ปัญหาเน็ต ต้องเอาออกจากคิว
        // ไม่งั้นจะวนซิงค์ซ้ำรายการที่ไม่มีทางสำเร็จไปเรื่อยๆ
        removeFromOfflineQueue_(item.clientRequestId);
        showToast('ข้อมูลออฟไลน์ 1 รายการซิงค์ไม่ผ่าน กรุณาตรวจสอบและคีย์ใหม่: ' + (res && res.message ? res.message : 'ไม่ทราบสาเหตุ'), true);
        trySyncOfflineQueue_(false);
      }
    })
    .catch(function () {
      offlineSyncInFlight_ = false;
      // ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้เหมือนเดิม — ปล่อยคิวไว้ก่อน รอรอบถัดไปจาก auto-sync
      if (manual) showToast('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้งภายหลัง', true);
    });
}

window.addEventListener('online', function () { trySyncOfflineQueue_(false); });
setInterval(function () { if (navigator.onLine) trySyncOfflineQueue_(false); }, 30000); // เผื่อกรณี browser ไม่ยิง event 'online' ตรงๆ (บาง Android WebView)

/* =========================================================================
   PUSH NOTIFICATION (Phase 4) — Firebase Cloud Messaging
   แจ้งเตือนช่างทันทีที่มีงานแจ้งซ่อมใหม่เข้า (สีแดง = แจ้งแบบสำคัญ) และแจ้งคนขับทันทีที่รถซ่อมเสร็จ
   ทำงานผ่าน Firebase SDK (โหลดจาก CDN ใน index.html) + Service Worker เดิม (sw.js) ที่เพิ่ม Firebase Messaging เข้าไป
   ========================================================================= */
const MAINT_FCM_CONFIG_ = {
  apiKey: 'AIzaSyA2JMm1AY4kh_tt9--4d6_trgjOAm-a6iA',
  authDomain: 'kjt-hub.firebaseapp.com',
  projectId: 'kjt-hub',
  storageBucket: 'kjt-hub.firebasestorage.app',
  messagingSenderId: '101679191796',
  appId: '1:101679191796:web:f0c3e3c8ce78f2bb74b0a1'
};
const MAINT_VAPID_KEY_ = 'BJMCMZzRckMVkd-x-wyiRsaYq8ceT5KsmImzc59NOy47aQSgpp8GBMM2QG4SS4cxyX30IyPy74jxUp03_l0edqw';
const MAINT_FCM_TOKEN_KEY_ = 'kjtHub_fcmToken_v1'; // เก็บ token ปัจจุบันไว้ในเครื่อง เผื่อต้องถอนตอน logout

/** ขอสิทธิ์แจ้งเตือน + ลงทะเบียน FCM token — เรียกทุกครั้งที่เข้าแอปสำเร็จ (login ตรง/auto-login)
 * ทำงานแบบเงียบๆ เสมอ ไม่ block การใช้งานแอปหลัก ถ้าเบราว์เซอร์ไม่รองรับ/ผู้ใช้กดปฏิเสธ ก็แค่ข้ามไป */
function maintInitPush_() {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || typeof firebase === 'undefined') return;

  try {
    if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(MAINT_FCM_CONFIG_);
    const messaging = firebase.messaging();

    // ข้อความ push ตอนแอปเปิดอยู่ตรงหน้า (foreground) — sw.js จะจัดการเฉพาะตอนแอปอยู่เบื้องหลังเท่านั้น
    messaging.onMessage(function (payload) {
      const n = payload && payload.notification;
      if (n) showToast((n.title || '') + (n.body ? ' — ' + n.body : ''));
    });

    if (Notification.permission === 'denied') return; // เคยกดปฏิเสธไว้ก่อนแล้ว ไม่รบกวนซ้ำ

    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') return;
      navigator.serviceWorker.ready.then(function (reg) {
        messaging.getToken({ vapidKey: MAINT_VAPID_KEY_, serviceWorkerRegistration: reg })
          .then(function (fcmToken) {
            if (!fcmToken) return;
            const prevToken = localStorage.getItem(MAINT_FCM_TOKEN_KEY_);
            if (prevToken === fcmToken) return; // token เดิม เคยลงทะเบียนไปแล้วตอนเข้าแอปรอบก่อน ไม่ต้องยิงซ้ำ
            localStorage.setItem(MAINT_FCM_TOKEN_KEY_, fcmToken);
            google.script.run
              .withSuccessHandler(function () { /* เงียบๆ ไม่ต้อง toast รบกวน ไม่ใช่ action ที่ user กดเอง */ })
              .withFailureHandler(function (err) { console.warn('savePushToken failed', err); })
              .savePushToken(sessionToken, fcmToken, navigator.userAgent);
          })
          .catch(function (err) { console.warn('FCM getToken error', err); });
      });
    });
  } catch (e) { console.warn('maintInitPush_ error', e); }
}

/** ถอน token ตอน logout — กันเครื่องที่เลิกใช้แล้วยังค้างรับแจ้งเตือนของ user เดิมอยู่ */
function maintRemovePushTokenOnLogout_() {
  try {
    const fcmToken = localStorage.getItem(MAINT_FCM_TOKEN_KEY_);
    if (fcmToken && sessionToken) {
      google.script.run.withSuccessHandler(function () {}).withFailureHandler(function () {}).removePushToken(sessionToken, fcmToken);
    }
    localStorage.removeItem(MAINT_FCM_TOKEN_KEY_);
  } catch (e) { /* ignore */ }
}

/* ---------- PWA: เพิ่มลงหน้าจอหลัก ---------- */
// สำคัญ: ต้องดักฟัง beforeinstallprompt ให้เร็วที่สุด (นอก DOMContentLoaded) เพราะบางเบราว์เซอร์
// ยิง event นี้เร็วมาก ถ้าดักช้าไปจะพลาด event แล้วปุ่มจะกลายเป็นโหมด "คำแนะนำมือ" แทนที่จะเป็น
// โหมด "กดปุ่มเดียวติดตั้งจริง"
let deferredInstallPrompt = null;
const INSTALL_GUIDE_DISMISS_KEY = 'kjt_install_guide_dismissed';

window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault(); // กันไม่ให้ Chrome โชว์แถบเตือนของตัวเอง จะได้ควบคุมด้วยปุ่มเราปุ่มเดียว
  deferredInstallPrompt = e;
  const fab = document.getElementById('pwaInstallFab');
  if (fab) fab.style.display = 'block';
});

window.addEventListener('appinstalled', function () {
  deferredInstallPrompt = null;
  const fab = document.getElementById('pwaInstallFab');
  if (fab) fab.style.display = 'none';
  closeInstallGuide_();
  showToast('ติดตั้งแอปเรียบร้อยแล้ว เปิดจากหน้าจอหลักได้เลยครั้งต่อไป');
});

function isIOSDevice_() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function isRunningStandalone_() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function setupPwa_() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.log('ลงทะเบียน Service Worker ไม่สำเร็จ:', err);
      });
    });
  }
  if (isRunningStandalone_()) return; // เปิดจากไอคอนที่ติดตั้งแล้ว ไม่ต้องเสนอให้ติดตั้งซ้ำ

  document.getElementById('pwaInstallFab').style.display = 'block';

  // โชว์คู่มือติดตั้งแบบภาพให้เห็นทันทีตั้งแต่เปิดครั้งแรก (ถ้ายังไม่เคยกดปิดไปก่อน) — เผื่อคนขับ
  // สูงอายุมองไม่เห็นปุ่มลอย หรือไม่แน่ใจว่าต้องกดอะไร
  let dismissedBefore = false;
  try { dismissedBefore = !!localStorage.getItem(INSTALL_GUIDE_DISMISS_KEY); } catch (e) { /* ignore */ }
  if (!dismissedBefore) {
    setTimeout(openInstallGuide_, 900);
  }
}

function openInstallGuide_() {
  if (isRunningStandalone_()) return;
  const androidSteps = document.getElementById('igAndroidSteps');
  const iosSteps = document.getElementById('igIosSteps');
  const installBtn = document.getElementById('igInstallBtn');

  if (isIOSDevice_()) {
    androidSteps.style.display = 'none';
    iosSteps.style.display = 'flex';
    installBtn.style.display = 'none'; // iOS กดปุ่มนี้ทำอะไรไม่ได้ ต้องทำตามขั้นตอนมือเท่านั้น
  } else {
    androidSteps.style.display = 'flex';
    iosSteps.style.display = 'none';
    installBtn.style.display = 'block';
  }
  document.getElementById('installGuideModal').classList.add('open');
}

function closeInstallGuide_() {
  document.getElementById('installGuideModal').classList.remove('open');
}

function dismissInstallGuide_() {
  try { localStorage.setItem(INSTALL_GUIDE_DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
  closeInstallGuide_();
}

function handlePwaInstallClick_() {
  // ถ้าเบราว์เซอร์รองรับ (ส่วนใหญ่ Android/Chrome) — กดปุ่มเดียวจบ เจอ popup ยืนยันของเบราว์เซอร์แค่ครั้งเดียว
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(function (choice) {
      if (choice.outcome === 'accepted') {
        document.getElementById('pwaInstallFab').style.display = 'none';
        closeInstallGuide_();
      }
      deferredInstallPrompt = null;
    });
    return;
  }
  // iOS หรือเบราว์เซอร์ที่ไม่รองรับ auto-prompt — เปิดคู่มือแบบภาพให้ทำตามขั้นตอนมือแทน
  openInstallGuide_();
}

    const ROLE_LABELS = {
      Admin: 'ผู้ดูแลระบบ',
      Supervisor: 'หัวหน้างาน',
      Driver: 'คนขับรถ',
      FuelAttendant: 'คนเติมน้ำมัน',
      Mechanic: 'ช่างซ่อมบำรุง'
    };

    /* ---------- Toast ---------- */
    function showToast(msg, isError) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = 'toast show' + (isError ? ' error' : '');
      setTimeout(function () { t.className = 'toast'; }, 3000);
    }

    /* ---------- Login ---------- */
    const REMEMBER_KEY = 'kjt_fuel_remember_session';

    function doLogin() {
      const username = document.getElementById('loginUsername').value.trim();
      const password = document.getElementById('loginPassword').value;
      const remember = document.getElementById('rememberMe').checked;
      const errBox = document.getElementById('loginError');
      const btn = document.getElementById('loginBtn');
      errBox.style.display = 'none';

      if (!username || !password) {
        errBox.textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน';
        errBox.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังเข้าสู่ระบบ...';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'เข้าสู่ระบบ';
          if (res.success) {
            sessionToken = res.token;
            currentUser = res.user;
            try {
              if (remember) localStorage.setItem(REMEMBER_KEY, JSON.stringify({ token: res.token }));
              else localStorage.removeItem(REMEMBER_KEY);
            } catch (e) { /* localStorage อาจไม่พร้อมใช้งาน ไม่เป็นไร */ }
            enterApp();
          } else {
            errBox.textContent = res.message;
            errBox.style.display = 'block';
          }
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'เข้าสู่ระบบ';
          errBox.textContent = 'เชื่อมต่อไม่สำเร็จ: ' + err.message;
          errBox.style.display = 'block';
        })
        .loginUser(username, password, remember);
    }

    function doLogout() {
      google.script.run.logoutUser(sessionToken);
      maintRemovePushTokenOnLogout_();
      try { localStorage.removeItem(REMEMBER_KEY); } catch (e) { /* ignore */ }
      sessionToken = null;
      currentUser = null;
      document.getElementById('appScreen').style.display = 'none';
      document.getElementById('loginScreen').style.display = 'flex';
      document.getElementById('loginUsername').value = '';
      document.getElementById('loginPassword').value = '';
    }

    function tryAutoLogin() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null'); } catch (e) { saved = null; }
      if (!saved || !saved.token) return;

      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) {
            sessionToken = saved.token;
            currentUser = res.user;
            enterApp();
          } else {
            try { localStorage.removeItem(REMEMBER_KEY); } catch (e) { /* ignore */ }
          }
        })
        .withFailureHandler(function () { /* เงียบไว้ ให้ผู้ใช้ล็อกอินตามปกติ */ })
        .checkSession(saved.token);
    }

    function enterApp() {
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('appScreen').style.display = 'block';
      document.getElementById('whoName').textContent = currentUser.fullName;
      document.getElementById('whoRole').textContent = currentUser.username;
      document.getElementById('whoRoleBadge').textContent = ROLE_LABELS[currentUser.role] || currentUser.role;
      driverView = 'menu';
      attendantView = 'menu';
      renderMain();
      renderOfflineBanner_();
      trySyncOfflineQueue_(false); // เข้าแอปสำเร็จ (login ตรง/auto-login) — ลองซิงค์รายการที่ค้างจากรอบก่อนทันที
      maintInitPush_(); // Phase 4: ขอสิทธิ์แจ้งเตือน + ลงทะเบียน FCM token ของเครื่องนี้ (เงียบๆ ถ้าไม่รองรับ/ถูกปฏิเสธ)
    }

    let adminActiveTab = 'schedule';

    function renderMain() {
      const el = document.getElementById('mainContent');
      if (currentUser.role === 'Admin') {
        renderAdminShell();
      } else if (currentUser.role === 'Supervisor') {
        renderSupervisorHome('mainContent');
      } else if (currentUser.role === 'Driver') {
        renderDriverHome();
      } else if (currentUser.role === 'FuelAttendant' || currentUser.role === 'Mechanic') {
        renderAttendantHome();
      } else {
        el.innerHTML =
          '<div class="placeholder">' +
            '<div class="icon">🚧</div>' +
            '<h3 style="margin:0 0 6px;color:var(--navy);">หน้า ' + (ROLE_LABELS[currentUser.role] || currentUser.role) + ' กำลังพัฒนา</h3>' +
            '<p style="margin:0;font-size:13.5px;">ส่วนนี้จะเปิดใช้งานในลำดับถัดไป</p>' +
          '</div>';
      }
    }

    function renderAdminShell() {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<div class="tab-bar">' +
          '<button class="tab-btn' + (adminActiveTab === 'schedule' ? ' active' : '') + '" onclick="switchAdminTab(\'schedule\')">ตารางเติมน้ำมัน</button>' +
          '<button class="tab-btn' + (adminActiveTab === 'users' ? ' active' : '') + '" onclick="switchAdminTab(\'users\')">จัดการผู้ใช้งาน</button>' +
          '<button class="tab-btn' + (adminActiveTab === 'healthImport' ? ' active' : '') + '" onclick="switchAdminTab(\'healthImport\')">นำเข้าผลตรวจสุขภาพ</button>' +
          '<button class="tab-btn' + (adminActiveTab === 'maintenance' ? ' active' : '') + '" onclick="switchAdminTab(\'maintenance\')">คิวซ่อมบำรุง</button>' +
        '</div>' +
        '<div id="adminTabContent"></div>';
      if (adminActiveTab === 'users') renderAdminUsers('adminTabContent');
      else if (adminActiveTab === 'healthImport') renderHealthImportPage_('adminTabContent', '');
      else if (adminActiveTab === 'maintenance') renderMaintenanceCalendarPage_('adminTabContent', '');
      else renderSupervisorSchedule('adminTabContent');
    }

    function switchAdminTab(tab) {
      adminActiveTab = tab;
      renderAdminShell();
    }

    /* ---------- Driver: QR Code + ประวัติของตัวเอง ---------- */
    let driverView = 'menu'; // 'menu' | 'qr' | 'history' | 'map'
    let driverHistoryMonth = '';

    function renderDriverHome() {
      if (driverView === 'qr') { renderDriverQr(); return; }
      if (driverView === 'history') { renderDriverHistory(); return; }
      if (driverView === 'map') { renderDriverSafetyMap(); return; }
      if (driverView === 'maint') { renderMaintenanceBookingPage_("goDriverView('menu')"); return; }

      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<div class="driver-menu">' +
          '<button type="button" class="driver-menu-btn" onclick="goDriverView(\'qr\')">' +
            '<span class="dmb-icon">📷</span><span class="dmb-label">เปิด QR Code สำหรับเติมน้ำมัน</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goDriverView(\'history\')">' +
            '<span class="dmb-icon">🧾</span><span class="dmb-label">ประวัติการเติมน้ำมัน</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goDriverView(\'map\')">' +
            '<span class="dmb-icon">📍</span><span class="dmb-label">แผนที่ส่งสินค้า / จุดเสี่ยง</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goDriverView(\'maint\')">' +
            '<span class="dmb-icon">🔧</span><span class="dmb-label">แจ้งซ่อม / จองคิวเข้าอู่</span>' +
          '</button>' +
        '</div>';
    }

    function goDriverView(view) {
      driverView = view;
      renderDriverHome();
    }

    function renderDriverQr() {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="goDriverView(\'menu\')">← กลับ</button>' +
        '<div class="panel" style="text-align:center;">' +
          '<h3 style="margin:0 0 4px;color:var(--navy);">QR Code สำหรับเติมน้ำมัน</h3>' +
          '<p class="panel-hint">ให้พนักงานเติมน้ำมันสแกนโค้ดนี้เพื่อยืนยันตัวตน</p>' +
          '<div id="qrHolder" style="display:flex;justify-content:center;padding:16px 0;"><div class="empty-state">กำลังโหลด...</div></div>' +
          '<div id="pinHolder"></div>' +
        '</div>';

      google.script.run
        .withSuccessHandler(function (res) {
          const holder = document.getElementById('qrHolder');
          const pinHolder = document.getElementById('pinHolder');
          if (!res.success) { holder.innerHTML = '<div class="empty-state">' + escapeHtml(res.message) + '</div>'; return; }
          holder.innerHTML = '';
          new QRCode(holder, { text: res.qrCode, width: 220, height: 220, colorDark: '#14213D', colorLight: '#ffffff' });
          if (res.pin) {
            pinHolder.innerHTML =
              '<p class="panel-hint" style="margin-top:14px;margin-bottom:4px;">หรือถ้าสแกนไม่ได้ แจ้งรหัส 6 หลักนี้แทน</p>' +
              '<div style="font-family:\'Prompt\',sans-serif;font-size:32px;font-weight:700;letter-spacing:6px;color:var(--navy);">' + escapeHtml(res.pin) + '</div>';
          }
        })
        .withFailureHandler(function (err) {
          document.getElementById('qrHolder').innerHTML = '<div class="empty-state">โหลดไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getMyQrCode(sessionToken);
    }

    function renderDriverHistory() {
      const el = document.getElementById('mainContent');
      if (!driverHistoryMonth) {
        const now = new Date();
        driverHistoryMonth = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2);
      }

      el.innerHTML =
        '<button type="button" class="back-link" onclick="goDriverView(\'menu\')">← กลับ</button>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>ประวัติการเติมน้ำมัน</h3></div>' +
          '<div class="filter-row">' +
            '<label style="font-size:13px;font-weight:600;">เดือน:</label>' +
            '<input type="month" id="driverMonthFilter" value="' + driverHistoryMonth + '" onchange="onDriverMonthChange()">' +
            '<button type="button" class="btn btn-outline btn-sm" onclick="clearDriverMonthFilter()">ดูทั้งหมด</button>' +
          '</div>' +
          '<div id="driverHistoryList"><div class="empty-state">กำลังโหลด...</div></div>' +
        '</div>';

      loadDriverHistory();
    }

    function onDriverMonthChange() {
      driverHistoryMonth = document.getElementById('driverMonthFilter').value;
      loadDriverHistory();
    }

    function clearDriverMonthFilter() {
      driverHistoryMonth = '';
      document.getElementById('driverMonthFilter').value = '';
      loadDriverHistory();
    }

    function loadDriverHistory() {
      const list = document.getElementById('driverHistoryList');
      list.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          renderDriverHistoryList(res.rows);
        })
        .withFailureHandler(function (err) { showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true); })
        .getMyFuelHistory(sessionToken, driverHistoryMonth);
    }

    function renderDriverHistoryList(rows) {
      const list = document.getElementById('driverHistoryList');
      if (!rows.length) { list.innerHTML = '<div class="empty-state">ไม่มีข้อมูลในเดือนที่เลือก</div>'; return; }

      let html = '<div class="grid-scroll"><table class="report-table"><thead><tr>' +
        '<th>No.</th><th>วันที่</th><th>Fleet</th><th>ทะเบียน</th><th>สถานที่</th><th>อำเภอ</th><th>จังหวัด</th><th>ลิตร</th>' +
      '</tr></thead><tbody>';
      rows.forEach(function (r, i) {
        html += '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHtml(r.date) + '</td>' +
          '<td>' + escapeHtml(r.fleet || '') + '</td>' +
          '<td>' + escapeHtml(r.plateNumber || '') + '</td>' +
          '<td>' + escapeHtml(r.location || '') + '</td>' +
          '<td>' + escapeHtml(r.district || '') + '</td>' +
          '<td>' + escapeHtml(r.province || '') + '</td>' +
          '<td>' + escapeHtml(String(r.liters)) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      list.innerHTML = html;
    }

    /* ---------- Driver: แผนที่ส่งสินค้า / จุดเสี่ยง ---------- */
    let safetyRoutesCache = [];
    let safetySelectedShop = null;

    function renderDriverSafetyMap() {
      renderSafetyMapShared_("goDriverView('menu')");
    }

    // ใช้ร่วมกันระหว่างเมนูคนขับและเมนูหัวหน้างาน — ต่างกันแค่ปุ่ม "กลับ" ที่ต้องกลับไปคนละเมนูหลัก
    function renderSafetyMapShared_(backOnclick) {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="' + backOnclick + '">← กลับ</button>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>แผนที่ส่งสินค้า / จุดเสี่ยง</h3></div>' +
          '<p class="panel-hint">พิมพ์ชื่อร้าน/โรงงานที่จะไปส่ง</p>' +
          '<div class="field search-box" style="position:relative;">' +
            '<input type="text" id="safSearchInput" list="safShopList" placeholder="กำลังโหลดรายชื่อร้าน..." oninput="onSafetySearchInput_()" onkeydown="if(event.key===\'Enter\')doSafetySearch_()" disabled>' +
            '<button type="button" class="search-clear-btn" id="safClearBtn" onclick="clearSafetySearch_()">✕</button>' +
            '<datalist id="safShopList"></datalist>' +
          '</div>' +
          '<button class="btn btn-primary" id="safSearchBtn" onclick="doSafetySearch_()" disabled>ค้นหา</button>' +
          '<div class="loading-state" id="safLoadingState">' +
            '<div class="spinner-lg"></div>' +
            '<p>กำลังโหลดข้อมูลร้านค้า/จุดส่งสินค้า...</p>' +
          '</div>' +
        '</div>' +
        '<div id="safetyDetailArea"></div>';

      loadSafetyRoutes_();
    }

    function loadSafetyRoutes_() {
      const loadingEl = document.getElementById('safLoadingState');
      const inputEl = document.getElementById('safSearchInput');
      const btnEl = document.getElementById('safSearchBtn');

      if (loadingEl) {
        loadingEl.innerHTML =
          '<div class="spinner-lg"></div>' +
          '<p>กำลังโหลดข้อมูลร้านค้า/จุดส่งสินค้า...</p>';
      }
      if (inputEl) { inputEl.disabled = true; inputEl.placeholder = 'กำลังโหลดรายชื่อร้าน...'; }
      if (btnEl) btnEl.disabled = true;

      google.script.run
        .withSuccessHandler(function (res) {
          if (loadingEl) loadingEl.remove();
          if (!res.success) { showToast(res.message, true); return; }
          safetyRoutesCache = res.rows;
          if (inputEl) {
            inputEl.disabled = false;
            inputEl.placeholder = 'พิมพ์ชื่อร้าน/โรงงาน... (มี ' + res.rows.length + ' รายการ)';
          }
          if (btnEl) btnEl.disabled = false;
        })
        .withFailureHandler(function (err) {
          if (loadingEl) {
            loadingEl.innerHTML =
              '<p style="color:var(--danger);margin:0 0 12px;">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</p>' +
              '<button type="button" class="btn btn-outline" onclick="loadSafetyRoutes_()">ลองใหม่</button>';
          }
          if (inputEl) inputEl.placeholder = 'โหลดข้อมูลไม่สำเร็จ — กดลองใหม่ด้านล่าง';
          showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true);
        })
        .getSafetyRoutes(sessionToken);
    }

    function onSafetySearchInput_() {
      const input = document.getElementById('safSearchInput');
      const clearBtn = document.getElementById('safClearBtn');
      const dl = document.getElementById('safShopList');
      clearBtn.style.display = input.value ? 'block' : 'none';

      const val = input.value.trim().toLowerCase();
      dl.innerHTML = '';
      if (!val) return;
      safetyRoutesCache
        .filter(function (s) { return s.customer.toLowerCase().indexOf(val) !== -1; })
        .slice(0, 20)
        .forEach(function (s) {
          const opt = document.createElement('option');
          opt.value = s.customer;
          dl.appendChild(opt);
        });
    }

    function clearSafetySearch_() {
      const input = document.getElementById('safSearchInput');
      input.value = '';
      document.getElementById('safClearBtn').style.display = 'none';
      input.focus();
    }

    function doSafetySearch_() {
      const val = document.getElementById('safSearchInput').value.trim();
      const shop = safetyRoutesCache.find(function (s) { return s.customer === val; });
      const detailArea = document.getElementById('safetyDetailArea');
      if (!shop) {
        detailArea.innerHTML = '<div class="empty-state">ไม่พบร้าน "' + escapeHtml(val) + '" ลองเลือกจากรายการที่แนะนำ</div>';
        return;
      }
      safetySelectedShop = shop;
      renderSafetyDetail_();
    }

    function renderSafetyDetail_() {
      const s = safetySelectedShop;
      const detailArea = document.getElementById('safetyDetailArea');
      detailArea.innerHTML =
        '<div class="panel">' +
          '<h3 style="margin:0 0 2px;color:var(--navy);">' + escapeHtml(s.customer) + '</h3>' +
          '<p class="panel-hint" style="margin-bottom:16px;">' + escapeHtml(s.address) + '</p>' +
          safetyTopicCard_('📝 หมายเหตุ', s.note, false) +
          safetyTopicCard_('🛣️ เส้นทางหลัก', s.mainRoute, false) +
          safetyTopicCard_('🗺️ เส้นทางสำรอง', s.subRoute, false) +
          safetyTopicCard_('📦 วิธีการลงสินค้า', s.howToUnload, false) +
          safetyTopicCard_('⚠️ จุดเสี่ยง', s.risk, true) +
          '<a href="' + escapeHtml(s.mapLink) + '" target="_blank" class="btn btn-primary" style="display:block;text-align:center;text-decoration:none;margin-top:6px;">🧭 นำทาง Google Maps</a>' +
          '<button type="button" class="btn btn-amber" style="margin-top:10px;" onclick="openSafetyUpdateModal_()">📷 อัปเดตข้อมูล</button>' +
        '</div>';
    }

    function safetyTopicCard_(label, rawText, isRisk) {
      const parsed = parseSafetyText_(rawText);
      let html = '<div class="topic-card' + (isRisk ? ' risk-card' : '') + '">' +
        '<div class="topic-label">' + label + '</div>' +
        '<div class="topic-text">' + (parsed.text || '-') + '</div>';
      if (parsed.photos.length) {
        html += '<div class="topic-photos">' +
          parsed.photos.map(function (url) {
            return '<img src="' + escapeHtml(url) + '" onclick="window.open(\'' + escapeHtml(url) + '\',\'_blank\')">';
          }).join('') +
          '</div>';
      }
      html += '</div>';
      return html;
    }

    function parseSafetyText_(raw) {
      if (!raw || raw === '-' || raw === '') return { text: '-', photos: [] };
      const urlRegex = /(https?:\/\/drive\.google\.com\/[^\s\n]+)/g;
      const photos = raw.match(urlRegex) || [];
      const clean = raw.replace(urlRegex, '').trim();
      return { text: clean ? escapeHtml(clean).replace(/\n/g, '<br>') : '-', photos: photos };
    }

    function openSafetyUpdateModal_() {
      if (!safetySelectedShop) return;
      document.getElementById('safetyUpdateError').style.display = 'none';
      document.getElementById('safDriverName').value = (currentUser && currentUser.fullName) || '';
      document.getElementById('safCarId').value = '';
      document.getElementById('safUpdateType').value = 'mainRoute';
      document.getElementById('safUpdateText').value = '';
      document.getElementById('safUpdatePhoto').value = '';
      document.getElementById('safetyUpdateModal').classList.add('open');
    }

    function closeSafetyUpdateModal_() {
      document.getElementById('safetyUpdateModal').classList.remove('open');
    }

    // ลดขนาดรูปก่อนส่งขึ้นเซิร์ฟเวอร์ (scale 50% + บีบอัด JPEG 80%) กันไฟล์ใหญ่/ช้า
    function resizeSafetyImage_(file, callback) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
          const scaleFactor = 0.5;
          const canvas = document.createElement('canvas');
          canvas.width = img.width * scaleFactor;
          canvas.height = img.height * scaleFactor;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          callback(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    function submitSafetyUpdate_() {
      const driverName = document.getElementById('safDriverName').value.trim();
      const carId = document.getElementById('safCarId').value.trim();
      const type = document.getElementById('safUpdateType').value;
      const text = document.getElementById('safUpdateText').value.trim();
      const file = document.getElementById('safUpdatePhoto').files[0];
      const errBox = document.getElementById('safetyUpdateError');

      if (!driverName || !carId) {
        errBox.textContent = 'กรุณากรอกชื่อคนขับและทะเบียน';
        errBox.style.display = 'block';
        return;
      }
      if (!text && !file) {
        errBox.textContent = 'กรุณาพิมพ์ข้อความหรือถ่ายรูปอย่างน้อย 1 อย่าง';
        errBox.style.display = 'block';
        return;
      }
      errBox.style.display = 'none';

      const btn = document.getElementById('safUpdateSaveBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';

      function send(photoBase64) {
        google.script.run
          .withSuccessHandler(function (res) {
            btn.disabled = false;
            btn.textContent = 'บันทึก';
            if (res.success) {
              showToast('บันทึกข้อมูลเรียบร้อย');
              safetyRoutesCache = res.rows;
              safetySelectedShop = safetyRoutesCache.find(function (s) { return s.rowId === safetySelectedShop.rowId; }) || safetySelectedShop;
              closeSafetyUpdateModal_();
              renderSafetyDetail_();
            } else {
              errBox.textContent = res.message;
              errBox.style.display = 'block';
            }
          })
          .withFailureHandler(function (err) {
            btn.disabled = false;
            btn.textContent = 'บันทึก';
            errBox.textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
            errBox.style.display = 'block';
          })
          .submitSafetyRouteUpdate(sessionToken, {
            rowId: safetySelectedShop.rowId,
            customerName: safetySelectedShop.customer,
            driverName: driverName,
            carId: carId,
            type: type,
            content: text,
            photoBase64: photoBase64 || ''
          });
      }

      if (file) {
        resizeSafetyImage_(file, function (resizedBase64) { send(resizedBase64); });
      } else {
        send('');
      }
    }

    /* ---------- Fuel Attendant: สแกน QR + บันทึกการเติมจริง ---------- */
    let attendantView = 'menu'; // menu | scan | jobs | meter | signature | report
    let scannerWindow = null;
    let attendantDriver = null;
    let attendantJobs = [];
    let attendantSelectedJob = null;
    let attendantStartMeter = '';
    let attendantEndMeter = '';
    let attendantLitersActual = null;
    let driverSigPad = null;
    let staffSigPad = null;
    let attendantReportFrom = '';
    let attendantReportTo = '';

    function renderAttendantHome() {
      if (attendantView === 'scan') { renderAttendantScan(); return; }
      if (attendantView === 'jobs') { renderAttendantJobs(); return; }
      if (attendantView === 'meter') { renderAttendantMeter(); return; }
      if (attendantView === 'signature') { renderAttendantSignature(); return; }
      if (attendantView === 'report') { renderAttendantReport(); return; }
      // ช่างซ่อมบำรุงใช้เมนูน้ำมันชุดเดียวกับคนเติมน้ำมัน แล้วมีเมนูคิวซ่อมเพิ่มมาอีก 2 รายการ
      if (attendantView === 'maintQueue') { renderMaintenanceCalendarPage_('mainContent', "goAttendantView('menu')"); return; }
      if (attendantView === 'maintBook') { renderMaintenanceBookingPage_("goAttendantView('menu')"); return; }

      const isMechanic = currentUser.role === 'Mechanic';
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<div class="driver-menu">' +
          (isMechanic
            ? '<button type="button" class="driver-menu-btn" onclick="goAttendantView(\'maintQueue\')">' +
                '<span class="dmb-icon">🔧</span><span class="dmb-label">ตารางงานซ่อม / คิวเข้าอู่</span>' +
              '</button>' +
              '<button type="button" class="driver-menu-btn" onclick="goAttendantView(\'maintBook\')">' +
                '<span class="dmb-icon">📝</span><span class="dmb-label">เปิดใบจองซ่อมแทนคนขับ</span>' +
              '</button>'
            : '') +
          '<button type="button" class="driver-menu-btn" onclick="goAttendantView(\'scan\')">' +
            '<span class="dmb-icon">📷</span><span class="dmb-label">สแกน QR เพื่อเติมน้ำมัน</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goAttendantView(\'report\')">' +
            '<span class="dmb-icon">🧾</span><span class="dmb-label">ประวัติ / รายงานการเติม</span>' +
          '</button>' +
        '</div>';
    }

    function goAttendantView(view) {
      if (scannerWindow && !scannerWindow.closed) { try { scannerWindow.close(); } catch (e) { /* ignore */ } }
      attendantView = view;
      renderAttendantHome();
    }

    // ลิงก์หน้าสแกน QR แบบสแกนสด (โฮสต์แยกนอก Apps Script เพื่อเลี่ยงข้อจำกัดกล้องของ iframe)
    // แก้ค่านี้เป็น URL จริงหลัง deploy หน้าสแกนแล้ว
    const SCANNER_PAGE_URL = 'https://kjtransport2018oa-ux.github.io/kjt-qr-scanner/';

    // ลิงก์เว็บแอประบบใบส่งมอบ/รับคืนรถ (Apps Script Web App แยกต่างหาก) — เฉพาะ Supervisor เข้าถึงได้
    const VEHICLE_HANDOVER_URL = 'https://script.google.com/macros/s/AKfycbxeRGICTt_Ub2LioY1wtOAp_aPhbl4HotWUOhxS3CkfkfqXkA1B1q-vHlQsDjdSzbpp/exec';

    function openVehicleHandoverWindow_() {
      window.open(VEHICLE_HANDOVER_URL, '_blank');
    }

    function renderAttendantScan() {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="goAttendantView(\'menu\')">← กลับ</button>' +
        '<div class="panel" style="text-align:center;">' +
          '<h3 style="margin:0 0 4px;color:var(--navy);">สแกน QR คนขับ</h3>' +
          '<p class="panel-hint" id="scanHint">กดปุ่มด้านล่างเพื่อเปิดกล้องสแกน QR — เจอแล้วจะกลับมาที่นี่ให้อัตโนมัติ</p>' +
          '<button type="button" class="btn btn-amber" style="width:auto;" onclick="openScannerWindow_()">📷 เปิดกล้องสแกน QR</button>' +
          '<div id="scanStatus" class="empty-state" style="padding-top:14px;"></div>' +
        '</div>';
    }

    function openScannerWindow_() {
      const statusEl = document.getElementById('scanStatus');
      if (SCANNER_PAGE_URL.indexOf('PUT_YOUR_SCANNER_PAGE_URL_HERE') !== -1) {
        if (statusEl) statusEl.textContent = 'ยังไม่ได้ตั้งค่าลิงก์หน้าสแกน กรุณาแจ้งผู้ดูแลระบบ';
        return;
      }
      if (statusEl) statusEl.textContent = 'กำลังเปิดหน้าสแกน...';
      scannerWindow = window.open(SCANNER_PAGE_URL, 'kjtQrScanner', 'width=420,height=680');
      if (!scannerWindow) {
        if (statusEl) statusEl.textContent = 'เปิดหน้าต่างสแกนไม่สำเร็จ — เช็คว่าเบราว์เซอร์บล็อกป๊อปอัปอยู่หรือไม่ แล้วลองใหม่';
      }
    }

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data || data.source !== 'kjt-fuel-scanner' || !data.qrValue) return;
      if (attendantView !== 'scan') return; // ไม่ได้อยู่หน้าสแกน ไม่ต้องทำอะไร
      const statusEl = document.getElementById('scanStatus');
      if (statusEl) statusEl.textContent = 'พบ QR Code แล้ว กำลังโหลดข้อมูล...';
      onQrScanned_(data.qrValue);
    });

    function onQrScanned_(qrText) {
      const el = document.getElementById('mainContent');
      el.innerHTML = '<div class="empty-state">กำลังตรวจสอบ...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) {
            showToast(res.message, true);
            attendantView = 'scan';
            renderAttendantHome();
            return;
          }
          attendantDriver = res.driver;
          attendantJobs = res.jobs;
          if (!attendantJobs.length) {
            showToast('ไม่มีงานที่รอเติมสำหรับคนขับนี้', true);
            attendantView = 'menu';
            renderAttendantHome();
            return;
          }
          if (attendantJobs.length === 1) {
            attendantSelectedJob = attendantJobs[0];
            attendantView = 'meter';
          } else {
            attendantView = 'jobs';
          }
          renderAttendantHome();
        })
        .withFailureHandler(function (err) {
          showToast('ตรวจสอบไม่สำเร็จ: ' + err.message, true);
          attendantView = 'menu';
          renderAttendantHome();
        })
        .findPendingFuelJobsForDriver(sessionToken, qrText);
    }

    function renderAttendantJobs() {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="goAttendantView(\'menu\')">← กลับ</button>' +
        '<div class="panel">' +
          '<h3 style="margin:0 0 4px;color:var(--navy);">เลือกงานของ ' + escapeHtml(attendantDriver.fullName) + '</h3>' +
          '<p class="panel-hint">คนขับคนนี้มีงานที่รอเติมมากกว่า 1 รายการ เลือกงานที่ตรงกับตอนนี้</p>' +
          attendantJobs.map(function (j, i) {
            return '<div class="job-card" onclick="selectAttendantJob(' + i + ')">' +
              '<div class="name">' + escapeHtml(j.date) + ' · ทะเบียน ' + escapeHtml(j.plateNumber) + '</div>' +
              '<div class="meta">' + escapeHtml(j.location) + ' · ' + escapeHtml(j.district) + ' ' + escapeHtml(j.province) + ' · ' + escapeHtml(String(j.liters)) + ' ลิตร</div>' +
            '</div>';
          }).join('') +
        '</div>';
    }

    function selectAttendantJob(i) {
      attendantSelectedJob = attendantJobs[i];
      attendantView = 'meter';
      renderAttendantHome();
    }

    function renderAttendantMeter() {
      const el = document.getElementById('mainContent');
      const j = attendantSelectedJob;
      el.innerHTML =
        '<button type="button" class="back-link" onclick="goAttendantView(\'menu\')">← กลับ</button>' +
        '<div class="scan-result-card">' +
          '<div class="scan-result-label">คนขับ</div>' +
          '<div class="scan-result-big">' + escapeHtml(attendantDriver.fullName) + '</div>' +
          '<div class="scan-result-label">ทะเบียนรถ</div>' +
          '<div class="scan-result-big scan-result-plate">' + escapeHtml(j.plateNumber) + '</div>' +
          '<div class="scan-result-label">ไปส่งที่</div>' +
          '<div class="scan-result-mid">' + escapeHtml(j.location) + '</div>' +
          '<div class="scan-result-mid" style="opacity:.85;">' + escapeHtml(j.district) + ' ' + escapeHtml(j.province) + '</div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="field"><label>จำนวนลิตรที่หัวหน้างานกำหนด</label><input type="text" value="' + escapeHtml(String(j.liters)) + ' ลิตร" disabled></div>' +
          '<div class="field"><label>เลขหัวจ่ายเริ่มต้น</label><input type="number" id="meterStart" oninput="onMeterChange()" placeholder="กำลังโหลด..."></div>' +
          '<div class="field"><label>เลขหัวจ่ายสิ้นสุด</label><input type="number" id="meterEnd" oninput="onMeterChange()" placeholder="กรอกเลขหลังเติมเสร็จ"></div>' +
          '<div id="meterCompare"></div>' +
          '<button class="btn btn-primary" id="meterConfirmBtn" onclick="confirmMeter()" disabled>ยืนยันจำนวนลิตร</button>' +
        '</div>';

      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success && document.getElementById('meterStart')) document.getElementById('meterStart').value = res.nextStart;
        })
        .withFailureHandler(function () { /* ปล่อยว่างให้กรอกเอง */ })
        .getNextStartMeter(sessionToken);
    }

    function onMeterChange() {
      const startInput = document.getElementById('meterStart');
      const endInput = document.getElementById('meterEnd');
      const compareEl = document.getElementById('meterCompare');
      const btn = document.getElementById('meterConfirmBtn');
      const start = Number(startInput.value);
      const end = Number(endInput.value);

      if (!endInput.value || !startInput.value || isNaN(end) || isNaN(start) || end <= start) {
        compareEl.innerHTML = '';
        btn.disabled = true;
        return;
      }
      const diff = end - start;
      const planned = Number(attendantSelectedJob.liters);
      const matched = diff === planned;
      attendantLitersActual = diff;
      compareEl.innerHTML =
        '<div class="meter-compare ' + (matched ? 'match' : 'mismatch') + '">' +
          'เติมจริง ' + diff + ' ลิตร (กำหนด ' + planned + ' ลิตร) — ' + (matched ? 'ตรงกัน ✓' : 'ไม่ตรงกัน ⚠') +
        '</div>';
      btn.disabled = false;
    }

    function confirmMeter() {
      attendantStartMeter = document.getElementById('meterStart').value;
      attendantEndMeter = document.getElementById('meterEnd').value;
      attendantView = 'signature';
      renderAttendantHome();
    }

    function renderAttendantSignature() {
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="attendantView=\'meter\';renderAttendantHome();">← กลับ</button>' +
        '<div class="panel">' +
          '<h3 style="margin:0 0 4px;color:var(--navy);">เซ็นยืนยันการเติมน้ำมัน</h3>' +
          '<p class="panel-hint">เติมจริง ' + attendantLitersActual + ' ลิตร — ให้คนขับและผู้เติมเซ็นชื่อยืนยัน</p>' +
          '<div class="sig-label"><span>ลายเซ็นคนขับ</span><button type="button" onclick="clearSig_(driverSigPad)">ล้าง</button></div>' +
          '<canvas id="driverSigCanvas" class="signature-box" width="320" height="140"></canvas>' +
          '<div class="sig-label"><span>ลายเซ็นผู้เติมน้ำมัน</span><button type="button" onclick="clearSig_(staffSigPad)">ล้าง</button></div>' +
          '<canvas id="staffSigCanvas" class="signature-box" width="320" height="140"></canvas>' +
          '<button class="btn btn-amber" style="margin-top:18px;" id="submitFuelBtn" onclick="submitAttendantFuelLog()">ยืนยันการเติมน้ำมัน</button>' +
        '</div>';

      driverSigPad = initSignaturePad_('driverSigCanvas');
      staffSigPad = initSignaturePad_('staffSigCanvas');
    }

    function initSignaturePad_(canvasId) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = '#14213D';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      let drawing = false;
      let hasContent = false;

      function pos(e) {
        const rect = canvas.getBoundingClientRect();
        const point = e.touches ? e.touches[0] : e;
        return {
          x: (point.clientX - rect.left) * (canvas.width / rect.width),
          y: (point.clientY - rect.top) * (canvas.height / rect.height)
        };
      }
      function start(e) { drawing = true; hasContent = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
      function move(e) { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); }
      function end() { drawing = false; }

      canvas.addEventListener('mousedown', start);
      canvas.addEventListener('mousemove', move);
      canvas.addEventListener('mouseup', end);
      canvas.addEventListener('mouseleave', end);
      canvas.addEventListener('touchstart', start, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', end);

      return {
        isEmpty: function () { return !hasContent; },
        clear: function () { ctx.clearRect(0, 0, canvas.width, canvas.height); hasContent = false; },
        toDataURL: function () { return canvas.toDataURL('image/png'); }
      };
    }

    function clearSig_(pad) { if (pad) pad.clear(); }

    function submitAttendantFuelLog() {
      if (!driverSigPad || driverSigPad.isEmpty()) { showToast('กรุณาให้คนขับเซ็นชื่อ', true); return; }
      if (!staffSigPad || staffSigPad.isEmpty()) { showToast('กรุณาเซ็นชื่อผู้เติมน้ำมัน', true); return; }

      const btn = document.getElementById('submitFuelBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';

      const payload = {
        scheduleId: attendantSelectedJob.id,
        startMeter: attendantStartMeter,
        endMeter: attendantEndMeter,
        driverSignature: driverSigPad.toDataURL(),
        attendantSignature: staffSigPad.toDataURL(),
        clientRequestId: genClientRequestId_() // ใช้กันบันทึกซ้ำตอน retry/sync ภายหลัง
      };

      callGasApi_('submitFuelLog', [sessionToken, payload])
        .then(function (res) {
          btn.disabled = false;
          btn.textContent = 'ยืนยันการเติมน้ำมัน';
          if (res.success) {
            showToast('บันทึกการเติมน้ำมันเรียบร้อย (' + res.litersActual + ' ลิตร)');
          } else {
            showToast(res.message, true);
            return; // validation ไม่ผ่าน — ให้ user แก้ไขในหน้าเดิมต่อ ไม่ต้องกลับเมนู
          }
          finishAttendantFuelSubmit_();
        })
        .catch(function () {
          // เน็ตหลุด/เซิร์ฟเวอร์ตอบช้าเกิน 15 วิ/ล่ม — เก็บเข้าคิวออฟไลน์แทนที่จะปล่อยให้ user ค้างรอหน้างาน
          queueFuelLogOffline_(payload);
          btn.disabled = false;
          btn.textContent = 'ยืนยันการเติมน้ำมัน';
          showToast('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ตอนนี้ บันทึกข้อมูลไว้ในเครื่องแล้ว จะซิงค์อัตโนมัติเมื่อกลับมาใช้งานได้', true);
          finishAttendantFuelSubmit_();
          trySyncOfflineQueue_(false); // ลองซิงค์ทันทีเผื่อจริงๆ แค่สะดุดแป๊บเดียว
        });
    }

    function finishAttendantFuelSubmit_() {
      attendantView = 'menu';
      attendantDriver = null;
      attendantJobs = [];
      attendantSelectedJob = null;
      renderAttendantHome();
    }

    function isoDate_(d) {
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    function renderAttendantReport() {
      const el = document.getElementById('mainContent');
      if (!attendantReportFrom) {
        const now = new Date();
        attendantReportFrom = isoDate_(now);
        attendantReportTo = isoDate_(now);
      }

      el.innerHTML =
        '<button type="button" class="back-link no-print" onclick="goAttendantView(\'menu\')">← กลับ</button>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>ประวัติ / รายงานการเติมน้ำมัน</h3></div>' +
          '<p class="panel-hint">เลือกวันเดียวเพื่อดูสรุปประจำวัน หรือเลือกช่วงวันที่เพื่อทำรายงานปริ้น</p>' +
          '<div class="filter-row">' +
            '<label style="font-size:13px;font-weight:600;">จาก:</label>' +
            '<input type="date" id="reportFrom" value="' + attendantReportFrom + '" onchange="onReportRangeChange()">' +
            '<label style="font-size:13px;font-weight:600;">ถึง:</label>' +
            '<input type="date" id="reportTo" value="' + attendantReportTo + '" onchange="onReportRangeChange()">' +
            '<button class="btn btn-outline btn-sm" onclick="window.print()">🖨 ปริ้น</button>' +
          '</div>' +
          '<div id="reportSummaryHolder"></div>' +
          '<div class="grid-scroll" id="reportTableHolder"><div class="empty-state">กำลังโหลด...</div></div>' +
        '</div>';

      loadAttendantReport();
    }

    function onReportRangeChange() {
      attendantReportFrom = document.getElementById('reportFrom').value;
      attendantReportTo = document.getElementById('reportTo').value;
      loadAttendantReport();
    }

    function loadAttendantReport() {
      const holder = document.getElementById('reportTableHolder');
      holder.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
      document.getElementById('reportSummaryHolder').innerHTML = '';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          renderAttendantSummary(res.rows);
          renderAttendantReportTable(res.rows);
        })
        .withFailureHandler(function (err) { showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true); })
        .getFuelLogReport(sessionToken, attendantReportFrom, attendantReportTo);
    }

    function renderAttendantSummary(rows) {
      const holder = document.getElementById('reportSummaryHolder');
      if (!rows.length) { holder.innerHTML = ''; return; }
      // rows มาจาก server เรียงตามเลขหัวจ่ายเริ่มต้นน้อย -> มากแล้ว
      const totalLiters = rows.reduce(function (sum, r) { return sum + (Number(r.litersActual) || 0); }, 0);
      const firstStart = rows[0].startMeter;
      const lastEnd = rows[rows.length - 1].endMeter;
      holder.innerHTML =
        '<div class="summary-cards">' +
          '<div class="summary-card"><div class="num">' + rows.length + '</div><div class="lbl">จำนวนเที่ยว</div></div>' +
          '<div class="summary-card"><div class="num">' + escapeHtml(String(firstStart)) + ' → ' + escapeHtml(String(lastEnd)) + '</div><div class="lbl">เลขหัวจ่าย เริ่ม → สิ้นสุด</div></div>' +
          '<div class="summary-card"><div class="num">' + totalLiters.toLocaleString() + '</div><div class="lbl">รวมลิตรที่จ่าย</div></div>' +
        '</div>';
    }

    function renderAttendantReportTable(rows) {
      const holder = document.getElementById('reportTableHolder');
      if (!rows.length) { holder.innerHTML = '<div class="empty-state">ไม่มีข้อมูลในช่วงที่เลือก</div>'; return; }
      let html = '<table class="report-table"><thead><tr>' +
        '<th>No.</th><th>วันที่</th><th>เลขหัวจ่ายเริ่มต้น</th><th>เลขหัวจ่ายสิ้นสุด</th><th>ลิตรจริง</th>' +
        '<th>อำเภอ</th><th>จังหวัด</th><th>ทะเบียน</th><th>ชื่อคนขับ</th><th>ผู้เติม</th>' +
      '</tr></thead><tbody>';
      rows.forEach(function (r, i) {
        html += '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHtml(r.fillDate) + '</td>' +
          '<td>' + escapeHtml(String(r.startMeter)) + '</td>' +
          '<td>' + escapeHtml(String(r.endMeter)) + '</td>' +
          '<td>' + escapeHtml(String(r.litersActual)) + '</td>' +
          '<td>' + escapeHtml(r.district) + '</td>' +
          '<td>' + escapeHtml(r.province) + '</td>' +
          '<td>' + escapeHtml(r.plateNumber) + '</td>' +
          '<td>' + escapeHtml(r.driverName) + '</td>' +
          '<td>' + escapeHtml(r.attendantName || '') + '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
      holder.innerHTML = html;
    }

    /* ---------- Admin: User Management ---------- */
    const UG_COLS = ['username', 'password', 'firstName', 'lastName', 'role'];
    const UG_HEADERS = ['Username', 'Password', 'ชื่อ', 'นามสกุล', 'Role'];
    let ugRowCount = 6;

    function renderAdminUsers(targetId) {
      const el = document.getElementById(targetId || 'mainContent');
      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title"><h3>เพิ่มผู้ใช้หลายคนพร้อมกัน</h3></div>' +
          '<p class="panel-hint">วางจาก Excel ได้เลย (คลิกช่องแรกแล้ว Ctrl+V) — ช่อง Role พิมพ์ได้ทั้ง Admin / Supervisor / Driver / FuelAttendant / Mechanic หรือภาษาไทย เช่น หัวหน้างาน, คนขับ, คนเติมน้ำมัน, ช่างซ่อมบำรุง</p>' +
          '<div class="grid-scroll"><table class="grid" id="userGrid"></table></div>' +
          '<div class="grid-toolbar">' +
            '<button class="btn btn-outline btn-sm" onclick="addUserGridRow()">+ เพิ่มแถว</button>' +
            '<button class="btn btn-outline btn-sm" onclick="clearUserGrid()">ล้างข้อมูล</button>' +
            '<button class="btn btn-amber btn-sm" id="saveUserGridBtn" onclick="saveUserGridRows()">บันทึกทั้งหมด</button>' +
          '</div>' +
          '<div class="bulk-results" id="userGridResults"></div>' +
        '</div>' +
        '<div class="section-head">' +
          '<h3>ผู้ใช้งานทั้งหมด</h3>' +
          '<button class="btn btn-amber btn-sm" onclick="openUserModal()">+ เพิ่มทีละคน</button>' +
        '</div>' +
        '<div id="userList"><div class="empty-state">กำลังโหลด...</div></div>';

      buildUserGridTable();
      loadUserList();
    }

    function loadUserList() {
      const list = document.getElementById('userList');
      list.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          renderUserList(res.users);
        })
        .withFailureHandler(function (err) { showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true); })
        .getAllUsers(sessionToken);
    }

    function renderUserList(users) {
      const list = document.getElementById('userList');
      if (!users.length) {
        list.innerHTML = '<div class="empty-state">ยังไม่มีผู้ใช้งานในระบบ</div>';
        return;
      }
      list.innerHTML = users.map(function (u) {
        const isActive = u.status === 'Active';
        return (
          '<div class="user-card">' +
            '<div class="user-info">' +
              '<div class="name">' + escapeHtml(u.fullName) + '</div>' +
              '<div class="meta">' +
                '<span class="role-pill">' + (ROLE_LABELS[u.role] || u.role) + '</span>' +
                '@' + escapeHtml(u.username) +
              '</div>' +
              '<div class="meta"><span class="status-dot ' + (isActive ? 'active' : 'inactive') + '"></span>' +
                (isActive ? 'ใช้งานอยู่' : 'ถูกระงับ') +
              '</div>' +
            '</div>' +
            '<div class="user-actions">' +
              '<button class="icon-btn" title="เปลี่ยนรหัสผ่าน" onclick="quickResetPassword(\'' + escAttr(u.username) + '\')">🔑</button>' +
              '<button class="icon-btn" title="เปิด/ปิดการใช้งาน" onclick="toggleStatus(\'' + escAttr(u.username) + '\')">' + (isActive ? '⏸' : '▶') + '</button>' +
              '<button class="icon-btn" title="แก้ไข" onclick=\'openUserModal(' + JSON.stringify(u) + ')\'>✎</button>' +
              '<button class="icon-btn" title="ลบ" onclick="confirmDeleteUser(\'' + escAttr(u.username) + '\')">🗑</button>' +
            '</div>' +
          '</div>'
        );
      }).join('');
    }

    function quickResetPassword(username) {
      const newPassword = prompt('ตั้งรหัสผ่านใหม่สำหรับ "' + username + '" (อย่างน้อย 6 ตัวอักษร):');
      if (newPassword === null) return;
      if (newPassword.length < 6) { showToast('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', true); return; }

      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) showToast('เปลี่ยนรหัสผ่านของ ' + username + ' แล้ว');
          else showToast(res.message, true);
        })
        .withFailureHandler(function (err) { showToast(err.message, true); })
        .resetUserPassword(sessionToken, username, newPassword);
    }

    function buildUserGridTable() {
      const table = document.getElementById('userGrid');
      let html = '<thead><tr>' + UG_HEADERS.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
      for (let r = 0; r < ugRowCount; r++) {
        html += '<tr>';
        for (let c = 0; c < UG_COLS.length; c++) {
          const type = UG_COLS[c] === 'password' ? 'text' : 'text';
          html += '<td><input type="' + type + '" id="ucell-' + r + '-' + c + '" data-row="' + r + '" data-col="' + c + '" ' +
            'onpaste="handleUserGridPaste(event,' + r + ',' + c + ')"></td>';
        }
        html += '</tr>';
      }
      table.innerHTML = html + '</tbody>';
    }

    function addUserGridRow() {
      ugRowCount++;
      const values = readUserGridValues();
      buildUserGridTable();
      writeUserGridValues(values);
    }

    function clearUserGrid() {
      if (!confirm('ล้างข้อมูลในตารางทั้งหมด?')) return;
      ugRowCount = 6;
      buildUserGridTable();
      document.getElementById('userGridResults').innerHTML = '';
    }

    function readUserGridValues() {
      const values = [];
      for (let r = 0; r < ugRowCount; r++) {
        const row = [];
        for (let c = 0; c < UG_COLS.length; c++) {
          const input = document.getElementById('ucell-' + r + '-' + c);
          row.push(input ? input.value : '');
        }
        values.push(row);
      }
      return values;
    }

    function writeUserGridValues(values) {
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < UG_COLS.length; c++) {
          const input = document.getElementById('ucell-' + r + '-' + c);
          if (input) input.value = values[r][c] || '';
        }
      }
    }

    function handleUserGridPaste(e, startRow, startCol) {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text) return;
      let rows = text.replace(/\r/g, '').split('\n');
      if (rows.length && rows[rows.length - 1] === '') rows.pop();
      const isMultiCell = rows.length > 1 || rows[0].indexOf('\t') !== -1;
      if (!isMultiCell) return;

      e.preventDefault();
      const neededRows = startRow + rows.length;
      if (neededRows > ugRowCount) {
        const values = readUserGridValues();
        ugRowCount = neededRows;
        buildUserGridTable();
        writeUserGridValues(values);
      }
      rows.forEach(function (rowText, rOffset) {
        const cells = rowText.split('\t');
        const targetRow = startRow + rOffset;
        cells.forEach(function (val, cOffset) {
          const targetCol = startCol + cOffset;
          if (targetCol >= UG_COLS.length) return;
          const input = document.getElementById('ucell-' + targetRow + '-' + targetCol);
          if (input) input.value = val.trim();
        });
      });
    }

    function saveUserGridRows() {
      const values = readUserGridValues();
      const rows = values
        .filter(function (row) { return row.some(function (v) { return v.trim() !== ''; }); })
        .map(function (row) {
          const obj = {};
          UG_COLS.forEach(function (key, i) { obj[key] = row[i].trim(); });
          return obj;
        });

      if (!rows.length) { showToast('ยังไม่มีข้อมูลให้บันทึก', true); return; }

      const btn = document.getElementById('saveUserGridBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';
      document.getElementById('userGridResults').innerHTML = '';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'บันทึกทั้งหมด';
          if (!res.success) { showToast(res.message, true); return; }
          renderUserGridResults(res.results);
          if (res.addedCount > 0) {
            showToast('เพิ่มผู้ใช้สำเร็จ ' + res.addedCount + ' คน');
            loadUserList();
          }
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'บันทึกทั้งหมด';
          showToast('บันทึกไม่สำเร็จ: ' + err.message, true);
        })
        .createUsersBulk(sessionToken, rows);
    }

    function renderUserGridResults(results) {
      const box = document.getElementById('userGridResults');
      const failed = results.filter(function (r) { return !r.success; });
      if (!failed.length) { box.innerHTML = ''; return; }
      box.innerHTML = failed.map(function (r) {
        return '<div class="bulk-result-row fail">แถวที่ ' + r.row + ' (' + escapeHtml(r.username || '-') + ')<span>' + escapeHtml(r.message) + '</span></div>';
      }).join('');
    }

    function toggleStatus(username) {
      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) { showToast('อัปเดตสถานะแล้ว'); loadUserList(); }
          else { showToast(res.message, true); }
        })
        .withFailureHandler(function (err) { showToast(err.message, true); })
        .toggleUserStatus(sessionToken, username);
    }

    function confirmDeleteUser(username) {
      if (!confirm('ยืนยันลบผู้ใช้ "' + username + '" ? การกระทำนี้ไม่สามารถย้อนกลับได้')) return;
      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) { showToast('ลบผู้ใช้แล้ว'); loadUserList(); }
          else { showToast(res.message, true); }
        })
        .withFailureHandler(function (err) { showToast(err.message, true); })
        .deleteUser(sessionToken, username);
    }

    /* ---------- User Modal (Add/Edit) ---------- */
    function openUserModal(user) {
      editingUsername = user ? user.username : null;
      document.getElementById('userModalError').style.display = 'none';
      document.getElementById('userModalTitle').textContent = user ? 'แก้ไขผู้ใช้งาน' : 'เพิ่มผู้ใช้งานใหม่';
      document.getElementById('fUsername').value = user ? user.username : '';
      document.getElementById('fUsername').disabled = !!user;
      document.getElementById('fFirstName').value = user ? user.firstName : '';
      document.getElementById('fLastName').value = user ? user.lastName : '';
      document.getElementById('fPassword').value = '';
      document.getElementById('pwHint').textContent = user ? '(เว้นว่างไว้หากไม่ต้องการเปลี่ยน)' : '';
      document.getElementById('fRole').value = user ? user.role : 'Driver';
      document.getElementById('userModal').classList.add('open');
    }

    function closeUserModal() {
      document.getElementById('userModal').classList.remove('open');
      document.getElementById('fUsername').disabled = false;
    }

    /* ---------- เปลี่ยนรหัสผ่านของตัวเอง (ทุก Role) ---------- */
    function openChangePasswordModal_() {
      document.getElementById('changePasswordError').style.display = 'none';
      document.getElementById('cpOldPassword').value = '';
      document.getElementById('cpNewPassword1').value = '';
      document.getElementById('cpNewPassword2').value = '';
      document.getElementById('changePasswordModal').classList.add('open');
    }

    function closeChangePasswordModal_() {
      document.getElementById('changePasswordModal').classList.remove('open');
    }

    function submitChangePassword_() {
      const oldPassword = document.getElementById('cpOldPassword').value;
      const newPassword1 = document.getElementById('cpNewPassword1').value;
      const newPassword2 = document.getElementById('cpNewPassword2').value;
      const errBox = document.getElementById('changePasswordError');
      const btn = document.getElementById('cpSaveBtn');
      errBox.style.display = 'none';

      if (!oldPassword || !newPassword1 || !newPassword2) {
        errBox.textContent = 'กรุณากรอกข้อมูลให้ครบทุกช่อง';
        errBox.style.display = 'block';
        return;
      }
      if (newPassword1.length < 4) {
        errBox.textContent = 'รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร (เช่น ใช้เบอร์โทรศัพท์ตัวเองก็ได้)';
        errBox.style.display = 'block';
        return;
      }
      if (newPassword1 !== newPassword2) {
        errBox.textContent = 'รหัสผ่านใหม่ทั้ง 2 ช่องไม่ตรงกัน กรุณาพิมพ์ซ้ำอีกครั้ง';
        errBox.style.display = 'block';
        return;
      }
      if (newPassword1 === oldPassword) {
        errBox.textContent = 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม';
        errBox.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="border-color:rgba(255,255,255,.4);border-top-color:#fff;"></span>กำลังบันทึก...';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false; btn.textContent = 'บันทึก';
          if (!res.success) {
            errBox.textContent = res.message || 'เปลี่ยนรหัสผ่านไม่สำเร็จ';
            errBox.style.display = 'block';
            return;
          }
          closeChangePasswordModal_();
          showToast('เปลี่ยนรหัสผ่านสำเร็จ');
        })
        .withFailureHandler(function (err) {
          btn.disabled = false; btn.textContent = 'บันทึก';
          errBox.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
          errBox.style.display = 'block';
        })
        .changeOwnPassword(sessionToken, oldPassword, newPassword1);
    }

    /* =========================================================================
       สุขภาพของฉัน / สุขภาพพนักงาน (Health Checkup Record & Analytics)
       ========================================================================= */
    // ลำดับต้องตรงกับ compareKeys/fieldMap ฝั่ง HealthCheckupAPI.gs เป๊ะ (ใช้ index จับคู่ label กับผลลัพธ์จาก backend)
    const HEALTH_METRIC_LABELS_ = [
      'ดัชนีมวลกาย (BMI)', 'ความดันตัวบน (SBP)', 'ความดันตัวล่าง (DBP)', 'ชีพจร',
      'น้ำตาลในเลือด (FBS)', 'BUN (ไต)', 'Creatinine (ไต)', 'Cholesterol (ไขมัน)', 'Triglyceride (ไขมัน)',
      'SGOT (ตับ)', 'SGPT (ตับ)', 'Hemoglobin', 'WBC'
    ];
    const HEALTH_CATEGORY_FIELDS_ = [
      { key: 'peStatus', label: 'ตรวจร่างกาย' }, { key: 'cbcStatus', label: 'เม็ดเลือด' },
      { key: 'uaStatus', label: 'ปัสสาวะ' }, { key: 'ekgStatus', label: 'คลื่นหัวใจ' },
      { key: 'xrayStatus', label: 'เอกซเรย์ปอด' }, { key: 'biochemStatus', label: 'สารชีวเคมี' },
      { key: 'drugScreenStatus', label: 'สารเสพติด' }, { key: 'hearingStatus', label: 'การได้ยิน' },
      { key: 'lungStatus', label: 'สมรรถภาพปอด' }, { key: 'visionStatus', label: 'สายตา' }
    ];

    let healthCurrentRecords_ = [];
    let healthCurrentIndex_ = 0;
    let healthViewingOwn_ = true;
    let healthTargetName_ = null; // { firstName, lastName } — ใช้ตอน Supervisor ดูของคนอื่น

    function healthStatusPillClass_(status) {
      if (status === 'normal') return 'health-normal';
      if (status === 'high') return 'health-high';
      if (status === 'low') return 'health-low';
      return 'health-unknown';
    }
    function healthStatusText_(status) {
      if (status === 'normal') return 'ปกติ';
      if (status === 'high') return 'สูงกว่าเกณฑ์';
      if (status === 'low') return 'ต่ำกว่าเกณฑ์';
      return 'ไม่มีข้อมูล';
    }
    function healthCategoryClass_(text) {
      const t = String(text || '').trim();
      if (t === 'ปกติ') return 'normal';
      if (t === 'เฝ้าระวัง') return 'watch';
      if (t) return 'abnormal';
      return '';
    }

    /* ---------- ทุก Role: สุขภาพของฉัน (ปุ่มบน topbar) ---------- */
    function openMyHealthPage_() {
      healthViewingOwn_ = true;
      healthTargetName_ = null;
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="renderMain()">← กลับ</button>' +
        '<div class="panel"><div class="panel-title"><h3>สุขภาพของฉัน — ผลตรวจสุขภาพประจำปี</h3></div>' +
          '<p class="panel-hint">ข้อมูลเฉพาะของคุณเท่านั้น อ้างอิงจากชื่อ-นามสกุลที่ลงทะเบียนในระบบ</p>' +
        '</div>' +
        '<div id="healthPageBody"><div class="loading-state"><div class="spinner-lg"></div><p>กำลังโหลดข้อมูลสุขภาพ...</p></div></div>';

      google.script.run
        .withSuccessHandler(function (res) { renderHealthPageResult_(res, true); })
        .withFailureHandler(function (err) {
          document.getElementById('healthPageBody').innerHTML =
            '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getMyHealthCheckup(sessionToken);
    }

    /* ---------- Supervisor: สุขภาพพนักงาน (ตารางรวมทุกคน) ---------- */
    function openHealthSummaryPage_() {
      const el = document.getElementById('mainContent');
      const curYear = new Date().getFullYear();
      let yearOptions = '<option value="">ปีล่าสุดของแต่ละคน</option>';
      for (let y = curYear; y >= curYear - 4; y--) yearOptions += '<option value="' + y + '">' + y + '</option>';

      el.innerHTML =
        '<button type="button" class="back-link" onclick="goSupervisorView(\'menu\')">← กลับเมนูหลัก</button>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>สุขภาพพนักงาน — ผลตรวจสุขภาพประจำปี</h3></div>' +
          '<p class="panel-hint">การเปิดดูข้อมูลของพนักงานแต่ละคนจะถูกบันทึกไว้ในระบบเพื่อความโปร่งใส</p>' +
          '<div class="filter-row" style="margin-bottom:0;">' +
            '<select id="healthSummaryYear" onchange="loadHealthSummary_()">' + yearOptions + '</select>' +
          '</div>' +
        '</div>' +
        '<div id="healthSummaryBody"></div>';

      loadHealthSummary_();
    }

    function loadHealthSummary_() {
      const yearEl = document.getElementById('healthSummaryYear');
      const bodyEl = document.getElementById('healthSummaryBody');
      const year = yearEl ? yearEl.value : '';
      bodyEl.innerHTML = '<div class="loading-state"><div class="spinner-lg"></div><p>กำลังโหลดข้อมูล...</p></div>';

      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { bodyEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดไม่สำเร็จ') + '</div>'; return; }
          if (!res.rows.length) { bodyEl.innerHTML = '<div class="empty-state">ไม่พบข้อมูลผลตรวจสุขภาพ</div>'; return; }

          let html = '<div class="panel"><div class="grid-scroll"><table class="report-table"><thead><tr>' +
            '<th>ชื่อ-นามสกุล</th><th>แผนก</th><th>ปี</th><th>BMI</th><th>ความดัน</th><th>FBS</th><th>สรุปผล</th><th></th>' +
            '</tr></thead><tbody>';
          res.rows.forEach(function (r) {
            const overallClass = healthCategoryClass_(r.overallStatus);
            html += '<tr>' +
              '<td>' + escapeHtml(r.firstName) + ' ' + escapeHtml(r.lastName) + '</td>' +
              '<td>' + escapeHtml(r.department || '') + '</td>' +
              '<td>' + escapeHtml(String(r.year)) + '</td>' +
              '<td>' + escapeHtml(String(r.bmi || '-')) + '</td>' +
              '<td>' + escapeHtml(String(r.sbp || '-')) + '/' + escapeHtml(String(r.dbp || '-')) + '</td>' +
              '<td>' + escapeHtml(String(r.fbs || '-')) + '</td>' +
              '<td><span class="status-pill ' + (overallClass === 'normal' ? 'filled' : overallClass === 'watch' ? 'pending' : 'missed') + '">' + escapeHtml(r.overallStatus || '-') + '</span></td>' +
              '<td><button type="button" class="btn btn-outline btn-sm" onclick="openEmployeeHealthDetail_(\'' + escAttr(r.firstName) + '\', \'' + escAttr(r.lastName) + '\')">ดูรายละเอียด</button></td>' +
            '</tr>';
          });
          html += '</tbody></table></div></div>';
          bodyEl.innerHTML = html;
        })
        .withFailureHandler(function (err) {
          bodyEl.innerHTML = '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getAllEmployeesHealthSummary(sessionToken, year);
    }

    function openEmployeeHealthDetail_(firstName, lastName) {
      healthViewingOwn_ = false;
      healthTargetName_ = { firstName: firstName, lastName: lastName };
      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<button type="button" class="back-link" onclick="openHealthSummaryPage_()">← กลับรายชื่อพนักงาน</button>' +
        '<div class="panel"><div class="panel-title"><h3>สุขภาพของ ' + escapeHtml(firstName) + ' ' + escapeHtml(lastName) + '</h3></div>' +
          '<p class="panel-hint">การเปิดดูหน้านี้ถูกบันทึกไว้ในระบบแล้ว</p>' +
        '</div>' +
        '<div id="healthPageBody"><div class="loading-state"><div class="spinner-lg"></div><p>กำลังโหลดข้อมูลสุขภาพ...</p></div></div>';

      google.script.run
        .withSuccessHandler(function (res) { renderHealthPageResult_(res, false); })
        .withFailureHandler(function (err) {
          document.getElementById('healthPageBody').innerHTML =
            '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getEmployeeHealthDetail(sessionToken, firstName, lastName);
    }

    /* ---------- ส่วน render ที่ใช้ร่วมกันทั้ง "สุขภาพของฉัน" และ "ดูรายละเอียดพนักงาน" ---------- */
    function renderHealthPageResult_(res, isOwn) {
      const bodyEl = document.getElementById('healthPageBody');
      if (!res.success) { bodyEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดไม่สำเร็จ') + '</div>'; return; }
      if (!res.hasData) {
        bodyEl.innerHTML = '<div class="empty-state">ยังไม่มีข้อมูลผลตรวจสุขภาพในระบบ' + (isOwn ? '' : 'สำหรับคนนี้') + '</div>';
        return;
      }
      healthCurrentRecords_ = res.records;
      healthCurrentIndex_ = 0;
      renderHealthRecordView_();
    }

    function renderHealthRecordView_() {
      const bodyEl = document.getElementById('healthPageBody');
      const records = healthCurrentRecords_;
      const record = records[healthCurrentIndex_];
      if (!record) { bodyEl.innerHTML = '<div class="empty-state">ไม่พบข้อมูล</div>'; return; }

      // ประเมินความเสี่ยง/โรคที่ต้องเฝ้าระวังของปีที่กำลังดูอยู่ (คำนวณฝั่งเบราว์เซอร์ทั้งหมด)
      const assess = healthAssessRecord_(record);

      let html = '';

      // ชิปเลือกปี (ถ้ามีมากกว่า 1 ปี)
      if (records.length > 1) {
        html += '<div class="health-year-chips">';
        records.forEach(function (r, i) {
          html += '<button type="button" class="health-year-chip' + (i === healthCurrentIndex_ ? ' active' : '') + '" onclick="selectHealthYear_(' + i + ')">ปี ' + escapeHtml(String(r.year)) + '</button>';
        });
        html += '</div>';
      }

      // สรุปย่อ
      html += '<div class="summary-cards" style="grid-template-columns:repeat(3,1fr);">' +
        summaryCardHtml_(record.bmi || '-', 'BMI') +
        summaryCardHtml_((record.sbp || '-') + '/' + (record.dbp || '-'), 'ความดัน (mmHg)') +
        summaryCardHtml_(record.fbs || '-', 'น้ำตาล FBS (mg/dl)') +
      '</div>';

      // ดัชนีความเสี่ยงรวม (Low / Medium / High)
      html += healthRiskPanelHtml_(assess, record);

      // ตารางค่าตัวชี้วัดพร้อมสถานะ + คำแนะนำ
      html += '<div class="panel"><div class="panel-title"><h3>ผลตรวจปี ' + escapeHtml(String(record.year)) + ' (บริษัท ' + escapeHtml(record.company || '-') + ')</h3></div>';
      (record.analysis || []).forEach(function (item, i) {
        const label = HEALTH_METRIC_LABELS_[i] || item.label;
        const pillClass = healthStatusPillClass_(item.status);
        const refText = (item.status !== 'unknown' && (item.min !== undefined || item.max !== undefined))
          ? 'เกณฑ์ปกติ: ' + (item.min !== undefined && item.min !== 0 ? item.min : (item.min === 0 ? '0' : '')) + (item.min !== undefined && item.max !== undefined ? ' - ' : '') + (item.max !== undefined ? item.max : '') + ' ' + (item.unit || '')
          : '';
        html += '<div class="health-metric-row">' +
          '<div>' +
            '<div class="health-metric-label">' + escapeHtml(label) + '</div>' +
            (refText ? '<div class="health-metric-ref">' + escapeHtml(refText) + '</div>' : '') +
          '</div>' +
          '<div style="text-align:right;">' +
            '<div class="health-metric-value">' + (item.value === '' || item.value === null || item.value === undefined ? '-' : escapeHtml(String(item.value)) + ' ' + escapeHtml(item.unit || '')) + '</div>' +
            '<span class="status-pill ' + pillClass + '">' + healthStatusText_(item.status) + '</span>' +
          '</div>' +
        '</div>' +
        (item.tip ? '<div class="health-metric-tip">💡 ' + escapeHtml(item.tip) + '</div>' : '');
      });
      html += '</div>';

      // สถานะรายหมวด
      html += '<div class="panel"><div class="panel-title"><h3>สรุปผลรายหมวดการตรวจ</h3></div><div class="health-category-grid">';
      HEALTH_CATEGORY_FIELDS_.forEach(function (f) {
        const val = record[f.key] || '-';
        html += '<div class="health-category-chip ' + healthCategoryClass_(val) + '">' +
          '<span class="cat-name">' + escapeHtml(f.label) + '</span><span class="cat-status">' + escapeHtml(val) + '</span>' +
        '</div>';
      });
      html += '</div>';
      if (record.doctorNote) {
        html += '<p class="health-metric-ref" style="margin-top:12px;"><b>ความเห็นแพทย์:</b> ' + escapeHtml(record.doctorNote) + '</p>';
      }
      html += '</div>';

      // โรคที่ต้องเฝ้าระวัง -> ผลกระทบต่อการขับรถ -> แนวโน้มย้อนหลัง -> คำแนะนำที่ทำได้จริง
      html += healthDiseasePanelHtml_(assess);
      html += healthDrivingPanelHtml_(assess);
      html += healthTrendPanelHtml_(record);
      html += healthAdvicePanelHtml_(assess);

      // ปุ่มเทียบปีก่อนหน้า (มีถ้ามีมากกว่า 1 ปี)
      if (records.length > 1) {
        html += '<button class="btn btn-outline" style="width:auto;" onclick="loadHealthYoY_()">📊 เทียบกับปีก่อนหน้า</button>' +
          '<div id="healthYoYArea" style="margin-top:12px;"></div>';
      }

      html += '<div class="health-disclaimer">⚠ ข้อมูลนี้เป็นการเทียบค่ากับเกณฑ์อ้างอิงทางการแพทย์ทั่วไปโดยระบบอัตโนมัติ ไม่ใช่คำวินิจฉัยจากแพทย์ หากผลตรวจผิดปกติควรปรึกษาแพทย์เพื่อการวินิจฉัยและรักษาที่ถูกต้องเสมอ</div>';

      bodyEl.innerHTML = html;
    }

    /* =========================================================================
       ส่วนวิเคราะห์เชิงลึก: แนวโน้มย้อนหลังหลายปี + ดัชนีความเสี่ยงรวม +
       โรคที่ต้องเฝ้าระวัง + ผลกระทบต่อการขับรถ + คำแนะนำปรับพฤติกรรม

       ทั้งหมดคำนวณฝั่งเบราว์เซอร์จาก healthCurrentRecords_ ที่ backend ส่งมาอยู่แล้ว
       (ทุกปีของคนคนนั้น) จึงไม่ต้องแก้ Apps Script หรือ deploy ใหม่
       เกณฑ์ที่ใช้เป็นค่าอ้างอิงทั่วไปสำหรับผู้ใหญ่ ไม่ใช่การวินิจฉัยของแพทย์
       ถ้าปีหน้าอยากปรับเกณฑ์ ให้แก้ที่ HEALTH_RISK_RULES_ / HEALTH_DISEASE_DEF_ จุดเดียว
       ========================================================================= */

    /** เพศในไฟล์ผลตรวจเป็นภาษาไทย ('ชาย'/'หญิง') — บางเกณฑ์ (Hb, Creatinine) ต่างกันตามเพศ */
    /* =========================================================================
       โมดูลจองคิวซ่อมบำรุง + ปฏิทินงานช่าง
       - คนขับ/หัวหน้างาน: แจ้งซ่อม + เลือกวันที่ที่คิวยังว่าง (Slot Limit Engine)
       - ช่าง/หัวหน้างาน/Admin: ปฏิทินงานรายวัน-รายสัปดาห์ + อัปเดตสถานะงาน
       backend อยู่ในไฟล์ MaintenanceAPI.gs
       ========================================================================= */

    const MAINT_SEVERITY_META_ = {
      1: { icon: '🟢', cls: 'sev1', label: 'ระดับ 1 — งานเล็กน้อย', hint: 'เช่น เปลี่ยนหลอดไฟ เติมลม ขันน็อต เช็คทั่วไป' },
      2: { icon: '🟡', cls: 'sev2', label: 'ระดับ 2 — งานปานกลาง', hint: 'เช่น เปลี่ยนผ้าเบรก เปลี่ยนถ่ายน้ำมันเครื่อง ซ่อมระบบไฟ' },
      3: { icon: '🔴', cls: 'sev3', label: 'ระดับ 3 — งานหนัก / ฉุกเฉินวิกฤต', hint: 'เช่น เครื่องยนต์ เกียร์ ระบบเบรกมีปัญหา — ห้ามฝืนใช้งานรถ' }
    };

    const MAINT_STATUS_META_ = {
      Pending:    { label: 'รอซ่อม',      cls: 'st-pending',  next: 'InProgress', nextLabel: '▶ เริ่มซ่อม' },
      InProgress: { label: 'กำลังซ่อม',   cls: 'st-progress', next: 'Completed',  nextLabel: '✔ ซ่อมเสร็จแล้ว' },
      Completed:  { label: 'ซ่อมเสร็จ',   cls: 'st-done',     next: '',           nextLabel: '' }, // เฟส 1: ปิดงานเลย ไม่มีปุ่มส่งมอบแยกแล้ว
      HandedOver: { label: 'ส่งมอบแล้ว',  cls: 'st-handed',   next: '',           nextLabel: '' }, // เหลือไว้แสดงงานเก่าเฉยๆ
      Cancelled:  { label: 'ยกเลิกแล้ว',  cls: 'st-cancel',   next: '',           nextLabel: '' }
    };

    let maintFormData_ = null;
    let maintSeverity_ = 0;
    let maintSelectedDate_ = '';
    let maintSelectedSlot_ = '';   // เฟส 3: รอบเวลาที่เลือก (HH:MM) — ใช้เฉพาะ severity 1/2
    let maintLastSlotsRes_ = null; // เฟส 3: cache ผลลัพธ์รอบเวลาล่าสุด ไว้ re-render ตอนกดเลือก โดยไม่ต้องยิง API ซ้ำ
    let maintCalMode_ = 'day';      // day | week
    let maintCalAnchor_ = '';       // YYYY-MM-DD ของวันที่กำลังดู
    let maintCalBack_ = '';
    let maintBookingBackOnclick_ = '';   // ปุ่มย้อนกลับของหน้าจอง ต่าง Role กัน เก็บไว้จะได้ไม่หลุดตอน re-render

    function maintMinutesText_(min) {
      const m = Number(min) || 0;
      if (m < 60) return m + ' นาที';
      const h = Math.floor(m / 60), r = m % 60;
      return h + ' ชม.' + (r ? ' ' + r + ' นาที' : '');
    }

    function maintTodayISO_() {
      const d = new Date();
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    function maintAddDays_(iso, n) {
      const p = iso.split('-');
      const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      d.setDate(d.getDate() + n);
      return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    }

    /* =========================================================================
       ฝั่งคนขับ: ฟอร์มแจ้งซ่อม / จองคิว
       ========================================================================= */
    function renderMaintenanceBookingPage_(backOnclick) {
      maintBookingBackOnclick_ = backOnclick || '';
      const el = document.getElementById('mainContent');
      el.innerHTML =
        (backOnclick ? '<button type="button" class="back-link" onclick="' + backOnclick + '">← กลับ</button>' : '') +
        '<div id="maintBookingBody"><div class="loading-state"><div class="spinner-lg"></div><p>กำลังโหลดคิวซ่อม...</p></div></div>';

      google.script.run
        .withSuccessHandler(function (res) {
          const body = document.getElementById('maintBookingBody');
          if (!body) return;
          if (!res || !res.success) {
            body.innerHTML = '<div class="empty-state">' + escapeHtml((res && res.message) || 'โหลดข้อมูลไม่สำเร็จ') + '</div>';
            return;
          }
          maintFormData_ = res;
          maintSeverity_ = 0;
          maintSelectedDate_ = '';
          maintSelectedSlot_ = '';
          maintLastSlotsRes_ = null;
          body.innerHTML = maintBookingFormHtml_(res) + maintMyBookingsHtml_(res.myBookings);
        })
        .withFailureHandler(function (err) {
          const body = document.getElementById('maintBookingBody');
          if (body) body.innerHTML = '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getMaintenanceFormData(sessionToken);
    }

    function maintBookingFormHtml_(data) {
      const plateOptions = data.plates.map(function (p) {
        return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>';
      }).join('');
      // เฟส 2: ต่อท้ายชื่อหมวดด้วยไอคอนสี ให้คนขับเห็นระดับความสำคัญตอนเลือกเลย ไม่ต้องกดเลือกเอง
      const catOptions = data.categories.map(function (c) {
        const sev = data.categorySeverity[c] || 2;
        const icon = MAINT_SEVERITY_META_[sev].icon;
        return '<option value="' + escapeHtml(c) + '">' + icon + ' ' + escapeHtml(c) + '</option>';
      }).join('');

      return '<div class="panel">' +
        '<div class="panel-title"><h3>แจ้งซ่อม / จองคิวเข้าอู่</h3></div>' +
        '<p class="panel-hint">เลือกหมวดหมู่อาการเสีย ระบบจะกำหนดระดับความสำคัญและเวลาซ่อมให้อัตโนมัติ แล้วแสดงเฉพาะวันที่คิวยังว่างให้เลือก</p>' +

        '<div class="field"><label>ทะเบียนรถ</label>' +
          '<select id="maintPlate" onchange="maintTogglePlateInput_()">' +
            '<option value="">— เลือกทะเบียนรถ —</option>' + plateOptions +
            '<option value="__other__">อื่นๆ (พิมพ์เอง)</option>' +
          '</select>' +
          '<input type="text" id="maintPlateOther" placeholder="เช่น 71-1645" style="display:none;margin-top:8px;">' +
        '</div>' +

        '<div class="field"><label>หมวดหมู่อาการเสีย</label>' +
          '<select id="maintCategory" onchange="maintOnCategoryChange_()"><option value="">— เลือกหมวดหมู่ —</option>' + catOptions + '</select>' +
          '<div id="maintSevBadge" class="maint-sev-badge" style="display:none;"></div>' +
        '</div>' +

        '<div class="field"><label>รายละเอียดอาการที่พบ</label>' +
          '<textarea id="maintSymptom" rows="3" class="maint-textarea" placeholder="เช่น เบรกมีเสียงดังตอนเหยียบ ลึกกว่าปกติ เริ่มเป็นตั้งแต่เมื่อวาน"></textarea>' +
        '</div>' +

        '<div class="field"><label>วันที่ต้องการเข้าซ่อม</label>' +
          '<div id="maintDayPicker" class="maint-day-picker">' +
            '<div class="empty-state" style="margin:0;">เลือกหมวดหมู่อาการก่อน ระบบจะแสดงวันที่ที่คิวว่างพอ</div>' +
          '</div>' +
        '</div>' +

        '<div class="field"><label>รอบเวลาที่ต้องการเข้าซ่อม</label>' +
          '<div id="maintSlotPicker" class="maint-slot-picker" style="display:none;"></div>' +
        '</div>' +

        '<div id="maintBookingMsg" class="hi-status"></div>' +
        '<button type="button" class="btn btn-primary" id="maintSubmitBtn" onclick="maintSubmitBooking_()">ยืนยันจองคิวซ่อม</button>' +
      '</div>';
    }

    function maintTogglePlateInput_() {
      const sel = document.getElementById('maintPlate');
      const other = document.getElementById('maintPlateOther');
      other.style.display = sel.value === '__other__' ? 'block' : 'none';
    }

    /** เฟส 2: แทนที่ maintSelectSeverity_ เดิม — สีความสำคัญมาจากหมวดหมู่ที่เลือกเสมอ คนขับไม่ต้องกดเลือกเอง */
    function maintOnCategoryChange_() {
      const cat = document.getElementById('maintCategory').value;
      const badge = document.getElementById('maintSevBadge');
      const slotHolder = document.getElementById('maintSlotPicker');
      maintSelectedDate_ = '';
      maintSelectedSlot_ = '';
      maintLastSlotsRes_ = null;
      if (slotHolder) { slotHolder.style.display = 'none'; slotHolder.innerHTML = ''; }

      if (!cat || !maintFormData_) {
        maintSeverity_ = 0;
        badge.style.display = 'none';
        maintRenderDayPicker_();
        return;
      }

      maintSeverity_ = maintFormData_.categorySeverity[cat] || 2;
      const m = MAINT_SEVERITY_META_[maintSeverity_];
      badge.style.display = 'block';
      badge.className = 'maint-sev-badge ' + m.cls;
      badge.innerHTML = m.icon + ' ' + escapeHtml(m.label) + ' · ประเมิน ≈ ' + maintMinutesText_(maintFormData_.severityMinutes[maintSeverity_]) + (maintSeverity_ === 3 ? ' ขึ้นไป' : '');
      maintRenderDayPicker_();
    }

    /** วาดชิปวันที่: วันที่เหลือเวลาไม่พอจะกดไม่ได้ ยกเว้นงานระดับ 3 ที่แทรกฉุกเฉินได้ */
    function maintRenderDayPicker_() {
      const holder = document.getElementById('maintDayPicker');
      if (!holder || !maintFormData_ || !maintSeverity_) return;
      const need = maintFormData_.severityMinutes[maintSeverity_];

      holder.innerHTML = maintFormData_.days.map(function (d) {
        const enough = d.remainingMinutes >= need && d.jobCount < d.maxJobs;
        const emergency = !enough && maintSeverity_ === 3;
        const disabled = !enough && !emergency;
        const pctUsed = Math.min(100, Math.round(d.usedMinutes * 100 / d.capacityMinutes));
        return '<button type="button" class="maint-day' +
            (disabled ? ' full' : '') + (emergency ? ' emergency' : '') +
            (maintSelectedDate_ === d.dateISO ? ' active' : '') + '"' +
            (disabled ? ' disabled' : ' onclick="maintSelectDay_(\'' + d.dateISO + '\')"') + '>' +
          '<div class="md-date">' + escapeHtml(d.dateText) + (d.isToday ? ' <span class="md-today">วันนี้</span>' : '') + '</div>' +
          '<div class="md-bar"><span style="width:' + pctUsed + '%;"></span></div>' +
          '<div class="md-meta">' +
            (disabled ? 'คิวเต็ม' : (emergency ? 'เต็มแล้ว — แทรกฉุกเฉิน' : 'ว่าง ' + maintMinutesText_(d.remainingMinutes))) +
            ' · ' + d.jobCount + '/' + d.maxJobs + ' คัน' +
          '</div>' +
        '</button>';
      }).join('');

      const anyFree = maintFormData_.days.some(function (d) {
        return d.remainingMinutes >= need && d.jobCount < d.maxJobs;
      });
      if (!anyFree && maintSeverity_ !== 3) {
        holder.innerHTML += '<div class="maint-nofree">คิวเต็มทุกวันในช่วงที่เปิดจอง กรุณาแจ้งหัวหน้างานเพื่อจัดคิวเพิ่ม</div>';
      }
    }

    function maintSelectDay_(iso) {
      maintSelectedDate_ = iso;
      maintSelectedSlot_ = '';
      maintRenderDayPicker_();
      const day = maintFormData_.days.filter(function (d) { return d.dateISO === iso; })[0];
      const need = maintFormData_.severityMinutes[maintSeverity_];
      if (day && (day.remainingMinutes < need || day.jobCount >= day.maxJobs)) {
        maintMsg_('วันนี้คิวเต็มแล้ว ระบบจะแทรกให้เพราะเป็นงานฉุกเฉินระดับ 3 — ช่างจะเห็นธงเตือนและติดต่อกลับเพื่อยืนยันเวลา', 'warn');
      } else {
        maintMsg_('');
      }
      maintLoadSlots_(iso);
    }

    /** เฟส 3: โหลดรอบเวลาที่ว่างของวัน+หมวดที่เลือก — severity 3 (แดง) ข้ามไปเลย ไม่ต้องเลือกเวลา */
    function maintLoadSlots_(iso) {
      const holder = document.getElementById('maintSlotPicker');
      if (!holder) return;
      maintLastSlotsRes_ = null;

      if (maintSeverity_ === 3) {
        holder.style.display = 'block';
        holder.innerHTML = '<div class="maint-slot-emergency">🔴 งานฉุกเฉิน ไม่ต้องเลือกเวลา ระบบจะจัดให้เป็นลำดับแรกของวันอัตโนมัติ</div>';
        return;
      }

      const category = document.getElementById('maintCategory').value;
      holder.style.display = 'block';
      holder.innerHTML = '<div class="loading-state" style="padding:16px;"><div class="spinner-lg"></div></div>';

      google.script.run
        .withSuccessHandler(function (res) {
          // กันเคส user เปลี่ยนวัน/หมวดหมู่ไปแล้วระหว่างที่ request เก่ายังโหลดไม่เสร็จ
          if (maintSelectedDate_ !== iso || document.getElementById('maintCategory').value !== category) return;
          maintLastSlotsRes_ = res;
          maintRenderSlotPicker_();
        })
        .withFailureHandler(function (err) {
          holder.innerHTML = '<div class="empty-state">โหลดรอบเวลาไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getAvailableMaintenanceSlots(sessionToken, iso, category);
    }

    function maintRenderSlotPicker_() {
      const holder = document.getElementById('maintSlotPicker');
      const res = maintLastSlotsRes_;
      if (!holder || !res) return;
      if (!res.success) {
        holder.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดรอบเวลาไม่สำเร็จ') + '</div>';
        return;
      }
      if (!res.slots.length) {
        holder.innerHTML = '<div class="maint-nofree">วันนี้ไม่มีรอบเวลาว่างพอสำหรับงานนี้แล้ว กรุณาเลือกวันอื่น</div>';
        return;
      }
      holder.innerHTML = '<div class="maint-slot-grid">' +
        res.slots.map(function (s) {
          return '<button type="button" class="maint-slot' +
              (!s.available ? ' full' : '') + (maintSelectedSlot_ === s.start ? ' active' : '') + '"' +
              (!s.available ? ' disabled' : ' onclick="maintSelectSlot_(\'' + s.start + '\')"') + '>' +
            s.start + '–' + s.end +
          '</button>';
        }).join('') +
      '</div>';
    }

    function maintSelectSlot_(start) {
      maintSelectedSlot_ = start;
      maintRenderSlotPicker_();
      maintMsg_('');
    }

    function maintMsg_(text, kind) {
      const el = document.getElementById('maintBookingMsg');
      if (!el) return;
      el.className = 'hi-status' + (kind ? ' hi-' + kind : '');
      el.innerHTML = text ? escapeHtml(text) : '';
    }

    function maintSubmitBooking_() {
      const plateSel = document.getElementById('maintPlate').value;
      const plate = plateSel === '__other__' ? document.getElementById('maintPlateOther').value.trim() : plateSel;
      const category = document.getElementById('maintCategory').value;
      const symptom = document.getElementById('maintSymptom').value.trim();

      if (!plate) { maintMsg_('กรุณาเลือกหรือพิมพ์ทะเบียนรถ', 'err'); return; }
      if (!category) { maintMsg_('กรุณาเลือกหมวดหมู่อาการเสีย', 'err'); return; }
      if (!symptom) { maintMsg_('กรุณาพิมพ์รายละเอียดอาการที่พบ', 'err'); return; }
      if (!maintSelectedDate_) { maintMsg_('กรุณาเลือกวันที่ต้องการเข้าซ่อม', 'err'); return; }
      if (maintSeverity_ !== 3 && !maintSelectedSlot_) { maintMsg_('กรุณาเลือกรอบเวลาที่ต้องการเข้าซ่อม', 'err'); return; }

      const btn = document.getElementById('maintSubmitBtn');
      btn.disabled = true;
      maintMsg_('กำลังจองคิว...');

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          if (!res || !res.success) { maintMsg_((res && res.message) || 'จองคิวไม่สำเร็จ', 'err'); return; }
          showToast('จองคิวซ่อมสำเร็จ');
          maintMsg_(res.message, res.overbooked ? 'warn' : 'ok');
          // โหลดใหม่ทั้งหน้าเพื่อให้โควตาของทุกวันอัปเดตตรงกับของจริง
          renderMaintenanceBookingPage_(maintBookingBack_());
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          maintMsg_('จองคิวไม่สำเร็จ: ' + err.message, 'err');
        })
        .createMaintenanceBooking(sessionToken, {
          dateISO: maintSelectedDate_, plateNumber: plate,
          category: category, symptom: symptom,
          slotStart: maintSeverity_ === 3 ? '' : maintSelectedSlot_
        });
    }

    function maintBookingBack_() { return maintBookingBackOnclick_; }

    function maintMyBookingsHtml_(bookings) {
      if (!bookings || !bookings.length) {
        return '<div class="panel"><div class="panel-title"><h3>คิวซ่อมของฉัน</h3></div>' +
          '<div class="empty-state">ยังไม่เคยจองคิวซ่อม</div></div>';
      }
      const rows = bookings.map(function (b) {
        const sev = MAINT_SEVERITY_META_[b.severity] || MAINT_SEVERITY_META_[1];
        const st = MAINT_STATUS_META_[b.status] || MAINT_STATUS_META_.Pending;
        return '<div class="maint-mine ' + sev.cls + '">' +
          '<div class="mm-head">' +
            '<span class="mm-plate">' + sev.icon + ' ' + escapeHtml(b.plateNumber) + '</span>' +
            '<span class="maint-status ' + st.cls + '">' + st.label + '</span>' +
          '</div>' +
          '<div class="mm-meta">' + escapeHtml(b.dateText) + ' · ' + escapeHtml(b.category) + ' · ประเมิน ' + maintMinutesText_(b.estimatedMinutes) + '</div>' +
          '<div class="mm-symptom">' + escapeHtml(b.symptom) + '</div>' +
          (b.mechanicNote ? '<div class="mm-note">🔧 ช่าง: ' + escapeHtml(b.mechanicNote) + '</div>' : '') +
          (b.status === 'Pending'
            ? '<button type="button" class="btn btn-outline mm-cancel" onclick="maintCancelBooking_(\'' + b.id + '\')">ยกเลิกใบจองนี้</button>'
            : '') +
        '</div>';
      }).join('');
      return '<div class="panel"><div class="panel-title"><h3>คิวซ่อมของฉัน</h3></div>' + rows + '</div>';
    }

    function maintCancelBooking_(id) {
      if (!confirm('ยืนยันยกเลิกใบจองนี้?')) return;
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res || !res.success) { showToast((res && res.message) || 'ยกเลิกไม่สำเร็จ', true); return; }
          showToast('ยกเลิกใบจองแล้ว');
          renderMaintenanceBookingPage_(maintBookingBack_());
        })
        .withFailureHandler(function (err) { showToast('ยกเลิกไม่สำเร็จ: ' + err.message, true); })
        .cancelMaintenanceBooking(sessionToken, id, '');
    }

    /* =========================================================================
       ฝั่งช่าง: ปฏิทินงานซ่อม (รายวัน / รายสัปดาห์)
       ========================================================================= */
    function renderMaintenanceCalendarPage_(targetId, backOnclick) {
      maintCalBack_ = backOnclick || '';
      const el = document.getElementById(targetId || 'mainContent');
      if (!el) return;
      el.innerHTML =
        (maintCalBack_ ? '<button type="button" class="back-link" onclick="' + maintCalBack_ + '">← กลับ</button>' : '') +
        '<div id="maintCalBody"><div class="loading-state"><div class="spinner-lg"></div><p>กำลังโหลดตารางงานซ่อม...</p></div></div>';
      // เปิดหน้าครั้งแรก (หรือกลับมาเปิดใหม่) ให้ "วันนี้" ยึดตามนาฬิกาของเซิร์ฟเวอร์เสมอ ไม่ใช่เครื่องผู้ใช้ —
      // กันปฏิทินไปเปิดวันผิดเพราะเครื่อง/เบราว์เซอร์ตั้งเขตเวลาไม่ตรงกับ Apps Script แล้วมองไม่เห็นงานที่เพิ่งจอง
      maintCalAnchor_ = '';
      maintLoadCalendar_();
    }

    function maintCalRange_() {
      // ยังไม่รู้ว่า "วันนี้" ของเซิร์ฟเวอร์คือวันไหน (ครั้งแรกที่เปิดหน้า) — ส่ง from/to ว่างไปก่อน
      // ให้ backend เป็นคนตัดสินแทน แล้วค่อย sync มาเก็บไว้ที่ maintCalAnchor_ ตอนได้ผลลัพธ์กลับมา
      if (!maintCalAnchor_) return { from: '', to: '' };
      if (maintCalMode_ === 'day') return { from: maintCalAnchor_, to: maintCalAnchor_ };
      // รายสัปดาห์: เริ่มวันจันทร์ของสัปดาห์ที่ anchor อยู่
      const p = maintCalAnchor_.split('-');
      const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      const shift = (d.getDay() + 6) % 7; // จันทร์ = 0
      const from = maintAddDays_(maintCalAnchor_, -shift);
      return { from: from, to: maintAddDays_(from, 6) };
    }

    function maintLoadCalendar_() {
      const body = document.getElementById('maintCalBody');
      if (!body) return;
      const range = maintCalRange_();
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res || !res.success) {
            body.innerHTML = '<div class="empty-state">' + escapeHtml((res && res.message) || 'โหลดไม่สำเร็จ') + '</div>';
            return;
          }
          // sync "วันนี้" ให้ตรงกับเซิร์ฟเวอร์เสมอ — ถ้าตอนขอไปยังไม่ได้ระบุ from/to (เปิดหน้าครั้งแรก/กด "วันนี้")
          // ตัว anchor จะถูกตั้งจาก res.todayISO ตรงนี้ แล้วค่อยเปลี่ยนโหมด/เลื่อนวันจากจุดนี้ต่อไป
          if (!maintCalAnchor_) maintCalAnchor_ = res.todayISO;
          body.innerHTML = maintCalendarHtml_(res);
        })
        .withFailureHandler(function (err) {
          body.innerHTML = '<div class="empty-state">โหลดไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getMaintenanceCalendar(sessionToken, range.from, range.to);
    }

    function maintSetCalMode_(mode) { maintCalMode_ = mode; maintLoadCalendar_(); }
    function maintShiftCal_(step) {
      maintCalAnchor_ = maintAddDays_(maintCalAnchor_, maintCalMode_ === 'day' ? step : step * 7);
      maintLoadCalendar_();
    }
    function maintGoToday_() { maintCalAnchor_ = ''; maintLoadCalendar_(); } // ให้เซิร์ฟเวอร์เป็นคนบอกว่า "วันนี้" คือวันไหน เหมือนตอนเปิดหน้าครั้งแรก

    function maintCalendarHtml_(res) {
      const byDay = {};
      res.bookings.forEach(function (b) {
        if (!byDay[b.dateISO]) byDay[b.dateISO] = [];
        byDay[b.dateISO].push(b);
      });

      let html = '<div class="panel maint-cal-head">' +
        '<div class="maint-cal-toolbar">' +
          '<div class="maint-mode">' +
            '<button type="button" class="tab-btn' + (maintCalMode_ === 'day' ? ' active' : '') + '" onclick="maintSetCalMode_(\'day\')">รายวัน</button>' +
            '<button type="button" class="tab-btn' + (maintCalMode_ === 'week' ? ' active' : '') + '" onclick="maintSetCalMode_(\'week\')">รายสัปดาห์</button>' +
          '</div>' +
          '<div class="maint-nav">' +
            '<button type="button" class="maint-nav-btn" onclick="maintShiftCal_(-1)">‹</button>' +
            '<button type="button" class="maint-nav-btn today" onclick="maintGoToday_()">วันนี้</button>' +
            '<button type="button" class="maint-nav-btn" onclick="maintShiftCal_(1)">›</button>' +
          '</div>' +
        '</div>' +
        '<div class="maint-legend">' +
          '<span class="maint-chip sev1">🟢 งานเล็กน้อย</span>' +
          '<span class="maint-chip sev2">🟡 งานปานกลาง</span>' +
          '<span class="maint-chip sev3">🔴 งานหนัก/ฉุกเฉิน</span>' +
        '</div>' +
      '</div>';

      html += res.days.map(function (d) {
        const jobs = byDay[d.dateISO] || [];
        const pct = Math.min(100, Math.round(d.usedMinutes * 100 / d.capacityMinutes));
        const cards = jobs.length
          ? jobs.map(function (b) { return maintJobCardHtml_(b, res.canEdit); }).join('')
          : '<div class="empty-state" style="margin:0;">ไม่มีงานซ่อมในวันนี้</div>';

        return '<div class="panel maint-day-panel' + (d.isToday ? ' is-today' : '') + '">' +
          '<div class="maint-day-head">' +
            '<div>' +
              '<div class="mdh-date">' + escapeHtml(d.dateText) + (d.isToday ? ' <span class="md-today">วันนี้</span>' : '') + '</div>' +
              '<div class="mdh-meta">' + d.jobCount + '/' + d.maxJobs + ' คัน · ' +
                maintMinutesText_(d.usedMinutes) + ' / ' + maintMinutesText_(d.capacityMinutes) + '</div>' +
            '</div>' +
            (d.over ? '<span class="maint-over-flag">⚠ งานล้นโควตา</span>' : '') +
          '</div>' +
          '<div class="maint-cap-bar' + (d.over ? ' over' : '') + '"><span style="width:' + pct + '%;"></span></div>' +
          '<div class="maint-job-list">' + cards + '</div>' +
        '</div>';
      }).join('');

      return html;
    }

    function maintJobCardHtml_(b, canEdit) {
      const sev = MAINT_SEVERITY_META_[b.severity] || MAINT_SEVERITY_META_[1];
      const st = MAINT_STATUS_META_[b.status] || MAINT_STATUS_META_.Pending;

      let actions = '';
      if (canEdit && st.next) {
        actions += '<button type="button" class="maint-act primary" onclick="maintUpdateStatus_(\'' + b.id + '\',\'' + st.next + '\')">' + st.nextLabel + '</button>';
      }
      if (canEdit) {
        actions += '<button type="button" class="maint-act" onclick="maintOpenNote_(\'' + b.id + '\',\'' + b.status + '\')">📝 บันทึกช่าง</button>';
      }

      return '<div class="maint-job ' + sev.cls + '">' +
        '<div class="mj-top">' +
          '<span class="mj-plate">' + sev.icon + ' ' + escapeHtml(b.plateNumber) + '</span>' +
          '<span class="maint-status ' + st.cls + '">' + st.label + '</span>' +
        '</div>' +
        '<div class="mj-time">🕒 ' + escapeHtml(b.planStart || '-') + ' - ' + escapeHtml(b.planEnd || '-') +
          ' · ประเมิน ' + maintMinutesText_(b.estimatedMinutes) + '</div>' +
        '<div class="mj-driver">👤 ' + escapeHtml(b.driverName || b.driverUsername) + '</div>' +
        '<div class="mj-cat">' + escapeHtml(b.category) + '</div>' +
        '<div class="mj-symptom">' + escapeHtml(b.symptom) + '</div>' +
        (b.overbooked ? '<div class="mj-overbooked">⚠ งานแทรกฉุกเฉิน — วันนี้คิวเกินโควตาปกติ</div>' : '') +
        (b.mechanicNote ? '<div class="mj-note">📝 ' + escapeHtml(b.mechanicNote) + '</div>' : '') +
        (actions ? '<div class="mj-actions">' + actions + '</div>' : '') +
      '</div>';
    }

    function maintUpdateStatus_(id, status) {
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res || !res.success) { showToast((res && res.message) || 'อัปเดตไม่สำเร็จ', true); return; }
          showToast('อัปเดตสถานะแล้ว');
          maintLoadCalendar_();
        })
        .withFailureHandler(function (err) { showToast('อัปเดตไม่สำเร็จ: ' + err.message, true); })
        .updateMaintenanceStatus(sessionToken, id, status, '', null);
    }

    /** บันทึกของช่าง + แก้เวลาที่ใช้จริง (งานระดับ 3 มักใช้เวลาต่างจากที่ประเมินไว้) */
    function maintOpenNote_(id, currentStatus) {
      const note = prompt('บันทึกของช่าง (สิ่งที่ทำ / อะไหล่ที่เปลี่ยน / สิ่งที่ต้องตามต่อ):', '');
      if (note === null) return;
      const mins = prompt('เวลาที่ใช้จริง (นาที) — เว้นว่างถ้าใช้ตามที่ประเมินไว้:', '');
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res || !res.success) { showToast((res && res.message) || 'บันทึกไม่สำเร็จ', true); return; }
          showToast('บันทึกเรียบร้อย');
          maintLoadCalendar_();
        })
        .withFailureHandler(function (err) { showToast('บันทึกไม่สำเร็จ: ' + err.message, true); })
        .updateMaintenanceStatus(sessionToken, id, currentStatus || 'Pending', note, mins ? Number(mins) : null);
    }

    function healthIsMale_(record) {
      const g = String(record && record.gender || '').trim();
      return g.indexOf('ช') === 0 || g.toLowerCase().indexOf('m') === 0;
    }

    function healthNum_(v) {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return isNaN(n) ? null : n;
    }

    /* ---------- กฎประเมินค่าแต่ละตัว ----------
       level: 'normal' | 'watch' | 'risk'      points = น้ำหนักที่ใช้คิดดัชนีความเสี่ยงรวม
       band  = ช่วงปกติที่ใช้วาดแถบเขียวในกราฟแนวโน้ม
       critical = true คือค่าที่ควรให้แพทย์ประเมินก่อนขึ้นขับรถ (ใช้ในหัวข้อ Fit to Drive) */
    const HEALTH_RISK_RULES_ = [
      {
        key: 'bmi', maxPoints: 15, label: 'ดัชนีมวลกาย (BMI)', unit: '', decimals: 1, band: [18.5, 22.9], disease: 'metabolic',
        evaluate: function (v) {
          if (v >= 30) return { level: 'risk', points: 15, note: 'อ้วนระดับ 2 ขึ้นไป' };
          if (v >= 25) return { level: 'risk', points: 10, note: 'อ้วน' };
          if (v >= 23) return { level: 'watch', points: 5, note: 'น้ำหนักเกิน' };
          if (v < 18.5) return { level: 'watch', points: 5, note: 'ผอมกว่าเกณฑ์' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'sbp', maxPoints: 30, label: 'ความดันตัวบน (SBP)', unit: 'mmHg', decimals: 0, band: [90, 129], disease: 'hypertension',
        evaluate: function (v) {
          if (v >= 180) return { level: 'risk', points: 30, critical: true, note: 'ความดันสูงมาก' };
          if (v >= 140) return { level: 'risk', points: 18, note: 'ความดันโลหิตสูง' };
          if (v >= 130) return { level: 'watch', points: 8, note: 'เริ่มสูง' };
          if (v < 90) return { level: 'watch', points: 6, note: 'ความดันต่ำ' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'dbp', maxPoints: 25, label: 'ความดันตัวล่าง (DBP)', unit: 'mmHg', decimals: 0, band: [60, 84], disease: 'hypertension',
        evaluate: function (v) {
          if (v >= 110) return { level: 'risk', points: 25, critical: true, note: 'ความดันล่างสูงมาก' };
          if (v >= 90) return { level: 'risk', points: 14, note: 'ความดันล่างสูง' };
          if (v >= 85) return { level: 'watch', points: 6, note: 'เริ่มสูง' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'pulse', maxPoints: 8, label: 'ชีพจร', unit: 'ครั้ง/นาที', decimals: 0, band: [60, 100], disease: null,
        evaluate: function (v) {
          if (v > 110 || v < 45) return { level: 'risk', points: 8, note: 'ชีพจรผิดจังหวะจากเกณฑ์มาก' };
          if (v > 100 || v < 50) return { level: 'watch', points: 4, note: 'นอกเกณฑ์เล็กน้อย' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'fbs', maxPoints: 30, label: 'น้ำตาลในเลือด (FBS)', unit: 'mg/dl', decimals: 0, band: [70, 99], disease: 'diabetes',
        evaluate: function (v) {
          if (v >= 200) return { level: 'risk', points: 30, critical: true, note: 'น้ำตาลสูงมาก' };
          if (v >= 126) return { level: 'risk', points: 20, note: 'อยู่ในเกณฑ์เบาหวาน' };
          if (v >= 100) return { level: 'watch', points: 8, note: 'ภาวะก่อนเบาหวาน' };
          if (v < 70) return { level: 'risk', points: 15, critical: true, note: 'น้ำตาลต่ำ เสี่ยงหน้ามืด/วูบ' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'cholesterol', maxPoints: 14, label: 'คอเลสเตอรอล', unit: 'mg/dl', decimals: 0, band: [0, 200], disease: 'cardiovascular',
        evaluate: function (v) {
          if (v >= 240) return { level: 'risk', points: 14, note: 'สูง' };
          if (v >= 200) return { level: 'watch', points: 7, note: 'เริ่มสูง' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'triglyceride', maxPoints: 18, label: 'ไตรกลีเซอไรด์', unit: 'mg/dl', decimals: 0, band: [0, 150], disease: 'cardiovascular',
        evaluate: function (v) {
          if (v >= 500) return { level: 'risk', points: 18, note: 'สูงมาก เสี่ยงตับอ่อนอักเสบ' };
          if (v >= 200) return { level: 'risk', points: 12, note: 'สูง' };
          if (v >= 150) return { level: 'watch', points: 6, note: 'เริ่มสูง' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'sgot', maxPoints: 14, label: 'SGOT (ตับ)', unit: 'U/L', decimals: 0, band: [0, 40], disease: 'liver',
        evaluate: function (v) {
          if (v > 80) return { level: 'risk', points: 14, note: 'สูงกว่าเกณฑ์มาก' };
          if (v > 40) return { level: 'watch', points: 7, note: 'สูงกว่าเกณฑ์' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'sgpt', maxPoints: 14, label: 'SGPT (ตับ)', unit: 'U/L', decimals: 0, band: [0, 40], disease: 'liver',
        evaluate: function (v) {
          if (v > 80) return { level: 'risk', points: 14, note: 'สูงกว่าเกณฑ์มาก' };
          if (v > 40) return { level: 'watch', points: 7, note: 'สูงกว่าเกณฑ์' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'bun', maxPoints: 12, label: 'BUN (ไต)', unit: 'mg/dl', decimals: 0, band: [7, 20], disease: 'kidney',
        evaluate: function (v) {
          if (v > 26 || v < 5) return { level: 'risk', points: 12, note: 'ผิดปกติชัดเจน' };
          if (v > 20) return { level: 'watch', points: 6, note: 'สูงกว่าเกณฑ์' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'cre', maxPoints: 20, label: 'Creatinine (ไต)', unit: 'mg/dl', decimals: 2, disease: 'kidney',
        bandFor: function (rec) { return healthIsMale_(rec) ? [0.7, 1.3] : [0.5, 1.1]; },
        evaluate: function (v, rec) {
          const max = healthIsMale_(rec) ? 1.3 : 1.1;
          if (v > max * 1.5) return { level: 'risk', points: 20, note: 'สูงกว่าเกณฑ์มาก' };
          if (v > max) return { level: 'risk', points: 12, note: 'สูงกว่าเกณฑ์' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'hemoglobin', maxPoints: 18, label: 'ฮีโมโกลบิน (Hb)', unit: 'g/dl', decimals: 1, disease: 'anemia',
        bandFor: function (rec) { return healthIsMale_(rec) ? [13, 17] : [12, 15]; },
        evaluate: function (v, rec) {
          const min = healthIsMale_(rec) ? 13 : 12;
          if (v < min - 3) return { level: 'risk', points: 18, critical: true, note: 'ซีดมาก เสี่ยงหน้ามืด' };
          if (v < min) return { level: 'watch', points: 8, note: 'ต่ำกว่าเกณฑ์ (ภาวะซีด)' };
          return { level: 'normal', points: 0 };
        }
      },
      {
        key: 'wbc', maxPoints: 10, label: 'เม็ดเลือดขาว (WBC)', unit: '/µL', decimals: 0, band: [4000, 10000], disease: null,
        evaluate: function (v) {
          if (v > 15000 || v < 3000) return { level: 'risk', points: 10, note: 'ผิดปกติชัดเจน' };
          if (v > 10000 || v < 4000) return { level: 'watch', points: 5, note: 'นอกเกณฑ์เล็กน้อย' };
          return { level: 'normal', points: 0 };
        }
      }
    ];

    function healthRuleBand_(rule, record) {
      return rule.bandFor ? rule.bandFor(record) : rule.band;
    }

    /* ---------- นิยามกลุ่มโรค: ทำไมถึงเสี่ยง / กระทบการขับรถอย่างไร / ทำอะไรได้บ้าง ---------- */
    const HEALTH_DISEASE_DEF_ = {
      diabetes: {
        name: 'เบาหวาน / ภาวะน้ำตาลในเลือดผิดปกติ',
        icon: '🍭',
        why: 'ระดับน้ำตาลในเลือดหลังอดอาหารสูงหรือต่ำกว่าเกณฑ์',
        driving: 'น้ำตาลสูงมากหรือต่ำเกินไปทำให้ง่วง อ่อนเพลีย ตาพร่า หน้ามืด หรือวูบหมดสติระหว่างขับรถได้ และระยะยาวทำให้ปลายประสาทชา รับรู้แป้นเบรก/คันเร่งได้ช้าลง',
        advice: [
          'ลดเครื่องดื่มหวาน น้ำอัดลม ชานมเย็น กาแฟใส่น้ำตาล — เปลี่ยนเป็นน้ำเปล่าระหว่างวิ่งงาน',
          'ลดข้าว/แป้งขัดสีลงประมาณหนึ่งในสามของที่เคยกิน เพิ่มผักในทุกมื้อ',
          'พกอาหารว่างที่ไม่หวานจัดไว้ในรถ ไม่ปล่อยให้ท้องว่างนานจนหน้ามืด',
          'ถ้าค่า FBS ตั้งแต่ 126 ขึ้นไป ควรพบแพทย์เพื่อตรวจยืนยันและวางแผนรักษา ไม่รอถึงปีหน้า'
        ]
      },
      hypertension: {
        name: 'ความดันโลหิตสูง',
        icon: '🩸',
        why: 'ค่าความดันตัวบน/ตัวล่างสูงกว่าเกณฑ์',
        driving: 'ความดันที่สูงมากสัมพันธ์กับอาการปวดหัว มึนศีรษะ และความเสี่ยงเส้นเลือดสมอง/หัวใจเฉียบพลันขณะปฏิบัติงาน ซึ่งอันตรายมากหากเกิดระหว่างขับรถ',
        advice: [
          'ลดอาหารเค็ม น้ำปลา ซอส บะหมี่กึ่งสำเร็จรูป และของดองที่กินบ่อยระหว่างเดินทาง',
          'เดินเร็วหรือออกแรงต่อเนื่องประมาณ 30 นาที สัปดาห์ละ 5 วัน (แบ่งเป็นช่วงสั้นๆ ได้)',
          'งด/ลดบุหรี่และเครื่องดื่มแอลกอฮอล์ และนอนให้ได้ 7-8 ชั่วโมง',
          'วัดความดันซ้ำที่คลินิกหรือ รพ.ใกล้บ้าน และถ้าได้รับยาแล้วต้องกินต่อเนื่อง ห้ามหยุดเอง'
        ]
      },
      cardiovascular: {
        name: 'ไขมันในเลือดสูง / เสี่ยงโรคหลอดเลือดหัวใจและสมอง',
        icon: '❤️',
        why: 'คอเลสเตอรอลหรือไตรกลีเซอไรด์สูงกว่าเกณฑ์',
        driving: 'ไขมันสะสมในหลอดเลือดเพิ่มโอกาสเกิดหัวใจขาดเลือดหรือหลอดเลือดสมองแบบเฉียบพลัน ซึ่งหากเกิดขณะขับรถจะควบคุมรถไม่ได้',
        advice: [
          'เลี่ยงของทอด หมูสามชั้น เครื่องในสัตว์ และกะทิข้น เปลี่ยนเป็นต้ม นึ่ง ย่าง',
          'เพิ่มปลา ถั่ว ผัก ผลไม้ไม่หวานจัด อย่างน้อยวันละ 1-2 มื้อ',
          'ถ้าไตรกลีเซอไรด์สูง ให้ลดน้ำตาลและแอลกอฮอล์ก่อนเป็นอันดับแรก เพราะมีผลโดยตรงที่สุด',
          'ตรวจซ้ำใน 3-6 เดือนเพื่อดูว่าการปรับอาหารได้ผลหรือไม่'
        ]
      },
      liver: {
        name: 'ภาวะตับอักเสบ / ไขมันพอกตับ',
        icon: '🧪',
        why: 'ค่าเอนไซม์ตับ (SGOT/SGPT) สูงกว่าเกณฑ์',
        driving: 'ตับทำงานผิดปกติทำให้อ่อนเพลียเรื้อรัง ง่วงกลางวัน และสมาธิลดลง ซึ่งเพิ่มความเสี่ยงหลับในระหว่างขับรถทางไกล',
        advice: [
          'งดเครื่องดื่มแอลกอฮอล์อย่างน้อย 3 เดือน แล้วตรวจค่าตับซ้ำ',
          'ลดน้ำหนักลงประมาณ 5-10% ของน้ำหนักตัว ช่วยลดไขมันพอกตับได้ชัดเจน',
          'ไม่ซื้อยาชุด ยาแก้ปวด หรืออาหารเสริม/ยาสมุนไพรกินเองต่อเนื่อง เพราะมีผลต่อตับโดยตรง',
          'ถ้าค่าสูงเกินสองเท่าของเกณฑ์ ควรพบแพทย์เพื่อหาสาเหตุ (ไวรัสตับอักเสบ ไขมัน หรือยา)'
        ]
      },
      kidney: {
        name: 'การทำงานของไตผิดปกติ',
        icon: '💧',
        why: 'ค่า BUN หรือ Creatinine อยู่นอกเกณฑ์',
        driving: 'ไตเสื่อมระยะแรกมักไม่มีอาการ แต่ทำให้อ่อนเพลีย บวม และความดันควบคุมยากขึ้น ซึ่งกระทบความพร้อมในการขับรถทางไกล',
        advice: [
          'ดื่มน้ำเปล่าให้พอตลอดวัน ไม่กลั้นปัสสาวะนานระหว่างวิ่งงาน',
          'ลดอาหารเค็มจัดและเลี่ยงยาแก้ปวดกลุ่ม NSAIDs ที่ซื้อกินเองบ่อยๆ',
          'ถ้ามีความดันสูงหรือน้ำตาลสูงร่วมด้วย ต้องคุมสองอย่างนี้ให้ดี เพราะเป็นสาเหตุหลักของไตเสื่อม',
          'พบแพทย์เพื่อตรวจยืนยันการทำงานของไต (eGFR) และตรวจปัสสาวะซ้ำ'
        ]
      },
      anemia: {
        name: 'ภาวะโลหิตจาง (ซีด)',
        icon: '🩹',
        why: 'ค่าฮีโมโกลบินต่ำกว่าเกณฑ์ตามเพศ',
        driving: 'เลือดขนส่งออกซิเจนได้น้อยลง ทำให้เหนื่อยง่าย ใจสั่น หน้ามืดเวลาลุกยืน และเสี่ยงวูบขณะทำงานหรือขับรถ',
        advice: [
          'กินอาหารที่มีธาตุเหล็ก เช่น เนื้อแดง ตับ ไข่ ผักใบเขียวเข้ม คู่กับผลไม้รสเปรี้ยวเพื่อดูดซึมดีขึ้น',
          'เลี่ยงดื่มชา/กาแฟพร้อมมื้ออาหาร เพราะลดการดูดซึมธาตุเหล็ก',
          'พบแพทย์เพื่อหาสาเหตุของภาวะซีด ไม่ควรซื้อยาบำรุงเลือดกินเองระยะยาว'
        ]
      },
      metabolic: {
        name: 'น้ำหนักเกิน / กลุ่มอาการเมตาบอลิก',
        icon: '⚖️',
        why: 'ค่าดัชนีมวลกาย (BMI) อยู่นอกเกณฑ์',
        driving: 'น้ำหนักเกินสัมพันธ์กับการนอนกรนและภาวะหยุดหายใจขณะหลับ ทำให้นอนไม่เต็มอิ่มและง่วงระหว่างวัน เป็นสาเหตุสำคัญของการหลับใน',
        advice: [
          'ตั้งเป้าลดทีละน้อยแบบที่ทำได้จริง เช่น ลดประมาณ 5% ของน้ำหนักตัวใน 3-6 เดือน',
          'เดินหรือยืดเส้นทุกครั้งที่จอดพัก แทนการนั่งอยู่ในรถตลอด',
          'ถ้ามีอาการกรนเสียงดัง สะดุ้งตื่นกลางดึก หรือง่วงมากตอนกลางวัน ควรปรึกษาแพทย์เรื่องภาวะหยุดหายใจขณะหลับ'
        ]
      }
    };

    /* ---------- หมวดตรวจที่ถ้าผิดปกติแล้วกระทบการขับรถโดยตรง ---------- */
    const HEALTH_FIT_CATEGORY_FLAGS_ = [
      { key: 'visionStatus', label: 'สายตา', text: 'ผลตรวจสายตาผิดปกติ — มีผลต่อการมองป้าย ระยะห่าง และการขับรถกลางคืน ควรตรวจวัดสายตาและใช้แว่นที่เหมาะสม' },
      { key: 'hearingStatus', label: 'การได้ยิน', text: 'ผลตรวจการได้ยินผิดปกติ — อาจไม่ได้ยินเสียงแตร เสียงสัญญาณ หรือเสียงผิดปกติของรถ ควรพบแพทย์อาชีวเวชศาสตร์' },
      { key: 'ekgStatus', label: 'คลื่นหัวใจ', text: 'คลื่นไฟฟ้าหัวใจผิดปกติ — ต้องให้แพทย์ประเมินก่อนมอบหมายงานขับรถทางไกลหรือทำงานต่อเนื่องนานๆ' },
      { key: 'lungStatus', label: 'สมรรถภาพปอด', text: 'สมรรถภาพปอดผิดปกติ — เหนื่อยง่ายขึ้นเมื่อทำงานหนักหรือขนถ่ายสินค้า ควรพบแพทย์' },
      { key: 'drugScreenStatus', label: 'สารเสพติด', text: 'ผลตรวจสารเสพติดผิดปกติ — ต้องดำเนินการตามระเบียบบริษัทและกฎหมายทันที ห้ามมอบหมายงานขับรถจนกว่าจะตรวจซ้ำและได้ข้อสรุป' }
    ];

    /* ---------- ตัวประเมินหลัก: record 1 ปี -> ผลวิเคราะห์ทั้งหมด ---------- */
    function healthAssessRecord_(record) {
      const factors = [];
      let rawScore = 0;   // คะแนนดิบที่ได้จริง
      let maxScore = 0;   // คะแนนเต็มของ "เฉพาะรายการที่ตรวจในปีนั้น" — ปีที่ตรวจไม่ครบจะได้ไม่เสียเปรียบ
      let hasCritical = false;
      const diseaseHits = {};

      HEALTH_RISK_RULES_.forEach(function (rule) {
        const v = healthNum_(record[rule.key]);
        if (v === null) return;
        const res = rule.evaluate(v, record) || { level: 'normal', points: 0 };
        const factor = {
          key: rule.key, label: rule.label, unit: rule.unit || '', value: v,
          level: res.level, points: res.points || 0, note: res.note || '', critical: !!res.critical
        };
        factors.push(factor);
        rawScore += factor.points;
        maxScore += rule.maxPoints || 10;
        if (factor.critical) hasCritical = true;
        if (rule.disease && res.level !== 'normal') {
          if (!diseaseHits[rule.disease]) diseaseHits[rule.disease] = { level: 'watch', evidence: [] };
          diseaseHits[rule.disease].evidence.push(factor);
          if (res.level === 'risk') diseaseHits[rule.disease].level = 'risk';
        }
      });

      // หมวดตรวจที่ระบุผลเป็นข้อความ ('ผิดปกติ'/'เฝ้าระวัง') ก็นับรวมในคะแนนด้วย
      HEALTH_CATEGORY_FIELDS_.forEach(function (f) {
        const t = String(record[f.key] || '').trim();
        if (!t) return;
        maxScore += 8;
        if (t === 'ผิดปกติ') rawScore += 8;
        else if (t === 'เฝ้าระวัง') rawScore += 4;
      });

      // แปลงเป็น 0-100 เพื่อให้เทียบข้ามปี/ข้ามคนได้ แม้จำนวนรายการตรวจไม่เท่ากัน
      let score = maxScore ? Math.round(rawScore * 100 / maxScore) : 0;
      if (score > 100) score = 100;
      let level = 'low';
      if (hasCritical || score >= 40) level = 'high';
      else if (score >= 15) level = 'medium';

      const diseases = Object.keys(diseaseHits).map(function (key) {
        const def = HEALTH_DISEASE_DEF_[key];
        return {
          key: key, name: def.name, icon: def.icon, why: def.why,
          driving: def.driving, advice: def.advice,
          level: diseaseHits[key].level,
          evidence: diseaseHits[key].evidence
        };
      }).sort(function (a, b) { return (b.level === 'risk' ? 1 : 0) - (a.level === 'risk' ? 1 : 0); });

      // ผลกระทบต่อการขับรถ: รวมจากค่าที่ critical + หมวดตรวจที่ผิดปกติ
      const driving = [];
      factors.filter(function (f) { return f.critical; }).forEach(function (f) {
        driving.push({
          severity: 'high',
          title: f.label + ' ' + f.value + ' ' + f.unit,
          text: f.note + ' — ควรให้แพทย์ประเมินความพร้อมก่อนมอบหมายงานขับรถทางไกล'
        });
      });
      HEALTH_FIT_CATEGORY_FLAGS_.forEach(function (flag) {
        const t = String(record[flag.key] || '').trim();
        if (t && t !== 'ปกติ') {
          driving.push({ severity: t === 'ผิดปกติ' ? 'high' : 'medium', title: flag.label + ': ' + t, text: flag.text });
        }
      });
      const sleepyRisk = diseaseHits.liver || diseaseHits.metabolic || diseaseHits.anemia;
      if (!driving.length && sleepyRisk) {
        driving.push({
          severity: 'medium',
          title: 'เฝ้าระวังอาการง่วง/อ่อนเพลียระหว่างขับรถ',
          text: 'ผลตรวจกลุ่มที่ทำให้อ่อนเพลียง่ายผิดปกติ ควรพักทุก 2 ชั่วโมง นอนให้พอก่อนออกงาน และแจ้งหัวหน้างานทันทีถ้ารู้สึกง่วงผิดปกติ'
        });
      }

      return { score: score, level: level, factors: factors, diseases: diseases, driving: driving };
    }

    function healthRiskLevelText_(level) {
      if (level === 'high') return 'ความเสี่ยงสูง';
      if (level === 'medium') return 'ความเสี่ยงปานกลาง';
      return 'ความเสี่ยงต่ำ';
    }

    /* =========================================================================
       UI 1: ดัชนีความเสี่ยงรวม
       ========================================================================= */
    function healthRiskPanelHtml_(assess, record) {
      const abnormal = assess.factors.filter(function (f) { return f.level !== 'normal'; });
      const pct = Math.max(4, Math.min(100, assess.score));

      let chips = abnormal.length
        ? abnormal.map(function (f) {
            return '<span class="hr-chip hr-' + f.level + '">' + escapeHtml(f.label) + ' ' +
              escapeHtml(String(f.value)) + (f.unit ? ' ' + escapeHtml(f.unit) : '') + '</span>';
          }).join('')
        : '<span class="hr-chip hr-normal">ค่าตรวจหลักอยู่ในเกณฑ์ทั้งหมด</span>';

      return '<div class="panel hr-score-panel hr-level-' + assess.level + '">' +
        '<div class="panel-title"><h3>ดัชนีความเสี่ยงสุขภาพรวม (ปี ' + escapeHtml(String(record.year)) + ')</h3></div>' +
        '<div class="hr-score-head">' +
          '<div class="hr-score-num">' + assess.score + '<span>/100</span></div>' +
          '<div class="hr-score-meta">' +
            '<span class="hr-level-badge hr-' + assess.level + '">' + healthRiskLevelText_(assess.level) + '</span>' +
            '<p class="hr-score-hint">คิดจากค่าตรวจที่อยู่นอกเกณฑ์และผลตรวจรายหมวด ยิ่งคะแนนสูงยิ่งควรรีบดูแล</p>' +
          '</div>' +
        '</div>' +
        '<div class="hr-score-bar"><div class="hr-score-fill" style="width:' + pct + '%;"></div></div>' +
        '<div class="hr-score-scale"><span>ต่ำ (0-14)</span><span>ปานกลาง (15-39)</span><span>สูง (40+)</span></div>' +
        '<div class="hr-chips">' + chips + '</div>' +
      '</div>';
    }

    /* =========================================================================
       UI 2: แนวโน้มย้อนหลัง 3-5 ปี (ตาราง + กราฟเส้น SVG วาดเอง ไม่ใช้ไลบรารี)
       ========================================================================= */
    let healthTrendMetricKey_ = 'bmi';

    /** คืนข้อมูลย้อนหลังไม่เกิน 5 ปี เรียงจากปีเก่า -> ปีใหม่ (ข้อมูลจาก backend เรียงปีใหม่ก่อน) */
    function healthTrendSeries_(key) {
      return healthCurrentRecords_
        .map(function (r) { return { year: Number(r.year), value: healthNum_(r[key]), record: r }; })
        .filter(function (p) { return !isNaN(p.year); })
        .sort(function (a, b) { return a.year - b.year; })
        .slice(-5);
    }

    function healthTrendChartSvg_(points, rule, record) {
      const valued = points.filter(function (p) { return p.value !== null; });
      if (valued.length < 2) {
        return '<div class="empty-state" style="margin:0;">ยังมีข้อมูลไม่พอวาดกราฟ (ต้องมีอย่างน้อย 2 ปี)</div>';
      }

      const W = 640, H = 240, padL = 52, padR = 16, padT = 18, padB = 34;
      const band = healthRuleBand_(rule, record);
      const vals = valued.map(function (p) { return p.value; });
      let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
      if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
      const pad = (hi - lo) * 0.18 || (hi * 0.1) || 1;
      lo -= pad; hi += pad;
      if (lo < 0) lo = 0;

      const x = function (i) { return padL + (points.length === 1 ? 0 : i * (W - padL - padR) / (points.length - 1)); };
      const y = function (v) { return padT + (hi - v) * (H - padT - padB) / (hi - lo); };
      const fmt = function (v) { return rule.decimals ? Number(v).toFixed(rule.decimals) : Math.round(v); };

      let svg = '<svg class="hr-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="กราฟแนวโน้ม' + escapeHtml(rule.label) + '">';

      // แถบเกณฑ์ปกติ
      if (band) {
        const yTop = Math.max(padT, y(band[1]));
        const yBot = Math.min(H - padB, y(band[0]));
        svg += '<rect x="' + padL + '" y="' + yTop + '" width="' + (W - padL - padR) + '" height="' + Math.max(1, yBot - yTop) + '" class="hr-chart-band"></rect>' +
          '<text x="' + (padL + 6) + '" y="' + (yTop + 13) + '" class="hr-chart-bandlabel">เกณฑ์ปกติ ' + fmt(band[0]) + '-' + fmt(band[1]) + '</text>';
      }

      // แกน + เส้นกริด 3 เส้น
      [0, 0.5, 1].forEach(function (t) {
        const v = lo + (hi - lo) * t;
        const yy = y(v);
        svg += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" class="hr-chart-grid"></line>' +
          '<text x="' + (padL - 8) + '" y="' + (yy + 4) + '" class="hr-chart-axis" text-anchor="end">' + fmt(v) + '</text>';
      });

      // เส้นแนวโน้ม (ต่อเฉพาะจุดที่มีค่า)
      const line = points.map(function (p, i) { return p.value === null ? null : x(i) + ',' + y(p.value); })
        .filter(function (s) { return s !== null; }).join(' ');
      svg += '<polyline points="' + line + '" class="hr-chart-line"></polyline>';

      // จุด + ค่ากำกับ + ปีที่แกนล่าง
      points.forEach(function (p, i) {
        svg += '<text x="' + x(i) + '" y="' + (H - 10) + '" class="hr-chart-axis" text-anchor="middle">' + escapeHtml(String(p.year)) + '</text>';
        if (p.value === null) return;
        const st = rule.evaluate(p.value, p.record) || { level: 'normal' };
        svg += '<circle cx="' + x(i) + '" cy="' + y(p.value) + '" r="6" class="hr-chart-dot hr-dot-' + st.level + '"></circle>' +
          '<text x="' + x(i) + '" y="' + (y(p.value) - 13) + '" class="hr-chart-value" text-anchor="middle">' + fmt(p.value) + '</text>';
      });

      svg += '</svg>';
      return svg;
    }

    function healthTrendPanelHtml_(record) {
      if (healthCurrentRecords_.length < 2) return '';
      const rule = HEALTH_RISK_RULES_.find(function (r) { return r.key === healthTrendMetricKey_; }) || HEALTH_RISK_RULES_[0];

      const chips = HEALTH_RISK_RULES_.map(function (r) {
        return '<button type="button" class="hr-metric-chip' + (r.key === rule.key ? ' active' : '') + '" onclick="healthSelectTrendMetric_(\'' + r.key + '\')">' + escapeHtml(r.label) + '</button>';
      }).join('');

      // ตารางแนวโน้มทุกค่า ย้อนหลังไม่เกิน 5 ปี
      const years = healthTrendSeries_('bmi').map(function (p) { return p.year; });
      let table = '<div class="grid-scroll"><table class="report-table hr-trend-table"><thead><tr><th>รายการ</th>' +
        years.map(function (yr) { return '<th>' + escapeHtml(String(yr)) + '</th>'; }).join('') + '<th>แนวโน้ม</th></tr></thead><tbody>';

      HEALTH_RISK_RULES_.forEach(function (r) {
        const series = healthTrendSeries_(r.key);
        const valued = series.filter(function (p) { return p.value !== null; });
        let cells = series.map(function (p) {
          if (p.value === null) return '<td>-</td>';
          const st = r.evaluate(p.value, p.record) || { level: 'normal' };
          const shown = r.decimals ? Number(p.value).toFixed(r.decimals) : p.value;
          return '<td><span class="hr-cell hr-' + st.level + '">' + escapeHtml(String(shown)) + '</span></td>';
        }).join('');

        let trend = '<td>-</td>';
        if (valued.length >= 2) {
          const first = valued[0].value, last = valued[valued.length - 1].value;
          const diff = last - first;
          const shownDiff = (diff > 0 ? '+' : '') + (r.decimals ? diff.toFixed(r.decimals) : Math.round(diff));
          const arrow = Math.abs(diff) < (r.decimals ? 0.05 : 0.5)
            ? '‒'
            : (diff > 0 ? '<span class="health-trend-arrow up">▲</span>' : '<span class="health-trend-arrow down">▼</span>');
          trend = '<td>' + arrow + ' ' + escapeHtml(shownDiff) + '</td>';
        }
        table += '<tr><td>' + escapeHtml(r.label) + '</td>' + cells + trend + '</tr>';
      });
      table += '</tbody></table></div>';

      return '<div class="panel">' +
        '<div class="panel-title"><h3>แนวโน้มย้อนหลัง ' + years.length + ' ปี</h3></div>' +
        '<p class="panel-hint">แตะชื่อค่าตรวจเพื่อดูกราฟของค่านั้น แถบสีเขียวในกราฟคือช่วงเกณฑ์ปกติ</p>' +
        '<div class="hr-metric-chips">' + chips + '</div>' +
        '<div id="healthTrendChart" class="hr-chart-wrap">' + healthTrendChartSvg_(healthTrendSeries_(rule.key), rule, record) + '</div>' +
        table +
      '</div>';
    }

    function healthSelectTrendMetric_(key) {
      healthTrendMetricKey_ = key;
      const record = healthCurrentRecords_[healthCurrentIndex_];
      const rule = HEALTH_RISK_RULES_.find(function (r) { return r.key === key; });
      const wrap = document.getElementById('healthTrendChart');
      if (!wrap || !rule || !record) return;
      wrap.innerHTML = healthTrendChartSvg_(healthTrendSeries_(key), rule, record);
      const chips = document.querySelectorAll('.hr-metric-chip');
      for (let i = 0; i < chips.length; i++) {
        chips[i].classList.toggle('active', chips[i].textContent === rule.label);
      }
    }

    /* =========================================================================
       UI 3: โรคที่ต้องเฝ้าระวัง + ผลกระทบต่อการขับรถ + คำแนะนำปรับพฤติกรรม
       ========================================================================= */
    function healthDiseasePanelHtml_(assess) {
      if (!assess.diseases.length) {
        return '<div class="panel">' +
          '<div class="panel-title"><h3>โรคที่ต้องเฝ้าระวัง</h3></div>' +
          '<div class="hr-allclear">✅ ค่าตรวจหลักในปีนี้ยังไม่พบสัญญาณที่ต้องเฝ้าระวังเป็นพิเศษ — รักษาพฤติกรรมแบบนี้ไว้และตรวจสุขภาพต่อเนื่องทุกปี</div>' +
        '</div>';
      }

      const cards = assess.diseases.map(function (d) {
        const evidence = d.evidence.map(function (f) {
          return '<span class="hr-chip hr-' + f.level + '">' + escapeHtml(f.label) + ' ' + escapeHtml(String(f.value)) +
            (f.note ? ' (' + escapeHtml(f.note) + ')' : '') + '</span>';
        }).join('');
        return '<div class="hr-disease-card hr-' + d.level + '">' +
          '<div class="hr-disease-head">' +
            '<span class="hr-disease-icon">' + d.icon + '</span>' +
            '<div>' +
              '<div class="hr-disease-name">' + escapeHtml(d.name) + '</div>' +
              '<div class="hr-disease-why">' + escapeHtml(d.why) + '</div>' +
            '</div>' +
            '<span class="hr-level-badge hr-' + (d.level === 'risk' ? 'high' : 'medium') + '">' +
              (d.level === 'risk' ? 'ต้องดูแล' : 'เฝ้าระวัง') + '</span>' +
          '</div>' +
          '<div class="hr-chips">' + evidence + '</div>' +
          '<div class="hr-disease-impact"><b>ผลต่อการปฏิบัติงาน:</b> ' + escapeHtml(d.driving) + '</div>' +
        '</div>';
      }).join('');

      return '<div class="panel">' +
        '<div class="panel-title"><h3>โรคที่ต้องเฝ้าระวัง (ประเมินจากค่าผลตรวจ)</h3></div>' +
        '<p class="panel-hint">เป็นการเทียบค่ากับเกณฑ์อ้างอิงทั่วไปเพื่อเตือนให้ดูแลตัวเอง ไม่ใช่การวินิจฉัยว่าเป็นโรคแล้ว</p>' +
        cards +
      '</div>';
    }

    function healthDrivingPanelHtml_(assess) {
      if (!assess.driving.length) return '';
      const items = assess.driving.map(function (d) {
        return '<div class="hr-fit-item hr-' + d.severity + '">' +
          '<div class="hr-fit-title">' + (d.severity === 'high' ? '🚨' : '⚠️') + ' ' + escapeHtml(d.title) + '</div>' +
          '<div class="hr-fit-text">' + escapeHtml(d.text) + '</div>' +
        '</div>';
      }).join('');

      return '<div class="panel hr-fit-panel">' +
        '<div class="panel-title"><h3>ผลกระทบต่อการปฏิบัติงาน (Fit to Drive)</h3></div>' +
        '<p class="panel-hint">ข้อมูลนี้ใช้เพื่อความปลอดภัยหน้างาน การตัดสินความพร้อมในการขับรถต้องให้แพทย์เป็นผู้ประเมินเท่านั้น</p>' +
        items +
      '</div>';
    }

    function healthAdvicePanelHtml_(assess) {
      if (!assess.diseases.length) return '';
      const blocks = assess.diseases.map(function (d) {
        return '<div class="hr-advice-block">' +
          '<div class="hr-advice-head">' + d.icon + ' ' + escapeHtml(d.name) + '</div>' +
          '<ul class="hr-advice-list">' +
            d.advice.map(function (a) { return '<li>' + escapeHtml(a) + '</li>'; }).join('') +
          '</ul>' +
        '</div>';
      }).join('');

      return '<div class="panel">' +
        '<div class="panel-title"><h3>สิ่งที่ทำได้เลยตั้งแต่วันนี้</h3></div>' +
        '<p class="panel-hint">เลือกทำทีละข้อที่ทำได้จริงก่อน แล้วดูผลอีกครั้งตอนตรวจปีหน้า</p>' +
        blocks +
      '</div>';
    }

    function selectHealthYear_(index) {
      healthCurrentIndex_ = index;
      renderHealthRecordView_();
    }

    function loadHealthYoY_() {
      const areaEl = document.getElementById('healthYoYArea');
      if (!areaEl) return;
      areaEl.innerHTML = '<div class="loading-state"><div class="spinner-lg"></div><p>กำลังเปรียบเทียบข้อมูล...</p></div>';

      const args = healthViewingOwn_
        ? [sessionToken, null, null]
        : [sessionToken, healthTargetName_.firstName, healthTargetName_.lastName];

      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { areaEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดไม่สำเร็จ') + '</div>'; return; }
          if (!res.yoy) { areaEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.yoyMessage || 'ยังไม่มีข้อมูลพอเปรียบเทียบ') + '</div>'; return; }
          renderHealthYoY_(res, areaEl);
        })
        .withFailureHandler(function (err) {
          areaEl.innerHTML = '<div class="empty-state">โหลดข้อมูลไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getHealthCheckupYoY.apply(null, args);
    }

    function renderHealthYoY_(res, areaEl) {
      let html = '<div class="panel"><div class="panel-title"><h3>เทียบปี ' + escapeHtml(String(res.previousYear)) + ' vs ' + escapeHtml(String(res.currentYear)) + '</h3></div>' +
        '<div class="grid-scroll"><table class="report-table"><thead><tr>' +
        '<th>รายการ</th><th>ปี ' + escapeHtml(String(res.previousYear)) + '</th><th>ปี ' + escapeHtml(String(res.currentYear)) + '</th><th>ส่วนต่าง</th>' +
        '</tr></thead><tbody>';
      res.yoy.forEach(function (item, i) {
        const label = HEALTH_METRIC_LABELS_[i] || item.key;
        let arrow = '';
        if (item.trend === 'up') arrow = '<span class="health-trend-arrow up">▲</span>';
        else if (item.trend === 'down') arrow = '<span class="health-trend-arrow down">▼</span>';
        else if (item.trend === 'same') arrow = '‒';
        html += '<tr>' +
          '<td>' + escapeHtml(label) + '</td>' +
          '<td>' + escapeHtml(item.previousValue === '' || item.previousValue == null ? '-' : String(item.previousValue)) + '</td>' +
          '<td>' + escapeHtml(item.currentValue === '' || item.currentValue == null ? '-' : String(item.currentValue)) + '</td>' +
          '<td>' + arrow + ' ' + (item.diff === null ? '-' : escapeHtml((item.diff > 0 ? '+' : '') + item.diff)) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div></div>';
      areaEl.innerHTML = html;
    }

    /* =========================================================================
       นำเข้าผลตรวจสุขภาพประจำปี (Auto-Import) — Admin + Supervisor
       ย้ายมาจากไฟล์ health-checkup-import.html ที่เคยเป็นหน้าเดี่ยว ให้มาอยู่ในแอปหลัก
       จะได้ใช้ session/token เดิม ไม่ต้องล็อกอินซ้ำ และธีมตรงกับหน้าอื่น
       SheetJS โหลดแบบ lazy (เฉพาะตอนเปิดหน้านี้) เพื่อไม่ให้ Driver/FuelAttendant
       ต้องโหลดไลบรารีก้อนใหญ่ทุกครั้งที่เปิดแอป
       ========================================================================= */
    const HEALTH_IMPORT_SHEETJS_URL_ = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    let healthImportParsed_ = null;      // { year, company, fileName, mimeType, base64File, records }
    let healthImportSheetJsPromise_ = null;

    function loadSheetJs_() {
      if (window.XLSX) return Promise.resolve();
      if (healthImportSheetJsPromise_) return healthImportSheetJsPromise_;
      healthImportSheetJsPromise_ = new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = HEALTH_IMPORT_SHEETJS_URL_;
        s.onload = function () { resolve(); };
        s.onerror = function () {
          healthImportSheetJsPromise_ = null;
          reject(new Error('โหลดตัวอ่านไฟล์ Excel ไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่'));
        };
        document.head.appendChild(s);
      });
      return healthImportSheetJsPromise_;
    }

    /* ---------- Auto-Map: หาคอลัมน์จากข้อความใน header จริง ไม่ยึดตำแหน่งคอลัมน์ ----------
       ถ้าปีหน้าบริษัทตรวจเปลี่ยน "คำ" ใน header (ไม่ใช่แค่สลับตำแหน่ง) ให้มาแก้ที่ตารางนี้จุดเดียว */
    const HEALTH_COLUMN_PATTERNS_ = {
      firstName:         ['[Name]'],
      lastName:          ['[Surname]'],
      age:               ['[Age]'],
      gender:            ['[Gender]'],
      department:        ['[Department]'],
      weight:            ['[Weight]'],
      height:            ['[Height]'],
      bmi:               ['[BMI]'],
      sbp:               ['ความดันส่วนบน'],
      dbp:               ['ความดันส่วนล่าง'],
      pulse:             ['[Pulse]'],
      doctorNoteRaw:     ['[Dr.Exam]'],
      peStatus:          ['[Physical Examination'],
      hemoglobin:        ['[Hemoglobin]'],
      wbc:               ['[WBC Count]'],
      cbcStatus:         ['[Complete Blood Count'],
      uaStatus:          ['[Urinalysis'],
      ekgStatus:         ['สรุปผลการตรวจ [EKG'],
      xrayStatus:        ['สรุปผลการตรวจ [Chest X-Ray]'],
      fbs:               ['FBS ในเลือด'],
      fbsStatus:         ['[FBS In Blood]'],
      bun:               ['BUN ในเลือด'],
      bunStatus:         ['[BUN In Blood]'],
      cre:               ['CRE ในเลือด'],
      creStatus:         ['[CRE In Blood]'],
      cholesterol:       ['Cholesterol:CHOL ในเลือด'],
      cholesterolStatus: ['[Cholesterol:CHOL In Blood]'],
      triglyceride:      ['Triglyceride:TG ในเลือด'],
      triglycerideStatus:['[Triglyceride:TG In Blood]'],
      sgot:              ['SGOT ในเลือด'],
      sgotStatus:        ['[SGOT In Blood]'],
      sgpt:              ['SGPT ในเลือด'],
      sgptStatus:        ['[SGPT In Blood]'],
      drugScreenStatus:  ['Methamphetamine In Urine'],
      hearingStatus:     ['สรุปผลการตรวจ [Audiometry]'],
      lungStatus:        ['สรุปผลการตรวจ [Spirometry]'],
      visionStatus:      ['[Occupational Vision]']
    };

    const HEALTH_STATUS_PRIORITY_ = { 'ผิดปกติ': 3, 'เฝ้าระวัง': 2, 'ปกติ': 1 };

    function healthWorstStatus_(list) {
      let best = '', bestScore = -1;
      list.forEach(function (s) {
        const val = (s || '').toString().trim();
        const score = HEALTH_STATUS_PRIORITY_[val];
        if (score && score > bestScore) { bestScore = score; best = val; }
      });
      return best;
    }

    function healthCleanHeader_(h) {
      return (h || '').toString().replace(/\r|\n/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function healthFindColumnIndex_(headers, patterns) {
      for (let i = 0; i < headers.length; i++) {
        const h = headers[i];
        if (patterns.some(function (p) { return h.indexOf(p) !== -1; })) return i;
      }
      return -1;
    }

    function healthNumberOrBlank_(v) {
      if (v === undefined || v === null || v === '') return '';
      const n = Number(v);
      return isNaN(n) ? '' : n;
    }

    /** อ่าน workbook ที่ parse แล้ว -> array ของ record object ตาม schema ของชีท HealthCheckup */
    function healthImportMapWorkbook_(workbook) {
      const sheetName = workbook.SheetNames.find(function (n) { return n.indexOf('ผลตรวจรวม') !== -1 && n.indexOf('ย่อ') === -1; })
        || workbook.SheetNames.find(function (n) { return n.indexOf('ผลตรวจรวม') !== -1; });
      if (!sheetName) throw new Error('ไม่พบชีท "ผลตรวจรวม" ในไฟล์ที่อัปโหลด');

      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

      // หาแถว header จริง (แถวที่มีคำว่า "ลำดับ") แทนการยึดเลขแถวตายตัว กันไฟล์ปีหน้าขยับแถวหัวตาราง
      let headerRowIdx = -1;
      for (let r = 0; r < Math.min(grid.length, 10); r++) {
        if (grid[r].some(function (c) { return healthCleanHeader_(c).indexOf('ลำดับ') !== -1; })) { headerRowIdx = r; break; }
      }
      if (headerRowIdx === -1) throw new Error('หาแถวหัวตาราง (แถวที่มีคำว่า "ลำดับ") ไม่เจอในชีท "ผลตรวจรวม"');

      const headers = grid[headerRowIdx].map(healthCleanHeader_);
      const col = {};
      Object.keys(HEALTH_COLUMN_PATTERNS_).forEach(function (key) {
        col[key] = healthFindColumnIndex_(headers, HEALTH_COLUMN_PATTERNS_[key]);
      });

      // เตือนถ้าคอลัมน์สำคัญจับคู่ไม่เจอ (ผังไฟล์อาจเปลี่ยนไปจากที่คาดไว้)
      const criticalMissing = ['firstName', 'lastName', 'bmi'].filter(function (k) { return col[k] === -1; });

      const records = [];
      for (let r = headerRowIdx + 1; r < grid.length; r++) {
        const row = grid[r];
        const firstName = (row[col.firstName] || '').toString().trim();
        const lastName = (row[col.lastName] || '').toString().trim();
        if (!firstName && !lastName) continue; // แถวว่าง

        const doctorNoteRaw = (row[col.doctorNoteRaw] || '').toString().trim();

        const peStatus = row[col.peStatus] || '';
        const cbcStatus = row[col.cbcStatus] || '';
        const uaStatus = row[col.uaStatus] || '';
        const ekgStatus = row[col.ekgStatus] || '';
        const xrayStatus = row[col.xrayStatus] || '';
        const drugScreenStatus = row[col.drugScreenStatus] || '';
        const hearingStatus = row[col.hearingStatus] || '';
        const lungStatus = row[col.lungStatus] || '';
        const visionStatus = row[col.visionStatus] || '';

        // Biochem_Status ไม่มีคอลัมน์สรุปรวมในไฟล์ดิบ ต้องคำนวณเองจาก 7 ค่าย่อย
        const biochemStatus = healthWorstStatus_([
          row[col.fbsStatus], row[col.bunStatus], row[col.creStatus],
          row[col.cholesterolStatus], row[col.triglycerideStatus], row[col.sgotStatus], row[col.sgptStatus]
        ]);

        const overallStatus = healthWorstStatus_([
          peStatus, cbcStatus, uaStatus, ekgStatus, xrayStatus,
          biochemStatus, hearingStatus, lungStatus, visionStatus
        ]);

        records.push({
          firstName: firstName,
          lastName: lastName,
          department: (row[col.department] || '').toString().trim(),
          age: healthNumberOrBlank_(row[col.age]),
          gender: (row[col.gender] || '').toString().trim(),
          weight: healthNumberOrBlank_(row[col.weight]),
          height: healthNumberOrBlank_(row[col.height]),
          bmi: healthNumberOrBlank_(row[col.bmi]),
          sbp: healthNumberOrBlank_(row[col.sbp]),
          dbp: healthNumberOrBlank_(row[col.dbp]),
          pulse: healthNumberOrBlank_(row[col.pulse]),
          fbs: healthNumberOrBlank_(row[col.fbs]),
          bun: healthNumberOrBlank_(row[col.bun]),
          cre: healthNumberOrBlank_(row[col.cre]),
          cholesterol: healthNumberOrBlank_(row[col.cholesterol]),
          triglyceride: healthNumberOrBlank_(row[col.triglyceride]),
          sgot: healthNumberOrBlank_(row[col.sgot]),
          sgpt: healthNumberOrBlank_(row[col.sgpt]),
          hemoglobin: healthNumberOrBlank_(row[col.hemoglobin]),
          wbc: healthNumberOrBlank_(row[col.wbc]),
          peStatus: peStatus, cbcStatus: cbcStatus, uaStatus: uaStatus, ekgStatus: ekgStatus, xrayStatus: xrayStatus,
          biochemStatus: biochemStatus, drugScreenStatus: drugScreenStatus,
          hearingStatus: hearingStatus, lungStatus: lungStatus, visionStatus: visionStatus,
          overallStatus: overallStatus,
          // ในไฟล์ดิบ ช่องคำแนะนำแพทย์ใส่คำว่า 'ปกติ' แทนความหมาย "ไม่มีข้อสังเกต" — ไม่ถือเป็น note จริง
          doctorNote: (doctorNoteRaw && doctorNoteRaw !== 'ปกติ') ? doctorNoteRaw : ''
        });
      }

      return { records: records, criticalMissing: criticalMissing };
    }

    function healthFileToBase64_(file) {
      return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onload = function () { resolve(reader.result.split(',')[1]); };
        reader.onerror = function () { reject(new Error('อ่านไฟล์ไม่สำเร็จ')); };
        reader.readAsDataURL(file);
      });
    }

    function healthImportStatus_(msg, kind) {
      const el = document.getElementById('hiStatus');
      if (!el) return;
      el.className = 'hi-status' + (kind ? ' hi-' + kind : '');
      el.innerHTML = msg ? escapeHtml(msg) : '';
    }

    /* ---------- หน้าจอหลักของการนำเข้า (ใช้ร่วมกันทั้ง Admin tab และเมนู Supervisor) ----------
       targetId: id ของกล่องที่จะ render ลงไป, backOnclick: โค้ดปุ่มย้อนกลับ (ส่ง '' ถ้าไม่ต้องการปุ่ม) */
    function renderHealthImportPage_(targetId, backOnclick) {
      healthImportParsed_ = null;
      const el = document.getElementById(targetId || 'mainContent');
      if (!el) return;
      const curYear = new Date().getFullYear();

      el.innerHTML =
        (backOnclick ? '<button type="button" class="back-link" onclick="' + backOnclick + '">← กลับเมนูหลัก</button>' : '') +
        '<div class="panel">' +
          '<div class="panel-title"><h3>นำเข้าผลตรวจสุขภาพประจำปี</h3></div>' +
          '<p class="panel-hint">อัปโหลดไฟล์ผลตรวจดิบจากบริษัทตรวจสุขภาพ (ต้องมีชีทชื่อ "ผลตรวจรวม") ระบบจะจับคู่คอลัมน์ให้อัตโนมัติ และให้ตรวจสอบก่อนบันทึกจริงเสมอ</p>' +
          '<div class="field"><label>ปีของผลตรวจ (ตรงกับคอลัมน์ Year ในชีท)</label>' +
            '<input type="number" id="hiYear" value="' + curYear + '" placeholder="เช่น 2025"></div>' +
          '<div class="field"><label>บริษัท / หน่วยงาน</label>' +
            '<input type="text" id="hiCompany" placeholder="เช่น KJ"></div>' +
          '<div class="field"><label>ไฟล์ผลตรวจ (.xlsx)</label>' +
            '<input type="file" id="hiFile" accept=".xlsx" onchange="healthImportResetPreview_()"></div>' +
          '<div class="hi-actions">' +
            '<button type="button" class="btn btn-primary" id="hiParseBtn" onclick="healthImportParse_()">1. อ่านไฟล์ + ตรวจสอบข้อมูลซ้ำ</button>' +
            '<button type="button" class="btn btn-amber" id="hiConfirmBtn" onclick="healthImportConfirm_()" disabled>2. ยืนยันนำเข้าจริง</button>' +
          '</div>' +
          '<div id="hiStatus" class="hi-status"></div>' +
        '</div>' +
        '<div id="hiPreview"></div>';
    }

    /** เปลี่ยนไฟล์ = ผล preview เดิมใช้ไม่ได้แล้ว ต้องกดอ่านไฟล์ใหม่ก่อนถึงจะยืนยันได้ */
    function healthImportResetPreview_() {
      healthImportParsed_ = null;
      const btn = document.getElementById('hiConfirmBtn');
      if (btn) btn.disabled = true;
      const prev = document.getElementById('hiPreview');
      if (prev) prev.innerHTML = '';
      healthImportStatus_('');
    }

    function healthImportParse_() {
      const year = (document.getElementById('hiYear').value || '').trim();
      const company = (document.getElementById('hiCompany').value || '').trim();
      const file = document.getElementById('hiFile').files[0];

      if (!year || !company) { healthImportStatus_('กรุณาระบุปีและบริษัทก่อน', 'err'); return; }
      if (!file) { healthImportStatus_('กรุณาเลือกไฟล์ .xlsx ก่อน', 'err'); return; }

      healthImportResetPreview_();
      const parseBtn = document.getElementById('hiParseBtn');
      parseBtn.disabled = true;
      healthImportStatus_('กำลังเปิดไฟล์...');

      loadSheetJs_()
        .then(function () { return healthFileToBase64_(file); })
        .then(function (base64) {
          const workbook = XLSX.read(base64, { type: 'base64' });
          const mapped = healthImportMapWorkbook_(workbook);
          if (!mapped.records.length) throw new Error('ไม่พบรายชื่อพนักงานในไฟล์ (แถวว่างทั้งหมด หรือจับคู่คอลัมน์ชื่อไม่สำเร็จ)');

          if (mapped.criticalMissing.length) {
            healthImportStatus_('เตือน: จับคู่คอลัมน์สำคัญไม่เจอ (' + mapped.criticalMissing.join(', ') + ') ผังไฟล์อาจเปลี่ยนไป กรุณาตรวจสอบตารางให้ละเอียดก่อนยืนยัน', 'warn');
          } else {
            healthImportStatus_('อ่านไฟล์สำเร็จ พบ ' + mapped.records.length + ' คน — กำลังตรวจสอบว่าซ้ำกับข้อมูลเดิมหรือไม่...');
          }

          healthImportParsed_ = {
            year: year, company: company,
            fileName: file.name, mimeType: file.type, base64File: base64,
            records: mapped.records
          };

          google.script.run
            .withSuccessHandler(function (res) {
              parseBtn.disabled = false;
              if (!res || !res.success) {
                healthImportStatus_((res && res.message) || 'ตรวจสอบข้อมูลซ้ำไม่สำเร็จ', 'err');
                return;
              }
              healthImportRenderPreview_(res);
              document.getElementById('hiConfirmBtn').disabled = false;
              healthImportStatus_('พร้อมนำเข้า: เพิ่มใหม่ ' + res.willInsertCount + ' คน / เขียนทับของเดิม ' + res.willOverwriteCount + ' คน — ตรวจสอบตารางด้านล่างก่อนกดยืนยัน', 'ok');
            })
            .withFailureHandler(function (err) {
              parseBtn.disabled = false;
              healthImportStatus_('ตรวจสอบข้อมูลซ้ำไม่สำเร็จ: ' + err.message, 'err');
            })
            .previewHealthImport(sessionToken, year, mapped.records);
        })
        .catch(function (err) {
          parseBtn.disabled = false;
          healthImportStatus_('เกิดข้อผิดพลาด: ' + err.message, 'err');
        });
    }

    function healthImportRenderPreview_(res) {
      const rows = res.items.map(function (item, idx) {
        const r = item.incoming;
        const cls = item.missingName ? 'hi-row-missing' : (item.willOverwrite ? 'hi-row-overwrite' : '');
        const badge = item.missingName
          ? '<span class="hi-badge hi-badge-missing">ไม่มีชื่อ-นามสกุล</span>'
          : (item.willOverwrite
              ? '<span class="hi-badge hi-badge-overwrite">จะเขียนทับ</span>'
              : '<span class="hi-badge hi-badge-new">คนใหม่</span>');
        const compare = item.existing
          ? 'BMI ' + escapeHtml(String(item.existing.bmi || '-')) + ' → ' + escapeHtml(String(r.bmi || '-')) +
            ' | ผลรวม ' + escapeHtml(String(item.existing.overallStatus || '-')) + ' → ' + escapeHtml(String(r.overallStatus || '-'))
          : '';
        return '<tr class="' + cls + '">' +
          '<td>' + (idx + 1) + '</td>' +
          '<td>' + badge + '</td>' +
          '<td>' + escapeHtml(r.firstName) + '</td>' +
          '<td>' + escapeHtml(r.lastName) + '</td>' +
          '<td>' + escapeHtml(r.department || '') + '</td>' +
          '<td>' + escapeHtml(String(r.age || '-')) + '</td>' +
          '<td>' + escapeHtml(r.gender || '') + '</td>' +
          '<td>' + escapeHtml(String(r.bmi || '-')) + '</td>' +
          '<td>' + escapeHtml(String(r.sbp || '-')) + '/' + escapeHtml(String(r.dbp || '-')) + '</td>' +
          '<td>' + escapeHtml(String(r.fbs || '-')) + '</td>' +
          '<td>' + escapeHtml(r.overallStatus || '-') + '</td>' +
          '<td>' + escapeHtml(r.doctorNote || '') + '</td>' +
          '<td class="hi-compare">' + compare + '</td>' +
        '</tr>';
      }).join('');

      document.getElementById('hiPreview').innerHTML =
        '<div class="panel">' +
          '<div class="summary-cards">' +
            summaryCardHtml_(res.totalRows, 'ทั้งหมดในไฟล์ (คน)') +
            summaryCardHtml_(res.willInsertCount, 'เพิ่มใหม่') +
            summaryCardHtml_(res.willOverwriteCount, 'เขียนทับของเดิม') +
            summaryCardHtml_(res.missingNameCount || 0, 'ข้าม (ไม่มีชื่อ)') +
          '</div>' +
          '<div class="grid-scroll hi-table-wrap"><table class="report-table"><thead><tr>' +
            '<th>#</th><th>สถานะ</th><th>ชื่อ</th><th>นามสกุล</th><th>แผนก</th><th>อายุ</th><th>เพศ</th>' +
            '<th>BMI</th><th>ความดัน</th><th>FBS</th><th>ผลรวม</th><th>คำแนะนำแพทย์</th><th>เทียบกับของเดิม</th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '</div>';
    }

    function healthImportConfirm_() {
      if (!healthImportParsed_) { healthImportStatus_('กรุณากดปุ่ม "อ่านไฟล์ + ตรวจสอบข้อมูลซ้ำ" ก่อน', 'err'); return; }
      const state = healthImportParsed_;
      if (!confirm('ยืนยันนำเข้าข้อมูล ' + state.records.length + ' คน สำหรับปี ' + state.year + '?\nข้อมูลเดิมของคนที่ซ้ำจะถูกเขียนทับและย้อนกลับไม่ได้')) return;

      const confirmBtn = document.getElementById('hiConfirmBtn');
      const parseBtn = document.getElementById('hiParseBtn');
      confirmBtn.disabled = true;
      parseBtn.disabled = true;
      healthImportStatus_('กำลังบันทึกลงระบบ อาจใช้เวลาสักครู่ (ห้ามปิดหน้านี้)...');

      google.script.run
        .withSuccessHandler(function (res) {
          parseBtn.disabled = false;
          if (!res || !res.success) {
            confirmBtn.disabled = false;
            healthImportStatus_((res && res.message) || 'บันทึกไม่สำเร็จ', 'err');
            return;
          }
          healthImportParsed_ = null;
          document.getElementById('hiPreview').innerHTML = '';
          healthImportStatus_('นำเข้าสำเร็จ! เพิ่มใหม่ ' + res.insertedCount + ' คน / เขียนทับ ' + res.updatedCount + ' คน' +
            (res.skippedNoName ? ' / ข้าม ' + res.skippedNoName + ' คน (ไม่มีชื่อ-นามสกุล)' : ''), 'ok');
          showToast('นำเข้าผลตรวจสุขภาพสำเร็จ');
        })
        .withFailureHandler(function (err) {
          parseBtn.disabled = false;
          confirmBtn.disabled = false;
          healthImportStatus_('เกิดข้อผิดพลาดตอนบันทึก: ' + err.message, 'err');
        })
        .confirmHealthImport(sessionToken, {
          year: state.year, company: state.company,
          fileName: state.fileName, mimeType: state.mimeType, base64File: state.base64File,
          records: state.records
        });
    }

    function saveUser() {
      const username = document.getElementById('fUsername').value.trim();
      const firstName = document.getElementById('fFirstName').value.trim();
      const lastName = document.getElementById('fLastName').value.trim();
      const password = document.getElementById('fPassword').value;
      const role = document.getElementById('fRole').value;
      const errBox = document.getElementById('userModalError');
      const btn = document.getElementById('saveUserBtn');
      errBox.style.display = 'none';

      if (!username || !firstName || !lastName || (!editingUsername && !password)) {
        errBox.textContent = 'กรุณากรอกข้อมูลที่จำเป็นให้ครบ';
        errBox.style.display = 'block';
        return;
      }
      if (password && password.length < 6) {
        errBox.textContent = 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร';
        errBox.style.display = 'block';
        return;
      }

      const payload = { username: username, firstName: firstName, lastName: lastName, password: password, role: role };
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';

      const handler = {
        withSuccessHandler: function (res) {
          btn.disabled = false;
          btn.textContent = 'บันทึก';
          if (res.success) {
            showToast(editingUsername ? 'แก้ไขผู้ใช้แล้ว' : 'เพิ่มผู้ใช้แล้ว');
            closeUserModal();
            loadUserList();
          } else {
            errBox.textContent = res.message;
            errBox.style.display = 'block';
          }
        },
        withFailureHandler: function (err) {
          btn.disabled = false;
          btn.textContent = 'บันทึก';
          errBox.textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
          errBox.style.display = 'block';
        }
      };

      if (editingUsername) {
        google.script.run
          .withSuccessHandler(handler.withSuccessHandler)
          .withFailureHandler(handler.withFailureHandler)
          .updateUser(sessionToken, payload);
      } else {
        google.script.run
          .withSuccessHandler(handler.withSuccessHandler)
          .withFailureHandler(handler.withFailureHandler)
          .createUser(sessionToken, payload);
      }
    }

    /* ---------- Supervisor: เมนูหลัก (คีย์งานเข้าระบบ / รับน้ำมันและเช็คสถานะน้ำมัน) ---------- */
    let supervisorView = 'menu'; // 'menu' | 'schedule' | 'fuelStock' | 'map'

    function renderSupervisorHome(targetId) {
      const target = targetId || 'mainContent';
      if (supervisorView === 'schedule') {
        const el = document.getElementById(target);
        el.innerHTML =
          '<button type="button" class="back-link" onclick="goSupervisorView(\'menu\')">← กลับเมนูหลัก</button>' +
          '<div id="supervisorScheduleWrap"></div>';
        renderSupervisorSchedule('supervisorScheduleWrap');
        return;
      }
      if (supervisorView === 'fuelStock') {
        const el = document.getElementById(target);
        el.innerHTML =
          '<button type="button" class="back-link" onclick="goSupervisorView(\'menu\')">← กลับเมนูหลัก</button>' +
          '<div id="fuelStockWrap"></div>';
        renderFuelStockHome('fuelStockWrap');
        return;
      }
      if (supervisorView === 'map') {
        // แผนที่จุดเสี่ยงใช้ #mainContent ตรงๆ (เหมือนฝั่งคนขับ) จึงต้อง render ผ่าน mainContent เสมอ
        // ไม่ว่า targetId ที่ส่งเข้ามาจะเป็นอะไร (กันเคส Admin เรียกผ่าน tab ที่ id ไม่ใช่ mainContent)
        renderSafetyMapShared_("goSupervisorView('menu')");
        return;
      }
      if (supervisorView === 'report') {
        renderSupervisorReportPage_();
        return;
      }
      if (supervisorView === 'maintQueue') {
        renderMaintenanceCalendarPage_('mainContent', "goSupervisorView('menu')");
        return;
      }
      if (supervisorView === 'maintBook') {
        renderMaintenanceBookingPage_("goSupervisorView('menu')");
        return;
      }
      if (supervisorView === 'healthImport') {
        // หน้านำเข้าใช้ #mainContent ตรงๆ เหมือนหน้าสุขภาพอื่น เพื่อให้พื้นที่ตาราง preview กว้างพอ
        renderHealthImportPage_('mainContent', "goSupervisorView('menu')");
        return;
      }

      const el = document.getElementById(target);
      el.innerHTML =
        '<div class="driver-menu">' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'schedule\')">' +
            '<span class="dmb-icon">📋</span><span class="dmb-label">คีย์งานเข้าระบบ</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'report\')">' +
            '<span class="dmb-icon">📊</span><span class="dmb-label">รายงานข้อมูลการเติมน้ำมัน (Report &amp; Dashboard)</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'fuelStock\')">' +
            '<span class="dmb-icon">⛽</span><span class="dmb-label">รับน้ำมันและเช็คสถานะน้ำมัน</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'map\')">' +
            '<span class="dmb-icon">📍</span><span class="dmb-label">แผนที่ส่งสินค้า / จุดเสี่ยง</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="openHealthSummaryPage_()">' +
            '<span class="dmb-icon">🩺</span><span class="dmb-label">สุขภาพพนักงาน (ผลตรวจประจำปี)</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'maintQueue\')">' +
            '<span class="dmb-icon">🔧</span><span class="dmb-label">ตารางงานซ่อมบำรุง (ทั้งอู่)</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'maintBook\')">' +
            '<span class="dmb-icon">📝</span><span class="dmb-label">เปิดใบจองซ่อมแทนคนขับ</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'healthImport\')">' +
            '<span class="dmb-icon">📥</span><span class="dmb-label">นำเข้าผลตรวจสุขภาพประจำปี (จากไฟล์บริษัทตรวจ)</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="openVehicleHandoverWindow_()">' +
            '<span class="dmb-icon">🚚</span><span class="dmb-label">ใบส่งมอบ / รับคืนรถ</span>' +
          '</button>' +
        '</div>';
    }

    function goSupervisorView(view) {
      supervisorView = view;
      renderSupervisorHome('mainContent');
    }

    /* ---------- Supervisor: รายงานข้อมูลการเติมน้ำมัน (Report & Dashboard) ---------- */
    const THAI_MONTHS_UI_ = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
    let lastReportParams_ = null;

    let reportActiveTab_ = 'monthly';

    function renderSupervisorReportPage_(tab) {
      reportActiveTab_ = tab || reportActiveTab_ || 'monthly';
      const el = document.getElementById('mainContent');

      el.innerHTML =
        '<button type="button" class="back-link" onclick="goSupervisorView(\'menu\')">← กลับเมนูหลัก</button>' +
        '<div class="tab-bar">' +
          '<button type="button" class="tab-btn' + (reportActiveTab_ === 'monthly' ? ' active' : '') + '" onclick="renderSupervisorReportPage_(\'monthly\')">สรุปรายเดือน</button>' +
          '<button type="button" class="tab-btn' + (reportActiveTab_ === 'variance' ? ' active' : '') + '" onclick="renderSupervisorReportPage_(\'variance\')">ตรวจสอบความผิดปกติ</button>' +
        '</div>' +
        '<div id="reportBody"></div>';

      if (reportActiveTab_ === 'variance') renderVarianceReportBody_();
      else renderMonthlyReportBody_();
    }

    /* ---------- แท็บ 1: สรุปรายเดือน (ของเดิม) ---------- */
    function renderMonthlyReportBody_() {
      const el = document.getElementById('reportBody');
      const now = new Date();
      const curYear = now.getFullYear();

      let monthOptions = '';
      for (let m = 1; m <= 12; m++) {
        monthOptions += '<option value="' + m + '"' + (m === now.getMonth() + 1 ? ' selected' : '') + '>' + THAI_MONTHS_UI_[m] + '</option>';
      }
      let yearOptions = '';
      for (let y = curYear; y >= curYear - 2; y--) {
        yearOptions += '<option value="' + y + '"' + (y === curYear ? ' selected' : '') + '>' + y + '</option>';
      }

      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title"><h3>รายงานข้อมูลการเติมน้ำมัน (Report &amp; Dashboard)</h3></div>' +
          '<p class="panel-hint">เลือกช่วงเวลาและพนักงานขับรถที่ต้องการดูรายงาน</p>' +
          '<div class="filter-row">' +
            '<select id="repMonth">' + monthOptions + '</select>' +
            '<select id="repYear">' + yearOptions + '</select>' +
            '<select id="repDriver"><option value="ALL">ทั้งหมด (ภาพรวม)</option></select>' +
          '</div>' +
          '<div class="filter-row" style="margin-bottom:0;">' +
            '<button class="btn btn-primary" id="repSearchBtn" onclick="loadSupervisorReport_()" style="width:auto;">ค้นหา</button>' +
            '<button class="btn btn-outline" id="repExportBtn" onclick="exportSupervisorReport_()" style="width:auto;display:none;">📥 Export เป็น Excel</button>' +
          '</div>' +
        '</div>' +
        '<div id="reportResultArea"></div>';

      loadDriverOptionsForReport_();
    }

    function loadDriverOptionsForReport_() {
      google.script.run
        .withSuccessHandler(function (res) {
          const sel = document.getElementById('repDriver');
          if (!sel || !res.success) return;
          res.drivers.forEach(function (name) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            sel.appendChild(opt);
          });
        })
        .withFailureHandler(function () { /* ไม่ critical — แค่ list คนขับไม่ขึ้น ยังใช้ "ทั้งหมด" ได้ปกติ */ })
        .getDriverNameOptions(sessionToken);
    }

    function loadSupervisorReport_() {
      const month = document.getElementById('repMonth').value;
      const year = document.getElementById('repYear').value;
      const driver = document.getElementById('repDriver').value;
      const resultEl = document.getElementById('reportResultArea');
      const exportBtn = document.getElementById('repExportBtn');
      const searchBtn = document.getElementById('repSearchBtn');

      exportBtn.style.display = 'none';
      searchBtn.disabled = true;
      resultEl.innerHTML = '<div class="loading-state"><div class="spinner-lg"></div><p>กำลังประมวลผลรายงาน...</p></div>';

      google.script.run
        .withSuccessHandler(function (res) {
          searchBtn.disabled = false;
          if (!res.success) {
            resultEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดรายงานไม่สำเร็จ') + '</div>';
            return;
          }
          lastReportParams_ = { month: month, year: year, driver: driver };
          renderReportResult_(res);
          exportBtn.style.display = 'inline-block';
        })
        .withFailureHandler(function (err) {
          searchBtn.disabled = false;
          resultEl.innerHTML = '<div class="empty-state">โหลดรายงานไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getFuelMonthlyReport(sessionToken, year, month, driver);
    }

    function summaryCardHtml_(val, label) {
      return '<div class="summary-card"><div class="num">' + Number(val || 0).toLocaleString('th-TH') + '</div><div class="lbl">' + label + '</div></div>';
    }

    function renderReportResult_(res) {
      const resultEl = document.getElementById('reportResultArea');
      let html = '';

      html += '<div class="summary-cards" style="grid-template-columns:repeat(4,1fr);">' +
        summaryCardHtml_(res.openingBalance, 'ยอดยกมาต้นเดือน (ลิตร)') +
        summaryCardHtml_(res.totalReceived, 'รับเข้ารวม (ลิตร)') +
        summaryCardHtml_(res.totalUsed, 'ใช้ไปรวม (ลิตร)') +
        summaryCardHtml_(res.closingBalance, res.mode === 'all' ? 'คงเหลือปลายเดือน (ลิตร)' : 'รวมของ ' + escapeHtml(res.driverName) + ' (ลิตร)') +
      '</div>';

      html += '<div class="panel">' +
        '<div class="panel-title"><h3>บทวิเคราะห์ประจำเดือน</h3></div>' +
        '<p class="panel-hint">สรุปจากการคำนวณสถิติอัตโนมัติในระบบ (ไม่ใช่ผลจากโมเดล AI ภายนอก)</p>' +
        '<div class="topic-text">' + escapeHtml(res.analysisText) + '</div>' +
      '</div>';

      if (res.mode === 'all' && res.daily) {
        html += '<div class="panel"><div class="panel-title"><h3>สรุปยอดรายวัน (' + escapeHtml(res.monthLabel) + ')</h3></div>' +
          '<div class="grid-scroll"><table class="grid"><thead><tr><th>วันที่</th><th>ใช้ไป (ลิตร)</th><th>รับเข้า (ลิตร)</th><th>คงเหลือ (ลิตร)</th></tr></thead><tbody>' +
          res.daily.map(function (d) {
            return '<tr>' +
              '<td style="padding:9px 8px;">' + escapeHtml(d.date) + '</td>' +
              '<td style="padding:9px 8px;">' + Number(d.used).toLocaleString('th-TH') + '</td>' +
              '<td style="padding:9px 8px;">' + Number(d.received).toLocaleString('th-TH') + '</td>' +
              '<td style="padding:9px 8px;font-weight:600;">' + Number(d.balance).toLocaleString('th-TH') + '</td>' +
            '</tr>';
          }).join('') +
          '</tbody></table></div></div>';

        if (res.driverBreakdown && res.driverBreakdown.length) {
          html += '<div class="panel"><div class="panel-title"><h3>สรุปตามคนขับ (สูงสุด ' + res.driverBreakdown.length + ' อันดับ)</h3></div>' +
            res.driverBreakdown.map(function (d) {
              return '<div class="bulk-result-row ok"><span>' + escapeHtml(d.driverName) + '</span><span>' + Number(d.liters).toLocaleString('th-TH') + ' ลิตร</span></div>';
            }).join('') +
          '</div>';
        }
      } else {
        html += '<div class="panel"><div class="panel-title"><h3>รายการเติมน้ำมันของ ' + escapeHtml(res.driverName) + '</h3></div>' +
          (res.rows.length ?
            '<div class="grid-scroll"><table class="report-table"><thead><tr><th>วันที่</th><th>Fleet</th><th>ทะเบียน</th><th>สถานที่</th><th>ลิตร</th><th>ผู้เติม</th></tr></thead><tbody>' +
            res.rows.map(function (r) {
              return '<tr>' +
                '<td>' + escapeHtml(r.fillDate) + '</td>' +
                '<td>' + escapeHtml(r.fleet) + '</td>' +
                '<td>' + escapeHtml(r.plateNumber) + '</td>' +
                '<td>' + escapeHtml(r.location) + '</td>' +
                '<td>' + Number(r.litersActual).toLocaleString('th-TH') + '</td>' +
                '<td>' + escapeHtml(r.attendantName) + '</td>' +
              '</tr>';
            }).join('') + '</tbody></table></div>'
            : '<div class="empty-state">ไม่พบรายการเติมน้ำมันในช่วงที่เลือก</div>') +
        '</div>';
      }

      resultEl.innerHTML = html;
    }

    function exportSupervisorReport_() {
      if (!lastReportParams_) return;
      const btn = document.getElementById('repExportBtn');
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="border-color:rgba(16,27,51,.35);border-top-color:var(--navy);"></span>กำลังสร้างไฟล์...';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false; btn.innerHTML = original;
          if (!res.success) { showToast(res.message || 'Export ไม่สำเร็จ', true); return; }
          downloadBase64File_(res.base64, res.fileName);
          showToast('ดาวน์โหลดไฟล์สำเร็จ');
        })
        .withFailureHandler(function (err) {
          btn.disabled = false; btn.innerHTML = original;
          showToast('Export ไม่สำเร็จ: ' + err.message, true);
        })
        .exportFuelMonthlyReportExcel(sessionToken, lastReportParams_.year, lastReportParams_.month, lastReportParams_.driver);
    }

    function downloadBase64File_(base64, fileName) {
      const byteChars = atob(base64);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    /* ---------- แท็บ 2: รายงานตรวจสอบความผิดปกติของการเติมน้ำมัน (Fuel Variance & Mismatch Report) ---------- */
    function renderVarianceReportBody_() {
      const el = document.getElementById('reportBody');
      const now = new Date();
      const curYear = now.getFullYear();

      let monthOptions = '';
      for (let m = 1; m <= 12; m++) {
        monthOptions += '<option value="' + m + '"' + (m === now.getMonth() + 1 ? ' selected' : '') + '>' + THAI_MONTHS_UI_[m] + '</option>';
      }
      let yearOptions = '';
      for (let y = curYear; y >= curYear - 2; y--) {
        yearOptions += '<option value="' + y + '"' + (y === curYear ? ' selected' : '') + '>' + y + '</option>';
      }

      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title"><h3>ตรวจสอบความผิดปกติของการเติมน้ำมัน (Fuel Variance &amp; Mismatch)</h3></div>' +
          '<p class="panel-hint">แสดงเฉพาะเที่ยวที่เติมจริงไม่ตรงกับแผน — ไม่เลือก Fleet/คนขับ = แสดงทั้งหมดในเดือนนั้น</p>' +
          '<div class="filter-row">' +
            '<select id="varMonth">' + monthOptions + '</select>' +
            '<select id="varYear">' + yearOptions + '</select>' +
            '<select id="varFleet"><option value="ALL">ทุก Fleet</option></select>' +
            '<select id="varDriver"><option value="ALL">ทุกคนขับ</option></select>' +
          '</div>' +
          '<div class="filter-row" style="margin-bottom:0;">' +
            '<button class="btn btn-primary" id="varSearchBtn" onclick="loadVarianceReport_()" style="width:auto;">ค้นหา</button>' +
          '</div>' +
        '</div>' +
        '<div id="varianceResultArea"></div>';

      loadFleetOptionsForVariance_();
      loadDriverOptionsForVariance_();
      loadVarianceReport_(); // ตามเงื่อนไข: ไม่เลือก filter = โชว์ทั้งหมดทันที ไม่ต้องรอกดค้นหา
    }

    function loadFleetOptionsForVariance_() {
      google.script.run
        .withSuccessHandler(function (res) {
          const sel = document.getElementById('varFleet');
          if (!sel || !res.success) return;
          res.fleets.forEach(function (fleet) {
            const opt = document.createElement('option');
            opt.value = fleet; opt.textContent = fleet;
            sel.appendChild(opt);
          });
        })
        .withFailureHandler(function () { /* ไม่ critical — แค่ list Fleet ไม่ขึ้น ยังใช้ "ทุก Fleet" ได้ปกติ */ })
        .getFleetOptions(sessionToken);
    }

    function loadDriverOptionsForVariance_() {
      google.script.run
        .withSuccessHandler(function (res) {
          const sel = document.getElementById('varDriver');
          if (!sel || !res.success) return;
          res.drivers.forEach(function (name) {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            sel.appendChild(opt);
          });
        })
        .withFailureHandler(function () { /* ไม่ critical — แค่ list คนขับไม่ขึ้น ยังใช้ "ทุกคนขับ" ได้ปกติ */ })
        .getDriverNameOptions(sessionToken);
    }

    function loadVarianceReport_() {
      const monthEl = document.getElementById('varMonth');
      const yearEl = document.getElementById('varYear');
      const fleetEl = document.getElementById('varFleet');
      const driverEl = document.getElementById('varDriver');
      if (!monthEl || !yearEl || !fleetEl || !driverEl) return; // เผื่อ tab ถูกสลับไปแล้วก่อน callback กลับมาถึง

      const month = monthEl.value, year = yearEl.value, fleet = fleetEl.value, driver = driverEl.value;
      const resultEl = document.getElementById('varianceResultArea');
      const searchBtn = document.getElementById('varSearchBtn');

      searchBtn.disabled = true;
      resultEl.innerHTML = '<div class="loading-state"><div class="spinner-lg"></div><p>กำลังตรวจสอบข้อมูล...</p></div>';

      google.script.run
        .withSuccessHandler(function (res) {
          if (searchBtn) searchBtn.disabled = false;
          if (!res.success) {
            resultEl.innerHTML = '<div class="empty-state">' + escapeHtml(res.message || 'โหลดรายงานไม่สำเร็จ') + '</div>';
            return;
          }
          renderVarianceResult_(res);
        })
        .withFailureHandler(function (err) {
          if (searchBtn) searchBtn.disabled = false;
          resultEl.innerHTML = '<div class="empty-state">โหลดรายงานไม่สำเร็จ: ' + escapeHtml(err.message) + '</div>';
        })
        .getFuelVarianceReport(sessionToken, year, month, fleet, driver);
    }

    function renderVarianceResult_(res) {
      const resultEl = document.getElementById('varianceResultArea');
      const s = res.summary;

      let html = '<div class="summary-cards" style="grid-template-columns:repeat(4,1fr);">' +
        summaryCardHtml_(s.mismatchCount, 'รายการผิดปกติ') +
        summaryCardHtml_(s.overCount, 'เติมเกินแผน') +
        summaryCardHtml_(s.underCount, 'เติมน้อยกว่าแผน') +
        summaryCardHtml_(s.netVariance, 'ส่วนต่างสุทธิ (ลิตร)') +
      '</div>';

      if (!res.rows.length) {
        let filterNote = '';
        if (res.fleet !== 'ทั้งหมด') filterNote += ' Fleet ' + escapeHtml(res.fleet);
        if (res.driverName !== 'ทั้งหมด') filterNote += ' คนขับ ' + escapeHtml(res.driverName);
        html += '<div class="empty-state">ไม่พบรายการที่เติมน้ำมันผิดไปจากแผนในเดือน ' + escapeHtml(res.monthLabel) +
          (filterNote ? ' สำหรับ' + filterNote : '') + ' — ข้อมูลตรงตามแผนทั้งหมด</div>';
        resultEl.innerHTML = html;
        return;
      }

      html += '<div class="panel"><div class="panel-title"><h3>รายการที่เติมไม่ตรงแผน (' + escapeHtml(res.monthLabel) + ')</h3></div>' +
        '<div class="grid-scroll"><table class="report-table"><thead><tr>' +
        '<th>วันที่</th><th>Fleet</th><th>ทะเบียน</th><th>คนขับ</th><th>เส้นทาง/ลูกค้า</th><th>แผน (ลิตร)</th><th>เติมจริง (ลิตร)</th><th>ส่วนต่าง</th><th>สถานะ</th>' +
        '</tr></thead><tbody>' +
        res.rows.map(function (r) {
          const isOver = r.status === 'over';
          const varianceText = (isOver ? '+' : '') + Number(r.variance).toLocaleString('th-TH');
          return '<tr class="variance-row ' + r.status + '">' +
            '<td>' + escapeHtml(r.fillDate) + '</td>' +
            '<td>' + escapeHtml(r.fleet) + '</td>' +
            '<td>' + escapeHtml(r.plateNumber) + '</td>' +
            '<td>' + escapeHtml(r.driverName) + '</td>' +
            '<td>' + escapeHtml(r.location) + '</td>' +
            '<td>' + Number(r.litersPlanned).toLocaleString('th-TH') + '</td>' +
            '<td>' + Number(r.litersActual).toLocaleString('th-TH') + '</td>' +
            '<td style="font-weight:700;">' + varianceText + '</td>' +
            '<td><span class="status-pill ' + r.status + '">' + (isOver ? 'เติมเกิน (Over)' : 'เติมน้อยกว่าแผน (Under)') + '</span></td>' +
          '</tr>';
        }).join('') +
        '</tbody></table></div></div>';

      resultEl.innerHTML = html;
    }

    /* ---------- Supervisor: รับน้ำมันเข้าถัง + สถานะน้ำมันแบบเรียลไทม์ ---------- */
    let fuelStockTab = 'receiving'; // 'receiving' | 'status'

    function renderFuelStockHome(targetId) {
      const el = document.getElementById(targetId || 'fuelStockWrap');
      el.innerHTML =
        '<div class="tab-bar">' +
          '<button class="tab-btn' + (fuelStockTab === 'receiving' ? ' active' : '') + '" onclick="switchFuelStockTab(\'receiving\')">บันทึกรับน้ำมัน</button>' +
          '<button class="tab-btn' + (fuelStockTab === 'status' ? ' active' : '') + '" onclick="switchFuelStockTab(\'status\')">สถานะน้ำมัน</button>' +
        '</div>' +
        '<div id="fuelStockTabContent"></div>';
      if (fuelStockTab === 'status') renderFuelStatusTab('fuelStockTabContent');
      else renderFuelReceivingTab('fuelStockTabContent');
    }

    function switchFuelStockTab(tab) {
      fuelStockTab = tab;
      renderFuelStockHome('fuelStockWrap');
    }

    /** ส่วนที่ 1: ฟอร์มบันทึกการรับน้ำมันเข้าถัง + ประวัติ */
    function renderFuelReceivingTab(targetId) {
      const el = document.getElementById(targetId);
      const today = new Date();
      const todayISO = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title"><h3>บันทึกการรับน้ำมันเข้าถัง</h3></div>' +
          '<p class="panel-hint">กรอกข้อมูลทุกครั้งที่มีรถขนน้ำมันเข้ามาส่งที่แทงก์ เพื่อให้ระบบคำนวณสต็อกคงเหลือได้ถูกต้อง</p>' +
          '<div class="field" style="max-width:260px;">' +
            '<label>วันที่รับน้ำมันเข้า</label>' +
            '<input type="date" id="frDate" value="' + todayISO + '">' +
          '</div>' +
          '<div class="field" style="max-width:260px;">' +
            '<label>เลขที่ Invoice สั่งซื้อน้ำมัน</label>' +
            '<input type="text" id="frInvoice" placeholder="เช่น INV-2026-0088">' +
          '</div>' +
          '<div class="field" style="max-width:260px;">' +
            '<label>จำนวนน้ำมันที่รับเข้า (ลิตร)</label>' +
            '<input type="number" id="frLiters" placeholder="เช่น 15000" min="0" step="1">' +
          '</div>' +
          '<button class="btn btn-amber" id="saveFuelReceivingBtn" style="max-width:260px;" onclick="saveFuelReceiving()">บันทึกการรับน้ำมัน</button>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>ประวัติการรับน้ำมันเข้าถัง</h3></div>' +
          '<div id="fuelReceivingHistory"><div class="empty-state">กำลังโหลด...</div></div>' +
        '</div>';
      loadFuelReceivingHistory();
    }

    function saveFuelReceiving() {
      const dateISO = document.getElementById('frDate').value;
      const invoiceNo = document.getElementById('frInvoice').value.trim();
      const liters = document.getElementById('frLiters').value;

      if (!dateISO) { showToast('กรุณาระบุวันที่รับน้ำมันเข้า', true); return; }
      if (!invoiceNo) { showToast('กรุณากรอกเลขที่ Invoice', true); return; }
      if (!liters || Number(liters) <= 0) { showToast('กรุณากรอกจำนวนลิตรให้ถูกต้อง', true); return; }

      const btn = document.getElementById('saveFuelReceivingBtn');
      btn.disabled = true;
      btn.textContent = 'กำลังบันทึก...';
      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'บันทึกการรับน้ำมัน';
          if (!res.success) { showToast(res.message, true); return; }
          showToast('บันทึกการรับน้ำมันเรียบร้อยแล้ว');
          document.getElementById('frInvoice').value = '';
          document.getElementById('frLiters').value = '';
          loadFuelReceivingHistory();
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'บันทึกการรับน้ำมัน';
          showToast('บันทึกไม่สำเร็จ: ' + err.message, true);
        })
        .addFuelReceiving(sessionToken, { dateISO: dateISO, invoiceNo: invoiceNo, liters: liters });
    }

    function loadFuelReceivingHistory() {
      const holder = document.getElementById('fuelReceivingHistory');
      if (!holder) return;
      holder.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          renderFuelReceivingHistoryTable(res.rows);
        })
        .withFailureHandler(function (err) { showToast('โหลดประวัติไม่สำเร็จ: ' + err.message, true); })
        .getFuelReceivingHistory(sessionToken);
    }

    function renderFuelReceivingHistoryTable(rows) {
      const holder = document.getElementById('fuelReceivingHistory');
      if (!holder) return;
      if (!rows.length) { holder.innerHTML = '<div class="empty-state">ยังไม่มีประวัติการรับน้ำมัน</div>'; return; }
      let html = '<div class="grid-scroll"><table class="report-table"><thead><tr>' +
        '<th>No.</th><th>วันที่รับเข้า</th><th>เลขที่ Invoice</th><th>จำนวนลิตร</th><th>บันทึกโดย</th>' +
      '</tr></thead><tbody>';
      rows.forEach(function (r, i) {
        html += '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHtml(r.date) + '</td>' +
          '<td>' + escapeHtml(r.invoiceNo) + '</td>' +
          '<td>' + Number(r.liters).toLocaleString() + '</td>' +
          '<td>' + escapeHtml(r.createdBy) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      holder.innerHTML = html;
    }

    /** ส่วนที่ 2: สถานะน้ำมันแบบเรียลไทม์ + คำแนะนำการสั่งซื้อ
     *  ดึงข้อมูลและคำนวณใหม่ทุกครั้งที่เข้าหน้านี้ (ไม่แคชค่าเก่าไว้) */
    function renderFuelStatusTab(targetId) {
      const el = document.getElementById(targetId);
      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title">' +
            '<h3>สถานะน้ำมันคงเหลือ (เรียลไทม์)</h3>' +
            '<button class="btn btn-outline btn-sm" style="width:auto;" onclick="loadFuelInventoryStatus()">🔄 รีเฟรช</button>' +
          '</div>' +
          '<div id="fuelStatusHolder"><div class="empty-state">กำลังโหลด...</div></div>' +
        '</div>';
      loadFuelInventoryStatus();
    }

    function loadFuelInventoryStatus() {
      const holder = document.getElementById('fuelStatusHolder');
      if (!holder) return;
      holder.innerHTML = '<div class="empty-state">กำลังคำนวณ...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          renderFuelStatusDashboard(res);
        })
        .withFailureHandler(function (err) { showToast('โหลดสถานะน้ำมันไม่สำเร็จ: ' + err.message, true); })
        .getFuelInventoryStatus(sessionToken);
    }

    function renderFuelStatusDashboard(s) {
      const holder = document.getElementById('fuelStatusHolder');
      if (!holder) return;

      let banners = '';
      if (s.dataWarning) {
        banners += '<div class="alert-banner danger">⚠️ ยอดเบิกจ่ายจริงมากกว่ายอดรับน้ำมันสะสมที่บันทึกไว้ (คงเหลือคำนวณได้ ' +
          Number(s.currentStock).toLocaleString() + ' ลิตร) ตรวจสอบว่าบันทึกใบรับน้ำมันครบทุกใบหรือไม่</div>';
      }
      if (s.shouldReorder) {
        banners += '<div class="alert-banner warn">⏰ น้ำมันคงเหลือคาดว่าจะใช้ได้อีกประมาณ ' + s.daysRemaining + ' วัน (ไม่เกินเกณฑ์ ' + s.reorderThresholdDays + ' วัน) ควรพิจารณาสั่งซื้อเพิ่มเร็วๆ นี้</div>';
      }

      const fillClass = s.fillPercent <= 20 ? 'low' : '';
      const rateText = s.dailyConsumptionRate > 0
        ? s.dailyConsumptionRate.toLocaleString() + ' ลิตร/วัน'
        : 'ยังไม่มีข้อมูลเพียงพอ';
      const daysText = s.daysRemaining === null ? '-' : s.daysRemaining + ' วัน';
      const basisText = s.consumptionBasis && s.consumptionBasis.indexOf('partial-history') === 0
        ? '(ระบบมีประวัติยังไม่ครบ 30 วัน ใช้ข้อมูลเท่าที่มีอยู่ ' + s.consumptionSampleDays + ' วัน)'
        : '(ค่าเฉลี่ยแบบ Time-Based ย้อนหลัง ' + s.consumptionSampleDays + ' วันปฏิทิน)';

      let recoHtml = '<div class="reco-grid">';
      s.recommendations.forEach(function (r) {
        const cls = r.fits ? 'fits' : 'overflow';
        recoHtml += '<div class="reco-card ' + cls + '">' +
          '<div class="reco-size">+' + r.size.toLocaleString() + ' ลิตร</div>' +
          (r.fits
            ? '<div class="reco-detail">สั่งได้พอดี ไม่เกินความจุถัง<br>เติมแล้วจะมี ~' + Number(r.newTotal).toLocaleString() + ' ลิตร</div><span class="reco-tag">สั่งได้</span>'
            : '<div class="reco-detail">เกินความจุถัง ~' + Number(r.overflow).toLocaleString() + ' ลิตร ถ้าสั่งไซส์นี้ตอนนี้</div><span class="reco-tag">เกินความจุ</span>') +
        '</div>';
      });
      recoHtml += '</div>';
      recoHtml += '<p class="panel-hint" style="margin-top:10px;">พื้นที่ว่างในถังตอนนี้ ~' + Number(s.spaceAvailable).toLocaleString() + ' ลิตร (คำนวณจากความจุถัง ' + Number(s.tankCapacity).toLocaleString() + ' ลิตร ลบด้วยของคงเหลือปัจจุบัน)</p>';

      holder.innerHTML =
        banners +
        '<div class="tank-gauge">' +
          '<div class="tank-gauge-labels"><span>0 ลิตร</span><span>ความจุถัง ' + Number(s.tankCapacity).toLocaleString() + ' ลิตร</span></div>' +
          '<div class="tank-gauge-bar">' +
            '<div class="tank-gauge-fill ' + fillClass + '" style="width:' + s.fillPercent + '%;"></div>' +
            '<div class="tank-gauge-pct">' + Number(s.currentStock).toLocaleString() + ' ลิตร (' + s.fillPercent + '%)</div>' +
          '</div>' +
        '</div>' +
        '<div class="summary-cards">' +
          '<div class="summary-card"><div class="num">' + Number(s.totalReceived).toLocaleString() + '</div><div class="lbl">รับเข้าสะสมทั้งหมด (ลิตร)</div></div>' +
          '<div class="summary-card"><div class="num">' + Number(s.totalDispensed).toLocaleString() + '</div><div class="lbl">เบิกจ่ายจริงสะสม (ลิตร)</div></div>' +
          '<div class="summary-card"><div class="num">' + daysText + '</div><div class="lbl">คาดว่าใช้ได้อีก</div></div>' +
        '</div>' +
        '<p class="panel-hint">อัตราการใช้น้ำมันเฉลี่ย: <strong style="color:var(--navy);">' + rateText + '</strong> ' + basisText + '</p>' +
        '<div class="section-head" style="margin-top:6px;"><h3 style="font-size:15px;">คำแนะนำการสั่งซื้อเพิ่ม</h3></div>' +
        recoHtml +
        '<p class="panel-hint" style="margin-top:14px;">คำนวณล่าสุดเมื่อ ' + new Date(s.generatedAt).toLocaleString('th-TH') + '</p>';
    }

    /* ---------- Supervisor: Fuel Schedule (Excel-like grid) ---------- */
    const GRID_COLS = ['date', 'location', 'district', 'province', 'liters', 'plateNumber', 'driverFirstName', 'driverLastName'];
    const GRID_HEADERS = ['วันที่ให้น้ำมัน', 'สถานที่ส่งสินค้า', 'อำเภอ', 'จังหวัด', 'จำนวนลิตร', 'ทะเบียน', 'ชื่อ (คนขับ)', 'นามสกุล (คนขับ)'];
    let gridRowCount = 8;
    let gridUndoStack = [];
    const GRID_UNDO_LIMIT = 20;
    let currentMonthFilter = '';
    let bulkFleetValue = ''; // ค่า Fleet ส่วนกลาง คงค้างไว้ข้ามการบันทึกแต่ละชุด จนกว่าหัวหน้างานจะเปลี่ยนเอง

    function renderSupervisorSchedule(targetId) {
      const el = document.getElementById(targetId || 'mainContent');
      currentMonthFilter = ''; // ค่าเริ่มต้น: แสดงทุกเดือน กันเคสมองไม่เห็นรายการเก่าเพราะลืมว่ามีตัวกรองเดือนซ่อนอยู่
      gridUndoStack = [];

      el.innerHTML =
        '<div class="panel">' +
          '<div class="panel-title"><h3>เพิ่มข้อมูลใหม่</h3></div>' +
          '<p class="panel-hint">1) ระบุ Fleet ที่จะใช้กับข้อมูลชุดนี้ก่อน · 2) วางข้อมูลจาก Excel ลงตารางด้านล่าง (คลิกช่องแรกแล้ว Ctrl+V) · 3) กดบันทึก — ระบบจะผูก Fleet นี้ให้ทุกแถวอัตโนมัติ ถ้าจะเพิ่มงานของ Fleet อื่นต่อ ให้เปลี่ยนค่า Fleet แล้ววางข้อมูลชุดใหม่ทับได้เลย</p>' +
          '<div class="field" style="max-width:320px;">' +
            '<label>Fleet (ใช้กับทุกแถวด้านล่างนี้)</label>' +
            '<input type="text" id="bulkFleetInput" list="fleetSuggestions" placeholder="เช่น IRPC, PTT, HMC" value="' + escAttr(bulkFleetValue) + '" oninput="bulkFleetValue = this.value">' +
            '<datalist id="fleetSuggestions"></datalist>' +
          '</div>' +
          '<div class="grid-scroll"><table class="grid" id="scheduleGrid"></table></div>' +
          '<div class="grid-toolbar">' +
            '<button class="btn btn-outline btn-sm" onclick="addGridRow()">+ เพิ่มแถว</button>' +
            '<button class="btn btn-outline btn-sm" onclick="undoGrid()">↶ ย้อนกลับ</button>' +
            '<button class="btn btn-outline btn-sm" onclick="clearGrid()">ล้างข้อมูล</button>' +
            '<button class="btn btn-amber btn-sm" id="saveGridBtn" onclick="saveGridRows()">บันทึกทั้งหมด</button>' +
          '</div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-title"><h3>รายการที่บันทึกแล้ว</h3></div>' +
          '<div class="filter-row">' +
            '<label style="font-size:13px;font-weight:600;">เดือน:</label>' +
            '<input type="month" id="monthFilterInput" value="' + currentMonthFilter + '" onchange="onMonthFilterChange()">' +
            '<button class="btn btn-outline btn-sm" style="width:auto;" onclick="clearMonthFilter()">ทุกเดือน</button>' +
            '<label style="font-size:13px;font-weight:600;">สถานะ:</label>' +
            '<select id="statusFilterInput" onchange="onStatusFilterChange()">' +
              '<option value="">ทั้งหมด</option>' +
              '<option value="รอเติม">รอเติม</option>' +
              '<option value="เติมแล้ว">เติมแล้ว</option>' +
              '<option value="ไม่ได้เติม">ไม่ได้เติม</option>' +
            '</select>' +
          '</div>' +
          '<p class="panel-hint" style="margin-top:-6px;">ค่าเริ่มต้นแสดงทุกเดือน — เลือกเดือนเพื่อกรองให้แคบลง</p>' +
          '<div id="scheduleList"><div class="empty-state">กำลังโหลด...</div></div>' +
        '</div>';

      buildGridTable();
      loadScheduleList();
    }

    function buildGridTable() {
      const table = document.getElementById('scheduleGrid');
      let html = '<thead><tr>' + GRID_HEADERS.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '<th></th></tr></thead><tbody>';
      for (let r = 0; r < gridRowCount; r++) {
        html += '<tr>';
        for (let c = 0; c < GRID_COLS.length; c++) {
          html += '<td><input type="text" id="cell-' + r + '-' + c + '" data-row="' + r + '" data-col="' + c + '" ' +
            'onpaste="handleGridPaste(event,' + r + ',' + c + ')"></td>';
        }
        html += '<td style="text-align:center;"><button type="button" class="icon-btn" title="ลบแถวนี้" onclick="deleteGridRow(' + r + ')">🗑</button></td>';
        html += '</tr>';
      }
      table.innerHTML = html + '</tbody>';
    }

    function pushGridUndo() {
      gridUndoStack.push({ rowCount: gridRowCount, values: readGridValues() });
      if (gridUndoStack.length > GRID_UNDO_LIMIT) gridUndoStack.shift();
    }

    function undoGrid() {
      if (!gridUndoStack.length) { showToast('ไม่มีการเปลี่ยนแปลงให้ย้อนกลับ', true); return; }
      const snapshot = gridUndoStack.pop();
      gridRowCount = snapshot.rowCount;
      buildGridTable();
      writeGridValues(snapshot.values);
    }

    function deleteGridRow(rowIndex) {
      if (gridRowCount <= 1) { showToast('ต้องมีอย่างน้อย 1 แถว', true); return; }
      pushGridUndo();
      const values = readGridValues();
      values.splice(rowIndex, 1);
      gridRowCount = gridRowCount - 1;
      buildGridTable();
      writeGridValues(values);
    }

    function addGridRow() {
      pushGridUndo();
      gridRowCount++;
      const values = readGridValues();
      buildGridTable();
      writeGridValues(values);
    }

    function clearGrid() {
      if (!confirm('ล้างข้อมูลในตารางทั้งหมด?')) return;
      pushGridUndo();
      gridRowCount = 8;
      buildGridTable();
    }

    function readGridValues() {
      const values = [];
      for (let r = 0; r < gridRowCount; r++) {
        const row = [];
        for (let c = 0; c < GRID_COLS.length; c++) {
          const input = document.getElementById('cell-' + r + '-' + c);
          row.push(input ? input.value : '');
        }
        values.push(row);
      }
      return values;
    }

    function writeGridValues(values) {
      for (let r = 0; r < values.length; r++) {
        for (let c = 0; c < GRID_COLS.length; c++) {
          const input = document.getElementById('cell-' + r + '-' + c);
          if (input) input.value = values[r][c] || '';
        }
      }
    }

    function handleGridPaste(e, startRow, startCol) {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text) return;
      let rows = text.replace(/\r/g, '').split('\n');
      if (rows.length && rows[rows.length - 1] === '') rows.pop();
      const isMultiCell = rows.length > 1 || rows[0].indexOf('\t') !== -1;
      if (!isMultiCell) return; // ให้เบราว์เซอร์วางค่าปกติสำหรับช่องเดียว

      e.preventDefault();
      pushGridUndo();

      // สร้างแถวเพิ่มถ้าจำเป็น แล้วค่อยเติมค่า (ต้อง rebuild ตารางก่อนถ้าจำนวนแถวเปลี่ยน)
      const neededRows = startRow + rows.length;
      if (neededRows > gridRowCount) {
        const values = readGridValues();
        gridRowCount = neededRows;
        buildGridTable();
        writeGridValues(values);
      }
      rows.forEach(function (rowText, rOffset) {
        const cells = rowText.split('\t');
        const targetRow = startRow + rOffset;
        cells.forEach(function (val, cOffset) {
          const targetCol = startCol + cOffset;
          if (targetCol >= GRID_COLS.length) return;
          const input = document.getElementById('cell-' + targetRow + '-' + targetCol);
          if (input) input.value = val.trim();
        });
      });
    }

    function saveGridRows() {
      const fleet = (document.getElementById('bulkFleetInput').value || '').trim();
      if (!fleet) {
        showToast('กรุณาระบุ Fleet ก่อนบันทึก (ใช้ค่าเดียวกันกับทุกแถวในชุดนี้)', true);
        document.getElementById('bulkFleetInput').focus();
        return;
      }
      bulkFleetValue = fleet;

      const values = readGridValues();
      const rows = values
        .filter(function (row) { return row.some(function (v) { return v.trim() !== ''; }); })
        .map(function (row) {
          const obj = { fleet: fleet };
          GRID_COLS.forEach(function (key, i) { obj[key] = row[i].trim(); });
          return obj;
        });

      if (!rows.length) { showToast('ยังไม่มีข้อมูลให้บันทึก', true); return; }

      const missingDate = rows.some(function (r) { return !r.date || !r.plateNumber; });
      if (missingDate) {
        showToast('กรุณากรอกอย่างน้อย วันที่ และ ทะเบียน ให้ครบทุกแถว', true);
        return;
      }

      const btn = document.getElementById('saveGridBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'บันทึกทั้งหมด';
          if (res.success) {
            showToast('บันทึก ' + res.count + ' รายการเรียบร้อย');
            gridRowCount = 8;
            gridUndoStack = [];
            buildGridTable();
            loadScheduleList();
          } else {
            showToast(res.message, true);
          }
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'บันทึกทั้งหมด';
          showToast('บันทึกไม่สำเร็จ: ' + err.message, true);
        })
        .addFuelScheduleRows(sessionToken, rows);
    }

    function onMonthFilterChange() {
      currentMonthFilter = document.getElementById('monthFilterInput').value;
      loadScheduleList();
    }

    function clearMonthFilter() {
      currentMonthFilter = '';
      const input = document.getElementById('monthFilterInput');
      if (input) input.value = '';
      loadScheduleList();
    }

    let scheduleRowsCache = [];
    let currentStatusFilter = '';

    function onStatusFilterChange() {
      currentStatusFilter = document.getElementById('statusFilterInput').value;
      renderScheduleList(scheduleRowsCache);
    }

    function loadScheduleList() {
      const list = document.getElementById('scheduleList');
      list.innerHTML = '<div class="empty-state">กำลังโหลด...</div>';
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          scheduleRowsCache = res.rows;
          renderScheduleList(scheduleRowsCache);
          updateFleetSuggestions_(scheduleRowsCache);
        })
        .withFailureHandler(function (err) { showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true); })
        .getFuelSchedule(sessionToken, currentMonthFilter);
    }

    /* เติม Fleet ที่เคยใช้ไว้แล้วลงในช่วยเลือก (datalist) ของช่อง Fleet ส่วนกลาง เพื่อกดเลือกซ้ำได้เร็ว ไม่ต้องพิมพ์ใหม่ทุกครั้ง */
    function updateFleetSuggestions_(rows) {
      const datalist = document.getElementById('fleetSuggestions');
      if (!datalist) return;
      const seen = {};
      const fleets = [];
      rows.forEach(function (r) {
        const f = (r.fleet || '').trim();
        if (f && !seen[f]) { seen[f] = true; fleets.push(f); }
      });
      datalist.innerHTML = fleets.map(function (f) { return '<option value="' + escAttr(f) + '">'; }).join('');
    }

    function statusPillClass_(status) {
      if (status === 'เติมแล้ว') return 'filled';
      if (status === 'ไม่ได้เติม') return 'missed';
      return 'pending';
    }

    function renderScheduleList(allRows) {
      const list = document.getElementById('scheduleList');
      const rows = currentStatusFilter ? allRows.filter(function (r) { return r.status === currentStatusFilter; }) : allRows;
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state">ไม่มีข้อมูลตามเงื่อนไขที่เลือก</div>';
        return;
      }
      list.innerHTML = rows.map(function (r) {
        const isFilled = r.status === 'เติมแล้ว';
        const isPending = r.status === 'รอเติม';
        return (
          '<div class="user-card">' +
            '<div class="user-info">' +
              '<div class="name">' + escapeHtml(r.date) + ' · ' + escapeHtml(r.plateNumber) + ' — ' + escapeHtml(r.driverName) + '</div>' +
              '<div class="meta">' +
                (r.fleet ? '<span class="fleet-pill">' + escapeHtml(r.fleet) + '</span>' : '') +
                escapeHtml(r.location) + ' · ' + escapeHtml(r.district) + ' ' + escapeHtml(r.province) + ' · ' + escapeHtml(String(r.liters)) + ' ลิตร' +
              '</div>' +
              '<div class="meta"><span class="status-pill ' + statusPillClass_(r.status) + '">' + escapeHtml(r.status) + '</span></div>' +
              (r.remark ? '<div class="remark-note">หมายเหตุ: ' + escapeHtml(r.remark) + '</div>' : '') +
            '</div>' +
            '<div class="user-actions">' +
              (isPending ? '<button class="icon-btn" title="เพิ่มลิตร (แจ้งขอเติมเพิ่ม)" onclick=\'topUpSchedule(' + JSON.stringify(r) + ')\'>⛽+</button>' : '') +
              '<button class="icon-btn" title="แก้ไข" onclick=\'openScheduleModal(' + JSON.stringify(r) + ')\'>✎</button>' +
              (isFilled
                ? '<button class="icon-btn" title="เติมน้ำมันไปแล้ว ลบไม่ได้" disabled style="opacity:.35;cursor:not-allowed;">🗑</button>'
                : '<button class="icon-btn" title="ลบ" onclick="confirmDeleteSchedule(\'' + escAttr(r.id) + '\')">🗑</button>') +
            '</div>' +
          '</div>'
        );
      }).join('');
    }

    function topUpSchedule(row) {
      const addStr = prompt('เพิ่มน้ำมันเข้า "เที่ยวงานปัจจุบัน" ของทะเบียน ' + row.plateNumber + '\nปัจจุบันกำหนดไว้ ' + row.liters + ' ลิตร\nต้องการเพิ่มกี่ลิตร?');
      if (addStr === null) return;
      const addAmount = Number(addStr);
      if (!addAmount || addAmount <= 0) { showToast('กรุณากรอกจำนวนลิตรที่ถูกต้อง', true); return; }

      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) { showToast('เพิ่มลิตรแล้ว รวมเป็น ' + res.newLiters + ' ลิตร'); loadScheduleList(); }
          else { showToast(res.message, true); }
        })
        .withFailureHandler(function (err) { showToast(err.message, true); })
        .topUpFuelLiters(sessionToken, row.id, addAmount);
    }

    function openScheduleModal(row) {
      document.getElementById('scheduleModalError').style.display = 'none';
      document.getElementById('scheduleModal').dataset.id = row.id;
      document.getElementById('sDate').value = row.date || '';
      document.getElementById('sFleet').value = row.fleet || '';
      document.getElementById('sLocation').value = row.location || '';
      document.getElementById('sDistrict').value = row.district || '';
      document.getElementById('sProvince').value = row.province || '';
      document.getElementById('sLiters').value = row.liters || '';
      document.getElementById('sPlate').value = row.plateNumber || '';
      document.getElementById('sDriverFirstName').value = row.driverFirstName || '';
      document.getElementById('sDriverLastName').value = row.driverLastName || '';
      document.getElementById('sStatus').value = row.status || 'รอเติม';
      document.getElementById('sRemark').value = row.remark || '';

      const isFilled = row.status === 'เติมแล้ว';
      const coreFieldIds = ['sDate', 'sFleet', 'sLocation', 'sDistrict', 'sProvince', 'sLiters', 'sPlate', 'sDriverFirstName', 'sDriverLastName', 'sStatus'];
      coreFieldIds.forEach(function (id) { document.getElementById(id).disabled = isFilled; });
      const noteEl = document.getElementById('scheduleModalRestrictNote');
      if (noteEl) noteEl.style.display = isFilled ? 'block' : 'none';

      document.getElementById('scheduleModal').classList.add('open');
    }

    function closeScheduleModal() {
      document.getElementById('scheduleModal').classList.remove('open');
    }

    function saveScheduleRow() {
      const id = document.getElementById('scheduleModal').dataset.id;
      const payload = {
        id: id,
        date: document.getElementById('sDate').value.trim(),
        fleet: document.getElementById('sFleet').value.trim(),
        location: document.getElementById('sLocation').value.trim(),
        district: document.getElementById('sDistrict').value.trim(),
        province: document.getElementById('sProvince').value.trim(),
        liters: document.getElementById('sLiters').value.trim(),
        plateNumber: document.getElementById('sPlate').value.trim(),
        driverFirstName: document.getElementById('sDriverFirstName').value.trim(),
        driverLastName: document.getElementById('sDriverLastName').value.trim(),
        status: document.getElementById('sStatus').value,
        remark: document.getElementById('sRemark').value.trim()
      };
      const errBox = document.getElementById('scheduleModalError');
      if (!document.getElementById('sDate').disabled && (!payload.date || !payload.plateNumber)) {
        errBox.textContent = 'กรุณากรอกอย่างน้อย วันที่ และ ทะเบียน';
        errBox.style.display = 'block';
        return;
      }
      const btn = document.getElementById('saveScheduleBtn');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>กำลังบันทึก...';

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'บันทึก';
          if (res.success) {
            showToast(res.restricted ? res.message : 'แก้ไขเรียบร้อย');
            closeScheduleModal();
            loadScheduleList();
          } else {
            errBox.textContent = res.message;
            errBox.style.display = 'block';
          }
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'บันทึก';
          errBox.textContent = 'บันทึกไม่สำเร็จ: ' + err.message;
          errBox.style.display = 'block';
        })
        .updateFuelScheduleRow(sessionToken, payload);
    }

    function confirmDeleteSchedule(id) {
      if (!confirm('ยืนยันลบรายการนี้?')) return;
      google.script.run
        .withSuccessHandler(function (res) {
          if (res.success) { showToast('ลบรายการแล้ว'); loadScheduleList(); }
          else { showToast(res.message, true); }
        })
        .withFailureHandler(function (err) { showToast(err.message, true); })
        .deleteFuelScheduleRow(sessionToken, id);
    }


    /* ---------- Utils ---------- */
    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function escAttr(str) { return String(str).replace(/'/g, "\\'"); }

    /* Enter key submits login */
    document.addEventListener('DOMContentLoaded', function () {
      document.getElementById('loginPassword').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') doLogin();
      });
      tryAutoLogin();
      setupPwa_();
      renderOfflineBanner_(); // เผื่อมีรายการค้างซิงค์จากรอบก่อนหน้าที่ปิดแอปไปตอนยังไม่ได้ซิงค์
      trySyncOfflineQueue_(false);
    });
