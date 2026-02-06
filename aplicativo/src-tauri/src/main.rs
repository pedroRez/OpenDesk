#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
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
      moonlight_list,
      moonlight_pair,
      moonlight_stream
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
