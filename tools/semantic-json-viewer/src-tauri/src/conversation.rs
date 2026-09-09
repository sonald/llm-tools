use crate::json::{ChildLocator, JsonKind, JsonNode, ParsedJson, SourceSpan};

const CANDIDATE_FIELDS: [&str; 3] = ["messages", "conversation", "conversations"];

#[cfg(test)]
std::thread_local! {
    static ROLE_SCAN_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationBlockKind {
    Message,
    Source,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationCategory {
    Message,
    Role,
    Content,
    Value,
    Tool,
    Unknown,
}

impl GenericConversationCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Role => "role",
            Self::Content => "content",
            Self::Value => "value",
            Self::Tool => "tool",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NormalizedRole {
    Unknown,
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

impl NormalizedRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::System => "system",
            Self::Developer => "developer",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationSourceRef {
    pub node_id: usize,
    pub span: SourceSpan,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenericConversationBlock {
    pub kind: GenericConversationBlockKind,
    pub message: ConversationSourceRef,
    pub source: Option<ConversationSourceRef>,
    pub field: Option<ConversationSourceRef>,
    pub category: GenericConversationCategory,
    pub role: NormalizedRole,
    pub role_source: Option<ConversationSourceRef>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationPhase {
    Message,
    Fields,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenericConversationCursor {
    pub message_index: usize,
    pub phase: GenericConversationPhase,
    pub field_index: usize,
    pub element_index: usize,
}

pub(crate) struct RoleCache {
    message_id: usize,
    role_source_id: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationWrapperRef {
    pub scope_root: ConversationSourceRef,
    pub candidate: ConversationSourceRef,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenericConversationPage {
    pub blocks: Vec<GenericConversationBlock>,
    pub has_more: bool,
    pub next_cursor: Option<GenericConversationCursor>,
    pub wrapper_ref: ConversationWrapperRef,
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
    let candidate = candidate_array(parsed, scope_root_id, candidate_node_id)?;
    let kind = classify_array(parsed, candidate);
    Some(ConversationCandidate {
        node_id: candidate_node_id,
        span: candidate.span,
        message_count: candidate.children.len(),
        kind,
    })
}

/// Return the selected candidate array without classifying its contents.
/// Paging uses this shape-only check so every page does not rescan the full
/// message array.
pub fn candidate_array<'a>(
    parsed: &'a ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
) -> Option<&'a JsonNode> {
    let scope_root = parsed.node_at(scope_root_id)?;
    if scope_root_id != parsed.root().index() && !is_direct_collection_item(parsed, scope_root_id) {
        return None;
    }

    if scope_root_id == candidate_node_id && scope_root.kind == JsonKind::Array {
        return Some(scope_root);
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
    is_direct_named_array.then_some(candidate)
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
    if possible {
        ConversationKind::Possible
    } else {
        ConversationKind::None
    }
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
        .then_some(node.decoded.as_deref())
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

const MAX_GENERIC_BLOCKS: usize = 100;

/// Page a selected message array without materializing message bodies or the
/// complete block list. The caller must bind cursor identity (revision,
/// scope root, and candidate) at the IPC boundary.
pub fn generic_conversation_page(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
) -> Option<GenericConversationPage> {
    generic_conversation_page_impl(
        parsed,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        None,
    )
}

pub(crate) fn generic_conversation_page_with_role_cache(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
    role_cache: &std::sync::Mutex<Option<RoleCache>>,
) -> Option<GenericConversationPage> {
    generic_conversation_page_impl(
        parsed,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        Some(role_cache),
    )
}

fn generic_conversation_page_impl(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) -> Option<GenericConversationPage> {
    if limit == 0 {
        return None;
    }
    let candidate = candidate_array(parsed, scope_root_id, candidate_node_id)?;
    let scope_root = parsed.node_at(scope_root_id)?;
    let mut cursor = cursor.unwrap_or(GenericConversationCursor {
        message_index: 0,
        phase: GenericConversationPhase::Message,
        field_index: 0,
        element_index: 0,
    });
    if !cursor_position_is_valid(parsed, candidate, cursor, role_cache) {
        return None;
    }

    let mut blocks = Vec::with_capacity(limit.min(MAX_GENERIC_BLOCKS));
    let page_limit = limit.min(MAX_GENERIC_BLOCKS);
    while blocks.len() < page_limit {
        normalize_cursor(parsed, candidate, &mut cursor, role_cache);
        if cursor.message_index >= candidate.children.len() {
            break;
        }

        let message_id = candidate.children[cursor.message_index].index();
        let message = parsed.node(candidate.children[cursor.message_index]);
        let message_ref = ConversationSourceRef {
            node_id: message_id,
            span: message.span,
        };
        let role_source_id = selected_role_node_cached(parsed, message_id, message, role_cache);
        let role_source = role_source_id.map(|node_id| ConversationSourceRef {
            node_id,
            span: parsed.node_at(node_id).expect("role node must exist").span,
        });
        let role = role_source_id
            .map(|node_id| normalized_role(parsed.node_at(node_id).expect("role node must exist")))
            .unwrap_or(NormalizedRole::Unknown);

        match cursor.phase {
            GenericConversationPhase::Message => {
                blocks.push(GenericConversationBlock {
                    kind: GenericConversationBlockKind::Message,
                    message: message_ref,
                    source: None,
                    field: None,
                    category: GenericConversationCategory::Message,
                    role,
                    role_source,
                });
                cursor.phase = if message.kind == JsonKind::Object {
                    GenericConversationPhase::Fields
                } else {
                    advance_message(&mut cursor);
                    GenericConversationPhase::Message
                };
            }
            GenericConversationPhase::Fields => {
                let field_id = message.children[cursor.field_index].index();
                let field = parsed.node(message.children[cursor.field_index]);
                let field_ref = ConversationSourceRef {
                    node_id: field_id,
                    span: field.span,
                };
                let category = field_category(field);
                let array_elements = content_or_value_array(field);
                if let Some(elements) = array_elements {
                    let element_id = elements[cursor.element_index].index();
                    let element = parsed.node(elements[cursor.element_index]);
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Source,
                        message: message_ref,
                        source: Some(ConversationSourceRef {
                            node_id: element_id,
                            span: element.span,
                        }),
                        field: Some(field_ref),
                        category,
                        role,
                        role_source,
                    });
                    cursor.element_index += 1;
                } else {
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Source,
                        message: message_ref,
                        source: Some(field_ref),
                        field: Some(field_ref),
                        category,
                        role,
                        role_source,
                    });
                    cursor.field_index += 1;
                }
            }
        }
    }

    normalize_cursor(parsed, candidate, &mut cursor, role_cache);
    let has_more = cursor.message_index < candidate.children.len();
    Some(GenericConversationPage {
        blocks,
        has_more,
        next_cursor: has_more.then_some(cursor),
        wrapper_ref: ConversationWrapperRef {
            scope_root: ConversationSourceRef {
                node_id: scope_root_id,
                span: scope_root.span,
            },
            candidate: ConversationSourceRef {
                node_id: candidate_node_id,
                span: candidate.span,
            },
        },
    })
}

fn cursor_position_is_valid(
    parsed: &ParsedJson<'_>,
    candidate: &JsonNode,
    cursor: GenericConversationCursor,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) -> bool {
    if cursor.message_index > candidate.children.len() {
        return false;
    }
    if cursor.message_index == candidate.children.len() {
        return matches!(cursor.phase, GenericConversationPhase::Message)
            && cursor.field_index == 0
            && cursor.element_index == 0;
    }

    let message = parsed.node(candidate.children[cursor.message_index]);
    match cursor.phase {
        GenericConversationPhase::Message => cursor.field_index == 0 && cursor.element_index == 0,
        GenericConversationPhase::Fields => {
            if message.kind != JsonKind::Object || cursor.field_index >= message.children.len() {
                return false;
            }
            let field = parsed.node(message.children[cursor.field_index]);
            if selected_role_node_cached(
                parsed,
                candidate.children[cursor.message_index].index(),
                message,
                role_cache,
            ) == Some(message.children[cursor.field_index].index())
            {
                return false;
            }
            match content_or_value_array(field) {
                Some(elements) => cursor.element_index < elements.len(),
                None => cursor.element_index == 0,
            }
        }
    }
}

fn normalize_cursor(
    parsed: &ParsedJson<'_>,
    candidate: &JsonNode,
    cursor: &mut GenericConversationCursor,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) {
    loop {
        if cursor.message_index >= candidate.children.len() {
            cursor.message_index = candidate.children.len();
            cursor.phase = GenericConversationPhase::Message;
            cursor.field_index = 0;
            cursor.element_index = 0;
            return;
        }
        if cursor.phase == GenericConversationPhase::Message {
            return;
        }

        let message = parsed.node(candidate.children[cursor.message_index]);
        if message.kind != JsonKind::Object || cursor.field_index >= message.children.len() {
            advance_message(cursor);
            continue;
        }
        let field = parsed.node(message.children[cursor.field_index]);
        if selected_role_node_cached(
            parsed,
            candidate.children[cursor.message_index].index(),
            message,
            role_cache,
        ) == Some(message.children[cursor.field_index].index())
        {
            cursor.field_index += 1;
            cursor.element_index = 0;
            continue;
        }
        if let Some(elements) = content_or_value_array(field) {
            if cursor.element_index >= elements.len() {
                cursor.field_index += 1;
                cursor.element_index = 0;
                continue;
            }
        } else {
            cursor.element_index = 0;
        }
        return;
    }
}

fn advance_message(cursor: &mut GenericConversationCursor) {
    cursor.message_index += 1;
    cursor.phase = GenericConversationPhase::Message;
    cursor.field_index = 0;
    cursor.element_index = 0;
}

fn selected_role_node(parsed: &ParsedJson<'_>, message: &JsonNode) -> Option<usize> {
    #[cfg(test)]
    ROLE_SCAN_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    message
        .children
        .iter()
        .copied()
        .find(|id| object_key(parsed.node(*id)) == Some("role"))
        .or_else(|| {
            message
                .children
                .iter()
                .copied()
                .find(|id| object_key(parsed.node(*id)) == Some("from"))
        })
        .map(|id| id.index())
}

#[cfg(test)]
fn reset_role_scan_count() {
    ROLE_SCAN_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn role_scan_count() -> usize {
    ROLE_SCAN_COUNT.with(std::cell::Cell::get)
}

fn selected_role_node_cached(
    parsed: &ParsedJson<'_>,
    message_id: usize,
    message: &JsonNode,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) -> Option<usize> {
    let Some(role_cache) = role_cache else {
        return selected_role_node(parsed, message);
    };
    let Ok(mut cache) = role_cache.lock() else {
        return selected_role_node(parsed, message);
    };
    if let Some(entry) = cache.as_ref() {
        if entry.message_id == message_id {
            return entry.role_source_id;
        }
    }
    let role_source_id = selected_role_node(parsed, message);
    *cache = Some(RoleCache {
        message_id,
        role_source_id,
    });
    role_source_id
}

fn normalized_role(node: &JsonNode) -> NormalizedRole {
    let Some(value) = string_value(node) else {
        return NormalizedRole::Unknown;
    };
    match value {
        "system" => NormalizedRole::System,
        "developer" => NormalizedRole::Developer,
        "user" | "human" => NormalizedRole::User,
        "assistant" | "gpt" | "bot" | "model" => NormalizedRole::Assistant,
        "tool" | "function" => NormalizedRole::Tool,
        _ => NormalizedRole::Unknown,
    }
}

fn field_category(node: &JsonNode) -> GenericConversationCategory {
    match object_key(node) {
        Some("role" | "from") => GenericConversationCategory::Role,
        Some("content") => GenericConversationCategory::Content,
        Some("value") => GenericConversationCategory::Value,
        Some("tool_calls" | "function_call" | "tool_call_id") => GenericConversationCategory::Tool,
        _ => GenericConversationCategory::Unknown,
    }
}

fn content_or_value_array(node: &JsonNode) -> Option<&[crate::json::NodeId]> {
    if !matches!(object_key(node), Some("content" | "value")) || node.kind != JsonKind::Array {
        return None;
    }
    if node.children.is_empty() {
        None
    } else {
        Some(node.children.as_slice())
    }
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

    #[test]
    fn generic_projection_preserves_message_and_source_order() {
        let input = r#"[{"role":"user","role":"assistant","content":["first","second"],"value":null,"tool_calls":{"name":"lookup"},"unknown":true},null,{"from":"human","content":[],"value":{"answer":42},"extra":"kept"}]"#;
        let parsed = parse_json(input.as_bytes()).unwrap();
        let root = parsed.root().index();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = generic_conversation_page(&parsed, root, root, cursor, 1).unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }

        assert_eq!(blocks[0].kind, GenericConversationBlockKind::Message);
        assert_eq!(blocks[0].role, NormalizedRole::User);
        assert!(blocks[0].role_source.is_some());
        assert_eq!(
            blocks
                .iter()
                .map(|block| (block.kind, block.category))
                .collect::<Vec<_>>(),
            vec![
                (
                    GenericConversationBlockKind::Message,
                    GenericConversationCategory::Message
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Role
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Content
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Content
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Value
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Tool
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Unknown
                ),
                (
                    GenericConversationBlockKind::Message,
                    GenericConversationCategory::Message
                ),
                (
                    GenericConversationBlockKind::Message,
                    GenericConversationCategory::Message
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Content
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Value
                ),
                (
                    GenericConversationBlockKind::Source,
                    GenericConversationCategory::Unknown
                ),
            ]
        );
        assert_eq!(blocks[8].role, NormalizedRole::User);
        assert_eq!(
            blocks[9].source.unwrap().node_id,
            blocks[9].field.unwrap().node_id
        );
        assert!(blocks
            .windows(2)
            .all(|pair| pair[0].message.span.start <= pair[1].message.span.start));
    }

    #[test]
    fn generic_projection_pages_long_content_without_duplicates_or_leaks() {
        let mut elements = String::new();
        for index in 0..205 {
            if index > 0 {
                elements.push(',');
            }
            elements.push_str(&format!("\"element-{index}\""));
        }
        let input = format!(r#"{{"messages":[{{"role":"user","content":[{elements}]}}]}}"#);
        let parsed = parse_json(input.as_bytes()).unwrap();
        let root = parsed.root().index();
        let candidate = parsed.node(parsed.root()).children[0].index();
        let mut cursor = None;
        let mut sources = Vec::new();
        let mut page_count = 0;
        loop {
            let page = generic_conversation_page(&parsed, root, candidate, cursor, 1).unwrap();
            page_count += 1;
            for block in page.blocks {
                if block.kind == GenericConversationBlockKind::Source {
                    sources.push(block.source.unwrap().node_id);
                }
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(page_count, 206);
        assert_eq!(sources.len(), 205);
        let mut sorted = sources.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), sources.len());
        assert!(generic_conversation_page(&parsed, root, candidate, None, 0).is_none());
        let page = generic_conversation_page(&parsed, root, candidate, None, 101).unwrap();
        assert_eq!(page.blocks.len(), 100);
        assert!(page.has_more);
    }

    #[test]
    fn generic_projection_traverses_all_101_messages_across_pages() {
        let mut items = String::new();
        for index in 0..101 {
            if index > 0 {
                items.push(',');
            }
            items.push_str(&format!(r#"{{"role":"user","content":"message-{index}"}}"#));
        }
        let tree =
            crate::tree::TreeDocument::from_bytes(format!("[{items}]").into_bytes()).unwrap();
        let root = tree.root().id;
        let mut cursor = None;
        let mut message_ids = Vec::new();
        loop {
            let page = tree
                .generic_conversation_page(root, root, cursor, 100)
                .unwrap();
            message_ids.extend(
                page.blocks
                    .iter()
                    .filter(|block| block.kind == GenericConversationBlockKind::Message)
                    .map(|block| block.message.node_id),
            );
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(message_ids.len(), 101);
        let mut unique = message_ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), message_ids.len());
    }

    #[test]
    fn generic_projection_rejects_forged_positions_and_keeps_wrapper_refs() {
        let parsed = parse_json(br#"{"messages":[{"role":"user","content":["a","b"]}]}"#).unwrap();
        let root = parsed.root().index();
        let candidate = parsed.node(parsed.root()).children[0].index();
        let page = generic_conversation_page(&parsed, root, candidate, None, 1).unwrap();
        assert_eq!(page.wrapper_ref.scope_root.node_id, root);
        assert_eq!(page.wrapper_ref.candidate.node_id, candidate);
        assert_eq!(page.blocks.len(), 1);
        assert!(generic_conversation_page(
            &parsed,
            root,
            candidate,
            Some(GenericConversationCursor {
                message_index: 0,
                phase: GenericConversationPhase::Fields,
                field_index: 0,
                element_index: 0,
            }),
            1,
        )
        .is_none());
        assert!(generic_conversation_page(
            &parsed,
            root,
            candidate,
            Some(GenericConversationCursor {
                message_index: 9,
                phase: GenericConversationPhase::Message,
                field_index: 0,
                element_index: 0,
            }),
            1,
        )
        .is_none());
    }

    #[test]
    fn cached_role_selection_handles_tail_role_and_roleless_messages() {
        let mut tail_fields = String::new();
        let mut roleless_fields = String::new();
        for index in 0..300 {
            if index > 0 {
                tail_fields.push(',');
                roleless_fields.push(',');
            }
            tail_fields.push_str(&format!(r#""tail-{index}":true"#));
            roleless_fields.push_str(&format!(r#""plain-{index}":true"#));
        }
        tail_fields.push_str(r#", "role":"assistant", "content":"tail""#);
        let input = format!(r#"[{{{tail_fields}}},{{{roleless_fields}}}]"#);
        reset_role_scan_count();
        let tree = crate::tree::TreeDocument::from_bytes(input.into_bytes()).unwrap();
        let root = tree.root().id;
        let mut cursor = None;
        let mut first_roles = Vec::new();
        let mut second_roles = Vec::new();
        loop {
            let page = tree
                .generic_conversation_page(root, root, cursor, 1)
                .unwrap();
            for block in page.blocks {
                if block.message.node_id == 1 {
                    first_roles.push(block.role);
                } else {
                    second_roles.push(block.role);
                }
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert!(!first_roles.is_empty());
        assert!(first_roles
            .iter()
            .all(|role| *role == NormalizedRole::Assistant));
        assert!(!second_roles.is_empty());
        assert!(second_roles
            .iter()
            .all(|role| *role == NormalizedRole::Unknown));
        assert_eq!(role_scan_count(), 2);
    }
}
