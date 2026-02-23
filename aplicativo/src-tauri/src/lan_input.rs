use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const DEFAULT_BIND_HOST: &str = "0.0.0.0";
const DEFAULT_BIND_PORT: u16 = 5505;
const DEFAULT_EVENTS_PER_SEC: u32 = 700;
const DEFAULT_STATS_INTERVAL_MS: u64 = 1000;
const AUTH_TIMEOUT_MS: u64 = 5000;
const READ_TIMEOUT_MS: u64 = 20;
const CLIENT_CONNECT_TIMEOUT_MS: u64 = 3000;

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct StartLanInputServerOptions {
  pub bindHost: Option<String>,
  pub bindPort: Option<u16>,
  pub authToken: String,
  pub authExpiresAtMs: Option<u64>,
  pub sessionId: Option<String>,
  pub streamId: Option<String>,
  pub sessionActive: Option<bool>,
  pub maxEventsPerSecond: Option<u32>,
  pub statsIntervalMs: Option<u64>,
}

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
pub struct StartLanInputClientOptions {
  pub host: String,
  pub port: u16,
  pub authToken: String,
  pub sessionId: Option<String>,
  pub streamId: Option<String>,
  pub connectTimeoutMs: Option<u64>,
}

#[derive(Deserialize, Clone)]
#[allow(non_snake_case)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LanInputEvent {
  MouseMove { seq: u64, tsUs: u64, dx: i32, dy: i32 },
  MouseButton { seq: u64, tsUs: u64, button: u8, down: bool },
  MouseWheel { seq: u64, tsUs: u64, deltaX: i32, deltaY: i32 },
  Key {
    seq: u64,
    tsUs: u64,
    code: String,
    down: bool,
    ctrl: Option<bool>,
    alt: Option<bool>,
    shift: Option<bool>,
    meta: Option<bool>,
  },
  DisconnectHotkey { seq: u64, tsUs: u64 },
}

#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
struct ServerStatsEvent {
  active: bool,
  bindHost: String,
  bindPort: u16,
  authenticatedClients: u64,
  authFailures: u64,
  eventsReceived: u64,
  eventsInjected: u64,
  eventsDroppedRate: u64,
  eventsDroppedInactive: u64,
  injectErrors: u64,
  mouseMoves: u64,
  mouseButtons: u64,
  mouseWheels: u64,
  keyEvents: u64,
  disconnectHotkeys: u64,
  eventsPerSecLimit: u32,
}

#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
struct ServerStatusEvent {
  active: bool,
  message: String,
}

#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
struct ClientStatusEvent {
  connected: bool,
  host: String,
  port: u16,
  message: String,
}

#[derive(Clone, Serialize)]
#[allow(non_snake_case)]
struct LanInputErrorEvent {
  message: String,
}

#[derive(Default)]
struct SharedServerStats {
  authenticated_clients: u64,
  auth_failures: u64,
  events_received: u64,
  events_injected: u64,
  events_dropped_rate: u64,
  events_dropped_inactive: u64,
  inject_errors: u64,
  mouse_moves: u64,
  mouse_buttons: u64,
  mouse_wheels: u64,
  key_events: u64,
  disconnect_hotkeys: u64,
}

#[derive(Deserialize)]
#[allow(dead_code, non_snake_case)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
  Auth {
    token: String,
    sessionId: Option<String>,
    streamId: Option<String>,
    version: Option<u8>,
  },
  MouseMove {
    seq: u64,
    tsUs: u64,
    dx: i32,
    dy: i32,
  },
  MouseButton {
    seq: u64,
    tsUs: u64,
    button: u8,
    down: bool,
  },
  MouseWheel {
    seq: u64,
    tsUs: u64,
    deltaX: i32,
    deltaY: i32,
  },
  Key {
    seq: u64,
    tsUs: u64,
    code: String,
    down: bool,
    ctrl: Option<bool>,
    alt: Option<bool>,
    shift: Option<bool>,
    meta: Option<bool>,
  },
  DisconnectHotkey {
    seq: u64,
    tsUs: u64,
  },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage<'a> {
  AuthOk,
  AuthError { reason: &'a str },
}

#[derive(Serialize)]
#[allow(non_snake_case)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientWireMessage<'a> {
  Auth {
    token: &'a str,
    sessionId: Option<&'a str>,
    streamId: Option<&'a str>,
    version: u8,
  },
  MouseMove {
    seq: u64,
    tsUs: u64,
    dx: i32,
    dy: i32,
  },
  MouseButton {
    seq: u64,
    tsUs: u64,
    button: u8,
    down: bool,
  },
  MouseWheel {
    seq: u64,
    tsUs: u64,
    deltaX: i32,
    deltaY: i32,
  },
  Key {
    seq: u64,
    tsUs: u64,
    code: &'a str,
    down: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
  },
  DisconnectHotkey { seq: u64, tsUs: u64 },
}

struct ServerConfig {
  bind_host: String,
  bind_port: u16,
  auth_token: String,
  auth_expires_at_ms: Option<u64>,
  session_id: Option<String>,
  stream_id: Option<String>,
  max_events_per_second: u32,
  stats_interval_ms: u64,
}

struct LanInputServerHandle {
  stop: Arc<AtomicBool>,
  session_active: Arc<AtomicBool>,
  join: Option<JoinHandle<()>>,
}

struct LanInputClientHandle {
  sender: mpsc::Sender<String>,
  stop: Arc<AtomicBool>,
  join: Option<JoinHandle<()>>,
  host: String,
  port: u16,
}

static LAN_INPUT_SERVER: OnceLock<Mutex<Option<LanInputServerHandle>>> = OnceLock::new();
static LAN_INPUT_CLIENT: OnceLock<Mutex<Option<LanInputClientHandle>>> = OnceLock::new();

fn server_slot() -> &'static Mutex<Option<LanInputServerHandle>> {
  LAN_INPUT_SERVER.get_or_init(|| Mutex::new(None))
}

fn client_slot() -> &'static Mutex<Option<LanInputClientHandle>> {
  LAN_INPUT_CLIENT.get_or_init(|| Mutex::new(None))
}

fn now_us() -> u64 {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_else(|_| Duration::from_secs(0));
  now.as_micros().try_into().unwrap_or(0)
}

fn now_ms() -> u64 {
  let now = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_else(|_| Duration::from_secs(0));
  now.as_millis().try_into().unwrap_or(0)
}

fn emit_server_status(app: &AppHandle, active: bool, message: String) {
  let _ = app.emit("lan-input-server-status", ServerStatusEvent { active, message });
}

fn emit_client_status(app: &AppHandle, connected: bool, host: String, port: u16, message: String) {
  let _ = app.emit(
    "lan-input-client-status",
    ClientStatusEvent {
      connected,
      host,
      port,
      message,
    },
  );
}

fn emit_error(app: &AppHandle, message: String) {
  let _ = app.emit("lan-input-error", LanInputErrorEvent { message });
}

fn normalize_server_config(options: StartLanInputServerOptions) -> Result<(ServerConfig, bool), String> {
  let bind_host = options
    .bindHost
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty())
    .unwrap_or_else(|| DEFAULT_BIND_HOST.to_string());
  let bind_port = options.bindPort.unwrap_or(DEFAULT_BIND_PORT);
  if bind_port == 0 {
    return Err("bindPort invalido.".to_string());
  }

  let auth_token = options.authToken.trim().to_string();
  if auth_token.is_empty() {
    return Err("authToken obrigatorio.".to_string());
  }
  let auth_expires_at_ms = options.authExpiresAtMs.filter(|value| *value > 0);
  if let Some(expires_at_ms) = auth_expires_at_ms {
    if expires_at_ms <= now_ms() {
      return Err("authToken expirado.".to_string());
    }
  }

  let session_id = options
    .sessionId
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());
  let stream_id = options
    .streamId
    .map(|v| v.trim().to_string())
    .filter(|v| !v.is_empty());
  let max_events_per_second = options
    .maxEventsPerSecond
    .unwrap_or(DEFAULT_EVENTS_PER_SEC)
    .clamp(60, 5000);
  let stats_interval_ms = options
    .statsIntervalMs
    .unwrap_or(DEFAULT_STATS_INTERVAL_MS)
    .clamp(250, 60_000);
  let session_active = options.sessionActive.unwrap_or(false);

  Ok((
    ServerConfig {
      bind_host,
      bind_port,
      auth_token,
      auth_expires_at_ms,
      session_id,
      stream_id,
      max_events_per_second,
      stats_interval_ms,
    },
    session_active,
  ))
}

fn normalize_client_options(options: StartLanInputClientOptions) -> Result<StartLanInputClientOptions, String> {
  let host = options.host.trim().to_string();
  if host.is_empty() {
    return Err("host obrigatorio no input client.".to_string());
  }
  if options.port == 0 {
    return Err("port invalida no input client.".to_string());
  }
  if options.authToken.trim().is_empty() {
    return Err("authToken obrigatorio no input client.".to_string());
  }
  Ok(StartLanInputClientOptions {
    host,
    port: options.port,
    authToken: options.authToken.trim().to_string(),
    sessionId: options
      .sessionId
      .map(|v| v.trim().to_string())
      .filter(|v| !v.is_empty()),
    streamId: options
      .streamId
      .map(|v| v.trim().to_string())
      .filter(|v| !v.is_empty()),
    connectTimeoutMs: options.connectTimeoutMs,
  })
}

fn write_json_line<T: Serialize>(stream: &mut TcpStream, value: &T) -> Result<(), String> {
  let text = serde_json::to_string(value).map_err(|e| format!("json serialize fail: {}", e))?;
  stream
    .write_all(text.as_bytes())
    .map_err(|e| format!("write fail: {}", e))?;
  stream
    .write_all(b"\n")
    .map_err(|e| format!("write fail: {}", e))?;
  stream.flush().map_err(|e| format!("flush fail: {}", e))
}

fn parse_json_line(line: &str) -> Result<ClientMessage, String> {
  serde_json::from_str::<ClientMessage>(line).map_err(|e| format!("json invalido: {}", e))
}

fn should_reset_rate_window(window_start: Instant) -> bool {
  window_start.elapsed().as_secs_f64() >= 1.0
}

#[cfg(windows)]
mod injector {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_WHEEL, MOUSEINPUT, VK_BACK, VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE,
    VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4, VK_F5, VK_F6, VK_F7, VK_F8, VK_F9,
    VK_HOME, VK_INSERT, VK_LEFT, VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT,
    VK_SPACE, VK_TAB, VK_UP,
  };

  fn send_input(input: &mut INPUT) -> bool {
    unsafe { SendInput(1, input as *const INPUT, std::mem::size_of::<INPUT>() as i32) == 1 }
  }

  pub fn inject_mouse_move(dx: i32, dy: i32) -> Result<(), String> {
    let mut input = INPUT {
      r#type: INPUT_MOUSE,
      Anonymous: INPUT_0 {
        mi: MOUSEINPUT {
          dx,
          dy,
          mouseData: 0,
          dwFlags: MOUSEEVENTF_MOVE,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
    if send_input(&mut input) {
      Ok(())
    } else {
      Err("SendInput falhou em mouse_move".to_string())
    }
  }

  pub fn inject_mouse_button(button: u8, down: bool) -> Result<(), String> {
    let flag = match (button, down) {
      (0, true) => MOUSEEVENTF_LEFTDOWN,
      (0, false) => MOUSEEVENTF_LEFTUP,
      (1, true) => MOUSEEVENTF_MIDDLEDOWN,
      (1, false) => MOUSEEVENTF_MIDDLEUP,
      (2, true) => MOUSEEVENTF_RIGHTDOWN,
      (2, false) => MOUSEEVENTF_RIGHTUP,
      _ => return Ok(()),
    };

    let mut input = INPUT {
      r#type: INPUT_MOUSE,
      Anonymous: INPUT_0 {
        mi: MOUSEINPUT {
          dx: 0,
          dy: 0,
          mouseData: 0,
          dwFlags: flag,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
    if send_input(&mut input) {
      Ok(())
    } else {
      Err("SendInput falhou em mouse_button".to_string())
    }
  }

  pub fn inject_mouse_wheel(delta_x: i32, delta_y: i32) -> Result<(), String> {
    if delta_y != 0 {
      let mut input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
          mi: MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: delta_y as u32,
            dwFlags: MOUSEEVENTF_WHEEL,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      };
      if !send_input(&mut input) {
        return Err("SendInput falhou em mouse_wheel vertical".to_string());
      }
    }
    if delta_x != 0 {
      let mut input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
          mi: MOUSEINPUT {
            dx: 0,
            dy: 0,
            mouseData: delta_x as u32,
            dwFlags: MOUSEEVENTF_HWHEEL,
            time: 0,
            dwExtraInfo: 0,
          },
        },
      };
      if !send_input(&mut input) {
        return Err("SendInput falhou em mouse_wheel horizontal".to_string());
      }
    }
    Ok(())
  }

  fn map_code_to_vk(code: &str) -> Option<u16> {
    let code = code.trim();
    if let Some(rest) = code.strip_prefix("Key") {
      if rest.len() == 1 {
        let c = rest.as_bytes()[0];
        if c.is_ascii_uppercase() {
          return Some(c as u16);
        }
      }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
      if rest.len() == 1 {
        let c = rest.as_bytes()[0];
        if c.is_ascii_digit() {
          return Some(c as u16);
        }
      }
    }

    let vk = match code {
      "Escape" => VK_ESCAPE,
      "Enter" => VK_RETURN,
      "Backspace" => VK_BACK,
      "Tab" => VK_TAB,
      "Space" => VK_SPACE,
      "ArrowUp" => VK_UP,
      "ArrowDown" => VK_DOWN,
      "ArrowLeft" => VK_LEFT,
      "ArrowRight" => VK_RIGHT,
      "Home" => VK_HOME,
      "End" => VK_END,
      "PageUp" => VK_PRIOR,
      "PageDown" => VK_NEXT,
      "Insert" => VK_INSERT,
      "Delete" => VK_DELETE,
      "ShiftLeft" | "ShiftRight" => VK_SHIFT,
      "ControlLeft" | "ControlRight" => VK_CONTROL,
      "AltLeft" | "AltRight" => VK_MENU,
      "F1" => VK_F1,
      "F2" => VK_F2,
      "F3" => VK_F3,
      "F4" => VK_F4,
      "F5" => VK_F5,
      "F6" => VK_F6,
      "F7" => VK_F7,
      "F8" => VK_F8,
      "F9" => VK_F9,
      "F10" => VK_F10,
      "F11" => VK_F11,
      "F12" => VK_F12,
      _ => 0,
    };
    if vk == 0 {
      None
    } else {
      Some(vk as u16)
    }
  }

  pub fn inject_key(code: &str, down: bool) -> Result<(), String> {
    let vk = match map_code_to_vk(code) {
      Some(v) => v,
      None => return Ok(()),
    };
    let flags = if down { 0 } else { KEYEVENTF_KEYUP };
    let mut input = INPUT {
      r#type: INPUT_KEYBOARD,
      Anonymous: INPUT_0 {
        ki: KEYBDINPUT {
          wVk: vk,
          wScan: 0,
          dwFlags: flags,
          time: 0,
          dwExtraInfo: 0,
        },
      },
    };
    if send_input(&mut input) {
      Ok(())
    } else {
      Err("SendInput falhou em key".to_string())
    }
  }
}

#[cfg(not(windows))]
mod injector {
  pub fn inject_mouse_move(_: i32, _: i32) -> Result<(), String> {
    Err("SendInput disponivel apenas no Windows.".to_string())
  }
  pub fn inject_mouse_button(_: u8, _: bool) -> Result<(), String> {
    Err("SendInput disponivel apenas no Windows.".to_string())
  }
  pub fn inject_mouse_wheel(_: i32, _: i32) -> Result<(), String> {
    Err("SendInput disponivel apenas no Windows.".to_string())
  }
  pub fn inject_key(_: &str, _: bool) -> Result<(), String> {
    Err("SendInput disponivel apenas no Windows.".to_string())
  }
}

fn handle_input_event(
  event: ClientMessage,
  session_active: &Arc<AtomicBool>,
  stats: &Arc<Mutex<SharedServerStats>>,
) {
  let mut guard = match stats.lock() {
    Ok(v) => v,
    Err(_) => return,
  };
  guard.events_received += 1;

  if !session_active.load(Ordering::Relaxed) {
    guard.events_dropped_inactive += 1;
    return;
  }

  let injected = match event {
    ClientMessage::MouseMove { dx, dy, .. } => {
      guard.mouse_moves += 1;
      injector::inject_mouse_move(dx.clamp(-300, 300), dy.clamp(-300, 300))
    }
    ClientMessage::MouseButton { button, down, .. } => {
      guard.mouse_buttons += 1;
      injector::inject_mouse_button(button, down)
    }
    ClientMessage::MouseWheel { deltaX, deltaY, .. } => {
      guard.mouse_wheels += 1;
      injector::inject_mouse_wheel(deltaX.clamp(-960, 960), deltaY.clamp(-960, 960))
    }
    ClientMessage::Key { code, down, .. } => {
      guard.key_events += 1;
      injector::inject_key(&code, down)
    }
    ClientMessage::DisconnectHotkey { .. } => {
      guard.disconnect_hotkeys += 1;
      Ok(())
    }
    ClientMessage::Auth { .. } => Ok(()),
  };

  if injected.is_ok() {
    guard.events_injected += 1;
  } else {
    guard.inject_errors += 1;
  }
}

fn handle_client_connection(
  app: AppHandle,
  mut stream: TcpStream,
  config: Arc<ServerConfig>,
  stop: Arc<AtomicBool>,
  session_active: Arc<AtomicBool>,
  stats: Arc<Mutex<SharedServerStats>>,
) {
  let _ = stream.set_nodelay(true);
  let _ = stream.set_read_timeout(Some(Duration::from_millis(AUTH_TIMEOUT_MS)));
  let cloned = match stream.try_clone() {
    Ok(v) => v,
    Err(_) => return,
  };
  let mut reader = BufReader::new(cloned);

  let mut line = String::new();
  let auth_msg = loop {
    if stop.load(Ordering::Relaxed) {
      return;
    }
    line.clear();
    match reader.read_line(&mut line) {
      Ok(0) => return,
      Ok(_) => match parse_json_line(line.trim()) {
        Ok(ClientMessage::Auth {
          token,
          sessionId,
          streamId,
          ..
        }) => break (token, sessionId, streamId),
        Ok(_) => {
          let _ = write_json_line(&mut stream, &ServerMessage::AuthError { reason: "expected_auth" });
          return;
        }
        Err(_) => {
          let _ = write_json_line(&mut stream, &ServerMessage::AuthError { reason: "invalid_auth_json" });
          return;
        }
      },
      Err(error)
        if error.kind() == std::io::ErrorKind::WouldBlock
          || error.kind() == std::io::ErrorKind::TimedOut =>
      {
        continue;
      }
      Err(_) => return,
    }
  };

  let (token, session_id, stream_id) = auth_msg;
  let token_ok = token == config.auth_token;
  let token_expired = match config.auth_expires_at_ms {
    Some(expires_at_ms) => now_ms() > expires_at_ms,
    None => false,
  };
  let session_ok = match (&config.session_id, session_id.as_ref()) {
    (Some(expected), Some(provided)) => expected == provided,
    (Some(_), None) => false,
    _ => true,
  };
  let stream_ok = match (&config.stream_id, stream_id.as_ref()) {
    (Some(expected), Some(provided)) => expected == provided,
    (Some(_), None) => false,
    _ => true,
  };
  let active_ok = session_active.load(Ordering::Relaxed);

  if !(token_ok && !token_expired && session_ok && stream_ok && active_ok) {
    if let Ok(mut guard) = stats.lock() {
      guard.auth_failures += 1;
    }
    let reason = if token_expired {
      "token_expired"
    } else if !token_ok {
      "invalid_token"
    } else if !session_ok {
      "invalid_session"
    } else if !stream_ok {
      "invalid_stream"
    } else {
      "session_inactive"
    };
    let _ = write_json_line(&mut stream, &ServerMessage::AuthError { reason });
    return;
  }

  if let Ok(mut guard) = stats.lock() {
    guard.authenticated_clients += 1;
  }
  let _ = write_json_line(&mut stream, &ServerMessage::AuthOk);
  let _ = stream.set_read_timeout(Some(Duration::from_millis(READ_TIMEOUT_MS)));

  let mut rate_window_start = Instant::now();
  let mut rate_events: u32 = 0;
  line.clear();

  loop {
    if stop.load(Ordering::Relaxed) {
      break;
    }
    if should_reset_rate_window(rate_window_start) {
      rate_window_start = Instant::now();
      rate_events = 0;
    }

    line.clear();
    match reader.read_line(&mut line) {
      Ok(0) => break,
      Ok(_) => {
        let msg = match parse_json_line(line.trim()) {
          Ok(v) => v,
          Err(_) => continue,
        };
        if matches!(msg, ClientMessage::Auth { .. }) {
          continue;
        }

        if rate_events >= config.max_events_per_second {
          if let Ok(mut guard) = stats.lock() {
            guard.events_dropped_rate += 1;
          }
          continue;
        }
        rate_events += 1;
        handle_input_event(msg, &session_active, &stats);
      }
      Err(error)
        if error.kind() == std::io::ErrorKind::WouldBlock
          || error.kind() == std::io::ErrorKind::TimedOut =>
      {
        continue;
      }
      Err(_) => break,
    }
  }

  let _ = app.emit(
    "lan-input-server-status",
    ServerStatusEvent {
      active: true,
      message: "Cliente de input desconectou.".to_string(),
    },
  );
}

fn run_server_loop(
  app: AppHandle,
  listener: TcpListener,
  config: Arc<ServerConfig>,
  stop: Arc<AtomicBool>,
  session_active: Arc<AtomicBool>,
) {
  let _ = listener.set_nonblocking(true);
  let stats = Arc::new(Mutex::new(SharedServerStats::default()));
  let mut stats_last = Instant::now();
  let mut workers: BTreeMap<u64, JoinHandle<()>> = BTreeMap::new();
  let mut worker_id: u64 = 0;

  while !stop.load(Ordering::Relaxed) {
    match listener.accept() {
      Ok((stream, _addr)) => {
        let app_conn = app.clone();
        let cfg_conn = config.clone();
        let stop_conn = stop.clone();
        let active_conn = session_active.clone();
        let stats_conn = stats.clone();
        let join = thread::spawn(move || {
          handle_client_connection(app_conn, stream, cfg_conn, stop_conn, active_conn, stats_conn);
        });
        worker_id = worker_id.wrapping_add(1);
        workers.insert(worker_id, join);
      }
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
      Err(error) => {
        emit_error(&app, format!("erro no listener LAN input: {}", error));
      }
    }

    if stats_last.elapsed().as_millis() as u64 >= config.stats_interval_ms {
      if let Ok(guard) = stats.lock() {
        let payload = ServerStatsEvent {
          active: true,
          bindHost: config.bind_host.clone(),
          bindPort: config.bind_port,
          authenticatedClients: guard.authenticated_clients,
          authFailures: guard.auth_failures,
          eventsReceived: guard.events_received,
          eventsInjected: guard.events_injected,
          eventsDroppedRate: guard.events_dropped_rate,
          eventsDroppedInactive: guard.events_dropped_inactive,
          injectErrors: guard.inject_errors,
          mouseMoves: guard.mouse_moves,
          mouseButtons: guard.mouse_buttons,
          mouseWheels: guard.mouse_wheels,
          keyEvents: guard.key_events,
          disconnectHotkeys: guard.disconnect_hotkeys,
          eventsPerSecLimit: config.max_events_per_second,
        };
        let _ = app.emit("lan-input-server-stats", payload);
      }
      stats_last = Instant::now();
    }

    thread::sleep(Duration::from_millis(5));
  }

  for (_id, join) in workers {
    let _ = join.join();
  }
  emit_server_status(&app, false, "Servidor input LAN encerrado.".to_string());
}

fn serialize_client_event(event: &LanInputEvent) -> Result<String, String> {
  let payload = match event {
    LanInputEvent::MouseMove { seq, tsUs, dx, dy } => ClientWireMessage::MouseMove {
      seq: *seq,
      tsUs: *tsUs,
      dx: (*dx).clamp(-1000, 1000),
      dy: (*dy).clamp(-1000, 1000),
    },
    LanInputEvent::MouseButton { seq, tsUs, button, down } => ClientWireMessage::MouseButton {
      seq: *seq,
      tsUs: *tsUs,
      button: *button,
      down: *down,
    },
    LanInputEvent::MouseWheel {
      seq,
      tsUs,
      deltaX,
      deltaY,
    } => ClientWireMessage::MouseWheel {
      seq: *seq,
      tsUs: *tsUs,
      deltaX: (*deltaX).clamp(-960, 960),
      deltaY: (*deltaY).clamp(-960, 960),
    },
    LanInputEvent::Key {
      seq,
      tsUs,
      code,
      down,
      ctrl,
      alt,
      shift,
      meta,
    } => ClientWireMessage::Key {
      seq: *seq,
      tsUs: *tsUs,
      code,
      down: *down,
      ctrl: ctrl.unwrap_or(false),
      alt: alt.unwrap_or(false),
      shift: shift.unwrap_or(false),
      meta: meta.unwrap_or(false),
    },
    LanInputEvent::DisconnectHotkey { seq, tsUs } => ClientWireMessage::DisconnectHotkey {
      seq: *seq,
      tsUs: *tsUs,
    },
  };
  serde_json::to_string(&payload).map_err(|e| format!("falha serializar evento input: {}", e))
}

#[tauri::command]
pub fn start_lan_input_server(app: AppHandle, options: StartLanInputServerOptions) -> Result<(), String> {
  let (config, initial_active) = normalize_server_config(options)?;
  let bind_addr = format!("{}:{}", config.bind_host, config.bind_port);
  let listener =
    TcpListener::bind(&bind_addr).map_err(|e| format!("falha bind input server em {}: {}", bind_addr, e))?;

  let slot = server_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha lock no servidor de input".to_string())?;
  if guard.is_some() {
    return Err("servidor de input LAN ja esta em execucao.".to_string());
  }

  let stop = Arc::new(AtomicBool::new(false));
  let session_active = Arc::new(AtomicBool::new(initial_active));
  let config_arc = Arc::new(config);

  let app_thread = app.clone();
  let cfg_thread = config_arc.clone();
  let stop_thread = stop.clone();
  let active_thread = session_active.clone();
  let join = thread::spawn(move || {
    run_server_loop(app_thread, listener, cfg_thread, stop_thread, active_thread);
  });

  *guard = Some(LanInputServerHandle {
    stop,
    session_active,
    join: Some(join),
  });
  emit_server_status(
    &app,
    true,
    format!(
      "Servidor input LAN ativo em {}:{}",
      config_arc.bind_host, config_arc.bind_port
    ),
  );
  Ok(())
}

#[tauri::command]
pub fn stop_lan_input_server(app: AppHandle) -> Result<(), String> {
  let slot = server_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha lock no servidor de input".to_string())?;
  let mut handle = match guard.take() {
    Some(h) => h,
    None => return Ok(()),
  };

  handle.stop.store(true, Ordering::Relaxed);
  if let Some(join) = handle.join.take() {
    let _ = join.join();
  }
  emit_server_status(&app, false, "Servidor input LAN parado.".to_string());
  Ok(())
}

#[tauri::command]
pub fn set_lan_input_server_session_active(active: bool) -> Result<(), String> {
  let slot = server_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha lock no servidor de input".to_string())?;
  if let Some(handle) = guard.as_mut() {
    handle.session_active.store(active, Ordering::Relaxed);
    Ok(())
  } else {
    Err("servidor input LAN nao esta ativo.".to_string())
  }
}

#[tauri::command]
pub fn start_lan_input_client(app: AppHandle, options: StartLanInputClientOptions) -> Result<(), String> {
  let options = normalize_client_options(options)?;
  let slot = client_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha lock no cliente de input".to_string())?;
  if guard.is_some() {
    return Err("cliente de input LAN ja esta conectado.".to_string());
  }

  let addr = format!("{}:{}", options.host, options.port);
  let timeout_ms = options.connectTimeoutMs.unwrap_or(CLIENT_CONNECT_TIMEOUT_MS).clamp(500, 10_000);
  let stream = TcpStream::connect(&addr).map_err(|e| format!("falha conectar input server {}: {}", addr, e))?;
  let _ = stream.set_read_timeout(Some(Duration::from_millis(timeout_ms)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(timeout_ms)));
  let _ = stream.set_nodelay(true);

  let mut writer = stream
    .try_clone()
    .map_err(|e| format!("falha clonar stream input: {}", e))?;
  let auth = ClientWireMessage::Auth {
    token: &options.authToken,
    sessionId: options.sessionId.as_deref(),
    streamId: options.streamId.as_deref(),
    version: 1,
  };
  write_json_line(&mut writer, &auth)?;

  let mut reader = BufReader::new(stream);
  let mut line = String::new();
  match reader.read_line(&mut line) {
    Ok(0) => return Err("input server fechou conexao durante auth.".to_string()),
    Ok(_) => {}
    Err(e) => return Err(format!("falha ao ler auth do input server: {}", e)),
  }

  let auth_response: serde_json::Value =
    serde_json::from_str(line.trim()).map_err(|e| format!("auth response invalida: {}", e))?;
  let auth_type = auth_response.get("type").and_then(|v| v.as_str()).unwrap_or("");
  if auth_type != "auth_ok" {
    let reason = auth_response
      .get("reason")
      .and_then(|v| v.as_str())
      .unwrap_or("unknown");
    return Err(format!("input auth recusado: {}", reason));
  }

  let (tx, rx) = mpsc::channel::<String>();
  let stop = Arc::new(AtomicBool::new(false));
  let stop_thread = stop.clone();
  let host = options.host.clone();
  let port = options.port;
  let app_thread = app.clone();
  let join = thread::spawn(move || {
    let mut writer = writer;
    let mut last_ping = Instant::now();
    loop {
      if stop_thread.load(Ordering::Relaxed) {
        break;
      }

      match rx.recv_timeout(Duration::from_millis(20)) {
        Ok(line) => {
          if writer.write_all(line.as_bytes()).is_err() {
            emit_error(&app_thread, "input client: falha write no socket.".to_string());
            break;
          }
          if writer.write_all(b"\n").is_err() {
            emit_error(&app_thread, "input client: falha write newline.".to_string());
            break;
          }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {}
        Err(mpsc::RecvTimeoutError::Disconnected) => break,
      }

      if last_ping.elapsed().as_secs_f64() > 5.0 {
        let ping = serde_json::json!({
          "type": "ping",
          "tsUs": now_us(),
        });
        if let Ok(text) = serde_json::to_string(&ping) {
          if writer.write_all(text.as_bytes()).is_err() || writer.write_all(b"\n").is_err() {
            emit_error(&app_thread, "input client: conexao interrompida.".to_string());
            break;
          }
        }
        last_ping = Instant::now();
      }
    }

    emit_client_status(
      &app_thread,
      false,
      host.clone(),
      port,
      "Cliente input LAN desconectado.".to_string(),
    );
  });

  *guard = Some(LanInputClientHandle {
    sender: tx,
    stop,
    join: Some(join),
    host: options.host.clone(),
    port: options.port,
  });

  emit_client_status(
    &app,
    true,
    options.host,
    options.port,
    "Cliente input LAN conectado.".to_string(),
  );
  Ok(())
}

#[tauri::command]
pub fn send_lan_input_event(event: LanInputEvent) -> Result<(), String> {
  let slot = client_slot();
  let guard = slot
    .lock()
    .map_err(|_| "falha lock no cliente de input".to_string())?;
  let handle = guard
    .as_ref()
    .ok_or_else(|| "cliente input LAN nao esta conectado.".to_string())?;

  let line = serialize_client_event(&event)?;
  handle
    .sender
    .send(line)
    .map_err(|_| "falha enviar evento para thread de input client.".to_string())?;
  Ok(())
}

#[tauri::command]
pub fn stop_lan_input_client(app: AppHandle) -> Result<(), String> {
  let slot = client_slot();
  let mut guard = slot
    .lock()
    .map_err(|_| "falha lock no cliente de input".to_string())?;
  let mut handle = match guard.take() {
    Some(v) => v,
    None => return Ok(()),
  };
  handle.stop.store(true, Ordering::Relaxed);
  let _ = handle.sender.send("{}".to_string());
  if let Some(join) = handle.join.take() {
    let _ = join.join();
  }
  emit_client_status(
    &app,
    false,
    handle.host,
    handle.port,
    "Cliente input LAN parado.".to_string(),
  );
  Ok(())
}
