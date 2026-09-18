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
messaging.onBackgroundMessage(function (payload) {
  const n = payload.notification || {};
  self.registration.showNotification(n.title || 'KJT HUB', {
    body: n.body || '',
    icon: '/icon/Icon-192.png',
    badge: '/icon/Icon-192.png',
    data: payload.data || {}
  });
});

// แตะที่ notification แล้วเด้งเปิด/โฟกัสแอปที่เปิดอยู่ (ถ้ายังไม่มีแท็บเปิดอยู่ ค่อยเปิดใหม่)
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const c of clientList) { if ('focus' in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow('./');
    })
  );
});

const CACHE_NAME = 'kjt-hub-shell-v15'; // v15: แก้บั๊กปฏิทินช่าง/หัวหน้างานไม่เห็นคิวที่จอง — บังคับล้าง cache เดิมทุกเครื่อง
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
