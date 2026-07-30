use super::*;

#[test]
fn venv_hermes_is_under_install_root() {
    let root = Path::new("/x/hermes-agent");
    let shim = venv_hermes(root);
    assert!(shim.starts_with(root));
    assert!(shim.to_string_lossy().contains("venv"));
}

#[test]
fn missing_file_is_not_locked() {
    assert!(!is_locked(Path::new("/nonexistent/does/not/exist/xyz")));
}

#[test]
fn update_child_env_forces_unbuffered_python() {
    let envs = update_child_env(Path::new("/x/hermes-agent"));
    assert!(
        envs.iter().any(|(k, v)| k == "PYTHONUNBUFFERED" && v.to_str() == Some("1")),
        "update children must run unbuffered so long steps stream to the live log"
    );
}

#[test]
fn lock_probe_paths_include_desktop_app_payload() {
    let root = Path::new("/x/hermes-agent");
    let probes = install_lock_probe_paths(root);

    assert!(
        probes.iter().any(|p| p == &venv_hermes(root)),
        "venv shim remains part of the update lock probe"
    );
    assert!(
        // Windows/Linux payloads live under `resources/`, the macOS bundle
        // under `Contents/Resources/` — Path::ends_with is case-sensitive.
        probes.iter().any(|p| {
            p.ends_with(Path::new("resources/app.asar"))
                || p.ends_with(Path::new("Resources/app.asar"))
        }),
        "packaged app.asar must be probed so repair/re-clone waits for the old desktop to exit"
    );
}

#[test]
fn locked_paths_ignores_missing_payloads() {
    let root = Path::new("/nonexistent/hermes-agent");
    let probes = install_lock_probe_paths(root);

    assert!(locked_paths(&probes).is_empty());
}

#[test]
fn update_marker_guard_writes_then_removes_on_drop() {
    let dir = unique_tmp_dir("marker-guard");
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join(".hermes-update-in-progress");

    {
        let _g = UpdateMarkerGuard::acquire(marker.clone());
        assert!(marker.exists(), "marker must exist while the guard is held");
        let body = std::fs::read_to_string(&marker).unwrap();
        let pid_line = body.lines().next().unwrap();
        assert_eq!(
            pid_line.trim().parse::<u32>().unwrap(),
            std::process::id(),
            "marker records our pid so the desktop can probe liveness"
        );
        assert_eq!(body.lines().count(), 2, "marker is pid + started_at lines");
    }

    assert!(
        !marker.exists(),
        "Drop must remove the marker on every exit path (incl. early return / panic unwind)"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn update_marker_guard_drop_is_quiet_when_already_gone() {
    let dir = unique_tmp_dir("marker-guard-gone");
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join(".hermes-update-in-progress");

    let guard = UpdateMarkerGuard::acquire(marker.clone());
    // Simulate an external cleanup (e.g. the desktop pruned a marker it
    // judged stale) before our guard drops — Drop must not panic.
    std::fs::remove_file(&marker).unwrap();
    drop(guard);

    assert!(!marker.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn parses_update_branch_from_space_or_equals_args() {
    assert_eq!(
        update_branch_from_args(["--update", "--branch", "bb/test"]),
        Some("bb/test".to_string())
    );
    assert_eq!(update_branch_from_args(["--update", "--branch=main"]), Some("main".to_string()));
    assert_eq!(update_branch_from_args(["--update"]), None);
}

#[test]
fn update_manifest_leads_with_handoff_and_gates_install() {
    let base = update_stages(false);
    assert_eq!(
        base.first().map(|s| s.name.as_str()),
        Some("handoff"),
        "the lock-wait must surface as the first visible step"
    );
    assert!(
        base.iter().any(|s| s.name == "update") && base.iter().any(|s| s.name == "rebuild"),
        "update + rebuild remain distinct stages"
    );
    assert!(
        base.iter().all(|s| s.name != "install"),
        "no app-swap stage unless an install target was passed"
    );

    let with_install = update_stages(true);
    assert_eq!(
        with_install.last().map(|s| s.name.as_str()),
        Some("install"),
        "the macOS app-swap is the final stage when present"
    );
    assert_eq!(with_install.len(), base.len() + 1, "include_install adds exactly one stage");
}

#[test]
fn renamed_target_migrates_within_the_same_install_dir() {
    // Legacy install, rebuilt bundle now carries the Catalyst name: the
    // update must land on the new name beside the old one, not relocate.
    assert_eq!(
        renamed_target_app(
            Path::new("/Applications/Costas Code.app"),
            Path::new("/tmp/build/release/mac-arm64/Catalyst.app"),
        ),
        Some(PathBuf::from("/Applications/Catalyst.app"))
    );
    assert_eq!(
        renamed_target_app(
            Path::new("/Applications/Hermes.app"),
            Path::new("/tmp/build/release/mac-arm64/Catalyst.app"),
        ),
        Some(PathBuf::from("/Applications/Catalyst.app"))
    );
    // Steady state: names already match, so no migration is signalled and
    // the old bundle is NOT retired.
    assert_eq!(
        renamed_target_app(
            Path::new("/Applications/Catalyst.app"),
            Path::new("/tmp/build/release/mac-arm64/Catalyst.app"),
        ),
        None
    );
}

#[test]
fn rebuild_retries_only_on_failure() {
    assert!(!rebuild_needs_retry(Some(0)), "a clean rebuild must not retry");
    assert!(rebuild_needs_retry(Some(1)), "a failed rebuild retries once");
    assert!(rebuild_needs_retry(None), "a killed/signalled rebuild (no exit code) retries once");
}

#[test]
fn parses_only_app_targets() {
    assert_eq!(
        target_app_from_args(["--update", "--target-app", "/Applications/Hermes.app"]),
        Some(PathBuf::from("/Applications/Hermes.app"))
    );
    assert_eq!(target_app_from_args(["--target-app", "/tmp/not-an-app"]), None);
}

// Helpers for the swap tests: make a throwaway dir tree we can rename.
fn unique_tmp_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "hermes-swap-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base
}

fn write_marker(dir: &Path, contents: &str) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("marker.txt"), contents).unwrap();
}

#[tokio::test]
async fn swap_installs_new_bundle_and_cleans_up() {
    let base = unique_tmp_dir("ok");
    let target = base.join("Hermes.app");
    let tmp = base.join("Hermes.app.hermes-update-new");
    let old = base.join("Hermes.app.hermes-update-old");
    write_marker(&target, "OLD");
    write_marker(&tmp, "NEW");

    swap_in_new_bundle(&tmp, &target, &old).await.unwrap();

    // New bundle is now at target; staging + backup dirs are gone.
    assert_eq!(std::fs::read_to_string(target.join("marker.txt")).unwrap(), "NEW");
    assert!(!tmp.exists(), "staged copy should be cleaned up");
    assert!(!old.exists(), "backup should be cleaned up on success");
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn swap_failure_never_leaves_target_missing() {
    // Regression guard for the catastrophic path: the move-aside of the
    // existing app fails AND the staged bundle can't be installed. The
    // buggy version deleted `target` when move-aside failed and then
    // skipped rollback, bricking the install. The fixed version must leave
    // the original app intact on disk.
    //
    // Trigger both failures deterministically:
    //  - `old` is a NON-EMPTY dir  -> rename(target, old) fails
    //  - `tmp` does not exist       -> rename(tmp, target) fails
    let base = unique_tmp_dir("fail");
    let target = base.join("Hermes.app");
    let tmp = base.join("Hermes.app.hermes-update-new"); // intentionally absent
    let old = base.join("Hermes.app.hermes-update-old");
    write_marker(&target, "OLD");
    write_marker(&old, "OCCUPIED"); // non-empty => rename(target,old) fails

    let result = swap_in_new_bundle(&tmp, &target, &old).await;

    assert!(result.is_err(), "swap should fail when neither move can complete");
    assert!(target.exists(), "original app must NOT be deleted on failure");
    assert_eq!(
        std::fs::read_to_string(target.join("marker.txt")).unwrap(),
        "OLD",
        "original app contents must be intact after a failed swap"
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[tokio::test]
async fn swap_rolls_back_when_install_step_fails() {
    // Move-aside succeeds but installing the staged bundle fails (tmp
    // absent). The original must be rolled back from `old` to `target`.
    let base = unique_tmp_dir("rollback");
    let target = base.join("Hermes.app");
    let tmp = base.join("Hermes.app.hermes-update-new"); // absent
    let old = base.join("Hermes.app.hermes-update-old");
    write_marker(&target, "OLD");

    let result = swap_in_new_bundle(&tmp, &target, &old).await;

    assert!(result.is_err());
    assert!(target.exists(), "original must be restored after failed install");
    assert_eq!(std::fs::read_to_string(target.join("marker.txt")).unwrap(), "OLD");
    assert!(!old.exists(), "backup should be rolled back, not left behind");
    let _ = std::fs::remove_dir_all(&base);
}
