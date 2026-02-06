#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Manager;
use serde::Serialize;

#[tauri::command]
fn validate_exe_path(path: String) -> bool {
  if !cfg!(windows) {
    return false;
  }
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return false;
  }
  let lower = trimmed.to_lowercase();
  if !lower.ends_with(".exe") {
    return false;
  }
  Path::new(trimmed).is_file()
}

#[tauri::command]
fn detect_sunshine_path() -> Option<String> {
  detect_path("sunshine", "Sunshine", "sunshine.exe")
}

#[tauri::command]
fn detect_moonlight_path() -> Option<String> {
  detect_path("moonlight", "Moonlight Game Streaming", "Moonlight.exe")
}

fn detect_path(binary: &str, folder: &str, exe: &str) -> Option<String> {
  if !cfg!(windows) {
    return None;
  }
  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Ok(program_files) = std::env::var("ProgramFiles") {
    candidates.push(PathBuf::from(program_files).join(folder).join(exe));
  }
  if let Ok(program_files_x86) = std::env::var("ProgramFiles(x86)") {
    candidates.push(PathBuf::from(program_files_x86).join(folder).join(exe));
  }
  candidates.push(PathBuf::from(format!(r"C:\Program Files\{}\{}", folder, exe)));
  candidates.push(PathBuf::from(format!(r"C:\Program Files (x86)\{}\{}", folder, exe)));

  if let Some(found) = first_existing(&candidates) {
    return Some(found);
  }

  if let Ok(output) = std::process::Command::new("where").arg(binary).output() {
    if output.status.success() {
      let stdout = String::from_utf8_lossy(&output.stdout);
      if let Some(line) = stdout.lines().next() {
        let trimmed = line.trim().trim_matches('"');
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
          return Some(trimmed.to_string());
        }
      }
    }
  }

  None
}

fn first_existing(paths: &[PathBuf]) -> Option<String> {
  for path in paths {
    if path.is_file() {
      return Some(path.to_string_lossy().to_string());
    }
  }
  None
}

#[tauri::command]
fn start_sunshine(path: String) -> Result<(), String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  std::process::Command::new(trimmed)
    .spawn()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn start_moonlight(path: String, address: String) -> Result<(), String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  let addr = address.trim();
  if addr.is_empty() {
    return Err("endereco vazio".to_string());
  }
  std::process::Command::new(trimmed)
    .arg(addr)
    .spawn()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[derive(Serialize)]
struct CommandOutput {
  code: i32,
  stdout: String,
  stderr: String,
}

#[derive(Serialize)]
struct OAuthCallbackPayload {
  code: Option<String>,
  state: Option<String>,
  error: Option<String>,
}

static OAUTH_LISTENER_ACTIVE: AtomicBool = AtomicBool::new(false);

fn percent_decode(input: &str) -> String {
  let bytes = input.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    match bytes[i] {
      b'%' if i + 2 < bytes.len() => {
        let hex = &input[i + 1..i + 3];
        if let Ok(value) = u8::from_str_radix(hex, 16) {
          out.push(value);
          i += 3;
          continue;
        }
        out.push(bytes[i]);
      }
      b'+' => out.push(b' '),
      _ => out.push(bytes[i]),
    }
    i += 1;
  }
  String::from_utf8_lossy(&out).to_string()
}

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
  let mut map = std::collections::HashMap::new();
  for pair in query.split('&') {
    if pair.is_empty() {
      continue;
    }
    let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
    map.insert(percent_decode(key), percent_decode(value));
  }
  map
}

fn wait_for_oauth_callback(port: u16) -> OAuthCallbackPayload {
  let addr = format!("127.0.0.1:{}", port);
  let listener = match TcpListener::bind(&addr) {
    Ok(listener) => listener,
    Err(error) => {
      return OAuthCallbackPayload {
        code: None,
        state: None,
        error: Some(format!("Falha ao abrir listener: {}", error)),
      };
    }
  };

  let _ = listener.set_nonblocking(true);
  let deadline = Instant::now() + Duration::from_secs(300);

  loop {
    match listener.accept() {
      Ok((mut stream, _)) => {
        let mut buffer = [0u8; 4096];
        let _ = stream.read(&mut buffer);
        let request = String::from_utf8_lossy(&buffer);
        let first_line = request.lines().next().unwrap_or("");
        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut error: Option<String> = None;

        if let Some(path) = first_line.split_whitespace().nth(1) {
          let (path_only, query) = path.split_once('?').unwrap_or((path, ""));
          if path_only.contains("/auth/google/callback") {
            let params = parse_query(query);
            code = params.get("code").cloned();
            state = params.get("state").cloned();
            error = params.get("error").cloned();
          }
        }

        let body = if code.is_some() {
          "<html><body><h2>Login concluido</h2><p>Voce pode voltar para o OpenDesk.</p></body></html>"
        } else {
          "<html><body><h2>Falha ao autenticar</h2><p>Voce pode voltar para o OpenDesk.</p></body></html>"
        };
        let response = format!(
          "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
          body.len(),
          body
        );
        let _ = stream.write_all(response.as_bytes());

        return OAuthCallbackPayload { code, state, error };
      }
      Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
        if Instant::now() > deadline {
          return OAuthCallbackPayload {
            code: None,
            state: None,
            error: Some("Tempo esgotado aguardando callback do Google.".to_string()),
          };
        }
        std::thread::sleep(Duration::from_millis(150));
      }
      Err(error) => {
        return OAuthCallbackPayload {
          code: None,
          state: None,
          error: Some(format!("Listener falhou: {}", error)),
        };
      }
    }
  }
}

#[tauri::command]
fn start_oauth_listener(app: tauri::AppHandle, port: u16) -> Result<(), String> {
  if OAUTH_LISTENER_ACTIVE.swap(true, Ordering::SeqCst) {
    return Ok(());
  }
  let handle = app.clone();
  std::thread::spawn(move || {
    let payload = wait_for_oauth_callback(port);
    let _ = handle.emit_all("oauth-callback", payload);
    OAUTH_LISTENER_ACTIVE.store(false, Ordering::SeqCst);
  });
  Ok(())
}

#[tauri::command]
fn moonlight_list(path: String, host: String) -> Result<CommandOutput, String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  let target = host.trim();
  if target.is_empty() {
    return Err("host vazio".to_string());
  }
  let output = std::process::Command::new(trimmed)
    .arg("list")
    .arg(target)
    .output()
    .map_err(|error| error.to_string())?;

  Ok(CommandOutput {
    code: output.status.code().unwrap_or(-1),
    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
  })
}

#[tauri::command]
fn moonlight_pair(path: String, host: String) -> Result<CommandOutput, String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  let target = host.trim();
  if target.is_empty() {
    return Err("host vazio".to_string());
  }
  let output = std::process::Command::new(trimmed)
    .arg("pair")
    .arg(target)
    .output()
    .map_err(|error| error.to_string())?;

  Ok(CommandOutput {
    code: output.status.code().unwrap_or(-1),
    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
    stderr: String::from_utf8_lossy(&output.stderr).to_string(),
  })
}

#[tauri::command]
fn moonlight_stream(path: String, host: String, app: String) -> Result<CommandOutput, String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  let target = host.trim();
  if target.is_empty() {
    return Err("host vazio".to_string());
  }
  let app_name = app.trim();
  if app_name.is_empty() {
    return Err("app vazio".to_string());
  }

  let child = std::process::Command::new(trimmed)
    .arg("stream")
    .arg(target)
    .arg(app_name)
    .spawn()
    .map_err(|error| error.to_string())?;

  Ok(CommandOutput {
    code: child.id() as i32,
    stdout: "".to_string(),
    stderr: "".to_string(),
  })
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      validate_exe_path,
      detect_sunshine_path,
      detect_moonlight_path,
      start_sunshine,
      start_moonlight,
      start_oauth_listener,
      moonlight_list,
      moonlight_pair,
      moonlight_stream
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
