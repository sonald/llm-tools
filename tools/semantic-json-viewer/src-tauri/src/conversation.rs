use std::borrow::Cow;

use crate::json::{ChildLocator, JsonKind, JsonNode, ParsedJson, SourceSpan};

const CANDIDATE_FIELDS: [&str; 3] = ["messages", "conversation", "conversations"];
// Conversation discriminators are fixed protocol tokens; content/message
// bodies are kept out of this helper and use their own bounded consumers.
const MAX_DISCRIMINATOR_BYTES: usize = 32;

#[cfg(test)]
std::thread_local! {
    static ROLE_SCAN_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static WRAPPER_SCAN_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
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
    pub ambiguous_duplicate_field: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationStyle {
    Generic,
    OpenAi,
    Anthropic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationBlockKind {
    Message,
    Source,
    System,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationCategory {
    Message,
    Role,
    Content,
    Value,
    Tool,
    Unknown,
    Text,
    Image,
    ToolCall,
    ToolResult,
    System,
    Thinking,
    RedactedThinking,
    ToolUse,
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
            Self::Text => "text",
            Self::Image => "image",
            Self::ToolCall => "toolCall",
            Self::ToolResult => "toolResult",
            Self::System => "system",
            Self::Thinking => "thinking",
            Self::RedactedThinking => "redactedThinking",
            Self::ToolUse => "toolUse",
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct ConversationOpenAiRefs {
    pub block: Option<ConversationSourceRef>,
    pub text: Option<ConversationSourceRef>,
    pub image: Option<ConversationSourceRef>,
    pub call_id: Option<ConversationSourceRef>,
    pub function: Option<ConversationSourceRef>,
    pub name: Option<ConversationSourceRef>,
    pub arguments: Option<ConversationSourceRef>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Default)]
pub struct ConversationAnthropicRefs {
    pub block: Option<ConversationSourceRef>,
    pub text: Option<ConversationSourceRef>,
    pub thinking: Option<ConversationSourceRef>,
    pub data: Option<ConversationSourceRef>,
    pub id: Option<ConversationSourceRef>,
    pub name: Option<ConversationSourceRef>,
    pub input: Option<ConversationSourceRef>,
    pub tool_use_id: Option<ConversationSourceRef>,
    pub content: Option<ConversationSourceRef>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenericConversationBlock {
    pub kind: GenericConversationBlockKind,
    pub message: Option<ConversationSourceRef>,
    pub source: Option<ConversationSourceRef>,
    pub field: Option<ConversationSourceRef>,
    pub category: GenericConversationCategory,
    pub role: NormalizedRole,
    pub role_source: Option<ConversationSourceRef>,
    pub openai_refs: Option<ConversationOpenAiRefs>,
    pub anthropic_refs: Option<ConversationAnthropicRefs>,
    pub ambiguous_duplicate_field: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenericConversationPhase {
    Message,
    Fields,
    SystemHeader,
    SystemContent,
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
    style: ConversationStyle,
    role_source_id: Option<usize>,
    ambiguous_duplicate_field: bool,
}

pub(crate) struct WrapperCache {
    scope_root_id: usize,
    candidate_node_id: usize,
    candidate_duplicate_field: bool,
    system_duplicate_field: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConversationWrapperRef {
    pub scope_root: ConversationSourceRef,
    pub candidate: ConversationSourceRef,
    pub ambiguous_duplicate_field: bool,
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
    let wrapper_ambiguous = candidate_wrapper_field_is_ambiguous(parsed, scope_root_id, candidate);
    let message_ambiguous = candidate
        .children
        .iter()
        .map(|id| parsed.node(*id))
        .any(|message| {
            message_has_duplicate_dependency(parsed, message, ConversationStyle::Generic)
        });
    let kind = if wrapper_ambiguous {
        ConversationKind::None
    } else {
        classify_array(parsed, candidate)
    };
    Some(ConversationCandidate {
        node_id: candidate_node_id,
        span: candidate.span,
        message_count: candidate.children.len(),
        kind,
        ambiguous_duplicate_field: wrapper_ambiguous || message_ambiguous,
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
    if message_has_duplicate_dependency(parsed, message, ConversationStyle::Generic) {
        return;
    }
    let role_node = message
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
        });
    let role_key = role_node.is_some();
    let recognized_role = role_node
        .and_then(|id| string_value(parsed, parsed.node(id)))
        .is_some_and(|value| is_recognized_role(&value));
    let mut content_or_tool = false;
    let mut openai_signal = false;
    for &child_id in &message.children {
        let child = parsed.node(child_id);
        let Some(key) = object_key(child) else {
            continue;
        };
        match key {
            "role" | "from" => {}
            "content" | "value" => {
                content_or_tool = true;
            }
            "tool_calls" => {
                content_or_tool = true;
                openai_signal |= openai_tool_calls_have_signal(parsed, child);
            }
            "function_call" => {
                content_or_tool = true;
                let (_, _, ambiguous_duplicate_field) =
                    openai_legacy_function_call(parsed, child_id.index(), child);
                openai_signal |= !ambiguous_duplicate_field;
            }
            "tool_call_id" => {
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
        if key == "role"
            && matches!(
                string_value(parsed, child).as_deref(),
                Some("developer" | "tool" | "function")
            )
        {
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
            if has_duplicate_key(parsed, block, "type") {
                continue;
            }
            let Some(type_node) = direct_child_by_key(parsed, block, "type") else {
                continue;
            };
            let Some(block_type) = string_value(parsed, type_node) else {
                continue;
            };
            if matches!(
                block_type.as_ref(),
                "tool_use" | "tool_result" | "thinking" | "redacted_thinking"
            ) && !anthropic_block_has_ambiguous_dependency(parsed, block, block_type.as_ref())
            {
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

fn has_key(parsed: &ParsedJson<'_>, object: &JsonNode, wanted: &str) -> bool {
    object
        .children
        .iter()
        .any(|id| object_key(parsed.node(*id)) == Some(wanted))
}

fn has_duplicate_key(parsed: &ParsedJson<'_>, object: &JsonNode, wanted: &str) -> bool {
    object.children.iter().any(|id| {
        matches!(
            &parsed.node(*id).locator,
            ChildLocator::ObjectKey {
                key,
                occurrence,
                ..
            } if key == wanted && *occurrence > 1
        )
    })
}

fn message_has_duplicate_dependency(
    parsed: &ParsedJson<'_>,
    message: &JsonNode,
    style: ConversationStyle,
) -> bool {
    if message.kind != JsonKind::Object {
        return false;
    }
    let has_role = has_key(parsed, message, "role");
    let role_or_fallback = has_duplicate_key(parsed, message, "role")
        || (style == ConversationStyle::Generic
            && !has_role
            && has_duplicate_key(parsed, message, "from"));
    let content = has_duplicate_key(parsed, message, "content");
    let value = style == ConversationStyle::Generic && has_duplicate_key(parsed, message, "value");
    let tool = matches!(
        style,
        ConversationStyle::Generic | ConversationStyle::OpenAi
    ) && ["tool_calls", "function_call", "tool_call_id"]
        .iter()
        .any(|key| has_duplicate_key(parsed, message, key));
    let openai_tool_result_error = style == ConversationStyle::OpenAi
        && direct_child_by_key(parsed, message, "role")
            .is_some_and(|role| normalized_role(parsed, role) == NormalizedRole::Tool)
        && has_duplicate_key(parsed, message, "is_error");
    match style {
        ConversationStyle::Generic => role_or_fallback || content || value || tool,
        ConversationStyle::OpenAi => {
            role_or_fallback || content || tool || openai_tool_result_error
        }
        ConversationStyle::Anthropic => role_or_fallback || content,
    }
}

fn openai_tool_calls_have_signal(parsed: &ParsedJson<'_>, field: &JsonNode) -> bool {
    if field.kind != JsonKind::Array || field.children.is_empty() {
        return true;
    }
    field.children.iter().any(|child_id| {
        let child = parsed.node(*child_id);
        let (_, _, ambiguous_duplicate_field) = openai_tool_call(parsed, child_id.index(), child);
        !ambiguous_duplicate_field
    })
}

fn anthropic_block_has_ambiguous_dependency(
    parsed: &ParsedJson<'_>,
    block: &JsonNode,
    block_type: &str,
) -> bool {
    if has_duplicate_key(parsed, block, "type") {
        return true;
    }
    match block_type {
        "thinking" => has_duplicate_key(parsed, block, "thinking"),
        "redacted_thinking" => has_duplicate_key(parsed, block, "data"),
        "tool_use" => ["id", "name", "input"]
            .iter()
            .any(|key| has_duplicate_key(parsed, block, key)),
        "tool_result" => {
            if ["tool_use_id", "content", "is_error"]
                .iter()
                .any(|key| has_duplicate_key(parsed, block, key))
            {
                return true;
            }
            direct_child_by_key(parsed, block, "content")
                .is_some_and(|content| content_children_have_duplicate_ui_fields(parsed, content))
        }
        _ => false,
    }
}

fn candidate_wrapper_field_is_ambiguous(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate: &JsonNode,
) -> bool {
    if parsed
        .node_at(scope_root_id)
        .is_none_or(|node| node.kind != JsonKind::Object)
    {
        return false;
    }
    let ChildLocator::ObjectKey { key, .. } = &candidate.locator else {
        return false;
    };
    let scope_root = parsed
        .node_at(scope_root_id)
        .expect("scope root was checked above");
    has_duplicate_key(parsed, scope_root, key)
}

fn wrapper_has_ambiguous_dependency(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    candidate: &JsonNode,
    style: ConversationStyle,
    wrapper_cache: Option<&std::sync::Mutex<Option<WrapperCache>>>,
) -> bool {
    let (candidate_duplicate_field, system_duplicate_field) = if let Some(wrapper_cache) =
        wrapper_cache
    {
        let Ok(mut cache) = wrapper_cache.lock() else {
            return wrapper_has_ambiguous_dependency_uncached(
                parsed,
                scope_root_id,
                candidate,
                style,
            );
        };
        if let Some(entry) = cache.as_ref() {
            if entry.scope_root_id == scope_root_id && entry.candidate_node_id == candidate_node_id
            {
                (
                    entry.candidate_duplicate_field,
                    entry.system_duplicate_field,
                )
            } else {
                let flags = wrapper_ambiguity_flags(parsed, scope_root_id, candidate);
                *cache = Some(WrapperCache {
                    scope_root_id,
                    candidate_node_id,
                    candidate_duplicate_field: flags.0,
                    system_duplicate_field: flags.1,
                });
                flags
            }
        } else {
            let flags = wrapper_ambiguity_flags(parsed, scope_root_id, candidate);
            *cache = Some(WrapperCache {
                scope_root_id,
                candidate_node_id,
                candidate_duplicate_field: flags.0,
                system_duplicate_field: flags.1,
            });
            flags
        }
    } else {
        wrapper_ambiguity_flags(parsed, scope_root_id, candidate)
    };
    candidate_duplicate_field || style == ConversationStyle::Anthropic && system_duplicate_field
}

fn wrapper_has_ambiguous_dependency_uncached(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate: &JsonNode,
    style: ConversationStyle,
) -> bool {
    let (candidate_duplicate_field, system_duplicate_field) =
        wrapper_ambiguity_flags(parsed, scope_root_id, candidate);
    candidate_duplicate_field || style == ConversationStyle::Anthropic && system_duplicate_field
}

fn wrapper_ambiguity_flags(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate: &JsonNode,
) -> (bool, bool) {
    #[cfg(test)]
    WRAPPER_SCAN_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let candidate_duplicate_field =
        candidate_wrapper_field_is_ambiguous(parsed, scope_root_id, candidate);
    let system_duplicate_field = parsed.node_at(scope_root_id).is_some_and(|scope_root| {
        scope_root.kind == JsonKind::Object && has_duplicate_key(parsed, scope_root, "system")
    });
    (candidate_duplicate_field, system_duplicate_field)
}

fn object_key(node: &JsonNode) -> Option<&str> {
    match &node.locator {
        ChildLocator::ObjectKey { key, .. } => Some(key.as_str()),
        ChildLocator::Root | ChildLocator::ArrayIndex(_) => None,
    }
}

fn string_value<'a>(parsed: &'a ParsedJson<'_>, node: &JsonNode) -> Option<Cow<'a, str>> {
    parsed
        .decoded_string_for_node(node)
        .and_then(|decoded| decoded.to_cow_limit(MAX_DISCRIMINATOR_BYTES))
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
const MAX_SYSTEM_SCAN_FIELDS: usize = 128;

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
    conversation_page(
        parsed,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        ConversationStyle::Generic,
    )
}

pub fn conversation_page(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
    style: ConversationStyle,
) -> Option<GenericConversationPage> {
    conversation_page_impl(
        parsed,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        style,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn conversation_page_with_caches(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
    style: ConversationStyle,
    role_cache: &std::sync::Mutex<Option<RoleCache>>,
    wrapper_cache: &std::sync::Mutex<Option<WrapperCache>>,
) -> Option<GenericConversationPage> {
    conversation_page_impl(
        parsed,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        style,
        Some(role_cache),
        Some(wrapper_cache),
    )
}

#[allow(clippy::too_many_arguments)]
fn conversation_page_impl(
    parsed: &ParsedJson<'_>,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursor>,
    limit: usize,
    style: ConversationStyle,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
    wrapper_cache: Option<&std::sync::Mutex<Option<WrapperCache>>>,
) -> Option<GenericConversationPage> {
    if limit == 0 {
        return None;
    }
    let candidate = candidate_array(parsed, scope_root_id, candidate_node_id)?;
    let scope_root = parsed.node_at(scope_root_id)?;
    if wrapper_has_ambiguous_dependency(
        parsed,
        scope_root_id,
        candidate_node_id,
        candidate,
        style,
        wrapper_cache,
    ) {
        if cursor.is_some() {
            return None;
        }
        return Some(ambiguous_wrapper_page(
            scope_root_id,
            candidate_node_id,
            scope_root,
            candidate,
        ));
    }
    let cursor_was_provided = cursor.is_some();
    let mut cursor = cursor.unwrap_or(GenericConversationCursor {
        message_index: 0,
        phase: if style == ConversationStyle::Anthropic && scope_root.kind == JsonKind::Object {
            GenericConversationPhase::SystemHeader
        } else {
            GenericConversationPhase::Message
        },
        field_index: 0,
        element_index: 0,
    });
    if cursor_was_provided
        && !cursor_position_is_valid(parsed, scope_root, candidate, cursor, style, role_cache)
    {
        return None;
    }
    let mut system_scan_budget = MAX_SYSTEM_SCAN_FIELDS;
    normalize_cursor(
        parsed,
        scope_root,
        candidate,
        &mut cursor,
        style,
        role_cache,
        &mut system_scan_budget,
    );

    let mut blocks = Vec::with_capacity(limit.min(MAX_GENERIC_BLOCKS));
    let page_limit = limit.min(MAX_GENERIC_BLOCKS);
    while blocks.len() < page_limit {
        normalize_cursor(
            parsed,
            scope_root,
            candidate,
            &mut cursor,
            style,
            role_cache,
            &mut system_scan_budget,
        );
        if cursor.phase == GenericConversationPhase::SystemHeader
            && cursor.field_index < scope_root.children.len()
            && object_key(parsed.node(scope_root.children[cursor.field_index])) != Some("system")
        {
            break;
        }
        if cursor.message_index >= candidate.children.len()
            && matches!(
                cursor.phase,
                GenericConversationPhase::Message | GenericConversationPhase::Fields
            )
        {
            break;
        }

        if cursor.phase == GenericConversationPhase::SystemHeader {
            let field = parsed.node(scope_root.children[cursor.field_index]);
            let field_id = scope_root.children[cursor.field_index].index();
            let field_ref = ConversationSourceRef {
                node_id: field_id,
                span: field.span,
            };
            let refs = anthropic_system_refs(field_id, field);
            blocks.push(GenericConversationBlock {
                kind: GenericConversationBlockKind::System,
                message: None,
                source: Some(field_ref),
                field: Some(field_ref),
                category: GenericConversationCategory::System,
                role: NormalizedRole::System,
                role_source: None,
                openai_refs: None,
                anthropic_refs: refs,
                ambiguous_duplicate_field: false,
            });
            cursor.phase = GenericConversationPhase::SystemContent;
            cursor.element_index = 0;
            continue;
        }
        if cursor.phase == GenericConversationPhase::SystemContent {
            let field = parsed.node(scope_root.children[cursor.field_index]);
            let field_id = scope_root.children[cursor.field_index].index();
            let field_ref = ConversationSourceRef {
                node_id: field_id,
                span: field.span,
            };
            let (source, category, refs, ambiguous_duplicate_field) =
                if field.kind == JsonKind::Array && !field.children.is_empty() {
                    let element_id = field.children[cursor.element_index].index();
                    let element = parsed.node(field.children[cursor.element_index]);
                    let (category, refs, ambiguous_duplicate_field) =
                        anthropic_system_element(parsed, element_id, element);
                    (
                        ConversationSourceRef {
                            node_id: element_id,
                            span: element.span,
                        },
                        category,
                        refs,
                        ambiguous_duplicate_field,
                    )
                } else {
                    let (category, refs) = anthropic_system_scalar(field_id, field);
                    (field_ref, category, refs, false)
                };
            blocks.push(GenericConversationBlock {
                kind: GenericConversationBlockKind::Source,
                message: None,
                source: Some(source),
                field: Some(field_ref),
                category,
                role: NormalizedRole::System,
                role_source: None,
                openai_refs: None,
                anthropic_refs: refs,
                ambiguous_duplicate_field,
            });
            if field.kind == JsonKind::Array && !field.children.is_empty() {
                cursor.element_index += 1;
            } else {
                cursor.field_index += 1;
                cursor.phase = GenericConversationPhase::SystemHeader;
                cursor.element_index = 0;
            }
            continue;
        }

        let message_id = candidate.children[cursor.message_index].index();
        let message = parsed.node(candidate.children[cursor.message_index]);
        let message_ref = ConversationSourceRef {
            node_id: message_id,
            span: message.span,
        };
        let role_selection =
            selected_role_info_cached(parsed, message_id, message, style, role_cache);
        let role_source_id = role_selection.source_id;
        let role_source = role_source_id.map(|node_id| ConversationSourceRef {
            node_id,
            span: parsed.node_at(node_id).expect("role node must exist").span,
        });
        let role = role_source_id
            .map(|node_id| {
                normalized_role(
                    parsed,
                    parsed.node_at(node_id).expect("role node must exist"),
                )
            })
            .unwrap_or(NormalizedRole::Unknown);

        match cursor.phase {
            GenericConversationPhase::Message => {
                if role_selection.ambiguous_duplicate_field {
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Source,
                        message: Some(message_ref),
                        source: Some(message_ref),
                        field: None,
                        category: GenericConversationCategory::Unknown,
                        role: NormalizedRole::Unknown,
                        role_source: None,
                        openai_refs: None,
                        anthropic_refs: None,
                        ambiguous_duplicate_field: true,
                    });
                    advance_message(&mut cursor);
                } else {
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Message,
                        message: Some(message_ref),
                        source: None,
                        field: None,
                        category: GenericConversationCategory::Message,
                        role,
                        role_source,
                        openai_refs: None,
                        anthropic_refs: None,
                        ambiguous_duplicate_field: false,
                    });
                    cursor.phase = if message.kind == JsonKind::Object {
                        GenericConversationPhase::Fields
                    } else {
                        advance_message(&mut cursor);
                        GenericConversationPhase::Message
                    };
                }
            }
            GenericConversationPhase::Fields => {
                let field_id = message.children[cursor.field_index].index();
                let field = parsed.node(message.children[cursor.field_index]);
                let field_ref = ConversationSourceRef {
                    node_id: field_id,
                    span: field.span,
                };
                let classification =
                    source_classification(parsed, field_id, field, None, None, role, style);
                let array_elements = content_or_value_array(field, style);
                if let Some(elements) = array_elements {
                    let element_id = elements[cursor.element_index].index();
                    let element = parsed.node(elements[cursor.element_index]);
                    let classification = source_classification(
                        parsed,
                        field_id,
                        field,
                        Some(element_id),
                        Some(element),
                        role,
                        style,
                    );
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Source,
                        message: Some(message_ref),
                        source: Some(ConversationSourceRef {
                            node_id: element_id,
                            span: element.span,
                        }),
                        field: Some(field_ref),
                        category: classification.category,
                        role,
                        role_source,
                        openai_refs: classification.openai_refs,
                        anthropic_refs: classification.anthropic_refs,
                        ambiguous_duplicate_field: classification.ambiguous_duplicate_field,
                    });
                    cursor.element_index += 1;
                } else {
                    blocks.push(GenericConversationBlock {
                        kind: GenericConversationBlockKind::Source,
                        message: Some(message_ref),
                        source: Some(field_ref),
                        field: Some(field_ref),
                        category: classification.category,
                        role,
                        role_source,
                        openai_refs: classification.openai_refs,
                        anthropic_refs: classification.anthropic_refs,
                        ambiguous_duplicate_field: classification.ambiguous_duplicate_field,
                    });
                    cursor.field_index += 1;
                }
            }
            GenericConversationPhase::SystemHeader | GenericConversationPhase::SystemContent => {
                unreachable!("system phases are handled before message projection")
            }
        }
    }

    normalize_cursor(
        parsed,
        scope_root,
        candidate,
        &mut cursor,
        style,
        role_cache,
        &mut system_scan_budget,
    );
    let has_more = cursor_has_more(parsed, scope_root, candidate, cursor, style);
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
            ambiguous_duplicate_field: false,
        },
    })
}

fn ambiguous_wrapper_page(
    scope_root_id: usize,
    candidate_node_id: usize,
    scope_root: &JsonNode,
    candidate: &JsonNode,
) -> GenericConversationPage {
    let scope_root_ref = ConversationSourceRef {
        node_id: scope_root_id,
        span: scope_root.span,
    };
    let candidate_ref = ConversationSourceRef {
        node_id: candidate_node_id,
        span: candidate.span,
    };
    GenericConversationPage {
        blocks: vec![GenericConversationBlock {
            kind: GenericConversationBlockKind::Source,
            message: None,
            source: Some(scope_root_ref),
            field: None,
            category: GenericConversationCategory::Unknown,
            role: NormalizedRole::Unknown,
            role_source: None,
            openai_refs: None,
            anthropic_refs: None,
            ambiguous_duplicate_field: true,
        }],
        has_more: false,
        next_cursor: None,
        wrapper_ref: ConversationWrapperRef {
            scope_root: scope_root_ref,
            candidate: candidate_ref,
            ambiguous_duplicate_field: true,
        },
    }
}

fn cursor_position_is_valid(
    parsed: &ParsedJson<'_>,
    scope_root: &JsonNode,
    candidate: &JsonNode,
    cursor: GenericConversationCursor,
    style: ConversationStyle,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) -> bool {
    match cursor.phase {
        GenericConversationPhase::SystemHeader => {
            style == ConversationStyle::Anthropic
                && scope_root.kind == JsonKind::Object
                && cursor.message_index == 0
                && cursor.field_index <= scope_root.children.len()
                && cursor.element_index == 0
        }
        GenericConversationPhase::SystemContent => {
            if style != ConversationStyle::Anthropic
                || scope_root.kind != JsonKind::Object
                || cursor.message_index != 0
                || cursor.field_index >= scope_root.children.len()
            {
                return false;
            }
            let field = parsed.node(scope_root.children[cursor.field_index]);
            if object_key(field) != Some("system") {
                return false;
            }
            if field.kind == JsonKind::Array && !field.children.is_empty() {
                cursor.element_index < field.children.len()
            } else {
                cursor.element_index == 0
            }
        }
        GenericConversationPhase::Message => {
            cursor.message_index <= candidate.children.len()
                && cursor.field_index == 0
                && cursor.element_index == 0
        }
        GenericConversationPhase::Fields => {
            if cursor.message_index >= candidate.children.len() {
                return false;
            }
            let message = parsed.node(candidate.children[cursor.message_index]);
            if message.kind != JsonKind::Object || cursor.field_index >= message.children.len() {
                return false;
            }
            let field = parsed.node(message.children[cursor.field_index]);
            let role_selection = selected_role_info_cached(
                parsed,
                candidate.children[cursor.message_index].index(),
                message,
                style,
                role_cache,
            );
            if role_selection.ambiguous_duplicate_field
                || role_selection.source_id == Some(message.children[cursor.field_index].index())
            {
                return false;
            }
            match content_or_value_array(field, style) {
                Some(elements) => cursor.element_index < elements.len(),
                None => cursor.element_index == 0,
            }
        }
    }
}

fn normalize_cursor(
    parsed: &ParsedJson<'_>,
    scope_root: &JsonNode,
    candidate: &JsonNode,
    cursor: &mut GenericConversationCursor,
    style: ConversationStyle,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
    system_scan_budget: &mut usize,
) {
    loop {
        if style == ConversationStyle::Anthropic
            && scope_root.kind == JsonKind::Object
            && matches!(
                cursor.phase,
                GenericConversationPhase::SystemHeader | GenericConversationPhase::SystemContent
            )
        {
            match cursor.phase {
                GenericConversationPhase::SystemHeader => {
                    if cursor.field_index >= scope_root.children.len() {
                        cursor.phase = GenericConversationPhase::Message;
                        cursor.message_index = 0;
                        cursor.field_index = 0;
                        cursor.element_index = 0;
                        continue;
                    }
                    let field = parsed.node(scope_root.children[cursor.field_index]);
                    if object_key(field) != Some("system") {
                        if *system_scan_budget == 0 {
                            return;
                        }
                        *system_scan_budget -= 1;
                        cursor.field_index += 1;
                        continue;
                    }
                    return;
                }
                GenericConversationPhase::SystemContent => {
                    let field = parsed.node(scope_root.children[cursor.field_index]);
                    if object_key(field) == Some("system")
                        && if field.kind == JsonKind::Array {
                            if field.children.is_empty() {
                                cursor.element_index == 0
                            } else {
                                cursor.element_index < field.children.len()
                            }
                        } else {
                            cursor.element_index == 0
                        }
                    {
                        return;
                    }
                    cursor.field_index += 1;
                    cursor.element_index = 0;
                    cursor.phase = GenericConversationPhase::SystemHeader;
                    continue;
                }
                GenericConversationPhase::Message | GenericConversationPhase::Fields => {}
            }
        }
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
        let role_selection = selected_role_info_cached(
            parsed,
            candidate.children[cursor.message_index].index(),
            message,
            style,
            role_cache,
        );
        if role_selection.ambiguous_duplicate_field {
            cursor.phase = GenericConversationPhase::Message;
            cursor.field_index = 0;
            cursor.element_index = 0;
            return;
        }
        if role_selection.source_id == Some(message.children[cursor.field_index].index()) {
            cursor.field_index += 1;
            cursor.element_index = 0;
            continue;
        }
        if let Some(elements) = content_or_value_array(field, style) {
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

fn cursor_has_more(
    parsed: &ParsedJson<'_>,
    scope_root: &JsonNode,
    candidate: &JsonNode,
    cursor: GenericConversationCursor,
    style: ConversationStyle,
) -> bool {
    match cursor.phase {
        GenericConversationPhase::SystemHeader => {
            style == ConversationStyle::Anthropic && cursor.field_index < scope_root.children.len()
        }
        GenericConversationPhase::SystemContent => {
            style == ConversationStyle::Anthropic
                && cursor.field_index < scope_root.children.len()
                && {
                    let field = parsed.node(scope_root.children[cursor.field_index]);
                    object_key(field) == Some("system")
                        && if field.kind == JsonKind::Array && !field.children.is_empty() {
                            cursor.element_index < field.children.len()
                        } else {
                            cursor.element_index == 0
                        }
                }
        }
        GenericConversationPhase::Message | GenericConversationPhase::Fields => {
            cursor.message_index < candidate.children.len()
        }
    }
}

#[derive(Clone, Copy)]
struct RoleSelection {
    source_id: Option<usize>,
    ambiguous_duplicate_field: bool,
}

fn selected_role_info(
    parsed: &ParsedJson<'_>,
    message: &JsonNode,
    style: ConversationStyle,
) -> RoleSelection {
    #[cfg(test)]
    ROLE_SCAN_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let ambiguous_duplicate_field = message_has_duplicate_dependency(parsed, message, style);
    let role = message
        .children
        .iter()
        .copied()
        .find(|id| object_key(parsed.node(*id)) == Some("role"));
    let source_id = if ambiguous_duplicate_field {
        None
    } else if role.is_some() || style != ConversationStyle::Generic {
        role.map(|id| id.index())
    } else {
        message
            .children
            .iter()
            .copied()
            .find(|id| object_key(parsed.node(*id)) == Some("from"))
            .map(|id| id.index())
    };
    RoleSelection {
        source_id,
        ambiguous_duplicate_field,
    }
}

#[cfg(test)]
fn reset_role_scan_count() {
    ROLE_SCAN_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn role_scan_count() -> usize {
    ROLE_SCAN_COUNT.with(std::cell::Cell::get)
}

#[cfg(test)]
fn reset_wrapper_scan_count() {
    WRAPPER_SCAN_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn wrapper_scan_count() -> usize {
    WRAPPER_SCAN_COUNT.with(std::cell::Cell::get)
}

fn selected_role_info_cached(
    parsed: &ParsedJson<'_>,
    message_id: usize,
    message: &JsonNode,
    style: ConversationStyle,
    role_cache: Option<&std::sync::Mutex<Option<RoleCache>>>,
) -> RoleSelection {
    let Some(role_cache) = role_cache else {
        return selected_role_info(parsed, message, style);
    };
    let Ok(mut cache) = role_cache.lock() else {
        return selected_role_info(parsed, message, style);
    };
    if let Some(entry) = cache.as_ref() {
        if entry.message_id == message_id && entry.style == style {
            return RoleSelection {
                source_id: entry.role_source_id,
                ambiguous_duplicate_field: entry.ambiguous_duplicate_field,
            };
        }
    }
    let selection = selected_role_info(parsed, message, style);
    *cache = Some(RoleCache {
        message_id,
        style,
        role_source_id: selection.source_id,
        ambiguous_duplicate_field: selection.ambiguous_duplicate_field,
    });
    selection
}

fn normalized_role(parsed: &ParsedJson<'_>, node: &JsonNode) -> NormalizedRole {
    let Some(value) = string_value(parsed, node) else {
        return NormalizedRole::Unknown;
    };
    match value.as_ref() {
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

struct SourceClassification {
    category: GenericConversationCategory,
    openai_refs: Option<ConversationOpenAiRefs>,
    anthropic_refs: Option<ConversationAnthropicRefs>,
    ambiguous_duplicate_field: bool,
}

fn generic_classification(category: GenericConversationCategory) -> SourceClassification {
    SourceClassification {
        category,
        openai_refs: None,
        anthropic_refs: None,
        ambiguous_duplicate_field: false,
    }
}

fn source_classification(
    parsed: &ParsedJson<'_>,
    field_id: usize,
    field: &JsonNode,
    element_id: Option<usize>,
    element: Option<&JsonNode>,
    role: NormalizedRole,
    style: ConversationStyle,
) -> SourceClassification {
    if style == ConversationStyle::Generic {
        return generic_classification(field_category(field));
    }
    if style == ConversationStyle::Anthropic {
        let (category, refs, ambiguous_duplicate_field) =
            anthropic_source_classification(parsed, field_id, field, element_id, element);
        return SourceClassification {
            category,
            openai_refs: None,
            anthropic_refs: refs,
            ambiguous_duplicate_field,
        };
    }
    let field_ref = ConversationSourceRef {
        node_id: field_id,
        span: field.span,
    };
    match object_key(field) {
        Some("content") => {
            if let (Some(element_id), Some(element)) = (element_id, element) {
                let (category, refs, ambiguous_duplicate_field) =
                    openai_content_block(parsed, element_id, element, role);
                return SourceClassification {
                    category,
                    openai_refs: refs,
                    anthropic_refs: None,
                    ambiguous_duplicate_field,
                };
            }
            if role == NormalizedRole::Tool {
                if field.kind == JsonKind::Object
                    && content_children_have_duplicate_ui_fields(parsed, field)
                {
                    return SourceClassification {
                        category: GenericConversationCategory::Unknown,
                        openai_refs: None,
                        anthropic_refs: None,
                        ambiguous_duplicate_field: true,
                    };
                }
                return generic_classification(GenericConversationCategory::ToolResult);
            }
            if field.kind == JsonKind::String {
                return SourceClassification {
                    category: GenericConversationCategory::Text,
                    openai_refs: Some(ConversationOpenAiRefs {
                        text: Some(field_ref),
                        ..ConversationOpenAiRefs::default()
                    }),
                    anthropic_refs: None,
                    ambiguous_duplicate_field: false,
                };
            }
            generic_classification(GenericConversationCategory::Content)
        }
        Some("value") => generic_classification(GenericConversationCategory::Value),
        Some("tool_calls") => {
            if let (Some(element_id), Some(element)) = (element_id, element) {
                let (category, refs, ambiguous_duplicate_field) =
                    openai_tool_call(parsed, element_id, element);
                SourceClassification {
                    category,
                    openai_refs: refs,
                    anthropic_refs: None,
                    ambiguous_duplicate_field,
                }
            } else if field.kind == JsonKind::Array {
                generic_classification(GenericConversationCategory::Tool)
            } else {
                generic_classification(GenericConversationCategory::Unknown)
            }
        }
        Some("function_call") => {
            let (category, refs, ambiguous_duplicate_field) =
                openai_legacy_function_call(parsed, field_id, field);
            SourceClassification {
                category,
                openai_refs: refs,
                anthropic_refs: None,
                ambiguous_duplicate_field,
            }
        }
        Some("tool_call_id") if role == NormalizedRole::Tool => SourceClassification {
            category: GenericConversationCategory::ToolResult,
            openai_refs: None,
            anthropic_refs: None,
            ambiguous_duplicate_field: false,
        },
        Some("tool_call_id") => generic_classification(GenericConversationCategory::Tool),
        _ => generic_classification(field_category(field)),
    }
}

fn anthropic_source_classification(
    parsed: &ParsedJson<'_>,
    field_id: usize,
    field: &JsonNode,
    element_id: Option<usize>,
    element: Option<&JsonNode>,
) -> (
    GenericConversationCategory,
    Option<ConversationAnthropicRefs>,
    bool,
) {
    if object_key(field) != Some("content") {
        return (field_category(field), None, false);
    }
    if let (Some(element_id), Some(element)) = (element_id, element) {
        return anthropic_content_block(parsed, element_id, element);
    }
    if field.kind == JsonKind::String {
        return (
            GenericConversationCategory::Text,
            Some(ConversationAnthropicRefs {
                text: Some(ConversationSourceRef {
                    node_id: field_id,
                    span: field.span,
                }),
                ..ConversationAnthropicRefs::default()
            }),
            false,
        );
    }
    if field.kind == JsonKind::Array {
        (GenericConversationCategory::Content, None, false)
    } else {
        (GenericConversationCategory::Unknown, None, false)
    }
}

fn anthropic_content_block(
    parsed: &ParsedJson<'_>,
    element_id: usize,
    element: &JsonNode,
) -> (
    GenericConversationCategory,
    Option<ConversationAnthropicRefs>,
    bool,
) {
    let element_ref = ConversationSourceRef {
        node_id: element_id,
        span: element.span,
    };
    let mut refs = ConversationAnthropicRefs {
        block: Some(element_ref),
        ..ConversationAnthropicRefs::default()
    };
    if element.kind != JsonKind::Object {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    }
    if has_duplicate_key(parsed, element, "type") {
        return (GenericConversationCategory::Unknown, None, true);
    }
    let Some(type_node) = direct_child_by_key(parsed, element, "type") else {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    };
    let Some(block_type) = string_value(parsed, type_node) else {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    };
    match block_type.as_ref() {
        "text" => {
            if has_duplicate_key(parsed, element, "text") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(text) = direct_child_by_key(parsed, element, "text") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if text.kind != JsonKind::String {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.text = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, text),
                span: text.span,
            });
            (GenericConversationCategory::Text, Some(refs), false)
        }
        "thinking" => {
            if has_duplicate_key(parsed, element, "thinking") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(thinking) = direct_child_by_key(parsed, element, "thinking") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if thinking.kind != JsonKind::String {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.thinking = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, thinking),
                span: thinking.span,
            });
            (GenericConversationCategory::Thinking, Some(refs), false)
        }
        "redacted_thinking" => {
            if has_duplicate_key(parsed, element, "data") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(data) = direct_child_by_key(parsed, element, "data") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if data.kind != JsonKind::String {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.data = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, data),
                span: data.span,
            });
            (
                GenericConversationCategory::RedactedThinking,
                Some(refs),
                false,
            )
        }
        "tool_use" => {
            if ["id", "name", "input"]
                .iter()
                .any(|key| has_duplicate_key(parsed, element, key))
            {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(id) = direct_child_by_key(parsed, element, "id") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            let Some(name) = direct_child_by_key(parsed, element, "name") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            let Some(input) = direct_child_by_key(parsed, element, "input") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if id.kind != JsonKind::String
                || name.kind != JsonKind::String
                || input.kind != JsonKind::Object
            {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.id = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, id),
                span: id.span,
            });
            refs.name = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, name),
                span: name.span,
            });
            refs.input = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, input),
                span: input.span,
            });
            (GenericConversationCategory::ToolUse, Some(refs), false)
        }
        "tool_result" => {
            if ["tool_use_id", "content", "is_error"]
                .iter()
                .any(|key| has_duplicate_key(parsed, element, key))
            {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(tool_use_id) = direct_child_by_key(parsed, element, "tool_use_id") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            let Some(content) = direct_child_by_key(parsed, element, "content") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if tool_use_id.kind != JsonKind::String
                || !matches!(content.kind, JsonKind::String | JsonKind::Array)
            {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            if content_children_have_duplicate_ui_fields(parsed, content) {
                return (GenericConversationCategory::Unknown, None, true);
            }
            refs.tool_use_id = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, tool_use_id),
                span: tool_use_id.span,
            });
            refs.content = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, content),
                span: content.span,
            });
            (GenericConversationCategory::ToolResult, Some(refs), false)
        }
        _ => (GenericConversationCategory::Unknown, Some(refs), false),
    }
}

fn content_children_have_duplicate_ui_fields(parsed: &ParsedJson<'_>, content: &JsonNode) -> bool {
    content.children.iter().any(|child_id| {
        let child = parsed.node(*child_id);
        if child.kind != JsonKind::Object {
            return false;
        }
        if has_duplicate_key(parsed, child, "type") {
            return true;
        }
        direct_child_by_key(parsed, child, "type").is_some_and(|type_node| {
            string_value(parsed, type_node).as_deref() == Some("text")
                && has_duplicate_key(parsed, child, "text")
        })
    })
}

fn anthropic_system_refs(field_id: usize, field: &JsonNode) -> Option<ConversationAnthropicRefs> {
    if field.kind == JsonKind::String {
        return Some(ConversationAnthropicRefs {
            text: Some(ConversationSourceRef {
                node_id: field_id,
                span: field.span,
            }),
            ..ConversationAnthropicRefs::default()
        });
    }
    None
}

fn anthropic_system_scalar(
    field_id: usize,
    field: &JsonNode,
) -> (
    GenericConversationCategory,
    Option<ConversationAnthropicRefs>,
) {
    if field.kind == JsonKind::String {
        (
            GenericConversationCategory::Text,
            Some(ConversationAnthropicRefs {
                text: Some(ConversationSourceRef {
                    node_id: field_id,
                    span: field.span,
                }),
                ..ConversationAnthropicRefs::default()
            }),
        )
    } else {
        (
            GenericConversationCategory::Unknown,
            Some(ConversationAnthropicRefs {
                block: Some(ConversationSourceRef {
                    node_id: field_id,
                    span: field.span,
                }),
                ..ConversationAnthropicRefs::default()
            }),
        )
    }
}

fn anthropic_system_element(
    parsed: &ParsedJson<'_>,
    element_id: usize,
    element: &JsonNode,
) -> (
    GenericConversationCategory,
    Option<ConversationAnthropicRefs>,
    bool,
) {
    if element.kind == JsonKind::String {
        return (
            GenericConversationCategory::Unknown,
            Some(ConversationAnthropicRefs {
                block: Some(ConversationSourceRef {
                    node_id: element_id,
                    span: element.span,
                }),
                ..ConversationAnthropicRefs::default()
            }),
            false,
        );
    }
    let element_ref = ConversationSourceRef {
        node_id: element_id,
        span: element.span,
    };
    let unknown = || {
        (
            GenericConversationCategory::Unknown,
            Some(ConversationAnthropicRefs {
                block: Some(element_ref),
                ..ConversationAnthropicRefs::default()
            }),
            false,
        )
    };
    if element.kind != JsonKind::Object {
        return unknown();
    }
    if has_duplicate_key(parsed, element, "type") {
        return (GenericConversationCategory::Unknown, None, true);
    }
    let Some(type_node) = direct_child_by_key(parsed, element, "type") else {
        return unknown();
    };
    if string_value(parsed, type_node).as_deref() != Some("text") {
        return unknown();
    }
    if has_duplicate_key(parsed, element, "text") {
        return (GenericConversationCategory::Unknown, None, true);
    }
    let Some(text) = direct_child_by_key(parsed, element, "text") else {
        return unknown();
    };
    if text.kind != JsonKind::String {
        return unknown();
    }
    (
        GenericConversationCategory::Text,
        Some(ConversationAnthropicRefs {
            block: Some(element_ref),
            text: Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, text),
                span: text.span,
            }),
            ..ConversationAnthropicRefs::default()
        }),
        false,
    )
}

fn openai_content_block(
    parsed: &ParsedJson<'_>,
    element_id: usize,
    element: &JsonNode,
    role: NormalizedRole,
) -> (
    GenericConversationCategory,
    Option<ConversationOpenAiRefs>,
    bool,
) {
    let element_ref = ConversationSourceRef {
        node_id: element_id,
        span: element.span,
    };
    let mut refs = ConversationOpenAiRefs {
        block: Some(element_ref),
        ..ConversationOpenAiRefs::default()
    };
    if element.kind == JsonKind::Object && has_duplicate_key(parsed, element, "type") {
        return (GenericConversationCategory::Unknown, None, true);
    }
    let Some(type_node) = direct_child_by_key(parsed, element, "type") else {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    };
    let Some(block_type) = string_value(parsed, type_node) else {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    };
    match block_type.as_ref() {
        "text" => {
            if has_duplicate_key(parsed, element, "text") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(text_node) = direct_child_by_key(parsed, element, "text") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if text_node.kind != JsonKind::String {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.text = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, text_node),
                span: text_node.span,
            });
            if role == NormalizedRole::Tool {
                (GenericConversationCategory::ToolResult, Some(refs), false)
            } else {
                (GenericConversationCategory::Text, Some(refs), false)
            }
        }
        "image_url" => {
            if has_duplicate_key(parsed, element, "image_url") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(image) = direct_child_by_key(parsed, element, "image_url") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if image.kind != JsonKind::Object {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            if has_duplicate_key(parsed, image, "url") {
                return (GenericConversationCategory::Unknown, None, true);
            }
            let Some(url) = direct_child_by_key(parsed, image, "url") else {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            };
            if url.kind != JsonKind::String {
                return (GenericConversationCategory::Unknown, Some(refs), false);
            }
            refs.image = Some(ConversationSourceRef {
                node_id: node_id_from_child(parsed, element, image),
                span: image.span,
            });
            (GenericConversationCategory::Image, Some(refs), false)
        }
        _ => (GenericConversationCategory::Unknown, Some(refs), false),
    }
}

fn openai_tool_call(
    parsed: &ParsedJson<'_>,
    element_id: usize,
    element: &JsonNode,
) -> (
    GenericConversationCategory,
    Option<ConversationOpenAiRefs>,
    bool,
) {
    let element_ref = ConversationSourceRef {
        node_id: element_id,
        span: element.span,
    };
    let mut refs = ConversationOpenAiRefs {
        block: Some(element_ref),
        ..ConversationOpenAiRefs::default()
    };
    if has_duplicate_key(parsed, element, "type") {
        return (GenericConversationCategory::Unknown, None, true);
    }
    if direct_child_by_key(parsed, element, "type")
        .is_some_and(|type_node| string_value(parsed, type_node).as_deref() != Some("function"))
    {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    }
    if ["id", "function"]
        .iter()
        .any(|key| has_duplicate_key(parsed, element, key))
    {
        return (GenericConversationCategory::Unknown, None, true);
    }
    refs.call_id = direct_child_by_key(parsed, element, "id").map(|node| ConversationSourceRef {
        node_id: node_id_from_child(parsed, element, node),
        span: node.span,
    });
    let Some(function) = direct_child_by_key(parsed, element, "function") else {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    };
    if function.kind != JsonKind::Object {
        return (GenericConversationCategory::Unknown, Some(refs), false);
    }
    if ["name", "arguments"]
        .iter()
        .any(|key| has_duplicate_key(parsed, function, key))
    {
        return (GenericConversationCategory::Unknown, None, true);
    }
    refs.function = Some(ConversationSourceRef {
        node_id: node_id_from_child(parsed, element, function),
        span: function.span,
    });
    let name = direct_child_by_key(parsed, function, "name");
    let arguments = direct_child_by_key(parsed, function, "arguments");
    refs.name = name.map(|node| ConversationSourceRef {
        node_id: node_id_from_child(parsed, function, node),
        span: node.span,
    });
    refs.arguments = arguments.map(|node| ConversationSourceRef {
        node_id: node_id_from_child(parsed, function, node),
        span: node.span,
    });
    let valid = name.is_some_and(|node| node.kind == JsonKind::String)
        && arguments.is_some_and(|node| matches!(node.kind, JsonKind::String | JsonKind::Object));
    if valid {
        (GenericConversationCategory::ToolCall, Some(refs), false)
    } else {
        (GenericConversationCategory::Unknown, Some(refs), false)
    }
}

fn openai_legacy_function_call(
    parsed: &ParsedJson<'_>,
    field_id: usize,
    field: &JsonNode,
) -> (
    GenericConversationCategory,
    Option<ConversationOpenAiRefs>,
    bool,
) {
    if field.kind != JsonKind::Object {
        return (GenericConversationCategory::Unknown, None, false);
    }
    if ["name", "arguments"]
        .iter()
        .any(|key| has_duplicate_key(parsed, field, key))
    {
        return (GenericConversationCategory::Unknown, None, true);
    }
    let mut refs = ConversationOpenAiRefs {
        function: Some(ConversationSourceRef {
            node_id: field_id,
            span: field.span,
        }),
        ..ConversationOpenAiRefs::default()
    };
    let name = direct_child_by_key(parsed, field, "name");
    let arguments = direct_child_by_key(parsed, field, "arguments");
    refs.name = name.map(|node| ConversationSourceRef {
        node_id: node_id_from_child(parsed, field, node),
        span: node.span,
    });
    refs.arguments = arguments.map(|node| ConversationSourceRef {
        node_id: node_id_from_child(parsed, field, node),
        span: node.span,
    });
    let valid = name.is_some_and(|node| node.kind == JsonKind::String)
        && arguments.is_some_and(|node| matches!(node.kind, JsonKind::String | JsonKind::Object));
    if valid {
        (GenericConversationCategory::ToolCall, Some(refs), false)
    } else {
        (GenericConversationCategory::Unknown, Some(refs), false)
    }
}

fn node_id_from_child(parsed: &ParsedJson<'_>, parent: &JsonNode, child: &JsonNode) -> usize {
    parent
        .children
        .iter()
        .copied()
        .find(|id| std::ptr::eq(parsed.node(*id), child))
        .map(|id| id.index())
        .expect("child node must belong to parent")
}

fn content_or_value_array(
    node: &JsonNode,
    style: ConversationStyle,
) -> Option<&[crate::json::NodeId]> {
    if node.kind != JsonKind::Array
        || !(matches!(object_key(node), Some("content" | "value"))
            || style == ConversationStyle::OpenAi && object_key(node) == Some("tool_calls"))
    {
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
            ConversationKind::Possible
        );
    }

    #[test]
    fn long_role_discriminator_is_unknown_without_materializing_protocol_body() {
        let long_role = format!("user{}", "x".repeat(MAX_DISCRIMINATOR_BYTES));
        let input = format!(
            r#"{{"messages":[{{"role":"{long_role}","content":"x"}},{{"role":"assistant","content":"y"}}]}}"#
        );
        assert_eq!(kind(&input), ConversationKind::Possible);
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
    fn duplicate_wrapper_fields_return_one_ambiguous_full_scope_source() {
        let parsed = parse_json(
            br#"{"mess\u0061ges":[{"role":"user","content":"first"}],"messages":[{"role":"assistant","content":"second"}]}"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let candidate = parsed.node(parsed.root()).children[0].index();
        let detected = detect_candidate(&parsed, root, candidate).unwrap();
        assert_eq!(detected.kind, ConversationKind::None);
        assert!(detected.ambiguous_duplicate_field);

        let page = generic_conversation_page(&parsed, root, candidate, None, 100).unwrap();
        assert_eq!(page.blocks.len(), 1);
        assert_eq!(page.blocks[0].kind, GenericConversationBlockKind::Source);
        assert_eq!(
            page.blocks[0].category,
            GenericConversationCategory::Unknown
        );
        assert!(page.blocks[0].ambiguous_duplicate_field);
        assert_eq!(
            page.blocks[0].source.unwrap().span,
            parsed.node(parsed.root()).span
        );
        assert!(page.wrapper_ref.ambiguous_duplicate_field);
        assert!(!page.has_more);
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
    }

    #[test]
    fn ambiguous_message_dependencies_fall_back_without_hiding_following_messages() {
        let mut tail_fields = String::new();
        for index in 0..220 {
            tail_fields.push_str(&format!(r#""unknown-{index}":true,"#));
        }
        let input = format!(
            r#"[{{"ro\u006ce":"user","role":false,"content":"ambiguous-role"}},{{"role":"assistant","content":"first","content":false}},{{"role":"user","from":"human","from":"other","content":"from-is-ignored"}},{{"role":"assistant","unknown":true,"unknown":false,"content":"unknown-duplicate"}},{{"role":"assistant",{tail_fields}"content":"late-first","content":"late-second"}},{{"role":"tool","content":"after"}}]"#
        );
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

        let ambiguous = blocks
            .iter()
            .filter(|block| block.ambiguous_duplicate_field)
            .collect::<Vec<_>>();
        assert_eq!(ambiguous.len(), 3);
        for block in &ambiguous {
            assert_eq!(block.kind, GenericConversationBlockKind::Source);
            assert_eq!(block.category, GenericConversationCategory::Unknown);
            assert_eq!(block.role, NormalizedRole::Unknown);
            assert!(block.role_source.is_none());
            assert!(block.openai_refs.is_none());
            assert!(block.anthropic_refs.is_none());
            assert_eq!(block.message.unwrap().span, block.source.unwrap().span);
        }
        assert!(blocks.iter().any(|block| {
            block.kind == GenericConversationBlockKind::Message
                && block.role == NormalizedRole::User
        }));
        assert!(blocks.iter().any(|block| {
            block.kind == GenericConversationBlockKind::Message
                && block.role == NormalizedRole::Tool
        }));
    }

    #[test]
    fn ambiguous_messages_do_not_create_a_strong_candidate_classification() {
        assert_eq!(
            kind(
                r#"[{"role":"user","role":"assistant","content":"a"},{"role":"assistant","content":"b","content":"c"}]"#
            ),
            ConversationKind::None
        );
    }

    #[test]
    fn tool_dependency_duplicates_fall_back_for_generic_and_openai_only() {
        let parsed = parse_json(
            br#"[{"role":"assistant","content":"x","tool_calls":[],"tool_calls":[]},{"role":"assistant","content":"x","function_call":{},"function_call":{}},{"role":"tool","content":"x","tool_call_id":"a","tool_call_id":"b"},{"role":"assistant","content":"normal"}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        for style in [ConversationStyle::Generic, ConversationStyle::OpenAi] {
            let mut cursor = None;
            let mut blocks = Vec::new();
            loop {
                let page = conversation_page(&parsed, root, root, cursor, 1, style).unwrap();
                blocks.extend(page.blocks);
                cursor = page.next_cursor;
                if !page.has_more {
                    break;
                }
            }
            assert_eq!(
                blocks
                    .iter()
                    .filter(|block| block.ambiguous_duplicate_field)
                    .count(),
                3
            );
            assert_eq!(
                blocks
                    .iter()
                    .filter(|block| block.kind == GenericConversationBlockKind::Message)
                    .count(),
                1
            );
        }

        let anthropic =
            conversation_page(&parsed, root, root, None, 1, ConversationStyle::Anthropic).unwrap();
        assert!(!anthropic.blocks[0].ambiguous_duplicate_field);
        assert_eq!(
            anthropic.blocks[0].kind,
            GenericConversationBlockKind::Message
        );
    }

    #[test]
    fn duplicate_anthropic_system_wrapper_falls_back_to_the_complete_scope() {
        let parsed = parse_json(
            br#"{"system":"first","system":"second","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":[{"type":"thinking","thinking":"work"}]}]}"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let candidate = parsed.node(parsed.root()).children[2].index();
        assert!(
            !detect_candidate(&parsed, root, candidate)
                .unwrap()
                .ambiguous_duplicate_field
        );

        let page = conversation_page(
            &parsed,
            root,
            candidate,
            None,
            100,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert_eq!(page.blocks.len(), 1);
        assert!(page.wrapper_ref.ambiguous_duplicate_field);
        assert_eq!(
            page.blocks[0].source.unwrap().span,
            parsed.node(parsed.root()).span
        );
        assert!(page.blocks[0].ambiguous_duplicate_field);
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

        assert_eq!(blocks[0].kind, GenericConversationBlockKind::Source);
        assert_eq!(blocks[0].category, GenericConversationCategory::Unknown);
        assert_eq!(blocks[0].role, NormalizedRole::Unknown);
        assert!(blocks[0].ambiguous_duplicate_field);
        assert_eq!(
            blocks[0].message.unwrap().node_id,
            blocks[0].source.unwrap().node_id
        );
        assert!(blocks[0].role_source.is_none());
        assert!(blocks[0].openai_refs.is_none());
        assert!(blocks[0].anthropic_refs.is_none());
        assert_eq!(
            blocks
                .iter()
                .map(|block| (block.kind, block.category))
                .collect::<Vec<_>>(),
            vec![
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
        assert_eq!(blocks[1].role, NormalizedRole::Unknown);
        assert_eq!(blocks[2].role, NormalizedRole::User);
        assert_eq!(
            blocks[5].source.unwrap().node_id,
            blocks[5].field.unwrap().node_id
        );
        assert!(
            blocks
                .windows(2)
                .all(|pair| pair[0].message.unwrap().span.start
                    <= pair[1].message.unwrap().span.start)
        );
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
                    .map(|block| block.message.unwrap().node_id),
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
        let bytes = input.into_bytes();
        reset_role_scan_count();
        let tree = crate::tree::TreeDocument::from_bytes(bytes.clone()).unwrap();
        let root = tree.root().id;
        let mut cursor = None;
        let mut first_roles = Vec::new();
        let mut second_roles = Vec::new();
        loop {
            let page = tree
                .generic_conversation_page(root, root, cursor, 1)
                .unwrap();
            for block in page.blocks {
                if block.message.unwrap().node_id == 1 {
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

        reset_role_scan_count();
        let tree = crate::tree::TreeDocument::from_bytes(bytes).unwrap();
        let root = tree.root().id;
        let mut cursor = None;
        loop {
            let page = tree
                .conversation_page(root, root, cursor, 1, ConversationStyle::Anthropic)
                .unwrap();
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(role_scan_count(), 2);
    }

    #[test]
    fn cached_openai_tool_message_scans_wide_content_once_across_pages() {
        let elements = (0..128)
            .map(|index| format!(r#"{{"type":"text","text":"item-{index}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let padding = (0..220)
            .map(|index| format!(r#""padding-{index}":true"#))
            .collect::<Vec<_>>()
            .join(",");
        let input =
            format!(r#"[{{"role":"tool","content":[{elements}],"is_error":false,{padding}}}]"#);
        reset_role_scan_count();
        let tree = crate::tree::TreeDocument::from_bytes(input.into_bytes()).unwrap();
        let root = tree.root().id;
        let mut cursor = None;
        let mut block_count = 0;
        loop {
            let page = tree
                .conversation_page(root, root, cursor, 1, ConversationStyle::OpenAi)
                .unwrap();
            block_count += page.blocks.len();
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(block_count, 1 + 128 + 1 + 220);
        assert_eq!(role_scan_count(), 1);
    }

    #[test]
    fn tree_document_caches_wrapper_scan_across_pages_and_rechecks_new_keys() {
        let messages = (0..128)
            .map(|index| format!(r#"{{"role":"user","content":"message-{index}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let conversation = r#"{"role":"user","content":"other"}"#;
        let padding = (0..128)
            .map(|index| format!(r#""padding-{index}":true"#))
            .collect::<Vec<_>>()
            .join(",");
        let input =
            format!(r#"{{{padding},"messages":[{messages}],"conversation":[{conversation}]}}"#);
        let tree = crate::tree::TreeDocument::from_bytes(input.into_bytes()).unwrap();
        let root = tree.root().id;
        let root_children = tree.children(root, 0, 200).unwrap();
        let messages_id = root_children
            .nodes
            .iter()
            .find(|node| node.label == "messages")
            .unwrap()
            .id;
        let conversation_id = root_children
            .nodes
            .iter()
            .find(|node| node.label == "conversation")
            .unwrap()
            .id;

        reset_wrapper_scan_count();
        let mut cursor = None;
        let mut page_count = 0;
        loop {
            let page = tree
                .generic_conversation_page(root, messages_id, cursor, 1)
                .unwrap();
            page_count += 1;
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(page_count, 256);
        assert_eq!(wrapper_scan_count(), 1);

        let style_page =
            tree.conversation_page(root, messages_id, None, 1, ConversationStyle::Anthropic);
        assert!(style_page.is_some());
        assert_eq!(wrapper_scan_count(), 1);
        let mut anthropic_cursor = None;
        let mut anthropic_page_count = 0;
        let mut anthropic_message_count = 0;
        loop {
            let page = tree
                .conversation_page(
                    root,
                    messages_id,
                    anthropic_cursor,
                    1,
                    ConversationStyle::Anthropic,
                )
                .unwrap();
            anthropic_page_count += 1;
            anthropic_message_count += page
                .blocks
                .iter()
                .filter(|block| block.kind == GenericConversationBlockKind::Message)
                .count();
            anthropic_cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert!(anthropic_page_count >= 256);
        assert_eq!(anthropic_message_count, 128);
        assert_eq!(wrapper_scan_count(), 1);

        let other_candidate_page = tree.generic_conversation_page(root, conversation_id, None, 1);
        assert!(other_candidate_page.is_some());
        assert_eq!(wrapper_scan_count(), 2);

        let collection_input =
            format!(r#"[{{"messages":[{conversation}]}},{{"messages":[{conversation}]}}]"#);
        let collection =
            crate::tree::TreeDocument::from_bytes(collection_input.into_bytes()).unwrap();
        let items = collection.children(collection.root().id, 0, 2).unwrap();
        let first_item = items.nodes[0].id;
        let second_item = items.nodes[1].id;
        let first_candidate = collection.children(first_item, 0, 10).unwrap().nodes[0].id;
        let second_candidate = collection.children(second_item, 0, 10).unwrap().nodes[0].id;
        reset_wrapper_scan_count();
        assert!(collection
            .generic_conversation_page(first_item, first_candidate, None, 1)
            .is_some());
        assert!(collection
            .generic_conversation_page(second_item, second_candidate, None, 1)
            .is_some());
        assert_eq!(wrapper_scan_count(), 2);

        let mut duplicate_input =
            String::from(r#"{"messages":[{"role":"user","content":"first"}],"#);
        for index in 0..220 {
            duplicate_input.push_str(&format!(r#""padding-{index}":true,"#));
        }
        duplicate_input.push_str(r#""messages":[{"role":"assistant","content":"tail"}]}"#);
        let duplicate_tree =
            crate::tree::TreeDocument::from_bytes(duplicate_input.into_bytes()).unwrap();
        let duplicate_root = duplicate_tree.root().id;
        let duplicate_candidate = duplicate_tree
            .children(duplicate_root, 0, 200)
            .unwrap()
            .nodes[0]
            .id;
        reset_wrapper_scan_count();
        let duplicate_page = duplicate_tree
            .generic_conversation_page(duplicate_root, duplicate_candidate, None, 1)
            .unwrap();
        assert_eq!(wrapper_scan_count(), 1);
        assert!(duplicate_page.wrapper_ref.ambiguous_duplicate_field);
        assert_eq!(duplicate_page.blocks.len(), 1);
        assert_eq!(
            duplicate_page.blocks[0].source.unwrap().span,
            duplicate_tree.root().span
        );
        assert!(duplicate_tree
            .generic_conversation_page(duplicate_root, duplicate_candidate, None, 1)
            .is_some());
        assert_eq!(wrapper_scan_count(), 1);
        assert!(duplicate_tree
            .generic_conversation_page(
                duplicate_root,
                duplicate_candidate,
                Some(GenericConversationCursor {
                    message_index: 0,
                    phase: GenericConversationPhase::Fields,
                    field_index: 0,
                    element_index: 0,
                }),
                1,
            )
            .is_none());
    }

    #[test]
    fn openai_child_duplicates_clear_refs_but_keep_sibling_sources_and_signal() {
        let parsed = parse_json(
            br#"[{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"text","text":"first","text":"second"},{"type":"image_url","image_url":{"url":"one","url":"two"}},{"type":"image_url","image_url":{"url":"good"}}],"tool_calls":[{"type":"function","id":"ok","function":{"name":"lookup","arguments":"{}"}},{"type":"function","id":"bad","id":"bad2","function":{"name":"lookup","arguments":"{}"}},{"type":"function","function":{"name":"first","name":"second","arguments":"{}"}}],"function_call":{"name":"legacy","name":"duplicate","arguments":"{}"}}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let message = parsed.node(parsed.node(parsed.root()).children[0]);
        let keyed_child = |object: &JsonNode, key: &str| {
            object
                .children
                .iter()
                .copied()
                .find(|id| object_key(parsed.node(*id)) == Some(key))
                .expect("test object has requested child")
        };
        let content = parsed.node(keyed_child(message, "content"));
        let (category, refs, ambiguous) = openai_content_block(
            &parsed,
            content.children[0].index(),
            parsed.node(content.children[0]),
            NormalizedRole::Assistant,
        );
        assert_eq!(category, GenericConversationCategory::Text);
        assert!(!ambiguous);
        assert!(refs.unwrap().text.is_some());
        let (category, refs, ambiguous) = openai_content_block(
            &parsed,
            content.children[1].index(),
            parsed.node(content.children[1]),
            NormalizedRole::Assistant,
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let image_with_duplicate_url = parsed.node(content.children[2]);
        let (category, refs, ambiguous) = openai_content_block(
            &parsed,
            content.children[2].index(),
            image_with_duplicate_url,
            NormalizedRole::Assistant,
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let (category, refs, ambiguous) = openai_content_block(
            &parsed,
            content.children[3].index(),
            parsed.node(content.children[3]),
            NormalizedRole::Assistant,
        );
        assert_eq!(category, GenericConversationCategory::Image);
        assert!(!ambiguous);
        assert!(refs.unwrap().image.is_some());

        let tool_calls = parsed.node(keyed_child(message, "tool_calls"));
        let (category, refs, ambiguous) = openai_tool_call(
            &parsed,
            tool_calls.children[0].index(),
            parsed.node(tool_calls.children[0]),
        );
        assert_eq!(category, GenericConversationCategory::ToolCall);
        assert!(!ambiguous);
        assert!(refs.unwrap().name.is_some());
        let (category, refs, ambiguous) = openai_tool_call(
            &parsed,
            tool_calls.children[1].index(),
            parsed.node(tool_calls.children[1]),
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let (category, refs, ambiguous) = openai_tool_call(
            &parsed,
            tool_calls.children[2].index(),
            parsed.node(tool_calls.children[2]),
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let function_call_id = keyed_child(message, "function_call");
        let function_call = parsed.node(function_call_id);
        let (category, refs, ambiguous) =
            openai_legacy_function_call(&parsed, function_call_id.index(), function_call);
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());

        let candidate = detect_candidate(&parsed, root, root).unwrap();
        assert_eq!(candidate.kind, ConversationKind::OpenAi);
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = conversation_page(&parsed, root, root, cursor, 1, ConversationStyle::OpenAi)
                .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert!(blocks.iter().any(|block| {
            block.category == GenericConversationCategory::Text
                && block.openai_refs.is_some()
                && !block.ambiguous_duplicate_field
        }));
        assert!(blocks.iter().any(|block| {
            block.category == GenericConversationCategory::Image
                && block.openai_refs.is_some()
                && !block.ambiguous_duplicate_field
        }));
        assert!(
            blocks
                .iter()
                .filter(|block| block.ambiguous_duplicate_field)
                .count()
                >= 4
        );
    }

    #[test]
    fn openai_tool_call_checks_nested_dependencies_only_for_function_type() {
        let parsed = parse_json(
            br#"[{"type":"custom","function":{"name":"first","name":"second","arguments":"{}"}},{"type":"function","function":{"name":"lookup","arguments":"{}"}},{"function":{"name":"first","name":"second","arguments":"{}"}}]"#,
        )
        .unwrap();
        let result = |index: usize| {
            openai_tool_call(
                &parsed,
                parsed.node(parsed.root()).children[index].index(),
                parsed.node(parsed.node(parsed.root()).children[index]),
            )
        };

        let (category, refs, ambiguous) = result(0);
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(!ambiguous);
        assert!(refs.unwrap().function.is_none());

        let (category, refs, ambiguous) = result(1);
        assert_eq!(category, GenericConversationCategory::ToolCall);
        assert!(!ambiguous);
        assert!(refs.unwrap().name.is_some());

        let (category, refs, ambiguous) = result(2);
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());

        let message_parsed = parse_json(
            br#"[{"role":"assistant","tool_calls":[{"type":"custom","function":{"name":"first","name":"second","arguments":"{}"}},{"type":"function","function":{"name":"lookup","arguments":"{}"}},{"function":{"name":"first","name":"second","arguments":"{}"}}]},{"role":"user","content":"next"}]"#,
        )
        .unwrap();
        let root = message_parsed.root().index();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = conversation_page(
                &message_parsed,
                root,
                root,
                cursor,
                1,
                ConversationStyle::OpenAi,
            )
            .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let custom = blocks
            .iter()
            .find(|block| {
                block.category == GenericConversationCategory::Unknown
                    && !block.ambiguous_duplicate_field
            })
            .unwrap();
        assert!(!custom.ambiguous_duplicate_field);
        assert!(custom.openai_refs.as_ref().unwrap().function.is_none());
        assert!(blocks.iter().any(|block| {
            block.category == GenericConversationCategory::ToolCall
                && !block.ambiguous_duplicate_field
                && block.openai_refs.as_ref().unwrap().name.is_some()
        }));
        assert!(blocks.iter().any(|block| block.ambiguous_duplicate_field));
    }

    #[test]
    fn openai_tool_result_object_checks_only_direct_ui_children() {
        let parsed = parse_json(
            br#"[{"role":"tool","content":{"part":{"type":"text","text":"first","text":"second"}}},{"role":"tool","content":{"part":{"meta":{"type":"text","text":"first","text":"second"}}}},{"role":"assistant","content":"next"}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let first_message = parsed.node(parsed.node(parsed.root()).children[0]);
        let first_content = first_message
            .children
            .iter()
            .map(|id| parsed.node(*id))
            .find(|node| object_key(node) == Some("content"))
            .unwrap();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = conversation_page(&parsed, root, root, cursor, 1, ConversationStyle::OpenAi)
                .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let ambiguous = blocks
            .iter()
            .filter(|block| block.ambiguous_duplicate_field)
            .collect::<Vec<_>>();
        assert_eq!(ambiguous.len(), 1);
        assert_eq!(ambiguous[0].category, GenericConversationCategory::Unknown);
        assert!(ambiguous[0].openai_refs.is_none());
        assert_eq!(ambiguous[0].source.unwrap().span, first_content.span);
        assert!(blocks.iter().any(|block| {
            block.category == GenericConversationCategory::ToolResult
                && !block.ambiguous_duplicate_field
        }));
    }

    #[test]
    fn ambiguous_specialized_children_do_not_supply_strong_schema_signals() {
        assert_eq!(
            kind(
                r#"[{"role":"assistant","tool_calls":[{"type":"function","function":{"name":"first","name":"second","arguments":"{}"}}]},{"role":"user","content":"next"}]"#
            ),
            ConversationKind::Generic
        );
        assert_eq!(
            kind(
                r#"[{"role":"assistant","content":[{"type":"thinking","thinking":"first","thinking":"second"}]},{"role":"user","content":"next"}]"#
            ),
            ConversationKind::Generic
        );
    }

    #[test]
    fn anthropic_child_duplicates_cover_each_type_and_ui_second_reads() {
        let parsed = parse_json(
            br#"[{"role":"assistant","content":[{"type":"text","text":"ok"},{"type":"text","text":"first","text":"second"},{"type":"thinking","thinking":"ok"},{"type":"thinking","thinking":"first","thinking":"second"},{"type":"redacted_thinking","data":"one","data":"two"},{"type":"tool_use","id":"id","name":"lookup","input":{}},{"type":"tool_use","id":"id","name":"one","name":"two","input":{}},{"type":"tool_result","tool_use_id":"id","content":"done","is_error":false},{"type":"tool_result","tool_use_id":"id","content":"done","is_error":false,"is_error":true},{"type":"tool_result","tool_use_id":"id","content":[{"type":"text","text":"first","text":"second"}]},{"type":"tool_result","tool_use_id":"id","content":[{"type":"image","text":"first","text":"second"}]}]}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let message = parsed.node(parsed.node(parsed.root()).children[0]);
        let content = parsed.node(message.children[1]);
        let result = |index: usize| {
            anthropic_content_block(
                &parsed,
                content.children[index].index(),
                parsed.node(content.children[index]),
            )
        };
        assert_eq!(result(0).0, GenericConversationCategory::Text);
        assert!(!result(0).2);
        assert!(result(0).1.unwrap().text.is_some());
        assert_eq!(result(1).0, GenericConversationCategory::Unknown);
        assert!(result(1).2);
        assert!(result(1).1.is_none());
        assert_eq!(result(2).0, GenericConversationCategory::Thinking);
        assert!(!result(2).2);
        assert!(result(2).1.unwrap().thinking.is_some());
        assert_eq!(result(3).0, GenericConversationCategory::Unknown);
        assert!(result(3).2);
        assert!(result(3).1.is_none());
        assert_eq!(result(4).0, GenericConversationCategory::Unknown);
        assert!(result(4).2);
        assert!(result(4).1.is_none());
        assert_eq!(result(5).0, GenericConversationCategory::ToolUse);
        assert!(!result(5).2);
        assert!(result(5).1.unwrap().input.is_some());
        assert_eq!(result(6).0, GenericConversationCategory::Unknown);
        assert!(result(6).2);
        assert!(result(6).1.is_none());
        assert_eq!(result(7).0, GenericConversationCategory::ToolResult);
        assert!(!result(7).2);
        assert!(result(7).1.unwrap().content.is_some());
        assert_eq!(result(8).0, GenericConversationCategory::Unknown);
        assert!(result(8).2);
        assert!(result(8).1.is_none());
        assert_eq!(result(9).0, GenericConversationCategory::Unknown);
        assert!(result(9).2);
        assert!(result(9).1.is_none());
        assert_eq!(result(10).0, GenericConversationCategory::ToolResult);
        assert!(!result(10).2);

        let system_parsed = parse_json(
            br#"{"system":[{"type":"text","text":"first","text":"second"},{"type":"text","type":"other","text":"third"},{"type":"text","text":"ok"}],"messages":[]}"#,
        )
        .unwrap();
        let system = system_parsed.node(system_parsed.node(system_parsed.root()).children[0]);
        let (category, refs, ambiguous) = anthropic_system_element(
            &system_parsed,
            system.children[0].index(),
            system_parsed.node(system.children[0]),
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let (category, refs, ambiguous) = anthropic_system_element(
            &system_parsed,
            system.children[1].index(),
            system_parsed.node(system.children[1]),
        );
        assert_eq!(category, GenericConversationCategory::Unknown);
        assert!(ambiguous);
        assert!(refs.is_none());
        let (category, refs, ambiguous) = anthropic_system_element(
            &system_parsed,
            system.children[2].index(),
            system_parsed.node(system.children[2]),
        );
        assert_eq!(category, GenericConversationCategory::Text);
        assert!(!ambiguous);
        assert!(refs.unwrap().text.is_some());
        let candidate = detect_candidate(&parsed, root, root).unwrap();
        assert_eq!(candidate.kind, ConversationKind::Anthropic);
    }

    #[test]
    fn openai_tool_result_is_error_duplicate_falls_back_to_each_whole_message() {
        let parsed = parse_json(
            br#"[{"role":"tool","content":"result","is_error":false,"is_error":true},{"role":"tool","content":[{"type":"text","text":"result"}],"is_error":false,"is_error":true},{"role":"assistant","content":"next"}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = conversation_page(&parsed, root, root, cursor, 1, ConversationStyle::OpenAi)
                .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let ambiguous = blocks
            .iter()
            .filter(|block| block.ambiguous_duplicate_field)
            .collect::<Vec<_>>();
        assert_eq!(ambiguous.len(), 2);
        for block in ambiguous {
            assert_eq!(block.kind, GenericConversationBlockKind::Source);
            assert_eq!(block.category, GenericConversationCategory::Unknown);
            assert_eq!(block.role, NormalizedRole::Unknown);
            assert!(block.role_source.is_none());
            assert!(block.openai_refs.is_none());
            assert!(block.anthropic_refs.is_none());
            assert_eq!(block.message.unwrap().span, block.source.unwrap().span);
        }
        assert!(blocks.iter().any(|block| {
            block.kind == GenericConversationBlockKind::Message
                && block.role == NormalizedRole::Assistant
                && !block.ambiguous_duplicate_field
        }));
    }

    #[test]
    fn openai_style_keeps_from_and_rejects_malformed_special_shapes() {
        let parsed = parse_json(
            br#"[{"from":"tool","content":"from-content"},{"role":"tool","content":"tool-content"},{"role":"assistant","content":[{"type":"image_url"},{"type":"image_url","image_url":"bad"},{"type":"text","text":1}],"tool_calls":[{}, {"function":{}}, {"function":{"name":"n","arguments":null}}],"function_call":{}}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page =
                conversation_page(&parsed, root, root, cursor, 100, ConversationStyle::OpenAi)
                    .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let first_message = blocks
            .iter()
            .find(|block| {
                block.message.unwrap().node_id == 1
                    && block.kind == GenericConversationBlockKind::Message
            })
            .unwrap();
        assert_eq!(first_message.role, NormalizedRole::Unknown);
        assert!(blocks.iter().any(|block| {
            block.message.unwrap().node_id == 1
                && block.category == GenericConversationCategory::Role
        }));
        let tool_message_id = blocks
            .iter()
            .find(|block| {
                block.kind == GenericConversationBlockKind::Message
                    && block.role == NormalizedRole::Tool
            })
            .unwrap()
            .message
            .unwrap()
            .node_id;
        assert!(blocks.iter().any(|block| {
            block.message.unwrap().node_id == tool_message_id
                && block.category == GenericConversationCategory::ToolResult
        }));
        assert!(blocks.iter().any(|block| {
            block.category == GenericConversationCategory::Unknown && block.openai_refs.is_some()
        }));
        assert!(!blocks
            .iter()
            .any(|block| block.category == GenericConversationCategory::ToolCall));
    }

    #[test]
    fn anthropic_style_does_not_use_from_and_keeps_malformed_content_sources() {
        let parsed = parse_json(
            br#"[{"from":"tool","content":"from-content"},{"role":"user","content":null},{"role":"assistant","content":{}}]"#,
        )
        .unwrap();
        let root = parsed.root().index();
        let page = conversation_page(&parsed, root, root, None, 100, ConversationStyle::Anthropic)
            .unwrap();
        let first_role = page
            .blocks
            .iter()
            .find(|block| {
                block.kind == GenericConversationBlockKind::Message
                    && block.role == NormalizedRole::Unknown
            })
            .unwrap();
        assert_eq!(first_role.role, NormalizedRole::Unknown);
        assert!(page.blocks.iter().any(|block| {
            block.role == NormalizedRole::Unknown
                && block.kind == GenericConversationBlockKind::Source
                && block.category == GenericConversationCategory::Role
        }));
        assert!(page.blocks.iter().any(|block| {
            block.role == NormalizedRole::Assistant
                && block.category == GenericConversationCategory::Unknown
        }));
    }
}
