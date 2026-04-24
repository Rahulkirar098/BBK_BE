import twilio from "twilio";

/* =========================================================
   TWILIO SMS SERVICE
========================================================= */

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

export interface SessionData {
  activity: string;
  timeStart: any;
  location: string;
  durationMinutes: number;
  pricePerSeat: number;
}

export interface RiderData {
  name: string | null;
  phone: string | null;
}

export const sendBookingSMS = async (phoneNumber: string, sessionData: SessionData, riderName: string) => {
  try {
    if (!process.env.TWILIO_PHONE_NUMBER) {
      console.warn("Twilio phone number not configured");
      return;
    }

    const message = `🚀 BBK Booking Confirmed!\n\n` +
      `Hi ${riderName},\n` +
      `Activity: ${sessionData.activity}\n` +
      `Date: ${new Date(sessionData.timeStart).toLocaleDateString()}\n` +
      `Time: ${new Date(sessionData.timeStart).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n` +
      `Location: ${sessionData.location}\n` +
      `Duration: ${sessionData.durationMinutes} minutes\n` +
      `Amount: AED ${sessionData.pricePerSeat}\n\n` +
      `See you there! 🌊`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log(`SMS sent to ${phoneNumber}`);
  } catch (error: any) {
    console.error("SMS sending failed:", error.message);
  }
};

export const sendPaymentConfirmationSMS = async (phoneNumber: string, sessionData: any, riderName: string) => {
  try {
    if (!process.env.TWILIO_PHONE_NUMBER) {
      console.warn("Twilio phone number not configured");
      return;
    }

    const message = `✅ Payment Confirmed!\n\n` +
      `Hi ${riderName},\n` +
      `Your booking for ${sessionData.activity} is fully confirmed.\n` +
      `Date: ${new Date(sessionData.timeStart).toLocaleDateString()}\n` +
      `Time: ${new Date(sessionData.timeStart).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}\n` +
      `Location: ${sessionData.location}\n\n` +
      `Payment: AED ${sessionData.pricePerSeat}\n` +
      `Status: Captured ✅\n\n` +
      `Have a great time! 🎉`;

    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });

    console.log(`Payment confirmation SMS sent to ${phoneNumber}`);
  } catch (error: any) {
    console.error("SMS sending failed:", error.message);
  }
};
