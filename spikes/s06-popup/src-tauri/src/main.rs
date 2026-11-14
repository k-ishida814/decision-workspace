//! S-06 spike: a one-question window. Reads JSON lines on stdin, shows them, writes the answer
//! as one JSON line on stdout and exits. The Rust side only bridges stdin/stdout and the window.
use std::io::{BufRead, Write};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

struct Inbox {
    ready: bool,
    pending: Vec<String>,
}

struct Started(Instant);

fn ms(started: &Started) -> u128 {
    started.0.elapsed().as_millis()
}

/// The page is listening: hand over what arrived before it was.
#[tauri::command]
fn ready(app: tauri::AppHandle, inbox: State<Mutex<Inbox>>, started: State<Started>) {
    eprintln!("[popup] page ready at {}ms", ms(&started));
    let mut inbox = inbox.lock().unwrap();
    inbox.ready = true;
    for line in inbox.pending.drain(..) {
        let _ = app.emit("message", line);
    }
}

/// The question is rendered: show the window without taking focus.
#[tauri::command]
fn show(window: tauri::WebviewWindow, started: State<Started>) {
    let _ = window.show();
    eprintln!("[popup] shown at {}ms", ms(&started));
    println!(r#"{{"type":"shown","ms":{}}}"#, ms(&started));
    let _ = std::io::stdout().flush();
}

/// Final message (answer / fallback / toWorkspace): write it and exit.
#[tauri::command]
fn reply(app: tauri::AppHandle, line: String) {
    println!("{line}");
    let _ = std::io::stdout().flush();
    app.exit(0);
}

fn main() {
    let started = Started(Instant::now());
    tauri::Builder::default()
        .manage(started)
        .manage(Mutex::new(Inbox { ready: false, pending: Vec::new() }))
        .invoke_handler(tauri::generate_handler![ready, show, reply])
        .setup(|app| {
            // No Dock icon and no app activation: showing the window must not steal the
            // keyboard from the terminal (design §4.3 plan A).
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
        .run(tauri::generate_context!())
        .expect("failed to run the popup");
}
