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
    if let Ok(dir) = std::env::var("YASKAWA_PORTABLE_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return path;
        }
    }
    if let Ok(appdir) = std::env::var("APPDIR") {
        let bin = PathBuf::from(&appdir).join("usr").join("bin");
        if bin.is_dir() {
            return bin;
        }
        let root = PathBuf::from(appdir);
        if root.is_dir() {
            return root;
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(unix)]
fn ensure_unix_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        let mode = perms.mode();
        if mode & 0o111 == 0 {
            perms.set_mode(mode | 0o755);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
}

#[cfg(unix)]
fn spawn_via_elf_loader(bin: &PathBuf) -> Result<KinSidecar, String> {
    let loaders = [
        "/lib64/ld-linux-x86-64.so.2",
        "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
    ];
    let mut last_err = format!("no ELF loader found for {}", bin.display());
    for loader in loaders {
        if !std::path::Path::new(loader).exists() {
            continue;
        }
        match Command::new(loader)
            .arg(bin)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
                let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
                return Ok(KinSidecar {
                    child,
                    stdin,
                    stdout: BufReader::new(stdout),
                });
            }
            Err(err) => last_err = format!("spawn {loader}: {err}"),
        }
    }
    Err(last_err)
}

fn server_script() -> PathBuf {
    // Dev tree (cargo / tauri dev). kinematics/ sits at the workspace root,
    // which is three levels above apps/desktop/src-tauri.
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for up in ["..", "../../.."] {
        let candidate = manifest.join(up).join("kinematics").join("server.py");
        if candidate.exists() {
            return candidate;
        }
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
    #[cfg(unix)]
    ensure_unix_executable(bin);

    let spawned = Command::new(bin)
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    match spawned {
        Ok(mut child) => {
            let stdin = child.stdin.take().ok_or("sidecar stdin missing")?;
            let stdout = child.stdout.take().ok_or("sidecar stdout missing")?;
            Ok(KinSidecar {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            })
        }
        Err(err) => {
            #[cfg(unix)]
            {
                if let Ok(sidecar) = spawn_via_elf_loader(bin) {
                    return Ok(sidecar);
                }
            }
            Err(format!("spawn {}: {err}", bin.display()))
        }
    }
}

fn start_python_sidecar(script: &PathBuf) -> Result<KinSidecar, String> {
    let pythons = ["python3", "python", "py"];
    let mut last_err = String::from("no Python interpreter found");
    for python in pythons {
        match KinSidecar::spawn(python, script) {
            Ok(sidecar) => return Ok(sidecar),
            Err(err) => last_err = err,
        }
    }
    Err(last_err)
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
            "missing kinematics sidecar (no yaskawa-kin / yaskawa-kin.exe beside the app, and no {})",
            script.display()
        ));
    }
    start_python_sidecar(&script)
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
