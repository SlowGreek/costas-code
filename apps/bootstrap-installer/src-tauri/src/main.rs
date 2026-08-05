// Hermes Setup — process entrypoint. All logic lives in lib.rs so it can
// be unit-tested as a library; this file just calls into it.
//
// The windows_subsystem attribute MUST live here on the binary crate
// (not lib.rs) — placing it on the lib was the bug that left a stray
// cmd window behind Hermes-Setup.exe on release builds.
//
// `windows_subsystem = "windows"` strips the console allocation that
// the default `windows_subsystem = "console"` would do, so double-clicking
// the .exe gives you ONLY the Tauri window.
//
// debug_assertions guard: dev builds keep the console so tracing output
// is visible during `cargo tauri dev`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow as _;
use dirs as _;
use reqwest as _;
use serde as _;
use serde_json as _;
use tauri as _;
use tauri_plugin_dialog as _;
use tauri_plugin_opener as _;
use tauri_plugin_process as _;
use tauri_plugin_shell as _;
use tokio as _;
use tracing as _;
use tracing_appender as _;
use tracing_subscriber as _;

fn main() {
    hermes_bootstrap_lib::run()
}
