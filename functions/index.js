const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");

const {
  onSchedule,
} = require("firebase-functions/v2/scheduler");

const {
  initializeApp,
} = require("firebase-admin/app");

const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");

const {
  getMessaging,
} = require("firebase-admin/messaging");

initializeApp();

// Kode error FCM yang berarti token itu sudah tidak valid lagi (app
// di-uninstall, izin notifikasi dicabut, dsb) -- bukan sekadar gagal
// sementara karena jaringan/kuota.
const INVALID_TOKEN_ERROR_CODES = [
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
];

async function deactivateInvalidTokens(tokenDocs, response) {
  const deactivations = response.responses
    .map((result, index) => ({
      result,
      doc: tokenDocs[index],
    }))
    .filter(
      ({ result }) =>
        !result.success &&
        INVALID_TOKEN_ERROR_CODES.includes(
          result.error?.code
        )
    )
    .map(({ doc }) =>
      doc.ref.update({
        active: false,
        deactivatedAt: FieldValue.serverTimestamp(),
      })
    );

  if (deactivations.length === 0) {
    return;
  }

  await Promise.all(deactivations);

  console.log(
    "Token tidak valid dinonaktifkan:",
    deactivations.length
  );
}

exports.notifyOperatorOnNewTransaction =
  onDocumentCreated(
    {
      document: "transactions/{transactionId}",
      region: "asia-southeast2",
    },
    async (event) => {
      const snapshot = event.data;

      if (!snapshot) {
        console.log("Data transaksi tidak ditemukan.");
        return;
      }

      const transaction = snapshot.data();

      const inputSource =
        transaction.inputSource ?? "";

      // WA Operator tidak perlu push ke dirinya sendiri.
      if (inputSource === "operator_whatsapp") {
        console.log(
          "Transaksi WA Operator, push dilewati."
        );
        return;
      }

      const db = getFirestore();

      const tokenSnapshot =
        await db
          .collection("notificationTokens")
          .where("role", "==", "operator")
          .where("active", "==", true)
          .get();

      const tokenDocs = tokenSnapshot.docs.filter(
        (doc) => Boolean(doc.data().token)
      );

      const tokens = tokenDocs.map(
        (doc) => doc.data().token
      );

      if (tokens.length === 0) {
        console.log(
          "Tidak ada token Operator aktif."
        );
        return;
      }

      const sourceLabel =
        inputSource === "qr"
          ? "QR Pelanggan"
          : "Akun Kios";

      const customerName =
        transaction.customerName || "Pelanggan";

      const transactionType =
        transaction.transactionType || "Pengisian";

      const nominalAmount =
        Number(transaction.nominalAmount || 0);

      const nominalText =
        nominalAmount.toLocaleString("id-ID");

      const message = {
        notification: {
          title: "Permintaan Baru SmartPPOB",
          body:
            `${customerName} · ` +
            `${transactionType} Rp${nominalText} · ` +
            sourceLabel,
        },

        data: {
          transactionId:
            event.params.transactionId,

          url: "/",
        },

        webpush: {
          headers: {
            Urgency: "high",
          },

          fcmOptions: {
            link:
              "https://smartppob-pasirhaur.web.app/",
          },
        },

        tokens,
      };

      const response =
        await getMessaging()
          .sendEachForMulticast(message);

      console.log(
        "Push terkirim:",
        response.successCount,
        "gagal:",
        response.failureCount
      );

      await deactivateInvalidTokens(tokenDocs, response);
    }
  );

exports.notifyKioskOnTransactionCompletion =
  onDocumentUpdated(
    {
      document: "transactions/{transactionId}",
      region: "asia-southeast2",
    },
    async (event) => {
      const beforeSnapshot = event.data?.before;
      const afterSnapshot = event.data?.after;

      if (!beforeSnapshot || !afterSnapshot) {
        console.log("Data transaksi tidak ditemukan.");
        return;
      }

      const before = beforeSnapshot.data();
      const after = afterSnapshot.data();

      const wasWaiting =
        before.processingStatus === "waiting";

      const isNowCompleted =
        after.processingStatus === "success" ||
        after.processingStatus === "failed";

      if (!wasWaiting || !isNowCompleted) {
        console.log(
          "Bukan transisi penyelesaian transaksi, push dilewati."
        );
        return;
      }

      const inputSource = after.inputSource ?? "";

      // Hanya transaksi dari Kios yang punya akun persisten
      // untuk dikirimi push balik.
      if (inputSource !== "kiosk") {
        console.log(
          "Bukan transaksi Kios, push dilewati."
        );
        return;
      }

      const createdBy = after.createdBy;

      if (!createdBy) {
        console.log(
          "Transaksi tanpa createdBy, push dilewati."
        );
        return;
      }

      const db = getFirestore();

      const tokenSnapshot =
        await db
          .collection("notificationTokens")
          .where("role", "==", "kiosk")
          .where("userId", "==", createdBy)
          .where("active", "==", true)
          .get();

      const tokenDocs = tokenSnapshot.docs.filter(
        (doc) => Boolean(doc.data().token)
      );

      const tokens = tokenDocs.map(
        (doc) => doc.data().token
      );

      if (tokens.length === 0) {
        console.log(
          "Tidak ada token Kios aktif untuk akun ini."
        );
        return;
      }

      const isSuccess =
        after.processingStatus === "success";

      const customerName =
        after.customerName || "Pelanggan";

      const transactionType =
        after.transactionType || "Pengisian";

      const nominalAmount =
        Number(after.nominalAmount || 0);

      const nominalText =
        nominalAmount.toLocaleString("id-ID");

      const message = {
        notification: {
          title: isSuccess
            ? "Transaksi Berhasil"
            : "Transaksi Gagal",
          body:
            `${customerName} · ` +
            `${transactionType} Rp${nominalText} · ` +
            (isSuccess
              ? "telah diproses Operator."
              : "gagal diproses, mohon dicek."),
        },

        data: {
          transactionId:
            event.params.transactionId,

          url: "/",
        },

        webpush: {
          headers: {
            Urgency: "high",
          },

          fcmOptions: {
            link:
              "https://smartppob-pasirhaur.web.app/",
          },
        },

        tokens,
      };

      const response =
        await getMessaging()
          .sendEachForMulticast(message);

      console.log(
        "Push Kios terkirim:",
        response.successCount,
        "gagal:",
        response.failureCount
      );

      await deactivateInvalidTokens(tokenDocs, response);
    }
  );

// Jadwal harian: token yang sudah dinonaktifkan (active === false) oleh
// deactivateInvalidTokens di atas dihapus sungguhan dari koleksi supaya
// tidak menumpuk selamanya sebagai data mati.
exports.cleanupInactiveNotificationTokens =
  onSchedule(
    {
      schedule: "every 24 hours",
      region: "asia-southeast2",
    },
    async () => {
      const db = getFirestore();

      const inactiveSnapshot =
        await db
          .collection("notificationTokens")
          .where("active", "==", false)
          .get();

      if (inactiveSnapshot.empty) {
        console.log(
          "Tidak ada token mati untuk dibersihkan."
        );
        return;
      }

      const batch = db.batch();

      inactiveSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();

      console.log(
        "Token mati dibersihkan:",
        inactiveSnapshot.size
      );
    }
  );