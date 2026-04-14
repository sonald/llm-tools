use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use assert_cmd::Command;
use reqwest::blocking::Client;
use reqwest::blocking::RequestBuilder;
use serde_json::{json, Value};

fn bin() -> Command {
    Command::cargo_bin("qrcode2txt").expect("binary should build")
}

fn api_url() -> String {
    std::env::var("QRCODE_MONKEY_API_URL")
        .unwrap_or_else(|_| "https://api.qrcode-monkey.com/qr/custom".to_string())
}

fn api_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("build reqwest client")
}

fn with_optional_api_headers(request: RequestBuilder) -> RequestBuilder {
    let request = if let Ok(key) = std::env::var("QRCODE_MONKEY_RAPIDAPI_KEY") {
        request.header("X-RapidAPI-Key", key)
    } else {
        request
    };

    if let Ok(host) = std::env::var("QRCODE_MONKEY_RAPIDAPI_HOST") {
        request.header("X-RapidAPI-Host", host)
    } else {
        request
    }
}

fn post_qrcode_monkey_png(name: &str, payload: Value) -> PathBuf {
    let response = with_optional_api_headers(api_client().post(api_url()))
        .json(&payload)
        .send()
        .expect("request to QRCode Monkey API should succeed")
        .error_for_status()
        .expect("QRCode Monkey API should return success");

    let bytes = response.bytes().expect("read PNG response bytes");
    let path = tempfile::Builder::new()
        .prefix(name)
        .suffix(".png")
        .tempfile()
        .expect("create temporary PNG file")
        .into_temp_path()
        .keep()
        .expect("persist temporary PNG file");
    fs::write(&path, &bytes).expect("write API PNG response");
    path
}

#[test]
#[ignore = "hits the live QRCode Monkey API"]
fn decodes_live_qrcode_monkey_url_png() {
    let path = post_qrcode_monkey_png(
        "url",
        json!({
            "data": "https://example.com/qrcode2txt-live?case=url&ts=2026-04-14",
            "size": 500,
            "file": "png",
            "download": false
        }),
    );

    let assert = bin().args(["--format", "raw"]).arg(&path).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");

    assert_eq!(
        stdout.trim_end_matches('\n'),
        "https://example.com/qrcode2txt-live?case=url&ts=2026-04-14"
    );
}

#[test]
#[ignore = "hits the live QRCode Monkey API"]
fn decodes_live_qrcode_monkey_text_png() {
    let path = post_qrcode_monkey_png(
        "text",
        json!({
            "data": "qrcode2txt live test\nline two: \u{4F60}\u{597D} QR",
            "size": 500,
            "file": "png",
            "download": false
        }),
    );

    let assert = bin().args(["--format", "raw"]).arg(&path).assert().code(0);
    let stdout = String::from_utf8(assert.get_output().stdout.clone()).expect("utf8 stdout");

    assert_eq!(
        stdout.trim_end_matches('\n'),
        "qrcode2txt live test\nline two: \u{4F60}\u{597D} QR"
    );
}
