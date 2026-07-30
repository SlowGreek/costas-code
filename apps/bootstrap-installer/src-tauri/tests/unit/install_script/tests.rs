use super::*;

#[test]
fn is_valid_commit_accepts_short_and_full_shas() {
    assert!(is_valid_commit("02d26981d3d4ad50e142399b8476f59ad5953ff0"));
    assert!(is_valid_commit("02d2698"));
    assert!(!is_valid_commit("02d269"));
    assert!(!is_valid_commit("not-a-sha"));
    assert!(!is_valid_commit(""));
}

#[test]
fn sanitize_ref_replaces_slashes() {
    assert_eq!(sanitize_ref("bb/gui"), "bb_gui");
    assert_eq!(sanitize_ref("main"), "main");
    assert_eq!(sanitize_ref("release/1.2.3"), "release_1.2.3");
}

#[test]
fn prepare_cached_ps1_prefixes_utf8_bom() {
    let out = prepare_cached_script_bytes(ScriptKind::Ps1, b"Write-Host hi\n");
    assert!(out.starts_with(UTF8_BOM), "cached .ps1 must start with UTF-8 BOM");
    assert_eq!(&out[UTF8_BOM.len()..], b"Write-Host hi\n");
}

#[test]
fn prepare_cached_ps1_does_not_double_bom() {
    let mut already = UTF8_BOM.to_vec();
    already.extend_from_slice(b"x");
    let out = prepare_cached_script_bytes(ScriptKind::Ps1, &already);
    assert_eq!(out, already);
    assert_eq!(out.windows(3).filter(|w| *w == UTF8_BOM).count(), 1);
}

#[test]
fn prepare_cached_sh_stays_bomless() {
    let out = prepare_cached_script_bytes(ScriptKind::Sh, b"#!/bin/bash\n");
    assert!(!out.starts_with(UTF8_BOM));
    assert_eq!(out, b"#!/bin/bash\n");
}

#[test]
fn commit_pins_are_immutable_branch_pins_are_not() {
    // Mirrors the resolve() immutable decision: SHA pins may reuse cache
    // forever; branch pins must refresh so Retry cannot keep a bad script.
    assert!(is_valid_commit("02d26981d3d4ad50e142399b8476f59ad5953ff0"));
    assert!(!is_valid_commit("main"));
    assert!(!is_valid_commit("release/1.2.3"));
}

#[test]
fn existing_branch_cache_plans_refresh_with_stale_fallback() {
    // Resolver-level: a prior install-main.ps1 must not short-circuit
    // Retry — mutable pins refresh, and only fall back if download fails.
    assert_eq!(
        cache_plan(/*immutable=*/ false, /*cached_exists=*/ true),
        CachePlan::Fetch { stale_ok: true }
    );
    assert_eq!(cache_plan(/*immutable=*/ true, /*cached_exists=*/ true), CachePlan::Reuse);
    assert_eq!(
        cache_plan(/*immutable=*/ false, /*cached_exists=*/ false),
        CachePlan::Fetch { stale_ok: false }
    );
    assert_eq!(
        cache_plan(/*immutable=*/ true, /*cached_exists=*/ false),
        CachePlan::Fetch { stale_ok: false }
    );
}

#[test]
fn upgrade_cached_script_adds_bom_to_legacy_ps1() {
    // A .ps1 cached by a pre-#67193 installer has no BOM; the Reuse path
    // must upgrade it in place instead of serving the broken bytes forever.
    let dir = std::env::temp_dir().join(format!("hermes-bom-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cached = dir.join("install-abc1234.ps1");
    std::fs::write(&cached, b"Write-Host legacy\n").unwrap();

    upgrade_cached_script(ScriptKind::Ps1, &cached, &|_| {});
    let bytes = std::fs::read(&cached).unwrap();
    assert!(bytes.starts_with(UTF8_BOM), "legacy cache must gain a BOM");
    assert_eq!(&bytes[UTF8_BOM.len()..], b"Write-Host legacy\n");

    // Idempotent: a second pass must not double the BOM.
    upgrade_cached_script(ScriptKind::Ps1, &cached, &|_| {});
    let again = std::fs::read(&cached).unwrap();
    assert_eq!(again, bytes);

    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn upgrade_cached_script_leaves_sh_untouched() {
    let dir = std::env::temp_dir().join(format!("hermes-bom-sh-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let cached = dir.join("install-main.sh");
    std::fs::write(&cached, b"#!/bin/bash\n").unwrap();

    upgrade_cached_script(ScriptKind::Sh, &cached, &|_| {});
    assert_eq!(std::fs::read(&cached).unwrap(), b"#!/bin/bash\n");

    std::fs::remove_dir_all(&dir).unwrap();
}
