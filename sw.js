// Service Worker — ทำ 2 อย่าง: (1) ให้เบราว์เซอร์เห็นว่าผ่านเกณฑ์ "ติดตั้งได้" ของ PWA
// (2) แคชหน้าเว็บหลักไว้เผื่อเน็ตหลุด/อินเทอร์เน็ตช้าตอนเปิดแอป
// สำคัญ: ไม่แตะ request ที่เป็น POST เลย (คำขอที่ยิงไปหา Apps Script API ทั้งหมดเป็น POST)
// เพื่อไม่ให้ไปยุ่งกับการเชื่อมต่อฐานข้อมูลจริงโดยไม่ตั้งใจ

// Firebase Cloud Messaging — รับ push ตอนแอปอยู่เบื้องหลัง/ปิดแท็บ
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyA2JMm1AY4kh_tt9--4d6_trgjOAm-a6iA',
  authDomain: 'kjt-hub.firebaseapp.com',
  projectId: 'kjt-hub',
  storageBucket: 'kjt-hub.firebasestorage.app',
  messagingSenderId: '101679191796',
  appId: '1:101679191796:web:f0c3e3c8ce78f2bb74b0a1'
});

const messaging = firebase.messaging();

/** สำคัญ: อ่านชื่อ/เนื้อหาจาก payload.data เป็นหลัก (ไม่ใช่ payload.notification)
 *  เหตุผล: ถ้าข้อความที่ยิงมาจากฝั่งเซิร์ฟเวอร์มีฟิลด์ "notification" ติดมาด้วย เบราว์เซอร์ (Chrome)
 *  จะเด้งแจ้งเตือนให้เอง "อีกอันหนึ่ง" นอกเหนือจากที่โค้ดตรงนี้เรียก showNotification() เอง
 *  กลายเป็นเห็นแจ้งเตือนซ้อนกัน 2 อัน (บั๊กที่เจอ: กดอันหนึ่งเข้าแอปได้ปกติ อีกอันกดแล้วเจอหน้า 404 —
 *  อันที่ 404 คือแจ้งเตือนที่ Chrome สร้างเองจาก payload.notification โดยอัตโนมัติ ไม่ได้ผ่านโค้ดของเรา
 *  จึงไม่มี notificationclick handler ของเราคอยจับ เลยเปิดลิงก์ default ที่ไม่ตรงกับ path จริงของเว็บ)
 *  ทางแก้ถาวรจริงๆ ต้องแก้ที่ฝั่งเซิร์ฟเวอร์ (โค้ด Apps Script ที่ยิง FCM) ให้ส่งเฉพาะฟิลด์ "data"
 *  เท่านั้น ห้ามมีฟิลด์ "notification" ติดไปด้วย — โค้ดฝั่งนี้ปรับให้รองรับทั้งสองแบบไว้ก่อน แต่ตราบใด
 *  ที่เซิร์ฟเวอร์ยังส่ง "notification" มาด้วย ปัญหาแจ้งเตือนซ้อน 2 อันจะยังไม่หายไปทั้งหมด */
messaging.onBackgroundMessage(function (payload) {
  const d = payload.data || {};
  const n = payload.notification || {};
  const title = d.title || n.title || 'KJT HUB';
  const body = d.body || n.body || '';
  const isUrgent = String(d.severity) === '3';

  self.registration.showNotification(title, {
    body: body,
    icon: 'icon/Icon-192.png',   // path สัมพัทธ์ (ไม่ใช่ /icon/...) กัน 404 ตอนแอปอยู่ใต้ subpath ของ GitHub Pages (username.github.io/reponame/)
    badge: 'icon/Icon-192.png',
    tag: d.bookingId ? ('maint-' + d.bookingId) : undefined, // กันแจ้งเตือนซ้อนหลายอันถ้า FCM ส่งข้อความเดิมมาซ้ำ
    requireInteraction: isUrgent,           // งานสีแดง/ฉุกเฉิน: ค้างไว้จนกว่าจะกดปิดเอง ไม่หายไปเงียบๆ
    vibrate: isUrgent ? [300, 100, 300, 100, 300] : [150],
    data: { url: d.url || './', bookingId: d.bookingId || '' }
  });
});

// แตะที่ notification แล้วเด้งเปิด/โฟกัสแอปที่เปิดอยู่ (ถ้ายังไม่มีแท็บเปิดอยู่ ค่อยเปิดใหม่)
// ใช้ './' เสมอ (สัมพัทธ์กับ scope ของ service worker เอง) ไม่ hardcode โดเมน กันพลาดเปิดผิด path
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const c of clientList) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

const CACHE_NAME = 'kjt-hub-shell-v16'; // v16: แก้ path ไอคอนแจ้งเตือนที่ทำให้ 404 + เตรียมรับ payload.data สำหรับแก้บั๊กแจ้งเตือนซ้อน 2 อัน — บังคับล้าง cache เดิมทุกเครื่อง
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL).catch(function (err) {
        console.log('บาง asset แคชไม่สำเร็จตอนติดตั้ง (ไม่ critical):', err);
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(
          keys.filter(function (k) { return k !== CACHE_NAME; })
              .map(function (k) { return caches.delete(k); })
        );
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  // ปล่อยผ่าน POST (คำขอ API ไปหา Apps Script) ให้วิ่งตรงไปเน็ตเวิร์กเสมอ ไม่แตะ
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(function (res) {
        // อัปเดตแคชเงียบๆ ไปพร้อมกัน (stale-while-revalidate อย่างง่าย)
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, resClone).catch(function () { /* ignore เช่น opaque response ข้าม origin */ });
        });
        return res;
      })
      .catch(function () {
        // ออฟไลน์/เน็ตหลุด — ลองเสิร์ฟจากแคชแทน
        return caches.match(event.request);
      })
  );
});
