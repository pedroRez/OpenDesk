# OpenDesk Streaming MVP (LAN + WAN Relay)

## Decision for outside LAN

Chosen strategy: **Option B - Backend Relay (WebSocket)**.

Why B now:
- Lower implementation risk than full WebRTC (ICE/STUN/TURN/state machine) in this phase.
- Works through NAT because both host and client open outbound connections to backend.
- Reuses existing H.264 pipeline and existing session/token model.
- Keeps Sunshine/Moonlight fallback unchanged.

Tradeoff:
- Extra server bandwidth and added latency versus direct LAN.

---

## Incremental architecture

```mermaid
flowchart LR
  H[host-daemon\nH.264 encoder] -->|WS binary (relay)| B[backend Fastify\n/stream/relay]
  C[Tauri client\nWebCodecs player] -->|WS subscribe| B
  C -->|feedback JSON| B -->|forward| H
  C -. fallback .-> M[Moonlight]
  H -. fallback .-> S[Sunshine]
```

LAN path remains available (UDP video + TCP input) for local/low-latency scenarios.

---

## Signaling contract

### `POST /sessions/:id/stream/start`

Session-gated signaling now returns both transports:

```json
{
  "sessionId": "uuid",
  "sessionStatus": "ACTIVE",
  "streamState": "ACTIVE",
  "host": "10.0.0.12",
  "videoPort": 5004,
  "inputPort": 5505,
  "streamId": "uuid-derived",
  "token": "stream-token",
  "tokenExpiresAt": "2026-02-23T20:00:00.000Z",
  "transport": {
    "recommended": "RELAY_WS",
    "relay": {
      "mode": "RELAY_WS",
      "url": "wss://api.example.com/stream/relay",
      "roleClient": "client",
      "roleHost": "host",
      "sessionId": "uuid",
      "streamId": "uuid-derived",
      "token": "stream-token",
      "tokenExpiresAt": "2026-02-23T20:00:00.000Z"
    },
    "lan": {
      "mode": "UDP_LAN",
      "host": "10.0.0.12",
      "videoPort": 5004,
      "inputPort": 5505
    }
  },
  "fallback": {
    "provider": "SUNSHINE_MOONLIGHT",
    "connectAddress": "10.0.0.12:5004"
  }
}
```

---

## Relay websocket contract

### Endpoint

`GET /stream/relay` (`websocket: true`)

### Handshake query params

- `role`: `host` | `client`
- `sessionId`: UUID
- `streamId`: derived stream id
- `token`: stream token
- `userId`: authenticated user id

### Auth rules

- Token must exist and not be expired.
- Session must be `PENDING` or `ACTIVE`.
- Token must match session owner/pc (`token.userId == session.clientUserId` and `token.pcId == session.pcId`).
- `streamId` must match deterministic `deriveStreamId(token)`.
- `role=client` requires `userId == session.clientUserId`.
- `role=host` requires `userId == session.pc.host.userId`.

### Rate limits (minimum)

- Connection attempts per `ip+user+session` window.
- Host payload bytes/sec cap.
- Client control message rate cap and max control message size.

---

## Media/control payloads

### Host -> client (binary)

`relay_h264_annexb_v1`

Frame envelope:
- Byte `0`: flags (bit0 = keyframe)
- Bytes `1..8`: `timestampUs` (u64, big-endian)
- Bytes `9..`: H.264 Annex B payload

### Client -> host (text JSON)

Control/feedback (forwarded by relay):

```json
{
  "type": "keyframe_request|network_report|reconnect",
  "token": "stream-token",
  "sessionId": "uuid",
  "streamId": "uuid-derived",
  "lossPct": 3.2,
  "jitterMs": 17.5,
  "freezeMs": 1200,
  "requestedBitrateKbps": 3200,
  "reason": "network_degraded"
}
```

Host reacts with:
- immediate IDR request handling,
- bitrate downshift under loss/jitter,
- clean reconnect support.

---

## Components

### Backend (`backend`)
- `src/routes/sessions.ts`: signaling with `transport.relay` + `transport.lan`.
- `src/routes/streamRelay.ts`: relay WS rooming/auth/rate-limit/forwarding.
- `src/utils/streamIdentity.ts`: deterministic `streamId` derivation.

### Host (`aplicativo/host-daemon`)
- `src/transport/relayHost.ts`: H.264 sender over relay WS + feedback handling.
- `src/transport/udpLanHost.ts`: LAN sender remains as fallback/local path.

### Client (`aplicativo`)
- `src/pages/client/Connection.tsx`: consumes relay signaling, chooses transport.
- `src/components/LanNativePlayer.tsx`: supports `transportMode=lan|relay`.

---

## Observability

### Backend logs
- `relay_connect`
- `relay_disconnect`
- `relay_connect_denied_rate`
- `relay_room_closed`
- `relay_socket_error`

### Host logs
- `relay_sender_start`
- `relay_sender_stats`
- `relay_sender_bitrate_drop_requested`
- `relay_sender_summary`

### Client UI metrics
- FPS render/assembled
- bitrate
- loss/jitter (LAN)
- keyframe requests / network reports / reconnect attempts

---

## Fallback policy

If native relay/LAN fails to establish or degrades beyond acceptable thresholds, keep existing Sunshine/Moonlight path available and callable from connection screen.
