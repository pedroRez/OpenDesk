#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

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

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      validate_exe_path,
      detect_sunshine_path,
      detect_moonlight_path
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
