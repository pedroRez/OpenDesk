const DEFAULT_SUNSHINE_PORT = 47990;

async function detectLocalIp(): Promise<string | null> {
  if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
    return null;
  }

  return new Promise((resolve) => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    peer.createDataChannel('probe');

    const cleanup = () => {
      peer.onicecandidate = null;
      peer.close();
    };

    peer.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate;
      if (!candidate) {
        cleanup();
        resolve(null);
        return;
      }

      const match = candidate.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };

    peer
      .createOffer()
      .then((offer) => peer.setLocalDescription(offer))
      .catch(() => {
        cleanup();
        resolve(null);
      });
  });
}

export async function resolveConnectAddress(): Promise<string> {
  const override = import.meta.env.VITE_HOST_CONNECT_ADDRESS;
  if (override) return override;

  const ip = await detectLocalIp();
  if (ip) return `${ip}:${DEFAULT_SUNSHINE_PORT}`;

  return `127.0.0.1:${DEFAULT_SUNSHINE_PORT}`;
}

export const DEFAULT_CONNECT_HINT = 'Sunshine LAN';
