//! Decision Workspace Popup (T-603, ADR-0006). The daemon starts it per batch of questions:
//! one `show` JSON line arrives on stdin; the page answers through `reply`, which prints one JSON
//! line on stdout and exits. Rust only bridges stdin/stdout and the window; the page holds the UI.
use std::io::{BufRead, Write};
use std::sync::Mutex;
use tauri::{Emitter, LogicalSize, Manager, State};

/// stdin lines that arrived before the page listened.
struct Inbox {
    ready: bool,
    pending: Vec<String>,
}

fn emit_line(out: &str) {
    println!("{out}");
    let _ = std::io::stdout().flush();
}

/// The page is listening: hand over what arrived before it was.
#[tauri::command]
fn ready(app: tauri::AppHandle, inbox: State<Mutex<Inbox>>) {
    let mut inbox = inbox.lock().unwrap();
    inbox.ready = true;
    for line in inbox.pending.drain(..) {
        let _ = app.emit("message", line);
    }
}

/// The question is rendered: fit the height, show without taking focus, tell the daemon.
#[tauri::command]
fn show(window: tauri::WebviewWindow, height: f64) {
    let _ = window.set_size(LogicalSize::new(480.0, height.clamp(160.0, 720.0)));
    let _ = window.center();
    let _ = window.show();
    emit_line(r#"{"type":"shown"}"#);
}

/// Resize when the content changes (next question, text field).
#[tauri::command]
fn fit(window: tauri::WebviewWindow, height: f64) {
    let _ = window.set_size(LogicalSize::new(480.0, height.clamp(160.0, 720.0)));
}

/// The final message (answer / fallback / toWorkspace): write it and exit.
#[tauri::command]
fn reply(app: tauri::AppHandle, line: String) {
    emit_line(&line);
    app.exit(0);
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(Inbox { ready: false, pending: Vec::new() }))
        .invoke_handler(tauri::generate_handler![ready, show, fit, reply])
        .setup(|app| {
            // No Dock icon and no activation: the window must not take the keyboard from the
            // terminal (ADR-0006). The user clicks it to answer.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                for line in std::io::stdin().lock().lines() {
                    let Ok(line) = line else { break };
                    let inbox = handle.state::<Mutex<Inbox>>();
                    let mut inbox = inbox.lock().unwrap();
                    if inbox.ready {
                        let _ = handle.emit("message", line);
                    } else {
                        inbox.pending.push(line);
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button means "answer in Claude Code instead" (design §4.1).
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                emit_line(r#"{"type":"fallback"}"#);
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run the popup");
}
