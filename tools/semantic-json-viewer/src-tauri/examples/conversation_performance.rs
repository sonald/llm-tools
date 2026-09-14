use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use semantic_json_viewer::conversation::{
    ConversationKind, ConversationSourceRef, ConversationStyle, GenericConversationBlockKind,
    GenericConversationCategory,
};
use semantic_json_viewer::document_session::DocumentSession;
use semantic_json_viewer::json::JsonKind;
use serde_json::{json, Value};

const PAGE_SIZE: usize = 100;
const BOUNDED_SOURCE_SLICE: usize = 256;
const LONG_SOURCE_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy)]
enum CacheMode {
    Warm,
    Cold,
}

struct Config {
    path: PathBuf,
    cache: CacheMode,
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
                "runner": "semantic-json-viewer-conversation-performance",
                "scope": "core-only-no-tauri-no-webview",
                "scenario": "conversation",
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
    run_conversation(&config, cache)
}

fn parse_args() -> Result<Config, Box<dyn std::error::Error>> {
    let mut path = None;
    let mut cache = CacheMode::Warm;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--path" => {
                path = Some(PathBuf::from(
                    args.next().ok_or("missing value for --path")?,
                ));
            }
            "--cache" => {
                cache = match args.next().ok_or("missing value for --cache")?.as_str() {
                    "warm" => CacheMode::Warm,
                    "cold" => CacheMode::Cold,
                    other => return Err(format!("unknown cache mode {other}").into()),
                };
            }
            "--help" | "-h" => {
                return Err(
                    "usage: conversation_performance --path FILE [--cache warm|cold]".into(),
                )
            }
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    Ok(Config {
        path: path.ok_or("--path is required")?,
        cache,
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
            Ok(json!({
                "mode": "warm",
                "prepared": true,
                "bytesRead": bytes,
                "reason": null
            }))
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
        Ok(json!({
            "mode": "cold",
            "prepared": true,
            "method": "posix_fadvise(DONTNEED)",
            "reason": null
        }))
    } else {
        Ok(json!({
            "mode": "cold",
            "prepared": false,
            "method": "posix_fadvise(DONTNEED)",
            "reason": format!("posix_fadvise returned {result}")
        }))
    }
}

#[cfg(not(target_os = "linux"))]
fn prepare_cold_cache(_path: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    Ok(json!({
        "mode": "cold",
        "prepared": false,
        "method": null,
        "reason": "unsupported on this platform; no cold-cache claim"
    }))
}

fn run_conversation(config: &Config, cache: Value) -> Result<Value, Box<dyn std::error::Error>> {
    let open_start = Instant::now();
    let session = DocumentSession::open(&config.path)?;
    let open_us = micros(open_start.elapsed());

    let lookup_start = Instant::now();
    let root = session.root()?;
    let root_children = session
        .children(root.id, 0, 200)?
        .ok_or("conversation fixture root children were unavailable")?;
    let candidate_id = root_children
        .nodes
        .iter()
        .find(|node| node.kind == JsonKind::Array && node.label == "messages")
        .map(|node| node.id)
        .ok_or("conversation fixture has no direct messages array")?;
    let candidate_lookup_us = micros(lookup_start.elapsed());

    let candidate_start = Instant::now();
    let candidate = session
        .conversation_candidate(root.id, candidate_id)?
        .ok_or("messages array was not accepted as a conversation candidate")?;
    let candidate_us = micros(candidate_start.elapsed());
    let style = style_for_kind(candidate.kind);

    let pages_start = Instant::now();
    let mut page = session
        .conversation_page(root.id, candidate_id, None, PAGE_SIZE, style)?
        .ok_or("first conversation page was unavailable")?;
    let first_page_us = micros(pages_start.elapsed());
    let first_page_block_count = page.blocks.len();

    let mut page_count = 0usize;
    let mut total_block_count = 0usize;
    let mut message_block_count = 0usize;
    let mut max_page_block_count = 0usize;
    let mut unknown_source_ref_count = 0usize;
    let mut tail_source_ref = None;
    let mut longest_source_span = 0usize;
    let mut long_source_slice = None;

    let remaining_start = Instant::now();
    loop {
        page_count += 1;
        total_block_count = total_block_count.saturating_add(page.blocks.len());
        max_page_block_count = max_page_block_count.max(page.blocks.len());
        for block in &page.blocks {
            if block.kind == GenericConversationBlockKind::Message {
                message_block_count += 1;
            }
            let Some(source) = block.source else {
                continue;
            };
            let span_bytes = source.span.end.saturating_sub(source.span.start);
            longest_source_span = longest_source_span.max(span_bytes);
            if span_bytes > LONG_SOURCE_BYTES && long_source_slice.is_none() {
                let slice = session
                    .read_raw_text(source.span.start, BOUNDED_SOURCE_SLICE)?
                    .ok_or("long source slice was unavailable")?;
                long_source_slice = Some(json!({
                    "sourceSpanBytes": span_bytes,
                    "requestedBytes": BOUNDED_SOURCE_SLICE,
                    "returnedBytes": slice.text.len(),
                    "hasMore": slice.has_more,
                    "nextOffset": slice.next_offset,
                    "fullRead": false,
                }));
            }
            if block.category == GenericConversationCategory::Unknown {
                unknown_source_ref_count += 1;
                tail_source_ref = Some(source);
            }
        }

        let Some(next_cursor) = page.next_cursor else {
            if page.has_more {
                return Err("conversation page reported has_more without a cursor".into());
            }
            break;
        };
        if !page.has_more {
            return Err("conversation page returned a cursor after the end".into());
        }
        page = session
            .conversation_page(root.id, candidate_id, Some(next_cursor), PAGE_SIZE, style)?
            .ok_or("conversation page cursor became invalid")?;
    }
    let remaining_pages_to_end_us = micros(remaining_start.elapsed());
    let all_pages_to_end_us = micros(pages_start.elapsed());

    if message_block_count != candidate.message_count {
        return Err(format!(
            "conversation emitted {message_block_count} message blocks for {} messages",
            candidate.message_count
        )
        .into());
    }
    if candidate.message_count == 0 {
        return Err("conversation has no messages for a tail sentinel check".into());
    }
    let tail_source_ref =
        tail_source_ref.ok_or("conversation emitted no unknown source reference")?;
    let expected_tail = format!("F12_TAIL_SENTINEL_{}", candidate.message_count - 1);
    let tail_span_bytes = tail_source_ref
        .span
        .end
        .saturating_sub(tail_source_ref.span.start);
    let tail_requested_bytes = tail_span_bytes.min(BOUNDED_SOURCE_SLICE);
    let tail_slice = session
        .read_raw_text(tail_source_ref.span.start, tail_requested_bytes)?
        .ok_or("tail source slice was unavailable")?;
    let tail_matches = tail_slice.text.contains(&expected_tail);
    if !tail_matches {
        return Err(
            format!("tail source slice did not contain expected sentinel {expected_tail}").into(),
        );
    }

    let retained_capacity = session.retained_capacity()?;
    let identity = session.identity();
    let modified_unix = identity
        .modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| {
            json!({
                "seconds": duration.as_secs(),
                "nanos": duration.subsec_nanos()
            })
        });
    Ok(json!({
        "schemaVersion": 1,
        "runner": "semantic-json-viewer-conversation-performance",
        "scope": "core-only-no-tauri-no-webview",
        "scenario": "conversation",
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "debug": cfg!(debug_assertions),
        "cache": cache,
        "fixture": {
            "path": identity.canonical_path,
            "bytes": identity.size,
            "modifiedUnix": modified_unix,
            "identityCurrent": session.is_current()
        },
        "timingsUs": {
            "open": open_us,
            "candidateLookup": candidate_lookup_us,
            "candidate": candidate_us,
            "first100BlockPage": first_page_us,
            "remainingPagesToEnd": remaining_pages_to_end_us,
            "allPagesToEnd": all_pages_to_end_us
        },
        "conversation": {
            "scopeRootId": root.id,
            "candidateNodeId": candidate.node_id,
            "candidateSpan": {"start": candidate.span.start, "end": candidate.span.end},
            "kind": candidate.kind.as_str(),
            "style": style_name(style),
            "messageCount": candidate.message_count,
            "pageSize": PAGE_SIZE,
            "firstPageBlockCount": first_page_block_count,
            "maxPageBlockCount": max_page_block_count,
            "pageCount": page_count,
            "totalBlockCount": total_block_count,
            "messageBlockCount": message_block_count,
            "reachedEnd": true,
            "unknownSourceRefCount": unknown_source_ref_count,
            "tailSourceRef": source_ref_value(tail_source_ref),
            "tailSourceSlice": {
                "start": tail_slice.start,
                "sourceSpanBytes": tail_span_bytes,
                "requestedBytes": tail_requested_bytes,
                "bytes": tail_slice.text.len(),
                "text": tail_slice.text,
                "hasMore": tail_slice.has_more,
                "nextOffset": tail_slice.next_offset,
                "expectedSentinel": expected_tail,
                "matchesSentinel": tail_matches
            },
            "longestSourceSpanBytes": longest_source_span,
            "longSourceSlice": long_source_slice
        },
        "memory": {
            "measured": false,
            "coreRetainedBufferCapacity": {
                "scope": "ParsedJson tree buffers only; excludes FileSource, temporary read slices, parser frames, conversation page vectors, and RSS/live/peak/private memory",
                "sourceCapacityBytes": retained_capacity.source_capacity_bytes,
                "nodesCapacityBytes": retained_capacity.nodes_capacity_bytes,
                "childrenCapacityBytes": retained_capacity.children_capacity_bytes,
                "objectKeyCapacityBytes": retained_capacity.object_key_capacity_bytes,
                "decodedCheckpointsCapacityBytes": retained_capacity.decoded_checkpoints_capacity_bytes,
                "totalCapacityBytes": retained_capacity.total_capacity_bytes
            },
            "applicationOwnedMiB": null,
            "inputResidentWindowMiB": null,
            "reason": "benchmark runner does not claim full application private memory or smaps without a platform harness"
        },
        "errors": []
    }))
}

fn style_for_kind(kind: ConversationKind) -> ConversationStyle {
    match kind {
        ConversationKind::OpenAi => ConversationStyle::OpenAi,
        ConversationKind::Anthropic => ConversationStyle::Anthropic,
        ConversationKind::Generic
        | ConversationKind::None
        | ConversationKind::Possible
        | ConversationKind::Mixed => ConversationStyle::Generic,
    }
}

fn style_name(style: ConversationStyle) -> &'static str {
    match style {
        ConversationStyle::Generic => "generic",
        ConversationStyle::OpenAi => "openai",
        ConversationStyle::Anthropic => "anthropic",
    }
}

fn source_ref_value(source: ConversationSourceRef) -> Value {
    json!({
        "nodeId": source.node_id,
        "span": {"start": source.span.start, "end": source.span.end}
    })
}

fn micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}
