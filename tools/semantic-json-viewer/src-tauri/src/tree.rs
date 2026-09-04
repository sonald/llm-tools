use std::str;

use crate::json::{
    parse_json_owned, ChildLocator, JsonKind, JsonNode, ParseError, ParsedJson, SourceSpan,
};

const MAX_LABEL_OR_VALUE_CHARS: usize = 256;
const MAX_PAGE_SIZE: usize = 200;

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

fn truncate_chars(value: &str, max_chars: usize) -> (String, bool) {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    let has_more = chars.next().is_some();
    (truncated, has_more)
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
}
