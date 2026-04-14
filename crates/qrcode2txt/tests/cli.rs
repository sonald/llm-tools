use std::fs;
use std::path::Path;

use assert_cmd::Command;
use image::{imageops, ImageBuffer, Luma};
use qrcode::QrCode;
use tempfile::TempDir;

fn bin() -> Command {
    Command::cargo_bin("qrcode2txt").expect("binary should build")
}

fn write_qr_png(path: &Path, text: &str) {
    let code = QrCode::new(text.as_bytes()).expect("valid QR payload");
    let image = code
        .render::<Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(240, 240)
        .build();
    image.save(path).expect("save QR image");
}

fn qr_png_bytes(text: &str) -> Vec<u8> {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("stdin.png");
    write_qr_png(&path, text);
    fs::read(path).expect("read QR bytes")
}

fn write_multi_qr_png(path: &Path, texts: &[&str]) {
    let images: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = texts
        .iter()
        .map(|text| {
            let code = QrCode::new(text.as_bytes()).expect("valid QR payload");
            code.render::<Luma<u8>>()
                .quiet_zone(true)
                .min_dimensions(220, 220)
                .build()
        })
        .collect();

    let gap = 32u32;
    let total_width =
        images.iter().map(|image| image.width()).sum::<u32>() + gap * (images.len() as u32 - 1);
    let max_height = images.iter().map(|image| image.height()).max().unwrap_or(0);
    let mut canvas = ImageBuffer::from_pixel(total_width, max_height, Luma([255u8]));

    let mut x = 0u32;
    for image in images {
        imageops::overlay(&mut canvas, &image, i64::from(x), 0);
        x += image.width() + gap;
    }

    canvas.save(path).expect("save combined QR image");
}

fn write_invalid_file(path: &Path) {
    fs::write(path, "not an image").expect("write invalid file");
}

#[test]
fn rejects_missing_input() {
    bin().assert().code(1).stderr(predicates::str::contains(
        "requires at least one input path",
    ));
}

#[test]
fn rejects_multiple_input_modes() {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("one.png");
    write_qr_png(&path, "alpha");

    bin()
        .arg(path)
        .arg("--stdin")
        .assert()
        .code(1)
        .stderr(predicates::str::contains("mutually exclusive"));
}

#[test]
fn rejects_missing_output_file() {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("one.png");
    write_qr_png(&path, "alpha");

    bin()
        .arg(path)
        .args(["--output", "file"])
        .assert()
        .code(1)
        .stderr(predicates::str::contains(
            "--output file requires --output-file",
        ));
}

#[test]
fn decodes_single_file_to_json() {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("one.png");
    write_qr_png(&path, "alpha");

    let assert = bin().arg(&path).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json output");

    assert_eq!(value["summary"]["total_sources"], 1);
    assert_eq!(value["summary"]["succeeded_sources"], 1);
    assert_eq!(value["summary"]["failed_sources"], 0);
    assert_eq!(value["summary"]["total_codes"], 1);
    assert_eq!(
        value["results"][0]["source_label"],
        path.display().to_string()
    );
    assert_eq!(value["results"][0]["codes"][0]["text"], "alpha");
}

#[test]
fn decodes_multiple_qrs_in_one_file() {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("multi.png");
    write_multi_qr_png(&path, &["alpha", "beta"]);

    let assert = bin().arg(&path).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json output");

    let codes = value["results"][0]["codes"].as_array().expect("code array");
    assert_eq!(codes.len(), 2);
    assert_eq!(codes[0]["text"], "alpha");
    assert_eq!(codes[1]["text"], "beta");
}

#[test]
fn preserves_input_order_for_parallel_file_processing() {
    let dir = TempDir::new().expect("temp dir");
    let first = dir.path().join("first.png");
    let second = dir.path().join("second.txt");
    let third = dir.path().join("third.png");
    write_qr_png(&first, "first");
    write_invalid_file(&second);
    write_qr_png(&third, "third");

    let assert = bin()
        .args(["--jobs", "2"])
        .arg(&first)
        .arg(&second)
        .arg(&third)
        .assert()
        .code(2);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json output");

    let results = value["results"].as_array().expect("results array");
    assert_eq!(results.len(), 3);
    assert_eq!(results[0]["source_label"], first.display().to_string());
    assert_eq!(results[1]["source_label"], second.display().to_string());
    assert_eq!(results[2]["source_label"], third.display().to_string());
    assert_eq!(results[0]["status"], "ok");
    assert_eq!(results[1]["status"], "error");
    assert_eq!(results[2]["status"], "ok");
}

#[test]
fn decodes_png_from_stdin() {
    let bytes = qr_png_bytes("stdin-payload");

    let assert = bin().arg("--stdin").write_stdin(bytes).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json output");

    assert_eq!(value["results"][0]["source_label"], "<stdin>");
    assert_eq!(value["results"][0]["codes"][0]["text"], "stdin-payload");
}

#[test]
fn raw_output_contains_only_successful_payloads() {
    let dir = TempDir::new().expect("temp dir");
    let valid = dir.path().join("valid.png");
    let invalid = dir.path().join("invalid.txt");
    write_qr_png(&valid, "alpha");
    write_invalid_file(&invalid);

    let assert = bin()
        .args(["--format", "raw"])
        .arg(&valid)
        .arg(&invalid)
        .assert()
        .code(2);

    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let stderr = String::from_utf8(assert.get_output().stderr.clone()).expect("utf8 stderr");

    assert_eq!(stdout, "alpha\n");
    assert!(stderr.contains("invalid.txt"));
}

#[test]
fn yaml_output_matches_expected_shape() {
    let dir = TempDir::new().expect("temp dir");
    let path = dir.path().join("one.png");
    write_qr_png(&path, "alpha");

    let assert = bin().arg(&path).args(["--format", "yaml"]).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_yaml::Value = serde_yaml::from_str(&stdout).expect("yaml output");

    assert_eq!(value["summary"]["total_sources"].as_i64(), Some(1));
    assert_eq!(
        value["results"][0]["codes"][0]["text"].as_str(),
        Some("alpha")
    );
}

#[test]
fn writes_output_to_file() {
    let dir = TempDir::new().expect("temp dir");
    let input = dir.path().join("one.png");
    let output = dir.path().join("report.json");
    write_qr_png(&input, "alpha");

    bin()
        .arg(&input)
        .args(["--output", "file", "--output-file"])
        .arg(&output)
        .assert()
        .code(0);

    let written = fs::read_to_string(output).expect("output file contents");
    let value: serde_json::Value = serde_json::from_str(&written).expect("json output");
    assert_eq!(value["results"][0]["codes"][0]["text"], "alpha");
}

#[test]
fn fail_fast_stops_after_first_failed_source() {
    let dir = TempDir::new().expect("temp dir");
    let invalid = dir.path().join("invalid.txt");
    let valid = dir.path().join("valid.png");
    write_invalid_file(&invalid);
    write_qr_png(&valid, "beta");

    let assert = bin()
        .arg("--fail-fast")
        .arg(&invalid)
        .arg(&valid)
        .assert()
        .code(2);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("json output");

    let results = value["results"].as_array().expect("results array");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["source_label"], invalid.display().to_string());
}
