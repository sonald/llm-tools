use std::str::from_utf8;

use crate::json::{parse_json, ParseError};
use crate::jsonl_index::EntryLocation;

pub const MAX_ENTRY_BYTES: usize = 16 * 1024 * 1024;
pub const PREVIEW_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EntryStatus {
    Valid,
    InvalidUtf8,
    InvalidJson(ParseError),
    Oversized,
}

pub fn entry_bytes<'a>(source: &'a [u8], location: &EntryLocation) -> Option<&'a [u8]> {
    let start = usize::try_from(location.byte_start).ok()?;
    let end = usize::try_from(location.byte_end).ok()?;
    source.get(start..end)
}

pub fn inspect_entry(bytes: &[u8]) -> EntryStatus {
    if bytes.len() > MAX_ENTRY_BYTES {
        return EntryStatus::Oversized;
    }
    if from_utf8(bytes).is_err() {
        return EntryStatus::InvalidUtf8;
    }
    match parse_json(bytes) {
        Ok(_) => EntryStatus::Valid,
        Err(error) => EntryStatus::InvalidJson(error),
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
