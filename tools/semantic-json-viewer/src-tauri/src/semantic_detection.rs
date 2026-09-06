use dom_query::Document;

use crate::json::{parse_json, JsonKind};

pub(crate) const MAX_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_HEURISTIC_BYTES: usize = 64 * 1024;
pub(crate) const MAX_CUMULATIVE_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const HARD_MAX_DEPTH: u8 = 10;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlainReason {
    Fallback,
    JsonParseFailed,
    SizeLimit,
    DepthLimit,
    CumulativeLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Detection {
    PlainText(PlainReason),
    Markdown,
    NestedJson { next_budget: NestedBudget },
    Code,
    Html,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NestedBudget {
    depth: u8,
    max_depth: u8,
    bytes: usize,
}

impl Default for NestedBudget {
    fn default() -> Self {
        Self {
            depth: 0,
            max_depth: 5,
            bytes: 0,
        }
    }
}

impl NestedBudget {
    pub fn with_max_depth(max_depth: u8) -> Option<Self> {
        (1..=HARD_MAX_DEPTH).contains(&max_depth).then_some(Self {
            max_depth,
            ..Self::default()
        })
    }

    pub fn depth(self) -> u8 {
        self.depth
    }

    pub fn max_depth(self) -> u8 {
        self.max_depth
    }

    pub fn bytes(self) -> usize {
        self.bytes
    }

    pub(crate) fn from_parts(depth: u8, max_depth: u8, bytes: usize) -> Self {
        Self {
            depth,
            max_depth,
            bytes,
        }
    }

    fn valid(self) -> bool {
        (1..=HARD_MAX_DEPTH).contains(&self.max_depth) && self.depth <= self.max_depth
    }
}

pub fn detect(decoded: &str, key: Option<&str>, budget: NestedBudget) -> Detection {
    if decoded.len() > MAX_INPUT_BYTES {
        return Detection::PlainText(PlainReason::SizeLimit);
    }

    let trimmed = decoded.trim();
    if matches!(trimmed.as_bytes().first(), Some(b'{' | b'[')) {
        return detect_nested_json(trimmed, decoded.len(), budget);
    }

    let sample = prefix_at_char_boundary(decoded, MAX_HEURISTIC_BYTES).trim();
    if decoded.len() <= MAX_HEURISTIC_BYTES && looks_like_html(sample) {
        return Detection::Html;
    }
    if has_complete_fenced_block(sample) || looks_like_markdown(sample) {
        return Detection::Markdown;
    }
    if looks_like_code(sample, key) {
        return Detection::Code;
    }
    Detection::PlainText(PlainReason::Fallback)
}

fn detect_nested_json(decoded: &str, input_bytes: usize, budget: NestedBudget) -> Detection {
    if !budget.valid() || budget.depth >= budget.max_depth {
        return Detection::PlainText(PlainReason::DepthLimit);
    }

    let Some(total_bytes) = budget.bytes.checked_add(input_bytes) else {
        return Detection::PlainText(PlainReason::CumulativeLimit);
    };
    if total_bytes > MAX_CUMULATIVE_BYTES {
        return Detection::PlainText(PlainReason::CumulativeLimit);
    }

    match parse_json(decoded.as_bytes()) {
        Ok(parsed) => {
            let kind = parsed.node(parsed.root()).kind;
            if !matches!(kind, JsonKind::Object | JsonKind::Array) {
                return Detection::PlainText(PlainReason::JsonParseFailed);
            }
            Detection::NestedJson {
                next_budget: NestedBudget {
                    depth: budget.depth + 1,
                    max_depth: budget.max_depth,
                    bytes: total_bytes,
                },
            }
        }
        Err(_) => Detection::PlainText(PlainReason::JsonParseFailed),
    }
}

fn prefix_at_char_boundary(input: &str, limit: usize) -> &str {
    let mut end = input.len().min(limit);
    while end > 0 && !input.is_char_boundary(end) {
        end -= 1;
    }
    &input[..end]
}

fn looks_like_html(input: &str) -> bool {
    let candidate = input.trim();
    if candidate.is_empty()
        || !candidate.starts_with('<')
        || candidate.len() > MAX_HEURISTIC_BYTES
        || candidate
            .get(..5)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("<?xml"))
    {
        return false;
    }

    let document = Document::fragment(candidate);
    if !document.errors.borrow().is_empty() {
        return false;
    }

    let root = document.html_root();
    let elements = root.element_children();
    if elements.is_empty() {
        return false;
    }
    if root
        .children()
        .iter()
        .any(|node| node.is_text() && !node.text().trim().is_empty())
    {
        return false;
    }

    if !has_balanced_html_tags(candidate) {
        return false;
    }

    elements
        .iter()
        .copied()
        .chain(elements.iter().flat_map(|element| element.descendants()))
        .filter(|node| node.is_element())
        .all(|element| {
            let Some(name) = element.node_name() else {
                return false;
            };
            let name = name.as_ref();
            !is_ambiguous_generic_tag(candidate, name)
        })
}

fn is_ambiguous_generic_tag(input: &str, name: &str) -> bool {
    if name.len() != 1 {
        return false;
    }
    let Some(opening) = input.trim().strip_prefix('<') else {
        return false;
    };
    let source_name = opening
        .split(|character: char| character.is_ascii_whitespace() || matches!(character, '>' | '/'))
        .next()
        .unwrap_or_default();
    source_name.len() == 1
        && source_name.as_bytes()[0].is_ascii_uppercase()
        && source_name.eq_ignore_ascii_case(name)
}

fn has_balanced_html_tags(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut counts = std::collections::HashMap::<String, (usize, usize)>::new();
    let mut cursor = 0;
    let mut raw_text_tag: Option<String> = None;

    while cursor < bytes.len() {
        if let Some(raw_name) = raw_text_tag.as_deref() {
            let Some(end) = find_raw_text_closing_tag(source, cursor, raw_name) else {
                return false;
            };
            counts.entry(raw_name.to_owned()).or_default().1 += 1;
            raw_text_tag = None;
            cursor = end;
            continue;
        }

        let Some(relative) = bytes[cursor..].iter().position(|byte| *byte == b'<') else {
            break;
        };
        let start = cursor + relative;
        let Some(next) = bytes.get(start + 1).copied() else {
            return false;
        };

        if source[start..].starts_with("<!--") {
            let Some(end) = source[start + 4..].find("-->") else {
                return false;
            };
            cursor = start + 4 + end + 3;
            continue;
        }

        if next == b'!' {
            if !source[start..]
                .get(..8)
                .is_some_and(|token| token.eq_ignore_ascii_case("<!doctype"))
            {
                return false;
            }
            let Some(end) = find_html_tag_end(bytes, start) else {
                return false;
            };
            cursor = end + 1;
            continue;
        }
        if next == b'?' {
            return false;
        }

        let closing = next == b'/';
        let name_start = start + if closing { 2 } else { 1 };
        if !bytes
            .get(name_start)
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        {
            cursor = start + 1;
            continue;
        }
        let Some(end) = find_html_tag_end(bytes, start) else {
            return false;
        };
        let name_end = name_start
            + bytes[name_start..end]
                .iter()
                .take_while(|byte| is_html_name_byte(**byte))
                .count();
        if name_end == name_start || !html_name_boundary(bytes, name_end, end) {
            return false;
        }
        let name = &source[name_start..name_end];
        let key = name.to_ascii_lowercase();

        if closing {
            if bytes[name_end..end]
                .iter()
                .any(|byte| !byte.is_ascii_whitespace())
            {
                return false;
            }
            counts.entry(key).or_default().1 += 1;
        } else {
            let self_closing = is_self_closing_tag(bytes, start, end);
            if !is_void_element(&key) && !self_closing {
                counts.entry(key.clone()).or_default().0 += 1;
                if key == "script" || key == "style" {
                    raw_text_tag = Some(key);
                }
            } else if !is_void_element(&key) {
                counts.entry(key).or_default().0 += 1;
            }
        }
        cursor = end + 1;
    }

    counts.values().all(|(open, close)| open == close)
}

fn find_html_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut quote = None;
    for (offset, byte) in bytes[start + 1..].iter().enumerate() {
        match quote {
            Some(expected) if *byte == expected => quote = None,
            Some(_) => {}
            None if *byte == b'\'' || *byte == b'"' => quote = Some(*byte),
            None if *byte == b'>' => return Some(start + 1 + offset),
            None => {}
        }
    }
    None
}

fn find_raw_text_closing_tag(source: &str, start: usize, name: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    while let Some(relative) = bytes[cursor..].iter().position(|byte| *byte == b'<') {
        let opening = cursor + relative;
        if bytes.get(opening + 1) == Some(&b'/') {
            let name_start = opening + 2;
            let name_end = name_start
                + bytes
                    .get(name_start..)?
                    .iter()
                    .take_while(|byte| is_html_name_byte(**byte))
                    .count();
            if name_end > name_start
                && source[name_start..name_end].eq_ignore_ascii_case(name)
                && html_name_boundary(bytes, name_end, find_html_tag_end(bytes, opening)?)
            {
                let end = find_html_tag_end(bytes, opening)?;
                if bytes[name_end..end]
                    .iter()
                    .all(|byte| byte.is_ascii_whitespace())
                {
                    return Some(end + 1);
                }
            }
        }
        cursor = opening + 1;
    }
    None
}

fn html_name_boundary(bytes: &[u8], name_end: usize, tag_end: usize) -> bool {
    name_end == tag_end
        || bytes
            .get(name_end)
            .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'/')
}

fn is_html_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'_')
}

fn is_self_closing_tag(bytes: &[u8], start: usize, end: usize) -> bool {
    let mut cursor = end;
    while cursor > start && bytes[cursor - 1].is_ascii_whitespace() {
        cursor -= 1;
    }
    cursor > start && bytes[cursor - 1] == b'/'
}

fn is_void_element(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn has_complete_fenced_block(input: &str) -> bool {
    let mut opening: Option<(u8, usize)> = None;
    for line in input.lines() {
        let line = line.trim_start();
        let Some(marker) = line.as_bytes().first().copied() else {
            continue;
        };
        if marker != b'`' && marker != b'~' {
            continue;
        }
        let run = line.bytes().take_while(|byte| *byte == marker).count();
        if run < 3 {
            continue;
        }
        match opening {
            None => opening = Some((marker, run)),
            Some((open_marker, open_run))
                if marker == open_marker && run >= open_run && line[run..].trim().is_empty() =>
            {
                return true;
            }
            Some(_) => {}
        }
    }
    false
}

fn looks_like_markdown(input: &str) -> bool {
    let lines: Vec<&str> = input.lines().collect();
    let heading = lines.iter().any(|line| is_atx_heading(line));
    let quote = lines.iter().any(|line| line.trim_start().starts_with('>'));
    let list_items = lines.iter().filter(|line| is_list_item(line)).count();
    let table = is_markdown_table(&lines);
    heading || quote || list_items >= 2 || table
}

fn is_atx_heading(line: &str) -> bool {
    let text = line.trim_start();
    let hashes = text.bytes().take_while(|byte| *byte == b'#').count();
    (1..=6).contains(&hashes)
        && text
            .as_bytes()
            .get(hashes)
            .is_none_or(|byte| byte.is_ascii_whitespace())
}

fn is_list_item(line: &str) -> bool {
    let text = line.trim_start();
    if text.starts_with("- ") || text.starts_with("+ ") || text.starts_with("* ") {
        return true;
    }
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    digits > 0
        && text.as_bytes().get(digits) == Some(&b'.')
        && text
            .as_bytes()
            .get(digits + 1)
            .is_some_and(u8::is_ascii_whitespace)
}

fn is_markdown_table(lines: &[&str]) -> bool {
    let Some(delimiter_index) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return false;
    };
    let Some(delimiter) = lines.get(delimiter_index + 1) else {
        return false;
    };
    let header = lines[delimiter_index];
    let header_cells = table_cells(header);
    let delimiter_cells = table_cells(delimiter);
    header_cells.len() >= 2
        && header_cells.len() == delimiter_cells.len()
        && delimiter_cells.iter().all(|cell| {
            let cell = cell.trim();
            let cell = cell.strip_prefix(':').unwrap_or(cell);
            let cell = cell.strip_suffix(':').unwrap_or(cell);
            cell.len() >= 3 && cell.bytes().all(|byte| byte == b'-')
        })
}

fn table_cells(line: &str) -> Vec<&str> {
    let mut cells = line.trim().split('|').collect::<Vec<_>>();
    if line.trim_start().starts_with('|') {
        cells.remove(0);
    }
    if line.trim_end().ends_with('|') {
        cells.pop();
    }
    cells
}

fn looks_like_code(input: &str, key: Option<&str>) -> bool {
    let explicit_key = key.is_some_and(|key| {
        key.eq_ignore_ascii_case("code")
            || key.eq_ignore_ascii_case("source")
            || key.eq_ignore_ascii_case("script")
    });
    let syntax = input.lines().any(has_code_syntax);
    if !syntax {
        return false;
    }

    explicit_key
        || input.lines().filter(|line| has_code_syntax(line)).count() >= 2
        || input.lines().any(is_unambiguous_code_line)
}

fn is_unambiguous_code_line(line: &str) -> bool {
    let text = line.trim();
    text.starts_with("#!/")
        || text.contains("#include <")
        || text.contains("fn ") && text.contains('(')
        || text.contains("def ") && text.contains('(')
        || text.contains("function ") && text.contains('(')
        || text.starts_with("package main")
        || text.contains("public static")
}

fn has_code_syntax(line: &str) -> bool {
    let text = line.trim();
    if text.starts_with("#!/")
        || text.contains("#include <")
        || text.contains("fn ") && text.contains('(')
        || text.contains("def ") && text.contains('(') && text.ends_with(':')
        || text.contains("function ") && text.contains('(')
        || text.starts_with("package main")
        || text.contains("public static")
    {
        return true;
    }
    let assignment =
        (text.starts_with("const ") || text.starts_with("let ") || text.starts_with("var "))
            && text.contains('=');
    let call = text.contains('(') && text.contains(')') && text.contains(';');
    let arrow = text.contains("=>") && (text.contains('{') || text.contains(';'));
    assignment || call || arrow
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::*;

    struct GeneratedFixtures {
        path: PathBuf,
    }

    impl GeneratedFixtures {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock is before Unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "semantic-json-viewer-m1-fixtures-{}-{nanos}",
                std::process::id()
            ));
            let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../fixtures/generate-semantic-fixtures.mjs");
            let output = Command::new("node")
                .arg(script)
                .arg(&path)
                .output()
                .expect("node must be available to generate semantic fixtures");
            assert!(
                output.status.success(),
                "semantic fixture generation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            Self { path }
        }

        fn read(&self, name: &str) -> Value {
            let bytes = fs::read(self.path.join(name)).expect("generated fixture must exist");
            serde_json::from_slice(&bytes).expect("generated fixture must be valid JSON")
        }
    }

    impl Drop for GeneratedFixtures {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn pointer_value<'a>(mut value: &'a Value, pointer: &str) -> &'a Value {
        if pointer.is_empty() {
            return value;
        }
        for encoded in pointer
            .strip_prefix('/')
            .expect("ground truth pointer must start with /")
            .split('/')
        {
            let token = encoded.replace("~1", "/").replace("~0", "~");
            value = match value {
                Value::Object(object) => object.get(&token).expect("pointer key must exist"),
                Value::Array(array) => &array[token.parse::<usize>().expect("array index")],
                _ => panic!("pointer traversed a scalar"),
            };
        }
        value
    }

    fn expected_plain_reason(case: &Value) -> PlainReason {
        match case["expected"]["stopReason"].as_str() {
            Some("jsonParseFailed") => PlainReason::JsonParseFailed,
            Some("sizeLimit") => PlainReason::SizeLimit,
            _ => PlainReason::Fallback,
        }
    }

    fn next_json_string(source: &str) -> String {
        serde_json::from_str::<Value>(source)
            .expect("nested fixture layer must be JSON")
            .get("next")
            .and_then(Value::as_str)
            .expect("nested fixture layer must contain a string next")
            .to_owned()
    }

    fn assert_fixture_depth(source: &str, max_depth: u8) {
        let mut current = source.to_owned();
        let mut budget = if max_depth == 5 {
            NestedBudget::default()
        } else {
            NestedBudget::with_max_depth(max_depth).expect("fixture depth must be valid")
        };
        for expected_depth in 0..max_depth {
            let next_budget = match detect(&current, None, budget) {
                Detection::NestedJson { next_budget } => next_budget,
                other => panic!("depth {expected_depth} should parse, got {other:?}"),
            };
            assert_eq!(next_budget.depth(), expected_depth + 1);
            current = next_json_string(&current);
            budget = next_budget;
        }
        assert_eq!(
            detect(&current, None, budget),
            Detection::PlainText(PlainReason::DepthLimit)
        );
    }

    #[test]
    fn generated_f01_and_f02_cases_match_ground_truth() {
        let fixtures = GeneratedFixtures::new();
        let ground_truth = fixtures.read("ground-truth.json");
        let mut checked = 0;
        let mut deep_source = None;
        let mut cumulative_source = None;

        for case in ground_truth["cases"]
            .as_array()
            .expect("ground truth cases must be an array")
        {
            let source = case["source"].as_str().expect("case source");
            if source != "spec-f01" && source != "spec-f02" {
                continue;
            }
            assert_eq!(case["kind"], "string");
            let file = case["file"].as_str().expect("case file");
            let pointer = case["pointer"].as_str().expect("case pointer");
            let decoded = pointer_value(&fixtures.read(file), pointer)
                .as_str()
                .expect("ground truth string pointer")
                .to_owned();
            let detection = detect(&decoded, None, NestedBudget::default());
            match case["expected"]["semanticType"]
                .as_str()
                .expect("semantic type")
            {
                "Plain Text" => assert_eq!(
                    detection,
                    Detection::PlainText(expected_plain_reason(case)),
                    "case {}",
                    case["id"]
                ),
                "Markdown" => assert_eq!(detection, Detection::Markdown, "case {}", case["id"]),
                "HTML" => assert_eq!(detection, Detection::Html, "case {}", case["id"]),
                "Nested JSON" => assert!(
                    matches!(detection, Detection::NestedJson { .. }),
                    "case {}: {detection:?}",
                    case["id"]
                ),
                other => panic!("unsupported M1 fixture type {other}"),
            }
            match case["id"].as_str().expect("case id") {
                "nested-depth-chain" => deep_source = Some(decoded),
                "nested-cumulative-limit" => cumulative_source = Some(decoded),
                _ => {}
            }
            checked += 1;
        }

        assert_eq!(checked, 22);
        let deep_source = deep_source.expect("F-02 depth fixture must be present");
        assert_fixture_depth(&deep_source, 5);
        assert_fixture_depth(&deep_source, 10);

        let mut current = cumulative_source.expect("F-02 cumulative fixture must be present");
        let mut budget = NestedBudget::with_max_depth(10).expect("fixture depth must be valid");
        for _ in 0..5 {
            budget = match detect(&current, None, budget) {
                Detection::NestedJson { next_budget } => next_budget,
                other => panic!("cumulative layer should parse before the sixth: {other:?}"),
            };
            current = next_json_string(&current);
        }
        assert_eq!(
            detect(&current, None, budget),
            Detection::PlainText(PlainReason::CumulativeLimit)
        );
    }

    #[test]
    fn exact_boundaries_are_allowed_and_cumulative_budget_is_checked() {
        assert!(NestedBudget::with_max_depth(0).is_none());
        assert!(NestedBudget::with_max_depth(11).is_none());

        let one_layer = format!("{{\"x\":\"{}\"}}", "x".repeat(2 * 1024 * 1024 - 8));
        assert_eq!(one_layer.len(), 2 * 1024 * 1024);
        assert!(matches!(
            detect(&one_layer, None, NestedBudget::default()),
            Detection::NestedJson { .. }
        ));

        let exact = "{}";
        let budget = NestedBudget::from_parts(0, 5, 8 * 1024 * 1024 - exact.len());
        assert!(matches!(
            detect(exact, None, budget),
            Detection::NestedJson { .. }
        ));
        let over = NestedBudget::from_parts(0, 5, 8 * 1024 * 1024 - exact.len() + 1);
        assert_eq!(
            detect(exact, None, over),
            Detection::PlainText(PlainReason::CumulativeLimit)
        );
    }

    #[test]
    fn heuristic_detection_is_bounded_by_bytes_and_utf8_boundaries() {
        let oversized_html = format!("<p>ok</p>{}", " ".repeat(MAX_HEURISTIC_BYTES));
        assert_eq!(
            detect(&oversized_html, None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );

        let boundary = format!(
            "{}🦀\n# hidden heading",
            "x".repeat(MAX_HEURISTIC_BYTES - 1)
        );
        assert_eq!(
            detect(&boundary, None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
    }

    #[test]
    fn markdown_fence_precedes_code_and_code_key_alone_is_not_enough() {
        assert_eq!(
            detect(
                "```rust\nfn main() {}\n```",
                Some("source"),
                NestedBudget::default()
            ),
            Detection::Markdown
        );
        assert_eq!(
            detect("plain text", Some("SOURCE"), NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
        assert_eq!(
            detect(
                "fn main() { println!(\"ok\"); }",
                Some("SOURCE"),
                NestedBudget::default()
            ),
            Detection::Code
        );
    }

    #[test]
    fn incomplete_html_is_plain_text() {
        assert_eq!(
            detect("<div>unclosed", None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
        assert_eq!(
            detect("Vec<T>", None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
        assert_eq!(
            detect("<div><div></div>", None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
    }

    #[test]
    fn accepts_complete_siblings_and_normalized_html_without_root_text() {
        assert_eq!(
            detect("<p>one</p><p>two</p>", None, NestedBudget::default()),
            Detection::Html
        );
        assert_eq!(
            detect(
                "<DIV class='notice'>ok</DIV>",
                None,
                NestedBudget::default()
            ),
            Detection::Html
        );
        assert_eq!(
            detect("<p title=\"a > b\">one</p>", None, NestedBudget::default()),
            Detection::Html
        );
        assert_eq!(
            detect(
                "<script>const markup = '<div>'; </script>",
                None,
                NestedBudget::default()
            ),
            Detection::Html
        );
        assert_eq!(
            detect(
                "<style>.probe { content: '<div>'; }</style>",
                None,
                NestedBudget::default()
            ),
            Detection::Html
        );
        assert_eq!(
            detect("<p>one</p> trailing text", None, NestedBudget::default()),
            Detection::PlainText(PlainReason::Fallback)
        );
    }
}
