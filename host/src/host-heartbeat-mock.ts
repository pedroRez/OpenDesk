const apiUrl = process.env.HEARTBEAT_API_URL ?? 'http://localhost:3333';
const hostId = process.env.HOST_ID ?? '';
const intervalMs = Number(process.env.HEARTBEAT_INTERVAL_MS ?? 10000);

if (!hostId) {
  console.error('Defina HOST_ID para enviar heartbeat.');
  process.exit(1);
}

async function sendHeartbeat() {
  try {
    const response = await fetch(`${apiUrl}/hosts/${hostId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ONLINE' }),
    });

    if (!response.ok) {
      console.error('Falha no heartbeat', await response.text());
    } else {
      console.log('Heartbeat enviado', new Date().toISOString());
    }
  } catch (error) {
    console.error('Erro no heartbeat', error);
  }
}

setInterval(sendHeartbeat, intervalMs);
void sendHeartbeat();
