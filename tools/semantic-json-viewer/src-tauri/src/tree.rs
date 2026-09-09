use std::borrow::Cow;
use std::str;

use crate::conversation::{
    self, ConversationCandidate, ConversationStyle, GenericConversationCursor,
    GenericConversationPage,
};
use crate::json::{
    parse_json_owned, ChildLocator, DecodedString, JsonKind, JsonNode, ParseError, ParsedJson,
    SourceSpan,
};
use crate::search::{self, SearchError, SearchPage, SearchRequest};
use crate::semantic_detection::{detect, Detection, NestedBudget, PlainReason, MAX_INPUT_BYTES};

const MAX_LABEL_OR_VALUE_CHARS: usize = 256;
const MAX_PAGE_SIZE: usize = 200;
const MAX_TEXT_CHUNK_BYTES: usize = 128 * 1024;

pub struct TreeDocument {
    parsed: ParsedJson<'static>,
    role_cache: std::sync::Mutex<Option<crate::conversation::RoleCache>>,
}

impl TreeDocument {
    pub fn from_bytes(input: Vec<u8>) -> Result<TreeDocument, ParseError> {
        Ok(TreeDocument {
            parsed: parse_json_owned(input)?,
            role_cache: std::sync::Mutex::new(None),
        })
    }

    pub fn root(&self) -> NodeProjection {
        let root_id = self.parsed.root();
        self.projection(root_id.index(), self.parsed.node(root_id))
    }

    pub fn node(&self, id: usize) -> Option<NodeProjection> {
        self.parsed
            .node_at(id)
            .map(|node| self.projection(id, node))
    }

    pub fn children(&self, parent_id: usize, cursor: usize, limit: usize) -> Option<NodePage> {
        if limit == 0 {
            return None;
        }

        let parent = self.parsed.node_at(parent_id)?;
        let child_count = parent.children.len();
        if cursor > child_count {
            return None;
        }

        let page_size = limit.min(MAX_PAGE_SIZE);
        let end = (cursor + page_size).min(child_count);
        let nodes = parent.children[cursor..end]
            .iter()
            .map(|&child| self.projection(child.index(), self.parsed.node(child)))
            .collect();
        let has_more = end < child_count;

        Some(NodePage {
            nodes,
            has_more,
            next_cursor: has_more.then_some(end),
        })
    }

    pub fn read_raw_text(&self, offset: usize, requested_len: usize) -> Option<TextChunk> {
        let source = str::from_utf8(self.parsed.source()).ok()?;
        chunk_text(source, offset, requested_len)
    }

    pub fn read_decoded_text(
        &self,
        node_id: usize,
        offset: usize,
        requested_len: usize,
    ) -> Option<TextChunk> {
        let node = self.parsed.node_at(node_id)?;
        if node.kind != JsonKind::String {
            return None;
        }
        let decoded = self.parsed.decoded_string_at(node_id)?;
        chunk_decoded_text(decoded, offset, requested_len)
    }

    pub fn detect_string(&self, node_id: usize) -> Option<Detection> {
        self.detect_string_with_budget(node_id, NestedBudget::default())
    }

    pub fn decoded_text(&self, node_id: usize) -> Option<Cow<'_, str>> {
        let node = self.parsed.node_at(node_id)?;
        if node.kind != JsonKind::String {
            return None;
        }
        self.parsed
            .decoded_string_at(node_id)
            .map(DecodedString::to_cow)
    }

    pub fn decoded_text_limited(&self, node_id: usize, max_bytes: usize) -> Option<Cow<'_, str>> {
        let node = self.parsed.node_at(node_id)?;
        if node.kind != JsonKind::String {
            return None;
        }
        self.parsed
            .decoded_string_at(node_id)
            .and_then(|decoded| decoded.to_cow_limit(max_bytes))
    }

    pub fn decoded_text_len(&self, node_id: usize) -> Option<usize> {
        self.parsed
            .decoded_string_at(node_id)
            .map(DecodedString::decoded_len)
    }

    pub fn string_metrics(&self, node_id: usize) -> Option<StringMetrics> {
        let decoded = self.parsed.decoded_string_at(node_id)?;
        let mut character_count = 0usize;
        let mut line_count = 1usize;
        let mut previous_was_cr = false;
        let mut decoded_bytes = 0usize;
        for scalar in decoded.iter() {
            let character = scalar.value;
            character_count += 1;
            decoded_bytes = scalar.end;
            match character {
                '\r' => {
                    line_count += 1;
                    previous_was_cr = true;
                }
                '\n' => {
                    if !previous_was_cr {
                        line_count += 1;
                    }
                    previous_was_cr = false;
                }
                _ => previous_was_cr = false,
            }
        }
        Some(StringMetrics {
            decoded_bytes,
            character_count,
            line_count,
        })
    }

    pub fn raw_text(&self, node_id: usize) -> Option<&str> {
        let node = self.parsed.node_at(node_id)?;
        str::from_utf8(&self.parsed.source()[node.span.start..node.span.end]).ok()
    }

    pub fn path(&self, node_id: usize) -> Option<String> {
        let mut ids = Vec::new();
        let mut current = Some(node_id);
        while let Some(id) = current {
            let node = self.parsed.node_at(id)?;
            ids.push(id);
            current = node.parent.map(|parent| parent.index());
        }
        ids.reverse();

        let mut path = String::from("$");
        for id in ids.into_iter().skip(1) {
            let node = self.parsed.node_at(id)?;
            match &node.locator {
                ChildLocator::Root => return None,
                ChildLocator::ArrayIndex(index) => {
                    path.push('[');
                    path.push_str(&index.to_string());
                    path.push(']');
                }
                ChildLocator::ObjectKey {
                    key, occurrence, ..
                } => {
                    if is_simple_path_key(key) {
                        path.push('.');
                        path.push_str(key);
                    } else {
                        path.push_str("[\"");
                        append_json_string(&mut path, key);
                        path.push_str("\"]");
                    }
                    if *occurrence > 1 {
                        path.push('#');
                        path.push_str(&occurrence.to_string());
                    }
                }
            }
        }
        Some(path)
    }

    pub fn detect_string_with_budget(
        &self,
        node_id: usize,
        budget: NestedBudget,
    ) -> Option<Detection> {
        let node = self.parsed.node_at(node_id)?;
        if node.kind != JsonKind::String {
            return None;
        }
        let decoded = self.parsed.decoded_string_at(node_id)?;
        let decoded = match decoded.to_cow_limit(MAX_INPUT_BYTES) {
            Some(decoded) => decoded,
            None => return Some(Detection::PlainText(PlainReason::SizeLimit)),
        };
        let key = match &node.locator {
            ChildLocator::ObjectKey { key, .. } => Some(key.as_str()),
            ChildLocator::Root | ChildLocator::ArrayIndex(_) => None,
        };
        Some(detect(decoded.as_ref(), key, budget))
    }

    pub fn search(&self, request: SearchRequest) -> Result<SearchPage, SearchError> {
        search::search(&self.parsed, request)
    }

    pub fn conversation_candidate(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
    ) -> Option<ConversationCandidate> {
        conversation::detect_candidate(&self.parsed, scope_root_id, candidate_node_id)
    }

    pub fn generic_conversation_page(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
        cursor: Option<GenericConversationCursor>,
        limit: usize,
    ) -> Option<GenericConversationPage> {
        self.conversation_page(
            scope_root_id,
            candidate_node_id,
            cursor,
            limit,
            ConversationStyle::Generic,
        )
    }

    pub fn conversation_page(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
        cursor: Option<GenericConversationCursor>,
        limit: usize,
        style: ConversationStyle,
    ) -> Option<GenericConversationPage> {
        conversation::conversation_page_with_role_cache(
            &self.parsed,
            scope_root_id,
            candidate_node_id,
            cursor,
            limit,
            style,
            &self.role_cache,
        )
    }

    fn projection(&self, id: usize, node: &JsonNode) -> NodeProjection {
        let (label, label_has_more) = node_label(&node.locator);

        let (value_preview, value_has_more) = match node.kind {
            JsonKind::String => self
                .parsed
                .decoded_string_at(id)
                .map(|decoded| {
                    let (preview, has_more) = decoded.prefix_chars(MAX_LABEL_OR_VALUE_CHARS);
                    (Some(preview), has_more)
                })
                .unwrap_or((None, false)),
            JsonKind::Number | JsonKind::True | JsonKind::False | JsonKind::Null => {
                let value = str::from_utf8(&self.parsed.source()[node.span.start..node.span.end])
                    .expect("JSON source is valid UTF-8");
                let (preview, has_more) = truncate_chars(value, MAX_LABEL_OR_VALUE_CHARS);
                (Some(preview), has_more)
            }
            JsonKind::Object | JsonKind::Array => (None, false),
        };

        NodeProjection {
            id,
            kind: node.kind,
            span: node.span,
            label,
            label_has_more,
            value_preview,
            value_has_more,
            child_count: node.children.len(),
        }
    }
}

fn is_simple_path_key(key: &str) -> bool {
    !key.is_empty()
        && key.chars().all(|character| {
            character == '_' || character == '$' || character.is_ascii_alphanumeric()
        })
        && !key.starts_with(|character: char| character.is_ascii_digit())
}

fn append_json_string(output: &mut String, value: &str) {
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            '\u{08}' => output.push_str("\\b"),
            '\u{0c}' => output.push_str("\\f"),
            character if character.is_control() => {
                use std::fmt::Write;
                write!(output, "\\u{:04x}", character as u32)
                    .expect("writing to String cannot fail");
            }
            character => output.push(character),
        }
    }
}

fn node_label(locator: &ChildLocator) -> (String, bool) {
    match locator {
        ChildLocator::Root => ("$".to_owned(), false),
        ChildLocator::ArrayIndex(index) => (format!("[{index}]"), false),
        ChildLocator::ObjectKey {
            key, occurrence: 1, ..
        } => {
            let (label, label_has_more) = truncate_chars(key, MAX_LABEL_OR_VALUE_CHARS);
            (label, label_has_more)
        }
        ChildLocator::ObjectKey {
            key, occurrence, ..
        } => {
            let suffix = format!("#{occurrence}");
            let key_limit = MAX_LABEL_OR_VALUE_CHARS.saturating_sub(suffix.chars().count());
            let (mut label, label_has_more) = truncate_chars(key, key_limit);
            label.push_str(&suffix);
            (label, label_has_more)
        }
    }
}

pub struct NodeProjection {
    pub id: usize,
    pub kind: JsonKind,
    pub span: SourceSpan,
    pub label: String,
    pub label_has_more: bool,
    pub value_preview: Option<String>,
    pub value_has_more: bool,
    pub child_count: usize,
}

pub struct NodePage {
    pub nodes: Vec<NodeProjection>,
    pub has_more: bool,
    pub next_cursor: Option<usize>,
}

pub struct TextChunk {
    pub start: usize,
    pub text: String,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StringMetrics {
    pub decoded_bytes: usize,
    pub character_count: usize,
    pub line_count: usize,
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    let has_more = chars.next().is_some();
    (truncated, has_more)
}

fn chunk_text(text: &str, offset: usize, requested_len: usize) -> Option<TextChunk> {
    if requested_len == 0 || offset > text.len() || !text.is_char_boundary(offset) {
        return None;
    }
    if offset == text.len() {
        return Some(TextChunk {
            start: offset,
            text: String::new(),
            has_more: false,
            next_offset: None,
        });
    }

    let remaining = text.len() - offset;
    let mut end = offset + requested_len.min(MAX_TEXT_CHUNK_BYTES).min(remaining);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == offset {
        return None;
    }

    let has_more = end < text.len();
    Some(TextChunk {
        start: offset,
        text: text[offset..end].to_owned(),
        has_more,
        next_offset: has_more.then_some(end),
    })
}

fn chunk_decoded_text(
    decoded: DecodedString<'_>,
    offset: usize,
    requested_len: usize,
) -> Option<TextChunk> {
    if requested_len == 0 {
        return None;
    }

    let byte_limit = requested_len.min(MAX_TEXT_CHUNK_BYTES);
    let mut iterator = decoded.iter();
    let mut last_end = 0usize;
    let mut started = false;
    let mut output = String::new();
    let mut end = offset;

    while let Some(scalar) = iterator.next() {
        last_end = scalar.end;
        if !started {
            if scalar.end <= offset {
                continue;
            }
            if scalar.start != offset {
                return None;
            }
            started = true;
        }

        let next_len = output.len().checked_add(scalar.value.len_utf8())?;
        if next_len > byte_limit {
            if output.is_empty() {
                return None;
            }
            return Some(TextChunk {
                start: offset,
                text: output,
                has_more: true,
                next_offset: Some(end),
            });
        }
        output.push(scalar.value);
        end = scalar.end;

        if output.len() == byte_limit {
            let has_more = iterator.next().is_some();
            return Some(TextChunk {
                start: offset,
                text: output,
                has_more,
                next_offset: has_more.then_some(end),
            });
        }
    }

    if !started {
        return (last_end == offset).then_some(TextChunk {
            start: offset,
            text: String::new(),
            has_more: false,
            next_offset: None,
        });
    }

    Some(TextChunk {
        start: offset,
        text: output,
        has_more: false,
        next_offset: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(input: &str) -> TreeDocument {
        TreeDocument::from_bytes(input.as_bytes().to_vec()).unwrap()
    }

    #[test]
    fn exposes_root_and_scalar_preview() {
        let tree = document(r#"{"name":"Ada","big":123456789012345678901234567890}"#);
        let root = tree.root();
        assert_eq!(root.label, "$");
        assert_eq!(root.child_count, 2);

        let children = tree.children(root.id, 0, 10).unwrap();
        assert_eq!(children.nodes[1].label, "big");
        assert_eq!(
            children.nodes[1].value_preview.as_deref(),
            Some("123456789012345678901234567890")
        );
        assert!(!children.nodes[1].value_has_more);
    }

    #[test]
    fn labels_duplicate_object_keys_by_occurrence() {
        let tree = document(r#"{"key":1,"key":2,"key":3}"#);
        let page = tree.children(tree.root().id, 0, 10).unwrap();
        let labels: Vec<_> = page.nodes.iter().map(|node| node.label.as_str()).collect();
        assert_eq!(labels, ["key", "key#2", "key#3"]);
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn preserves_suffix_when_truncating_long_duplicate_keys() {
        let key = "k".repeat(300);
        let tree = document(&format!(r#"{{"{key}":1,"{key}":2}}"#));
        let page = tree.children(tree.root().id, 0, 10).unwrap();

        assert_eq!(page.nodes[1].label.chars().count(), 256);
        assert!(page.nodes[1].label.ends_with("#2"));
        assert!(page.nodes[1].label_has_more);
    }

    #[test]
    fn limits_pages_to_200_children() {
        let items = "0,".repeat(204);
        let tree = document(&format!("[{}0]", items));
        let root = tree.root();
        assert_eq!(root.child_count, 205);

        let first = tree.children(root.id, 0, 300).unwrap();
        assert_eq!(first.nodes.len(), 200);
        assert_eq!(first.nodes[0].label, "[0]");
        assert_eq!(first.nodes[199].label, "[199]");
        assert!(first.has_more);
        assert_eq!(first.next_cursor, Some(200));

        let second = tree
            .children(root.id, first.next_cursor.unwrap(), 300)
            .unwrap();
        assert_eq!(second.nodes.len(), 5);
        assert!(!second.has_more);
        assert_eq!(second.next_cursor, None);
    }

    #[test]
    fn truncates_unicode_scalars_for_labels_and_values() {
        let key = "é".repeat(300);
        let value = "🦀".repeat(300);
        let input = format!(r#"{{"{key}":"{value}"}}"#);
        let tree = document(&input);

        let root = tree.root();
        let child = tree.children(root.id, 0, 10).unwrap().nodes.remove(0);
        assert_eq!(child.label.chars().count(), 256);
        assert!(child.label_has_more);
        let preview = child.value_preview.unwrap();
        assert_eq!(preview.chars().count(), 256);
        assert!(child.value_has_more);
    }

    #[test]
    fn rejects_invalid_json_ids_cursors_and_limits() {
        let tree = document(r#"{"a":[1,2,3]}"#);
        let root = tree.root();

        assert!(TreeDocument::from_bytes(b"{".to_vec()).is_err());
        assert!(tree.node(99).is_none());
        assert!(tree.children(root.id, 1, 10).unwrap().nodes.is_empty());
        assert!(tree.children(root.id, 2, 10).is_none());
        assert!(tree.children(root.id, 0, 0).is_none());
    }

    #[test]
    fn reads_raw_text_with_original_escapes_and_decoded_text_separately() {
        let tree = document(r#"["a\né"]"#);
        let node = tree.node(1).unwrap();

        let raw = tree.read_raw_text(2, 5).unwrap();
        assert_eq!(raw.start, 2);
        assert_eq!(raw.text, r"a\né");
        assert!(raw.has_more);
        assert_eq!(raw.next_offset, Some(7));

        let raw_end = tree.read_raw_text(7, 1).unwrap();
        assert_eq!(raw_end.text, "\"");
        assert!(raw_end.has_more);
        assert_eq!(raw_end.next_offset, Some(8));

        let decoded = tree.read_decoded_text(node.id, 0, 4).unwrap();
        assert_eq!(decoded.start, 0);
        assert_eq!(decoded.text, "a\né");
        assert!(!decoded.has_more);
        assert_eq!(decoded.next_offset, None);
    }

    #[test]
    fn escaped_decoded_chunks_match_literal_chunks_at_scalar_boundaries() {
        let literal = document("[\"a😀b\"]");
        let escaped = document(r#"["a\ud83d\ude00b"]"#);

        for tree in [&literal, &escaped] {
            let first = tree.read_decoded_text(1, 0, 3).unwrap();
            assert_eq!(first.text, "a");
            assert!(first.has_more);
            assert_eq!(first.next_offset, Some(1));

            let second = tree
                .read_decoded_text(1, first.next_offset.unwrap(), 4)
                .unwrap();
            assert_eq!(second.text, "😀");
            assert!(second.has_more);
            assert_eq!(second.next_offset, Some(5));

            let tail = tree
                .read_decoded_text(1, second.next_offset.unwrap(), 1)
                .unwrap();
            assert_eq!(tail.text, "b");
            assert!(!tail.has_more);
            assert_eq!(tail.next_offset, None);

            let end = tree.read_decoded_text(1, 6, 1).unwrap();
            assert!(end.text.is_empty());
            assert!(!end.has_more);
            assert_eq!(end.next_offset, None);
            assert!(tree.read_decoded_text(1, 2, 1).is_none());
        }
    }

    #[test]
    fn string_metrics_count_decoded_scalars_and_line_endings() {
        let cases = [
            ("", 0, 0, 1),
            ("ASCII", 5, 5, 1),
            ("你😀é", 10, 4, 1),
            (r#"\r\nX\rY\n"#, 6, 6, 4),
            (r#"\ud83d\ude00"#, 4, 1, 1),
        ];
        for (source, decoded_bytes, character_count, line_count) in cases {
            let tree = document(&format!(r#"["{source}"]"#));
            let node = tree.node(1).unwrap();
            let metrics = tree.string_metrics(node.id).unwrap();
            assert_eq!(metrics.decoded_bytes, decoded_bytes, "{source:?}");
            assert_eq!(metrics.character_count, character_count, "{source:?}");
            assert_eq!(metrics.line_count, line_count, "{source:?}");
        }
    }

    #[test]
    fn string_metrics_scan_full_strings_beyond_the_text_page_limit() {
        let value = "a".repeat(200_000);
        let tree = document(&format!(r#"["{value}"]"#));
        let metrics = tree.string_metrics(1).unwrap();
        assert_eq!(metrics.decoded_bytes, 200_000);
        assert_eq!(metrics.character_count, 200_000);
        assert_eq!(metrics.line_count, 1);
    }

    #[test]
    fn string_metrics_scan_escaped_scalars_without_changing_the_counts() {
        let value = r#"\u0061"#.repeat(200_000);
        let tree = document(&format!(r#"["{value}"]"#));
        let metrics = tree.string_metrics(1).unwrap();
        assert_eq!(metrics.decoded_bytes, 200_000);
        assert_eq!(metrics.character_count, 200_000);
        assert_eq!(metrics.line_count, 1);
    }

    #[test]
    fn string_metrics_reject_non_string_nodes() {
        let tree = document(r#"[42]"#);
        assert!(tree.string_metrics(1).is_none());
    }

    #[test]
    fn exposes_full_copy_raw_and_unambiguous_paths() {
        let tree = document(r#"{"normal":"\u4f60\u597d","a.b":1,"a.b":2,"":3,"quote\"key":4}"#);
        let children = tree.children(tree.root().id, 0, 10).unwrap();
        assert_eq!(
            tree.raw_text(children.nodes[0].id),
            Some(r#""\u4f60\u597d""#)
        );
        assert_eq!(tree.path(children.nodes[0].id), Some("$.normal".to_owned()));
        assert_eq!(
            tree.path(children.nodes[1].id),
            Some(r#"$["a.b"]"#.to_owned())
        );
        assert_eq!(
            tree.path(children.nodes[2].id),
            Some(r#"$["a.b"]#2"#.to_owned())
        );
        assert_eq!(tree.path(children.nodes[3].id), Some(r#"$[""]"#.to_owned()));
        assert_eq!(
            tree.path(children.nodes[4].id),
            Some(r#"$["quote\"key"]"#.to_owned())
        );
    }

    #[test]
    fn paginates_text_at_128_kib() {
        let value = "a".repeat(200_000);
        let tree = document(&format!(r#"["{value}"]"#));
        let node = tree.node(1).unwrap();

        let first = tree.read_decoded_text(node.id, 0, usize::MAX).unwrap();
        assert_eq!(first.text.len(), MAX_TEXT_CHUNK_BYTES);
        assert!(first.has_more);
        assert_eq!(first.next_offset, Some(MAX_TEXT_CHUNK_BYTES));

        let second = tree
            .read_decoded_text(node.id, first.next_offset.unwrap(), usize::MAX)
            .unwrap();
        assert_eq!(second.start, MAX_TEXT_CHUNK_BYTES);
        assert_eq!(second.text.len(), 200_000 - MAX_TEXT_CHUNK_BYTES);
        assert!(!second.has_more);
        assert_eq!(second.next_offset, None);
    }

    #[test]
    fn rejects_chunks_that_cannot_contain_a_complete_scalar() {
        let tree = document(r#"["😀😀"]"#);
        let node = tree.node(1).unwrap();

        assert!(tree.read_decoded_text(node.id, 0, 1).is_none());
        let first = tree.read_decoded_text(node.id, 0, 5).unwrap();
        assert_eq!(first.text.len(), 4);
        assert_eq!(first.text, "😀");
        assert!(first.has_more);
        assert_eq!(first.next_offset, Some(4));

        let second = tree.read_decoded_text(node.id, 4, 5).unwrap();
        assert_eq!(second.start, 4);
        assert_eq!(second.text, "😀");
        assert!(!second.has_more);
        assert_eq!(second.next_offset, None);
    }

    #[test]
    fn rejects_invalid_text_chunk_requests() {
        let tree = document(r#"["😀😀"]"#);
        let root = tree.root();
        let node = tree.node(1).unwrap();
        let decoded_len = "😀😀".len();

        assert!(tree.read_raw_text(0, 0).is_none());
        assert!(tree.read_decoded_text(node.id, 0, 0).is_none());
        assert!(tree.node(99).is_none());
        assert!(tree.read_decoded_text(99, 0, 1).is_none());
        assert!(tree.read_decoded_text(root.id, 0, 1).is_none());
        assert!(tree
            .read_raw_text(tree.parsed.source().len() + 1, 1)
            .is_none());
        assert!(tree
            .read_decoded_text(node.id, decoded_len + 1, 1)
            .is_none());
        assert!(tree.read_decoded_text(node.id, 1, 1).is_none());
    }

    #[test]
    fn returns_empty_chunks_at_end_of_text() {
        let tree = document(r#"["😀😀"]"#);
        let node = tree.node(1).unwrap();
        let decoded_len = "😀😀".len();

        let raw = tree.read_raw_text(tree.parsed.source().len(), 1).unwrap();
        assert_eq!(raw.start, tree.parsed.source().len());
        assert!(raw.text.is_empty());
        assert!(!raw.has_more);
        assert_eq!(raw.next_offset, None);

        let decoded = tree.read_decoded_text(node.id, decoded_len, 1).unwrap();
        assert_eq!(decoded.start, decoded_len);
        assert!(decoded.text.is_empty());
        assert!(!decoded.has_more);
        assert_eq!(decoded.next_offset, None);
    }
}
