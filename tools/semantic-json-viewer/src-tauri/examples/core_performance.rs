use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use semantic_json_viewer::document_session::DocumentSession;
use semantic_json_viewer::jsonl_session::JsonlSession;
use serde_json::{json, Value};

const RAW_FIRST_SLICE: usize = 128 * 1024;

#[derive(Clone, Copy)]
enum Scenario {
    Jsonl,
    Document,
}

#[derive(Clone, Copy)]
enum CacheMode {
    Warm,
    Cold,
}

struct Config {
    scenario: Scenario,
    path: PathBuf,
    cache: CacheMode,
    idle_seconds: u64,
}

fn main() {
    match run() {
        Ok(output) => println!(
            "{}",
            serde_json::to_string(&output).expect("benchmark output must serialize")
        ),
        Err(error) => {
            let output = json!({
                "schemaVersion": 1,
                "runner": "semantic-json-viewer-core-performance",
                "scenario": "unknown",
                "errors": [error.to_string()],
            });
            println!(
                "{}",
                serde_json::to_string(&output).expect("error output must serialize")
            );
            std::process::exit(1);
        }
    }
}

fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let config = parse_args()?;
    let cache = prepare_cache(&config.path, config.cache)?;
    let output = match config.scenario {
        Scenario::Jsonl => run_jsonl(&config, cache)?,
        Scenario::Document => run_document(&config, cache)?,
    };
    Ok(output)
}

fn parse_args() -> Result<Config, Box<dyn std::error::Error>> {
    let mut scenario = None;
    let mut path = None;
    let mut cache = CacheMode::Warm;
    let mut idle_seconds = 5;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("missing value for {arg}"))
        };
        match arg.as_str() {
            "--scenario" => {
                scenario = Some(match value()?.as_str() {
                    "jsonl" => Scenario::Jsonl,
                    "document" => Scenario::Document,
                    other => return Err(format!("unknown scenario {other}").into()),
                });
            }
            "--path" => path = Some(PathBuf::from(value()?)),
            "--cache" => {
                cache = match value()?.as_str() {
                    "warm" => CacheMode::Warm,
                    "cold" => CacheMode::Cold,
                    other => return Err(format!("unknown cache mode {other}").into()),
                };
            }
            "--idle-seconds" => idle_seconds = value()?.parse()?,
            "--help" | "-h" => {
                return Err("usage: core_performance --scenario jsonl|document --path FILE [--cache warm|cold] [--idle-seconds N]".into());
            }
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    Ok(Config {
        scenario: scenario.ok_or("--scenario is required")?,
        path: path.ok_or("--path is required")?,
        cache,
        idle_seconds,
    })
}

fn prepare_cache(path: &Path, mode: CacheMode) -> Result<Value, Box<dyn std::error::Error>> {
    match mode {
        CacheMode::Warm => {
            let mut file = File::open(path)?;
            let mut buffer = [0u8; 1024 * 1024];
            let mut bytes = 0u64;
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                bytes += read as u64;
            }
            Ok(json!({"mode":"warm","prepared":true,"bytesRead":bytes,"reason":null}))
        }
        CacheMode::Cold => prepare_cold_cache(path),
    }
}

#[cfg(target_os = "linux")]
fn prepare_cold_cache(path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    use std::os::fd::AsRawFd;
    const POSIX_FADV_DONTNEED: i32 = 4;
    unsafe extern "C" {
        fn posix_fadvise(fd: i32, offset: i64, length: i64, advice: i32) -> i32;
    }
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let result = unsafe { posix_fadvise(file.as_raw_fd(), 0, size as i64, POSIX_FADV_DONTNEED) };
    if result == 0 {
        Ok(json!({"mode":"cold","prepared":true,"method":"posix_fadvise(DONTNEED)","reason":null}))
    } else {
        Ok(
            json!({"mode":"cold","prepared":false,"method":"posix_fadvise(DONTNEED)","reason":format!("posix_fadvise returned {result}")}),
        )
    }
}

#[cfg(not(target_os = "linux"))]
fn prepare_cold_cache(_path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(
        json!({"mode":"cold","prepared":false,"method":null,"reason":"unsupported on this platform; no cold-cache claim"}),
    )
}

fn run_jsonl(config: &Config, cache: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let start = Instant::now();
    let mut session = JsonlSession::open(&config.path)?;
    let mut progress = session.progress()?;
    let mut first_page = session
        .list_entry_summaries(0, 20)?
        .ok_or("list_entry_summaries returned no page")?;
    while first_page.summaries.len() < 20 && !progress.complete {
        progress = session.scan_next()?;
        first_page = session
            .list_entry_summaries(0, 20)?
            .ok_or("list_entry_summaries returned no page")?;
    }
    if first_page.summaries.len() < 20 {
        return Err(format!(
            "fixture exposes only {} entries; need at least 20",
            first_page.summaries.len()
        )
        .into());
    }
    let open_to_first20_us = micros(start.elapsed());
    let scan_start = Instant::now();
    while !progress.complete {
        progress = session.scan_next()?;
    }
    let scan_next_only_us = micros(scan_start.elapsed());
    let open_to_scan_complete_us = micros(start.elapsed());
    if config.idle_seconds > 0 {
        thread::sleep(Duration::from_secs(config.idle_seconds));
    }
    let total_entries = progress.total_entries.unwrap_or(progress.indexed_entries);
    let ordinals = sample_ordinals(total_entries, 100);
    let mut samples = Vec::with_capacity(ordinals.len());
    for ordinal in ordinals {
        let sample_start = Instant::now();
        let selection = session
            .select_entry(ordinal)?
            .ok_or_else(|| format!("entry {ordinal} was unavailable after complete indexing"))?;
        samples.push(json!({
            "ordinal": ordinal,
            "elapsedUs": micros(sample_start.elapsed()),
            "status": format!("{:?}", selection.summary.status),
            "byteStart": selection.summary.location.byte_start,
            "byteEnd": selection.summary.location.byte_end,
            "rootNodeId": selection.root.as_ref().map(|root| root.id),
        }));
    }
    let sample_times = samples
        .iter()
        .filter_map(|sample| sample.get("elapsedUs")?.as_u64())
        .collect::<Vec<_>>();
    let identity = session.identity();
    let modified_unix =
        identity.modified.duration_since(UNIX_EPOCH).ok().map(
            |duration| json!({"seconds": duration.as_secs(), "nanos": duration.subsec_nanos()}),
        );
    Ok(json!({
        "schemaVersion": 1,
        "runner": "semantic-json-viewer-core-performance",
        "scope": "core-only-no-tauri-no-webview",
        "scenario": "jsonl",
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "debug": cfg!(debug_assertions),
        "fixture": {"path": identity.canonical_path, "bytes": identity.size, "modifiedUnix": modified_unix, "identityCurrent": session.is_current()},
        "cache": cache,
        "idleSeconds": config.idle_seconds,
        "timingsUs": {"openToFirst20": open_to_first20_us, "openToScanComplete": open_to_scan_complete_us, "scanNextOnly": scan_next_only_us},
        "index": {"indexedEntries": progress.indexed_entries, "totalEntries": total_entries, "complete": progress.complete, "indexedThroughSourceLines": progress.indexed_source_lines},
        "select": {"sampleCount": samples.len(), "medianUs": median(&sample_times), "p95Us": percentile(&sample_times, 0.95), "samples": samples},
        "memory": {"measured": false, "applicationOwnedMiB": null, "inputResidentWindowMiB": null, "reason": "benchmark runner does not claim full application private memory or smaps without a platform harness"},
        "errors": [],
    }))
}

fn run_document(config: &Config, cache: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let start = Instant::now();
    let session = DocumentSession::open(&config.path)?;
    let root = session.root()?;
    let open_to_root_us = micros(start.elapsed());
    let ready_to_raw_start = Instant::now();
    let raw = session
        .read_raw_text(0, RAW_FIRST_SLICE)?
        .ok_or("document raw first slice was unavailable")?;
    let ready_to_raw_first_slice_us = micros(ready_to_raw_start.elapsed());
    let open_to_raw_first_slice_us = micros(start.elapsed());
    let identity = session.identity();
    let modified_unix =
        identity.modified.duration_since(UNIX_EPOCH).ok().map(
            |duration| json!({"seconds": duration.as_secs(), "nanos": duration.subsec_nanos()}),
        );
    Ok(json!({
        "schemaVersion": 1,
        "runner": "semantic-json-viewer-core-performance",
        "scope": "core-only-no-tauri-no-webview",
        "scenario": "document",
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "debug": cfg!(debug_assertions),
        "fixture": {"path": identity.canonical_path, "bytes": identity.size, "modifiedUnix": modified_unix, "identityCurrent": session.is_current(), "rootNodeId": root.id, "rootSpanStart": root.span.start, "rootSpanEnd": root.span.end},
        "cache": cache,
        "timingsUs": {"openToRoot": open_to_root_us, "openToRawFirstSlice": open_to_raw_first_slice_us, "readyToRawFirstSlice": ready_to_raw_first_slice_us},
        "rawFirstSlice": {"start": raw.start, "bytes": raw.text.len(), "hasMore": raw.has_more, "nextOffset": raw.next_offset},
        "memory": {"measured": false, "applicationOwnedMiB": null, "inputResidentWindowMiB": null, "reason": "benchmark runner does not claim full application private memory or smaps without a platform harness"},
        "errors": [],
    }))
}

fn sample_ordinals(total: u64, count: usize) -> Vec<u64> {
    if total == 0 {
        return Vec::new();
    }
    let count = (count as u64).min(total) as usize;
    if count <= 1 {
        return vec![0];
    }
    (0..count)
        .map(|index| index as u64 * (total - 1) / (count as u64 - 1))
        .collect()
}

fn percentile(values: &[u64], percentile: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let index = ((values.len() as f64 * percentile).ceil() as usize)
        .saturating_sub(1)
        .min(values.len() - 1);
    values.get(index).copied()
}

fn median(values: &[u64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[middle] as f64)
    } else {
        Some((values[middle - 1] as f64 + values[middle] as f64) / 2.0)
    }
}

fn micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::{median, percentile, sample_ordinals};

    #[test]
    fn sample_ordinals_are_bounded_and_distinct() {
        assert!(sample_ordinals(0, 100).is_empty());
        assert_eq!(sample_ordinals(1, 100), vec![0]);
        assert_eq!(sample_ordinals(69, 100).len(), 69);

        let samples = sample_ordinals(101, 100);
        assert_eq!(samples.len(), 100);
        assert_eq!(samples.first(), Some(&0));
        assert_eq!(samples.last(), Some(&100));
        assert!(samples.windows(2).all(|window| window[0] < window[1]));
    }

    #[test]
    fn percentile_is_deterministic_at_small_boundaries() {
        let values = [10, 20, 30, 40];
        assert_eq!(percentile(&values, 0.0), Some(10));
        assert_eq!(percentile(&values, 0.5), Some(20));
        assert_eq!(percentile(&values, 0.95), Some(40));
        assert_eq!(percentile(&[], 0.5), None);
        assert_eq!(median(&values), Some(25.0));
        assert_eq!(median(&[10, 20, 30]), Some(20.0));
        assert_eq!(median(&[]), None);
    }
}
