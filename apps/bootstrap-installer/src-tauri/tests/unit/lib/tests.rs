use super::{force_setup_from_args, AppMode};

#[test]
fn bare_args_are_install() {
    assert_eq!(AppMode::from_args(Vec::<String>::new()), AppMode::Install);
    assert_eq!(AppMode::from_args(["--foo", "bar"]), AppMode::Install);
}

#[test]
fn update_flag_selects_update() {
    assert_eq!(AppMode::from_args(["--update"]), AppMode::Update);
    assert_eq!(AppMode::from_args(["--something", "--update", "--else"]), AppMode::Update);
}

#[test]
fn reinstall_and_repair_flags_force_setup() {
    assert!(force_setup_from_args(["--reinstall"]));
    assert!(force_setup_from_args(["--repair"]));
    assert!(force_setup_from_args(["--foo", "--repair", "--bar"]));
}

#[test]
fn bare_or_unrelated_args_do_not_force_setup() {
    assert!(!force_setup_from_args(Vec::<String>::new()));
    assert!(!force_setup_from_args(["--foo", "bar"]));
    // --update must not be mistaken for a force-setup flag.
    assert!(!force_setup_from_args(["--update"]));
}

#[test]
fn force_setup_flags_do_not_affect_mode_selection() {
    // The repair flags must never flip Install<->Update.
    assert_eq!(AppMode::from_args(["--reinstall"]), AppMode::Install);
    assert_eq!(AppMode::from_args(["--repair"]), AppMode::Install);
    assert_eq!(AppMode::from_args(["--update", "--reinstall"]), AppMode::Update);
}
