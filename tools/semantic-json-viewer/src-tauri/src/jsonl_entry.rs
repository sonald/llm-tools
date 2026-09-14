use std::str::from_utf8;

use crate::json::{parse_json, ChildLocator, JsonKind, ParseError, ParsedJson};
use crate::jsonl_index::EntryLocation;

pub const MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
pub const PREVIEW_BYTES: usize = 64 * 1024;
const EVENT_SUMMARY_MAX_SCALARS: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntryStatus {
    Valid,
    InvalidUtf8,
    InvalidJson(ParseError),
    Oversized,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntryEventValue {
    pub value: String,
    pub has_more: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct EntryEventSummary {
    pub event_type: Option<EntryEventValue>,
    pub timestamp: Option<EntryEventValue>,
    pub grouping: Option<EntryEventValue>,
}

pub fn entry_bytes<'a>(source: &'a [u8], location: &EntryLocation) -> Option<&'a [u8]> {
    let start = usize::try_from(location.byte_start).ok()?;
    let end = usize::try_from(location.byte_end).ok()?;
    source.get(start..end)
}

pub fn inspect_entry(bytes: &[u8]) -> EntryStatus {
    inspect_entry_with_summary(bytes).0
}

pub fn inspect_entry_with_summary(bytes: &[u8]) -> (EntryStatus, Option<EntryEventSummary>) {
    if bytes.len() > MAX_ENTRY_BYTES {
        return (EntryStatus::Oversized, None);
    }
    if from_utf8(bytes).is_err() {
        return (EntryStatus::InvalidUtf8, None);
    }
    match parse_json(bytes) {
        Ok(parsed) => (EntryStatus::Valid, event_summary_from_parsed(&parsed)),
        Err(error) => (EntryStatus::InvalidJson(error), None),
    }
}

pub fn event_summary_from_parsed(parsed: &ParsedJson<'_>) -> Option<EntryEventSummary> {
    let root = parsed.node(parsed.root());
    if root.kind != JsonKind::Object {
        return None;
    }

    let mut event_type = None;
    let mut timestamp = None;
    let mut grouping = None;
    let mut event_type_rank = usize::MAX;
    let mut timestamp_rank = usize::MAX;
    let mut grouping_rank = usize::MAX;

    for &child_id in &root.children {
        let child = parsed.node(child_id);
        let ChildLocator::ObjectKey { key, .. } = &child.locator else {
            continue;
        };
        if let Some(rank) = event_type_key_rank(key) {
            if rank < event_type_rank {
                if let Some(value) = bounded_event_value(parsed, child_id) {
                    event_type = Some(value);
                    event_type_rank = rank;
                }
            }
        } else if let Some(rank) = timestamp_key_rank(key) {
            if rank < timestamp_rank {
                if let Some(value) = bounded_event_value(parsed, child_id) {
                    timestamp = Some(value);
                    timestamp_rank = rank;
                }
            }
        } else if let Some(rank) = grouping_key_rank(key) {
            if rank < grouping_rank {
                if let Some(value) = bounded_event_value(parsed, child_id) {
                    grouping = Some(value);
                    grouping_rank = rank;
                }
            }
        }
    }

    (event_type.is_some() || timestamp.is_some() || grouping.is_some()).then_some(
        EntryEventSummary {
            event_type,
            timestamp,
            grouping,
        },
    )
}

fn bounded_event_value(
    parsed: &ParsedJson<'_>,
    child_id: crate::json::NodeId,
) -> Option<EntryEventValue> {
    let child = parsed.node(child_id);
    match child.kind {
        JsonKind::String => parsed.decoded_string_for_node(child).map(|value| {
            let (value, has_more) = value.prefix_chars(EVENT_SUMMARY_MAX_SCALARS);
            EntryEventValue { value, has_more }
        }),
        _ => from_utf8(parsed.raw_lexeme(child_id)).ok().map(|value| {
            let (value, has_more) = truncate_source(value);
            EntryEventValue { value, has_more }
        }),
    }
}

fn truncate_source(value: &str) -> (String, bool) {
    let mut scalars = value.chars();
    let preview: String = scalars.by_ref().take(EVENT_SUMMARY_MAX_SCALARS).collect();
    (preview, scalars.next().is_some())
}

fn event_type_key_rank(key: &str) -> Option<usize> {
    match key {
        "type" => Some(0),
        "event" => Some(1),
        "event_type" => Some(2),
        "kind" => Some(3),
        _ => None,
    }
}

fn timestamp_key_rank(key: &str) -> Option<usize> {
    match key {
        "timestamp" => Some(0),
        "time" => Some(1),
        "ts" => Some(2),
        "created_at" => Some(3),
        "createdAt" => Some(4),
        _ => None,
    }
}

fn grouping_key_rank(key: &str) -> Option<usize> {
    match key {
        "session_id" => Some(0),
        "sessionId" => Some(1),
        "trace_id" => Some(2),
        "traceId" => Some(3),
        "run_id" => Some(4),
        "runId" => Some(5),
        "conversation_id" => Some(6),
        "conversationId" => Some(7),
        "request_id" => Some(8),
        "requestId" => Some(9),
        "case_id" => Some(10),
        "caseId" => Some(11),
        _ => None,
    }
}

pub fn oversized_preview(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    if bytes.len() <= MAX_ENTRY_BYTES {
        return None;
    }
    Some((
        &bytes[..PREVIEW_BYTES],
        &bytes[bytes.len() - PREVIEW_BYTES..],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number_with_trailing_spaces(len: usize) -> Vec<u8> {
        let mut bytes = vec![b'0'];
        bytes.resize(len, b' ');
        bytes
    }

    #[test]
    fn valid_entry_is_valid() {
        assert_eq!(inspect_entry(br#"{"ok":true}"#), EntryStatus::Valid);
    }

    #[test]
    fn event_summary_uses_spec_field_priority_and_keeps_missing_fields_absent() {
        let inspection = inspect_entry_with_summary(
            br#"{"kind":"fallback","event_type":"secondary","type":"message","createdAt":"later","timestamp":"now","traceId":"trace","session_id":"session"}"#,
        );
        assert_eq!(inspection.0, EntryStatus::Valid);
        let summary = inspection.1.expect("event fields");
        assert_eq!(summary.event_type.unwrap().value, "message");
        assert_eq!(summary.timestamp.unwrap().value, "now");
        assert_eq!(summary.grouping.unwrap().value, "session");

        let missing = inspect_entry_with_summary(br#"{"payload":true}"#);
        assert_eq!(missing.1, None);
    }

    #[test]
    fn event_summary_bounds_decoded_strings_and_raw_values() {
        let escaped = "\\u4f60".repeat(300);
        let raw_items = (0..300).map(|_| "0").collect::<Vec<_>>().join(",");
        let input = format!(r#"{{"type":"{escaped}","session_id":{{"items":[{raw_items}]}}}}"#);
        let summary = inspect_entry_with_summary(input.as_bytes())
            .1
            .expect("event fields");
        let event_type = summary.event_type.expect("event type");
        assert_eq!(event_type.value.chars().count(), EVENT_SUMMARY_MAX_SCALARS);
        assert!(event_type.has_more);
        let grouping = summary.grouping.expect("grouping");
        assert_eq!(grouping.value.chars().count(), EVENT_SUMMARY_MAX_SCALARS);
        assert!(grouping.has_more);
        assert!(grouping.value.starts_with(r#"{"items":[0,"#));
    }

    #[test]
    fn event_summary_is_omitted_for_invalid_nonobject_and_oversized_entries() {
        let nonobject = inspect_entry_with_summary(br#"[]"#);
        assert_eq!(nonobject.0, EntryStatus::Valid);
        assert_eq!(nonobject.1, None);
        for input in [b"{".as_slice(), b"\xff".as_slice()] {
            let inspection = inspect_entry_with_summary(input);
            assert_eq!(inspection.1, None);
            assert_ne!(inspection.0, EntryStatus::Valid);
        }

        let oversized = vec![b' '; MAX_ENTRY_BYTES + 1];
        let inspection = inspect_entry_with_summary(&oversized);
        assert_eq!(inspection.0, EntryStatus::Oversized);
        assert_eq!(inspection.1, None);
    }

    #[test]
    fn malformed_entry_is_invalid_json() {
        assert!(matches!(inspect_entry(b"{"), EntryStatus::InvalidJson(_)));
    }

    #[test]
    fn invalid_utf8_entry_is_reported_before_json() {
        assert_eq!(inspect_entry(b"\"\xff\""), EntryStatus::InvalidUtf8);
    }

    #[test]
    fn max_entry_is_valid_and_not_oversized() {
        let bytes = number_with_trailing_spaces(MAX_ENTRY_BYTES);
        assert_eq!(inspect_entry(&bytes), EntryStatus::Valid);
        assert_eq!(oversized_preview(&bytes), None);
    }

    #[test]
    fn oversized_entry_has_head_and_tail_previews() {
        let mut bytes = vec![b'x'; MAX_ENTRY_BYTES + 1];
        bytes[0] = 0xff;
        let tail_start = bytes.len() - PREVIEW_BYTES;
        bytes[PREVIEW_BYTES - 1] = b'H';
        bytes[tail_start] = b'T';
        assert_eq!(inspect_entry(&bytes), EntryStatus::Oversized);
        let (head, tail) = oversized_preview(&bytes).expect("oversized preview");
        assert_eq!(head.len(), PREVIEW_BYTES);
        assert_eq!(tail.len(), PREVIEW_BYTES);
        assert_eq!(head[0], 0xff);
        assert_eq!(head[head.len() - 1], b'H');
        assert_eq!(tail[0], b'T');
        assert_eq!(tail[tail.len() - 1], b'x');
    }

    #[test]
    fn entry_bytes_returns_only_in_bounds_forward_slices() {
        let source = b"0123456789";
        assert_eq!(
            entry_bytes(
                source,
                &EntryLocation {
                    entry_ordinal: 0,
                    source_line: 1,
                    byte_start: 2,
                    byte_end: 5
                }
            ),
            Some(&source[2..5])
        );
        assert_eq!(
            entry_bytes(
                source,
                &EntryLocation {
                    entry_ordinal: 0,
                    source_line: 1,
                    byte_start: 6,
                    byte_end: 11
                }
            ),
            None
        );
        assert_eq!(
            entry_bytes(
                source,
                &EntryLocation {
                    entry_ordinal: 0,
                    source_line: 1,
                    byte_start: 5,
                    byte_end: 2
                }
            ),
            None
        );
    }
}
