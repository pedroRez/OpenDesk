#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use serde::Serialize;
use tauri::Emitter;
use sysinfo::System;

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
fn is_process_running(process_name: String) -> Result<bool, String> {
  if !cfg!(windows) {
    return Ok(false);
  }
  let name = process_name.trim();
  if name.is_empty() {
    return Ok(false);
  }
  let filter = format!("IMAGENAME eq {}", name);
  let output = std::process::Command::new("tasklist")
    .args(["/FI", &filter])
    .output()
    .map_err(|error| error.to_string())?;

  let stdout = String::from_utf8_lossy(&output.stdout).to_lowercase();
  Ok(stdout.contains(&name.to_lowercase()))
}

#[tauri::command]
fn launch_exe(path: String, args: Vec<String>) -> Result<(), String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  std::process::Command::new(trimmed)
    .args(args)
    .spawn()
    .map(|_| ())
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn launch_moonlight(path: String, args: Vec<String>) -> Result<(), String> {
  let trimmed = path.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return Err("path vazio".to_string());
  }
  std::process::Command::new(trimmed)
    .args(args)
    .spawn()
    .map(|_| ())
    .map_err(|error| error.to_string())
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

#[derive(Serialize, Clone)]
struct HardwareProfile {
  cpuName: String,
  ramGb: u64,
  gpuName: String,
  storageSummary: String,
  osName: Option<String>,
  screenResolution: Option<String>,
}

#[derive(Serialize, Clone)]
struct HardwareProgress {
  requestId: String,
  status: String,
}

static HARDWARE_CANCEL: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancel_set() -> &'static Mutex<HashSet<String>> {
  HARDWARE_CANCEL.get_or_init(|| Mutex::new(HashSet::new()))
}

fn set_cancel(request_id: &str) {
  if let Ok(mut guard) = cancel_set().lock() {
    guard.insert(request_id.to_string());
  }
}

fn clear_cancel(request_id: &str) {
  if let Ok(mut guard) = cancel_set().lock() {
    guard.remove(request_id);
  }
}

fn is_cancelled(request_id: &str) -> bool {
  if let Ok(guard) = cancel_set().lock() {
    return guard.contains(request_id);
  }
  false
}

fn emit_progress(app: &tauri::AppHandle, request_id: &str, status: &str) {
  let _ = app.emit(
    "hardware-progress",
    HardwareProgress {
      requestId: request_id.to_string(),
      status: status.to_string(),
    },
  );
}

fn fnv1a_hash(input: &str) -> String {
  let mut hash: u64 = 0xcbf29ce484222325;
  for byte in input.as_bytes() {
    hash ^= *byte as u64;
    hash = hash.wrapping_mul(0x100000001b3);
  }
  format!("{:016x}", hash)
}

fn parse_wmic_lines(args: &[&str]) -> Vec<String> {
  if let Ok(output) = std::process::Command::new("wmic").args(args).output() {
    if output.status.success() {
      let stdout = String::from_utf8_lossy(&output.stdout);
      return stdout
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    }
  }
  Vec::new()
}

fn detect_gpu_name() -> String {
  let lines = parse_wmic_lines(&["path", "win32_VideoController", "get", "name"]);
  for line in lines {
    if line.to_lowercase().contains("name") {
      continue;
    }
    if !line.is_empty() {
      return line;
    }
  }
  "GPU desconhecida".to_string()
}

fn detect_storage_summary() -> String {
  let lines = parse_wmic_lines(&["diskdrive", "get", "MediaType,Size"]);
  let mut total_bytes: u64 = 0;
  let mut has_ssd = false;
  for line in lines {
    let lower = line.to_lowercase();
    if lower.contains("mediatype") || lower.contains("size") {
      continue;
    }
    if lower.contains("ssd") || lower.contains("solid state") {
      has_ssd = true;
    }
    let size = line
      .split_whitespace()
      .rev()
      .find_map(|part| part.parse::<u64>().ok());
    if let Some(bytes) = size {
      total_bytes = total_bytes.saturating_add(bytes);
    }
  }

  if total_bytes == 0 {
    return "Disco".to_string();
  }
  let total_gb = (total_bytes as f64 / 1024.0 / 1024.0 / 1024.0).round() as u64;
  let label = if has_ssd { "SSD" } else { "HDD" };
  if total_gb >= 1024 {
    let tb = (total_gb as f64 / 1024.0).round() as u64;
    format!("{} {}TB", label, tb)
  } else {
    format!("{} {}GB", label, total_gb.max(1))
  }
}

fn extract_ipv4s(text: &str) -> Vec<String> {
  let mut ips: Vec<String> = Vec::new();
  let mut buffer = String::new();
  let mut push_candidate = |candidate: &str, ips: &mut Vec<String>| {
    let parts: Vec<&str> = candidate.split('.').collect();
    if parts.len() != 4 {
      return;
    }
    let mut octets: [u8; 4] = [0, 0, 0, 0];
    for (idx, part) in parts.iter().enumerate() {
      if part.is_empty() || part.len() > 3 {
        return;
      }
      if let Ok(value) = part.parse::<u8>() {
        octets[idx] = value;
      } else {
        return;
      }
    }
    let ip = format!("{}.{}.{}.{}", octets[0], octets[1], octets[2], octets[3]);
    ips.push(ip);
  };

  for ch in text.chars() {
    if ch.is_ascii_digit() || ch == '.' {
      buffer.push(ch);
    } else if !buffer.is_empty() {
      push_candidate(&buffer, &mut ips);
      buffer.clear();
    }
  }
  if !buffer.is_empty() {
    push_candidate(&buffer, &mut ips);
  }

  ips
}

fn score_ip(ip: &str) -> i32 {
  if ip.starts_with("127.") {
    return -1;
  }
  if ip.starts_with("100.") {
    return 3;
  }
  if ip.starts_with("192.168.") {
    return 2;
  }
  if ip.starts_with("10.") {
    return 2;
  }
  if ip.starts_with("172.") {
    if let Some(second) = ip.split('.').nth(1).and_then(|v| v.parse::<u8>().ok()) {
      if (16..=31).contains(&second) {
        return 1;
      }
    }
  }
  0
}

#[tauri::command]
fn detect_local_ip() -> Option<String> {
  if !cfg!(windows) {
    return None;
  }
  let output = std::process::Command::new("ipconfig").output().ok()?;
  let text = String::from_utf8_lossy(&output.stdout);
  let ips = extract_ipv4s(&text);
  if ips.is_empty() {
    return None;
  }
  let mut best = ips[0].clone();
  let mut best_score = score_ip(&best);
  for ip in ips.into_iter() {
    let score = score_ip(&ip);
    if score > best_score {
      best_score = score;
      best = ip;
    }
  }
  if best_score < 0 {
    None
  } else {
    Some(best)
  }
}

#[tauri::command]
fn get_local_pc_id() -> Result<String, String> {
  if !cfg!(windows) {
    return Err("Plataforma nao suportada.".to_string());
  }
  let mut parts: Vec<String> = Vec::new();
  let uuid_lines = parse_wmic_lines(&["csproduct", "get", "UUID"]);
  for line in uuid_lines {
    if line.to_lowercase().contains("uuid") {
      continue;
    }
    if !line.is_empty() {
      parts.push(line);
      break;
    }
  }
  let bios_lines = parse_wmic_lines(&["bios", "get", "serialnumber"]);
  for line in bios_lines {
    if line.to_lowercase().contains("serial") {
      continue;
    }
    if !line.is_empty() {
      parts.push(line);
      break;
    }
  }
  let mut system = System::new();
  system.refresh_cpu();
  if let Some(cpu) = system.cpus().first() {
    parts.push(cpu.brand().to_string());
  }

  let base = parts.join("|");
  if base.trim().is_empty() {
    return Err("Nao foi possivel identificar este PC.".to_string());
  }
  Ok(fnv1a_hash(&base))
}

#[tauri::command]
fn cancel_hardware_profile(request_id: String) -> bool {
  if request_id.trim().is_empty() {
    return false;
  }
  set_cancel(&request_id);
  true
}

#[tauri::command]
fn get_hardware_profile(app: tauri::AppHandle, request_id: String) -> Result<HardwareProfile, String> {
  if request_id.trim().is_empty() {
    return Err("requestId invalido".to_string());
  }
  if !cfg!(windows) {
    return Err("Plataforma nao suportada.".to_string());
  }

  emit_progress(&app, &request_id, "Detectando CPU...");
  if is_cancelled(&request_id) {
    clear_cancel(&request_id);
    return Err("cancelled".to_string());
  }
  let mut system = System::new_all();
  system.refresh_cpu();
  let cpu_name = system
    .cpus()
    .first()
    .map(|cpu| cpu.brand().to_string())
    .unwrap_or_else(|| "CPU desconhecida".to_string());

  emit_progress(&app, &request_id, "Detectando RAM...");
  if is_cancelled(&request_id) {
    clear_cancel(&request_id);
    return Err("cancelled".to_string());
  }
  system.refresh_memory();
  let total_kb = system.total_memory();
  let ram_gb = ((total_kb as f64 / 1024.0 / 1024.0).round() as u64).max(1);

  emit_progress(&app, &request_id, "Detectando GPU...");
  if is_cancelled(&request_id) {
    clear_cancel(&request_id);
    return Err("cancelled".to_string());
  }
  let gpu_name = detect_gpu_name();

  emit_progress(&app, &request_id, "Detectando armazenamento...");
  if is_cancelled(&request_id) {
    clear_cancel(&request_id);
    return Err("cancelled".to_string());
  }
  let storage_summary = detect_storage_summary();

  emit_progress(&app, &request_id, "Finalizando...");
  clear_cancel(&request_id);

  Ok(HardwareProfile {
    cpuName: cpu_name,
    ramGb: ram_gb,
    gpuName: gpu_name,
    storageSummary: storage_summary,
    osName: Some("Windows".to_string()),
    screenResolution: None,
  })
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
      is_process_running,
      launch_exe,
      launch_moonlight,
      get_local_pc_id,
      detect_local_ip,
      get_hardware_profile,
      cancel_hardware_profile,
      detect_sunshine_path,
      detect_moonlight_path,
      start_sunshine,
      start_moonlight,
      moonlight_list,
      moonlight_pair,
      moonlight_stream
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
