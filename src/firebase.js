import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAsYIyD6QkdgUCQ8Gs67OO8LbMSwQzMHWk",
  authDomain: "smartppob-pasirhaur.firebaseapp.com",
  projectId: "smartppob-pasirhaur",
  storageBucket: "smartppob-pasirhaur.firebasestorage.app",
  messagingSenderId: "9236752169",
  appId: "1:9236752169:web:63f3714d9fb7c001dbb938"
};

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);

// Messaging (push notification) tidak didukung di semua browser -
// misalnya browser dalam-aplikasi WhatsApp/Instagram, atau Safari lama.
// Memanggil getMessaging() di browser yang tidak didukung akan
// langsung melempar error dan membuat SELURUH aplikasi gagal dimuat
// (layar putih), meskipun error itu tidak ada hubungannya dengan
// transaksi. Jadi messaging dibuat lazy (baru dibuat saat benar-benar
// dipakai) dan dibungkus try/catch supaya kegagalannya tidak pernah
// menjatuhkan aplikasi utama.
let messagingInstance = null;
let messagingChecked = false;

async function getMessagingSafe() {
  if (messagingChecked) return messagingInstance;
  messagingChecked = true;

  try {
    const { getMessaging, isSupported } = await import("firebase/messaging");
    const supported = await isSupported();
    if (!supported) return null;
    messagingInstance = getMessaging(app);
    return messagingInstance;
  } catch (error) {
    console.warn("Push notification tidak tersedia di perangkat ini:", error);
    return null;
  }
}

export { app, auth, db, getMessagingSafe };