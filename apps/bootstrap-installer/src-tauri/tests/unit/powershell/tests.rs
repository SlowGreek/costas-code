use super::*;

#[test]
fn parse_stage_result_picks_last_json_line() {
    let stdout = r#"
[bootstrap] some info
{"ok": false, "stage": "venv", "reason": "bad python"}
{"ok": true, "stage": "venv"}
final non-json banner
"#;
    let result = parse_stage_result(stdout).unwrap();
    assert_eq!(result.stage, "venv");
    assert!(result.ok);
}

#[test]
fn parse_manifest_finds_stages_array() {
    let stdout = r#"
info line
{"stages": [{"name": "uv", "title": "uv", "category": "prereqs", "needs_user_input": false}], "protocol_version": 1}
"#;
    let m = parse_manifest(stdout).unwrap();
    assert_eq!(m.stages.len(), 1);
    assert_eq!(m.stages[0].name, "uv");
    assert_eq!(m.protocol_version, Some(1));
}

#[test]
fn parse_returns_none_when_no_match() {
    assert!(parse_stage_result("just banner\n").is_none());
    assert!(parse_manifest("just banner\n").is_none());
}

#[test]
fn stable_script_cwd_prefers_existing_hermes_home() {
    let script = Path::new("/tmp/install.sh");
    let cwd = stable_script_cwd(script, Some("/"));
    assert_eq!(cwd, Some(Path::new("/")));
}

#[test]
fn powershell_under_root_uses_system32_v1_layout() {
    let resolved = powershell_under_root(Path::new("C:\\Windows"));
    let normalized = resolved.to_string_lossy().replace('\\', "/");
    assert!(
        normalized.ends_with("System32/WindowsPowerShell/v1.0/powershell.exe"),
        "unexpected powershell path: {normalized}"
    );
}

#[test]
fn decode_console_bytes_keeps_valid_utf8() {
    assert_eq!(decode_console_bytes("café — ok".as_bytes()), "café — ok");
}

#[test]
fn decode_console_bytes_preserves_cp1252_portuguese_error() {
    // "Não foi fornecido o terminador..." as Windows PowerShell 5.1 emits
    // under CP1252 (0xE3 = ã). BufReader::lines() previously failed here
    // with "stream did not contain valid UTF-8" and the UI only showed "No".
    let bytes: &[u8] = b"N\xE3o foi fornecido o terminador";
    assert_eq!(decode_console_bytes(bytes), "Não foi fornecido o terminador");
}

#[test]
fn decode_console_bytes_maps_cp1252_only_punctuation() {
    // 0x91/0x92 are curly quotes in Windows-1252, but C1 controls under
    // Latin-1 (`b as char`). This locks the real CP1252 fallback.
    let bytes: &[u8] = b"say \x91hi\x92";
    assert_eq!(decode_console_bytes(bytes), "say \u{2018}hi\u{2019}");
    assert_ne!(
        decode_console_bytes(bytes),
        bytes.iter().map(|&b| b as char).collect::<String>(),
        "Latin-1 byte mapping must not be used for the 0x80..=0x9F range"
    );
}

#[tokio::test]
async fn read_decoded_line_survives_non_utf8_and_crlf() {
    let data: &[u8] = b"N\xE3o erro\r\nnext\n";
    let mut reader = BufReader::new(data);
    let mut buf = Vec::new();
    assert_eq!(
        read_decoded_line(&mut reader, &mut buf).await.unwrap().as_deref(),
        Some("Não erro")
    );
    assert_eq!(read_decoded_line(&mut reader, &mut buf).await.unwrap().as_deref(), Some("next"));
    assert!(read_decoded_line(&mut reader, &mut buf).await.unwrap().is_none());
}

#[tokio::test]
async fn read_decoded_line_preserves_partial_line_across_cancellation() {
    use std::time::Duration;
    use tokio::io::AsyncWriteExt;

    let (mut tx, rx) = tokio::io::duplex(64);
    let mut reader = BufReader::new(rx);
    let mut buf = Vec::new();

    tx.write_all(b"partial").await.unwrap();
    // Poll once, then cancel (drop) the future -- exactly what
    // tokio::select! does in run_script when the other stream produces
    // a line first. The consumed bytes must survive in `buf`.
    let _ =
        tokio::time::timeout(Duration::from_millis(0), read_decoded_line(&mut reader, &mut buf))
            .await;

    tx.write_all(b" line\n").await.unwrap();
    let line = read_decoded_line(&mut reader, &mut buf).await.unwrap();
    assert_eq!(line.as_deref(), Some("partial line"));
}

#[tokio::test]
async fn read_decoded_line_emits_unterminated_final_line_at_eof() {
    let data: &[u8] = b"no trailing newline";
    let mut reader = BufReader::new(data);
    let mut buf = Vec::new();
    assert_eq!(
        read_decoded_line(&mut reader, &mut buf).await.unwrap().as_deref(),
        Some("no trailing newline")
    );
    assert!(read_decoded_line(&mut reader, &mut buf).await.unwrap().is_none());
}
