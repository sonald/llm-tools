use std::str;

use crate::json::{
    parse_json_owned, ChildLocator, JsonKind, JsonNode, ParseError, ParsedJson, SourceSpan,
};

const MAX_LABEL_OR_VALUE_CHARS: usize = 256;
const MAX_PAGE_SIZE: usize = 200;
const MAX_TEXT_CHUNK_BYTES: usize = 128 * 1024;

pub struct TreeDocument {
    parsed: ParsedJson<'static>,
}

impl TreeDocument {
    pub fn from_bytes(input: Vec<u8>) -> Result<TreeDocument, ParseError> {
        Ok(TreeDocument {
            parsed: parse_json_owned(input)?,
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
        let decoded = node.decoded.as_deref()?;
        chunk_text(decoded, offset, requested_len)
    }

    fn projection(&self, id: usize, node: &JsonNode) -> NodeProjection {
        let (label, label_has_more) = match &node.locator {
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
        };

        let value = match node.kind {
            JsonKind::String => node.decoded.as_deref(),
            JsonKind::Number | JsonKind::True | JsonKind::False | JsonKind::Null => Some(
                str::from_utf8(&self.parsed.source()[node.span.start..node.span.end])
                    .expect("JSON source is valid UTF-8"),
            ),
            JsonKind::Object | JsonKind::Array => None,
        };
        let (value_preview, value_has_more) = match value {
            Some(value) => {
                let (preview, has_more) = truncate_chars(value, MAX_LABEL_OR_VALUE_CHARS);
                (Some(preview), has_more)
            }
            None => (None, false),
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
