use super::*;
use std::path::Path;
use std::path::PathBuf;

fn unique_tmp_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!(
        "hermes-bootstrap-test-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&base).unwrap();
    base
}

// Build a fake built-desktop release tree at the platform's expected path
// and return (install_root, expected_app_bundle_or_exe).
fn make_release_tree(install_root: &Path) -> PathBuf {
    let release = install_root.join("apps").join("desktop").join("release");
    if cfg!(target_os = "macos") {
        let macos_dir =
            release.join("mac-arm64").join("Catalyst.app").join("Contents").join("MacOS");
        std::fs::create_dir_all(&macos_dir).unwrap();
        std::fs::write(macos_dir.join("Catalyst"), b"#!/bin/sh\n").unwrap();
        macos_dir.parent().unwrap().parent().unwrap().to_path_buf() // .../Catalyst.app
    } else if cfg!(target_os = "windows") {
        let dir = release.join("win-unpacked");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Catalyst.exe");
        std::fs::write(&exe, b"stub").unwrap();
        exe
    } else {
        let dir = release.join("linux-unpacked");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("Catalyst");
        std::fs::write(&exe, b"stub").unwrap();
        exe
    }
}

// The relaunch / install target is derived from the rebuilt desktop app.
// On macOS this MUST resolve to the .app bundle (what `open` relaunches and
// what the updater ditto's over /Applications/Catalyst.app). A regression in
// this derivation breaks the post-update auto-relaunch, so guard it.
#[test]
fn resolve_hermes_desktop_app_finds_built_bundle() {
    let root = unique_tmp_dir("app-ok");
    let expected = make_release_tree(&root);

    let resolved =
        resolve_hermes_desktop_app(&root).expect("should resolve the freshly-built desktop app");

    #[cfg(target_os = "macos")]
    {
        assert_eq!(resolved, expected, "must resolve to the .app bundle");
        assert_eq!(
            resolved.extension().and_then(|e| e.to_str()),
            Some("app"),
            "relaunch target must be a .app bundle on macOS"
        );
    }
    #[cfg(not(target_os = "macos"))]
    {
        assert_eq!(resolved, expected);
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn resolve_hermes_desktop_app_is_none_without_a_build() {
    let root = unique_tmp_dir("app-none");
    // No release tree created.
    assert!(
        resolve_hermes_desktop_app(&root).is_none(),
        "no resolved app when nothing has been built"
    );
    let _ = std::fs::remove_dir_all(&root);
}
