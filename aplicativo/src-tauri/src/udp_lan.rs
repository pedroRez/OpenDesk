use std::collections::BTreeMap;
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const UDP_MAGIC: u16 = 0x4f44;
const UDP_VERSION: u8 = 1;
const UDP_HEADER_SIZE: usize = 38;
const DEFAULT_LISTEN_HOST: &str = "0.0.0.0";
const DEFAULT_LISTEN_PORT: u16 = 5004;
const DEFAULT_MAX_FRAME_AGE_MS: u64 = 40;
const DEFAULT_MAX_PENDING_FRAMES: usize = 96;
const DEFAULT_STATS_INTERVAL_MS: u64 = 1000;

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct StartUdpLanReceiverOptions {
  pub listenHost: Option<String>,
  pub listenPort: Option<u16>,
  pub streamId: Option<String>,
  pub maxFrameAgeMs: Option<u64>,
  pub maxPendingFrames: Option<usize>,
  pub statsIntervalMs: Option<u64>,
}

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct UdpLanFeedbackMessage {
  #[serde(rename = "type")]
  pub message_type: String,
  pub version: Option<u8>,
  pub token: String,
  pub sessionId: Option<String>,
  pub streamId: Option<String>,
  pub lossPct: Option<f64>,
  pub jitterMs: Option<f64>,
  pub freezeMs: Option<u64>,
  pub requestedBitrateKbps: Option<u32>,
  pub reason: Option<String>,
}

#[derive(Serialize)]
#[allow(non_snake_case)]
struct UdpLanFeedbackWireMessage<'a> {
  #[serde(rename = "type")]
  message_type: &'a str,
  version: u8,
  token: &'a str,
  sessionId: Option<&'a str>,
  streamId: Option<&'a str>,
  lossPct: Option<f64>,
  jitterMs: Option<f64>,
  freezeMs: Option<u64>,
  requestedBitrateKbps: Option<u32>,
  reason: Option<&'a str>,
  sentAtUs: u64,
}

#[derive(Clone)]
struct NormalizedOptions {
  listen_host: String,
  listen_port: u16,
  expected_stream_id: Option<[u8; 16]>,
  max_frame_age_ms: u64,
  max_pending_frames: usize,
  stats_interval_ms: u64,
}

struct ReceiverStats {
  started_at: Instant,
  packets_received: u64,
  packets_accepted: u64,
  packets_invalid: u64,
  packets_duplicate: u64,
  packets_stream_mismatch: u64,
  frames_completed: u64,
  frames_dropped_timeout: u64,
  frames_dropped_queue: u64,
  frames_dropped_late: u64,
  frames_dropped_gap: u64,
  missing_chunks: u64,
  keyframes_completed: u64,
  bytes_reassembled: u64,
  seq_gap_frames: u64,
  jitter_ms: f64,
  remote_address: Option<String>,
  remote_port: Option<u16>,
}

impl ReceiverStats {
  fn new() -> Self {
    Self {
      started_at: Instant::now(),
      packets_received: 0,
      packets_accepted: 0,
      packets_invalid: 0,
      packets_duplicate: 0,
      packets_stream_mismatch: 0,
      frames_completed: 0,
      frames_dropped_timeout: 0,
      frames_dropped_queue: 0,
      frames_dropped_late: 0,
      frames_dropped_gap: 0,
      missing_chunks: 0,
      keyframes_completed: 0,
      bytes_reassembled: 0,
      seq_gap_frames: 0,
      jitter_ms: 0.0,
      remote_address: None,
      remote_port: None,
    }
  }
}

#[derive(Serialize, Clone)]
#[allow(non_snake_case)]
struct UdpLanFrameEvent {
  streamId: String,
  seq: u32,
  timestampUs: u64,
  flags: u8,
  totalChunks: u16,
  receivedChunks: u16,
  payloadBytes: usize,
  payloadBase64: String,
}

#[derive(Serialize, Clone)]
#[allow(non_snake_case)]
struct UdpLanStatsEvent {
  streamId: Option<String>,
  listenHost: String,
  listenPort: u16,
  packetsReceived: u64,
  packetsAccepted: u64,
  packetsInvalid: u64,
  packetsDuplicate: u64,
  packetsStreamMismatch: u64,
  framesCompleted: u64,
  framesDroppedTimeout: u64,
  framesDroppedQueue: u64,
  framesDroppedLate: u64,
  framesDroppedGap: u64,
  missingChunks: u64,
  lossPct: f64,
  jitterMs: f64,
  fpsAssembled: f64,
  bitrateKbps: f64,
  pendingFrames: usize,
  remoteAddress: Option<String>,
  remotePort: Option<u16>,
}

#[derive(Serialize, Clone)]
#[allow(non_snake_case)]
struct UdpLanStoppedEvent {
  reason: String,
}

#[derive(Serialize, Clone)]
#[allow(non_snake_case)]
struct UdpLanErrorEvent {
  message: String,
}

struct UdpDatagram {
  stream_id: [u8; 16],
  seq: u32,
  timestamp_us: u64,
  flags: u8,
  chunk_index: u16,
  total_chunks: u16,
  payload: Vec<u8>,
}

struct PendingFrame {
  seq: u32,
  timestamp_us: u64,
  flags: u8,
  total_chunks: u16,
  chunks: Vec<Option<Vec<u8>>>,
  received_chunks: u16,
  first_arrival: Instant,
}

struct UdpLanReceiverHandle {
  stop: Arc<AtomicBool>,
  feedback_socket: UdpSocket,
  feedback_route: Arc<Mutex<UdpLanFeedbackRoute>>,
  join: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct UdpLanFeedbackRoute {
  remote: Option<SocketAddr>,
  active_stream_id: Option<[u8; 16]>,
}

static UDP_LAN_RECEIVER: OnceLock<Mutex<Option<UdpLanReceiverHandle>>> = OnceLock::new();

fn receiver_slot() -> &'static Mutex<Option<UdpLanReceiverHandle>> {
  UDP_LAN_RECEIVER.get_or_init(|| Mutex::new(None))
}

fn now_us() -> u64 {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_else(|_| Duration::from_secs(0));
  now.as_micros().try_into().unwrap_or(0)
}

fn parse_stream_id_hex(input: &str) -> Result<[u8; 16], String> {
  let normalized = input.trim().replace('-', "").to_lowercase();
  if normalized.len() != 32 {
    return Err("streamId invalido: esperado UUID com 16 bytes.".to_string());
  }

  let mut out = [0u8; 16];
  for i in 0..16 {
    let hi = normalized.as_bytes()[i * 2] as char;
    let lo = normalized.as_bytes()[i * 2 + 1] as char;
    let pair = format!("{}{}", hi, lo);
    let byte = u8::from_str_radix(&pair, 16)
      .map_err(|_| format!("streamId invalido no byte {}.", i))?;
    out[i] = byte;
  }
  Ok(out)
}

fn stream_id_to_hex(stream_id: &[u8; 16]) -> String {
  let mut out = String::with_capacity(32);
  for byte in stream_id {
    out.push_str(&format!("{:02x}", byte));
  }
  out
}

fn normalize_options(options: StartUdpLanReceiverOptions) -> Result<NormalizedOptions, String> {
  let listen_host = options
    .listenHost
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| DEFAULT_LISTEN_HOST.to_string());

  let listen_port = options
    .listenPort
    .filter(|value| *value > 0)
    .unwrap_or(DEFAULT_LISTEN_PORT);

  let expected_stream_id = match options.streamId {
    Some(value) if !value.trim().is_empty() => Some(parse_stream_id_hex(&value)?),
    _ => None,
  };

  let max_frame_age_ms = options
    .maxFrameAgeMs
    .unwrap_or(DEFAULT_MAX_FRAME_AGE_MS)
    .clamp(5, 5000);

  let max_pending_frames = options
    .maxPendingFrames
    .unwrap_or(DEFAULT_MAX_PENDING_FRAMES)
    .clamp(2, 4096);

  let stats_interval_ms = options
    .statsIntervalMs
    .unwrap_or(DEFAULT_STATS_INTERVAL_MS)
    .clamp(250, 60_000);

  Ok(NormalizedOptions {
    listen_host,
    listen_port,
    expected_stream_id,
    max_frame_age_ms,
    max_pending_frames,
    stats_interval_ms,
  })
}

fn parse_udp_datagram(buf: &[u8]) -> Option<UdpDatagram> {
  if buf.len() < UDP_HEADER_SIZE {
    return None;
  }

  let magic = u16::from_be_bytes([buf[0], buf[1]]);
  let version = buf[2];
  if magic != UDP_MAGIC || version != UDP_VERSION {
    return None;
  }

  let flags = buf[3];
  let mut stream_id = [0u8; 16];
  stream_id.copy_from_slice(&buf[4..20]);
  let seq = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
  let timestamp_us = u64::from_be_bytes([
    buf[24], buf[25], buf[26], buf[27], buf[28], buf[29], buf[30], buf[31],
  ]);
  let chunk_index = u16::from_be_bytes([buf[32], buf[33]]);
  let total_chunks = u16::from_be_bytes([buf[34], buf[35]]);
  let payload_size = u16::from_be_bytes([buf[36], buf[37]]) as usize;

  if total_chunks == 0 {
    return None;
  }
  if chunk_index >= total_chunks {
    return None;
  }
  if buf.len() != UDP_HEADER_SIZE + payload_size {
    return None;
  }

  Some(UdpDatagram {
    stream_id,
    seq,
    timestamp_us,
    flags,
    chunk_index,
    total_chunks,
    payload: buf[UDP_HEADER_SIZE..].to_vec(),
  })
}

fn emit_error(app: &AppHandle, message: String) {
  let _ = app.emit("udp-lan-error", UdpLanErrorEvent { message });
}

fn emit_stopped(app: &AppHandle, reason: String) {
  let _ = app.emit("udp-lan-stopped", UdpLanStoppedEvent { reason });
}

fn emit_stats(
  app: &AppHandle,
  options: &NormalizedOptions,
  stats: &ReceiverStats,
  active_stream_id: Option<&[u8; 16]>,
  pending_frames: usize,
) {
  let elapsed_sec = stats.started_at.elapsed().as_secs_f64().max(0.001);
  let fps_assembled = stats.frames_completed as f64 / elapsed_sec;
  let bitrate_kbps = ((stats.bytes_reassembled as f64 * 8.0) / 1000.0) / elapsed_sec;
  let loss_pct = (stats.missing_chunks as f64
    / (stats.packets_accepted + stats.missing_chunks).max(1) as f64)
    * 100.0;

  let payload = UdpLanStatsEvent {
    streamId: active_stream_id.map(stream_id_to_hex),
    listenHost: options.listen_host.clone(),
    listenPort: options.listen_port,
    packetsReceived: stats.packets_received,
    packetsAccepted: stats.packets_accepted,
    packetsInvalid: stats.packets_invalid,
    packetsDuplicate: stats.packets_duplicate,
    packetsStreamMismatch: stats.packets_stream_mismatch,
    framesCompleted: stats.frames_completed,
    framesDroppedTimeout: stats.frames_dropped_timeout,
    framesDroppedQueue: stats.frames_dropped_queue,
    framesDroppedLate: stats.frames_dropped_late,
    framesDroppedGap: stats.frames_dropped_gap,
    missingChunks: stats.missing_chunks,
    lossPct: loss_pct,
    jitterMs: stats.jitter_ms,
    fpsAssembled: fps_assembled,
    bitrateKbps: bitrate_kbps,
    pendingFrames: pending_frames,
    remoteAddress: stats.remote_address.clone(),
    remotePort: stats.remote_port,
  };
  let _ = app.emit("udp-lan-stats", payload);
}

fn run_udp_receiver_loop(
  app: AppHandle,
  socket: UdpSocket,
  options: NormalizedOptions,
  feedback_route: Arc<Mutex<UdpLanFeedbackRoute>>,
  stop: Arc<AtomicBool>,
) {
  let mut stats = ReceiverStats::new();
  let mut buf = vec![0u8; 65536];
  let mut pending: BTreeMap<u32, PendingFrame> = BTreeMap::new();
  let mut active_stream_id: Option<[u8; 16]> = None;
  let mut last_delivered_seq: i64 = -1;
  let mut last_transit_us: Option<i128> = None;
  let mut last_stats_emit = Instant::now();

  while !stop.load(Ordering::Relaxed) {
    match socket.recv_from(&mut buf) {
      Ok((size, remote)) => {
        stats.packets_received += 1;
        let packet = match parse_udp_datagram(&buf[..size]) {
          Some(value) => value,
          None => {
            stats.packets_invalid += 1;
            continue;
          }
        };

        if let Some(expected) = options.expected_stream_id {
          if expected != packet.stream_id {
            stats.packets_stream_mismatch += 1;
            continue;
          }
        }

        match active_stream_id {
          Some(id) if id != packet.stream_id => {
            stats.packets_stream_mismatch += 1;
            continue;
          }
          None => {
            active_stream_id = Some(packet.stream_id);
          }
          _ => {}
        }

        if stats.remote_address.is_none() {
          stats.remote_address = Some(remote.ip().to_string());
          stats.remote_port = Some(remote.port());
        }

        if let Ok(mut route) = feedback_route.lock() {
          route.remote = Some(remote);
          route.active_stream_id = Some(packet.stream_id);
        }

        let arrival_us = now_us();
        let transit_us = arrival_us as i128 - packet.timestamp_us as i128;
        if let Some(previous) = last_transit_us {
          let d_ms = (transit_us - previous).abs() as f64 / 1000.0;
          stats.jitter_ms += (d_ms - stats.jitter_ms) / 16.0;
        }
        last_transit_us = Some(transit_us);

        if last_delivered_seq >= 0 && packet.seq <= last_delivered_seq as u32 {
          stats.frames_dropped_late += 1;
          continue;
        }

        let entry = pending.entry(packet.seq).or_insert_with(|| PendingFrame {
          seq: packet.seq,
          timestamp_us: packet.timestamp_us,
          flags: packet.flags,
          total_chunks: packet.total_chunks,
          chunks: vec![None; packet.total_chunks as usize],
          received_chunks: 0,
          first_arrival: Instant::now(),
        });

        if entry.total_chunks != packet.total_chunks {
          pending.remove(&packet.seq);
          stats.packets_invalid += 1;
          continue;
        }

        let chunk_index = packet.chunk_index as usize;
        if entry.chunks[chunk_index].is_some() {
          stats.packets_duplicate += 1;
          continue;
        }

        entry.chunks[chunk_index] = Some(packet.payload);
        entry.received_chunks += 1;
        stats.packets_accepted += 1;

        let completed = entry.received_chunks == entry.total_chunks;
        if completed {
          let frame = match pending.remove(&packet.seq) {
            Some(value) => value,
            None => continue,
          };

          if frame.seq <= last_delivered_seq as u32 && last_delivered_seq >= 0 {
            stats.frames_dropped_late += 1;
            continue;
          }

          if last_delivered_seq >= 0 && frame.seq > (last_delivered_seq as u32 + 1) {
            let gap = frame.seq as i64 - last_delivered_seq - 1;
            if gap > 0 {
              stats.seq_gap_frames += gap as u64;
            }
            let stale_keys: Vec<u32> = pending
              .keys()
              .copied()
              .filter(|seq| *seq < frame.seq)
              .collect();
            for key in stale_keys {
              if let Some(stale) = pending.remove(&key) {
                let missing = stale.total_chunks.saturating_sub(stale.received_chunks) as u64;
                stats.missing_chunks += missing;
                stats.frames_dropped_gap += 1;
              }
            }
          }

          let mut payload = Vec::new();
          let mut missing_chunks = 0u64;
          for chunk in frame.chunks {
            match chunk {
              Some(bytes) => payload.extend_from_slice(&bytes),
              None => missing_chunks += 1,
            }
          }
          if missing_chunks > 0 {
            stats.frames_dropped_timeout += 1;
            stats.missing_chunks += missing_chunks;
            continue;
          }

          let stream_id_hex = active_stream_id
            .as_ref()
            .map(stream_id_to_hex)
            .unwrap_or_else(|| "".to_string());
          let payload_len = payload.len();
          let frame_event = UdpLanFrameEvent {
            streamId: stream_id_hex,
            seq: frame.seq,
            timestampUs: frame.timestamp_us,
            flags: frame.flags,
            totalChunks: frame.total_chunks,
            receivedChunks: frame.received_chunks,
            payloadBytes: payload_len,
            payloadBase64: base64::engine::general_purpose::STANDARD.encode(&payload),
          };
          let _ = app.emit("udp-lan-frame", frame_event);

          stats.frames_completed += 1;
          if (frame.flags & 1) != 0 {
            stats.keyframes_completed += 1;
          }
          stats.bytes_reassembled += payload_len as u64;
          last_delivered_seq = frame.seq as i64;
        }
      }
      Err(error)
        if error.kind() == std::io::ErrorKind::WouldBlock
          || error.kind() == std::io::ErrorKind::TimedOut => {}
      Err(error) => {
        emit_error(&app, format!("falha no socket UDP: {}", error));
        break;
      }
    }

    let now = Instant::now();
    let timeout_keys: Vec<u32> = pending
      .iter()
      .filter_map(|(seq, frame)| {
        if now.duration_since(frame.first_arrival).as_millis() as u64 > options.max_frame_age_ms {
          Some(*seq)
        } else {
          None
        }
      })
      .collect();
    for key in timeout_keys {
      if let Some(stale) = pending.remove(&key) {
        let missing = stale.total_chunks.saturating_sub(stale.received_chunks) as u64;
        stats.missing_chunks += missing;
        stats.frames_dropped_timeout += 1;
      }
    }

    while pending.len() > options.max_pending_frames {
      let oldest = pending.keys().next().copied();
      if let Some(seq) = oldest {
        if let Some(stale) = pending.remove(&seq) {
          let missing = stale.total_chunks.saturating_sub(stale.received_chunks) as u64;
          stats.missing_chunks += missing;
          stats.frames_dropped_queue += 1;
        }
      } else {
        break;
      }
    }

    if last_stats_emit.elapsed().as_millis() as u64 >= options.stats_interval_ms {
      emit_stats(&app, &options, &stats, active_stream_id.as_ref(), pending.len());
      last_stats_emit = Instant::now();
    }
  }

  emit_stats(&app, &options, &stats, active_stream_id.as_ref(), pending.len());
  emit_stopped(&app, "stopped".to_string());
}

#[tauri::command]
pub fn start_udp_lan_receiver(app: AppHandle, options: StartUdpLanReceiverOptions) -> Result<(), String> {
  let normalized = normalize_options(options)?;
  let bind_addr = format!("{}:{}", normalized.listen_host, normalized.listen_port);
  let socket = UdpSocket::bind(&bind_addr)
    .map_err(|error| format!("falha ao bind UDP em {}: {}", bind_addr, error))?;
  socket
    .set_read_timeout(Some(Duration::from_millis(20)))
    .map_err(|error| format!("falha ao configurar timeout do socket UDP: {}", error))?;

  let feedback_socket = UdpSocket::bind("0.0.0.0:0")
    .map_err(|error| format!("falha ao criar socket de feedback UDP: {}", error))?;
  feedback_socket
    .set_write_timeout(Some(Duration::from_millis(200)))
    .map_err(|error| format!("falha ao configurar timeout do socket de feedback UDP: {}", error))?;

  let slot = receiver_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha ao adquirir lock do receiver UDP".to_string())?;
  if guard.is_some() {
    return Err("receiver UDP ja esta em execucao.".to_string());
  }

  let stop = Arc::new(AtomicBool::new(false));
  let stop_thread = stop.clone();
  let feedback_route = Arc::new(Mutex::new(UdpLanFeedbackRoute::default()));
  let feedback_route_thread = feedback_route.clone();
  let app_thread = app.clone();
  let options_thread = normalized.clone();
  let join = thread::spawn(move || {
    run_udp_receiver_loop(app_thread, socket, options_thread, feedback_route_thread, stop_thread);
  });

  *guard = Some(UdpLanReceiverHandle {
    stop,
    feedback_socket,
    feedback_route,
    join: Some(join),
  });

  Ok(())
}

#[tauri::command]
pub fn send_udp_lan_feedback(message: UdpLanFeedbackMessage) -> Result<(), String> {
  let message_type = message.message_type.trim().to_string();
  if message_type.is_empty() {
    return Err("type obrigatorio no feedback UDP.".to_string());
  }
  let token = message.token.trim().to_string();
  if token.is_empty() {
    return Err("token obrigatorio no feedback UDP.".to_string());
  }

  let slot = receiver_slot();
  let guard = slot
    .lock()
    .map_err(|_| "falha ao adquirir lock do receiver UDP".to_string())?;
  let handle = guard
    .as_ref()
    .ok_or_else(|| "receiver UDP nao esta em execucao.".to_string())?;

  let (remote, default_stream_id) = {
    let route_guard = handle
      .feedback_route
      .lock()
      .map_err(|_| "falha ao adquirir lock de rota de feedback UDP".to_string())?;
    (
      route_guard.remote,
      route_guard.active_stream_id.map(|id| stream_id_to_hex(&id)),
    )
  };

  let remote = remote.ok_or_else(|| "receiver UDP ainda nao possui remoto ativo.".to_string())?;
  let stream_id = message
    .streamId
    .as_ref()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .or(default_stream_id);
  let session_id = message
    .sessionId
    .as_ref()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
  let reason = message
    .reason
    .as_ref()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
  let payload = UdpLanFeedbackWireMessage {
    message_type: &message_type,
    version: message.version.unwrap_or(1),
    token: &token,
    sessionId: session_id.as_deref(),
    streamId: stream_id.as_deref(),
    lossPct: message.lossPct.map(|value| value.clamp(0.0, 100.0)),
    jitterMs: message.jitterMs.map(|value| value.clamp(0.0, 10_000.0)),
    freezeMs: message.freezeMs.map(|value| value.min(60_000)),
    requestedBitrateKbps: message
      .requestedBitrateKbps
      .map(|value| value.clamp(100, 500_000)),
    reason: reason.as_deref(),
    sentAtUs: now_us(),
  };
  let bytes =
    serde_json::to_vec(&payload).map_err(|error| format!("falha serializar feedback UDP: {}", error))?;
  handle
    .feedback_socket
    .send_to(&bytes, remote)
    .map_err(|error| format!("falha enviar feedback UDP para {}: {}", remote, error))?;
  Ok(())
}

#[tauri::command]
pub fn stop_udp_lan_receiver() -> Result<(), String> {
  let slot = receiver_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha ao adquirir lock do receiver UDP".to_string())?;
  let mut handle = match guard.take() {
    Some(value) => value,
    None => return Ok(()),
  };

  handle.stop.store(true, Ordering::Relaxed);
  if let Some(join) = handle.join.take() {
    let _ = join.join();
  }
  Ok(())
}
