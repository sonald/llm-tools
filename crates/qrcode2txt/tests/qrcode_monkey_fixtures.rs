use std::path::{Path, PathBuf};

use assert_cmd::Command;

const URL_FIXTURE: &str = "tests/fixtures/qrcode-monkey-url.png";
const URL_EXPECTED: &str = "https://example.com/qrcode2txt-live?case=url&ts=2026-04-14";

const TEXT_FIXTURE: &str = "tests/fixtures/qrcode-monkey-text.png";
const TEXT_EXPECTED: &str = "qrcode2txt live test\nline two: \u{4F60}\u{597D} QR";

const NOISY_SCREENSHOT_FIXTURE: &str = "tests/fixtures/noisy-screenshot-qr.png";
const NOISY_SCREENSHOT_EXPECTED: &str = "https://example.com/qrcode2txt-live?case=url&ts=2026-04-14";

fn bin() -> Command {
    Command::cargo_bin("qrcode2txt").expect("binary should build")
}

fn fixture_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

#[test]
fn decodes_qrcode_monkey_url_fixture() {
    let fixture = fixture_path(URL_FIXTURE);

    let assert = bin()
        .args(["--format", "raw"])
        .arg(&fixture)
        .assert()
        .code(0);

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    assert_eq!(stdout.trim_end_matches('\n'), URL_EXPECTED);
}

#[test]
fn decodes_qrcode_monkey_text_fixture() {
    let fixture = fixture_path(TEXT_FIXTURE);

    let assert = bin()
        .args(["--format", "raw"])
        .arg(&fixture)
        .assert()
        .code(0);

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    assert_eq!(stdout.trim_end_matches('\n'), TEXT_EXPECTED);
}

#[test]
fn decodes_noisy_screenshot_fixture() {
    let fixture = fixture_path(NOISY_SCREENSHOT_FIXTURE);

    let assert = bin()
        .args(["--format", "raw"])
        .arg(&fixture)
        .assert()
        .code(0);

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    assert_eq!(stdout.trim_end_matches('\n'), NOISY_SCREENSHOT_EXPECTED);
}
