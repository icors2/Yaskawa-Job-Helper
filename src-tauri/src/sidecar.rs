use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

pub struct KinSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl KinSidecar {
    fn spawn(python: &str, script: &PathBuf) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg(script)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("spawn {python}: {err}"))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    fn request_line(&mut self, line: &str) -> Result<String, String> {
        writeln!(self.stdin, "{line}").map_err(|err| err.to_string())?;
        self.stdin.flush().map_err(|err| err.to_string())?;
        let mut response = String::new();
        let n = self
            .stdout
            .read_line(&mut response)
            .map_err(|err| err.to_string())?;
        if n == 0 {
            return Err("sidecar closed stdout".into());
        }
        Ok(response.trim_end_matches(['\r', '\n']).to_string())
    }
}

impl Drop for KinSidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct SidecarStore {
    inner: Mutex<Option<KinSidecar>>,
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn server_script() -> PathBuf {
    // Dev tree (cargo / tauri dev)
    let from_manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("kinematics")
        .join("server.py");
    if from_manifest.exists() {
        return from_manifest;
    }
    // Portable layout: kinematics/server.py next to the app exe
    exe_dir().join("kinematics").join("server.py")
}

fn portable_kin_exe() -> Option<PathBuf> {
    let dir = exe_dir();
    for name in ["yaskawa-kin.exe", "yaskawa-kin"] {
        let candidate = dir.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn spawn_kin_binary(bin: &PathBuf) -> Result<KinSidecar, String> {
    let mut child = Command::new(bin)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn {}: {err}", bin.display()))?;
    let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
    Ok(KinSidecar {
        child,
        stdin,
        stdout: BufReader::new(stdout),
    })
}

fn start_sidecar() -> Result<KinSidecar, String> {
    // 1) Portable USB / release: bundled PyInstaller binary next to the app
    if let Some(bin) = portable_kin_exe() {
        return spawn_kin_binary(&bin);
    }

    // 2) Dev: python + server.py
    let script = server_script();
    if !script.exists() {
        return Err(format!(
            "missing kinematics sidecar (no yaskawa-kin.exe beside the app, and no {})",
            script.display()
        ));
    }
    match KinSidecar::spawn("python", &script) {
        Ok(sidecar) => Ok(sidecar),
        Err(_) => KinSidecar::spawn("py", &script),
    }
}

fn with_sidecar<F>(store: &SidecarStore, mut action: F) -> Result<String, String>
where
    F: FnMut(&mut KinSidecar) -> Result<String, String>,
{
    let mut guard = store.inner.lock().map_err(|_| "sidecar lock")?;
    if guard.is_none() {
        *guard = Some(start_sidecar()?);
    }
    let sidecar = guard.as_mut().ok_or("sidecar missing")?;
    match action(sidecar) {
        Ok(value) => Ok(value),
        Err(_) => {
            *guard = Some(start_sidecar()?);
            let restarted = guard.as_mut().ok_or("sidecar restart failed")?;
            action(restarted)
        }
    }
}

#[tauri::command]
pub fn kin_request(store: tauri::State<SidecarStore>, request: String) -> Result<String, String> {
    let line = request.replace(['\n', '\r'], "");
    if line.is_empty() {
        return Err("empty sidecar request".into());
    }
    with_sidecar(&store, |sidecar| sidecar.request_line(&line))
}
