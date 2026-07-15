/**
 * Twilio sandbox router. With TWILIO_* env vars present it hits the Twilio
 * REST API directly (no SDK dependency); without them it falls back to a
 * console mock so the demo runs with zero keys.
 */
export async function sendCriticalAlert(phoneNumber, { chargerId, fault }) {
  const body = `Sent from your Twilio trial account - [Nemzilla AI] CRITICAL: Station ${chargerId} is reporting a ${fault}. Diagnostic brief attached.`;

  const {
    TWILIO_ACCOUNT_SID: sid,
    TWILIO_AUTH_TOKEN: token,
    TWILIO_FROM_NUMBER: from,
  } = process.env;

  if (!sid || !token || !from) {
    console.log(`[MOCK SMS ROUTE]: Sending critical alert message to ${phoneNumber}: "${body}"`);
    return { mocked: true, to: phoneNumber, body };
  }

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phoneNumber, From: from, Body: body }),
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Twilio API responded ${res.status}: ${detail}`);
  }
  const message = await res.json();
  return { mocked: false, to: phoneNumber, sid: message.sid };
}
