const {
  onDocumentCreated,
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