const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");

const {
  initializeApp,
} = require("firebase-admin/app");

const {
  getFirestore,
} = require("firebase-admin/firestore");

const {
  getMessaging,
} = require("firebase-admin/messaging");

initializeApp();

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

      const tokens = tokenSnapshot.docs
        .map((doc) => doc.data().token)
        .filter(Boolean);

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

      const tokens = tokenSnapshot.docs
        .map((doc) => doc.data().token)
        .filter(Boolean);

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
    }
  );