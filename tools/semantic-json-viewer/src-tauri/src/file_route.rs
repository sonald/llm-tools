use std::path::Path;
use std::str::from_utf8;

use crate::json::{parse_json, parse_json_prefix, JsonKind, ParseError};

const FULL_PARSE_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
const SAMPLE_LINE_LIMIT: usize = 200;
const SAMPLE_SIZE_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileMode {
    Document,
    Collection,
    Entry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OpenDecision {
    Open {
        mode: FileMode,
        has_utf8_bom: bool,
        many_invalid_utf8_warning: bool,
    },
    NeedsModeChoice,
    InvalidJson(ParseError),
    UnsupportedEncoding,
    UnsupportedFraming,
}

pub fn route_bytes(path: &Path, reported_size: u64, bytes: &[u8]) -> OpenDecision {
    if has_non_utf8_bom(bytes) {
        return OpenDecision::UnsupportedEncoding;
    }

    if has_record_separator_framing(bytes) {
        return OpenDecision::UnsupportedFraming;
    }

    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("json") => route_json(bytes),
        Some(extension)
            if extension.eq_ignore_ascii_case("jsonl")
                || extension.eq_ignore_ascii_case("ndjson") =>
        {
            route_jsonl(bytes)
        }
        _ => route_unknown(reported_size, bytes),
    }
}

fn route_json(bytes: &[u8]) -> OpenDecision {
    if from_utf8(bytes).is_err() {
        return OpenDecision::UnsupportedEncoding;
    }

    match parse_json(bytes) {
        Ok(parsed) => OpenDecision::Open {
            mode: mode_for_root(parsed.node(parsed.root()).kind),
            has_utf8_bom: has_utf8_bom(bytes),
            many_invalid_utf8_warning: false,
        },
        Err(error) => OpenDecision::InvalidJson(error),
    }
}

fn route_jsonl(bytes: &[u8]) -> OpenDecision {
    let lines = sampled_lines(bytes);

    OpenDecision::Open {
        mode: FileMode::Entry,
        has_utf8_bom: has_utf8_bom(bytes),
        many_invalid_utf8_warning: many_invalid_utf8(&lines),
    }
}

fn route_unknown(reported_size: u64, bytes: &[u8]) -> OpenDecision {
    if reported_size > FULL_PARSE_LIMIT_BYTES {
        return route_unknown_sample(bytes);
    }

    match parse_json(bytes) {
        Ok(parsed) => OpenDecision::Open {
            mode: mode_for_root(parsed.node(parsed.root()).kind),
            has_utf8_bom: has_utf8_bom(bytes),
            many_invalid_utf8_warning: false,
        },
        Err(error) => {
            let lines = sampled_lines(bytes);
            let concatenated = lines.iter().any(|line| {
                parse_json_prefix(line)
                    .is_ok_and(|(_, consumed)| concatenated_json_framing(line, consumed))
            });

            if concatenated {
                return OpenDecision::UnsupportedFraming;
            }

            if detects_jsonl(&lines) {
                OpenDecision::Open {
                    mode: FileMode::Entry,
                    has_utf8_bom: has_utf8_bom(bytes),
                    many_invalid_utf8_warning: many_invalid_utf8(&lines),
                }
            } else if from_utf8(bytes).is_err() {
                OpenDecision::UnsupportedEncoding
            } else {
                OpenDecision::InvalidJson(error)
            }
        }
    }
}

fn route_unknown_sample(bytes: &[u8]) -> OpenDecision {
    let lines = sampled_lines(bytes);
    let concatenated = lines.iter().any(|line| {
        parse_json_prefix(line).is_ok_and(|(_, consumed)| concatenated_json_framing(line, consumed))
    });

    if concatenated {
        OpenDecision::UnsupportedFraming
    } else if detects_jsonl(&lines) {
        OpenDecision::Open {
            mode: FileMode::Entry,
            has_utf8_bom: has_utf8_bom(bytes),
            many_invalid_utf8_warning: many_invalid_utf8(&lines),
        }
    } else {
        OpenDecision::NeedsModeChoice
    }
}

fn mode_for_root(kind: JsonKind) -> FileMode {
    if kind == JsonKind::Array {
        FileMode::Collection
    } else {
        FileMode::Document
    }
}

fn has_utf8_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
}

fn has_non_utf8_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFE, 0xFF])
        || bytes.starts_with(&[0xFF, 0xFE, 0x00, 0x00])
        || bytes.starts_with(&[0xFF, 0xFE])
        || bytes.starts_with(&[0x00, 0x00, 0xFE, 0xFF])
}

fn has_record_separator_framing(bytes: &[u8]) -> bool {
    bytes.first() == Some(&0x1E)
        || sampled_lines(bytes)
            .iter()
            .any(|line| line.first() == Some(&0x1E))
}

fn concatenated_json_framing(bytes: &[u8], consumed: usize) -> bool {
    let Some(next_start) = next_nonwhitespace_start(bytes, consumed) else {
        return false;
    };

    is_json_value_start(bytes[next_start])
        && !bytes[consumed..next_start]
            .iter()
            .any(|byte| matches!(byte, b'\n' | b'\r'))
}

fn next_nonwhitespace_start(bytes: &[u8], mut index: usize) -> Option<usize> {
    while matches!(bytes.get(index), Some(b' ' | b'\t' | b'\r' | b'\n')) {
        index += 1;
    }

    bytes.get(index).copied().map(|_| index)
}

fn is_json_value_start(byte: u8) -> bool {
    matches!(
        byte,
        b'{' | b'[' | b'"' | b'-' | b'0'..=b'9' | b't' | b'f' | b'n'
    )
}

fn sampled_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut sampled_size = 0;

    for line in bytes.split_inclusive(|byte| *byte == b'\n') {
        if line_is_blank(line) {
            continue;
        }
        if lines.len() == SAMPLE_LINE_LIMIT || sampled_size + line.len() > SAMPLE_SIZE_LIMIT {
            break;
        }

        sampled_size += line.len();
        lines.push(line);
    }

    lines
}

fn line_is_blank(line: &[u8]) -> bool {
    line.iter()
        .all(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
}

fn detects_jsonl(lines: &[&[u8]]) -> bool {
    lines.len() >= 2
        && lines.iter().filter(|line| parse_json(line).is_ok()).count() * 10 >= lines.len() * 9
}

fn many_invalid_utf8(lines: &[&[u8]]) -> bool {
    let invalid = lines.iter().filter(|line| from_utf8(line).is_err()).count();
    !lines.is_empty() && invalid * 5 > lines.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(path: &str, size: u64, bytes: &[u8]) -> (FileMode, bool, bool) {
        match route_bytes(Path::new(path), size, bytes) {
            OpenDecision::Open {
                mode,
                has_utf8_bom,
                many_invalid_utf8_warning,
            } => (mode, has_utf8_bom, many_invalid_utf8_warning),
            decision => panic!("expected an open decision, got {decision:?}"),
        }
    }

    #[test]
    fn routes_json_extension_by_root_kind() {
        let document = route_bytes(Path::new("data.json"), 12, b"{\"a\":1}");
        assert_eq!(
            document,
            OpenDecision::Open {
                mode: FileMode::Document,
                has_utf8_bom: false,
                many_invalid_utf8_warning: false,
            }
        );

        let collection = route_bytes(Path::new("data.json"), 2, b"[]");
        assert_eq!(
            collection,
            OpenDecision::Open {
                mode: FileMode::Collection,
                has_utf8_bom: false,
                many_invalid_utf8_warning: false,
            }
        );

        assert!(matches!(
            route_bytes(Path::new("data.json"), 1, b"{"),
            OpenDecision::InvalidJson(_)
        ));
    }

    #[test]
    fn routes_jsonl_and_ndjson_extensions_as_entries() {
        let bytes = b"{}\n[]\n";
        for path in ["records.jsonl", "records.ndjson"] {
            assert_eq!(
                open(path, 6, bytes),
                (FileMode::Entry, false, false),
                "path: {path}"
            );
        }

        assert_eq!(
            open("records.jsonl", 5, b"{}\n\n"),
            (FileMode::Entry, false, false)
        );
        assert_eq!(
            open(
                "records.jsonl",
                b"{\n  \"a\": 1\n}\n".len() as u64,
                b"{\n  \"a\": 1\n}\n"
            ),
            (FileMode::Entry, false, false)
        );
    }

    #[test]
    fn unknown_jsonl_requires_ninety_percent_and_rejects_concatenation() {
        let mut bytes = Vec::new();
        for _ in 0..9 {
            bytes.extend_from_slice(b"{}\n");
        }
        bytes.extend_from_slice(b"not-json\n");
        assert_eq!(
            open("blob", bytes.len() as u64, &bytes),
            (FileMode::Entry, false, false)
        );

        let mut bytes = Vec::new();
        for _ in 0..8 {
            bytes.extend_from_slice(b"{}\n");
        }
        bytes.extend_from_slice(b"not-json\nnot-json\n");
        assert!(matches!(
            route_bytes(Path::new("blob"), bytes.len() as u64, &bytes),
            OpenDecision::InvalidJson(_)
        ));

        for size in [b"{}[]".len() as u64, FULL_PARSE_LIMIT_BYTES + 1] {
            assert_eq!(
                route_bytes(Path::new("blob"), size, b"{}[]"),
                OpenDecision::UnsupportedFraming,
                "reported size: {size}"
            );
        }
    }

    #[test]
    fn routes_unknown_small_inputs_by_content() {
        assert_eq!(
            open("blob", 12, b"{\"a\":1}"),
            (FileMode::Document, false, false)
        );
        assert_eq!(open("blob", 2, b"[]"), (FileMode::Collection, false, false));
        assert_eq!(
            open("blob", 6, b"{}\n[]\n"),
            (FileMode::Entry, false, false)
        );
    }

    #[test]
    fn large_unknown_samples_jsonl_without_full_parse() {
        let bytes = b"{}\n[]\n";
        assert_eq!(
            open("blob", FULL_PARSE_LIMIT_BYTES + 1, bytes),
            (FileMode::Entry, false, false)
        );

        let document_bytes = b"{\"full\":\"parse\"}";
        assert_eq!(
            route_bytes(
                Path::new("blob"),
                FULL_PARSE_LIMIT_BYTES + 1,
                document_bytes
            ),
            OpenDecision::NeedsModeChoice
        );

        let mut lines_201 = Vec::new();
        for _ in 0..=SAMPLE_LINE_LIMIT {
            lines_201.extend_from_slice(b"{}\n");
        }
        assert_eq!(sampled_lines(&lines_201).len(), SAMPLE_LINE_LIMIT);

        let mut line = vec![b'x'; 3 * 1024 * 1024 - 1];
        line.push(b'\n');
        let mut oversized_bytes = line.clone();
        oversized_bytes.extend_from_slice(&line);
        oversized_bytes.extend_from_slice(&line);
        assert_eq!(
            sampled_lines(&oversized_bytes),
            [line.as_slice(), line.as_slice()]
        );
    }

    #[test]
    fn reports_utf8_bom_for_supported_modes() {
        let bytes = b"\xEF\xBB\xBF{}\n[]\n";
        assert_eq!(
            open("records.jsonl", bytes.len() as u64, bytes),
            (FileMode::Entry, true, false)
        );
        assert_eq!(
            open("data.json", 6, b"\xEF\xBB\xBF{}"),
            (FileMode::Document, true, false)
        );
    }

    #[test]
    fn rejects_utf16_and_utf32_boms() {
        let boms = [
            &[0xFE, 0xFF][..],
            &[0xFF, 0xFE],
            &[0xFF, 0xFE, 0x00, 0x00],
            &[0x00, 0x00, 0xFE, 0xFF],
        ];
        for bom in boms {
            for path in ["data.json", "records.jsonl", "blob"] {
                assert_eq!(
                    route_bytes(Path::new(path), 8, bom),
                    OpenDecision::UnsupportedEncoding,
                    "bom: {bom:?}, path: {path}"
                );
            }
        }
    }

    #[test]
    fn rejects_record_separator_framing() {
        let bytes = b"\x1e{}\n\x1e[]\n";
        for path in ["data.json", "records.jsonl", "blob"] {
            assert_eq!(
                route_bytes(Path::new(path), bytes.len() as u64, bytes),
                OpenDecision::UnsupportedFraming,
                "path: {path}"
            );
        }
    }

    #[test]
    fn rejects_invalid_utf8_json_documents() {
        assert_eq!(
            route_bytes(Path::new("data.json"), 2, b"{\xff}"),
            OpenDecision::UnsupportedEncoding
        );
    }

    #[test]
    fn opens_jsonl_with_one_bad_entry_followed_by_valid_entries() {
        let bytes = b"\xff\n{}\n[]\n{}\n[]\n";
        assert_eq!(
            open("records.jsonl", bytes.len() as u64, bytes),
            (FileMode::Entry, false, false)
        );
    }

    #[test]
    fn warns_when_more_than_twenty_percent_of_entries_have_invalid_utf8() {
        let mut bytes = Vec::new();
        for index in 0..10 {
            if index < 3 {
                bytes.extend_from_slice(b"\xff\n");
            } else {
                bytes.extend_from_slice(b"{}\n");
            }
        }

        assert_eq!(
            open("records.jsonl", bytes.len() as u64, &bytes),
            (FileMode::Entry, false, true)
        );
    }
}
