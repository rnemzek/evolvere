/**
 * Structured NOC event logger. Emits a single grep-friendly line per alert
 * transaction to stdout for production container streams (e.g. Railway logs).
 */
export async function sendCriticalAlert(phoneNumber, { chargerId, fault }) {
  const line = `[ēvolvere-NOC-EVENT] CRITICAL_FAULT | Timestamp: ${new Date().toISOString()} | Data: ${JSON.stringify({ chargerId, fault, eventType: 'HARDWARE_ANOMALY', triagedBy: 'Nemzilla_AI' })}`;
  console.log(line);
  return { logged: true, chargerId, fault };
}
