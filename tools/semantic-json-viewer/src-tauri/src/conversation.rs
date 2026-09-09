use crate::json::{ChildLocator, JsonKind, JsonNode, ParsedJson, SourceSpan};

const CANDIDATE_FIELDS: [&str; 3] = ["messages", "conversation", "conversations"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationKind {
    None,
    Possible,
    Generic,
    OpenAi,
    Anthropic,
    Mixed,
}

impl ConversationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Possible => "possible",
            Self::Generic => "generic",
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
            Self::Mixed => "mixed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationCandidate {
    pub node_id: usize,
    pub span: SourceSpan,
    pub message_count: usize,
    pub kind: ConversationKind,
}

/// Detect one explicitly selected candidate.
///
/// `scope_root_id` is the document/entry root or a direct item of a root
/// collection. For an object scope the candidate must be one of its direct
/// `messages`/`conversation`/`conversations` arrays. For an array scope the
/// scope itself is the candidate. This keeps duplicate candidate fields
/// explicit and prevents an unbounded scan of collection items.
pub fn detect_candidate(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
) -> Option<ConversationCandidate> {
    let scope_root = parsed.node_at(scope_root_id)?;
    if scope_root_id != parsed.root().index() && !is_direct_collection_item(parsed, scope_root_id) {
        return None;
    }

    if scope_root_id == candidate_node_id && scope_root.kind == JsonKind::Array {
        return Some(candidate_for_array(parsed, candidate_node_id));
    }
    if scope_root.kind != JsonKind::Object {
        return None;
    }

    let candidate = parsed.node_at(candidate_node_id)?;
    let is_direct_named_array = candidate.parent.map(|parent| parent.index())
        == Some(scope_root_id)
        && candidate.kind == JsonKind::Array
        && match &candidate.locator {
            ChildLocator::ObjectKey { key, .. } => CANDIDATE_FIELDS.contains(&key.as_str()),
            ChildLocator::Root | ChildLocator::ArrayIndex(_) => false,
        };
    is_direct_named_array.then(|| candidate_for_array(parsed, candidate_node_id))
}

fn is_direct_collection_item(parsed: &ParsedJson<'_>, node_id: usize) -> bool {
    let Some(node) = parsed.node_at(node_id) else {
        return false;
    };
    let Some(parent) = node.parent else {
        return false;
    };
    parent.index() == parsed.root().index() && parsed.node(parent).kind == JsonKind::Array
}

fn candidate_for_array(parsed: &ParsedJson<'_>, node_id: usize) -> ConversationCandidate {
    let node = parsed
        .node_at(node_id)
        .expect("candidate array node must exist");
    let kind = classify_array(parsed, node);
    ConversationCandidate {
        node_id,
        span: node.span,
        message_count: node.children.len(),
        kind,
    }
}

#[derive(Default)]
struct Metrics {
    object_count: usize,
    role_key_count: usize,
    recognized_role_count: usize,
    content_or_tool_count: usize,
    possible_signal: bool,
    openai_signal: bool,
    anthropic_signal: bool,
}

fn classify_array(parsed: &ParsedJson<'_>, array: &JsonNode) -> ConversationKind {
    let count = array.children.len();
    let mut metrics = Metrics::default();
    for &child_id in &array.children {
        let child = parsed.node(child_id);
        if child.kind != JsonKind::Object {
            continue;
        }
        metrics.object_count += 1;
        inspect_message(parsed, child, &mut metrics);
    }

    let strong_kind = match (metrics.openai_signal, metrics.anthropic_signal) {
        (true, true) => Some(ConversationKind::Mixed),
        (true, false) => Some(ConversationKind::OpenAi),
        (false, true) => Some(ConversationKind::Anthropic),
        (false, false) => None,
    };
    if let Some(kind) = strong_kind {
        return kind;
    }

    if count >= 2 {
        let required = required_ratio(count);
        let generic = metrics.object_count >= required
            && metrics.role_key_count >= required
            && metrics.recognized_role_count >= required
            && metrics.content_or_tool_count >= required;
        if generic {
            return ConversationKind::Generic;
        }
    }

    let possible = metrics.possible_signal;
    possible
        .then_some(ConversationKind::Possible)
        .unwrap_or(ConversationKind::None)
}

fn required_ratio(count: usize) -> usize {
    // ceil(4 * count / 5) == count - floor(count / 5), without overflow.
    count - count / 5
}

fn inspect_message(parsed: &ParsedJson<'_>, message: &JsonNode, metrics: &mut Metrics) {
    let mut role_key = false;
    let mut recognized_role = false;
    let mut content_or_tool = false;
    let mut openai_signal = false;
    for &child_id in &message.children {
        let child = parsed.node(child_id);
        let Some(key) = object_key(child) else {
            continue;
        };
        match key {
            "role" | "from" => {
                role_key = true;
                if let Some(value) = string_value(child) {
                    if is_recognized_role(value) {
                        recognized_role = true;
                    }
                }
            }
            "content" | "value" => {
                content_or_tool = true;
            }
            "tool_calls" | "function_call" | "tool_call_id" => {
                content_or_tool = true;
                openai_signal = true;
            }
            _ => {}
        }
    }

    // Every role/from discriminator participates in the strong-signal OR;
    // a later ordinary role must not erase a developer/tool/function role.
    for &child_id in &message.children {
        let child = parsed.node(child_id);
        let Some(key) = object_key(child) else {
            continue;
        };
        if key == "role" && matches!(string_value(child), Some("developer" | "tool" | "function")) {
            openai_signal = true;
        }
    }

    // Anthropic is identified by explicit content block discriminators only.
    // In particular, model names and a plain role/content pair are not enough.
    for &child_id in &message.children {
        let child = parsed.node(child_id);
        if object_key(child) != Some("content") || child.kind != JsonKind::Array {
            continue;
        }
        for &block_id in &child.children {
            let block = parsed.node(block_id);
            if block.kind != JsonKind::Object {
                continue;
            }
            let Some(type_node) = direct_child_by_key(parsed, block, "type") else {
                continue;
            };
            let Some(block_type) = string_value(type_node) else {
                continue;
            };
            if matches!(
                block_type,
                "tool_use" | "tool_result" | "thinking" | "redacted_thinking"
            ) {
                metrics.anthropic_signal = true;
                content_or_tool = true;
            }
        }
    }

    if role_key {
        metrics.role_key_count += 1;
    }
    if recognized_role {
        metrics.recognized_role_count += 1;
    }
    if content_or_tool {
        metrics.content_or_tool_count += 1;
    }
    if recognized_role && content_or_tool {
        metrics.possible_signal = true;
    }
    metrics.openai_signal |= openai_signal;
}

fn direct_child_by_key<'a>(
    parsed: &'a ParsedJson<'_>,
    object: &'a JsonNode,
    wanted: &str,
) -> Option<&'a JsonNode> {
    object
        .children
        .iter()
        .map(|id| parsed.node(*id))
        .find(|node| object_key(node) == Some(wanted))
}

fn object_key(node: &JsonNode) -> Option<&str> {
    match &node.locator {
        ChildLocator::ObjectKey { key, .. } => Some(key.as_str()),
        ChildLocator::Root | ChildLocator::ArrayIndex(_) => None,
    }
}

fn string_value(node: &JsonNode) -> Option<&str> {
    (node.kind == JsonKind::String)
        .then(|| node.decoded.as_deref())
        .flatten()
}

fn is_recognized_role(value: &str) -> bool {
    matches!(
        value,
        "system"
            | "developer"
            | "user"
            | "assistant"
            | "tool"
            | "function"
            | "human"
            | "gpt"
            | "bot"
            | "model"
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::json::parse_json;

    fn kind(input: &str) -> ConversationKind {
        let parsed = parse_json(input.as_bytes()).unwrap();
        let root = parsed.root().index();
        let root_node = parsed.node(parsed.root());
        let candidate = if root_node.kind == JsonKind::Array {
            root
        } else {
            root_node
                .children
                .iter()
                .copied()
                .find(|id| {
                    let node = parsed.node(*id);
                    matches!(&node.locator, ChildLocator::ObjectKey { key, .. } if CANDIDATE_FIELDS.contains(&key.as_str()))
                })
                .expect("test object has a candidate field")
                .index()
        };
        detect_candidate(&parsed, root, candidate).unwrap().kind
    }

    #[test]
    fn recognizes_openai_only_from_specific_signals() {
        assert_eq!(
            kind(
                r#"{"messages":[{"role":"user","content":"x"},{"role":"assistant","tool_calls":[{"function":{"name":"f","arguments":"{}"}}]}]}"#
            ),
            ConversationKind::OpenAi
        );
        assert_eq!(
            kind(
                r#"{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}],"model":"claude-3"}"#
            ),
            ConversationKind::Generic
        );
        assert_eq!(
            kind(r#"{"messages":[{"from":"tool","value":"x"},{"from":"human","value":"y"}]}"#),
            ConversationKind::Generic
        );
        assert_eq!(
            kind(
                r#"{"messages":[{"role":"developer","role":"user","content":"x"},{"role":"assistant","content":"y"}]}"#
            ),
            ConversationKind::OpenAi
        );
    }

    #[test]
    fn recognizes_anthropic_only_from_explicit_blocks() {
        assert_eq!(
            kind(
                r#"{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":[{"type":"thinking","thinking":"x"}]}]}"#
            ),
            ConversationKind::Anthropic
        );
        assert_eq!(
            kind(
                r#"{"system":"x","messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}"#
            ),
            ConversationKind::Generic
        );
    }

    #[test]
    fn uses_exact_ceil_four_fifths_thresholds() {
        assert_eq!(
            kind(r#"[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]"#),
            ConversationKind::Generic
        );
        assert_eq!(
            kind(
                r#"[{"role":"user","content":"a"},{"role":"assistant","content":"b"},{"speaker":"x","text":"c"},{"speaker":"y","text":"d"}]"#
            ),
            ConversationKind::Possible
        );
    }

    #[test]
    fn detects_possible_with_array_value_without_global_veto() {
        assert_eq!(
            kind(r#"[{"role":"user","content":"a"},{"role":"other","value":"b"}]"#),
            ConversationKind::Possible
        );
        assert_eq!(
            kind(
                r#"[{"role":"user","content":"a"},{"role":"assistant","value":["b"]},{"speaker":"x","text":"c"},{"speaker":"y","text":"d"}]"#
            ),
            ConversationKind::Possible
        );
    }

    #[test]
    fn each_generic_metric_counts_a_message_once() {
        assert_eq!(
            kind(
                r#"[{"role":"user","from":"human","content":"a","value":"b"},{"role":"assistant","content":"c"}]"#
            ),
            ConversationKind::Generic
        );
        assert_eq!(
            kind(r#"[{"role":"user","from":"human","content":"a","value":"b"},{}]"#),
            ConversationKind::Possible
        );
    }

    #[test]
    fn does_not_sample_only_the_first_hundred_messages() {
        let mut items = String::new();
        for index in 0..101 {
            if index > 0 {
                items.push(',');
            }
            if index < 80 {
                items.push_str(r#"{"role":"user","content":"matching"}"#);
            } else {
                items.push_str(r#"{"speaker":"other","text":"tail"}"#);
            }
        }
        assert_eq!(kind(&format!("[{items}]")), ConversationKind::Possible);
    }

    #[test]
    fn finds_a_specific_signal_at_the_end_of_the_full_array() {
        let mut items = String::new();
        for index in 0..101 {
            if index > 0 {
                items.push(',');
            }
            if index == 100 {
                items.push_str(r#"{"role":"tool","content":"tail"}"#);
            } else {
                items.push_str(r#"{"role":"user","content":"ordinary"}"#);
            }
        }
        assert_eq!(kind(&format!("[{items}]")), ConversationKind::OpenAi);
    }

    #[test]
    fn mixed_schema_defaults_to_explicit_mixed_kind() {
        assert_eq!(
            kind(
                r#"{"messages":[{"role":"user","content":"x"},{"role":"assistant","tool_calls":[{"function":{"name":"f"}}],"content":[{"type":"tool_use"}]}]}"#
            ),
            ConversationKind::Mixed
        );
    }

    #[test]
    fn nested_candidate_is_not_in_scope_and_duplicate_fields_are_explicit() {
        let parsed = parse_json(
            br#"{"meta":{"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]},"messages":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}],"conversation":[{"role":"user","content":"x"},{"role":"assistant","content":"y"}]}"#,
        )
        .unwrap();
        let root_id = parsed.root().index();
        let root = parsed.node(parsed.root());
        let messages = root.children[1].index();
        let conversation = root.children[2].index();
        assert_eq!(
            detect_candidate(&parsed, root_id, messages).unwrap().kind,
            ConversationKind::Generic
        );
        assert_eq!(
            detect_candidate(&parsed, root_id, conversation)
                .unwrap()
                .kind,
            ConversationKind::Generic
        );

        let meta = parsed.node(parsed.root()).children[0].index();
        let deep_messages = parsed.node_at(meta).unwrap().children[0].index();
        assert!(detect_candidate(&parsed, root_id, deep_messages).is_none());
    }

    #[test]
    fn collection_item_is_the_only_non_root_scope_allowed() {
        let parsed = parse_json(
            br#"[{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}]"#,
        )
        .unwrap();
        let root_id = parsed.root().index();
        let item_id = parsed.node(parsed.root()).children[0].index();
        let messages_id = parsed.node_at(item_id).unwrap().children[0].index();
        assert_eq!(
            detect_candidate(&parsed, item_id, messages_id)
                .unwrap()
                .kind,
            ConversationKind::Generic
        );
        assert!(detect_candidate(&parsed, root_id, messages_id).is_none());
        assert!(detect_candidate(&parsed, messages_id, messages_id).is_none());
    }

    #[test]
    fn possible_requires_role_and_content_on_the_same_message() {
        let parsed = parse_json(
            br#"[{"role":"user"},{"content":"detached"},{"other":true},{"other":false}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        assert_eq!(
            detect_candidate(&parsed, root, root).unwrap().kind,
            ConversationKind::None
        );
    }

    #[test]
    fn one_message_can_be_possible_but_never_generic() {
        assert_eq!(
            kind(r#"[{"role":"user","content":"a"}]"#),
            ConversationKind::Possible
        );
    }

    #[test]
    fn generated_f03_f05_fixtures_match_the_candidate_contract() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-conversation-fixtures-{}-{nanos}",
            std::process::id()
        ));
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/generate-semantic-fixtures.mjs");
        let output = Command::new("node")
            .arg(script)
            .arg(&directory)
            .output()
            .expect("node must be available to generate conversation fixtures");
        assert!(
            output.status.success(),
            "fixture generation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let cases = [
            ("openai-conversation.json", ConversationKind::OpenAi),
            ("anthropic-system-string.json", ConversationKind::Anthropic),
            ("anthropic-system-blocks.json", ConversationKind::Anthropic),
            ("generic-role-content.json", ConversationKind::Generic),
            ("generic-from-value.json", ConversationKind::Generic),
            ("generic-non-conversation.json", ConversationKind::None),
            ("generic-threshold-79.json", ConversationKind::Possible),
            ("generic-threshold-80.json", ConversationKind::Generic),
        ];
        for (name, expected) in cases {
            let bytes = fs::read(directory.join(name)).expect("generated fixture must exist");
            let parsed = parse_json(&bytes).expect("generated fixture must be valid JSON");
            let root_id = parsed.root().index();
            let root = parsed.node(parsed.root());
            let candidate_id = if root.kind == JsonKind::Array {
                root_id
            } else {
                root.children
                    .iter()
                    .copied()
                    .find(|id| {
                        let child = parsed.node(*id);
                        matches!(&child.locator, ChildLocator::ObjectKey { key, .. } if matches!(key.as_str(), "messages" | "conversation" | "conversations"))
                    })
                    .expect("generated conversation object has a candidate field")
                    .index()
            };
            let candidate = detect_candidate(&parsed, root_id, candidate_id)
                .expect("candidate field must be an allowed direct scope");
            assert_eq!(candidate.kind, expected, "{name}");
            assert_eq!(
                candidate.message_count,
                parsed.node_at(candidate_id).unwrap().children.len(),
                "{name} message count"
            );
        }
        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }
}
