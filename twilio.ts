import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

/* =========================================================
   TWILIO SMS SERVICE
========================================================= */

let twilioClient: twilio.Twilio | null = null;

const getTwilioClient = (): twilio.Twilio => {
  if (!twilioClient) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      throw new Error(
        "Missing Twilio credentials. Check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN"
      );
    }

    twilioClient = twilio(accountSid, authToken);
  }

  return twilioClient;
};

/* =========================================================
   TYPES
========================================================= */

export interface SessionData {
  activity: string;
  timeStart: any;
  location: string;
  durationMinutes: number;
  pricePerSeat: number;
}

export interface RiderData {
  name?: string | null;
  phone?: string | null;
}

/* =========================================================
   HELPERS
========================================================= */

const formatDate = (value: any): Date => {
  if (value?.toDate && typeof value.toDate === "function") {
    return value.toDate(); // Firestore Timestamp
  }

  if (value?.seconds) {
    return new Date(value.seconds * 1000);
  }

  return new Date(value);
};

const getTwilioPhone = (): string => {
  const phone = process.env.TWILIO_PHONE_NUMBER;

  if (!phone) {
    throw new Error("Missing TWILIO_PHONE_NUMBER");
  }

  return phone;
};

const sendSMS = async (to: string, body: string) => {
  const response = await getTwilioClient().messages.create({
    body,
    from: getTwilioPhone(),
    to,
  });

  console.log("SMS Sent:", response.sid);
  return response;
};

/* =========================================================
   BOOKING SMS
========================================================= */

export const sendBookingSMS = async (
  phoneNumber: string,
  sessionData: any,
  riderName: string
): Promise<void> => {
  try {

    console.log(phoneNumber,process.env.TWILIO_PHONE_NUMBER,riderName)

    const date = formatDate(sessionData.timeStart);

    const message =
      `🚀 BBK Booking Confirmed!\n\n` +
      `Hi ${riderName},\n\n` +
      `Activity: ${sessionData.activity}\n` +
      `Date: ${date.toLocaleDateString()}\n` +
      `Time: ${date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}\n` +
      `Location: ${sessionData.location}\n` +
      `Duration: ${sessionData.durationMinutes} minutes\n` +
      `Amount: AED ${sessionData.pricePerSeat}\n\n` +
      `See you there! 🌊`;

    await sendSMS(phoneNumber, message);
  } catch (error: any) {
    console.error("Booking SMS failed:", error?.message || error);
  }
};

/* =========================================================
   PAYMENT CONFIRMATION SMS
========================================================= */

export const sendPaymentConfirmationSMS = async (
  phoneNumber: string,
  sessionData: any,
  riderName: string
): Promise<void> => {
  try {
    const date = formatDate(sessionData.timeStart);

    const message =
      `✅ Payment Confirmed!\n\n` +
      `Hi ${riderName},\n\n` +
      `Your booking for ${sessionData.activity} is confirmed.\n` +
      `Date: ${date.toLocaleDateString()}\n` +
      `Time: ${date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}\n` +
      `Location: ${sessionData.location}\n\n` +
      `Amount: AED ${sessionData.pricePerSeat}\n` +
      `Status: Captured ✅\n\n` +
      `Have a great time! 🎉`;

    await sendSMS(phoneNumber, message);
  } catch (error: any) {
    console.error(
      "Payment confirmation SMS failed:",
      error?.message || error
    );
  }
};