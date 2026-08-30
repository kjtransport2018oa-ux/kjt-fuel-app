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

function callGasApi_(functionName, args) {
  return fetch(API_BASE_URL, {
    method: 'POST',
    // ใช้ text/plain เพื่อให้เป็น "simple request" เลี่ยง CORS preflight (OPTIONS) ที่ Apps Script รองรับได้ไม่ดี
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: functionName, args: args })
  }).then(function (res) {
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
      FuelAttendant: 'คนเติมน้ำมัน'
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
      } else if (currentUser.role === 'FuelAttendant') {
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
        '</div>' +
        '<div id="adminTabContent"></div>';
      if (adminActiveTab === 'users') renderAdminUsers('adminTabContent');
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
      list.innerHTML = rows.map(function (r) {
        return (
          '<div class="user-card">' +
            '<div class="user-info">' +
              '<div class="name">' + escapeHtml(r.date) + ' · ทะเบียน ' + escapeHtml(r.plateNumber) + '</div>' +
              '<div class="meta">' +
                (r.fleet ? '<span class="fleet-pill">' + escapeHtml(r.fleet) + '</span>' : '') +
                escapeHtml(r.location) + (r.location ? ' · ' : '') + escapeHtml(r.district) + ' ' + escapeHtml(r.province) +
                ' · ' + escapeHtml(String(r.liters)) + ' ลิตร' +
              '</div>' +
              '<div class="meta"><span class="status-pill filled">เติมแล้ว</span></div>' +
            '</div>' +
          '</div>'
        );
      }).join('');
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
            '<input type="text" id="safSearchInput" list="safShopList" placeholder="พิมพ์ชื่อร้าน/โรงงาน..." oninput="onSafetySearchInput_()" onkeydown="if(event.key===\'Enter\')doSafetySearch_()">' +
            '<button type="button" class="search-clear-btn" id="safClearBtn" onclick="clearSafetySearch_()">✕</button>' +
            '<datalist id="safShopList"></datalist>' +
          '</div>' +
          '<button class="btn btn-primary" onclick="doSafetySearch_()">ค้นหา</button>' +
        '</div>' +
        '<div id="safetyDetailArea"></div>';

      loadSafetyRoutes_();
    }

    function loadSafetyRoutes_() {
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.success) { showToast(res.message, true); return; }
          safetyRoutesCache = res.rows;
        })
        .withFailureHandler(function (err) { showToast('โหลดข้อมูลไม่สำเร็จ: ' + err.message, true); })
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

      const el = document.getElementById('mainContent');
      el.innerHTML =
        '<div class="driver-menu">' +
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

      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          btn.textContent = 'ยืนยันการเติมน้ำมัน';
          if (res.success) {
            showToast('บันทึกการเติมน้ำมันเรียบร้อย (' + res.litersActual + ' ลิตร)');
            attendantView = 'menu';
            attendantDriver = null;
            attendantJobs = [];
            attendantSelectedJob = null;
            renderAttendantHome();
          } else {
            showToast(res.message, true);
          }
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'ยืนยันการเติมน้ำมัน';
          showToast('บันทึกไม่สำเร็จ: ' + err.message, true);
        })
        .submitFuelLog(sessionToken, {
          scheduleId: attendantSelectedJob.id,
          startMeter: attendantStartMeter,
          endMeter: attendantEndMeter,
          driverSignature: driverSigPad.toDataURL(),
          attendantSignature: staffSigPad.toDataURL()
        });
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
          '<p class="panel-hint">วางจาก Excel ได้เลย (คลิกช่องแรกแล้ว Ctrl+V) — ช่อง Role พิมพ์ได้ทั้ง Admin / Supervisor / Driver / FuelAttendant หรือภาษาไทย เช่น หัวหน้างาน, คนขับ, คนเติมน้ำมัน</p>' +
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

      const el = document.getElementById(target);
      el.innerHTML =
        '<div class="driver-menu">' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'schedule\')">' +
            '<span class="dmb-icon">📋</span><span class="dmb-label">คีย์งานเข้าระบบ</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'fuelStock\')">' +
            '<span class="dmb-icon">⛽</span><span class="dmb-label">รับน้ำมันและเช็คสถานะน้ำมัน</span>' +
          '</button>' +
          '<button type="button" class="driver-menu-btn" onclick="goSupervisorView(\'map\')">' +
            '<span class="dmb-icon">📍</span><span class="dmb-label">แผนที่ส่งสินค้า / จุดเสี่ยง</span>' +
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
    });
