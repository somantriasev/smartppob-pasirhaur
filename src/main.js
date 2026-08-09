import "./style.css";

import {
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

import {
  addDoc,
  arrayUnion,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
  import {
    auth,
    db,
    getMessagingSafe,
  } from "./firebase.js";

const appElement = document.querySelector("#app");

const SHEET_SYNC_URL =
  "https://script.google.com/macros/s/AKfycbzbPZa9uuAz_c0Lo7NxIE2Ap46bJJkdXpbMrMC6pG9OR0d0DJ_apX7rb5jHIKcjpo8bTQ/exec";

const SHEET_SYNC_TOKEN =
  "SMARTPPOB-PASIRHAUR-2026";

const VAPID_PUBLIC_KEY=
"BHGqTP7bh826uIgoADQF7Eqs0iBTaMFYrFT1KTYs-lFCtZN9cG-EYufgqtpCOXoOzP9kO7VSQFosEtKmbIZnQ2Y";

const QR_COOLDOWN_MS =
  30 * 1000;

// Batas satu akun Kios/Operator hanya aktif di satu perangkat. Heartbeat
// menulis ulang lastActive tiap HEARTBEAT_INTERVAL_MS; sesi dianggap basi
// (boleh direbut perangkat lain) kalau tidak ada heartbeat selama
// SESSION_TIMEOUT_MS. Rasio 4x supaya 1-2 heartbeat yang telat (jaringan
// putus sebentar, tab di-background) tidak memicu pengusiran palsu.
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const SESSION_TIMEOUT_MS = 120 * 1000;
const SESSION_ID_STORAGE_PREFIX = "smartppobSessionId_";

// Kalau tidak ada interaksi (klik/ketik/sentuh/scroll) sama sekali selama
// IDLE_TIMEOUT_MS, perangkat ini logout sendiri (lepas activeSession-nya
// dengan bersih) supaya tab yang lupa ditutup tidak menyandera kunci sesi
// selamanya. Dicek di tick heartbeat yang sama, tidak pakai timer sendiri.
const IDLE_TIMEOUT_MS = 120 * 1000;
const IDLE_ACTIVITY_EVENTS = [
  "click",
  "keydown",
  "touchstart",
  "scroll",
];

// Login cepat khusus Kios: PIN 4 digit tetap, hanya berfungsi di
// perangkat yang sudah pernah login lengkap dan ditandai "dipercaya"
// (lihat getTrustedKioskDevice dkk di dekat renderLogin). Bukan lapisan
// keamanan kuat -- murni kemudahan untuk pengguna Kios yang lansia.
const KIOSK_QUICK_PIN = "0000";
const KIOSK_TRUSTED_DEVICE_STORAGE_KEY = "smartppobKioskTrustedDevice";
const KIOSK_QUICK_PIN_MAX_ATTEMPTS = 5;

const urlParameters = new URLSearchParams(
  window.location.search
);

const isQrMode =
  urlParameters.get("mode") === "qr";

// State sesi single-device untuk Kios/Operator (lihat claimOrRejectSession
// dkk di dekat renderLoggedIn). Diisi sekali per login, dibersihkan saat
// logout atau saat sesi direbut perangkat lain.
let currentSessionId = null;
let sessionHeartbeatTimer = null;
let sessionTakeoverUnsubscribe = null;
let pendingLoginNotice = null;
let pendingRememberDeviceCredentials = null;
let forceNormalLoginForm = false;
let kioskQuickPinAttempts = 0;
let lastInteractionAt = Date.now();

function markUserActive() {
  lastInteractionAt = Date.now();
}

IDLE_ACTIVITY_EVENTS.forEach((eventName) => {
  document.addEventListener(eventName, markUserActive, {
    passive: true,
  });
});

function renderQrPage() {
  appElement.innerHTML = `
    <main class="qr-page">
      <section class="qr-app">
        <header class="qr-header">
          <img
            src="/icons/icon-192.png"
            alt="Logo SmartPPOB"
            class="brand-logo qr-brand-logo"
          />

          <div>
            <p class="app-label">SmartPPOB</p>
            <h1>Permintaan Pengisian</h1>
            <p>
              Isi data dengan benar, lalu kirim ke Operator.
            </p>
          </div>
        </header>

        <form id="qrTransactionForm" novalidate>
          <fieldset class="form-section">
            <legend>Jenis transaksi</legend>

            <div class="type-grid">
              <button
                class="choice-button qr-type-button"
                type="button"
                data-type="pulsa"
              >
                <span class="choice-icon">📱</span>
                <span>Pulsa</span>
              </button>

              <button
                class="choice-button qr-type-button"
                type="button"
                data-type="pln"
              >
                <span class="choice-icon">⚡</span>
                <span>PLN</span>
              </button>

              <button
                class="choice-button qr-type-button"
                type="button"
                data-type="other"
              >
                <span class="choice-icon">📦</span>
                <span>Lainnya</span>
              </button>
            </div>

            <label id="qrOtherTypeGroup" class="hidden-field">
              Tuliskan jenis transaksi
              <input
                id="qrOtherType"
                type="text"
                placeholder="Contoh: GoPay atau paket data"
              />
            </label>
          </fieldset>

          <fieldset class="form-section">
            <legend>Nominal</legend>

            <div class="nominal-grid">
              <button type="button" class="nominal-button qr-nominal-button" data-value="5">5</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="10">10</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="15">15</button>

              <button type="button" class="nominal-button qr-nominal-button" data-value="20">20</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="25">25</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="30">30</button>

              <button type="button" class="nominal-button qr-nominal-button" data-value="50">50</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="100">100</button>
              <button type="button" class="nominal-button qr-nominal-button" data-value="custom">Lain</button>
            </div>

            <label id="qrCustomNominalGroup" class="hidden-field">
              Nominal lainnya
              <input
                id="qrCustomNominal"
                type="number"
                inputmode="numeric"
                min="1"
                placeholder="Contoh: 75"
              />
            </label>
          </fieldset>

          <div class="customer-fields">
            <label>
              Nama peminta
              <input
                id="qrCustomerName"
                type="text"
                autocomplete="off"
                placeholder="Nama wajib diisi"
                required
              />
            </label>

            <label>
              Nomor HP / ID
              <input
                id="qrCustomerNumber"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                placeholder="Nomor HP atau ID pelanggan"
                required
              />
            </label>
          </div>

          <div class="qr-bottom-actions">
            <div class="payment-group">
              <span class="payment-label">
                Status pembayaran
              </span>

              <div class="payment-buttons">
                <button
                  class="payment-button qr-payment-button"
                  type="button"
                  data-payment="paid"
                >
                  Lunas
                </button>

                <button
                  class="payment-button qr-payment-button"
                  type="button"
                  data-payment="debt"
                >
                  Hutang
                </button>
              </div>
            </div>

            <button
              id="qrSendButton"
              class="send-button"
              type="submit"
              disabled
            >
              Kirim
            </button>
          </div>

          <p class="qr-helper">
            Pilih Hutang hanya atas izin penjaga kios.
          </p>

          <p
            id="qrMessage"
            class="transaction-message"
            aria-live="polite"
          ></p>
        </form>
      </section>
    </main>
  `;

  attachQrInteractions();
}

function attachQrInteractions() {
  const form = document.querySelector("#qrTransactionForm");

  const typeButtons = [
    ...document.querySelectorAll(".qr-type-button"),
  ];

  const nominalButtons = [
    ...document.querySelectorAll(".qr-nominal-button"),
  ];

  const paymentButtons = [
    ...document.querySelectorAll(".qr-payment-button"),
  ];

  const otherTypeGroup =
    document.querySelector("#qrOtherTypeGroup");

  const otherTypeInput =
    document.querySelector("#qrOtherType");

  const customNominalGroup =
    document.querySelector("#qrCustomNominalGroup");

  const customNominalInput =
    document.querySelector("#qrCustomNominal");

  const customerNameInput =
    document.querySelector("#qrCustomerName");

  const customerNumberInput =
    document.querySelector("#qrCustomerNumber");

  const sendButton =
    document.querySelector("#qrSendButton");

  const message =
    document.querySelector("#qrMessage");

  let selectedType = "";
  let selectedNominal = "";
  let selectedPayment = "";
  let hasBeenSubmitted = false;

  const lastSubmitAt =
    Number(
      localStorage.getItem(
        "smartppobQrLastSubmitAt"
      ) || 0
    );

  const cooldownUntil =
    lastSubmitAt + QR_COOLDOWN_MS;

  const qrIsCoolingDown =
    Date.now() < cooldownUntil;

  function formatCooldownTime(milliseconds) {
  const totalSeconds =
    Math.max(
      0,
      Math.ceil(milliseconds / 1000)
    );

  const minutes =
    Math.floor(totalSeconds / 60);

  const seconds =
    totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(
    seconds
  ).padStart(2, "0")}`;
  }

  function activateQrCooldown() {
      if (!qrIsCoolingDown) {
        return;
      }

      hasBeenSubmitted = true;
      sendButton.disabled = true;
      sendButton.textContent = "Tunggu";

      const updateCooldownMessage = () => {
        const remaining =
          cooldownUntil - Date.now();

        if (remaining <= 0) {
          localStorage.removeItem(
            "smartppobQrLastSubmitAt"
          );

          window.location.reload();
          return;
        }

        message.textContent =
          `Permintaan sudah pernah dikirim. ` +
          `Permintaan baru dapat dikirim dalam ` +
          `${formatCooldownTime(remaining)}.`;
      };

      updateCooldownMessage();

      setInterval(
        updateCooldownMessage,
        1000
      );
  }

  function normalizeText(value) {
    return value
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function updateSendButton() {
    const validType =
      selectedType &&
      (
        selectedType !== "other" ||
        otherTypeInput.value.trim().length >= 2
      );

    const validNominal =
      selectedNominal &&
      (
        selectedNominal !== "custom" ||
        Number(customNominalInput.value) > 0
      );

    const validCustomer =
      customerNameInput.value.trim().length >= 2 &&
      customerNumberInput.value.trim().length >= 4;

    const formIsComplete =
      validType &&
      validNominal &&
      validCustomer &&
      selectedPayment &&
      !hasBeenSubmitted;

    sendButton.disabled =
      !formIsComplete || qrIsCoolingDown;
  }

  activateQrCooldown();

  typeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      typeButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedType = button.dataset.type;

      const isOther = selectedType === "other";

      otherTypeGroup.classList.toggle(
        "visible-field",
        isOther
      );

      if (isOther) {
        otherTypeInput.focus();
      } else {
        otherTypeInput.value = "";
      }

      updateSendButton();
    });
  });

  nominalButtons.forEach((button) => {
    button.addEventListener("click", () => {
      nominalButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedNominal = button.dataset.value;

      const isCustom = selectedNominal === "custom";

      customNominalGroup.classList.toggle(
        "visible-field",
        isCustom
      );

      if (isCustom) {
        customNominalInput.focus();
      } else {
        customNominalInput.value = "";
        customerNameInput.focus();
      }

      updateSendButton();
    });
  });

  paymentButtons.forEach((button) => {
    button.addEventListener("click", () => {
      paymentButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedPayment = button.dataset.payment;

      updateSendButton();
    });
  });

  [
    otherTypeInput,
    customNominalInput,
    customerNameInput,
    customerNumberInput,
  ].forEach((input) => {
    input.addEventListener("input", updateSendButton);
  });

 async function saveQrCustomer(name, number) {
  const normalizedName = normalizeText(name);

  const normalizedNumber = String(number ?? "")
    .replace(/\s+/g, "");

  const savedCustomerId =
    localStorage.getItem("smartppobQrCustomerId") || "";

  const savedCustomerName =
    localStorage.getItem("smartppobQrCustomerName") || "";

  const sameCustomer =
    normalizeText(savedCustomerName) === normalizedName;

  const customerId =
    sameCustomer && savedCustomerId
      ? savedCustomerId
      : `${normalizedName}-${normalizedNumber}`
          .replace(/[^a-z0-9-]/g, "")
          .slice(0, 120);

  if (!customerId) {
    throw new Error("ID pelanggan QR tidak dapat dibuat.");
  }

  try { 
  const customerReference =
    doc(db, "customers", customerId);

  const customerSnapshot =
    await getDoc(customerReference);

  if (!customerSnapshot.exists()) {
    await setDoc(customerReference, {
      name,
      number,
      normalizedName,
      normalizedNumber,

      numbers: normalizedNumber
        ? [normalizedNumber]
        : [],

      transactionCount: 1,
      source: "qr",

      firstTransactionAt: serverTimestamp(),
      lastTransactionAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } else {
    const currentData = customerSnapshot.data();

    await updateDoc(customerReference, {
      name,
      number,
      normalizedName,
      normalizedNumber,

      ...(normalizedNumber
        ? {
            numbers: arrayUnion(normalizedNumber),
          }
        : {}),

      transactionCount:
        Number(currentData.transactionCount ?? 0) + 1,

      lastTransactionAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

    } catch (customerError) {
      console.warn(
        "Data pelanggan QR tidak dapat diperbarui:",
        customerError
      );
    }
      
  localStorage.setItem(
    "smartppobQrCustomerId",
    customerId
  );

  localStorage.setItem(
    "smartppobQrCustomerName",
    name
  );

  return customerId;
}

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (
      sendButton.disabled ||
      hasBeenSubmitted ||
      !auth.currentUser
    ) {
      return;
    }

    const nominalShort =
      selectedNominal === "custom"
        ? Number(customNominalInput.value)
        : Number(selectedNominal);

    const transactionType =
      selectedType === "other"
        ? otherTypeInput.value.trim()
        : selectedType;

    const customerName =
      customerNameInput.value.trim();

    const customerNumber =
      customerNumberInput.value.trim();

    sendButton.disabled = true;
    sendButton.textContent = "Mengirim...";
    message.textContent = "";

    try {
      const qrCustomerId =
        await saveQrCustomer(
          customerName,
          customerNumber
        );
      const transactionReference = await addDoc(
        collection(db, "transactions"),
        {
          transactionType,
          nominalShort,
          nominalAmount: nominalShort * 1000,

          customerName,
          customerNumber,
          customerId: qrCustomerId,

          paymentStatus: selectedPayment,
          processingStatus: "waiting",

          inputSource: "qr",
          createdBy: auth.currentUser.uid,

          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          completedAt: null,
        }
      );

      if (selectedPayment === "debt") {
        await addDoc(collection(db, "debts"), {
          customerName,
          customerNumber,
          customerId: qrCustomerId,
          
          debtCategory: "digital",
          debtType: transactionType,

          nominalShort,
          nominalAmount: nominalShort * 1000,

          source: "smartppob-qr",
          sourceTransactionId:
            transactionReference.id,

          status: "unpaid",

          createdBy: auth.currentUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          paidAt: null,
        });
      }
          await syncTransactionToSheet(
         transactionReference.id
      );

          localStorage.setItem(
            "smartppobQrLastSubmitAt",
            String(Date.now())
          );

      hasBeenSubmitted = true;

      appElement.innerHTML = `
        <main class="login-page">
          <section class="login-card">
            <div
              class="success-icon"
              aria-hidden="true"
            >
              ✓
            </div>

            <h1>Permintaan Sudah Dikirim</h1>

            <p class="subtitle">
              ${customerName} ·
              ${transactionType} ·
              Rp${Number(
                nominalShort * 1000
              ).toLocaleString("id-ID")}
            </p>

            <p>
              Silakan tunggu proses pengisian.
            </p>

            <p class="qr-helper">
              Untuk transaksi baru, scan kembali
              QR di kios.
            </p>
          </section>
        </main>
      `;
    } catch (error) {
      console.error(
        "Permintaan QR gagal dikirim:",
        error
      );

      message.textContent =
        "Permintaan gagal dikirim. Silakan coba kembali.";

      sendButton.disabled = false;
      sendButton.textContent = "Kirim";
    }
  });
}

async function syncTransactionToSheet(
  transactionId,
  overrides = {}
) {
  try {
    const transactionReference = doc(
      db,
      "transactions",
      transactionId
    );

    const transactionSnapshot = await getDoc(
      transactionReference
    );

    if (!transactionSnapshot.exists()) {
      throw new Error("Transaksi tidak ditemukan.");
    }

    const transaction = transactionSnapshot.data();

    const createdAt =
      transaction.createdAt?.toDate?.() ?? new Date();

    const completedAt =
      transaction.completedAt?.toDate?.() ?? null;

    const payload = {
      token: SHEET_SYNC_TOKEN,
      transactionId,

      customerName: transaction.customerName ?? "",
      customerNumber: transaction.customerNumber ?? "",

      transactionType:
        transaction.transactionType ?? "",

      nominalAmount:
        Number(transaction.nominalAmount ?? 0),

      paymentStatus:
        transaction.paymentStatus ?? "",

      processingStatus:
        overrides.processingStatus ??
        transaction.processingStatus ?? "",

      inputSource:
        transaction.inputSource ?? "",

      createdAt: createdAt.toISOString(),

      completedAt:
        overrides.completedAt ??
        (
          completedAt
            ? completedAt.toISOString()
            : ""
        ),
    };

    await fetch(SHEET_SYNC_URL, {
      method: "POST",
      mode: "no-cors",
      headers: {
        "Content-Type": "text/plain;charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    console.log(
      "Sinkronisasi Sheet dikirim:",
      transactionId
    );
  } catch (error) {
    console.error(
      "Gagal sinkron ke Google Sheets:",
      error
    );
  }
}

// Bukan enkripsi sungguhan -- cuma supaya email/password tersimpan tidak
// langsung kebaca polos sekilas pandang di panel localStorage devtools.
// Batas keamanan sebenarnya tetap "siapa yang pegang fisik perangkat ini".
function encodeForStorage(value) {
  return btoa(unescape(encodeURIComponent(value)));
}

function decodeFromStorage(value) {
  return decodeURIComponent(escape(atob(value)));
}

function getTrustedKioskDevice() {
  try {
    const raw = localStorage.getItem(
      KIOSK_TRUSTED_DEVICE_STORAGE_KEY
    );

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(decodeFromStorage(raw));

    if (!parsed?.email || !parsed?.password) {
      return null;
    }

    return parsed;
  } catch (error) {
    return null;
  }
}

function storeTrustedKioskDevice(email, password) {
  localStorage.setItem(
    KIOSK_TRUSTED_DEVICE_STORAGE_KEY,
    encodeForStorage(JSON.stringify({ email, password }))
  );
}

function clearTrustedKioskDevice() {
  localStorage.removeItem(KIOSK_TRUSTED_DEVICE_STORAGE_KEY);
}

function renderLogin() {
  const trusted = forceNormalLoginForm
    ? null
    : getTrustedKioskDevice();

  if (trusted) {
    renderKioskQuickPinEntry(trusted);
    return;
  }

  renderLoginForm();
}

function renderLoginForm() {
  const loginNotice = pendingLoginNotice;
  pendingLoginNotice = null;
  forceNormalLoginForm = false;

  appElement.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <img
          src="/icons/icon-192.png"
          alt="Logo SmartPPOB"
          class="login-logo"
        />

        <h1>SmartPPOB</h1>
        <p class="subtitle">Pencatatan transaksi kios</p>

        ${
          loginNotice
            ? `<p class="form-message" role="alert">${loginNotice}</p>`
            : ""
        }

        <form id="loginForm" class="login-form">
          <label for="email">
            Email pengguna
            <input
              id="email"
              name="email"
              type="email"
              autocomplete="username"
              placeholder="Masukkan email"
              required
            />
          </label>

          <label for="password">
            PIN / Password
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              inputmode="numeric"
              placeholder="Masukkan PIN"
              required
            />
          </label>

          <label class="remember-device-label">
            <input type="checkbox" id="rememberDevice" />
            Ingat perangkat ini untuk login cepat (PIN)
          </label>

          <p id="loginMessage" class="form-message" aria-live="polite"></p>

          <button id="loginButton" type="submit">
            MASUK
          </button>
        </form>
      </section>
    </main>
  `;

  const loginForm = document.querySelector("#loginForm");
  const loginButton = document.querySelector("#loginButton");
  const loginMessage = document.querySelector("#loginMessage");

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;
    const rememberDevice = loginForm.rememberDevice.checked;

    loginButton.disabled = true;
    loginButton.textContent = "MEMERIKSA...";
    loginMessage.textContent = "";

    try {
      await signInWithEmailAndPassword(auth, email, password);

      if (rememberDevice) {
        pendingRememberDeviceCredentials = { email, password };
      }
    } catch (error) {
      console.error(error);

      loginMessage.textContent =
        "Email atau PIN salah. Silakan periksa kembali.";

      loginButton.disabled = false;
      loginButton.textContent = "MASUK";
    }
  });
}

function renderKioskQuickPinEntry(trusted) {
  let enteredPin = "";

  appElement.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <img
          src="/icons/icon-192.png"
          alt="Logo SmartPPOB"
          class="login-logo"
        />

        <h1>SmartPPOB</h1>
        <p class="subtitle">Masukkan PIN untuk masuk</p>

        <p id="pinDots" class="pin-dots">○ ○ ○ ○</p>

        <p id="pinMessage" class="form-message" aria-live="polite"></p>

        <div class="type-grid pin-keypad">
          <button class="choice-button pin-key" type="button" data-digit="1">1</button>
          <button class="choice-button pin-key" type="button" data-digit="2">2</button>
          <button class="choice-button pin-key" type="button" data-digit="3">3</button>
          <button class="choice-button pin-key" type="button" data-digit="4">4</button>
          <button class="choice-button pin-key" type="button" data-digit="5">5</button>
          <button class="choice-button pin-key" type="button" data-digit="6">6</button>
          <button class="choice-button pin-key" type="button" data-digit="7">7</button>
          <button class="choice-button pin-key" type="button" data-digit="8">8</button>
          <button class="choice-button pin-key" type="button" data-digit="9">9</button>
          <button id="pinBackspace" class="choice-button pin-key" type="button">⌫</button>
          <button class="choice-button pin-key" type="button" data-digit="0">0</button>
          <span></span>
        </div>

        <button id="usePasswordButton" type="button" class="link-button">
          Gunakan email &amp; password
        </button>

        <button id="forgetDeviceButton" type="button" class="link-button">
          Lupakan perangkat ini
        </button>
      </section>
    </main>
  `;

  const pinDots = document.querySelector("#pinDots");
  const pinMessage = document.querySelector("#pinMessage");

  function updateDots() {
    pinDots.textContent = [0, 1, 2, 3]
      .map((index) => (index < enteredPin.length ? "●" : "○"))
      .join(" ");
  }

  async function submitPin() {
    if (enteredPin !== KIOSK_QUICK_PIN) {
      kioskQuickPinAttempts += 1;
      enteredPin = "";
      updateDots();

      if (kioskQuickPinAttempts >= KIOSK_QUICK_PIN_MAX_ATTEMPTS) {
        clearTrustedKioskDevice();
        kioskQuickPinAttempts = 0;

        pendingLoginNotice =
          "PIN salah berkali-kali, silakan login pakai email & password.";

        renderLogin();
        return;
      }

      pinMessage.textContent = "PIN salah, coba lagi.";
      return;
    }

    pinMessage.textContent = "Memeriksa...";

    try {
      await signInWithEmailAndPassword(
        auth,
        trusted.email,
        trusted.password
      );

      kioskQuickPinAttempts = 0;
    } catch (error) {
      console.error("Login cepat PIN gagal:", error);

      clearTrustedKioskDevice();

      pendingLoginNotice =
        "Login cepat gagal, silakan masuk dengan email & password.";

      renderLogin();
    }
  }

  document
    .querySelectorAll(".pin-key[data-digit]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        if (enteredPin.length >= 4) {
          return;
        }

        enteredPin += button.dataset.digit;
        pinMessage.textContent = "";
        updateDots();

        if (enteredPin.length === 4) {
          submitPin();
        }
      });
    });

  document
    .querySelector("#pinBackspace")
    .addEventListener("click", () => {
      enteredPin = enteredPin.slice(0, -1);
      pinMessage.textContent = "";
      updateDots();
    });

  document
    .querySelector("#usePasswordButton")
    .addEventListener("click", () => {
      forceNormalLoginForm = true;
      renderLogin();
    });

  document
    .querySelector("#forgetDeviceButton")
    .addEventListener("click", () => {
      clearTrustedKioskDevice();
      renderLogin();
    });
}

function renderRoleLoading() {
  appElement.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <img
          src="/icons/icon-192.png"
          alt="Logo SmartPPOB"
          class="login-logo"
        />
        <h1>SmartPPOB</h1>
        <p class="subtitle">Memuat akun...</p>
      </section>
    </main>
  `;
}

function renderKioskPage(profile) {
  appElement.innerHTML = `
    <main class="kiosk-page">
      <section class="kiosk-app">
        <header class="app-header">
          <div class="brand-header">
          <img
            src="/icons/icon-192.png"
            alt="Logo SmartPPOB"
            class="brand-logo"
          />

          <div>
              <p class="app-label">SmartPPOB</p>
              <h1>${profile.name}</h1>
            </div>
          </div>

          <button
            id="logoutButton"
            class="icon-button"
            type="button"
            aria-label="Keluar"
          >
            Keluar
          </button>
        </header>

        <nav class="app-tabs app-tabs-three">
          <button
            id="transactionTab"
            class="tab-button active"
            type="button"
          >
            Transaksi
          </button>

          <button
            id="debtTab"
            class="tab-button"
            type="button"
          >
            Hutang
          </button>

          <button
            id="historyTab"
            class="tab-button"
            type="button"
          >
            Riwayat
          </button>
        </nav>

        <section class="notification-panel">
          <div>
            <strong>Notifikasi Kios</strong>
            <p id="notificationStatus">
              Aktifkan agar tahu saat top up selesai diproses.
            </p>
          </div>

          <button
            id="enableNotificationButton"
            type="button"
            class="notification-button"
          >
            🔔 Aktifkan
          </button>
        </section>

        <section id="transactionPage" class="tab-content">
          <form id="transactionForm" novalidate>
            <fieldset class="form-section">
              <legend>Jenis transaksi</legend>

              <div class="type-grid">
                <button
                  class="choice-button type-button"
                  type="button"
                  data-type="pulsa"
                >
                  <span class="choice-icon">📱</span>
                  <span>Pulsa</span>
                </button>

                <button
                  class="choice-button type-button"
                  type="button"
                  data-type="pln"
                >
                  <span class="choice-icon">⚡</span>
                  <span>PLN</span>
                </button>

                <button
                  class="choice-button type-button"
                  type="button"
                  data-type="other"
                >
                  <span class="choice-icon">📦</span>
                  <span>Lainnya</span>
                </button>
              </div>

              <label id="otherTypeGroup" class="hidden-field">
                Tuliskan jenis transaksi
                <input
                  id="otherType"
                  type="text"
                  placeholder="Contoh: GoPay atau paket data"
                />
              </label>
            </fieldset>

            <fieldset class="form-section">
              <legend>Nominal</legend>

              <div class="nominal-grid">
                <button type="button" class="nominal-button" data-value="5">5</button>
                <button type="button" class="nominal-button" data-value="10">10</button>
                <button type="button" class="nominal-button" data-value="15">15</button>

                <button type="button" class="nominal-button" data-value="20">20</button>
                <button type="button" class="nominal-button" data-value="25">25</button>
                <button type="button" class="nominal-button" data-value="30">30</button>

                <button type="button" class="nominal-button" data-value="50">50</button>
                <button type="button" class="nominal-button" data-value="100">100</button>
                <button type="button" class="nominal-button" data-value="custom">Lain</button>
              </div>

              <label id="customNominalGroup" class="hidden-field">
                Nominal lainnya
                <input
                  id="customNominal"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  placeholder="Contoh: 75"
                />
              </label>
            </fieldset>

            <div class="customer-fields">
              <label class="customer-name-group">
  Nama pembeli
  <input
    id="customerName"
    type="text"
    autocomplete="off"
    placeholder="Ketik nama pembeli"
    required
  />

  <div
    id="customerSuggestions"
    class="customer-suggestions hidden-page"
  ></div>
</label>

              <label>
                Nomor HP / ID
                <input
                  id="customerNumber"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  placeholder="Nomor HP atau ID pelanggan"
                  required
                />
              </label>
            </div>

            <div class="bottom-actions">
              <div class="payment-group">
                <span class="payment-label">Status pembayaran</span>

                <div class="payment-buttons">
                  <button
                    class="payment-button"
                    type="button"
                    data-payment="paid"
                  >
                    Lunas
                  </button>

                  <button
                    class="payment-button"
                    type="button"
                    data-payment="debt"
                  >
                    Hutang
                  </button>
                </div>
              </div>

              <button
                id="sendTransactionButton"
                class="send-button"
                type="submit"
                disabled
              >
                Kirim
              </button>
            </div>

            <p
              id="transactionMessage"
              class="transaction-message"
              aria-live="polite"
            ></p>
          </form>
        </section>

        <section id="debtPage" class="tab-content hidden-page">
  <div id="debtCustomerList">
    <section class="debt-summary">
      <div>
        <p class="app-label">Piutang aktif</p>
        <h2>Catatan Hutang</h2>
      </div>

      <strong id="totalDebtAmount">Rp0</strong>
    </section>

    <button
      id="addManualDebtButton"
      class="manual-debt-button"
      type="button"
    >
      + Catat Hutang Sembako
    </button>

    <form
  id="manualDebtForm"
  class="manual-debt-form hidden-page"
  novalidate
>
  <label class="customer-name-group">
    Nama
    <input
      id="manualDebtCustomerName"
      type="text"
      autocomplete="off"
      placeholder="Ketik nama"
      required
    />

    <div
      id="manualDebtSuggestions"
      class="customer-suggestions hidden-page"
    ></div>
  </label>

  <label>
    Keterangan pembeda
    <input
      id="manualDebtCustomerLabel"
      type="text"
      autocomplete="off"
      placeholder="Contoh: Bengkel, RT 03, Blok Masjid"
    />
  </label>

  <label>
    Nominal
    <input
      id="manualDebtAmount"
      type="number"
      inputmode="numeric"
      min="1"
      placeholder="Contoh: 75000"
      required
    />
  </label>

  <p class="manual-debt-type">
    Jenis: <strong>Sembako</strong>
  </p>

  <div class="manual-debt-actions">
    <button
      id="cancelManualDebtButton"
      type="button"
      class="cancel-button"
    >
      Batal
    </button>

    <button
      id="saveManualDebtButton"
      type="submit"
      disabled
    >
      Simpan
    </button>
  </div>

  <p
    id="manualDebtMessage"
    class="transaction-message"
    aria-live="polite"
  ></p>
</form>

    <section id="debtCards" class="debt-cards">
      <div class="empty-page">
        <span class="empty-icon">✓</span>
        <h2>Tidak ada hutang</h2>
        <p>Semua catatan sudah lunas.</p>
      </div>
    </section>
  </div>

  <div id="debtDetailPage" class="hidden-page">
    <div class="debt-detail-header">
      <button
        id="backToDebtListButton"
        class="back-button"
        type="button"
      >
        ← Kembali
      </button>

      <div>
        <h2 id="debtCustomerName">Nama Pelanggan</h2>
        <p id="debtCustomerTotal">Total Rp0</p>
      </div>
    </div>

    <div class="debt-table-wrapper">
      <table class="debt-table">
        <thead>
          <tr>
            <th>Tanggal</th>
            <th>Nominal</th>
            <th>Jenis</th>
            <th>Pilih</th>
          </tr>
        </thead>

        <tbody id="debtDetailRows"></tbody>
      </table>
    </div>

    <section class="debt-payment-bar">
      <div>
        <span>Total dipilih</span>
        <strong id="selectedDebtTotal">Rp0</strong>
      </div>

      <button
        id="paySelectedDebtsButton"
        type="button"
        disabled
      >
        Bayar
      </button>
    </section>

    <p
      id="debtMessage"
      class="transaction-message"
      aria-live="polite"
    ></p>
  </div>
</section>

    <section
        id="historyPage"
        class="tab-content hidden-page"
      >
        <div id="historyList">
          <div class="empty-page">
            <span class="empty-icon">↺</span>
            <h2>Belum ada riwayat</h2>
            <p>
              Transaksi yang sudah tercatat akan tampil di sini.
            </p>
          </div>
        </div>

        <div
           id="historyDetailPage"
           class="history-modal hidden-page"
      >
        <div
          class="history-modal-backdrop"
          id="historyModalBackdrop"
        ></div>

        <div class="history-modal-card">
        <div id="historyModalContent"></div>
      </div>
    </div>    
      </section>

      </section>
    </main>
  `;

  attachLogoutButton();
  attachPushNotificationUi("kiosk");
  attachKioskInteractions();
  attachDebtPage();
  attachHistoryPage();
}

function attachKioskInteractions() {
  const transactionTab = 
    document.querySelector("#transactionTab");

  const debtTab = 
    document.querySelector("#debtTab");

const historyTab =
  document.querySelector("#historyTab");

const historyPage =
  document.querySelector("#historyPage");

  const transactionPage = 
    document.querySelector("#transactionPage");

  const debtPage = 
      document.querySelector("#debtPage");

  const typeButtons = [...document.querySelectorAll(".type-button")];
  const nominalButtons = [...document.querySelectorAll(".nominal-button")];
  const paymentButtons = [...document.querySelectorAll(".payment-button")];

  const otherTypeGroup = document.querySelector("#otherTypeGroup");
  const otherTypeInput = document.querySelector("#otherType");

  const customNominalGroup =
    document.querySelector("#customNominalGroup");
  const customNominalInput =
    document.querySelector("#customNominal");

  const customerNameInput =
    document.querySelector("#customerName");
    const customerSuggestions =
  document.querySelector("#customerSuggestions");
  const customerNumberInput =
    document.querySelector("#customerNumber");

  const transactionForm =
    document.querySelector("#transactionForm");
  const sendButton =
    document.querySelector("#sendTransactionButton");
  const message =
    document.querySelector("#transactionMessage");

  let selectedType = "";
  let selectedNominal = "";
  let selectedPayment = "";
  let selectedCustomerId = "";

  function openTab(tabName) {
  const transactionIsActive =
    tabName === "transaction";

  const debtIsActive =
    tabName === "debt";

  const historyIsActive =
    tabName === "history";

  transactionTab.classList.toggle(
    "active",
    transactionIsActive
  );

  debtTab.classList.toggle(
    "active",
    debtIsActive
  );

  historyTab.classList.toggle(
    "active",
    historyIsActive
  );

  transactionPage.classList.toggle(
    "hidden-page",
    !transactionIsActive
  );

  debtPage.classList.toggle(
    "hidden-page",
    !debtIsActive
  );

  historyPage.classList.toggle(
    "hidden-page",
    !historyIsActive
  );
}

  function updateSendButton() {
    const validType =
      selectedType &&
      (selectedType !== "other" ||
        otherTypeInput.value.trim().length >= 2);

    const validNominal =
      selectedNominal &&
      (selectedNominal !== "custom" ||
        Number(customNominalInput.value) > 0);

    const validCustomer =
      customerNameInput.value.trim().length >= 2 &&
      customerNumberInput.value.trim().length >= 4;

    const formIsComplete =
      validType &&
      validNominal &&
      validCustomer &&
      selectedPayment;

    sendButton.disabled = !formIsComplete;
  }

  transactionTab.addEventListener("click", () => {
    openTab("transaction");
  });

  debtTab.addEventListener("click", () => {
    openTab("debt");
  });

  historyTab.addEventListener("click", () => {
    openTab("history");
  });

  typeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      typeButtons.forEach((item) => item.classList.remove("selected"));

      button.classList.add("selected");
      selectedType = button.dataset.type;

      const isOther = selectedType === "other";
      otherTypeGroup.classList.toggle("visible-field", isOther);

      if (!isOther) {
        otherTypeInput.value = "";
      } else {
        otherTypeInput.focus();
      }

      updateSendButton();
    });
  });

  nominalButtons.forEach((button) => {
    button.addEventListener("click", () => {
      nominalButtons.forEach((item) =>
        item.classList.remove("selected")
      );

      button.classList.add("selected");
      selectedNominal = button.dataset.value;

      const isCustom = selectedNominal === "custom";

      customNominalGroup.classList.toggle(
        "visible-field",
        isCustom
      );

      if (!isCustom) {
        customNominalInput.value = "";
        customerNameInput.focus();
      } else {
        customNominalInput.focus();
      }

      updateSendButton();
    });
  });

  paymentButtons.forEach((button) => {
    button.addEventListener("click", () => {
      paymentButtons.forEach((item) =>
        item.classList.remove("selected")
      );

      button.classList.add("selected");
      selectedPayment = button.dataset.payment;

      updateSendButton();
    });
  });

  [
    otherTypeInput,
    customNominalInput,
    customerNameInput,
    customerNumberInput,
  ].forEach((input) => {
    input.addEventListener("input", updateSendButton);
  });

  function normalizeText(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function saveCustomerIfNeeded(name, number) {
  const normalizedName = normalizeText(name);
  const normalizedNumber = String(number ?? "")
    .replace(/\s+/g, "");

  const customerId =
    selectedCustomerId ||
    `${normalizedName}-${normalizedNumber}`
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 120);

  if (!customerId) {
    throw new Error("ID pelanggan tidak dapat dibuat.");
  }

  const customerReference =
    doc(db, "customers", customerId);

  const customerSnapshot =
    await getDoc(customerReference);

  if (!customerSnapshot.exists()) {
    await setDoc(customerReference, {
      name,
      number,
      normalizedName,
      normalizedNumber,

      numbers: normalizedNumber
        ? [normalizedNumber]
        : [],

      customerLabel: "",
      transactionCount: 1,

      firstTransactionAt: serverTimestamp(),
      lastTransactionAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return customerId;
  }

  const customerData = customerSnapshot.data();

  await updateDoc(customerReference, {
    name,
    number,
    normalizedName,
    normalizedNumber,

    ...(normalizedNumber
  ? {
      numbers: arrayUnion(normalizedNumber),
    }
  : {}),

    transactionCount:
      Number(customerData.transactionCount ?? 0) + 1,

    lastTransactionAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return customerId;
}

let customerSearchTimer = null;

customerNameInput.addEventListener("input", () => {
  selectedCustomerId = "";
 
  clearTimeout(customerSearchTimer);

  const keyword = normalizeText(customerNameInput.value);

  if (keyword.length < 2) {
    customerSuggestions.innerHTML = "";
    customerSuggestions.classList.add("hidden-page");
    return;
  }

  customerSearchTimer = setTimeout(async () => {
    try {
      const customerSnapshot = await getDocs(
  collection(db, "customers")
);

      const matches = customerSnapshot.docs
        .map((customerDocument) => ({
          id: customerDocument.id,
          ...customerDocument.data(),
        }))
        .filter((customer) =>
          String(customer.normalizedName || "")
            .includes(keyword)
        )
        .slice(0, 6);

      if (matches.length === 0) {
        customerSuggestions.innerHTML = "";
        customerSuggestions.classList.add("hidden-page");
        return;
      }

      customerSuggestions.innerHTML = matches
  .map(
    (customer) => `
      <button
        type="button"
        class="customer-suggestion-button"
        data-id="${customer.id}"
        data-name="${customer.name}"
        data-number="${customer.number || ""}"
        data-label="${customer.customerLabel || ""}"
      >
        <strong>
          ${customer.name}
          ${
            customer.customerLabel
              ? ` — ${customer.customerLabel}`
              : ""
          }
        </strong>

        <span>
          ${
            customer.number
              ? customer.number
              : "Belum memiliki nomor/ID"
          }
        </span>
      </button>
    `
  )
  .join("");

      customerSuggestions.classList.remove("hidden-page");

      document
        .querySelectorAll(".customer-suggestion-button")
        .forEach((button) => {
          button.addEventListener("click", () => {
            customerNameInput.value = button.dataset.name;
            customerNumberInput.value = button.dataset.number;
            selectedCustomerId = button.dataset.id;

            customerSuggestions.innerHTML = "";
            customerSuggestions.classList.add("hidden-page");
            
            if (!button.dataset.number) {
            customerNumberInput.focus();
            }
            
            updateSendButton();
          });
        });
    } catch (error) {
      console.error("Gagal mencari pelanggan:", error);
    }
  }, 250);
});

  function resetTransactionForm() {
  selectedType = "";
  selectedNominal = "";
  selectedPayment = "";
  selectedCustomerId = "";

  transactionForm.reset();

  typeButtons.forEach((button) => {
    button.classList.remove("selected");
  });

  nominalButtons.forEach((button) => {
    button.classList.remove("selected");
  });

  paymentButtons.forEach((button) => {
    button.classList.remove("selected");
  });

  otherTypeGroup.classList.remove("visible-field");
  customNominalGroup.classList.remove("visible-field");

  sendButton.disabled = true;
} 
transactionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (sendButton.disabled || !auth.currentUser) {
    return;
  }

  const nominalShort =
    selectedNominal === "custom"
      ? Number(customNominalInput.value)
      : Number(selectedNominal);

  const transactionType =
    selectedType === "other"
      ? otherTypeInput.value.trim()
      : selectedType;

  const customerName = customerNameInput.value.trim();
  const customerNumber = customerNumberInput.value.trim();

  sendButton.disabled = true;
  sendButton.textContent = "Mengirim...";
  message.textContent = "";
  message.classList.remove("success-message");

    try {
      const customerId =
        await saveCustomerIfNeeded(
          customerName,
          customerNumber
        );

    const transactionReference = await addDoc(
      collection(db, "transactions"),
      {
        transactionType,
        nominalShort,
        nominalAmount: nominalShort * 1000,

        customerName,
        customerNumber,
        customerId,

        paymentStatus: selectedPayment,
        processingStatus: "waiting",

        inputSource: "kiosk",
        createdBy: auth.currentUser.uid,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        completedAt: null,
      }
    );

    console.log(
      "Transaksi berhasil dibuat:",
      transactionReference.id
    );

    if (selectedPayment === "debt") {
  await addDoc(collection(db, "debts"), {
    customerName,
    customerNumber,
    customerId,

    debtCategory: "digital",
    debtType: transactionType,

    nominalShort,
    nominalAmount: nominalShort * 1000,

    source: "smartppob",
    sourceTransactionId: transactionReference.id,

    status: "unpaid",

    createdBy: auth.currentUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    paidAt: null,
  });
}
    await syncTransactionToSheet(
     transactionReference.id
    );

    resetTransactionForm();

    message.textContent =
      `✓ Permintaan ${customerName} berhasil dikirim.`;
    message.classList.add("success-message");

    setTimeout(() => {
      message.textContent = "";
      message.classList.remove("success-message");
    }, 3000);
  } catch (error) {
    console.error("Gagal menyimpan transaksi:", error);

    message.textContent =
      "Transaksi gagal dikirim. Silakan coba kembali.";

    sendButton.disabled = false;
  } finally {
    sendButton.textContent = "Kirim";
  }
})

};

function attachDebtPage() {
  const debtCustomerList =
    document.querySelector("#debtCustomerList");

  const debtDetailPage =
    document.querySelector("#debtDetailPage");

  const debtCards =
    document.querySelector("#debtCards");

  const totalDebtAmount =
    document.querySelector("#totalDebtAmount");

  const backButton =
    document.querySelector("#backToDebtListButton");

  const detailCustomerName =
    document.querySelector("#debtCustomerName");

  const detailCustomerTotal =
    document.querySelector("#debtCustomerTotal");

  const detailRows =
    document.querySelector("#debtDetailRows");

  const selectedDebtTotal =
    document.querySelector("#selectedDebtTotal");

  const payButton =
    document.querySelector("#paySelectedDebtsButton");

  const debtMessage =
    document.querySelector("#debtMessage");

  const addManualDebtButton =
    document.querySelector("#addManualDebtButton");

  const manualDebtForm =
    document.querySelector("#manualDebtForm");

  const manualDebtCustomerName =
    document.querySelector("#manualDebtCustomerName");

  const manualDebtCustomerLabel =
    document.querySelector("#manualDebtCustomerLabel");  

  const manualDebtAmount =
    document.querySelector("#manualDebtAmount");

  const manualDebtSuggestions =
    document.querySelector("#manualDebtSuggestions");

  const cancelManualDebtButton =
    document.querySelector("#cancelManualDebtButton");

  const saveManualDebtButton =
    document.querySelector("#saveManualDebtButton");

  const manualDebtMessage =
    document.querySelector("#manualDebtMessage");

  let manualDebtCustomerId = "";
  let manualDebtCustomerNumber = "";
  let manualDebtCustomerLabelValue = "";
  let manualDebtSearchTimer = null;

  let allDebts = [];
  let selectedCustomerDebts = [];
  let selectedDebtIds = new Set();

  function normalizeManualDebtText(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function updateManualDebtButton() {
  const validName =
    manualDebtCustomerName.value.trim().length >= 2;

  const validAmount =
    Number(manualDebtAmount.value) > 0;

  saveManualDebtButton.disabled =
    !(validName && validAmount);
}

function closeManualDebtForm() {
  manualDebtForm.reset();
  manualDebtCustomerNumber = "";
  manualDebtCustomerId = "";
  manualDebtCustomerLabelValue = "";

  manualDebtSuggestions.innerHTML = "";
  manualDebtSuggestions.classList.add("hidden-page");

  manualDebtForm.classList.add("hidden-page");
  addManualDebtButton.classList.remove("hidden-page");

  saveManualDebtButton.disabled = true;
  saveManualDebtButton.textContent = "Simpan";
  manualDebtMessage.textContent = "";
}

addManualDebtButton.addEventListener("click", () => {
  addManualDebtButton.classList.add("hidden-page");
  manualDebtForm.classList.remove("hidden-page");
  manualDebtCustomerName.focus();
});

cancelManualDebtButton.addEventListener("click", () => {
  closeManualDebtForm();
});

manualDebtCustomerName.addEventListener("input", () => {
  manualDebtCustomerId = "";
  
  clearTimeout(manualDebtSearchTimer);

  manualDebtCustomerNumber = "";
  updateManualDebtButton();

  const keyword = normalizeManualDebtText(
    manualDebtCustomerName.value
  );

  if (keyword.length < 2) {
    manualDebtSuggestions.innerHTML = "";
    manualDebtSuggestions.classList.add("hidden-page");
    return;
  }

  manualDebtSearchTimer = setTimeout(async () => {
    try {
      const customerSnapshot = await getDocs(
        collection(db, "customers")
      );

      const rawMatches = customerSnapshot.docs
  .map((customerDocument) => ({
    id: customerDocument.id,
    ...customerDocument.data(),
  }))
  .filter((customer) =>
    String(customer.normalizedName || "")
      .includes(keyword)
  );

      const uniqueCustomers = new Map();

      rawMatches.forEach((customer) => {
      const normalizedNumber = String(
        customer.normalizedNumber ||
        customer.number ||
        ""
      ).replace(/\D/g, "");

      const normalizedName = String(
        customer.normalizedName ||
        customer.name ||
        ""
      )
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

      const normalizedLabel = String(
        customer.customerLabel || ""
      )
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");

      const uniqueKey = normalizedNumber
        ? `number||${normalizedNumber}`
        : `name||${normalizedName}||${normalizedLabel}`;

      if (!uniqueCustomers.has(uniqueKey)) {
        uniqueCustomers.set(uniqueKey, customer);
      }
    });

    const matches = [...uniqueCustomers.values()]
      .slice(0, 6);      

      if (matches.length === 0) {
        manualDebtSuggestions.innerHTML = "";
        manualDebtSuggestions.classList.add("hidden-page");
        return;
      }

      manualDebtSuggestions.innerHTML = matches
        .map(
          (customer) => `
            <button
              type="button"
              class="customer-suggestion-button manual-debt-suggestion"
              data-id="${customer.id}"
              data-name="${customer.name}"
              data-number="${customer.number || ""}"
              data-label="${customer.customerLabel || ""}"
            >
              <strong>${customer.name}</strong>
              <span>${customer.number}</span>
            </button>
          `
        )
        .join("");

      manualDebtSuggestions.classList.remove("hidden-page");

      document
        .querySelectorAll(".manual-debt-suggestion")
        .forEach((button) => {
          button.addEventListener("click", () => {
            manualDebtCustomerName.value =
              button.dataset.name;

            manualDebtCustomerId =
              button.dataset.id;

            manualDebtCustomerNumber =
              button.dataset.number;

            manualDebtCustomerLabel.value =
              button.dataset.label || "";

            manualDebtCustomerLabelValue =
              button.dataset.label || "";  

            manualDebtSuggestions.innerHTML = "";
            manualDebtSuggestions.classList.add(
              "hidden-page"
            );

            updateManualDebtButton();
            manualDebtAmount.focus();
          });
        });
    } catch (error) {
      console.error(
        "Gagal mencari pelanggan hutang:",
        error
      );
    }
  }, 250);
});

manualDebtAmount.addEventListener(
  "input",
  updateManualDebtButton
);

manualDebtForm.addEventListener(
  "submit",
  async (event) => {
    event.preventDefault();

    if (
      saveManualDebtButton.disabled ||
      !auth.currentUser
    ) {
      return;
    }

    const customerName =
     manualDebtCustomerName.value.trim();

    const customerLabel =
      manualDebtCustomerLabel.value.trim();

    let customerId = manualDebtCustomerId;

    if (!customerId) {
  const normalizedCustomerName =
    normalizeManualDebtText(customerName);

  const normalizedCustomerLabel =
    normalizeManualDebtText(customerLabel);

  customerId = [
    normalizedCustomerName,
    normalizedCustomerLabel || "tanpa-keterangan",
  ]
    .join("-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 120);

  const customerReference =
    doc(db, "customers", customerId);

  const customerSnapshot =
    await getDoc(customerReference);

  if (!customerSnapshot.exists()) {
    await setDoc(customerReference, {
      name: customerName,
      number: "",
      normalizedName: normalizedCustomerName,
      normalizedNumber: "",

      customerLabel,
      transactionCount: 0,

      firstTransactionAt: null,
      lastTransactionAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }
}  

    const nominalAmount =
      Number(manualDebtAmount.value);

    saveManualDebtButton.disabled = true;
    saveManualDebtButton.textContent = "Menyimpan...";
    manualDebtMessage.textContent = "";

    try {
      await addDoc(collection(db, "debts"), {
        customerName,
        customerNumber: manualDebtCustomerNumber || "",

        customerId,
        customerLabel,

        debtCategory: "sembako",
        debtType: "sembako",

        nominalShort: null,
        nominalAmount,

        source: "manual",
        sourceTransactionId: null,

        status: "unpaid",

        createdBy: auth.currentUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        paidAt: null,
      });

      manualDebtMessage.textContent =
        "✓ Hutang sembako berhasil dicatat.";

      setTimeout(() => {
        closeManualDebtForm();
      }, 1200);
    } catch (error) {
      console.error(
        "Gagal menyimpan hutang manual:",
        error
      );

      manualDebtMessage.textContent =
        "Hutang gagal disimpan.";

      saveManualDebtButton.disabled = false;
      saveManualDebtButton.textContent = "Simpan";
    }
  }
);

  const unpaidDebtsQuery = query(
    collection(db, "debts"),
    where("status", "==", "unpaid")
  );

  onSnapshot(
    unpaidDebtsQuery,
    (snapshot) => {
      allDebts = snapshot.docs
        .map((debtDocument) => ({
          id: debtDocument.id,
          ...debtDocument.data(),
        }))
        .sort((first, second) => {
          const firstTime =
            first.createdAt?.toMillis?.() ?? 0;

          const secondTime =
            second.createdAt?.toMillis?.() ?? 0;

          return firstTime - secondTime;
        });

      renderDebtCards();

      if (
        !debtDetailPage.classList.contains("hidden-page")
      ) {
        const currentCustomerId =
          detailCustomerName.dataset.customerId;

        const currentName =
          detailCustomerName.dataset.customerName;

        const currentNumber =
          detailCustomerName.dataset.customerNumber;

        const currentLabel =
          detailCustomerName.dataset.customerLabel;

        openDebtDetail(
          currentCustomerId,
          currentName,
          currentNumber,
          currentLabel
        );
      }
    },
    (error) => {
      console.error("Gagal membaca hutang:", error);

      debtCards.innerHTML = `
        <div class="empty-page">
          <h2>Data gagal dimuat</h2>
          <p>Silakan coba beberapa saat lagi.</p>
        </div>
      `;
    }
  );

  function normalizeDebtName(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeDebtNumber(value) {
  return String(value ?? "")
    .replace(/\D/g, "");
}

function getDebtCategory(debt) {
  if (debt.debtCategory) {
    return debt.debtCategory;
  }

  return debt.debtType === "sembako"
    ? "sembako"
    : "digital";
}

function customerKey(debt) {
  // Identitas utama adalah customerId.
  // Nomor berbeda tetap dianggap satu orang
  // selama transaksi memilih pelanggan yang sama.
  if (debt.customerId) {
    return `customer||${debt.customerId}`;
  }

  // Fallback untuk data lama tanpa customerId.
  const normalizedNumber =
    normalizeDebtNumber(debt.customerNumber);

  if (normalizedNumber) {
    return `legacy-number||${normalizedNumber}`;
  }

  const normalizedName =
    normalizeDebtName(debt.customerName);

  const normalizedLabel =
    normalizeDebtName(debt.customerLabel);

  return `legacy-name||${normalizedName}||${normalizedLabel}`;
}

  function formatMoney(value) {
    return `Rp${Number(value ?? 0).toLocaleString("id-ID")}`;
  }

  function formatDate(timestamp) {
    const date = timestamp?.toDate?.();

    if (!date) {
      return "-";
    }

    return date.toLocaleDateString("id-ID", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }

  function formatDebtType(type) {
    const labels = {
      pulsa: "Pulsa",
      pln: "PLN",
      other: "Lainnya",
      sembako: "Sembako",
    };

    return labels[type] ?? type;
  }

  function renderDebtCards() {
    const groupedDebts = new Map();

    allDebts.forEach((debt) => {
  const key = customerKey(debt);

  if (!groupedDebts.has(key)) {
    groupedDebts.set(key, {
      customerId: debt.customerId || "",
      customerName: debt.customerName,
      customerNumber: debt.customerNumber || "",
      customerLabel: debt.customerLabel || "",

      debts: [],
      total: 0,
      digitalTotal: 0,
      sembakoTotal: 0,
    });
  }

  const group = groupedDebts.get(key);

  group.debts.push(debt);

  const debtAmount =
    Number(debt.nominalAmount ?? 0);

  group.total += debtAmount;

  if (getDebtCategory(debt) === "digital") {
    group.digitalTotal += debtAmount;
  } else {
    group.sembakoTotal += debtAmount;
  }
});

    const groups = [...groupedDebts.values()]
      .sort((first, second) =>
        first.customerName.localeCompare(
          second.customerName,
          "id"
        )
      );

    const totalAllDebts = groups.reduce(
      (total, group) => total + group.total,
      0
    );

    totalDebtAmount.textContent =
      formatMoney(totalAllDebts);

    if (groups.length === 0) {
      debtCards.innerHTML = `
        <div class="empty-page">
          <span class="empty-icon">✓</span>
          <h2>Tidak ada hutang</h2>
          <p>Semua catatan sudah lunas.</p>
        </div>
      `;
      return;
    }

    debtCards.innerHTML = groups
      .map(
        (group) => `
          <button
            class="debt-customer-card"
            type="button"
            data-customer-id="${group.customerId}"
            data-name="${group.customerName}"
            data-number="${group.customerNumber}"
            data-label="${group.customerLabel}"
          >
            <span class="debt-avatar">👤</span>

          <span class="debt-card-info">
            <strong>
              ${group.customerName}
              ${
                group.customerLabel
                  ? `<small class="customer-label">
                      — ${group.customerLabel}
                    </small>`
                  : ""
              }
            </strong>

            <span class="debt-category-summary">
  ${
    group.digitalTotal > 0
      ? `
        <span class="debt-category-badge debt-category-digital">
          Digital ${formatMoney(group.digitalTotal)}
        </span>
      `
      : ""
  }

  ${
    group.sembakoTotal > 0
      ? `
        <span class="debt-category-badge debt-category-sembako">
          Sembako ${formatMoney(group.sembakoTotal)}
        </span>
      `
      : ""
  }
</span>

  <small>
    ${group.debts.length} catatan
  </small>
</span>

            <span class="debt-card-total">
              ${formatMoney(group.total)}
            </span>

            <span class="debt-card-arrow">›</span>
          </button>
        `
      )
      .join("");

    document
      .querySelectorAll(".debt-customer-card")
      .forEach((button) => {
        button.addEventListener("click", () => {
          history.pushState(
            {
              smartPpobView: "debt-detail",
            },
            "",
            "#debt-detail"
          );

          openDebtDetail(
            button.dataset.customerId,
            button.dataset.name,
            button.dataset.number,
            button.dataset.label
          );
        });
      });
  }

  function openDebtDetail(
    customerId,
    customerName,
    customerNumber,
    customerLabel
  ) {
  selectedDebtIds = new Set();

selectedCustomerDebts = allDebts.filter((debt) => {
  if (customerId) {
    return debt.customerId === customerId;
  }

  // Untuk data lama yang belum memiliki customerId.
  const selectedNumber =
    normalizeDebtNumber(customerNumber);

  const debtNumber =
    normalizeDebtNumber(debt.customerNumber);

  if (selectedNumber && debtNumber) {
    return selectedNumber === debtNumber;
  }

  return (
    normalizeDebtName(debt.customerName) ===
    normalizeDebtName(customerName)
  );
});

  const customerTotal = selectedCustomerDebts.reduce(
    (total, debt) =>
      total + Number(debt.nominalAmount ?? 0),
    0
  );

  detailCustomerName.textContent =
  customerLabel
    ? `${customerName} — ${customerLabel}`
    : customerName;

detailCustomerName.dataset.customerId =
  customerId || "";

detailCustomerName.dataset.customerName =
  customerName;

detailCustomerName.dataset.customerNumber =
  customerNumber || "";

detailCustomerName.dataset.customerLabel =
  customerLabel || "";  

  detailCustomerTotal.textContent =
    `Total hutang ${formatMoney(customerTotal)}`;

  detailRows.innerHTML = selectedCustomerDebts
  .map(
    (debt) => `
      <tr>
        <td>${formatDate(debt.createdAt)}</td>

        <td>
          ${formatMoney(debt.nominalAmount)}
        </td>

        <td>
          <div class="debt-type-info">
            <span class="debt-type debt-type-${debt.debtType}">
              ${formatDebtType(debt.debtType)}
            </span>

            ${
              getDebtCategory(debt) === "digital" &&
              debt.customerNumber
                ? `
                  <small class="debt-target-number">
                    ${debt.customerNumber}
                  </small>
                `
                : ""
            }
          </div>
        </td>

        <td class="debt-check-cell">
          <input
            class="debt-checkbox"
            type="checkbox"
            data-id="${debt.id}"
            aria-label="Pilih hutang ${formatMoney(
              debt.nominalAmount
            )}"
          />
        </td>
      </tr>
    `
  )
  .join("");

  debtCustomerList.classList.add("hidden-page");
  debtDetailPage.classList.remove("hidden-page");

  updateSelectedTotal();

  document
    .querySelectorAll(".debt-checkbox")
    .forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedDebtIds.add(checkbox.dataset.id);
        } else {
          selectedDebtIds.delete(checkbox.dataset.id);
        }

        updateSelectedTotal();
      });
    });
}

  function closeDebtDetail() {
    selectedDebtIds = new Set();

    debtDetailPage.classList.add("hidden-page");
    debtCustomerList.classList.remove("hidden-page");

    debtMessage.textContent = "";
  }

  function updateSelectedTotal() {
    const total = selectedCustomerDebts
      .filter((debt) => selectedDebtIds.has(debt.id))
      .reduce(
        (sum, debt) =>
          sum + Number(debt.nominalAmount ?? 0),
        0
      );

    selectedDebtTotal.textContent = formatMoney(total);
    payButton.disabled = selectedDebtIds.size === 0;
  }

    backButton.addEventListener("click", () => {
    if (window.location.hash === "#debt-detail") {
      history.back();
      return;
    }

    closeDebtDetail();
  });

   window.addEventListener("popstate", () => {
      const detailIsOpen =
        !debtDetailPage.classList.contains(
          "hidden-page"
        );

      if (detailIsOpen) {
        closeDebtDetail();
      }
   });

  payButton.addEventListener("click", async () => {
    if (selectedDebtIds.size === 0) {
      return;
    }

    payButton.disabled = true;
    payButton.textContent = "Menyimpan...";
    debtMessage.textContent = "";

    try {
      const batch = writeBatch(db);

      selectedDebtIds.forEach((debtId) => {
        batch.update(doc(db, "debts", debtId), {
          status: "paid",
          paidAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      });

      await batch.commit();

      debtMessage.textContent =
        `✓ ${selectedDebtIds.size} catatan berhasil dibayar.`;

      selectedDebtIds = new Set();

      setTimeout(() => {
        debtMessage.textContent = "";
      }, 2500);
    } catch (error) {
      console.error("Gagal melunasi hutang:", error);

      debtMessage.textContent =
        "Pelunasan gagal disimpan.";
    } finally {
      payButton.textContent = "Bayar";
    }
  });
}

function attachHistoryPage() {
    const historyList =
      document.querySelector("#historyList");

    const historyDetailPage =
      document.querySelector("#historyDetailPage");

    const historyModalContent =
      document.querySelector("#historyModalContent");

    const historyModalBackdrop =
      document.querySelector("#historyModalBackdrop");

    if (
      !historyList ||
      !historyDetailPage ||
      !historyModalContent ||
      !historyModalBackdrop
    ) {
      return;
    }

    let historyTransactions = [];

  function formatHistoryMoney(value) {
    return new Intl.NumberFormat(
      "id-ID",
      {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
      }
    ).format(Number(value || 0));
  }

  function formatHistoryDate(date) {
    const today = new Date();
    const yesterday = new Date();

    yesterday.setDate(today.getDate() - 1);

    const sameDate = (a, b) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();

    if (sameDate(date, today)) {
      return "Hari ini";
    }

    if (sameDate(date, yesterday)) {
      return "Kemarin";
    }

    return date.toLocaleDateString(
      "id-ID",
      {
        day: "2-digit",
        month: "long",
        year: "numeric",
      }
    );
  }

  const historyQuery = query(
      collection(db, "transactions")
    );

  onSnapshot(historyQuery, (snapshot) => {
      console.log(
        "History snapshot size:",
        snapshot.size
      );

      historyTransactions = snapshot.docs
        .map((documentSnapshot) => ({
          id: documentSnapshot.id,
          ...documentSnapshot.data(),
        }))
        .sort((a, b) => {
          const timeA =
            a.createdAt?.toMillis?.() ?? 0;

          const timeB =
            b.createdAt?.toMillis?.() ?? 0;

          return timeB - timeA;
        });

      renderHistoryCards();
    });
  function openHistoryDetail(transactionId) {
    const transaction =
      historyTransactions.find(
        (item) => item.id === transactionId
      );

    if (!transaction) {
      return;
    }

    const createdDate =
      transaction.createdAt?.toDate?.();

    const completedDate =
      transaction.completedAt?.toDate?.();

    const sourceLabel =
      transaction.inputSource === "qr"
        ? "QR Pelanggan"
        : transaction.inputSource ===
            "operator_whatsapp"
          ? "Operator"
          : "Akun Kios";

    const status =
      transaction.processingStatus ??
      "waiting";

    const statusLabel =
      status === "success"
        ? "Berhasil"
        : status === "failed"
          ? "Gagal"
          : "Menunggu";

    const paymentLabel =
      transaction.paymentStatus === "debt"
        ? "Hutang"
        : "Lunas";

    historyDetailPage.classList.remove(
      "hidden-page"
    );

    historyModalContent.innerHTML = `
      <div class="history-detail-header">
        <button
          id="historyBackButton"
          type="button"
          class="back-button"
        >
          ← Kembali
        </button>

        <div>
          <h2>Detail Transaksi</h2>
          <p>${statusLabel}</p>
        </div>
      </div>

      <div class="history-detail-card">
        <div>
          <span>Nama</span>
          <strong>
            ${transaction.customerName ?? "-"}
          </strong>
        </div>

        <div>
          <span>Nomor / ID</span>
          <strong>
            ${transaction.customerNumber ?? "-"}
          </strong>
        </div>

        <div>
          <span>Jenis</span>
          <strong>
            ${transaction.transactionType ?? "-"}
          </strong>
        </div>

        <div>
          <span>Nominal</span>
          <strong>
            ${formatHistoryMoney(
              transaction.nominalAmount
            )}
          </strong>
        </div>

        <div>
          <span>Pembayaran</span>
          <strong>${paymentLabel}</strong>
        </div>

        <div>
          <span>Sumber</span>
          <strong>${sourceLabel}</strong>
        </div>

        <div>
          <span>Status</span>
          <strong>${statusLabel}</strong>
        </div>

        <div>
          <span>Dibuat</span>
          <strong>
            ${
              createdDate
                ? createdDate.toLocaleString(
                    "id-ID"
                  )
                : "-"
            }
          </strong>
        </div>

        <div>
          <span>Selesai</span>
          <strong>
            ${
              completedDate
                ? completedDate.toLocaleString(
                    "id-ID"
                  )
                : "-"
            }
          </strong>
        </div>

        <div>
          <span>ID Transaksi</span>
          <strong class="history-id">
            ${transaction.id}
          </strong>
        </div>
      </div>
    `;

    const historyBackButton =
      document.querySelector(
        "#historyBackButton"
      );

    historyBackButton.addEventListener(
      "click",
      () => {
        history.back();
      }
    );
  }
  function renderHistoryCards() {
    if (historyTransactions.length === 0) {
      historyList.innerHTML = `
        <div class="empty-page">
          <span class="empty-icon">↺</span>
          <h2>Belum ada riwayat</h2>
          <p>
            Transaksi yang sudah tercatat akan tampil di sini.
          </p>
        </div>
      `;

      return;
    }

    const groupedTransactions = {};

    historyTransactions.forEach((transaction) => {
    const createdDate =
      transaction.createdAt?.toDate?.();

    const dateKey = createdDate
      ? createdDate.toLocaleDateString("en-CA")
      : "unknown";

    if (!groupedTransactions[dateKey]) {
      groupedTransactions[dateKey] = {
        date: createdDate,
        transactions: [],
      };
    }

    groupedTransactions[dateKey].transactions.push(
      transaction
    );
  });

  historyList.innerHTML =
    Object.values(groupedTransactions)
      .map((group) => {
        const dateLabel =
          group.date
            ? formatHistoryDate(group.date)
            : "Tanggal tidak tersedia";

        const cards = group.transactions
          .map((transaction) => {
            const createdDate =
              transaction.createdAt?.toDate?.();

            const timeText =
              createdDate
                ? createdDate.toLocaleTimeString(
                    "id-ID",
                    {
                      hour: "2-digit",
                      minute: "2-digit",
                    }
                  )
                : "--:--";

            const sourceLabel =
              transaction.inputSource === "qr"
                ? "QR"
                : transaction.inputSource ===
                    "operator_whatsapp"
                  ? "OPT"
                  : "Kios";

            const status =
              transaction.processingStatus ??
              "waiting";

            const statusIcon =
              status === "success"
                ? "✅"
                : status === "failed"
                  ? "❌"
                  : "⏳";

            const typeText =
              String(
                transaction.transactionType ??
                  "Pengisian"
              );

            const nominalText =
              formatHistoryMoney(
                transaction.nominalAmount
              );

            const customerName =
              transaction.customerName ??
              "Pelanggan";

            return `
              <button
                type="button"
                class="history-card"
                data-transaction-id="${transaction.id}"
              >
                <div class="history-card-top">
                  <span class="history-time">
                    ${timeText}
                  </span>

                  <strong class="history-name">
                    ${customerName}
                  </strong>

                  <span class="history-source">
                    ${sourceLabel}
                  </span>
                </div>

                <div class="history-card-bottom">
                  <span>
                    ${typeText} · ${nominalText}
                  </span>

                  <span class="history-status">
                    ${statusIcon}
                  </span>
                </div>
              </button>
            `;
          })
          .join("");

        return `
          <section class="history-date-group">
            <div class="history-date-header">
              ${dateLabel}
            </div>

            <div class="history-date-cards">
              ${cards}
            </div>
          </section>
        `;
      })
      .join("");

      document
    .querySelectorAll(".history-card")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const transactionId =
          button.dataset.transactionId;

        history.pushState(
          {
            smartPpobView: "history-detail",
          },
          "",
          "#history-detail"
        );

        openHistoryDetail(transactionId);
      });
    });
  }
  function closeHistoryDetail() {
  historyDetailPage.classList.add(
    "hidden-page"
  );

  historyModalContent.innerHTML = "";
}
  window.addEventListener(
        "popstate",
        () => {
          const detailIsOpen =
            !historyDetailPage.classList.contains(
              "hidden-page"
            );

          if (detailIsOpen) {
            closeHistoryDetail();
          }
        }
  );
}

function renderOperatorPage(profile) {
  appElement.innerHTML = `
    <section class="operator-app">
  <header class="app-header">
    <div class="brand-header">
      <img
        src="/icons/icon-192.png"
        alt="Logo SmartPPOB"
        class="brand-logo"
      />

      <div>
        <p class="app-label">SmartPPOB</p>
        <h1>${profile.name}</h1>
      </div>
    </div>

    <button
      id="logoutButton"
      class="icon-button"
      type="button"
    >
      Keluar
    </button>
  </header>

  <nav class="app-tabs">
    <button
      id="queueTab"
      class="tab-button active"
      type="button"
    >
      Antrian
    </button>

    <button
      id="operatorHistoryTab"
      class="tab-button"
      type="button"
    >
      Riwayat
    </button>
  </nav>

    <section class="notification-panel">
    <div>
      <strong>Notifikasi Operator</strong>
      <p id="notificationStatus">
        Aktifkan agar permintaan baru muncul di HP.
      </p>
    </div>

    <button
      id="enableNotificationButton"
      type="button"
      class="notification-button"
    >
      🔔 Aktifkan
    </button>
  </section>

        <button
          id="addWhatsappTransactionButton"
          class="whatsapp-input-button"
          type="button"
        >
          + Input dari WhatsApp
        </button>

          <form
    id="whatsappTransactionForm"
    class="whatsapp-transaction-form hidden-page"
    novalidate
  >
    <div class="whatsapp-form-header">
      <div>
        <p class="app-label">Permintaan langsung</p>
        <h2>Input dari WhatsApp</h2>
      </div>

      <button
        id="cancelWhatsappTransactionButton"
        class="cancel-button"
        type="button"
      >
        Batal
      </button>
    </div>

    <fieldset class="form-section">
      <legend>Jenis transaksi</legend>

      <div class="type-grid">
        <button
          class="choice-button whatsapp-type-button"
          type="button"
          data-type="pulsa"
        >
          <span class="choice-icon">📱</span>
          <span>Pulsa</span>
        </button>

        <button
          class="choice-button whatsapp-type-button"
          type="button"
          data-type="pln"
        >
          <span class="choice-icon">⚡</span>
          <span>PLN</span>
        </button>

        <button
          class="choice-button whatsapp-type-button"
          type="button"
          data-type="other"
        >
          <span class="choice-icon">📦</span>
          <span>Lainnya</span>
        </button>
      </div>

      <label id="whatsappOtherTypeGroup" class="hidden-field">
        Jenis lainnya
        <input
          id="whatsappOtherType"
          type="text"
          placeholder="Contoh: GoPay atau paket data"
        />
      </label>
    </fieldset>

    <fieldset class="form-section">
      <legend>Nominal</legend>

      <div class="nominal-grid">
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="5">5</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="10">10</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="15">15</button>

        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="20">20</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="25">25</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="30">30</button>

        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="50">50</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="100">100</button>
        <button type="button" class="nominal-button whatsapp-nominal-button" data-value="custom">Lain</button>
      </div>

      <label id="whatsappCustomNominalGroup" class="hidden-field">
        Nominal lainnya
        <input
          id="whatsappCustomNominal"
          type="number"
          inputmode="numeric"
          min="1"
          placeholder="Contoh: 75"
        />
      </label>
    </fieldset>

    <label class="customer-name-group">
      Nama pembeli
      <input
        id="whatsappCustomerName"
        type="text"
        autocomplete="off"
        placeholder="Ketik nama pembeli"
        required
      />

      <div
        id="whatsappCustomerSuggestions"
        class="customer-suggestions hidden-page"
      ></div>
    </label>

    <label>
      Nomor HP / ID
      <input
        id="whatsappCustomerNumber"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        placeholder="Nomor HP atau ID pelanggan"
        required
      />
    </label>

    <div class="payment-group">
      <span class="payment-label">Status pembayaran</span>

      <div class="payment-buttons">
        <button
          class="payment-button whatsapp-payment-button"
          type="button"
          data-payment="paid"
        >
          Lunas
        </button>

        <button
          class="payment-button whatsapp-payment-button"
          type="button"
          data-payment="debt"
        >
          Hutang
        </button>
      </div>
    </div>

    <button
      id="saveWhatsappTransactionButton"
      class="send-button"
      type="submit"
      disabled
    >
      Masukkan ke Antrian
    </button>

    <p
      id="whatsappTransactionMessage"
      class="transaction-message"
      aria-live="polite"
    ></p>
  </form>

        <section id="queuePage" class="tab-content">
          <section class="queue-header">
            <div>
              <h2>Antrian Pengisian</h2>
              <p>Transaksi paling lama berada di atas.</p>
            </div>

            <span id="queueCount" class="queue-count">
              0 menunggu
            </span>
          </section>

          <p
            id="operatorMessage"
            class="transaction-message"
            aria-live="polite"
          ></p>

          <section id="queueList" class="queue-list">
            <div class="empty-page">
              <span class="empty-icon">✓</span>
              <h2>Tidak ada antrian</h2>
              <p>Semua pengisian sudah selesai.</p>
            </div>
          </section>
        </section>

        <section id="historyPage" class="tab-content hidden-page">
          <div id="historyList">
            <div class="empty-page">
              <span class="empty-icon">↺</span>
              <h2>Belum ada riwayat</h2>
              <p>
                Transaksi yang sudah tercatat akan tampil di sini.
              </p>
            </div>
          </div>

          <div
            id="historyDetailPage"
            class="history-modal hidden-page"
          >
            <div
              class="history-modal-backdrop"
              id="historyModalBackdrop"
            ></div>

            <div class="history-modal-card">
              <div id="historyModalContent"></div>
            </div>
          </div>
        </section>
      </section>
    </main>
  `;

  attachLogoutButton();
  attachWhatsappTransactionForm();
  attachOperatorQueue();
  attachPushNotificationUi("operator");
  attachHistoryPage();
  attachOperatorTabs();
}

function attachOperatorTabs() {
  const queueTab = document.querySelector("#queueTab");
  const historyTab = document.querySelector("#operatorHistoryTab");
  const queuePage = document.querySelector("#queuePage");
  const historyPage = document.querySelector("#historyPage");

  if (!queueTab || !historyTab || !queuePage || !historyPage) {
    return;
  }

  function openTab(tabName) {
    const queueIsActive = tabName === "queue";

    queueTab.classList.toggle("active", queueIsActive);
    historyTab.classList.toggle("active", !queueIsActive);

    queuePage.classList.toggle("hidden-page", !queueIsActive);
    historyPage.classList.toggle("hidden-page", queueIsActive);
  }

  queueTab.addEventListener("click", () => openTab("queue"));
  historyTab.addEventListener("click", () => openTab("history"));
}

  async function attachPushNotificationUi(role) {
    const enableButton =
      document.querySelector(
        "#enableNotificationButton"
      );

    const notificationStatus =
      document.querySelector(
        "#notificationStatus"
      );

    if (!enableButton || !notificationStatus) {
      return;
    }

    try {
      const messaging = await getMessagingSafe();

      if (!messaging) {
        enableButton.disabled = true;

        notificationStatus.textContent =
          "Browser ini tidak mendukung push notification.";

        return;
      }

      const { getToken, onMessage } = await import("firebase/messaging");

      if (Notification.permission === "granted") {
        notificationStatus.textContent =
          "Izin notifikasi sudah diberikan.";

        enableButton.textContent = "✓ Aktif";
        enableButton.classList.add("enabled");
      }

      enableButton.addEventListener(
        "click",
        async () => {
          enableButton.disabled = true;
          enableButton.textContent =
            "Mengaktifkan...";

          try {
            const permission =
              await Notification.requestPermission();

            if (permission !== "granted") {
              throw new Error(
                "Izin notifikasi tidak diberikan."
              );
            }

            const serviceWorkerRegistration =
              await navigator.serviceWorker.ready;

            const token = await getToken(
              messaging,
              {
                vapidKey: VAPID_PUBLIC_KEY,
                serviceWorkerRegistration,
              }
            );

            if (!token) {
              throw new Error(
                "Token notifikasi tidak diperoleh."
              );
            }

            if (!auth.currentUser) {
              throw new Error(
                "Akun tidak ditemukan."
              );
            }

            await setDoc(
              doc(
                db,
                "notificationTokens",
                token
              ),
              {
                token,
                userId: auth.currentUser.uid,
                role,
                active: true,

                deviceInfo: navigator.userAgent,

                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              },
              {
                merge: true,
              }
            );

            notificationStatus.textContent =
              "Notifikasi aktif pada perangkat ini.";

            enableButton.textContent = "✓ Aktif";
            enableButton.classList.add("enabled");
          } catch (error) {
            console.error(
              "Gagal mengaktifkan notifikasi:",
              error
            );

            notificationStatus.textContent =
              "Notifikasi gagal diaktifkan.";

            enableButton.textContent =
              "🔔 Coba Lagi";

            enableButton.disabled = false;
          }
        }
      );

      onMessage(messaging, (payload) => {
        console.log(
          "Pesan FCM diterima saat aplikasi terbuka:",
          payload
        );

        const title =
          payload.notification?.title ??
          "SmartPPOB";

        const body =
          payload.notification?.body ??
          "Ada permintaan pengisian baru.";

        notificationStatus.textContent =
          `${title}: ${body}`;
      });
    } catch (error) {
      console.error(
        `Gagal menyiapkan notifikasi ${role}:`,
        error
      );

      enableButton.disabled = true;

      notificationStatus.textContent =
        "Notifikasi tidak dapat disiapkan.";
    }
}

function attachWhatsappTransactionForm() {
  const addButton =
    document.querySelector("#addWhatsappTransactionButton");

  const form =
    document.querySelector("#whatsappTransactionForm");

  const cancelButton =
    document.querySelector("#cancelWhatsappTransactionButton");

  const typeButtons = [
    ...document.querySelectorAll(
      ".whatsapp-type-button"
    ),
  ];

  const nominalButtons = [
    ...document.querySelectorAll(
      ".whatsapp-nominal-button"
    ),
  ];

  const paymentButtons = [
    ...document.querySelectorAll(
      ".whatsapp-payment-button"
    ),
  ];

  const otherTypeGroup =
    document.querySelector("#whatsappOtherTypeGroup");

  const otherTypeInput =
    document.querySelector("#whatsappOtherType");

  const customNominalGroup =
    document.querySelector(
      "#whatsappCustomNominalGroup"
    );

  const customNominalInput =
    document.querySelector("#whatsappCustomNominal");

  const customerNameInput =
    document.querySelector("#whatsappCustomerName");

  const customerNumberInput =
    document.querySelector("#whatsappCustomerNumber");

  const customerSuggestions =
    document.querySelector(
      "#whatsappCustomerSuggestions"
    );

  const saveButton =
    document.querySelector(
      "#saveWhatsappTransactionButton"
    );

  const message =
    document.querySelector(
      "#whatsappTransactionMessage"
    );

  if (
    !addButton ||
    !form ||
    !cancelButton ||
    !saveButton
  ) {
    return;
  }

  let selectedType = "";
  let selectedNominal = "";
  let selectedPayment = "";
  let selectedCustomerId = "";
  let customerSearchTimer = null;

  function normalizeText(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function updateSaveButton() {
    const validType =
      selectedType &&
      (
        selectedType !== "other" ||
        otherTypeInput.value.trim().length >= 2
      );

    const validNominal =
      selectedNominal &&
      (
        selectedNominal !== "custom" ||
        Number(customNominalInput.value) > 0
      );

    const validCustomer =
      customerNameInput.value.trim().length >= 2 &&
      customerNumberInput.value.trim().length >= 4;

    saveButton.disabled =
      !(
        validType &&
        validNominal &&
        validCustomer &&
        selectedPayment
      );
  }

  function resetWhatsappForm() {
    form.reset();

    selectedType = "";
    selectedNominal = "";
    selectedPayment = "";
    selectedCustomerId = "";

    typeButtons.forEach((button) => {
      button.classList.remove("selected");
    });

    nominalButtons.forEach((button) => {
      button.classList.remove("selected");
    });

    paymentButtons.forEach((button) => {
      button.classList.remove("selected");
    });

    otherTypeGroup.classList.remove(
      "visible-field"
    );

    customNominalGroup.classList.remove(
      "visible-field"
    );

    customerSuggestions.innerHTML = "";
    customerSuggestions.classList.add(
      "hidden-page"
    );

    saveButton.disabled = true;
    saveButton.textContent =
      "Masukkan ke Antrian";

    message.textContent = "";
  }

  addButton.addEventListener("click", () => {
    addButton.classList.add("hidden-page");
    form.classList.remove("hidden-page");
  });

  cancelButton.addEventListener("click", () => {
    resetWhatsappForm();

    form.classList.add("hidden-page");
    addButton.classList.remove("hidden-page");
  });

  typeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      typeButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedType = button.dataset.type;

      const isOther =
        selectedType === "other";

      otherTypeGroup.classList.toggle(
        "visible-field",
        isOther
      );

      if (isOther) {
        otherTypeInput.focus();
      } else {
        otherTypeInput.value = "";
      }

      updateSaveButton();
    });
  });

  nominalButtons.forEach((button) => {
    button.addEventListener("click", () => {
      nominalButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedNominal = button.dataset.value;

      const isCustom =
        selectedNominal === "custom";

      customNominalGroup.classList.toggle(
        "visible-field",
        isCustom
      );

      if (isCustom) {
        customNominalInput.focus();
      } else {
        customNominalInput.value = "";
        customerNameInput.focus();
      }

      updateSaveButton();
    });
  });

  paymentButtons.forEach((button) => {
    button.addEventListener("click", () => {
      paymentButtons.forEach((item) => {
        item.classList.remove("selected");
      });

      button.classList.add("selected");
      selectedPayment =
        button.dataset.payment;

      updateSaveButton();
    });
  });

  [
    otherTypeInput,
    customNominalInput,
    customerNameInput,
    customerNumberInput,
  ].forEach((input) => {
    input.addEventListener(
      "input",
      updateSaveButton
    );
  });

  customerNameInput.addEventListener(
    "input",
    () => {
      selectedCustomerId = "";

      clearTimeout(customerSearchTimer);

      const keyword =
        normalizeText(customerNameInput.value);

      if (keyword.length < 2) {
        customerSuggestions.innerHTML = "";
        customerSuggestions.classList.add(
          "hidden-page"
        );
        return;
      }

      customerSearchTimer = setTimeout(
        async () => {
          try {
            const customerSnapshot =
              await getDocs(
                collection(db, "customers")
              );

            const matches =
              customerSnapshot.docs
                .map((customerDocument) => ({
                  id: customerDocument.id,
                  ...customerDocument.data(),
                }))
                .filter((customer) =>
                  String(
                    customer.normalizedName || ""
                  ).includes(keyword)
                )
                .slice(0, 6);

            if (matches.length === 0) {
              customerSuggestions.innerHTML = "";
              customerSuggestions.classList.add(
                "hidden-page"
              );
              return;
            }

            customerSuggestions.innerHTML =
              matches
                .map(
                  (customer) => `
                    <button
                      type="button"
                      class="customer-suggestion-button whatsapp-customer-suggestion"
                      data-id="${customer.id}"
                      data-name="${customer.name}"
                      data-number="${customer.number || ""}"
                      data-label="${customer.customerLabel || ""}"
                    >
                      <strong>
                        ${customer.name}
                        ${
                          customer.customerLabel
                            ? ` — ${customer.customerLabel}`
                            : ""
                        }
                      </strong>

                      <span>
                        ${
                          customer.number
                            ? customer.number
                            : "Belum memiliki nomor/ID"
                        }
                      </span>
                    </button>
                  `
                )
                .join("");

            customerSuggestions.classList.remove(
              "hidden-page"
            );

            document
              .querySelectorAll(
                ".whatsapp-customer-suggestion"
              )
              .forEach((button) => {
                button.addEventListener(
                  "click",
                  () => {
                    customerNameInput.value =
                      button.dataset.name;

                    customerNumberInput.value =
                      button.dataset.number;

                    selectedCustomerId =
                      button.dataset.id;

                    customerSuggestions.innerHTML =
                      "";

                    customerSuggestions.classList.add(
                      "hidden-page"
                    );

                    if (!button.dataset.number) {
                      customerNumberInput.focus();
                    }

                    updateSaveButton();
                  }
                );
              });
          } catch (error) {
            console.error(
              "Gagal mencari pelanggan WA:",
              error
            );
          }
        },
        250
      );
    }
  );

  async function saveWhatsappCustomer(name, number) {
  const normalizedName = normalizeText(name);

  const normalizedNumber = String(number ?? "")
    .replace(/\s+/g, "");

  const customerId =
    selectedCustomerId ||
    `${normalizedName}-${normalizedNumber}`
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 120);

  if (!customerId) {
    throw new Error("ID pelanggan tidak dapat dibuat.");
  }

  const customerReference =
    doc(db, "customers", customerId);

  const customerSnapshot =
    await getDoc(customerReference);

  if (!customerSnapshot.exists()) {
    await setDoc(customerReference, {
      name,
      number,
      normalizedName,
      normalizedNumber,

        numbers: normalizedNumber
          ? [normalizedNumber]
          : [],

      customerLabel: "",
      transactionCount: 1,

      firstTransactionAt: serverTimestamp(),
      lastTransactionAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    return customerId;
  }

  const customerData = customerSnapshot.data();

  await updateDoc(customerReference, {
    name,
    number,
    normalizedName,
    normalizedNumber,

      ...(normalizedNumber
        ? {
            numbers: arrayUnion(normalizedNumber),
          }
        : {}),

    transactionCount:
      Number(customerData.transactionCount ?? 0) + 1,

    lastTransactionAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  return customerId;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (
    saveButton.disabled ||
    !auth.currentUser
  ) {
    return;
  }

  const nominalShort =
    selectedNominal === "custom"
      ? Number(customNominalInput.value)
      : Number(selectedNominal);

  const transactionType =
    selectedType === "other"
      ? otherTypeInput.value.trim()
      : selectedType;

  const customerName =
    customerNameInput.value.trim();

  const customerNumber =
    customerNumberInput.value.trim();

  saveButton.disabled = true;
  saveButton.textContent = "Menyimpan...";
  message.textContent = "";

  try {
    const customerId =
      await saveWhatsappCustomer(
        customerName,
        customerNumber
      );

    const transactionReference = await addDoc(
      collection(db, "transactions"),
      {
        customerId,
        customerName,
        customerNumber,

        transactionType,
        nominalShort,
        nominalAmount: nominalShort * 1000,

        paymentStatus: selectedPayment,
        processingStatus: "waiting",

        inputSource: "operator_whatsapp",
        createdBy: auth.currentUser.uid,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        completedAt: null,
      }
    );

    if (selectedPayment === "debt") {
      await addDoc(collection(db, "debts"), {
        customerId,
        customerName,
        customerNumber,

        debtCategory: "digital",
        debtType: transactionType,

        nominalShort,
        nominalAmount: nominalShort * 1000,

        source: "operator-whatsapp",
        sourceTransactionId:
          transactionReference.id,

        status: "unpaid",

        createdBy: auth.currentUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        paidAt: null,
      });
    }

    await syncTransactionToSheet(
      transactionReference.id
    );

    message.textContent =
      "✓ Transaksi WhatsApp masuk ke antrian.";

    resetWhatsappForm();

    form.classList.add("hidden-page");
    addButton.classList.remove("hidden-page");
  } catch (error) {
    console.error(
      "Gagal menyimpan transaksi WhatsApp:",
      error
    );

    message.textContent =
      "Transaksi WhatsApp gagal disimpan.";

    saveButton.disabled = false;
    saveButton.textContent =
      "Masukkan ke Antrian";
  }
});

}

function attachOperatorQueue() {
  const queueList = document.querySelector("#queueList");
  const queueCount = document.querySelector("#queueCount");
  const operatorMessage = document.querySelector("#operatorMessage");

  const waitingQuery = query(
    collection(db, "transactions"),
    where("processingStatus", "==", "waiting")
  );

  onSnapshot(
    waitingQuery,
    (snapshot) => {
      const transactions = snapshot.docs
        .map((documentSnapshot) => ({
          id: documentSnapshot.id,
          ...documentSnapshot.data(),
        }))
        .sort((first, second) => {
          const firstTime =
            first.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;

          const secondTime =
            second.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;

          return firstTime - secondTime;
        });

      queueCount.textContent =
        `${transactions.length} menunggu`;

      if (transactions.length === 0) {
        queueList.innerHTML = `
          <div class="empty-page">
            <span class="empty-icon">✓</span>
            <h2>Tidak ada antrian</h2>
            <p>Semua pengisian sudah selesai.</p>
          </div>
        `;
        return;
      }

      queueList.innerHTML = transactions
        .map((transaction, index) => {
          const createdDate =
            transaction.createdAt?.toDate?.() ?? null;

          const timeText = createdDate
            ? createdDate.toLocaleTimeString("id-ID", {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "--:--";

          const paymentText =
            transaction.paymentStatus === "debt"
              ? "Hutang"
              : "Lunas";

          const sourceMap = {
            kiosk: {
              text: "Akun Kios",
              className: "source-kiosk",
            },
            qr: {
              text: "QR Pelanggan",
              className: "source-qr",
            },
            operator_whatsapp: {
              text: "WA Operator",
              className: "source-whatsapp",
            },
          };

          const sourceInfo =
            sourceMap[transaction.inputSource] ??
            {
              text: transaction.inputSource || "Tidak diketahui",
              className: "source-unknown",
            };

          const sourceText = sourceInfo.text;
          const sourceClass = sourceInfo.className; 

          return `
            <article class="queue-card">
              <div class="queue-card-top">
          <span class="queue-number">#${index + 1}</span>
          <span class="queue-time">${timeText}</span>
          <span class="source-badge ${sourceClass}">
    ${sourceText}
  </span>

          <span class="payment-badge">
    ${paymentText}
  </span>
</div>

              <h3>${transaction.customerName}</h3>

              <p class="queue-product">
                ${transaction.transactionType}
                · Rp${Number(
                  transaction.nominalAmount
                ).toLocaleString("id-ID")}
              </p>

              <p class="queue-phone">
                ${transaction.customerNumber}
              </p>

              <div class="queue-actions">
                <button
                  class="copy-number-button"
                  type="button"
                  data-number="${transaction.customerNumber}"
                >
                  Salin Nomor
                </button>

                <button
                  class="success-action-button"
                  type="button"
                  data-id="${transaction.id}"
                >
                  Berhasil
                </button>

                <button
                  class="failed-action-button"
                  type="button"
                  data-id="${transaction.id}"
                >
                  Gagal
                </button>
              </div>
            </article>
          `;
        })
        .join("");

      document
        .querySelectorAll(".copy-number-button")
        .forEach((button) => {
          button.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(
                button.dataset.number
              );

              button.textContent = "Tersalin ✓";

              setTimeout(() => {
                button.textContent = "Salin Nomor";
              }, 1500);
            } catch (error) {
              console.error("Gagal menyalin nomor:", error);

              operatorMessage.textContent =
                "Nomor gagal disalin.";
            }
          });
        });

      document
        .querySelectorAll(".success-action-button")
        .forEach((button) => {
          button.addEventListener("click", async () => {
            await updateTransactionStatus(
              button.dataset.id,
              "success"
            );
          });
        });

      document
        .querySelectorAll(".failed-action-button")
        .forEach((button) => {
          button.addEventListener("click", async () => {
            await updateTransactionStatus(
              button.dataset.id,
              "failed"
            );
          });
        });
    },
    (error) => {
      console.error("Gagal membaca antrian:", error);

      operatorMessage.textContent =
        "Antrian gagal dimuat.";
    }
  );

  async function updateTransactionStatus(
    transactionId,
    newStatus
  ) {
    operatorMessage.textContent = "Memperbarui status...";

    try {
      await updateDoc(
        doc(db, "transactions", transactionId),
        {
          processingStatus: newStatus,
          completedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        }
      );

      await syncTransactionToSheet(
        transactionId,
         {
           processingStatus: newStatus,
          completedAt: new Date().toISOString(),
        }
      );

      operatorMessage.textContent =
        newStatus === "success"
          ? "✓ Transaksi ditandai berhasil."
          : "Transaksi ditandai gagal.";

      setTimeout(() => {
        operatorMessage.textContent = "";
      }, 2000);
    } catch (error) {
      console.error("Gagal memperbarui transaksi:", error);

      operatorMessage.textContent =
        "Status gagal diperbarui.";
    }
  }
}

function renderMessageScreen(title, message) {
  appElement.innerHTML = `
    <main class="login-page">
      <section class="login-card">
        <img
          src="/icons/icon-192.png"
          alt="Logo SmartPPOB"
          class="login-logo"
        />

        <h1>${title}</h1>
        <p class="subtitle">${message}</p>

        <button id="logoutButton" type="button">
          KEMBALI
        </button>
      </section>
    </main>
  `;

  attachLogoutButton();
}

function renderRoleError(message) {
  renderMessageScreen("Akun Belum Siap", message);
}

function renderSessionBlockedScreen() {
  renderMessageScreen(
    "Akun Sedang Digunakan",
    "Akun ini sedang aktif di perangkat lain. Tunggu beberapa saat atau logout dari perangkat tersebut, lalu coba lagi."
  );
}

async function performLogout(notice) {
  const uid = auth.currentUser?.uid;
  const sessionId = currentSessionId;

  stopSessionHeartbeat();
  stopWatchingSessionTakeover();
  currentSessionId = null;

  if (uid && sessionId) {
    await releaseSession(uid, doc(db, "users", uid), sessionId);
  }

  if (notice) {
    pendingLoginNotice = notice;
  }

  await signOut(auth);
}

function attachLogoutButton() {
  document
    .querySelector("#logoutButton")
    .addEventListener("click", async () => {
      await performLogout();
    });
}

// --- Single-device session lock (Kios/Operator) ---
//
// Satu dokumen users/{uid} menyimpan activeSession: { sessionId, loginAt,
// lastActive, device }. Perangkat yang berhasil klaim menyimpan sessionId-nya
// sendiri di localStorage supaya reload di perangkat yang sama dikenali
// sebagai kelanjutan sesi, bukan perangkat baru. Klaim & heartbeat memakai
// runTransaction supaya dua perangkat tidak bisa klaim bersamaan, dan supaya
// heartbeat tidak diam-diam menghidupkan lagi sesi yang sudah direbut
// perangkat lain.

function getStoredSessionId(uid) {
  return localStorage.getItem(SESSION_ID_STORAGE_PREFIX + uid);
}

function setStoredSessionId(uid, sessionId) {
  localStorage.setItem(SESSION_ID_STORAGE_PREFIX + uid, sessionId);
}

function clearStoredSessionId(uid) {
  localStorage.removeItem(SESSION_ID_STORAGE_PREFIX + uid);
}

async function claimOrRejectSession(uid, userReference) {
  const storedSessionId = getStoredSessionId(uid);

  const result = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(userReference);
    const activeSession = snapshot.data()?.activeSession;

    const isStale =
      !activeSession?.lastActive ||
      Date.now() - activeSession.lastActive.toMillis() >
        SESSION_TIMEOUT_MS;

    const isOurs =
      Boolean(activeSession?.sessionId) &&
      activeSession.sessionId === storedSessionId;

    if (activeSession && !isStale && !isOurs) {
      return { granted: false, sessionId: storedSessionId };
    }

    const sessionId = isOurs
      ? storedSessionId
      : crypto.randomUUID();

    transaction.update(userReference, {
      activeSession: {
        sessionId,
        loginAt: isOurs ? activeSession.loginAt : serverTimestamp(),
        lastActive: serverTimestamp(),
        device: navigator.userAgent.slice(0, 120),
      },
    });

    return { granted: true, sessionId };
  });

  if (result.granted) {
    setStoredSessionId(uid, result.sessionId);
  }

  return result;
}

function startSessionHeartbeat(uid, userReference, sessionId) {
  stopSessionHeartbeat();

  sessionHeartbeatTimer = setInterval(async () => {
    if (Date.now() - lastInteractionAt > IDLE_TIMEOUT_MS) {
      await performLogout(
        "Anda otomatis keluar karena tidak ada aktivitas selama 2 menit."
      );
      return;
    }

    try {
      const stillOurs = await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(userReference);
        const activeSession = snapshot.data()?.activeSession;

        if (activeSession?.sessionId !== sessionId) {
          return false;
        }

        transaction.update(userReference, {
          "activeSession.lastActive": serverTimestamp(),
        });

        return true;
      });

      if (!stillOurs) {
        await handleSessionLostElsewhere(uid);
      }
    } catch (error) {
      console.warn("Heartbeat sesi gagal, akan dicoba lagi:", error);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopSessionHeartbeat() {
  if (sessionHeartbeatTimer) {
    clearInterval(sessionHeartbeatTimer);
    sessionHeartbeatTimer = null;
  }
}

function watchForSessionTakeover(uid, userReference, sessionId) {
  stopWatchingSessionTakeover();

  sessionTakeoverUnsubscribe = onSnapshot(userReference, (snapshot) => {
    const activeSession = snapshot.data()?.activeSession;

    if (
      activeSession?.sessionId &&
      activeSession.sessionId !== sessionId
    ) {
      handleSessionLostElsewhere(uid);
    }
  });
}

function stopWatchingSessionTakeover() {
  if (sessionTakeoverUnsubscribe) {
    sessionTakeoverUnsubscribe();
    sessionTakeoverUnsubscribe = null;
  }
}

async function releaseSession(uid, userReference, sessionId) {
  try {
    await runTransaction(db, async (transaction) => {
      const snapshot = await transaction.get(userReference);
      const activeSession = snapshot.data()?.activeSession;

      if (activeSession?.sessionId === sessionId) {
        transaction.update(userReference, {
          activeSession: deleteField(),
        });
      }
    });
  } catch (error) {
    console.warn("Gagal melepas sesi di server:", error);
  }

  clearStoredSessionId(uid);
}

async function handleSessionLostElsewhere(
  uid,
  notice = "Sesi Anda berakhir karena akun ini login di perangkat lain."
) {
  stopSessionHeartbeat();
  stopWatchingSessionTakeover();
  clearStoredSessionId(uid);
  currentSessionId = null;

  pendingLoginNotice = notice;

  await signOut(auth);
}

// Satu browser bisa punya beberapa tab situs ini terbuka sekaligus — semua
// berbagi localStorage yang sama tapi berjalan sebagai proses JS terpisah
// (tidak saling tahu). Kalau satu tab logout (hapus sessionId dari
// localStorage), event "storage" ini otomatis kedengaran di tab LAIN
// (bukan di tab yang melakukan perubahan) supaya tab itu juga berhenti
// heartbeat, bukannya diam-diam terus "menghidupkan" sesi yang sudah
// dilepas tab sebelah — inilah yang bikin akun terasa "nyangkut" walau
// user merasa sudah logout semua.
window.addEventListener("storage", (event) => {
  const uid = auth.currentUser?.uid;

  if (!uid || !currentSessionId) {
    return;
  }

  if (event.key !== SESSION_ID_STORAGE_PREFIX + uid) {
    return;
  }

  if (event.newValue !== currentSessionId) {
    handleSessionLostElsewhere(
      uid,
      "Anda sudah logout dari tab/jendela lain di browser ini."
    );
  }
});

async function renderLoggedIn(user) {
  renderRoleLoading();

  try {
    const userReference = doc(db, "users", user.uid);
    const userSnapshot = await getDoc(userReference);

    if (!userSnapshot.exists()) {
      renderRoleError("Data role akun tidak ditemukan.");
      return;
    }

    const profile = userSnapshot.data();

    if (profile.role !== "kiosk" && profile.role !== "operator") {
      renderRoleError("Role akun tidak dikenali.");
      return;
    }

    // Login cepat PIN khusus Kios -- simpan kredensial perangkat ini kalau
    // tadi dicentang "ingat perangkat ini" waktu login lengkap.
    if (
      profile.role === "kiosk" &&
      pendingRememberDeviceCredentials
    ) {
      storeTrustedKioskDevice(
        pendingRememberDeviceCredentials.email,
        pendingRememberDeviceCredentials.password
      );
    }

    pendingRememberDeviceCredentials = null;

    const claim = await claimOrRejectSession(user.uid, userReference);

    if (!claim.granted) {
      await signOut(auth);
      renderSessionBlockedScreen();
      return;
    }

    currentSessionId = claim.sessionId;
    startSessionHeartbeat(user.uid, userReference, claim.sessionId);
    watchForSessionTakeover(user.uid, userReference, claim.sessionId);

    if (profile.role === "kiosk") {
      renderKioskPage(profile);
      return;
    }

    renderOperatorPage(profile);
  } catch (error) {
    console.error("Gagal membaca role:", error);
    renderRoleError("Gagal membaca data akun.");
  }
}

onAuthStateChanged(auth, async (user) => {
  if (isQrMode) {
    if (!user || !user.isAnonymous) {
      try {
        if (user && !user.isAnonymous) {
          await signOut(auth);
        }

        await signInAnonymously(auth);
      } catch (error) {
        console.error(
          "Gagal membuka akses QR:",
          error
        );

        appElement.innerHTML = `
          <main class="login-page">
            <section class="login-card">
              <h1>QR Tidak Bisa Dibuka</h1>
              <p class="subtitle">
                Silakan scan ulang QR di kios.
              </p>
            </section>
          </main>
        `;
      }

      return;
    }

    renderQrPage();
    return;
  }

  if (user?.isAnonymous) {
    await signOut(auth);
    renderLogin();
    return;
  }

  if (user) {
    renderLoggedIn(user);
  } else {
    renderLogin();
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js");

      console.log(
        "Service worker SmartPPOB berhasil terdaftar."
      );
    } catch (error) {
      console.error(
        "Service worker gagal terdaftar:",
        error
      );
    }
  });
}