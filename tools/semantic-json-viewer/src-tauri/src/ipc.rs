use std::borrow::Cow;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::conversation::{
    ConversationAnthropicRefs, ConversationCandidate, ConversationOpenAiRefs, ConversationStyle,
    GenericConversationBlock, GenericConversationBlockKind, GenericConversationCursor,
    GenericConversationPage, GenericConversationPhase,
};
use crate::document_session::DocumentSession;
use crate::file_route::{
    route_read_limit, route_with_override, FileMode, OpenDecision, OverrideError,
};
use crate::file_source::{FileIdentity, FileSource, ReadChunk};
use crate::html_sanitizer::{self, HtmlPreviewReason};
use crate::json::JsonKind;
use crate::jsonl_entry::EntryStatus;
use crate::jsonl_session::{
    EntrySelection, EntrySummary, JsonlProgress, JsonlSession, OversizedPreview,
};
use crate::search::{
    SearchError, SearchField, SearchMode, SearchPage, SearchPhase, SearchRequest, MAX_PAGE_SIZE,
    MAX_QUERY_BYTES, MAX_SCAN_BYTES,
};
use crate::semantic_detection::{
    Detection, NestedBudget, PlainReason, HARD_MAX_DEPTH, MAX_CUMULATIVE_BYTES, MAX_INPUT_BYTES,
};
use crate::tree::{NodePage, NodeProjection, StringMetrics, TextChunk, TreeDocument};

// AppState is a singleton with one session; boxing this variant adds indirection without value.
#[allow(clippy::large_enum_variant)]
enum OpenSession {
    Document(DocumentSession),
    Entry(JsonlSession),
    RawDocument {
        source: FileSource,
        document_error: IpcError,
    },
}

struct NestedScope {
    scope_id: u64,
    tree: TreeDocument,
    depth: u8,
    max_depth: u8,
    cumulative_bytes: usize,
    budget: NestedBudget,
}

#[derive(Default)]
struct NestedScopes {
    next_scope_id: u64,
    scopes: Vec<NestedScope>,
}

impl NestedScopes {
    fn new() -> Self {
        Self {
            next_scope_id: 1,
            scopes: Vec::new(),
        }
    }

    fn find(&self, scope_id: u64) -> Option<&NestedScope> {
        self.scopes.iter().find(|scope| scope.scope_id == scope_id)
    }

    fn clear(&mut self) {
        self.scopes.clear();
    }

    fn truncate_after(&mut self, scope_id: u64) -> Result<(), IpcError> {
        let position = self
            .scopes
            .iter()
            .position(|scope| scope.scope_id == scope_id)
            .ok_or_else(|| nested_scope_not_found(scope_id))?;
        self.scopes.truncate(position + 1);
        Ok(())
    }

    fn close_from(&mut self, scope_id: u64) -> Result<(), IpcError> {
        let position = self
            .scopes
            .iter()
            .position(|scope| scope.scope_id == scope_id)
            .ok_or_else(|| nested_scope_not_found(scope_id))?;
        self.scopes.truncate(position);
        Ok(())
    }
}

struct SessionState {
    revision: u64,
    session: Option<OpenSession>,
    nested: NestedScopes,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            revision: 0,
            session: None,
            nested: NestedScopes::new(),
        }
    }
}

impl OpenSession {
    fn is_current(&self) -> bool {
        match self {
            OpenSession::Document(session) => session.is_current(),
            OpenSession::Entry(session) => session.is_current(),
            OpenSession::RawDocument { source, .. } => source.is_current(),
        }
    }
}

#[derive(Default)]
pub struct AppState {
    session: Mutex<SessionState>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub size: u64,
    pub mode: String,
    pub root: Option<NodeDto>,
    pub progress: Option<JsonlProgressDto>,
    pub many_invalid_utf8_warning: bool,
    pub document_error: Option<IpcError>,
    pub session_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDto {
    pub id: usize,
    pub kind: String,
    pub span_start: usize,
    pub span_end: usize,
    pub label: String,
    pub label_has_more: bool,
    pub value_preview: Option<String>,
    pub value_has_more: bool,
    pub child_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePageDto {
    pub nodes: Vec<NodeDto>,
    pub has_more: bool,
    pub next_cursor: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NestedScopeDto {
    pub scope_id: u64,
    pub parent_scope_id: Option<u64>,
    pub source_node_id: usize,
    pub root: NodeDto,
    pub depth: u8,
    pub max_depth: u8,
    pub parsed_bytes: usize,
    pub cumulative_bytes: usize,
    pub session_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextChunkDto {
    pub start: usize,
    pub text: String,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SemanticTypeDto {
    PlainText,
    Markdown,
    NestedJson,
    Code,
    Html,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectionSourceDto {
    ContentDetected,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlainReasonDto {
    Fallback,
    JsonParseFailed,
    SizeLimit,
    DepthLimit,
    CumulativeLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StringDetectionDto {
    pub semantic_type: SemanticTypeDto,
    pub detection_source: DetectionSourceDto,
    pub plain_reason: Option<PlainReasonDto>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StringMetricsDto {
    pub decoded_bytes: usize,
    pub character_count: usize,
    pub line_count: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HtmlPreviewReasonDto {
    SizeLimit,
    RenderLimit,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlPreviewDto {
    pub html: Option<String>,
    pub reason: Option<HtmlPreviewReasonDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteChunkDto {
    pub start: u64,
    pub bytes: Vec<u8>,
    pub has_more: bool,
    pub next_offset: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchRepresentationDto {
    Decoded,
    RawSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchFieldDto {
    Key,
    Value,
    RawSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyFormatDto {
    Raw,
    Decoded,
    Path,
    Parsed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyCurrentBytesFormatDto {
    Hex,
    Lossy,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum SearchCursorDto {
    Decoded {
        #[serde(rename = "nodeId")]
        node_id: usize,
        field: SearchFieldDto,
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
        query: String,
        #[serde(rename = "sessionRevision")]
        session_revision: u64,
        #[serde(rename = "scopeId")]
        scope_id: Option<u64>,
        #[serde(rename = "targetNodeId")]
        target_node_id: Option<usize>,
    },
    RawSource {
        #[serde(rename = "byteOffset")]
        byte_offset: usize,
        query: String,
        #[serde(rename = "sessionRevision")]
        session_revision: u64,
        #[serde(rename = "scopeId")]
        scope_id: Option<u64>,
        #[serde(rename = "targetNodeId")]
        target_node_id: Option<usize>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatchDto {
    pub node_id: Option<usize>,
    pub field: SearchFieldDto,
    pub path_segments: Vec<String>,
    pub path_truncated: bool,
    pub source_span_start: usize,
    pub source_span_end: usize,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageDto {
    pub matches: Vec<SearchMatchDto>,
    pub has_more: bool,
    pub next_cursor: Option<SearchCursorDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonlProgressDto {
    pub indexed_entries: u64,
    pub indexed_source_lines: u64,
    pub complete: bool,
    pub stride: u64,
    pub total_entries: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryLocationDto {
    pub entry_ordinal: u64,
    pub source_line: u64,
    pub byte_start: u64,
    pub byte_end: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseErrorDto {
    pub message: String,
    pub byte_offset: usize,
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryDto {
    pub location: EntryLocationDto,
    pub status: String,
    pub parse_error: Option<ParseErrorDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryPageDto {
    pub entries: Vec<EntryDto>,
    pub has_more: bool,
    pub next_cursor: Option<u64>,
    pub progress: JsonlProgressDto,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySelectionDto {
    pub entry: EntryDto,
    pub root: Option<NodeDto>,
    pub session_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCandidateDto {
    pub node_id: usize,
    pub span_start: usize,
    pub span_end: usize,
    pub message_count: usize,
    pub kind: String,
    pub scope_root_id: usize,
    pub scope_root_span_start: usize,
    pub scope_root_span_end: usize,
    pub session_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenericConversationCursorKindDto {
    GenericConversation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConversationStyleDto {
    Generic,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenericConversationPhaseDto {
    Message,
    Fields,
    SystemHeader,
    SystemContent,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenericConversationCursorDto {
    pub kind: GenericConversationCursorKindDto,
    pub style: ConversationStyleDto,
    pub scope_root_id: usize,
    pub candidate_node_id: usize,
    pub message_index: usize,
    pub phase: GenericConversationPhaseDto,
    pub field_index: usize,
    pub element_index: usize,
    pub session_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericConversationBlockDto {
    pub kind: String,
    pub message_node_id: Option<usize>,
    pub message_span_start: Option<usize>,
    pub message_span_end: Option<usize>,
    pub source_node_id: Option<usize>,
    pub source_span_start: Option<usize>,
    pub source_span_end: Option<usize>,
    pub field_node_id: Option<usize>,
    pub field_span_start: Option<usize>,
    pub field_span_end: Option<usize>,
    pub category: String,
    pub role: String,
    pub role_source_node_id: Option<usize>,
    pub role_source_span_start: Option<usize>,
    pub role_source_span_end: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openai_refs: Option<ConversationOpenAiRefsDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anthropic_refs: Option<ConversationAnthropicRefsDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationOpenAiRefsDto {
    pub block: Option<ConversationSourceRefDto>,
    pub text: Option<ConversationSourceRefDto>,
    pub image: Option<ConversationSourceRefDto>,
    pub call_id: Option<ConversationSourceRefDto>,
    pub function: Option<ConversationSourceRefDto>,
    pub name: Option<ConversationSourceRefDto>,
    pub arguments: Option<ConversationSourceRefDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationAnthropicRefsDto {
    pub block: Option<ConversationSourceRefDto>,
    pub text: Option<ConversationSourceRefDto>,
    pub thinking: Option<ConversationSourceRefDto>,
    pub data: Option<ConversationSourceRefDto>,
    pub id: Option<ConversationSourceRefDto>,
    pub name: Option<ConversationSourceRefDto>,
    pub input: Option<ConversationSourceRefDto>,
    pub tool_use_id: Option<ConversationSourceRefDto>,
    pub content: Option<ConversationSourceRefDto>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSourceRefDto {
    pub node_id: usize,
    pub span_start: usize,
    pub span_end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWrapperRefDto {
    pub scope_root_id: usize,
    pub scope_root_span_start: usize,
    pub scope_root_span_end: usize,
    pub candidate_node_id: usize,
    pub candidate_span_start: usize,
    pub candidate_span_end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenericConversationPageDto {
    pub blocks: Vec<GenericConversationBlockDto>,
    pub has_more: bool,
    pub next_cursor: Option<GenericConversationCursorDto>,
    pub wrapper_ref: ConversationWrapperRefDto,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OversizedPreviewDto {
    pub entry: EntryDto,
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
}

#[tauri::command(async)]
pub fn open_file(
    path: String,
    open_as: Option<String>,
    state: State<'_, AppState>,
) -> Result<FileSummary, IpcError> {
    match open_as.as_deref() {
        None => open_file_inner(&state, &path),
        Some(value) => open_file_with_override(&state, &path, Some(value)),
    }
}

#[tauri::command]
pub fn get_file_summary(state: State<'_, AppState>) -> Result<FileSummary, IpcError> {
    get_file_summary_inner(&state)
}

#[tauri::command]
pub fn get_root_node(
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<NodeDto, IpcError> {
    get_root_node_scoped_inner(&state, scope_id, session_revision)
}

#[tauri::command]
pub fn get_node_summary(
    node_id: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<NodeDto, IpcError> {
    get_node_summary_scoped_inner(&state, node_id, scope_id, session_revision)
}

#[tauri::command]
pub fn get_children(
    node_id: usize,
    cursor: usize,
    limit: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<NodePageDto, IpcError> {
    get_children_scoped_inner(&state, node_id, cursor, limit, scope_id, session_revision)
}

#[tauri::command]
pub fn read_raw_slice(
    source_start: usize,
    length: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<TextChunkDto, IpcError> {
    read_raw_slice_scoped_inner(&state, source_start, length, scope_id, session_revision)
}

#[tauri::command(async)]
pub fn read_selected_entry_bytes(
    offset: u64,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<ByteChunkDto, IpcError> {
    read_selected_entry_bytes_inner(&state, offset, length, session_revision)
}

#[tauri::command(async)]
pub fn read_selected_entry_window(
    offset: u64,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<ByteChunkDto, IpcError> {
    read_selected_entry_window_inner(&state, offset, length, session_revision)
}

#[tauri::command(async)]
pub fn read_raw_document_bytes(
    offset: u64,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<ByteChunkDto, IpcError> {
    read_raw_document_bytes_inner(&state, offset, length, session_revision)
}

#[tauri::command]
pub fn read_decoded_text(
    node_id: usize,
    offset: usize,
    length: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<TextChunkDto, IpcError> {
    read_decoded_text_scoped_inner(&state, node_id, offset, length, scope_id, session_revision)
}

#[tauri::command(async)]
pub fn copy_node(
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
    format: CopyFormatDto,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), IpcError> {
    copy_node_to_sink(
        &state,
        node_id,
        scope_id,
        session_revision,
        format,
        |text| {
            app.clipboard()
                .write_text(text)
                .map_err(|error| error.to_string())
        },
    )
}

#[tauri::command(async)]
pub fn copy_current_bytes(
    format: CopyCurrentBytesFormatDto,
    session_revision: u64,
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), IpcError> {
    copy_current_bytes_to_sink(&state, session_revision, format, |text| {
        app.clipboard()
            .write_text(text)
            .map_err(|error| error.to_string())
    })
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn search_current(
    query: String,
    representation: SearchRepresentationDto,
    scope_id: Option<u64>,
    node_id: Option<usize>,
    cursor: Option<SearchCursorDto>,
    limit: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<SearchPageDto, IpcError> {
    search_current_inner(
        &state,
        query,
        representation,
        scope_id,
        node_id,
        cursor,
        limit,
        session_revision,
    )
}

#[tauri::command]
pub fn get_string_detection(
    node_id: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<StringDetectionDto, IpcError> {
    get_string_detection_scoped_inner(&state, node_id, scope_id, session_revision)
}

#[tauri::command]
pub fn get_string_metrics(
    node_id: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<StringMetricsDto, IpcError> {
    get_string_metrics_scoped_inner(&state, node_id, scope_id, session_revision)
}

#[tauri::command]
pub fn get_conversation_candidate(
    scope_root_id: usize,
    candidate_node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<ConversationCandidateDto, IpcError> {
    get_conversation_candidate_inner(
        &state,
        scope_root_id,
        candidate_node_id,
        scope_id,
        session_revision,
    )
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn get_generic_conversation_blocks(
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursorDto>,
    limit: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<GenericConversationPageDto, IpcError> {
    get_conversation_blocks_inner(
        &state,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        session_revision,
        scope_id,
        ConversationStyle::Generic,
    )
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn get_conversation_blocks(
    scope_root_id: usize,
    candidate_node_id: usize,
    style: ConversationStyleDto,
    cursor: Option<GenericConversationCursorDto>,
    limit: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    state: State<'_, AppState>,
) -> Result<GenericConversationPageDto, IpcError> {
    get_conversation_blocks_inner(
        &state,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        session_revision,
        scope_id,
        conversation_style_from_dto(style),
    )
}

#[tauri::command]
pub fn get_html_preview(
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<HtmlPreviewDto, IpcError> {
    get_html_preview_inner(&state, node_id, scope_id, session_revision)
}

#[tauri::command]
pub fn open_nested_json(
    parent_scope_id: Option<u64>,
    node_id: usize,
    max_depth: Option<u8>,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<NestedScopeDto, IpcError> {
    open_nested_json_inner(
        &state,
        parent_scope_id,
        node_id,
        max_depth,
        session_revision,
    )
}

#[tauri::command]
pub fn close_nested_scope(
    scope_id: u64,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    close_nested_scope_inner(&state, scope_id, session_revision)
}

#[tauri::command(async)]
pub fn scan_entries(
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<JsonlProgressDto, IpcError> {
    scan_entries_inner(&state, session_revision)
}

#[tauri::command(async)]
pub fn list_entries(
    start: u64,
    limit: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<EntryPageDto, IpcError> {
    list_entries_inner(&state, start, limit, session_revision)
}

#[tauri::command(async)]
pub fn select_entry(
    ordinal: u64,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<EntrySelectionDto, IpcError> {
    select_entry_inner(&state, ordinal, session_revision)
}

#[tauri::command(async)]
pub fn get_oversized_preview(
    ordinal: u64,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<OversizedPreviewDto, IpcError> {
    get_oversized_preview_inner(&state, ordinal, session_revision)
}

fn open_file_inner(state: &AppState, path: &str) -> Result<FileSummary, IpcError> {
    open_file_with_override(state, path, None)
}

fn open_file_with_override(
    state: &AppState,
    path: &str,
    open_as: Option<&str>,
) -> Result<FileSummary, IpcError> {
    if path.trim().is_empty() {
        return Err(invalid_request("path must not be empty"));
    }

    let path = Path::new(path);
    let requested_mode = parse_open_as(open_as)?;
    let route_source = FileSource::open(path).map_err(open_error)?;

    let read_limit = route_read_limit(path, route_source.identity().size, requested_mode);
    let route_bytes = read_route_bytes(&route_source, read_limit).map_err(open_read_error)?;
    let decision = route_with_override(
        path,
        route_source.identity().size,
        &route_bytes,
        requested_mode,
    )
    .map_err(override_error)?;
    let allow_raw_document = requested_mode != Some(FileMode::Entry);
    let (mode, many_invalid_utf8_warning, document_error) =
        decision_mode(decision, allow_raw_document)?;
    // ponytail: route and session currently reread the selected file; reuse route bytes only if v0.1 benchmarks miss the target.
    drop(route_bytes);

    let route_identity = route_source.identity().clone();
    let session = if let Some(document_error) = document_error {
        OpenSession::RawDocument {
            source: route_source,
            document_error,
        }
    } else {
        match mode {
            FileMode::Entry => {
                let mut session = JsonlSession::open(path).map_err(open_error)?;
                session.set_many_invalid_utf8_warning(many_invalid_utf8_warning);
                OpenSession::Entry(session)
            }
            FileMode::Document | FileMode::Collection => {
                OpenSession::Document(DocumentSession::open(path).map_err(open_error)?)
            }
        }
    };
    if &route_identity != session_identity(&session) {
        return Err(file_changed());
    }
    let mut guard = lock_session(state)?;
    let next_revision = guard
        .revision
        .checked_add(1)
        .ok_or_else(|| internal("session revision overflow"))?;
    let summary = file_summary(&session, next_revision)?;
    *guard = SessionState {
        revision: next_revision,
        session: Some(session),
        nested: NestedScopes::new(),
    };
    Ok(summary)
}

fn parse_open_as(open_as: Option<&str>) -> Result<Option<FileMode>, IpcError> {
    match open_as {
        None => Ok(None),
        Some(value) if value.eq_ignore_ascii_case("json") => Ok(Some(FileMode::Document)),
        Some(value) if value.eq_ignore_ascii_case("jsonl") => Ok(Some(FileMode::Entry)),
        Some(_) => Err(invalid_request("openAs must be json or jsonl")),
    }
}

fn read_route_bytes(source: &FileSource, limit: u64) -> io::Result<Vec<u8>> {
    let target = source.identity().size.min(limit);
    let capacity = usize::try_from(target).map_err(|_| {
        io::Error::new(
            ErrorKind::InvalidData,
            "route sample exceeds addressable memory",
        )
    })?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|error| io::Error::new(ErrorKind::OutOfMemory, error))?;
    let mut offset = 0;
    while offset < target {
        let remaining = target - offset;
        let requested = usize::try_from(remaining).map_err(|_| {
            io::Error::new(
                ErrorKind::InvalidData,
                "route sample exceeds addressable memory",
            )
        })?;
        let chunk = source.read_chunk(offset, requested)?;
        if chunk.bytes.is_empty() {
            if chunk.has_more {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "file ended before the route sample",
                ));
            }
            break;
        }
        let read = u64::try_from(chunk.bytes.len()).expect("chunk length exceeds u64");
        if read > remaining {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "route sample exceeded its requested range",
            ));
        }
        bytes.extend_from_slice(&chunk.bytes);
        offset = offset
            .checked_add(read)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
    }
    if !source.is_current() {
        return Err(ErrorKind::InvalidData.into());
    }
    Ok(bytes)
}

fn decision_mode(
    decision: OpenDecision,
    allow_raw_document: bool,
) -> Result<(FileMode, bool, Option<IpcError>), IpcError> {
    match decision {
        OpenDecision::Open {
            mode,
            many_invalid_utf8_warning,
            ..
        } => Ok((mode, many_invalid_utf8_warning, None)),
        OpenDecision::InvalidJson(error) if allow_raw_document => {
            Ok((FileMode::Document, false, Some(invalid_json(error))))
        }
        OpenDecision::InvalidJson(error) => Err(invalid_json(error)),
        OpenDecision::InvalidUtf8Document if allow_raw_document => {
            Ok((FileMode::Document, false, Some(unsupported_encoding())))
        }
        OpenDecision::InvalidUtf8Document => Err(unsupported_encoding()),
        OpenDecision::UnsupportedEncoding => Err(unsupported_encoding()),
        OpenDecision::UnsupportedFraming => Err(unsupported_framing()),
        OpenDecision::UnsupportedFormat => Err(unsupported_format()),
        OpenDecision::NeedsModeChoice => Err(mode_choice_required()),
    }
}

fn override_error(error: OverrideError) -> IpcError {
    match error {
        OverrideError::Conflict => invalid_request("openAs conflicts with the file extension"),
        OverrideError::NotAllowed => {
            invalid_request("openAs is only valid after mode choice is required")
        }
    }
}

fn open_read_error(error: io::Error) -> IpcError {
    if error.kind() == ErrorKind::InvalidData {
        file_changed()
    } else {
        open_error(error)
    }
}

fn session_identity(session: &OpenSession) -> &FileIdentity {
    match session {
        OpenSession::Document(session) => session.identity(),
        OpenSession::Entry(session) => session.identity(),
        OpenSession::RawDocument { source, .. } => source.identity(),
    }
}

fn file_summary(session: &OpenSession, session_revision: u64) -> Result<FileSummary, IpcError> {
    match session {
        OpenSession::Document(session) => {
            let root = session.root().map_err(session_error)?;
            let mode = if root.kind == JsonKind::Array {
                "collection"
            } else {
                "document"
            };
            Ok(FileSummary {
                path: session.identity().canonical_path.display().to_string(),
                size: session.identity().size,
                mode: mode.to_owned(),
                root: Some(node_dto(root)),
                progress: None,
                many_invalid_utf8_warning: false,
                document_error: None,
                session_revision,
            })
        }
        OpenSession::Entry(session) => Ok(FileSummary {
            path: session.identity().canonical_path.display().to_string(),
            size: session.identity().size,
            mode: "entry".to_owned(),
            root: None,
            progress: Some(progress_dto(session.progress().map_err(session_error)?)),
            many_invalid_utf8_warning: session.many_invalid_utf8_warning(),
            document_error: None,
            session_revision,
        }),
        OpenSession::RawDocument {
            source,
            document_error,
        } => {
            if !source.is_current() {
                return Err(file_changed());
            }
            Ok(FileSummary {
                path: source.identity().canonical_path.display().to_string(),
                size: source.identity().size,
                mode: "document".to_owned(),
                root: None,
                progress: None,
                many_invalid_utf8_warning: false,
                document_error: Some(document_error.clone()),
                session_revision,
            })
        }
    }
}

fn get_file_summary_inner(state: &AppState) -> Result<FileSummary, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.session.as_ref().ok_or_else(no_session)?;
    file_summary(session, guard.revision)
}

fn get_conversation_candidate_inner(
    state: &AppState,
    scope_root_id: usize,
    candidate_node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<ConversationCandidateDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        if scope.is_some() {
            return Err(invalid_request(
                "conversation detection is unavailable for a nested JSON scope",
            ));
        }
        let scope_root = match session {
            OpenSession::Document(session) => session.node(scope_root_id).map_err(session_error)?,
            OpenSession::Entry(session) => {
                require_selected(session)?;
                session
                    .selected_node(scope_root_id)
                    .map_err(session_error)?
            }
            OpenSession::RawDocument { .. } => {
                return Err(invalid_request(
                    "command is unavailable for a raw-only document session",
                ));
            }
        }
        .ok_or_else(|| not_found(format!("scope root node {scope_root_id} was not found")))?;
        let candidate = match session {
            OpenSession::Document(session) => session
                .conversation_candidate(scope_root_id, candidate_node_id)
                .map_err(session_error)?,
            OpenSession::Entry(session) => session
                .selected_conversation_candidate(scope_root_id, candidate_node_id)
                .map_err(session_error)?,
            OpenSession::RawDocument { .. } => {
                return Err(invalid_request(
                    "command is unavailable for a raw-only document session",
                ));
            }
        }
        .ok_or_else(|| invalid_request("candidate is not a supported conversation array"))?;
        if !session.is_current() {
            return Err(file_changed());
        }

        Ok(conversation_candidate_dto(
            candidate,
            scope_root_id,
            scope_root.span,
            session_revision,
        ))
    })
}

#[allow(clippy::too_many_arguments)]
fn get_conversation_blocks_inner(
    state: &AppState,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursorDto>,
    limit: usize,
    session_revision: u64,
    scope_id: Option<u64>,
    style: ConversationStyle,
) -> Result<GenericConversationPageDto, IpcError> {
    if limit == 0 {
        return Err(invalid_request("limit must be greater than zero"));
    }
    let cursor = generic_conversation_cursor_from_dto(
        cursor,
        scope_root_id,
        candidate_node_id,
        session_revision,
        style,
    )?;

    with_session_scope(state, scope_id, session_revision, |session, scope| {
        if scope.is_some() {
            return Err(invalid_request(
                "conversation blocks are unavailable for a nested JSON scope",
            ));
        }
        let page = match session {
            OpenSession::Document(session) => session
                .conversation_page(scope_root_id, candidate_node_id, cursor, limit, style)
                .map_err(session_error)?,
            OpenSession::Entry(session) => session
                .selected_conversation_page(scope_root_id, candidate_node_id, cursor, limit, style)
                .map_err(session_error)?,
            OpenSession::RawDocument { .. } => {
                return Err(invalid_request(
                    "command is unavailable for a raw-only document session",
                ));
            }
        }
        .ok_or_else(|| invalid_request("candidate is not a supported conversation array"))?;
        if !session.is_current() {
            return Err(file_changed());
        }
        generic_conversation_page_dto(
            page,
            scope_root_id,
            candidate_node_id,
            session_revision,
            style,
        )
    })
}

#[cfg(test)]
fn get_generic_conversation_blocks_inner(
    state: &AppState,
    scope_root_id: usize,
    candidate_node_id: usize,
    cursor: Option<GenericConversationCursorDto>,
    limit: usize,
    session_revision: u64,
    scope_id: Option<u64>,
) -> Result<GenericConversationPageDto, IpcError> {
    get_conversation_blocks_inner(
        state,
        scope_root_id,
        candidate_node_id,
        cursor,
        limit,
        session_revision,
        scope_id,
        ConversationStyle::Generic,
    )
}

#[cfg(test)]
fn get_root_node_inner(state: &AppState, session_revision: u64) -> Result<NodeDto, IpcError> {
    get_root_node_scoped_inner(state, None, session_revision)
}

fn get_root_node_scoped_inner(
    state: &AppState,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<NodeDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        if let Some(scope) = scope {
            return Ok(node_dto(scope.tree.root()));
        }
        match session {
            OpenSession::Document(session) => session.root().map(node_dto).map_err(session_error),
            OpenSession::Entry(session) => session
                .selected_root()
                .map_err(session_error)?
                .map(node_dto)
                .ok_or_else(|| invalid_request("no valid entry is selected")),
            OpenSession::RawDocument { .. } => Err(invalid_request(
                "command is unavailable for a raw-only document session",
            )),
        }
    })
}

#[cfg(test)]
fn get_node_summary_inner(
    state: &AppState,
    node_id: usize,
    session_revision: u64,
) -> Result<NodeDto, IpcError> {
    get_node_summary_scoped_inner(state, node_id, None, session_revision)
}

fn get_node_summary_scoped_inner(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<NodeDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let node = if let Some(scope) = scope {
            scope.tree.node(node_id)
        } else {
            match session {
                OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    session.selected_node(node_id).map_err(session_error)?
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        };
        node.map(node_dto)
            .ok_or_else(|| not_found(format!("node {node_id} was not found")))
    })
}

#[cfg(test)]
fn get_children_inner(
    state: &AppState,
    node_id: usize,
    cursor: usize,
    limit: usize,
    session_revision: u64,
) -> Result<NodePageDto, IpcError> {
    get_children_scoped_inner(state, node_id, cursor, limit, None, session_revision)
}

fn get_children_scoped_inner(
    state: &AppState,
    node_id: usize,
    cursor: usize,
    limit: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<NodePageDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let parent = if let Some(scope) = scope {
            scope.tree.node(node_id)
        } else {
            match session {
                OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    session.selected_node(node_id).map_err(session_error)?
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        }
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if limit == 0 || cursor > parent.child_count {
            return Err(invalid_request("invalid cursor or limit"));
        }
        let page = if let Some(scope) = scope {
            scope.tree.children(node_id, cursor, limit)
        } else {
            match session {
                OpenSession::Document(session) => session.children(node_id, cursor, limit),
                OpenSession::Entry(session) => session.selected_children(node_id, cursor, limit),
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
            .map_err(session_error)?
        };
        page.map(node_page_dto)
            .ok_or_else(|| invalid_request("invalid cursor or limit"))
    })
}

#[cfg(test)]
fn read_raw_slice_inner(
    state: &AppState,
    source_start: usize,
    length: usize,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    read_raw_slice_scoped_inner(state, source_start, length, None, session_revision)
}

fn read_raw_slice_scoped_inner(
    state: &AppState,
    source_start: usize,
    length: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let chunk = if let Some(scope) = scope {
            scope.tree.read_raw_text(source_start, length)
        } else {
            match session {
                OpenSession::Document(session) => session.read_raw_text(source_start, length),
                OpenSession::Entry(session) => session.read_raw_text(source_start, length),
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
            .map_err(session_error)?
        };
        chunk
            .map(text_chunk_dto)
            .ok_or_else(|| invalid_request("raw slice is unavailable"))
    })
}

fn read_selected_entry_bytes_inner(
    state: &AppState,
    offset: u64,
    length: usize,
    session_revision: u64,
) -> Result<ByteChunkDto, IpcError> {
    with_entry_session(state, session_revision, |session| {
        if length == 0 {
            return Err(invalid_request("length must be greater than zero"));
        }
        let Some(chunk) = session
            .read_selected_entry_bytes(offset, length)
            .map_err(|error| {
                if error.kind() == ErrorKind::InvalidInput {
                    invalid_request(error.to_string())
                } else {
                    session_error(error)
                }
            })?
        else {
            return Err(invalid_request("no entry is selected"));
        };
        Ok(ByteChunkDto {
            start: chunk.start,
            bytes: chunk.bytes,
            has_more: chunk.has_more,
            next_offset: chunk.next_offset,
        })
    })
}

fn read_selected_entry_window_inner(
    state: &AppState,
    offset: u64,
    length: usize,
    session_revision: u64,
) -> Result<ByteChunkDto, IpcError> {
    with_entry_session(state, session_revision, |session| {
        let Some(chunk) = session
            .read_selected_raw_window(offset, length.min(128 * 1024))
            .map_err(|error| {
                if error.kind() == ErrorKind::InvalidInput {
                    invalid_request(error.to_string())
                } else {
                    session_error(error)
                }
            })?
        else {
            return Err(invalid_request("no entry is selected"));
        };
        Ok(ByteChunkDto {
            start: chunk.start,
            bytes: chunk.bytes,
            has_more: chunk.has_more,
            next_offset: chunk.next_offset,
        })
    })
}

fn read_raw_document_bytes_inner(
    state: &AppState,
    offset: u64,
    length: usize,
    session_revision: u64,
) -> Result<ByteChunkDto, IpcError> {
    with_session(state, session_revision, |session| {
        let OpenSession::RawDocument { source, .. } = session else {
            return Err(invalid_request(
                "command requires a raw-only document session",
            ));
        };
        if length == 0 {
            return Err(invalid_request("length must be greater than zero"));
        }
        let file_size = source.identity().size;
        if offset > file_size {
            return Err(invalid_request("offset exceeds raw document length"));
        }
        if offset == file_size {
            if !source.is_current() {
                return Err(file_changed());
            }
            return Ok(ByteChunkDto {
                start: offset,
                bytes: Vec::new(),
                has_more: false,
                next_offset: None,
            });
        }

        let requested = u64::try_from(length)
            .map_err(|_| invalid_request("length exceeds addressable range"))?
            .min(128 * 1024)
            .min(file_size - offset);
        let requested = usize::try_from(requested)
            .map_err(|_| internal("raw document range exceeds addressable memory"))?;
        let chunk = source
            .read_chunk(offset, requested)
            .map_err(session_error)?;
        if !source.is_current() {
            return Err(file_changed());
        }
        if chunk.start != offset || chunk.bytes.is_empty() {
            return Err(internal("file ended before the raw document range"));
        }
        let read = u64::try_from(chunk.bytes.len()).expect("chunk length exceeds u64");
        let end = offset
            .checked_add(read)
            .ok_or_else(|| internal("raw document range overflow"))?;
        if read > requested as u64 || end > file_size {
            return Err(internal("raw document range exceeded its requested bounds"));
        }
        let has_more = end < file_size;
        Ok(ByteChunkDto {
            start: offset,
            bytes: chunk.bytes,
            has_more,
            next_offset: has_more.then_some(end),
        })
    })
}

#[cfg(test)]
fn read_decoded_text_inner(
    state: &AppState,
    node_id: usize,
    offset: usize,
    length: usize,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    read_decoded_text_scoped_inner(state, node_id, offset, length, None, session_revision)
}

fn read_decoded_text_scoped_inner(
    state: &AppState,
    node_id: usize,
    offset: usize,
    length: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let node = if let Some(scope) = scope {
            scope.tree.node(node_id)
        } else {
            match session {
                OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    session.selected_node(node_id).map_err(session_error)?
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        }
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if node.kind != JsonKind::String {
            return Err(invalid_request("node does not contain decoded text"));
        }
        let chunk = if let Some(scope) = scope {
            scope.tree.read_decoded_text(node_id, offset, length)
        } else {
            match session {
                OpenSession::Document(session) => {
                    session.read_decoded_text(node_id, offset, length)
                }
                OpenSession::Entry(session) => session.read_decoded_text(node_id, offset, length),
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
            .map_err(session_error)?
        };
        chunk
            .map(text_chunk_dto)
            .ok_or_else(|| invalid_request("decoded text is unavailable"))
    })
}

fn copy_node_to_sink(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
    format: CopyFormatDto,
    sink: impl FnOnce(String) -> Result<(), String>,
) -> Result<(), IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let text = copy_node_text_for_session(session, scope, node_id, format)?;
        if !session.is_current() {
            return Err(file_changed());
        }
        sink(text).map_err(clipboard_error)
    })
}

fn copy_current_bytes_to_sink(
    state: &AppState,
    session_revision: u64,
    format: CopyCurrentBytesFormatDto,
    sink: impl FnOnce(String) -> Result<(), String>,
) -> Result<(), IpcError> {
    with_session_scope(state, None, session_revision, |session, _| {
        let bytes = read_current_bytes(session)?;
        let text = match format {
            CopyCurrentBytesFormatDto::Hex => format_copy_hex(&bytes)?,
            CopyCurrentBytesFormatDto::Lossy => format_copy_lossy(&bytes)?,
        };
        if !session.is_current() {
            return Err(file_changed());
        }
        sink(text).map_err(clipboard_error)
    })
}

fn read_current_bytes(session: &OpenSession) -> Result<Vec<u8>, IpcError> {
    match session {
        OpenSession::Entry(session) => {
            let Some((start, end)) = session.selected_raw_range().map_err(copy_read_error)? else {
                return Err(invalid_request("no Entry is selected"));
            };
            let length = end
                .checked_sub(start)
                .ok_or_else(|| internal("selected Entry range overflow"))?;
            read_all_copy_bytes(length, |offset, length| {
                session
                    .read_selected_raw_window(offset, length)
                    .map_err(copy_read_error)?
                    .ok_or_else(|| invalid_request("no Entry is selected"))
            })
        }
        OpenSession::RawDocument { source, .. } => {
            let length = source.identity().size;
            read_all_copy_bytes(length, |offset, requested| {
                source
                    .read_chunk(offset, requested)
                    .map_err(copy_read_error)
            })
        }
        OpenSession::Document(_) => Err(invalid_request(
            "copy current bytes is unavailable for a parsed document",
        )),
    }
}

fn read_all_copy_bytes(
    length: u64,
    mut read: impl FnMut(u64, usize) -> Result<ReadChunk, IpcError>,
) -> Result<Vec<u8>, IpcError> {
    let capacity = usize::try_from(length)
        .map_err(|_| invalid_request("copy source exceeds addressable memory"))?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|_| internal("copy buffer allocation failed"))?;

    let mut offset = 0u64;
    while offset < length {
        let chunk = read(offset, usize::MAX)?;
        if chunk.start != offset || chunk.bytes.is_empty() {
            return Err(internal("copy source ended before its recorded range"));
        }
        let read_len = u64::try_from(chunk.bytes.len())
            .map_err(|_| internal("copy chunk length exceeds addressable range"))?;
        let next = offset
            .checked_add(read_len)
            .ok_or_else(|| internal("copy source range overflow"))?;
        if next > length {
            return Err(internal("copy chunk exceeded its recorded range"));
        }
        let has_more = next < length;
        if chunk.has_more != has_more || chunk.next_offset != has_more.then_some(next) {
            return Err(internal("copy source returned an inconsistent range"));
        }
        bytes.extend_from_slice(&chunk.bytes);
        offset = next;
    }
    Ok(bytes)
}

fn format_copy_hex(bytes: &[u8]) -> Result<String, IpcError> {
    use std::fmt::Write;

    let (_rows, _offset_width, capacity) = hex_copy_layout(bytes.len())?;
    let mut output = String::new();
    output
        .try_reserve(capacity)
        .map_err(|_| internal("hex copy buffer allocation failed"))?;

    for (row_index, row) in bytes.chunks(16).enumerate() {
        if row_index > 0 {
            output.push('\n');
        }
        let offset = row_index
            .checked_mul(16)
            .ok_or_else(|| invalid_request("hex copy offset overflow"))?;
        write!(&mut output, "{offset:08x}  ").expect("writing to String cannot fail");

        let mut hex = String::with_capacity(16 * 3 - 1);
        for (index, byte) in row.iter().enumerate() {
            if index > 0 {
                hex.push(' ');
            }
            write!(&mut hex, "{byte:02x}").expect("writing to String cannot fail");
        }
        while hex.len() < 16 * 3 - 1 {
            hex.push(' ');
        }
        output.push_str(&hex);
        output.push_str("  |");
        for byte in row {
            output.push(if (0x20..=0x7e).contains(byte) {
                char::from(*byte)
            } else {
                '.'
            });
        }
        for _ in row.len()..16 {
            output.push(' ');
        }
        output.push('|');
    }
    Ok(output)
}

fn hex_copy_layout(byte_len: usize) -> Result<(usize, usize, usize), IpcError> {
    let rows = byte_len.saturating_add(15) / 16;
    if rows == 0 {
        return Ok((0, 8, 0));
    }
    let last_offset = (rows - 1)
        .checked_mul(16)
        .ok_or_else(|| invalid_request("hex copy offset overflow"))?;
    let offset_width = hex_digits(last_offset).max(8);
    let line_width = offset_width
        .checked_add(69)
        .ok_or_else(|| invalid_request("hex copy line width overflow"))?;
    let capacity = rows
        .checked_mul(line_width)
        .and_then(|value| value.checked_add(rows - 1))
        .ok_or_else(|| invalid_request("hex copy exceeds addressable memory"))?;
    Ok((rows, offset_width, capacity))
}

fn hex_digits(value: usize) -> usize {
    if value == 0 {
        1
    } else {
        (usize::BITS - value.leading_zeros()).div_ceil(4) as usize
    }
}

fn format_copy_lossy(bytes: &[u8]) -> Result<String, IpcError> {
    let mut output = String::new();
    let mut remaining = bytes;
    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                output
                    .try_reserve(text.len())
                    .map_err(|_| internal("lossy copy buffer allocation failed"))?;
                output.push_str(text);
                break;
            }
            Err(error) => {
                let valid_len = error.valid_up_to();
                if valid_len > 0 {
                    output
                        .try_reserve(valid_len)
                        .map_err(|_| internal("lossy copy buffer allocation failed"))?;
                    output.push_str(
                        std::str::from_utf8(&remaining[..valid_len])
                            .expect("valid UTF-8 prefix was reported by from_utf8"),
                    );
                }
                output
                    .try_reserve('\u{fffd}'.len_utf8())
                    .map_err(|_| internal("lossy copy buffer allocation failed"))?;
                output.push('\u{fffd}');
                let invalid_len = error
                    .error_len()
                    .unwrap_or(remaining.len().saturating_sub(valid_len));
                if invalid_len == 0 {
                    return Err(internal("UTF-8 decoder did not advance"));
                }
                remaining = &remaining[valid_len + invalid_len..];
            }
        }
    }
    Ok(output)
}

fn copy_node_text_for_session(
    session: &OpenSession,
    scope: Option<&NestedScope>,
    node_id: usize,
    format: CopyFormatDto,
) -> Result<String, IpcError> {
    if let Some(scope) = scope {
        return copy_tree_node(&scope.tree, node_id, format);
    }

    match session {
        OpenSession::Document(session) => copy_document_node(session, node_id, format),
        OpenSession::Entry(session) => copy_entry_node(session, node_id, format),
        OpenSession::RawDocument { .. } => Err(invalid_request(
            "copy is unavailable for a raw-only document session",
        )),
    }
}

fn copy_document_node(
    session: &DocumentSession,
    node_id: usize,
    format: CopyFormatDto,
) -> Result<String, IpcError> {
    let node = session
        .node(node_id)
        .map_err(session_error)?
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
    if format == CopyFormatDto::Parsed {
        return Err(invalid_request(
            "parsed copy requires an open nested JSON scope",
        ));
    }
    match format {
        CopyFormatDto::Raw => session
            .raw_text(node_id)
            .map_err(session_error)?
            .map(str::to_owned)
            .ok_or_else(|| internal("node source span is unavailable")),
        CopyFormatDto::Decoded => copy_decoded_scalar(
            node.kind,
            || {
                session
                    .raw_text(node_id)
                    .map(|text| text.map(str::to_owned))
                    .map_err(session_error)
            },
            || {
                session
                    .decoded_text(node_id)
                    .map(|text| text.map(|value| value.into_owned()))
                    .map_err(session_error)
            },
        ),
        CopyFormatDto::Path => session
            .path(node_id)
            .map_err(session_error)?
            .ok_or_else(|| internal("node path is unavailable")),
        CopyFormatDto::Parsed => unreachable!("parsed was rejected above"),
    }
}

fn copy_entry_node(
    session: &JsonlSession,
    node_id: usize,
    format: CopyFormatDto,
) -> Result<String, IpcError> {
    require_selected(session)?;
    let node = session
        .selected_node(node_id)
        .map_err(session_error)?
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
    if format == CopyFormatDto::Parsed {
        return Err(invalid_request(
            "parsed copy requires an open nested JSON scope",
        ));
    }
    match format {
        CopyFormatDto::Raw => session
            .selected_raw_text(node_id)
            .map_err(session_error)?
            .map(str::to_owned)
            .ok_or_else(|| internal("node source span is unavailable")),
        CopyFormatDto::Decoded => copy_decoded_scalar(
            node.kind,
            || {
                session
                    .selected_raw_text(node_id)
                    .map(|text| text.map(str::to_owned))
                    .map_err(session_error)
            },
            || {
                session
                    .selected_decoded_text(node_id)
                    .map(|text| text.map(|value| value.into_owned()))
                    .map_err(session_error)
            },
        ),
        CopyFormatDto::Path => session
            .selected_path(node_id)
            .map_err(session_error)?
            .ok_or_else(|| internal("node path is unavailable")),
        CopyFormatDto::Parsed => unreachable!("parsed was rejected above"),
    }
}

fn copy_tree_node(
    tree: &TreeDocument,
    node_id: usize,
    format: CopyFormatDto,
) -> Result<String, IpcError> {
    let node = tree
        .node(node_id)
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
    if format == CopyFormatDto::Parsed {
        if node_id != tree.root().id {
            return Err(invalid_request(
                "parsed copy requires the nested JSON scope root",
            ));
        }
        return tree
            .raw_text(node_id)
            .map(str::to_owned)
            .ok_or_else(|| internal("nested JSON source is unavailable"));
    }
    match format {
        CopyFormatDto::Raw => tree
            .raw_text(node_id)
            .map(str::to_owned)
            .ok_or_else(|| internal("node source span is unavailable")),
        CopyFormatDto::Decoded => copy_decoded_scalar(
            node.kind,
            || Ok(tree.raw_text(node_id).map(str::to_owned)),
            || Ok(tree.decoded_text(node_id).map(|value| value.into_owned())),
        ),
        CopyFormatDto::Path => tree
            .path(node_id)
            .ok_or_else(|| internal("node path is unavailable")),
        CopyFormatDto::Parsed => unreachable!("parsed was handled above"),
    }
}

fn copy_decoded_scalar(
    kind: JsonKind,
    raw: impl FnOnce() -> Result<Option<String>, IpcError>,
    decoded: impl FnOnce() -> Result<Option<String>, IpcError>,
) -> Result<String, IpcError> {
    match kind {
        JsonKind::String => {
            decoded()?.ok_or_else(|| invalid_request("string decoded value is unavailable"))
        }
        JsonKind::Number | JsonKind::True | JsonKind::False | JsonKind::Null => {
            raw()?.ok_or_else(|| invalid_request("scalar source is unavailable"))
        }
        JsonKind::Object | JsonKind::Array => Err(invalid_request(
            "decoded copy is available only for scalar nodes",
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn search_current_inner(
    state: &AppState,
    query: String,
    representation: SearchRepresentationDto,
    scope_id: Option<u64>,
    node_id: Option<usize>,
    cursor: Option<SearchCursorDto>,
    limit: usize,
    session_revision: u64,
) -> Result<SearchPageDto, IpcError> {
    let request = search_request_from_dto(
        query,
        representation,
        scope_id,
        node_id,
        cursor,
        limit,
        session_revision,
    )?;
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        if let Some(scope) = scope {
            if let Some(node_id) = request.node_id {
                ensure_search_target(session, Some(scope), node_id)?;
            }
            let page = scope.tree.search(request.clone()).map_err(search_error)?;
            if !session.is_current() {
                return Err(file_changed());
            }
            return search_page_dto(page, &request, session_revision, scope_id);
        }

        match session {
            OpenSession::Document(session) => {
                if let Some(node_id) = request.node_id {
                    ensure_search_target_node(
                        session.node(node_id).map_err(session_error)?,
                        node_id,
                    )?;
                }
                let page = session
                    .search(request.clone())
                    .map_err(session_error)?
                    .map_err(search_error)?;
                if !session.is_current() {
                    return Err(file_changed());
                }
                search_page_dto(page, &request, session_revision, scope_id)
            }
            OpenSession::Entry(session) => {
                if request.mode == SearchMode::Decoded {
                    require_selected(session)?;
                }
                if let Some(page) = session
                    .selected_search(request.clone())
                    .map_err(session_error)?
                {
                    if let Some(node_id) = request.node_id {
                        ensure_search_target_node(
                            session.selected_node(node_id).map_err(session_error)?,
                            node_id,
                        )?;
                    }
                    let page = page.map_err(search_error)?;
                    if !session.is_current() {
                        return Err(file_changed());
                    }
                    return search_page_dto(page, &request, session_revision, scope_id);
                }
                if request.mode != SearchMode::Raw {
                    return Err(invalid_request(
                        "decoded search is unavailable for an invalid or oversized Entry",
                    ));
                }
                if request.node_id.is_some() {
                    return Err(invalid_request(
                        "raw-only search does not accept a node target",
                    ));
                }
                let Some((start, end)) = session.selected_raw_range().map_err(session_error)?
                else {
                    return Err(invalid_request("no valid entry is selected"));
                };
                let range_len = usize::try_from(
                    end.checked_sub(start)
                        .ok_or_else(|| internal("selected Entry range overflow"))?,
                )
                .map_err(|_| invalid_request("Entry range exceeds addressable range"))?;
                let page = search_raw_windows(
                    range_len,
                    &request.query,
                    request.cursor.as_ref().map(|cursor| cursor.offset),
                    request.limit,
                    &request,
                    session_revision,
                    scope_id,
                    |offset, length| {
                        session
                            .read_selected_raw_window(offset, length)
                            .map_err(session_error)?
                            .ok_or_else(|| invalid_request("no valid entry is selected"))
                    },
                )?;
                if !session.is_current() {
                    return Err(file_changed());
                }
                Ok(page)
            }
            OpenSession::RawDocument { source, .. } => {
                if request.mode != SearchMode::Raw {
                    return Err(invalid_request(
                        "decoded search is unavailable for a raw-only document session",
                    ));
                }
                if request.node_id.is_some() {
                    return Err(invalid_request(
                        "raw-only search does not accept a node target",
                    ));
                }
                let range_len = usize::try_from(source.identity().size)
                    .map_err(|_| invalid_request("file size exceeds addressable range"))?;
                let page = search_raw_windows(
                    range_len,
                    &request.query,
                    request.cursor.as_ref().map(|cursor| cursor.offset),
                    request.limit,
                    &request,
                    session_revision,
                    scope_id,
                    |offset, length| {
                        let chunk = source.read_chunk(offset, length).map_err(session_error)?;
                        if !source.is_current() {
                            return Err(file_changed());
                        }
                        Ok(chunk)
                    },
                )?;
                if !source.is_current() {
                    return Err(file_changed());
                }
                Ok(page)
            }
        }
    })
}

fn search_request_from_dto(
    query: String,
    representation: SearchRepresentationDto,
    scope_id: Option<u64>,
    node_id: Option<usize>,
    cursor: Option<SearchCursorDto>,
    limit: usize,
    session_revision: u64,
) -> Result<SearchRequest, IpcError> {
    if query.is_empty() {
        return Err(invalid_request("query must not be empty"));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(invalid_request("query exceeds the 4096-byte limit"));
    }
    if limit == 0 {
        return Err(invalid_request("limit must be greater than zero"));
    }
    let mode = match representation {
        SearchRepresentationDto::Decoded => SearchMode::Decoded,
        SearchRepresentationDto::RawSource => SearchMode::Raw,
    };
    let cursor = cursor
        .map(|cursor| match cursor {
            SearchCursorDto::Decoded {
                node_id: cursor_node_id,
                field,
                byte_offset,
                query: cursor_query,
                session_revision: cursor_revision,
                scope_id: cursor_scope_id,
                target_node_id: cursor_target_node_id,
            } => {
                if mode != SearchMode::Decoded
                    || cursor_query != query
                    || cursor_revision != session_revision
                    || cursor_scope_id != scope_id
                    || cursor_target_node_id != node_id
                {
                    return Err(invalid_request("search cursor does not match the request"));
                }
                let phase = match field {
                    SearchFieldDto::Key => SearchPhase::Key,
                    SearchFieldDto::Value => SearchPhase::Value,
                    SearchFieldDto::RawSource => {
                        return Err(invalid_request(
                            "decoded search cursor field must be key or value",
                        ));
                    }
                };
                Ok(crate::search::SearchCursor {
                    mode,
                    query: query.clone(),
                    node_id,
                    unit: cursor_node_id,
                    phase,
                    offset: byte_offset,
                })
            }
            SearchCursorDto::RawSource {
                byte_offset,
                query: cursor_query,
                session_revision: cursor_revision,
                scope_id: cursor_scope_id,
                target_node_id: cursor_target_node_id,
            } => {
                if mode != SearchMode::Raw
                    || cursor_query != query
                    || cursor_revision != session_revision
                    || cursor_scope_id != scope_id
                    || cursor_target_node_id != node_id
                {
                    return Err(invalid_request("search cursor does not match the request"));
                }
                Ok(crate::search::SearchCursor {
                    mode,
                    query: query.clone(),
                    node_id,
                    unit: 0,
                    phase: SearchPhase::Value,
                    offset: byte_offset,
                })
            }
        })
        .transpose()?;
    Ok(SearchRequest {
        mode,
        query,
        cursor,
        limit,
        node_id,
    })
}

fn ensure_search_target(
    session: &OpenSession,
    scope: Option<&NestedScope>,
    node_id: usize,
) -> Result<(), IpcError> {
    let node = if let Some(scope) = scope {
        scope.tree.node(node_id)
    } else {
        match session {
            OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
            OpenSession::Entry(session) => {
                require_selected(session)?;
                session.selected_node(node_id).map_err(session_error)?
            }
            OpenSession::RawDocument { .. } => {
                return Err(invalid_request(
                    "command is unavailable for a raw-only document session",
                ));
            }
        }
    };
    ensure_search_target_node(node, node_id)
}

fn ensure_search_target_node(node: Option<NodeProjection>, node_id: usize) -> Result<(), IpcError> {
    node.ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
    Ok(())
}

fn search_error(error: SearchError) -> IpcError {
    invalid_request(error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn search_raw_windows(
    range_len: usize,
    query: &str,
    cursor_offset: Option<usize>,
    limit: usize,
    request: &SearchRequest,
    session_revision: u64,
    scope_id: Option<u64>,
    mut read: impl FnMut(u64, usize) -> Result<ReadChunk, IpcError>,
) -> Result<SearchPageDto, IpcError> {
    if query.is_empty() {
        return Err(invalid_request("query must not be empty"));
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(invalid_request("query exceeds the 4096-byte limit"));
    }
    if limit == 0 {
        return Err(invalid_request("limit must be greater than zero"));
    }
    let mut source_offset = cursor_offset.unwrap_or(0);
    if source_offset > range_len {
        return Err(invalid_request(
            "search cursor offset is outside the source range",
        ));
    }
    if range_len == source_offset {
        return Ok(SearchPageDto {
            matches: Vec::new(),
            has_more: false,
            next_cursor: None,
        });
    }

    const WINDOW_BYTES: usize = 256 * 1024;
    let query_bytes = query.as_bytes();
    let page_size = limit.min(MAX_PAGE_SIZE);
    let mut matches = Vec::new();
    let mut scanned = 0usize;
    let mut deferred_start = source_offset;
    let mut overlap = Vec::new();

    while source_offset < range_len && matches.len() < page_size && scanned < MAX_SCAN_BYTES {
        let requested = WINDOW_BYTES
            .min(MAX_SCAN_BYTES.saturating_sub(scanned))
            .min(range_len - source_offset);
        if requested == 0 {
            break;
        }
        let chunk = read(source_offset as u64, requested)?;
        if chunk.start != source_offset as u64 || chunk.bytes.is_empty() {
            return Err(internal("file ended before the requested search range"));
        }
        if chunk.bytes.len() > requested || chunk.bytes.len() > range_len - source_offset {
            return Err(internal("search window exceeded its requested bounds"));
        }

        let chunk_end = source_offset
            .checked_add(chunk.bytes.len())
            .ok_or_else(|| internal("search range overflow"))?;
        let base = source_offset
            .checked_sub(overlap.len())
            .ok_or_else(|| internal("search overlap underflow"))?;
        let mut haystack = Vec::with_capacity(overlap.len() + chunk.bytes.len());
        haystack.extend_from_slice(&overlap);
        haystack.extend_from_slice(&chunk.bytes);

        if query_bytes.len() <= haystack.len() {
            let mut cursor = 0usize;
            while cursor + query_bytes.len() <= haystack.len() {
                let Some(local_start) = find_bytes(&haystack, query_bytes, cursor) else {
                    break;
                };
                let match_start = base
                    .checked_add(local_start)
                    .ok_or_else(|| internal("search match offset overflow"))?;
                let match_end = match_start
                    .checked_add(query_bytes.len())
                    .ok_or_else(|| internal("search match range overflow"))?;
                if match_start >= deferred_start
                    && match_start < range_len
                    && match_end <= range_len
                {
                    matches.push(SearchMatchDto {
                        node_id: None,
                        field: SearchFieldDto::RawSource,
                        path_segments: vec!["$".to_owned()],
                        path_truncated: false,
                        source_span_start: match_start,
                        source_span_end: match_end,
                        match_start,
                        match_end,
                    });
                    if matches.len() >= page_size {
                        break;
                    }
                }
                cursor = local_start.saturating_add(query_bytes.len());
            }
        }

        scanned = scanned.saturating_add(chunk.bytes.len());
        source_offset = chunk_end;
        if query_bytes.len() > 1 {
            let overlap_len = (query_bytes.len() - 1).min(haystack.len());
            overlap = haystack[haystack.len() - overlap_len..].to_vec();
            deferred_start = source_offset.saturating_sub(overlap_len);
        } else {
            overlap.clear();
            deferred_start = source_offset;
        }
        if !matches.is_empty() && matches.len() >= page_size {
            break;
        }
    }

    let next_offset = if matches.len() >= page_size {
        matches
            .last()
            .map(|item| item.match_end)
            .filter(|&offset| offset < range_len)
    } else if source_offset < range_len {
        Some(deferred_start)
    } else {
        None
    };
    let has_more = next_offset.is_some();
    let next_cursor = next_offset.map(|byte_offset| SearchCursorDto::RawSource {
        byte_offset,
        query: request.query.clone(),
        session_revision,
        scope_id,
        target_node_id: request.node_id,
    });
    Ok(SearchPageDto {
        matches,
        has_more,
        next_cursor,
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if needle.is_empty() || start > haystack.len() || needle.len() > haystack.len() - start {
        return None;
    }
    let mut prefix = vec![0usize; needle.len()];
    let mut length = 0usize;
    for index in 1..needle.len() {
        while length > 0 && needle[index] != needle[length] {
            length = prefix[length - 1];
        }
        if needle[index] == needle[length] {
            length += 1;
        }
        prefix[index] = length;
    }

    let mut matched = 0usize;
    for (relative, &byte) in haystack[start..].iter().enumerate() {
        while matched > 0 && byte != needle[matched] {
            matched = prefix[matched - 1];
        }
        if byte == needle[matched] {
            matched += 1;
            if matched == needle.len() {
                return Some(start + relative + 1 - needle.len());
            }
        }
    }
    None
}

#[cfg(test)]
fn get_string_detection_inner(
    state: &AppState,
    node_id: usize,
    session_revision: u64,
) -> Result<StringDetectionDto, IpcError> {
    get_string_detection_scoped_inner(state, node_id, None, session_revision)
}

fn get_string_detection_scoped_inner(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<StringDetectionDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let detection = if let Some(scope) = scope {
            let node = scope
                .tree
                .node(node_id)
                .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
            if node.kind != JsonKind::String {
                return Err(invalid_request("node does not contain decoded text"));
            }
            scope.tree.detect_string_with_budget(node_id, scope.budget)
        } else {
            match session {
                OpenSession::Document(session) => {
                    let node = session
                        .node(node_id)
                        .map_err(session_error)?
                        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                    if node.kind != JsonKind::String {
                        return Err(invalid_request("node does not contain decoded text"));
                    }
                    session.detect_string(node_id).map_err(session_error)?
                }
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    let node = session
                        .selected_node(node_id)
                        .map_err(session_error)?
                        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                    if node.kind != JsonKind::String {
                        return Err(invalid_request("node does not contain decoded text"));
                    }
                    session.detect_string(node_id).map_err(session_error)?
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        };
        detection
            .map(string_detection_dto)
            .ok_or_else(|| invalid_request("node does not contain decoded text"))
    })
}

#[cfg(test)]
fn get_string_metrics_inner(
    state: &AppState,
    node_id: usize,
    session_revision: u64,
) -> Result<StringMetricsDto, IpcError> {
    get_string_metrics_scoped_inner(state, node_id, None, session_revision)
}

fn get_string_metrics_scoped_inner(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<StringMetricsDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let metrics = if let Some(scope) = scope {
            scope
                .tree
                .string_metrics(node_id)
                .ok_or_else(|| invalid_request("node does not contain decoded text"))?
        } else {
            match session {
                OpenSession::Document(session) => session
                    .string_metrics(node_id)
                    .map_err(session_error)?
                    .ok_or_else(|| invalid_request("node does not contain decoded text"))?,
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    session
                        .selected_string_metrics(node_id)
                        .map_err(session_error)?
                        .ok_or_else(|| invalid_request("node does not contain decoded text"))?
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        };
        if !session.is_current() {
            return Err(file_changed());
        }
        Ok(string_metrics_dto(metrics))
    })
}

fn get_html_preview_inner(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<HtmlPreviewDto, IpcError> {
    get_html_preview_scoped_inner(state, node_id, scope_id, session_revision)
}

fn get_html_preview_scoped_inner(
    state: &AppState,
    node_id: usize,
    scope_id: Option<u64>,
    session_revision: u64,
) -> Result<HtmlPreviewDto, IpcError> {
    with_session_scope(state, scope_id, session_revision, |session, scope| {
        let size_limited = || -> Result<HtmlPreviewDto, IpcError> {
            if !session.is_current() {
                return Err(file_changed());
            }
            Ok(HtmlPreviewDto {
                html: None,
                reason: Some(HtmlPreviewReasonDto::SizeLimit),
            })
        };
        let decoded = if let Some(scope) = scope {
            let node = scope
                .tree
                .node(node_id)
                .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
            if node.kind != JsonKind::String {
                return Err(invalid_request("node does not contain decoded HTML"));
            }
            let Some(decoded) = scope
                .tree
                .decoded_text_limited(node_id, html_sanitizer::MAX_INPUT_BYTES)
            else {
                return size_limited();
            };
            decoded
        } else {
            match session {
                OpenSession::Document(session) => {
                    let node = session
                        .node(node_id)
                        .map_err(session_error)?
                        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                    if node.kind != JsonKind::String {
                        return Err(invalid_request("node does not contain decoded HTML"));
                    }
                    let Some(decoded) = session
                        .decoded_text_limited(node_id, html_sanitizer::MAX_INPUT_BYTES)
                        .map_err(session_error)?
                    else {
                        return size_limited();
                    };
                    decoded
                }
                OpenSession::Entry(session) => {
                    require_selected(session)?;
                    let node = session
                        .selected_node(node_id)
                        .map_err(session_error)?
                        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                    if node.kind != JsonKind::String {
                        return Err(invalid_request("node does not contain decoded HTML"));
                    }
                    let Some(decoded) = session
                        .selected_decoded_text_limited(node_id, html_sanitizer::MAX_INPUT_BYTES)
                        .map_err(session_error)?
                    else {
                        return size_limited();
                    };
                    decoded
                }
                OpenSession::RawDocument { .. } => {
                    return Err(invalid_request(
                        "command is unavailable for a raw-only document session",
                    ));
                }
            }
        };

        let preview = html_sanitizer::sanitize_html(decoded.as_ref());
        if !session.is_current() {
            return Err(file_changed());
        }
        Ok(HtmlPreviewDto {
            html: preview.html,
            reason: preview.reason.map(html_preview_reason_dto),
        })
    })
}

fn materialize_nested_value(
    decoded: Option<Cow<'_, str>>,
    decoded_len: Option<usize>,
    parent_cumulative_bytes: usize,
) -> Result<(usize, usize, Vec<u8>), IpcError> {
    let decoded = match decoded {
        Some(decoded) => decoded.into_owned().into_bytes(),
        None => {
            if decoded_len.ok_or_else(|| invalid_request("node does not contain decoded text"))?
                > MAX_INPUT_BYTES
            {
                return Err(invalid_request("nested JSON exceeds the 2 MiB layer limit"));
            }
            return Err(invalid_request(
                "nested JSON exceeds the 8 MiB cumulative limit",
            ));
        }
    };
    let parsed_bytes = decoded.len();
    let cumulative_bytes = parent_cumulative_bytes
        .checked_add(parsed_bytes)
        .ok_or_else(|| invalid_request("nested JSON exceeds the 8 MiB cumulative limit"))?;
    if cumulative_bytes > MAX_CUMULATIVE_BYTES {
        return Err(invalid_request(
            "nested JSON exceeds the 8 MiB cumulative limit",
        ));
    }
    Ok((parsed_bytes, cumulative_bytes, decoded))
}

fn open_nested_json_inner(
    state: &AppState,
    parent_scope_id: Option<u64>,
    node_id: usize,
    max_depth: Option<u8>,
    session_revision: u64,
) -> Result<NestedScopeDto, IpcError> {
    let mut guard = lock_session(state)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    let session = guard.session.as_ref().ok_or_else(no_session)?;
    if !session.is_current() {
        return Err(file_changed());
    }
    if parent_scope_id.is_some() && max_depth.is_some() {
        return Err(invalid_request(
            "maxDepth is only valid for a root nested scope",
        ));
    }
    let mut max_depth = max_depth.unwrap_or(5);
    if !(1..=HARD_MAX_DEPTH).contains(&max_depth) {
        return Err(invalid_request("maxDepth must be between 1 and 10"));
    }

    let (parent_depth, parent_cumulative_bytes) = match parent_scope_id {
        Some(scope_id) => {
            let scope = guard
                .nested
                .find(scope_id)
                .ok_or_else(|| nested_scope_not_found(scope_id))?;
            max_depth = scope.max_depth;
            (scope.depth, scope.cumulative_bytes)
        }
        None => (0, 0),
    };
    let depth = parent_depth
        .checked_add(1)
        .ok_or_else(|| internal("nested JSON depth overflow"))?;
    if depth > max_depth {
        return Err(invalid_request("nested JSON depth limit reached"));
    }
    let materialize_limit =
        MAX_INPUT_BYTES.min(MAX_CUMULATIVE_BYTES.saturating_sub(parent_cumulative_bytes));

    let (parsed_bytes, cumulative_bytes, decoded) = match parent_scope_id {
        Some(scope_id) => {
            let scope = guard
                .nested
                .find(scope_id)
                .ok_or_else(|| nested_scope_not_found(scope_id))?;
            let node = scope
                .tree
                .node(node_id)
                .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
            if node.kind != JsonKind::String {
                return Err(invalid_request("node does not contain decoded text"));
            }
            materialize_nested_value(
                scope.tree.decoded_text_limited(node_id, materialize_limit),
                scope.tree.decoded_text_len(node_id),
                parent_cumulative_bytes,
            )?
        }
        None => match session {
            OpenSession::Document(session) => {
                let node = session
                    .node(node_id)
                    .map_err(session_error)?
                    .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                if node.kind != JsonKind::String {
                    return Err(invalid_request("node does not contain decoded text"));
                }
                materialize_nested_value(
                    session
                        .decoded_text_limited(node_id, materialize_limit)
                        .map_err(session_error)?,
                    session.decoded_text_len(node_id).map_err(session_error)?,
                    parent_cumulative_bytes,
                )?
            }
            OpenSession::Entry(session) => {
                require_selected(session)?;
                let node = session
                    .selected_node(node_id)
                    .map_err(session_error)?
                    .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
                if node.kind != JsonKind::String {
                    return Err(invalid_request("node does not contain decoded text"));
                }
                materialize_nested_value(
                    session
                        .selected_decoded_text_limited(node_id, materialize_limit)
                        .map_err(session_error)?,
                    session
                        .selected_decoded_text_len(node_id)
                        .map_err(session_error)?,
                    parent_cumulative_bytes,
                )?
            }
            OpenSession::RawDocument { .. } => {
                return Err(invalid_request(
                    "command is unavailable for a raw-only document session",
                ));
            }
        },
    };

    let tree = TreeDocument::from_bytes(decoded)
        .map_err(|_| invalid_request("node is not parseable nested JSON"))?;
    if !matches!(tree.root().kind, JsonKind::Object | JsonKind::Array) {
        return Err(invalid_request("node is not parseable nested JSON"));
    }
    if !session.is_current() {
        return Err(file_changed());
    }

    let scope_id = guard.nested.next_scope_id;
    let next_scope_id = scope_id
        .checked_add(1)
        .ok_or_else(|| internal("nested scope id overflow"))?;
    let budget = NestedBudget::from_parts(depth, max_depth, cumulative_bytes);
    let dto = NestedScopeDto {
        scope_id,
        parent_scope_id,
        source_node_id: node_id,
        root: node_dto(tree.root()),
        depth,
        max_depth,
        parsed_bytes,
        cumulative_bytes,
        session_revision,
    };
    if let Some(parent_scope_id) = parent_scope_id {
        guard.nested.truncate_after(parent_scope_id)?;
    } else {
        guard.nested.clear();
    }
    guard.nested.next_scope_id = next_scope_id;
    guard.nested.scopes.push(NestedScope {
        scope_id,
        tree,
        depth,
        max_depth,
        cumulative_bytes,
        budget,
    });
    Ok(dto)
}

fn close_nested_scope_inner(
    state: &AppState,
    scope_id: u64,
    session_revision: u64,
) -> Result<(), IpcError> {
    let mut guard = lock_session(state)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    let session = guard.session.as_ref().ok_or_else(no_session)?;
    if !session.is_current() {
        return Err(file_changed());
    }
    guard.nested.close_from(scope_id)
}

fn scan_entries_inner(
    state: &AppState,
    session_revision: u64,
) -> Result<JsonlProgressDto, IpcError> {
    with_entry_session_mut(state, session_revision, |session| {
        session.scan_next().map(progress_dto).map_err(session_error)
    })
}

fn list_entries_inner(
    state: &AppState,
    start: u64,
    limit: usize,
    session_revision: u64,
) -> Result<EntryPageDto, IpcError> {
    with_entry_session(state, session_revision, |session| {
        let page = session
            .list_entry_summaries(start, limit)
            .map_err(session_error)?
            .ok_or_else(|| invalid_request("entry range has not been indexed"))?;
        let progress = session.progress().map_err(session_error)?;
        Ok(EntryPageDto {
            entries: page.summaries.into_iter().map(entry_dto).collect(),
            has_more: page.has_more,
            next_cursor: page.next_cursor,
            progress: progress_dto(progress),
        })
    })
}

fn select_entry_inner(
    state: &AppState,
    ordinal: u64,
    session_revision: u64,
) -> Result<EntrySelectionDto, IpcError> {
    let mut guard = lock_session(state)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    let next_revision = guard
        .revision
        .checked_add(1)
        .ok_or_else(|| internal("session revision overflow"))?;
    let session = guard.session.as_mut().ok_or_else(no_session)?;
    let selection = match session {
        OpenSession::Document(_) | OpenSession::RawDocument { .. } => {
            return Err(invalid_request("command requires a JSONL session"));
        }
        OpenSession::Entry(session) => session.select_entry(ordinal).map_err(session_error)?,
    };
    let Some(selection) = selection else {
        guard.revision = next_revision;
        guard.nested = NestedScopes::new();
        return Err(invalid_request("entry is not indexed"));
    };
    let dto = selection_dto(selection, next_revision);
    guard.revision = next_revision;
    guard.nested = NestedScopes::new();
    Ok(dto)
}

fn get_oversized_preview_inner(
    state: &AppState,
    ordinal: u64,
    session_revision: u64,
) -> Result<OversizedPreviewDto, IpcError> {
    with_entry_session(state, session_revision, |session| {
        let preview = session
            .oversized_preview(ordinal)
            .map_err(session_error)?
            .ok_or_else(|| invalid_request("entry is not oversized"))?;
        Ok(oversized_preview_dto(preview))
    })
}

fn with_session<T>(
    state: &AppState,
    session_revision: u64,
    operation: impl FnOnce(&OpenSession) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.session.as_ref().ok_or_else(no_session)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    operation(session)
}

fn with_session_scope<T>(
    state: &AppState,
    scope_id: Option<u64>,
    session_revision: u64,
    operation: impl FnOnce(&OpenSession, Option<&NestedScope>) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.session.as_ref().ok_or_else(no_session)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    if !session.is_current() {
        return Err(file_changed());
    }
    let scope = scope_id.map(|scope_id| {
        guard
            .nested
            .find(scope_id)
            .ok_or_else(|| nested_scope_not_found(scope_id))
    });
    let scope = match scope {
        Some(scope) => Some(scope?),
        None => None,
    };
    operation(session, scope)
}

fn with_entry_session<T>(
    state: &AppState,
    session_revision: u64,
    operation: impl FnOnce(&JsonlSession) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    with_session(state, session_revision, |session| match session {
        OpenSession::Document(_) | OpenSession::RawDocument { .. } => {
            Err(invalid_request("command requires a JSONL session"))
        }
        OpenSession::Entry(session) => operation(session),
    })
}

fn require_selected(session: &JsonlSession) -> Result<(), IpcError> {
    session
        .selected_ordinal()
        .map_err(session_error)?
        .map(|_| ())
        .ok_or_else(|| invalid_request("no valid entry is selected"))
}

fn with_entry_session_mut<T>(
    state: &AppState,
    session_revision: u64,
    operation: impl FnOnce(&mut JsonlSession) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let mut guard = lock_session(state)?;
    if guard.revision != session_revision {
        return Err(stale_session());
    }
    let session = guard.session.as_mut().ok_or_else(no_session)?;
    match session {
        OpenSession::Document(_) | OpenSession::RawDocument { .. } => {
            Err(invalid_request("command requires a JSONL session"))
        }
        OpenSession::Entry(session) => operation(session),
    }
}

fn lock_session(state: &AppState) -> Result<MutexGuard<'_, SessionState>, IpcError> {
    state
        .session
        .lock()
        .map_err(|_| internal("document session lock is poisoned"))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<ParseErrorDto>,
}

fn no_session() -> IpcError {
    IpcError {
        code: "no_session".to_owned(),
        message: "no document is open".to_owned(),
        parse_error: None,
    }
}

fn file_changed() -> IpcError {
    IpcError {
        code: "file_changed".to_owned(),
        message: "the file changed on disk".to_owned(),
        parse_error: None,
    }
}

fn stale_session() -> IpcError {
    IpcError {
        code: "stale_session".to_owned(),
        message: "the document session is stale".to_owned(),
        parse_error: None,
    }
}

fn invalid_request(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "invalid_request".to_owned(),
        message: message.into(),
        parse_error: None,
    }
}

fn not_found(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "not_found".to_owned(),
        message: message.into(),
        parse_error: None,
    }
}

fn nested_scope_not_found(scope_id: u64) -> IpcError {
    not_found(format!("nested scope {scope_id} was not found"))
}

fn open_error(error: impl std::fmt::Display) -> IpcError {
    IpcError {
        code: "open_failed".to_owned(),
        message: error.to_string(),
        parse_error: None,
    }
}

fn invalid_json(error: crate::json::ParseError) -> IpcError {
    IpcError {
        code: "invalid_json".to_owned(),
        message: "invalid JSON".to_owned(),
        parse_error: Some(ParseErrorDto {
            message: error.message,
            byte_offset: error.byte_offset,
            line: error.line,
            column: error.column,
        }),
    }
}

fn unsupported_encoding() -> IpcError {
    IpcError {
        code: "unsupported_encoding".to_owned(),
        message: "v0.1 accepts UTF-8 and UTF-8 BOM files only".to_owned(),
        parse_error: None,
    }
}

fn unsupported_framing() -> IpcError {
    IpcError {
        code: "unsupported_framing".to_owned(),
        message: "JSON Text Sequences and concatenated JSON values are not supported".to_owned(),
        parse_error: None,
    }
}

fn unsupported_format() -> IpcError {
    IpcError {
        code: "unsupported_format".to_owned(),
        message: "this file format is not supported".to_owned(),
        parse_error: None,
    }
}

fn mode_choice_required() -> IpcError {
    IpcError {
        code: "mode_choice_required".to_owned(),
        message: "choose whether to open the file as JSON or JSONL".to_owned(),
        parse_error: None,
    }
}

fn internal(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "internal".to_owned(),
        message: message.into(),
        parse_error: None,
    }
}

fn clipboard_error(error: impl std::fmt::Display) -> IpcError {
    IpcError {
        code: "clipboard_failed".to_owned(),
        message: format!("failed to write the system clipboard: {error}"),
        parse_error: None,
    }
}

fn copy_read_error(error: io::Error) -> IpcError {
    match error.kind() {
        ErrorKind::InvalidData => file_changed(),
        ErrorKind::InvalidInput => invalid_request(error.to_string()),
        _ => internal(format!("failed to read copy source: {error}")),
    }
}

fn session_error(error: std::io::Error) -> IpcError {
    if error.kind() == std::io::ErrorKind::InvalidData {
        file_changed()
    } else {
        internal(error.to_string())
    }
}

fn node_page_dto(page: NodePage) -> NodePageDto {
    NodePageDto {
        nodes: page.nodes.into_iter().map(node_dto).collect(),
        has_more: page.has_more,
        next_cursor: page.next_cursor,
    }
}

fn node_dto(node: NodeProjection) -> NodeDto {
    NodeDto {
        id: node.id,
        kind: json_kind_name(node.kind).to_owned(),
        span_start: node.span.start,
        span_end: node.span.end,
        label: node.label,
        label_has_more: node.label_has_more,
        value_preview: node.value_preview,
        value_has_more: node.value_has_more,
        child_count: node.child_count,
    }
}

fn conversation_candidate_dto(
    candidate: ConversationCandidate,
    scope_root_id: usize,
    scope_root_span: crate::json::SourceSpan,
    session_revision: u64,
) -> ConversationCandidateDto {
    ConversationCandidateDto {
        node_id: candidate.node_id,
        span_start: candidate.span.start,
        span_end: candidate.span.end,
        message_count: candidate.message_count,
        kind: candidate.kind.as_str().to_owned(),
        scope_root_id,
        scope_root_span_start: scope_root_span.start,
        scope_root_span_end: scope_root_span.end,
        session_revision,
    }
}

fn generic_conversation_page_dto(
    page: GenericConversationPage,
    scope_root_id: usize,
    candidate_node_id: usize,
    session_revision: u64,
    style: ConversationStyle,
) -> Result<GenericConversationPageDto, IpcError> {
    let next_cursor = page.next_cursor.map(|cursor| {
        generic_conversation_cursor_dto(
            cursor,
            scope_root_id,
            candidate_node_id,
            session_revision,
            style,
        )
    });
    let dto = GenericConversationPageDto {
        blocks: page
            .blocks
            .into_iter()
            .map(generic_conversation_block_dto)
            .collect(),
        has_more: page.has_more,
        next_cursor,
        wrapper_ref: conversation_wrapper_ref_dto(page.wrapper_ref),
    };
    if dto.has_more != dto.next_cursor.is_some() {
        return Err(internal("conversation page cursor state is inconsistent"));
    }
    Ok(dto)
}

fn conversation_style_from_dto(style: ConversationStyleDto) -> ConversationStyle {
    match style {
        ConversationStyleDto::Generic => ConversationStyle::Generic,
        ConversationStyleDto::OpenAi => ConversationStyle::OpenAi,
        ConversationStyleDto::Anthropic => ConversationStyle::Anthropic,
    }
}

fn conversation_style_dto(style: ConversationStyle) -> ConversationStyleDto {
    match style {
        ConversationStyle::Generic => ConversationStyleDto::Generic,
        ConversationStyle::OpenAi => ConversationStyleDto::OpenAi,
        ConversationStyle::Anthropic => ConversationStyleDto::Anthropic,
    }
}

fn generic_conversation_cursor_dto(
    cursor: GenericConversationCursor,
    scope_root_id: usize,
    candidate_node_id: usize,
    session_revision: u64,
    style: ConversationStyle,
) -> GenericConversationCursorDto {
    GenericConversationCursorDto {
        kind: GenericConversationCursorKindDto::GenericConversation,
        style: conversation_style_dto(style),
        scope_root_id,
        candidate_node_id,
        message_index: cursor.message_index,
        phase: match cursor.phase {
            GenericConversationPhase::Message => GenericConversationPhaseDto::Message,
            GenericConversationPhase::Fields => GenericConversationPhaseDto::Fields,
            GenericConversationPhase::SystemHeader => GenericConversationPhaseDto::SystemHeader,
            GenericConversationPhase::SystemContent => GenericConversationPhaseDto::SystemContent,
        },
        field_index: cursor.field_index,
        element_index: cursor.element_index,
        session_revision,
    }
}

fn generic_conversation_cursor_from_dto(
    cursor: Option<GenericConversationCursorDto>,
    scope_root_id: usize,
    candidate_node_id: usize,
    session_revision: u64,
    style: ConversationStyle,
) -> Result<Option<GenericConversationCursor>, IpcError> {
    cursor
        .map(|cursor| {
            if cursor.kind != GenericConversationCursorKindDto::GenericConversation
                || cursor.scope_root_id != scope_root_id
                || cursor.candidate_node_id != candidate_node_id
                || cursor.session_revision != session_revision
                || cursor.style != conversation_style_dto(style)
            {
                return Err(invalid_request(
                    "conversation cursor does not match the request",
                ));
            }
            Ok(GenericConversationCursor {
                message_index: cursor.message_index,
                phase: match cursor.phase {
                    GenericConversationPhaseDto::Message => GenericConversationPhase::Message,
                    GenericConversationPhaseDto::Fields => GenericConversationPhase::Fields,
                    GenericConversationPhaseDto::SystemHeader => {
                        GenericConversationPhase::SystemHeader
                    }
                    GenericConversationPhaseDto::SystemContent => {
                        GenericConversationPhase::SystemContent
                    }
                },
                field_index: cursor.field_index,
                element_index: cursor.element_index,
            })
        })
        .transpose()
}

fn generic_conversation_block_dto(block: GenericConversationBlock) -> GenericConversationBlockDto {
    let (source_node_id, source_span_start, source_span_end) =
        block.source.map_or((None, None, None), |source| {
            (
                Some(source.node_id),
                Some(source.span.start),
                Some(source.span.end),
            )
        });
    let (field_node_id, field_span_start, field_span_end) =
        block.field.map_or((None, None, None), |field| {
            (
                Some(field.node_id),
                Some(field.span.start),
                Some(field.span.end),
            )
        });
    let (role_source_node_id, role_source_span_start, role_source_span_end) =
        block.role_source.map_or((None, None, None), |role| {
            (
                Some(role.node_id),
                Some(role.span.start),
                Some(role.span.end),
            )
        });
    GenericConversationBlockDto {
        kind: match block.kind {
            GenericConversationBlockKind::Message => "message",
            GenericConversationBlockKind::Source => "source",
            GenericConversationBlockKind::System => "system",
        }
        .to_owned(),
        message_node_id: block.message.map(|message| message.node_id),
        message_span_start: block.message.map(|message| message.span.start),
        message_span_end: block.message.map(|message| message.span.end),
        source_node_id,
        source_span_start,
        source_span_end,
        field_node_id,
        field_span_start,
        field_span_end,
        category: block.category.as_str().to_owned(),
        role: block.role.as_str().to_owned(),
        role_source_node_id,
        role_source_span_start,
        role_source_span_end,
        openai_refs: block.openai_refs.map(conversation_openai_refs_dto),
        anthropic_refs: block.anthropic_refs.map(conversation_anthropic_refs_dto),
    }
}

fn conversation_openai_refs_dto(refs: ConversationOpenAiRefs) -> ConversationOpenAiRefsDto {
    ConversationOpenAiRefsDto {
        block: refs.block.map(conversation_source_ref_dto),
        text: refs.text.map(conversation_source_ref_dto),
        image: refs.image.map(conversation_source_ref_dto),
        call_id: refs.call_id.map(conversation_source_ref_dto),
        function: refs.function.map(conversation_source_ref_dto),
        name: refs.name.map(conversation_source_ref_dto),
        arguments: refs.arguments.map(conversation_source_ref_dto),
    }
}

fn conversation_anthropic_refs_dto(
    refs: ConversationAnthropicRefs,
) -> ConversationAnthropicRefsDto {
    ConversationAnthropicRefsDto {
        block: refs.block.map(conversation_source_ref_dto),
        text: refs.text.map(conversation_source_ref_dto),
        thinking: refs.thinking.map(conversation_source_ref_dto),
        data: refs.data.map(conversation_source_ref_dto),
        id: refs.id.map(conversation_source_ref_dto),
        name: refs.name.map(conversation_source_ref_dto),
        input: refs.input.map(conversation_source_ref_dto),
        tool_use_id: refs.tool_use_id.map(conversation_source_ref_dto),
        content: refs.content.map(conversation_source_ref_dto),
    }
}

fn conversation_source_ref_dto(
    source: crate::conversation::ConversationSourceRef,
) -> ConversationSourceRefDto {
    ConversationSourceRefDto {
        node_id: source.node_id,
        span_start: source.span.start,
        span_end: source.span.end,
    }
}

fn conversation_wrapper_ref_dto(
    wrapper: crate::conversation::ConversationWrapperRef,
) -> ConversationWrapperRefDto {
    ConversationWrapperRefDto {
        scope_root_id: wrapper.scope_root.node_id,
        scope_root_span_start: wrapper.scope_root.span.start,
        scope_root_span_end: wrapper.scope_root.span.end,
        candidate_node_id: wrapper.candidate.node_id,
        candidate_span_start: wrapper.candidate.span.start,
        candidate_span_end: wrapper.candidate.span.end,
    }
}

fn text_chunk_dto(chunk: TextChunk) -> TextChunkDto {
    TextChunkDto {
        start: chunk.start,
        text: chunk.text,
        has_more: chunk.has_more,
        next_offset: chunk.next_offset,
    }
}

fn search_page_dto(
    page: SearchPage,
    request: &SearchRequest,
    session_revision: u64,
    scope_id: Option<u64>,
) -> Result<SearchPageDto, IpcError> {
    let has_more = page.has_more;
    let matches = page.matches.into_iter().map(search_match_dto).collect();
    let next_cursor = page
        .next_cursor
        .map(|cursor| search_cursor_dto(cursor, request, session_revision, scope_id))
        .transpose()?;
    if has_more != next_cursor.is_some() {
        return Err(internal("search page cursor state is inconsistent"));
    }
    Ok(SearchPageDto {
        matches,
        has_more,
        next_cursor,
    })
}

fn search_match_dto(item: crate::search::SearchMatch) -> SearchMatchDto {
    SearchMatchDto {
        node_id: item.node_id,
        field: match item.field {
            SearchField::Key => SearchFieldDto::Key,
            SearchField::Value => SearchFieldDto::Value,
            SearchField::RawSource => SearchFieldDto::RawSource,
        },
        path_segments: item.path,
        path_truncated: item.path_truncated,
        source_span_start: item.span.start,
        source_span_end: item.span.end,
        match_start: item.match_start,
        match_end: item.match_end,
    }
}

fn search_cursor_dto(
    cursor: crate::search::SearchCursor,
    request: &SearchRequest,
    session_revision: u64,
    scope_id: Option<u64>,
) -> Result<SearchCursorDto, IpcError> {
    if cursor.mode != request.mode
        || cursor.query != request.query
        || cursor.node_id != request.node_id
    {
        return Err(internal("search cursor does not match the request"));
    }
    match cursor.mode {
        SearchMode::Decoded => Ok(SearchCursorDto::Decoded {
            node_id: cursor.unit,
            field: match cursor.phase {
                SearchPhase::Key => SearchFieldDto::Key,
                SearchPhase::Value => SearchFieldDto::Value,
            },
            byte_offset: cursor.offset,
            query: request.query.clone(),
            session_revision,
            scope_id,
            target_node_id: request.node_id,
        }),
        SearchMode::Raw => Ok(SearchCursorDto::RawSource {
            byte_offset: cursor.offset,
            query: request.query.clone(),
            session_revision,
            scope_id,
            target_node_id: request.node_id,
        }),
    }
}

fn string_detection_dto(detection: Detection) -> StringDetectionDto {
    let (semantic_type, plain_reason) = match detection {
        Detection::PlainText(reason) => (
            SemanticTypeDto::PlainText,
            Some(match reason {
                PlainReason::Fallback => PlainReasonDto::Fallback,
                PlainReason::JsonParseFailed => PlainReasonDto::JsonParseFailed,
                PlainReason::SizeLimit => PlainReasonDto::SizeLimit,
                PlainReason::DepthLimit => PlainReasonDto::DepthLimit,
                PlainReason::CumulativeLimit => PlainReasonDto::CumulativeLimit,
            }),
        ),
        Detection::Markdown => (SemanticTypeDto::Markdown, None),
        Detection::NestedJson { .. } => (SemanticTypeDto::NestedJson, None),
        Detection::Code => (SemanticTypeDto::Code, None),
        Detection::Html => (SemanticTypeDto::Html, None),
    };
    StringDetectionDto {
        semantic_type,
        detection_source: DetectionSourceDto::ContentDetected,
        plain_reason,
    }
}

fn string_metrics_dto(metrics: StringMetrics) -> StringMetricsDto {
    StringMetricsDto {
        decoded_bytes: metrics.decoded_bytes,
        character_count: metrics.character_count,
        line_count: metrics.line_count,
    }
}

fn html_preview_reason_dto(reason: HtmlPreviewReason) -> HtmlPreviewReasonDto {
    match reason {
        HtmlPreviewReason::SizeLimit => HtmlPreviewReasonDto::SizeLimit,
        HtmlPreviewReason::RenderLimit => HtmlPreviewReasonDto::RenderLimit,
    }
}

fn progress_dto(progress: JsonlProgress) -> JsonlProgressDto {
    JsonlProgressDto {
        indexed_entries: progress.indexed_entries,
        indexed_source_lines: progress.indexed_source_lines,
        complete: progress.complete,
        stride: progress.stride,
        total_entries: progress.total_entries,
    }
}

fn entry_dto(summary: EntrySummary) -> EntryDto {
    let (status, parse_error) = match summary.status {
        EntryStatus::Valid => ("valid", None),
        EntryStatus::InvalidUtf8 => ("invalidUtf8", None),
        EntryStatus::Oversized => ("oversized", None),
        EntryStatus::InvalidJson(error) => (
            "invalidJson",
            Some(ParseErrorDto {
                message: error.message,
                byte_offset: error.byte_offset,
                line: error.line,
                column: error.column,
            }),
        ),
    };
    EntryDto {
        location: EntryLocationDto {
            entry_ordinal: summary.location.entry_ordinal,
            source_line: summary.location.source_line,
            byte_start: summary.location.byte_start,
            byte_end: summary.location.byte_end,
        },
        status: status.to_owned(),
        parse_error,
    }
}

fn selection_dto(selection: EntrySelection, session_revision: u64) -> EntrySelectionDto {
    EntrySelectionDto {
        entry: entry_dto(selection.summary),
        root: selection.root.map(node_dto),
        session_revision,
    }
}

fn oversized_preview_dto(preview: OversizedPreview) -> OversizedPreviewDto {
    OversizedPreviewDto {
        entry: EntryDto {
            location: EntryLocationDto {
                entry_ordinal: preview.location.entry_ordinal,
                source_line: preview.location.source_line,
                byte_start: preview.location.byte_start,
                byte_end: preview.location.byte_end,
            },
            status: "oversized".to_owned(),
            parse_error: None,
        },
        head: preview.head,
        tail: preview.tail,
    }
}

fn json_kind_name(kind: JsonKind) -> &'static str {
    match kind {
        JsonKind::String => "string",
        JsonKind::Number => "number",
        JsonKind::True => "true",
        JsonKind::False => "false",
        JsonKind::Null => "null",
        JsonKind::Object => "object",
        JsonKind::Array => "array",
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::TryLockError;
    use std::time::SystemTime;

    use super::*;

    const MAX_IPC_PAYLOAD_BYTES: usize = 1024 * 1024;

    fn temp_path(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}.json", std::process::id()))
    }

    fn temp_jsonl_path(prefix: &str) -> PathBuf {
        temp_path(prefix).with_extension("jsonl")
    }

    fn write_large_json(path: &Path, prefix: &[u8], suffix: &[u8]) {
        let size = (crate::file_route::FULL_PARSE_LIMIT_BYTES + 1) as usize;
        let mut file = fs::File::create(path).unwrap();
        let filler = vec![b' '; 1024 * 1024];
        file.write_all(prefix).unwrap();
        let mut remaining = size - prefix.len() - suffix.len();
        while remaining > 0 {
            let write_len = remaining.min(filler.len());
            file.write_all(&filler[..write_len]).unwrap();
            remaining -= write_len;
        }
        file.write_all(suffix).unwrap();
        file.flush().unwrap();
    }

    fn child_id(
        state: &AppState,
        scope_id: Option<u64>,
        parent_id: usize,
        label: &str,
        revision: u64,
    ) -> usize {
        get_children_scoped_inner(state, parent_id, 0, 200, scope_id, revision)
            .unwrap()
            .nodes
            .into_iter()
            .find(|node| node.label == label)
            .unwrap_or_else(|| panic!("missing child {label}"))
            .id
    }

    fn sized_nested_object(size: usize, fill: u8) -> String {
        let prefix = b"{\"payload\":\"";
        let suffix = b"\"}";
        assert!(size >= prefix.len() + suffix.len());
        format!(
            "{}{}{}",
            std::str::from_utf8(prefix).unwrap(),
            char::from(fill)
                .to_string()
                .repeat(size - prefix.len() - suffix.len()),
            std::str::from_utf8(suffix).unwrap()
        )
    }

    #[test]
    fn conversation_candidate_ipc_consumes_generated_f03_f05_fixtures() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-ipc-conversation-fixtures-{}-{nanos}",
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
            ("openai-conversation.json", "messages", "openai"),
            ("anthropic-system-string.json", "messages", "anthropic"),
            ("anthropic-system-blocks.json", "messages", "anthropic"),
            ("generic-role-content.json", "conversation", "generic"),
            ("generic-from-value.json", "conversation", "generic"),
            ("generic-non-conversation.json", "$", "none"),
            ("generic-threshold-79.json", "$", "possible"),
            ("generic-threshold-80.json", "$", "generic"),
        ];
        let state = AppState::default();
        for (name, candidate_label, expected_kind) in cases {
            let summary = open_file_inner(
                &state,
                directory
                    .join(name)
                    .to_str()
                    .expect("fixture path is UTF-8"),
            )
            .unwrap();
            let root_id = summary.root.as_ref().map_or(0, |root| root.id);
            let candidate_id = if candidate_label == "$" {
                root_id
            } else {
                child_id(
                    &state,
                    None,
                    root_id,
                    candidate_label,
                    summary.session_revision,
                )
            };
            let candidate = get_conversation_candidate_inner(
                &state,
                root_id,
                candidate_id,
                None,
                summary.session_revision,
            )
            .unwrap();
            assert_eq!(candidate.kind, expected_kind, "{name}");
            assert_eq!(candidate.node_id, candidate_id, "{name} node id");
            assert_eq!(candidate.scope_root_id, root_id, "{name} scope root");
        }
        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }

    fn nested_chain(depth: usize) -> String {
        assert!(depth >= 1);
        let mut current = r#"{"leaf":true}"#.to_owned();
        for level in (1..depth).rev() {
            current = format!(
                r#"{{"level":{level},"next":{}}}"#,
                serde_json::to_string(&current).unwrap()
            );
        }
        current
    }

    fn wrap_nested_chain(mut current: String, layers: usize) -> (String, Vec<usize>) {
        let mut sizes = vec![current.len()];
        for _ in 1..layers {
            current = format!(r#"{{"next":{}}}"#, serde_json::to_string(&current).unwrap());
            sizes.push(current.len());
        }
        (current, sizes)
    }

    #[test]
    fn dto_serialization_uses_camel_case() {
        let dto = NodePageDto {
            nodes: vec![NodeDto {
                id: usize::MAX,
                kind: "string".to_owned(),
                span_start: usize::MAX,
                span_end: usize::MAX,
                label: "label".to_owned(),
                label_has_more: true,
                value_preview: Some("value".to_owned()),
                value_has_more: true,
                child_count: usize::MAX,
            }],
            has_more: true,
            next_cursor: Some(usize::MAX),
        };

        let encoded = serde_json::to_vec(&dto).unwrap();
        let encoded = String::from_utf8(encoded).unwrap();
        assert!(encoded.contains("spanStart"));
        assert!(encoded.contains("labelHasMore"));
        assert!(encoded.contains("nextCursor"));
        assert!(!encoded.contains("span_start"));
    }

    #[test]
    fn conversation_candidate_ipc_requires_explicit_direct_array() {
        let path = temp_path("ipc-conversation-direct-candidate");
        fs::write(
            &path,
            br#"{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}],"conversation":[{"role":"user","content":"c"},{"role":"assistant","content":"d"}],"meta":{"messages":[{"role":"user","content":"deep"},{"role":"assistant","content":"deep"}]}}"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let messages = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "messages",
            opened.session_revision,
        );
        let conversation = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "conversation",
            opened.session_revision,
        );

        let first = get_conversation_candidate_inner(
            &state,
            opened.root.as_ref().unwrap().id,
            messages,
            None,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(first.node_id, messages);
        assert_eq!(first.kind, "generic");
        assert_eq!(first.message_count, 2);
        assert_eq!(first.scope_root_id, opened.root.as_ref().unwrap().id);
        assert_eq!(first.scope_root_span_start, 0);

        let second = get_conversation_candidate_inner(
            &state,
            opened.root.as_ref().unwrap().id,
            conversation,
            None,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(second.node_id, conversation);
        assert_eq!(second.kind, "generic");

        let root_error = get_conversation_candidate_inner(
            &state,
            opened.root.as_ref().unwrap().id,
            opened.root.as_ref().unwrap().id,
            None,
            opened.session_revision,
        )
        .unwrap_err();
        assert_eq!(root_error.code, "invalid_request");

        let meta = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "meta",
            opened.session_revision,
        );
        let deep_messages = child_id(&state, None, meta, "messages", opened.session_revision);
        let deep_error = get_conversation_candidate_inner(
            &state,
            meta,
            deep_messages,
            None,
            opened.session_revision,
        )
        .unwrap_err();
        assert_eq!(deep_error.code, "invalid_request");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_candidate_ipc_binds_jsonl_selection_revision_and_file_state() {
        let path = temp_jsonl_path("ipc-conversation-entry");
        let line = br#"{"messages":[{"role":"user","content":"a"},{"role":"assistant","tool_calls":[{"function":{"name":"lookup","arguments":"{}"}}]}]}"#;
        let mut input = Vec::new();
        input.extend_from_slice(line);
        input.push(b'\n');
        input.extend_from_slice(line);
        input.push(b'\n');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let unselected =
            get_conversation_candidate_inner(&state, 0, 0, None, opened.session_revision)
                .unwrap_err();
        assert_eq!(unselected.code, "invalid_request");

        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let selected_revision = selected.session_revision;
        let messages = child_id(&state, None, 0, "messages", selected_revision);
        let candidate =
            get_conversation_candidate_inner(&state, 0, messages, None, selected_revision).unwrap();
        assert_eq!(candidate.kind, "openai");
        assert_eq!(candidate.message_count, 2);

        let second = select_entry_inner(&state, 1, selected_revision).unwrap();
        let stale = get_conversation_candidate_inner(&state, 0, messages, None, selected_revision)
            .unwrap_err();
        assert_eq!(stale.code, "stale_session");
        assert_eq!(second.session_revision, selected_revision + 1);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        let changed =
            get_conversation_candidate_inner(&state, 0, messages, None, second.session_revision)
                .unwrap_err();
        assert_eq!(changed.code, "file_changed");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_candidate_ipc_rejects_raw_only_sessions() {
        let path = temp_path("ipc-conversation-raw-only");
        fs::write(&path, b"not valid json").unwrap();
        let state = AppState::default();
        let summary =
            open_file_with_override(&state, path.to_str().unwrap(), Some("json")).unwrap();
        let error = get_conversation_candidate_inner(&state, 0, 0, None, summary.session_revision)
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_paginates_and_binds_cursor() {
        let path = temp_path("ipc-generic-conversation-blocks");
        fs::write(
            &path,
            br#"[{"role":"user","role":"assistant","content":["first","second"],"value":null,"tool_calls":{"name":"lookup"},"unknown":true},{"from":"human","content":[],"value":{"answer":42},"extra":"kept"},null]"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            1,
            opened.session_revision,
            None,
        )
        .unwrap();
        assert_eq!(page.blocks.len(), 1);
        assert_eq!(page.blocks[0].kind, "message");
        assert_eq!(page.blocks[0].role, "user");
        assert!(page.blocks[0].role_source_node_id.is_some());
        assert!(page.has_more);
        assert_eq!(page.wrapper_ref.scope_root_id, 0);
        assert_eq!(page.wrapper_ref.candidate_node_id, 0);
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);

        let mut wrong_revision_cursor = page.next_cursor.clone().unwrap();
        wrong_revision_cursor.session_revision += 1;
        let wrong_revision = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            Some(wrong_revision_cursor),
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(wrong_revision.code, "invalid_request");

        let mut cursor = page.next_cursor;
        let mut blocks = page.blocks;
        while let Some(next) = cursor {
            let page = get_generic_conversation_blocks_inner(
                &state,
                0,
                0,
                Some(next),
                100,
                opened.session_revision,
                None,
            )
            .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            assert_eq!(page.has_more, cursor.is_some());
        }
        assert_eq!(
            blocks
                .iter()
                .map(|block| (block.kind.as_str(), block.category.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("message", "message"),
                ("source", "role"),
                ("source", "content"),
                ("source", "content"),
                ("source", "value"),
                ("source", "tool"),
                ("source", "unknown"),
                ("message", "message"),
                ("source", "content"),
                ("source", "value"),
                ("source", "unknown"),
                ("message", "message"),
            ]
        );

        let stale_cursor = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            1,
            opened.session_revision + 1,
            None,
        )
        .unwrap_err();
        assert_eq!(stale_cursor.code, "stale_session");

        let wrong_candidate = get_generic_conversation_blocks_inner(
            &state,
            0,
            1,
            None,
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(wrong_candidate.code, "invalid_request");

        let malformed = GenericConversationCursorDto {
            kind: GenericConversationCursorKindDto::GenericConversation,
            style: ConversationStyleDto::Generic,
            scope_root_id: 0,
            candidate_node_id: 0,
            message_index: 0,
            phase: GenericConversationPhaseDto::Fields,
            field_index: 0,
            element_index: 0,
            session_revision: opened.session_revision,
        };
        let malformed_error = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            Some(malformed),
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(malformed_error.code, "invalid_request");

        let zero = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            0,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(zero.code, "invalid_request");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_handles_large_message_array_with_bounded_page() {
        let path = temp_path("ipc-generic-conversation-large");
        let mut items = String::new();
        for index in 0..10_000 {
            if index > 0 {
                items.push(',');
            }
            items.push_str(&format!(r#"{{"role":"user","content":"message-{index}"}}"#));
        }
        fs::write(&path, format!("[{items}]")).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            usize::MAX,
            opened.session_revision,
            None,
        )
        .unwrap();
        assert_eq!(page.blocks.len(), 100);
        assert!(page.has_more);
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        assert_eq!(page.blocks[0].message_node_id, Some(1));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_does_not_return_giant_text_or_unknown_fields() {
        let path = temp_path("ipc-generic-conversation-giant-fields");
        let giant = "x".repeat(2 * 1024 * 1024);
        let input = format!(
            r#"[{{"role":"user","content":"{giant}","unknown":"{giant}"}},{{"role":"assistant","content":"reply"}}]"#
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            100,
            opened.session_revision,
            None,
        )
        .unwrap();
        let payload = serde_json::to_vec(&page).unwrap();
        assert!(payload.len() < MAX_IPC_PAYLOAD_BYTES);
        assert!(!payload
            .windows(128)
            .any(|window| window.iter().all(|byte| *byte == b'x')));
        assert!(page.blocks.iter().any(|block| block.category == "unknown"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_rejects_cross_item_cursor_and_file_changes() {
        let path = temp_path("ipc-generic-conversation-collection");
        fs::write(
            &path,
            br#"[{"messages":[{"role":"user","content":"first"},{"role":"assistant","content":"reply"}]},{"messages":[{"role":"user","content":"second"},{"role":"assistant","content":"reply"}]}]"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let first_item = child_id(&state, None, 0, "[0]", opened.session_revision);
        let second_item = child_id(&state, None, 0, "[1]", opened.session_revision);
        let first_candidate = child_id(
            &state,
            None,
            first_item,
            "messages",
            opened.session_revision,
        );
        let second_candidate = child_id(
            &state,
            None,
            second_item,
            "messages",
            opened.session_revision,
        );
        let first = get_generic_conversation_blocks_inner(
            &state,
            first_item,
            first_candidate,
            None,
            1,
            opened.session_revision,
            None,
        )
        .unwrap();
        let cursor = first.next_cursor.unwrap();
        let crossed = get_generic_conversation_blocks_inner(
            &state,
            second_item,
            second_candidate,
            Some(cursor),
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(crossed.code, "invalid_request");

        let stale = get_generic_conversation_blocks_inner(
            &state,
            first_item,
            first_candidate,
            None,
            1,
            opened.session_revision + 1,
            None,
        )
        .unwrap_err();
        assert_eq!(stale.code, "stale_session");

        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        let changed = get_generic_conversation_blocks_inner(
            &state,
            first_item,
            first_candidate,
            None,
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(changed.code, "file_changed");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_requires_a_selected_jsonl_entry() {
        let path = temp_jsonl_path("ipc-generic-conversation-entry");
        fs::write(
            &path,
            b"{\"messages\":[{\"role\":\"user\",\"content\":\"a\"},{\"role\":\"assistant\",\"content\":\"b\"}]}\n",
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let unselected = get_generic_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            1,
            opened.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(unselected.code, "invalid_request");
        let selection = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let messages = child_id(&state, None, 0, "messages", selection.session_revision);
        let page = get_generic_conversation_blocks_inner(
            &state,
            0,
            messages,
            None,
            1,
            selection.session_revision,
            None,
        )
        .unwrap();
        assert_eq!(page.blocks[0].kind, "message");
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        let changed = get_generic_conversation_blocks_inner(
            &state,
            0,
            messages,
            None,
            1,
            selection.session_revision,
            None,
        )
        .unwrap_err();
        assert_eq!(changed.code, "file_changed");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_blocks_ipc_anthropic_entry_stale_and_file_change_guards() {
        let path = temp_jsonl_path("ipc-anthropic-entry-guards");
        let line = br#"{"system":"sys","messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}"#;
        let mut input = Vec::new();
        input.extend_from_slice(line);
        input.push(b'\n');
        input.extend_from_slice(line);
        input.push(b'\n');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let unselected = get_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            1,
            opened.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap_err();
        assert_eq!(unselected.code, "invalid_request");
        let selection = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let candidate = child_id(&state, None, 0, "messages", selection.session_revision);
        let first = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            1,
            selection.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert_eq!(first.blocks[0].kind, "system");
        let stale = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            1,
            selection.session_revision + 1,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap_err();
        assert_eq!(stale.code, "stale_session");
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        let changed = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            1,
            selection.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap_err();
        assert_eq!(changed.code, "file_changed");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_consumes_generated_openai_and_anthropic_sources() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-ipc-generic-fixtures-{}-{nanos}",
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
            ("openai-conversation.json", "messages", "tool"),
            ("anthropic-system-string.json", "messages", "unknown"),
            ("anthropic-system-blocks.json", "messages", "unknown"),
        ];
        let state = AppState::default();
        for (name, label, expected_category) in cases {
            let summary = open_file_inner(
                &state,
                directory
                    .join(name)
                    .to_str()
                    .expect("fixture path is UTF-8"),
            )
            .unwrap();
            let root_id = summary.root.as_ref().unwrap().id;
            let candidate_id = child_id(&state, None, root_id, label, summary.session_revision);
            let page = get_generic_conversation_blocks_inner(
                &state,
                root_id,
                candidate_id,
                None,
                100,
                summary.session_revision,
                None,
            )
            .unwrap();
            assert!(
                page.blocks
                    .iter()
                    .any(|block| block.category == expected_category),
                "{name}"
            );
            for block in page
                .blocks
                .iter()
                .filter(|block| matches!(block.category.as_str(), "tool" | "unknown"))
            {
                assert!(block.source_node_id.is_some(), "{name} source node");
                assert!(block.field_node_id.is_some(), "{name} field node");
                assert!(
                    block.source_span_start.unwrap() >= block.message_span_start.unwrap()
                        && block.source_span_end.unwrap() <= block.message_span_end.unwrap(),
                    "{name} source span"
                );
            }
            assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        }
        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }

    #[test]
    fn conversation_blocks_ipc_explicit_openai_projects_f03_refs_without_body_text() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-ipc-openai-fixture-{}-{nanos}",
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
        let state = AppState::default();
        let path = directory.join("openai-conversation.json");
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root_id = summary.root.as_ref().unwrap().id;
        let candidate_id = child_id(&state, None, root_id, "messages", summary.session_revision);
        let first = get_conversation_blocks_inner(
            &state,
            root_id,
            candidate_id,
            None,
            1,
            summary.session_revision,
            None,
            ConversationStyle::OpenAi,
        )
        .unwrap();
        let first_cursor = first.next_cursor.clone().unwrap();
        let wrong_style = get_conversation_blocks_inner(
            &state,
            root_id,
            candidate_id,
            Some(first_cursor.clone()),
            1,
            summary.session_revision,
            None,
            ConversationStyle::Generic,
        )
        .unwrap_err();
        assert_eq!(wrong_style.code, "invalid_request");
        let mut cursor = first.next_cursor;
        let mut blocks = first.blocks;
        loop {
            let page = get_conversation_blocks_inner(
                &state,
                root_id,
                candidate_id,
                cursor,
                100,
                summary.session_revision,
                None,
                ConversationStyle::OpenAi,
            )
            .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let roles: Vec<_> = blocks
            .iter()
            .filter(|block| block.kind == "message")
            .map(|block| block.role.as_str())
            .collect();
        assert_eq!(
            roles,
            [
                "system",
                "developer",
                "user",
                "assistant",
                "tool",
                "assistant"
            ]
        );
        assert!(blocks.iter().any(|block| block.category == "text"));
        assert!(blocks.iter().any(|block| block.category == "image"));
        assert!(blocks.iter().any(|block| block.category == "toolResult"));
        assert!(blocks.iter().any(|block| block.category == "unknown"));
        let tool_calls: Vec<_> = blocks
            .iter()
            .filter(|block| block.category == "toolCall")
            .collect();
        assert_eq!(tool_calls.len(), 3);
        for block in tool_calls {
            let refs = block.openai_refs.as_ref().unwrap();
            assert!(refs.function.is_some());
            assert!(refs.name.is_some());
            assert!(refs.arguments.is_some());
        }
        let text_block = blocks
            .iter()
            .find(|block| block.category == "text" && block.openai_refs.is_some())
            .unwrap();
        assert!(text_block.openai_refs.as_ref().unwrap().text.is_some());
        let image_block = blocks
            .iter()
            .find(|block| block.category == "image")
            .unwrap();
        assert!(image_block.openai_refs.as_ref().unwrap().image.is_some());
        let payload = serde_json::to_vec(&blocks).unwrap();
        assert!(payload.len() < MAX_IPC_PAYLOAD_BYTES);
        assert!(!String::from_utf8_lossy(&payload).contains("OPENAI_CONTENT_UNKNOWN_SENTINEL"));
        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }

    #[test]
    fn conversation_blocks_ipc_explicit_anthropic_projects_f04_system_and_blocks() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-ipc-anthropic-fixtures-{}-{nanos}",
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
        let state = AppState::default();
        for name in [
            "anthropic-system-string.json",
            "anthropic-system-blocks.json",
        ] {
            let summary = open_file_inner(
                &state,
                directory
                    .join(name)
                    .to_str()
                    .expect("fixture path is UTF-8"),
            )
            .unwrap();
            let root_id = summary.root.as_ref().unwrap().id;
            let candidate = child_id(&state, None, root_id, "messages", summary.session_revision);
            let mut cursor = None;
            let mut blocks = Vec::new();
            loop {
                let page = get_conversation_blocks_inner(
                    &state,
                    root_id,
                    candidate,
                    cursor,
                    100,
                    summary.session_revision,
                    None,
                    ConversationStyle::Anthropic,
                )
                .unwrap();
                assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
                blocks.extend(page.blocks);
                cursor = page.next_cursor;
                if !page.has_more {
                    break;
                }
            }
            let first_message = blocks
                .iter()
                .position(|block| block.kind == "message")
                .unwrap();
            assert!(blocks[..first_message]
                .iter()
                .all(|block| block.message_node_id.is_none()));
            assert!(blocks[..first_message]
                .iter()
                .all(|block| block.source_node_id.is_some() && block.field_node_id.is_some()));
            let roles: Vec<_> = blocks
                .iter()
                .filter(|block| block.kind == "message")
                .map(|block| block.role.as_str())
                .collect();
            assert_eq!(roles, ["user", "assistant", "user"]);
            for category in [
                "text",
                "thinking",
                "redactedThinking",
                "toolUse",
                "toolResult",
            ] {
                assert!(
                    blocks.iter().any(|block| block.category == category),
                    "{name}: missing {category}"
                );
            }
            assert!(blocks.iter().any(|block| block.category == "unknown"));
            assert!(blocks.iter().any(|block| {
                matches!(
                    block.category.as_str(),
                    "text" | "thinking" | "redactedThinking" | "toolUse" | "toolResult"
                ) && block.anthropic_refs.is_some()
            }));
            let expected_text = [
                "Use source-preserving reasoning and identify tool results explicitly.",
                "Use source-preserving reasoning.",
                "Please inspect the attached result.",
                "I will use the lookup tool.",
                "status: ready",
            ];
            for block in &blocks {
                if let Some(source) = block.source_node_id {
                    let node =
                        get_node_summary_inner(&state, source, summary.session_revision).unwrap();
                    assert_eq!(node.span_start, block.source_span_start.unwrap(), "{name}");
                    assert_eq!(node.span_end, block.source_span_end.unwrap(), "{name}");
                    let raw = read_raw_slice_inner(
                        &state,
                        block.source_span_start.unwrap(),
                        block.source_span_end.unwrap() - block.source_span_start.unwrap(),
                        summary.session_revision,
                    )
                    .unwrap();
                    assert_eq!(raw.start, block.source_span_start.unwrap(), "{name}");
                    assert_eq!(
                        raw.text.len(),
                        block.source_span_end.unwrap() - block.source_span_start.unwrap(),
                        "{name} source {source}"
                    );
                }
                let Some(refs) = block.anthropic_refs.as_ref() else {
                    continue;
                };
                for source in [
                    refs.block.as_ref(),
                    refs.text.as_ref(),
                    refs.thinking.as_ref(),
                    refs.data.as_ref(),
                    refs.id.as_ref(),
                    refs.name.as_ref(),
                    refs.input.as_ref(),
                    refs.tool_use_id.as_ref(),
                    refs.content.as_ref(),
                ]
                .into_iter()
                .flatten()
                {
                    let node =
                        get_node_summary_inner(&state, source.node_id, summary.session_revision)
                            .unwrap();
                    assert_eq!(node.span_start, source.span_start, "{name}");
                    assert_eq!(node.span_end, source.span_end, "{name}");
                    let raw = read_raw_slice_inner(
                        &state,
                        source.span_start,
                        source.span_end - source.span_start,
                        summary.session_revision,
                    )
                    .unwrap();
                    assert_eq!(
                        raw.text.len(),
                        source.span_end - source.span_start,
                        "{name}"
                    );
                }
                let assert_decoded = |source: &ConversationSourceRefDto, expected: &[&str]| {
                    let decoded = read_decoded_text_inner(
                        &state,
                        source.node_id,
                        0,
                        usize::MAX,
                        summary.session_revision,
                    )
                    .unwrap();
                    assert!(
                        expected.contains(&decoded.text.as_str()),
                        "{name} decoded {}",
                        source.node_id
                    );
                };
                if let Some(source) = refs.text.as_ref() {
                    assert_decoded(source, &expected_text);
                }
                if let Some(source) = refs.thinking.as_ref() {
                    assert_decoded(
                        source,
                        &["I should inspect the tool result before answering."],
                    );
                }
                if let Some(source) = refs.data.as_ref() {
                    assert_decoded(source, &["opaque-redacted-content"]);
                }
                if let Some(source) = refs.id.as_ref() {
                    assert_decoded(source, &["toolu_lookup"]);
                }
                if let Some(source) = refs.name.as_ref() {
                    assert_decoded(source, &["lookup_status"]);
                }
                if let Some(source) = refs.tool_use_id.as_ref() {
                    assert_decoded(source, &["toolu_lookup"]);
                }
                if let Some(source) = refs.input.as_ref() {
                    let raw = read_raw_slice_inner(
                        &state,
                        source.span_start,
                        source.span_end - source.span_start,
                        summary.session_revision,
                    )
                    .unwrap();
                    assert_eq!(
                        raw.text,
                        "{\n            \"query\": \"status\"\n          }"
                    );
                }
                if let Some(source) = refs.content.as_ref() {
                    let raw = read_raw_slice_inner(
                        &state,
                        source.span_start,
                        source.span_end - source.span_start,
                        summary.session_revision,
                    )
                    .unwrap();
                    assert!(raw.text.contains("status: ready"));
                    assert!(raw.text.contains("ANTHROPIC_RESULT_TEXT_UNKNOWN_SENTINEL"));
                }
            }
        }
        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }

    #[test]
    fn conversation_blocks_ipc_anthropic_pages_duplicate_system_and_content_arrays() {
        let path = temp_path("ipc-anthropic-system-content-pages");
        let system_elements = (0..205)
            .map(|index| format!("\"system-{index}\""))
            .collect::<Vec<_>>()
            .join(",");
        let content_elements = (0..205)
            .map(|index| format!(r#"{{"type":"text","text":"content-{index}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let input = format!(
            r#"{{"before":true,"system":[{system_elements}],"middle":1,"system":"second","messages":[{{"role":"user","content":[{content_elements}]}}]}}"#
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let candidate = child_id(&state, None, 0, "messages", summary.session_revision);
        let first = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            1,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        let cross_style = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            first.next_cursor.clone(),
            1,
            summary.session_revision,
            None,
            ConversationStyle::Generic,
        )
        .unwrap_err();
        assert_eq!(cross_style.code, "invalid_request");
        let mut system_values = Vec::new();
        let mut content_values = Vec::new();
        let mut record_page = |page: &GenericConversationPageDto| {
            assert!(page.blocks.len() <= 1);
            for block in &page.blocks {
                if block.message_node_id.is_none() && block.kind == "source" {
                    let source = block.source_node_id.unwrap();
                    let decoded = read_decoded_text_inner(
                        &state,
                        source,
                        0,
                        usize::MAX,
                        summary.session_revision,
                    )
                    .unwrap();
                    system_values.push(decoded.text);
                }
                if block.message_node_id.is_some() && block.category == "text" {
                    let source = block
                        .anthropic_refs
                        .as_ref()
                        .unwrap()
                        .text
                        .as_ref()
                        .unwrap();
                    let decoded = read_decoded_text_inner(
                        &state,
                        source.node_id,
                        0,
                        usize::MAX,
                        summary.session_revision,
                    )
                    .unwrap();
                    content_values.push(decoded.text);
                }
            }
        };
        record_page(&first);
        let mut cursor = first.next_cursor;
        let mut blocks = first.blocks;
        loop {
            let request_cursor = cursor.clone();
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                cursor,
                1,
                summary.session_revision,
                None,
                ConversationStyle::Anthropic,
            )
            .unwrap();
            if let Some(request_cursor) = request_cursor {
                if page.has_more {
                    assert_ne!(page.next_cursor.as_ref(), Some(&request_cursor));
                }
            }
            record_page(&page);
            assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let first_message = blocks
            .iter()
            .position(|block| block.kind == "message")
            .unwrap();
        let system_headers: Vec<_> = blocks
            .iter()
            .filter(|block| block.kind == "system")
            .collect();
        assert_eq!(system_headers.len(), 2);
        assert!(system_headers.iter().all(|block| {
            block.message_node_id.is_none()
                && block.source_node_id.is_some()
                && block.field_node_id.is_some()
        }));
        assert!(blocks[..first_message]
            .iter()
            .all(|block| block.message_node_id.is_none()));
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.category == "text" && block.message_node_id.is_none())
                .count(),
            1
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.category == "unknown" && block.message_node_id.is_none())
                .count(),
            205
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.category == "text" && block.message_node_id.is_some())
                .count(),
            205
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.kind == "message")
                .count(),
            1
        );
        assert_eq!(
            system_values,
            (0..205)
                .map(|index| format!("system-{index}"))
                .chain(std::iter::once("second".to_owned()))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            content_values,
            (0..205)
                .map(|index| format!("content-{index}"))
                .collect::<Vec<_>>()
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_blocks_ipc_anthropic_empty_messages_and_bounded_wrapper_scan() {
        let empty_path = temp_path("ipc-anthropic-empty-messages");
        fs::write(&empty_path, br#"{"system":null,"messages":[]}"#).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, empty_path.to_str().unwrap()).unwrap();
        let candidate = child_id(&state, None, 0, "messages", summary.session_revision);
        let page = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            100,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.blocks[0].kind, "system");
        assert!(!page.has_more);
        let forged = GenericConversationCursorDto {
            kind: GenericConversationCursorKindDto::GenericConversation,
            style: ConversationStyleDto::Anthropic,
            scope_root_id: 0,
            candidate_node_id: candidate,
            message_index: 0,
            phase: GenericConversationPhaseDto::SystemContent,
            field_index: 1,
            element_index: 0,
            session_revision: summary.session_revision,
        };
        let forged_error = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            Some(forged),
            1,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap_err();
        assert_eq!(forged_error.code, "invalid_request");
        fs::remove_file(empty_path).unwrap();

        let empty_array_path = temp_path("ipc-anthropic-empty-system-array");
        fs::write(&empty_array_path, br#"{"system":[],"messages":[]}"#).unwrap();
        let summary = open_file_inner(&state, empty_array_path.to_str().unwrap()).unwrap();
        let candidate = child_id(&state, None, 0, "messages", summary.session_revision);
        let page = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            100,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert_eq!(page.blocks.len(), 2);
        assert_eq!(page.blocks[1].category, "unknown");
        fs::remove_file(empty_array_path).unwrap();

        let large_path = temp_path("ipc-anthropic-wrapper-scan");
        let mut wrapper = String::from("{");
        for index in 0..200 {
            if index > 0 {
                wrapper.push(',');
            }
            wrapper.push_str(&format!(r#""meta-{index}":{index}"#));
        }
        wrapper.push_str(r#", "messages":[{"role":"user","content":"done"}]}"#);
        fs::write(&large_path, wrapper).unwrap();
        let summary = open_file_inner(&state, large_path.to_str().unwrap()).unwrap();
        let candidate =
            get_children_scoped_inner(&state, 0, 200, 200, None, summary.session_revision)
                .unwrap()
                .nodes
                .into_iter()
                .find(|node| node.label == "messages")
                .unwrap()
                .id;
        let first = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            None,
            100,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert!(first.blocks.is_empty());
        assert!(first.has_more);
        let second = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            first.next_cursor,
            100,
            summary.session_revision,
            None,
            ConversationStyle::Anthropic,
        )
        .unwrap();
        assert!(second.blocks.iter().any(|block| block.kind == "message"));
        fs::remove_file(large_path).unwrap();
    }

    #[test]
    fn conversation_blocks_ipc_pages_205_openai_tool_calls_without_duplicates() {
        let path = temp_path("ipc-openai-tool-calls-205");
        let mut calls = String::new();
        for index in 0..205 {
            if index > 0 {
                calls.push(',');
            }
            calls.push_str(&format!(
                r#"{{"id":"call-{index}","type":"function","function":{{"name":"fn-{index}","arguments":"{{}}"}}}}"#
            ));
        }
        let input = format!(r#"[{{"role":"assistant","tool_calls":[{calls}]}}]"#);
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                0,
                cursor,
                100,
                summary.session_revision,
                None,
                ConversationStyle::OpenAi,
            )
            .unwrap();
            assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        assert_eq!(
            blocks
                .iter()
                .filter(|block| block.kind == "message")
                .count(),
            1
        );
        let calls: Vec<_> = blocks
            .iter()
            .filter(|block| block.category == "toolCall")
            .map(|block| {
                let refs = block.openai_refs.as_ref().unwrap();
                assert!(refs.call_id.is_some());
                assert!(refs.function.is_some());
                assert!(refs.name.is_some());
                assert!(refs.arguments.is_some());
                block.source_node_id.unwrap()
            })
            .collect();
        assert_eq!(calls.len(), 205);
        let mut unique = calls.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), calls.len());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_blocks_ipc_openai_omits_giant_arguments_from_dto() {
        let path = temp_path("ipc-openai-giant-arguments");
        let giant = "a".repeat(2 * 1024 * 1024);
        let input = format!(
            r#"[{{"role":"assistant","tool_calls":[{{"type":"function","function":{{"name":"big","arguments":"{giant}"}}}}]}},{{"role":"user","content":"done"}}]"#
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = get_conversation_blocks_inner(
            &state,
            0,
            0,
            None,
            100,
            summary.session_revision,
            None,
            ConversationStyle::OpenAi,
        )
        .unwrap();
        let payload = serde_json::to_vec(&page).unwrap();
        assert!(payload.len() < MAX_IPC_PAYLOAD_BYTES);
        assert!(!payload
            .windows(128)
            .any(|window| window.iter().all(|byte| *byte == b'a')));
        assert!(page
            .blocks
            .iter()
            .any(|block| block.category == "toolCall" && block.openai_refs.is_some()));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn conversation_blocks_ipc_mixed_candidate_keeps_generic_stable_and_openai_refs_source_faithful(
    ) {
        let path = temp_path("ipc-mixed-style-conversation");
        let mut content_blocks = String::new();
        for index in 0..205 {
            if index > 0 {
                content_blocks.push(',');
            }
            content_blocks.push_str(&format!(
                r#"{{"type":"tool_use","id":"toolu-{index}","name":"lookup-{index}","input":{{"index":{index}}}}}"#
            ));
        }
        let input = format!(
            r#"{{"messages":[{{"role":"assistant","content":[{content_blocks}],"tool_calls":[{{"id":"call-1","type":"function","function":{{"name":"lookup","arguments":"{{\"q\":1}}"}}}}]}},{{"role":"user","content":"done"}}]}}"#
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let candidate = child_id(&state, None, 0, "messages", summary.session_revision);
        let detected =
            get_conversation_candidate_inner(&state, 0, candidate, None, summary.session_revision)
                .unwrap();
        assert_eq!(detected.kind, "mixed");

        let mut generic_cursor = None;
        let mut generic_before = Vec::new();
        loop {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                generic_cursor,
                100,
                summary.session_revision,
                None,
                ConversationStyle::Generic,
            )
            .unwrap();
            assert!(page.blocks.iter().all(|block| block.openai_refs.is_none()));
            generic_cursor = page.next_cursor.clone();
            generic_before.push(serde_json::to_vec(&page).unwrap());
            if !page.has_more {
                break;
            }
        }
        let generic_cursor_for_cross_style = {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                None,
                100,
                summary.session_revision,
                None,
                ConversationStyle::Generic,
            )
            .unwrap();
            page.next_cursor.unwrap()
        };
        let openai_from_generic = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            Some(generic_cursor_for_cross_style),
            100,
            summary.session_revision,
            None,
            ConversationStyle::OpenAi,
        )
        .unwrap_err();
        assert_eq!(openai_from_generic.code, "invalid_request");

        let mut openai_cursor = None;
        let mut openai_blocks = Vec::new();
        loop {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                openai_cursor,
                100,
                summary.session_revision,
                None,
                ConversationStyle::OpenAi,
            )
            .unwrap();
            openai_cursor = page.next_cursor.clone();
            openai_blocks.extend(page.blocks);
            if !page.has_more {
                break;
            }
        }
        let openai_from_openai = {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                None,
                100,
                summary.session_revision,
                None,
                ConversationStyle::OpenAi,
            )
            .unwrap();
            page.next_cursor.unwrap()
        };
        let generic_from_openai = get_conversation_blocks_inner(
            &state,
            0,
            candidate,
            Some(openai_from_openai),
            100,
            summary.session_revision,
            None,
            ConversationStyle::Generic,
        )
        .unwrap_err();
        assert_eq!(generic_from_openai.code, "invalid_request");

        let mut generic_cursor = None;
        let mut generic_after = Vec::new();
        loop {
            let page = get_conversation_blocks_inner(
                &state,
                0,
                candidate,
                generic_cursor,
                100,
                summary.session_revision,
                None,
                ConversationStyle::Generic,
            )
            .unwrap();
            generic_cursor = page.next_cursor.clone();
            generic_after.push(serde_json::to_vec(&page).unwrap());
            if !page.has_more {
                break;
            }
        }
        assert_eq!(generic_before, generic_after);

        let tool_call = openai_blocks
            .iter()
            .find(|block| block.category == "toolCall")
            .unwrap();
        let refs = tool_call.openai_refs.as_ref().unwrap();
        let name = refs.name.as_ref().unwrap();
        let arguments = refs.arguments.as_ref().unwrap();
        let name_source = read_raw_slice_inner(
            &state,
            name.span_start,
            name.span_end - name.span_start,
            summary.session_revision,
        )
        .unwrap();
        let arguments_source = read_raw_slice_inner(
            &state,
            arguments.span_start,
            arguments.span_end - arguments.span_start,
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(name_source.text, "\"lookup\"");
        assert_eq!(arguments_source.text, "\"{\\\"q\\\":1}\"");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn generic_conversation_blocks_ipc_projects_generated_f05_roles_and_tail_sources() {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "semantic-json-viewer-ipc-f05-projection-fixtures-{}-{nanos}",
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

        let state = AppState::default();
        let threshold_path = directory.join("generic-threshold-80.json");
        let threshold = open_file_inner(
            &state,
            threshold_path.to_str().expect("fixture path is UTF-8"),
        )
        .unwrap();
        let threshold_root = threshold.root.as_ref().unwrap().id;
        let message_nodes = get_children_scoped_inner(
            &state,
            threshold_root,
            0,
            200,
            None,
            threshold.session_revision,
        )
        .unwrap()
        .nodes;
        assert_eq!(message_nodes.len(), 100);
        let mut cursor = None;
        let mut blocks = Vec::new();
        loop {
            let page = get_generic_conversation_blocks_inner(
                &state,
                threshold_root,
                threshold_root,
                cursor,
                100,
                threshold.session_revision,
                None,
            )
            .unwrap();
            blocks.extend(page.blocks);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        let projected_message_ids: Vec<_> = blocks
            .iter()
            .filter(|block| block.kind == "message")
            .map(|block| block.message_node_id.unwrap())
            .collect();
        let expected_message_ids: Vec<_> = message_nodes.iter().map(|node| node.id).collect();
        assert_eq!(projected_message_ids, expected_message_ids);

        let tail_ids = &expected_message_ids[80..];
        let mut expected_tail_source_ids = Vec::new();
        for message_id in tail_ids {
            let fields = get_children_scoped_inner(
                &state,
                *message_id,
                0,
                200,
                None,
                threshold.session_revision,
            )
            .unwrap()
            .nodes;
            expected_tail_source_ids.extend(fields.into_iter().map(|field| field.id));
        }
        let actual_tail_sources: Vec<_> = blocks
            .iter()
            .filter(|block| {
                block.kind == "source" && tail_ids.contains(&block.message_node_id.unwrap())
            })
            .map(|block| {
                assert_eq!(block.category, "unknown");
                block.source_node_id.unwrap()
            })
            .collect();
        assert_eq!(actual_tail_sources, expected_tail_source_ids);
        assert!(serde_json::to_vec(&blocks).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);

        let from_path = directory.join("generic-from-value.json");
        let from_summary =
            open_file_inner(&state, from_path.to_str().expect("fixture path is UTF-8")).unwrap();
        let from_root = from_summary.root.as_ref().unwrap().id;
        let from_candidate = child_id(
            &state,
            None,
            from_root,
            "conversation",
            from_summary.session_revision,
        );
        let from_page = get_generic_conversation_blocks_inner(
            &state,
            from_root,
            from_candidate,
            None,
            100,
            from_summary.session_revision,
            None,
        )
        .unwrap();
        let roles: Vec<_> = from_page
            .blocks
            .iter()
            .filter(|block| block.kind == "message")
            .map(|block| block.role.as_str())
            .collect();
        assert_eq!(roles, ["user", "assistant", "user", "assistant"]);
        assert_eq!(
            from_page
                .blocks
                .iter()
                .filter(|block| block.category == "value")
                .count(),
            4
        );

        fs::remove_dir_all(directory).expect("generated fixture directory should be removable");
    }

    #[test]
    fn real_node_page_serialization_stays_below_one_mib() {
        let path = temp_path("ipc-node-page-payload");
        let escaped_null = "\\u0000".repeat(256);
        let mut input = String::from("{");
        for index in 0..200 {
            if index > 0 {
                input.push(',');
            }
            input.push('"');
            input.push_str(&escaped_null);
            input.push_str(&index.to_string());
            input.push_str("\":\"");
            input.push_str(&escaped_null);
            input.push('"');
        }
        input.push('}');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = get_children_inner(
            &state,
            summary.root.as_ref().unwrap().id,
            0,
            usize::MAX,
            summary.session_revision,
        )
        .unwrap();

        assert_eq!(page.nodes.len(), 200);
        let encoded = serde_json::to_vec(&page).unwrap();
        assert!(encoded.len() < MAX_IPC_PAYLOAD_BYTES);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn real_decoded_text_serialization_stays_below_one_mib() {
        let path = temp_path("ipc-decoded-payload");
        let escaped_null = "\\u0000".repeat(128 * 1024);
        fs::write(&path, format!("[\"{escaped_null}\"]")).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let chunk = read_decoded_text_inner(
            &state,
            summary.root.as_ref().unwrap().id + 1,
            0,
            usize::MAX,
            summary.session_revision,
        )
        .unwrap();

        assert_eq!(chunk.text.len(), 128 * 1024);
        let encoded = serde_json::to_vec(&chunk).unwrap();
        assert!(encoded.len() < MAX_IPC_PAYLOAD_BYTES);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn jsonl_open_exposes_partial_progress_and_scan_keeps_revision() {
        let path = temp_jsonl_path("ipc-jsonl-progress");
        let mut input = (0..20)
            .map(|index| format!("{index}\n"))
            .collect::<String>()
            .into_bytes();
        input.extend(std::iter::repeat_n(b'x', 256 * 1024));
        fs::write(&path, input).unwrap();
        let state = AppState::default();

        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "entry");
        assert!(summary.root.is_none());
        let progress = summary.progress.as_ref().unwrap();
        assert!(progress.indexed_entries >= 20);
        assert!(!progress.complete);
        assert_eq!(progress.total_entries, None);
        assert_eq!(summary.session_revision, 1);

        let page = list_entries_inner(&state, 0, 200, summary.session_revision).unwrap();
        assert_eq!(page.entries.len(), 20);
        assert!(!page.progress.complete);
        assert_eq!(page.progress.total_entries, None);

        let complete = scan_entries_inner(&state, summary.session_revision).unwrap();
        assert!(complete.complete);
        assert_eq!(complete.total_entries, Some(21));
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            summary.session_revision
        );

        let complete_page = list_entries_inner(&state, 0, 200, summary.session_revision).unwrap();
        assert!(complete_page.progress.complete);
        assert_eq!(complete_page.progress.total_entries, Some(21));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_large_file_uses_bounded_sample_and_stays_in_entry_mode() {
        let path = temp_path("ipc-route-large-sample").with_extension("blob");
        let mut file = fs::File::create(&path).unwrap();
        file.set_len(crate::file_route::FULL_PARSE_LIMIT_BYTES + 1)
            .unwrap();
        file.write_all("{}\n".repeat(200).as_bytes()).unwrap();
        file.flush().unwrap();

        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "entry");
        assert!(summary.root.is_none());
        assert!(summary.progress.as_ref().unwrap().indexed_entries >= 2);
        assert!(!summary.progress.as_ref().unwrap().complete);
        assert_eq!(summary.progress.as_ref().unwrap().total_entries, None);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn open_routes_overrides_and_preserves_the_previous_session_on_failure() {
        let previous = temp_path("ipc-route-previous");
        fs::write(&previous, b"{\"previous\":true}").unwrap();
        let state = AppState::default();
        let previous_summary = open_file_inner(&state, previous.to_str().unwrap()).unwrap();

        let explicit_jsonl = temp_jsonl_path("ipc-route-conflict");
        fs::write(&explicit_jsonl, b"{}\n").unwrap();
        assert_eq!(
            open_file_with_override(&state, explicit_jsonl.to_str().unwrap(), Some("json"))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(get_file_summary_inner(&state).unwrap(), previous_summary);

        assert_eq!(
            open_file_with_override(&state, previous.to_str().unwrap(), Some("ndjson"))
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            open_file_with_override(&state, previous.to_str().unwrap(), Some("yaml"))
                .unwrap_err()
                .code,
            "invalid_request"
        );

        let unknown = temp_path("ipc-route-choice").with_extension("blob");
        fs::write(&unknown, b"not-json\nstill-not-json\n").unwrap();
        assert_eq!(
            open_file_inner(&state, unknown.to_str().unwrap())
                .unwrap_err()
                .code,
            "mode_choice_required"
        );
        let chosen =
            open_file_with_override(&state, unknown.to_str().unwrap(), Some("jsonl")).unwrap();
        assert_eq!(chosen.mode, "entry");
        assert!(!chosen.many_invalid_utf8_warning);
        assert_eq!(
            chosen.session_revision,
            previous_summary.session_revision + 1
        );

        let unsupported = temp_path("ipc-route-unsupported").with_extension("jsonc");
        fs::write(&unsupported, b"{}").unwrap();
        assert_eq!(
            open_file_inner(&state, unsupported.to_str().unwrap())
                .unwrap_err()
                .code,
            "unsupported_format"
        );

        fs::remove_file(previous).unwrap();
        fs::remove_file(explicit_jsonl).unwrap();
        fs::remove_file(unknown).unwrap();
        fs::remove_file(unsupported).unwrap();
    }

    #[test]
    fn open_file_uses_content_for_unknown_small_and_extension_case_for_entries() {
        let state = AppState::default();
        let object = temp_path("ipc-route-unknown-object").with_extension("blob");
        fs::write(&object, b"{\"a\":1}").unwrap();
        let summary = open_file_inner(&state, object.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert!(summary.root.is_some());
        assert!(summary.progress.is_none());
        fs::remove_file(object).unwrap();

        let array = temp_path("ipc-route-unknown-array").with_extension("blob");
        fs::write(&array, b"[1,2]").unwrap();
        let summary = open_file_inner(&state, array.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "collection");
        assert_eq!(summary.root.as_ref().unwrap().kind, "array");
        fs::remove_file(array).unwrap();

        let mut jsonl = Vec::new();
        for _ in 0..9 {
            jsonl.extend_from_slice(b"{}\n");
        }
        jsonl.extend_from_slice(b"not-json\n");
        let unknown_jsonl = temp_path("ipc-route-unknown-jsonl").with_extension("blob");
        fs::write(&unknown_jsonl, &jsonl).unwrap();
        let summary = open_file_inner(&state, unknown_jsonl.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "entry");
        assert!(summary.root.is_none());
        assert!(summary.progress.is_some());
        fs::remove_file(unknown_jsonl).unwrap();

        for extension in ["JSONL", "NDJSON"] {
            let path = temp_path("ipc-route-case").with_extension(extension);
            fs::write(&path, b"{}\n").unwrap();
            assert_eq!(
                open_file_inner(&state, path.to_str().unwrap())
                    .unwrap()
                    .mode,
                "entry"
            );
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn unknown_bad_utf8_requires_choice_and_supports_jsonl_byte_safe_override() {
        let path = temp_path("ipc-route-unknown-bad-utf8").with_extension("blob");
        fs::write(&path, b"\xff\n{}\n").unwrap();
        let state = AppState::default();

        assert_eq!(
            open_file_inner(&state, path.to_str().unwrap())
                .unwrap_err()
                .code,
            "mode_choice_required"
        );
        let entry = open_file_with_override(&state, path.to_str().unwrap(), Some("jsonl")).unwrap();
        assert_eq!(entry.mode, "entry");
        assert!(entry.progress.is_some());
        let page = list_entries_inner(&state, 0, 200, entry.session_revision).unwrap();
        assert_eq!(page.entries[0].status, "invalidUtf8");
        assert_eq!(page.entries[1].status, "valid");

        let document =
            open_file_with_override(&state, path.to_str().unwrap(), Some("json")).unwrap();
        assert_eq!(document.mode, "document");
        assert!(document.root.is_none());
        assert_eq!(
            document.document_error.as_ref().unwrap().code,
            "unsupported_encoding"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unknown_large_mode_choice_can_retry_as_json_document_or_collection() {
        for (prefix, suffix, expected_mode) in [
            (br#"{"value":0"# as &[u8], b"}" as &[u8], "document"),
            (b"[0" as &[u8], b"]" as &[u8], "collection"),
        ] {
            let path = temp_path("ipc-route-large-choice").with_extension("blob");
            write_large_json(&path, prefix, suffix);
            let state = AppState::default();
            let error = open_file_inner(&state, path.to_str().unwrap()).unwrap_err();
            assert_eq!(error.code, "mode_choice_required");
            let summary =
                open_file_with_override(&state, path.to_str().unwrap(), Some("json")).unwrap();
            assert_eq!(summary.mode, expected_mode);
            assert!(summary.root.is_some());
            assert!(summary.progress.is_none());
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn open_reports_structured_encoding_framing_and_warning_states() {
        let state = AppState::default();
        let json = temp_path("ipc-route-json-invalid");
        fs::write(&json, b"{").unwrap();
        let summary = open_file_inner(&state, json.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert!(summary.root.is_none());
        assert_eq!(
            summary.document_error.as_ref().unwrap().code,
            "invalid_json"
        );
        assert!(summary
            .document_error
            .as_ref()
            .and_then(|error| error.parse_error.as_ref())
            .is_some());
        fs::remove_file(json).unwrap();

        let encoding = temp_path("ipc-route-encoding").with_extension("blob");
        fs::write(&encoding, [0xFF, 0xFE]).unwrap();
        assert_eq!(
            open_file_with_override(&state, encoding.to_str().unwrap(), Some("jsonl"))
                .unwrap_err()
                .code,
            "unsupported_encoding"
        );
        fs::remove_file(encoding).unwrap();

        let framing = temp_path("ipc-route-framing").with_extension("blob");
        fs::write(&framing, b"\x1e{}\n").unwrap();
        assert_eq!(
            open_file_with_override(&state, framing.to_str().unwrap(), Some("jsonl"))
                .unwrap_err()
                .code,
            "unsupported_framing"
        );
        fs::remove_file(framing).unwrap();

        for (invalid_count, expected_warning) in [(2, false), (3, true)] {
            let warning = temp_jsonl_path("ipc-route-warning");
            let mut input = Vec::new();
            for index in 0..10 {
                if index < invalid_count {
                    input.extend_from_slice(b"\xff\n");
                } else {
                    input.extend_from_slice(b"{}\n");
                }
            }
            fs::write(&warning, input).unwrap();
            let summary = open_file_inner(&state, warning.to_str().unwrap()).unwrap();
            assert_eq!(summary.many_invalid_utf8_warning, expected_warning);
            let encoded = serde_json::to_vec(&summary).unwrap();
            let encoded = String::from_utf8(encoded).unwrap();
            assert!(encoded.contains("manyInvalidUtf8Warning"));
            assert!(!encoded.contains("many_invalid_utf8_warning"));
            fs::remove_file(warning).unwrap();
        }

        let mixed = temp_jsonl_path("ipc-route-parse-error");
        let mut input = b"\xff\n\xff\n{\n".to_vec();
        input.extend(std::iter::repeat_n(b"{}\n".as_slice(), 7).flatten());
        fs::write(&mixed, input).unwrap();
        let summary = open_file_inner(&state, mixed.to_str().unwrap()).unwrap();
        let page = list_entries_inner(&state, 0, 200, summary.session_revision).unwrap();
        let encoded_page = String::from_utf8(serde_json::to_vec(&page).unwrap()).unwrap();
        assert!(encoded_page.contains("parseError"));
        assert!(encoded_page.contains("byteOffset"));
        assert!(!encoded_page.contains("byte_offset"));
        let encoded_summary = String::from_utf8(serde_json::to_vec(&summary).unwrap()).unwrap();
        assert!(encoded_summary.contains("manyInvalidUtf8Warning"));
        assert!(!encoded_summary.contains("many_invalid_utf8_warning"));
        fs::remove_file(mixed).unwrap();
    }

    #[test]
    fn jsonl_selection_dispatches_tree_and_invalidates_old_revision() {
        let path = temp_jsonl_path("ipc-jsonl-select");
        fs::write(&path, b"{\"name\":\"Ada\"}\n[1,2]\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let first = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(first.entry.status, "valid");
        assert_eq!(first.root.as_ref().unwrap().kind, "object");
        assert_eq!(first.session_revision, 2);
        assert_eq!(
            get_root_node_inner(&state, opened.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );
        let root = get_root_node_inner(&state, first.session_revision).unwrap();
        let page = get_children_inner(&state, root.id, 0, 200, first.session_revision).unwrap();
        assert_eq!(page.nodes[0].label, "name");
        let raw = read_raw_slice_inner(&state, 0, usize::MAX, first.session_revision).unwrap();
        assert_eq!(raw.text, r#"{"name":"Ada"}"#);
        let decoded =
            read_decoded_text_inner(&state, page.nodes[0].id, 0, 32, first.session_revision)
                .unwrap();
        assert_eq!(decoded.text, "Ada");

        let second = select_entry_inner(&state, 1, first.session_revision).unwrap();
        assert_eq!(second.entry.status, "valid");
        assert_eq!(second.root.as_ref().unwrap().kind, "array");
        assert_eq!(second.session_revision, 3);
        assert_eq!(
            get_root_node_inner(&state, first.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn unindexed_selection_bumps_revision_after_clearing_tree() {
        let path = temp_jsonl_path("ipc-jsonl-select-missing");
        fs::write(&path, b"{\"ok\":true}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let valid = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(valid.session_revision, 2);
        assert!(get_root_node_inner(&state, valid.session_revision).is_ok());

        assert_eq!(
            select_entry_inner(&state, 99, valid.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        let after = get_file_summary_inner(&state).unwrap();
        assert_eq!(after.session_revision, 3);
        assert_eq!(
            get_root_node_inner(&state, valid.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );
        assert_eq!(
            get_node_summary_inner(&state, 0, valid.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );
        assert_eq!(
            get_root_node_inner(&state, after.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn jsonl_status_dtos_keep_parse_errors_and_clear_invalid_selection() {
        let path = temp_jsonl_path("ipc-jsonl-statuses");
        fs::write(&path, b"{\"ok\":true}\n{\n\"bad\":\xff\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = list_entries_inner(&state, 0, 200, opened.session_revision).unwrap();
        assert_eq!(page.entries.len(), 3);
        assert_eq!(page.entries[0].status, "valid");
        assert_eq!(page.entries[1].status, "invalidJson");
        assert!(page.entries[1].parse_error.is_some());
        assert_eq!(page.entries[2].status, "invalidUtf8");
        assert!(page.entries[2].parse_error.is_none());

        let valid = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let invalid_json = select_entry_inner(&state, 1, valid.session_revision).unwrap();
        assert_eq!(invalid_json.entry.status, "invalidJson");
        assert!(invalid_json.root.is_none());
        assert_eq!(invalid_json.session_revision, valid.session_revision + 1);
        assert_eq!(
            get_root_node_inner(&state, invalid_json.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        let invalid_utf8 = select_entry_inner(&state, 2, invalid_json.session_revision).unwrap();
        assert_eq!(invalid_utf8.entry.status, "invalidUtf8");
        assert!(invalid_utf8.root.is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn jsonl_oversized_preview_and_selection_stay_below_ipc_limit() {
        let path = temp_jsonl_path("ipc-jsonl-oversized");
        let mut input = Vec::with_capacity(16 * 1024 * 1024 + 64);
        input.push(0xff);
        input.extend(std::iter::repeat_n(b'a', 16 * 1024 * 1024));
        input.push(b'\n');
        input.extend_from_slice(br#"{"ok":true}"#);
        input.push(b'\n');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let mut progress = opened.progress.clone().unwrap();
        while !progress.complete {
            progress = scan_entries_inner(&state, opened.session_revision).unwrap();
        }
        assert_eq!(progress.total_entries, Some(2));

        let preview = get_oversized_preview_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(preview.entry.status, "oversized");
        assert_eq!(preview.head.len(), 64 * 1024);
        assert_eq!(preview.tail.len(), 64 * 1024);
        assert!(serde_json::to_vec(&preview).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);

        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "oversized");
        assert!(selected.root.is_none());
        assert_eq!(selected.session_revision, opened.session_revision + 1);
        assert_eq!(
            get_root_node_inner(&state, selected.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn open_and_read_commands_share_one_session() {
        let path = temp_path("ipc-session");
        fs::write(&path, r#"{"name":"Ada","items":[1,2]}"#).unwrap();
        let state = AppState::default();

        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert_eq!(summary.root.as_ref().unwrap().kind, "object");
        assert_eq!(summary.root.as_ref().unwrap().child_count, 2);
        assert_eq!(summary.session_revision, 1);

        let root = get_root_node_inner(&state, summary.session_revision).unwrap();
        let page = get_children_inner(&state, root.id, 0, 200, summary.session_revision).unwrap();
        assert_eq!(page.nodes[0].label, "name");
        assert_eq!(page.nodes[1].label, "items");

        let raw = read_raw_slice_inner(&state, 8, 5, summary.session_revision).unwrap();
        assert_eq!(raw.text, r#""Ada""#);
        let decoded =
            read_decoded_text_inner(&state, page.nodes[0].id, 0, 16, summary.session_revision)
                .unwrap();
        assert_eq!(decoded.text, "Ada");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn open_array_reports_collection_mode() {
        let path = temp_path("ipc-collection");
        fs::write(&path, b"[1,2,3]").unwrap();
        let state = AppState::default();

        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "collection");
        assert_eq!(summary.root.as_ref().unwrap().kind, "array");
        assert_eq!(summary.session_revision, 1);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn commands_reject_missing_session_and_invalid_ranges() {
        let state = AppState::default();
        assert_eq!(
            get_root_node_inner(&state, 0).unwrap_err().code,
            "no_session"
        );

        let path = temp_path("ipc-invalid-ranges");
        fs::write(&path, b"[\"Ada\"]").unwrap();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(
            get_children_inner(&state, 0, 0, 0, summary.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_raw_slice_inner(&state, 0, 0, summary.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_decoded_text_inner(&state, 99, 0, 1, summary.session_revision)
                .unwrap_err()
                .code,
            "not_found"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_keep_invalid_rows_and_delimiters_out_of_scope() {
        let path = temp_jsonl_path("ipc-selected-entry-bytes");
        let mut input = b"{\"bad\":".to_vec();
        input.extend_from_slice(b"\r\n");
        input.extend_from_slice(&[0xff, 0xfe]);
        input.extend_from_slice(b"\n{\"after\":1}\r\n");
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let invalid_json = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(invalid_json.entry.status, "invalidJson");
        let json_bytes =
            read_selected_entry_bytes_inner(&state, 0, usize::MAX, invalid_json.session_revision)
                .unwrap();
        assert_eq!(json_bytes.start, 0);
        assert_eq!(json_bytes.bytes, b"{\"bad\":".to_vec());
        assert!(!json_bytes.has_more);
        assert_eq!(json_bytes.next_offset, None);
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            invalid_json.session_revision
        );
        let offset_error = read_selected_entry_bytes_inner(
            &state,
            json_bytes.bytes.len() as u64 + 1,
            1,
            invalid_json.session_revision,
        )
        .unwrap_err();
        assert_eq!(offset_error.code, "invalid_request");
        assert_eq!(offset_error.message, "offset exceeds selected Entry length");

        let invalid_utf8 = select_entry_inner(&state, 1, invalid_json.session_revision).unwrap();
        assert_eq!(invalid_utf8.entry.status, "invalidUtf8");
        let utf8_bytes =
            read_selected_entry_bytes_inner(&state, 0, usize::MAX, invalid_utf8.session_revision)
                .unwrap();
        assert_eq!(utf8_bytes.bytes, vec![0xff, 0xfe]);
        assert!(!utf8_bytes.has_more);

        let valid = select_entry_inner(&state, 2, invalid_utf8.session_revision).unwrap();
        assert_eq!(valid.entry.status, "valid");
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 32, valid.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_page_large_invalid_entry_and_eof() {
        let path = temp_jsonl_path("ipc-selected-entry-large");
        let body = vec![b'x'; 300 * 1024];
        let mut input = body.clone();
        input.extend_from_slice(b"\n{\"after\":true}\n");
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let mut progress = opened.progress.clone().unwrap();
        while !progress.complete {
            progress = scan_entries_inner(&state, opened.session_revision).unwrap();
        }
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "invalidJson");

        let mut offset = 0;
        let mut combined = Vec::new();
        loop {
            let chunk = read_selected_entry_bytes_inner(
                &state,
                offset,
                usize::MAX,
                selected.session_revision,
            )
            .unwrap();
            assert!(chunk.bytes.len() <= 128 * 1024);
            combined.extend_from_slice(&chunk.bytes);
            if !chunk.has_more {
                assert_eq!(chunk.next_offset, None);
                assert_eq!(chunk.start + chunk.bytes.len() as u64, body.len() as u64);
                break;
            }
            let next = chunk.next_offset.expect("next offset for a paged chunk");
            assert!(next > offset);
            offset = next;
        }
        assert_eq!(combined, body);
        assert!(
            serde_json::to_vec(
                &read_selected_entry_bytes_inner(&state, 0, usize::MAX, selected.session_revision,)
                    .unwrap()
            )
            .unwrap()
            .len()
                < MAX_IPC_PAYLOAD_BYTES
        );

        let eof = read_selected_entry_bytes_inner(
            &state,
            body.len() as u64,
            1,
            selected.session_revision,
        )
        .unwrap();
        assert!(eof.bytes.is_empty());
        assert!(!eof.has_more);
        assert_eq!(eof.next_offset, None);
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 0, selected.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_selected_entry_bytes_inner(
                &state,
                body.len() as u64 + 1,
                1,
                selected.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_rejects_unselected_oversized_and_stale_requests_without_bumping() {
        let path = temp_jsonl_path("ipc-selected-entry-errors");
        fs::write(&path, b"{\"ok\":true}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, opened.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, selected.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            selected.session_revision
        );
        fs::write(&path, b"{\"changed\":true}\n").unwrap();
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, selected.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_clears_after_failed_selection_and_caps_worst_case_payload() {
        let path = temp_jsonl_path("ipc-selected-entry-failed-selection");
        fs::write(&path, b"{\"ok\":true}\n{\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "valid");
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, selected.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, opened.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            selected.session_revision
        );
        let after_failed = select_entry_inner(&state, 99, selected.session_revision).unwrap_err();
        assert_eq!(after_failed.code, "invalid_request");
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, selected.session_revision + 1)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();

        let path = temp_jsonl_path("ipc-selected-entry-payload-cap");
        let mut input = vec![0xff; 200 * 1024];
        input.push(b'\n');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "invalidUtf8");
        let chunk =
            read_selected_entry_bytes_inner(&state, 0, usize::MAX, selected.session_revision)
                .unwrap();
        assert_eq!(chunk.bytes.len(), 128 * 1024);
        assert!(chunk.bytes.iter().all(|&byte| byte == 0xff));
        assert!(serde_json::to_vec(&chunk).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_rejects_valid_and_oversized_entries() {
        let valid_path = temp_jsonl_path("ipc-selected-entry-valid");
        fs::write(&valid_path, b"{\"ok\":true}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, valid_path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "valid");
        for offset in [0, u64::MAX] {
            let error = read_selected_entry_bytes_inner(
                &state,
                offset,
                usize::MAX,
                selected.session_revision,
            )
            .unwrap_err();
            assert_eq!(error.code, "invalid_request");
            assert_eq!(error.message, "selected Entry is valid; use read_raw_slice");
        }
        fs::remove_file(valid_path).unwrap();

        let oversized_path = temp_jsonl_path("ipc-selected-entry-oversized");
        let mut input = vec![b'x'; crate::jsonl_entry::MAX_ENTRY_BYTES + 1];
        input.push(b'\n');
        fs::write(&oversized_path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, oversized_path.to_str().unwrap()).unwrap();
        let mut progress = opened.progress.clone().unwrap();
        while !progress.complete {
            progress = scan_entries_inner(&state, opened.session_revision).unwrap();
        }
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "oversized");
        for offset in [0, u64::MAX] {
            let error =
                read_selected_entry_bytes_inner(&state, offset, 1, selected.session_revision)
                    .unwrap_err();
            assert_eq!(error.code, "invalid_request");
            assert_eq!(
                error.message,
                "selected Entry is oversized; use get_oversized_preview"
            );
        }
        fs::remove_file(oversized_path).unwrap();
    }

    #[test]
    fn selected_entry_window_reads_middle_oversized_bytes_without_crossing_entry_bounds() {
        let path = temp_jsonl_path("ipc-selected-entry-window-oversized");
        let body = vec![b'm'; crate::jsonl_entry::MAX_ENTRY_BYTES + 1];
        let mut input = b"before\n".to_vec();
        let body_start = input.len();
        input.extend_from_slice(&body);
        let body_end = input.len();
        input.extend_from_slice(b"\r\nafter\n");
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let mut progress = opened.progress.clone().unwrap();
        while !progress.complete {
            progress = scan_entries_inner(&state, opened.session_revision).unwrap();
        }

        let selected = select_entry_inner(&state, 1, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "oversized");
        assert_eq!(selected.entry.location.byte_start, body_start as u64);
        assert_eq!(selected.entry.location.byte_end, body_end as u64);

        let middle_offset = (body.len() / 2) as u64;
        let middle =
            read_selected_entry_window_inner(&state, middle_offset, 64, selected.session_revision)
                .unwrap();
        assert_eq!(middle.start, middle_offset);
        assert_eq!(middle.bytes, vec![b'm'; 64]);
        assert!(middle.has_more);
        assert_eq!(middle.next_offset, Some(middle_offset + 64));

        let tail_offset = (body.len() - 4) as u64;
        let tail = read_selected_entry_window_inner(
            &state,
            tail_offset,
            usize::MAX,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(tail.start, tail_offset);
        assert_eq!(tail.bytes, vec![b'm'; 4]);
        assert!(!tail.has_more);
        assert_eq!(tail.next_offset, None);

        let eof = read_selected_entry_window_inner(
            &state,
            body.len() as u64,
            1,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(eof.start, body.len() as u64);
        assert!(eof.bytes.is_empty());
        assert!(!eof.has_more);
        assert_eq!(eof.next_offset, None);
        assert_eq!(
            read_selected_entry_window_inner(&state, 0, 0, selected.session_revision)
                .unwrap_err()
                .message,
            "length must be greater than zero"
        );
        assert_eq!(
            read_selected_entry_window_inner(
                &state,
                body.len() as u64 + 1,
                1,
                selected.session_revision,
            )
            .unwrap_err()
            .message,
            "offset exceeds selected Entry length"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_window_reads_valid_invalid_json_and_invalid_utf8_rows() {
        let path = temp_jsonl_path("ipc-selected-entry-window-statuses");
        fs::write(&path, b"{\"ok\":true}\n{\"bad\":\xff}\n{\"broken\":\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let valid = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let valid_chunk =
            read_selected_entry_window_inner(&state, 0, usize::MAX, valid.session_revision)
                .unwrap();
        assert_eq!(valid_chunk.bytes, b"{\"ok\":true}".to_vec());
        assert!(!valid_chunk.has_more);
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, valid.session_revision)
                .unwrap_err()
                .message,
            "selected Entry is valid; use read_raw_slice"
        );

        let invalid_utf8 = select_entry_inner(&state, 1, valid.session_revision).unwrap();
        let utf8_chunk =
            read_selected_entry_window_inner(&state, 0, usize::MAX, invalid_utf8.session_revision)
                .unwrap();
        assert_eq!(
            utf8_chunk.bytes,
            vec![b'{', b'\"', b'b', b'a', b'd', b'\"', b':', 0xff, b'}']
        );
        assert!(!utf8_chunk.has_more);

        let invalid_json = select_entry_inner(&state, 2, invalid_utf8.session_revision).unwrap();
        let json_chunk =
            read_selected_entry_window_inner(&state, 0, usize::MAX, invalid_json.session_revision)
                .unwrap();
        assert_eq!(json_chunk.bytes, b"{\"broken\":".to_vec());
        assert!(!json_chunk.has_more);

        let encoded = String::from_utf8(serde_json::to_vec(&json_chunk).unwrap()).unwrap();
        assert!(encoded.contains("\"hasMore\""));
        assert!(encoded.contains("\"nextOffset\""));
        assert!(!encoded.contains("has_more"));
        assert!(!encoded.contains("next_offset"));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_window_rejects_unselected_wrong_revision_wrong_mode_and_file_changes() {
        let entry_path = temp_jsonl_path("ipc-selected-entry-window-errors");
        fs::write(&entry_path, b"{}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        assert_eq!(
            read_selected_entry_window_inner(&state, 0, 1, opened.session_revision)
                .unwrap_err()
                .message,
            "no entry is selected"
        );

        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(
            read_selected_entry_window_inner(&state, 0, 1, selected.session_revision + 1)
                .unwrap_err()
                .code,
            "stale_session"
        );
        fs::write(&entry_path, b"{\"changed\":true}\n").unwrap();
        assert_eq!(
            read_selected_entry_window_inner(&state, 0, 0, selected.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        assert_eq!(
            read_selected_entry_window_inner(&state, 0, 1, selected.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        fs::remove_file(entry_path).unwrap();

        let document_path = temp_path("ipc-selected-entry-window-document");
        fs::write(&document_path, b"{}").unwrap();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let wrong_mode =
            read_selected_entry_window_inner(&state, 0, 1, document.session_revision).unwrap_err();
        assert_eq!(wrong_mode.code, "invalid_request");
        assert_eq!(wrong_mode.message, "command requires a JSONL session");
        fs::remove_file(document_path).unwrap();

        let capped_path = temp_jsonl_path("ipc-selected-entry-window-payload-cap");
        let mut capped_input = vec![0xff; 300 * 1024];
        capped_input.push(b'\n');
        fs::write(&capped_path, capped_input).unwrap();
        let capped = open_file_inner(&state, capped_path.to_str().unwrap()).unwrap();
        let mut progress = capped.progress.clone().unwrap();
        while !progress.complete {
            progress = scan_entries_inner(&state, capped.session_revision).unwrap();
        }
        let capped_selection = select_entry_inner(&state, 0, capped.session_revision).unwrap();
        let capped_chunk = read_selected_entry_window_inner(
            &state,
            0,
            usize::MAX,
            capped_selection.session_revision,
        )
        .unwrap();
        assert_eq!(capped_chunk.bytes.len(), 128 * 1024);
        assert!(capped_chunk.bytes.iter().all(|&byte| byte == 0xff));
        assert!(capped_chunk.has_more);
        assert_eq!(capped_chunk.next_offset, Some(128 * 1024));
        assert!(serde_json::to_vec(&capped_chunk).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        fs::remove_file(capped_path).unwrap();
    }

    #[test]
    fn invalid_utf8_json_becomes_raw_document_and_jsonl_stays_entry_mode() {
        let old_path = temp_path("ipc-invalid-utf8-old");
        let json_path = temp_path("ipc-invalid-utf8-json");
        let unknown_path = temp_path("ipc-invalid-utf8-unknown").with_extension("blob");
        fs::write(&old_path, b"{\"old\":true}").unwrap();
        fs::write(&json_path, b"{\xff}").unwrap();
        fs::write(&unknown_path, [0xff]).unwrap();
        let state = AppState::default();
        let old = open_file_inner(&state, old_path.to_str().unwrap()).unwrap();

        let json_summary = open_file_inner(&state, json_path.to_str().unwrap()).unwrap();
        assert_eq!(json_summary.mode, "document");
        assert!(json_summary.root.is_none());
        assert_eq!(
            json_summary.document_error.as_ref().unwrap().code,
            "unsupported_encoding"
        );
        assert_eq!(json_summary.session_revision, old.session_revision + 1);

        let unknown_summary =
            open_file_with_override(&state, unknown_path.to_str().unwrap(), Some("json")).unwrap();
        assert_eq!(unknown_summary.mode, "document");
        assert!(unknown_summary.root.is_none());
        assert_eq!(
            unknown_summary.document_error.as_ref().unwrap().code,
            "unsupported_encoding"
        );

        let jsonl_path = temp_jsonl_path("ipc-invalid-utf8-jsonl");
        fs::write(&jsonl_path, b"{\xff}\n{}\n").unwrap();
        let jsonl = open_file_inner(&state, jsonl_path.to_str().unwrap()).unwrap();
        assert_eq!(jsonl.mode, "entry");
        let page = list_entries_inner(&state, 0, 50, jsonl.session_revision).unwrap();
        assert_eq!(page.entries[0].status, "invalidUtf8");

        fs::remove_file(old_path).unwrap();
        fs::remove_file(json_path).unwrap();
        fs::remove_file(unknown_path).unwrap();
        fs::remove_file(jsonl_path).unwrap();
    }

    #[test]
    fn invalid_utf8_json_entry_override_stays_unsupported_and_preserves_session() {
        let old_path = temp_path("ipc-invalid-utf8-override-old");
        let json_path = temp_path("ipc-invalid-utf8-override-json");
        fs::write(&old_path, b"{\"old\":true}").unwrap();
        fs::write(&json_path, b"{\xff}").unwrap();
        let state = AppState::default();
        let old = open_file_inner(&state, old_path.to_str().unwrap()).unwrap();

        let error = open_file_with_override(&state, json_path.to_str().unwrap(), Some("jsonl"))
            .unwrap_err();
        assert_eq!(error.code, "unsupported_encoding");
        assert_eq!(get_file_summary_inner(&state).unwrap(), old);

        fs::remove_file(old_path).unwrap();
        fs::remove_file(json_path).unwrap();
    }

    #[test]
    fn raw_only_invalid_json_summary_and_bounded_file_bytes() {
        let path = temp_path("ipc-raw-only-invalid-json");
        fs::write(&path, b"{").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert!(summary.root.is_none());
        assert!(summary.progress.is_none());
        let error = summary.document_error.as_ref().expect("document error");
        assert_eq!(error.code, "invalid_json");
        let parse = error.parse_error.as_ref().expect("parse error");
        assert_eq!(parse.message, "expected object key");
        assert_eq!(parse.byte_offset, 1);
        assert_eq!(parse.line, 1);
        assert_eq!(parse.column, 2);
        let encoded = String::from_utf8(serde_json::to_vec(&summary).unwrap()).unwrap();
        assert!(encoded.contains("\"documentError\""));
        assert!(encoded.contains("\"parseError\""));
        assert!(!encoded.contains("document_error"));
        assert!(!encoded.contains("parse_error"));

        let first =
            read_raw_document_bytes_inner(&state, 0, usize::MAX, summary.session_revision).unwrap();
        assert_eq!(first.start, 0);
        assert_eq!(first.bytes, b"{");
        assert!(!first.has_more);
        assert_eq!(first.next_offset, None);
        assert_eq!(
            read_raw_document_bytes_inner(&state, 1, 1, summary.session_revision)
                .unwrap()
                .bytes,
            Vec::<u8>::new()
        );
        assert_eq!(
            read_raw_document_bytes_inner(&state, 0, 0, summary.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_raw_document_bytes_inner(&state, 2, 1, summary.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            summary.session_revision
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn raw_only_invalid_utf8_and_unknown_json_override_keep_document_error() {
        let json_path = temp_path("ipc-raw-only-invalid-utf8");
        fs::write(&json_path, [0xff, 0x00]).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, json_path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert!(summary.root.is_none());
        assert_eq!(
            summary.document_error.as_ref().unwrap().code,
            "unsupported_encoding"
        );
        let raw =
            read_raw_document_bytes_inner(&state, 0, usize::MAX, summary.session_revision).unwrap();
        assert_eq!(raw.bytes, vec![0xff, 0x00]);

        let unknown_path = temp_path("ipc-raw-only-unknown").with_extension("blob");
        fs::write(&unknown_path, b"{").unwrap();
        let unknown =
            open_file_with_override(&state, unknown_path.to_str().unwrap(), Some("json")).unwrap();
        assert!(unknown.document_error.is_some());
        assert_eq!(unknown.mode, "document");
        assert_eq!(unknown.session_revision, summary.session_revision + 1);
        fs::remove_file(json_path).unwrap();
        fs::remove_file(unknown_path).unwrap();
    }

    #[test]
    fn raw_document_command_rejects_parsed_sessions_and_has_camel_case_payload() {
        let document_path = temp_path("ipc-raw-only-parsed-document");
        fs::write(&document_path, b"{}").unwrap();
        let state = AppState::default();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let error =
            read_raw_document_bytes_inner(&state, 0, 1, document.session_revision).unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert_eq!(
            error.message,
            "command requires a raw-only document session"
        );
        fs::remove_file(document_path).unwrap();

        let dto = ByteChunkDto {
            start: 0,
            bytes: vec![0xff; 128 * 1024],
            has_more: true,
            next_offset: Some(128 * 1024),
        };
        let encoded = String::from_utf8(serde_json::to_vec(&dto).unwrap()).unwrap();
        assert!(encoded.contains("hasMore"));
        assert!(encoded.contains("nextOffset"));
        assert!(!encoded.contains("has_more"));
        assert!(!encoded.contains("next_offset"));
        assert!(encoded.len() < MAX_IPC_PAYLOAD_BYTES);
    }

    #[test]
    fn raw_document_bytes_are_capped_and_file_relative_across_chunks() {
        let path = temp_path("ipc-raw-only-multichunk");
        let input = vec![0xff; 300 * 1024];
        fs::write(&path, &input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert!(summary.document_error.is_some());

        let first =
            read_raw_document_bytes_inner(&state, 0, usize::MAX, summary.session_revision).unwrap();
        assert_eq!(first.start, 0);
        assert_eq!(first.bytes.len(), 128 * 1024);
        assert!(first.bytes.iter().all(|&byte| byte == 0xff));
        assert!(first.has_more);
        assert_eq!(first.next_offset, Some(128 * 1024));

        let second = read_raw_document_bytes_inner(
            &state,
            first.next_offset.unwrap(),
            usize::MAX,
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(second.start, 128 * 1024);
        assert_eq!(second.bytes.len(), 128 * 1024);
        assert!(second.has_more);
        assert_eq!(second.next_offset, Some(256 * 1024));

        let tail = read_raw_document_bytes_inner(
            &state,
            second.next_offset.unwrap(),
            usize::MAX,
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(tail.start, 256 * 1024);
        assert_eq!(tail.bytes.len(), 44 * 1024);
        assert!(!tail.has_more);
        assert_eq!(tail.next_offset, None);
        assert_eq!(get_file_summary_inner(&state).unwrap().session_revision, 1);

        let eof = read_raw_document_bytes_inner(&state, input.len() as u64, 1, 1).unwrap();
        assert_eq!(eof.start, input.len() as u64);
        assert!(eof.bytes.is_empty());
        assert!(!eof.has_more);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn raw_document_wrong_sessions_and_stale_revision_are_rejected() {
        let raw_path = temp_path("ipc-raw-only-stale");
        let entry_path = temp_jsonl_path("ipc-raw-only-entry");
        let document_path = temp_path("ipc-raw-only-document");
        fs::write(&raw_path, [0xff]).unwrap();
        fs::write(&entry_path, b"{}\n").unwrap();
        fs::write(&document_path, b"{}").unwrap();
        let state = AppState::default();

        let raw = open_file_inner(&state, raw_path.to_str().unwrap()).unwrap();
        let entry = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        let entry_error =
            read_raw_document_bytes_inner(&state, 0, 1, entry.session_revision).unwrap_err();
        assert_eq!(entry_error.code, "invalid_request");
        assert_eq!(
            entry_error.message,
            "command requires a raw-only document session"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            entry.session_revision
        );

        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let stale = read_raw_document_bytes_inner(&state, 0, 1, raw.session_revision).unwrap_err();
        assert_eq!(stale.code, "stale_session");
        assert_eq!(document.session_revision, raw.session_revision + 2);

        fs::remove_file(raw_path).unwrap();
        fs::remove_file(entry_path).unwrap();
        fs::remove_file(document_path).unwrap();
    }

    #[test]
    fn raw_document_operations_reject_tree_and_entry_commands() {
        let path = temp_path("ipc-raw-only-command-rejections");
        fs::write(&path, b"{").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let revision = summary.session_revision;

        let root_error = get_root_node_inner(&state, revision).unwrap_err();
        assert_eq!(root_error.code, "invalid_request");
        assert_eq!(
            root_error.message,
            "command is unavailable for a raw-only document session"
        );
        assert_eq!(
            get_node_summary_inner(&state, 0, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            get_children_inner(&state, 0, 0, 1, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_raw_slice_inner(&state, 0, 1, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_decoded_text_inner(&state, 0, 0, 1, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            read_selected_entry_bytes_inner(&state, 0, 1, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            scan_entries_inner(&state, revision).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            list_entries_inner(&state, 0, 1, revision).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            select_entry_inner(&state, 0, revision).unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(
            get_oversized_preview_inner(&state, 0, revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            revision
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn raw_document_identity_changes_are_reported_without_revision_bump() {
        let path = temp_path("ipc-raw-only-file-change");
        fs::write(&path, [0xff]).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        fs::write(&path, [0xff, 0xfe]).unwrap();

        assert_eq!(
            get_file_summary_inner(&state).unwrap_err().code,
            "file_changed"
        );
        assert_eq!(
            read_raw_document_bytes_inner(&state, 0, 1, summary.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap_err().code,
            "file_changed"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_document_command_is_invalid_without_revision_change() {
        let path = temp_path("ipc-selected-entry-document");
        fs::write(&path, b"{\"ok\":true}").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let error =
            read_selected_entry_bytes_inner(&state, 0, 1, summary.session_revision).unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            summary.session_revision
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selected_entry_bytes_dto_uses_camel_case_fields() {
        let dto = ByteChunkDto {
            start: 3,
            bytes: vec![0xff, 0],
            has_more: true,
            next_offset: Some(5),
        };
        let encoded = String::from_utf8(serde_json::to_vec(&dto).unwrap()).unwrap();
        assert!(encoded.contains("\"hasMore\""));
        assert!(encoded.contains("\"nextOffset\""));
        assert!(!encoded.contains("has_more"));
        assert!(!encoded.contains("next_offset"));
    }

    #[test]
    fn stale_revision_is_rejected_after_reopening() {
        let first = temp_path("ipc-stale-first");
        let second = temp_path("ipc-stale-second");
        fs::write(&first, b"{\"first\":1}").unwrap();
        fs::write(&second, b"{\"second\":2}").unwrap();
        let state = AppState::default();

        let first_summary = open_file_inner(&state, first.to_str().unwrap()).unwrap();
        let second_summary = open_file_inner(&state, second.to_str().unwrap()).unwrap();
        assert_eq!(
            second_summary.session_revision,
            first_summary.session_revision + 1
        );
        assert_eq!(
            get_root_node_inner(&state, first_summary.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );

        fs::remove_file(first).unwrap();
        fs::remove_file(second).unwrap();
    }

    #[test]
    fn failed_open_keeps_previous_session_and_revision() {
        let first = temp_path("ipc-open-first");
        let invalid = temp_path("ipc-open-invalid").with_extension("jsonc");
        let missing = temp_path("ipc-open-missing");
        fs::write(&first, b"{\"name\":\"Ada\"}").unwrap();
        fs::write(&invalid, b"{").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, first.to_str().unwrap()).unwrap();

        assert_eq!(
            open_file_inner(&state, invalid.to_str().unwrap())
                .unwrap_err()
                .code,
            "unsupported_format"
        );
        assert_eq!(get_file_summary_inner(&state).unwrap(), summary);
        assert_eq!(
            open_file_inner(&state, missing.to_str().unwrap())
                .unwrap_err()
                .code,
            "open_failed"
        );
        assert_eq!(get_file_summary_inner(&state).unwrap(), summary);
        assert_eq!(
            get_root_node_inner(&state, summary.session_revision).unwrap(),
            summary.root.clone().unwrap()
        );
        assert_eq!(
            read_raw_slice_inner(&state, 8, 5, summary.session_revision)
                .unwrap()
                .text,
            r#""Ada""#
        );

        fs::remove_file(first).unwrap();
        fs::remove_file(invalid).unwrap();
    }

    #[test]
    fn file_changes_report_file_changed_without_clearing_session() {
        let path = temp_path("ipc-file-changed");
        fs::write(&path, b"{\"name\":\"Ada\"}").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        fs::write(&path, b"{}").unwrap();
        assert_eq!(
            get_file_summary_inner(&state).unwrap_err().code,
            "file_changed"
        );
        assert_eq!(
            get_root_node_inner(&state, summary.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        assert_eq!(
            read_raw_slice_inner(&state, 0, 1, summary.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn same_size_rewrite_reports_file_changed() {
        let path = temp_path("ipc-file-rewrite");
        let first = b"{\"name\":\"Ada\"}";
        let second = b"{\"name\":\"Bob\"}";
        assert_eq!(first.len(), second.len());
        fs::write(&path, first).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let before = fs::metadata(&path).unwrap().modified().unwrap();

        let mut changed = false;
        for _ in 0..100 {
            fs::write(&path, second).unwrap();
            if fs::metadata(&path).unwrap().modified().unwrap() != before {
                changed = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            changed,
            "filesystem did not expose modified timestamp change"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap_err().code,
            "file_changed"
        );
        assert_eq!(
            get_root_node_inner(&state, summary.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn string_detection_returns_only_content_metadata_for_documents_collections_and_entries() {
        let document_path = temp_path("ipc-string-detection-document");
        fs::write(
            &document_path,
            r##"{"source":"foo();","markdown":"# title","nested":"{\"x\":1}","html":"<p>ok</p>","plain":"hello","invalid":"{bad"}"##,
        )
        .unwrap();
        let state = AppState::default();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let root = document.root.as_ref().unwrap().id;
        let children =
            get_children_inner(&state, root, 0, usize::MAX, document.session_revision).unwrap();
        let by_label = |label: &str| {
            children
                .nodes
                .iter()
                .find(|node| node.label == label)
                .unwrap()
                .id
        };

        let source =
            get_string_detection_inner(&state, by_label("source"), document.session_revision)
                .unwrap();
        assert_eq!(source.semantic_type, SemanticTypeDto::Code);
        assert_eq!(source.detection_source, DetectionSourceDto::ContentDetected);
        assert_eq!(source.plain_reason, None);
        assert_eq!(
            get_string_detection_inner(&state, by_label("markdown"), document.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::Markdown
        );
        assert_eq!(
            get_string_detection_inner(&state, by_label("nested"), document.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::NestedJson
        );
        assert_eq!(
            get_string_detection_inner(&state, by_label("html"), document.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::Html
        );
        assert_eq!(
            get_string_detection_inner(&state, by_label("plain"), document.session_revision)
                .unwrap()
                .plain_reason,
            Some(PlainReasonDto::Fallback)
        );
        assert_eq!(
            get_string_detection_inner(&state, by_label("invalid"), document.session_revision)
                .unwrap()
                .plain_reason,
            Some(PlainReasonDto::JsonParseFailed)
        );

        let collection_path = temp_path("ipc-string-detection-collection");
        fs::write(&collection_path, br#"["foo();"]"#).unwrap();
        let collection = open_file_inner(&state, collection_path.to_str().unwrap()).unwrap();
        let collection_root = collection.root.as_ref().unwrap().id;
        let array_string =
            get_children_inner(&state, collection_root, 0, 1, collection.session_revision)
                .unwrap()
                .nodes[0]
                .id;
        assert_eq!(
            get_string_detection_inner(&state, array_string, collection.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::PlainText
        );

        let entry_path = temp_jsonl_path("ipc-string-detection-entry");
        fs::write(&entry_path, br#"{"source":"foo();"}"#).unwrap();
        let entry = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, entry.session_revision).unwrap();
        let selected_root = selected.root.as_ref().unwrap().id;
        let selected_child =
            get_children_inner(&state, selected_root, 0, 1, selected.session_revision)
                .unwrap()
                .nodes[0]
                .id;
        let selected_detection =
            get_string_detection_inner(&state, selected_child, selected.session_revision).unwrap();
        assert_eq!(selected_detection.semantic_type, SemanticTypeDto::Code);
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            selected.session_revision
        );

        for path in [document_path, collection_path, entry_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn string_detection_uses_actual_object_keys_and_preserves_metadata_wire_shape() {
        let path = temp_path("ipc-string-detection-keys");
        fs::write(&path, br#"{"source":"foo();","source":"foo();"}"#).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = summary.root.as_ref().unwrap().id;
        let children = get_children_inner(&state, root, 0, 10, summary.session_revision)
            .unwrap()
            .nodes;
        assert_eq!(children[0].label, "source");
        assert_eq!(children[1].label, "source#2");
        for node in children {
            assert_eq!(
                get_string_detection_inner(&state, node.id, summary.session_revision)
                    .unwrap()
                    .semantic_type,
                SemanticTypeDto::Code
            );
        }

        let encoded = serde_json::to_vec(
            &get_string_detection_inner(&state, 1, summary.session_revision).unwrap(),
        )
        .unwrap();
        assert!(encoded.len() < MAX_IPC_PAYLOAD_BYTES);
        let encoded = String::from_utf8(encoded).unwrap();
        assert!(encoded.contains("semanticType"));
        assert!(encoded.contains("plainReason"));
        assert!(encoded.contains("contentDetected"));
        assert!(encoded.contains("code"));
        assert!(!encoded.contains("decoded"));
        assert!(!encoded.contains("rawLexeme"));
        assert!(!encoded.contains("nextBudget"));
        assert!(!encoded.contains("source"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn string_detection_dto_serializes_every_wire_enum_and_null_plain_reason() {
        let semantic_types = [
            (SemanticTypeDto::PlainText, "plainText"),
            (SemanticTypeDto::Markdown, "markdown"),
            (SemanticTypeDto::NestedJson, "nestedJson"),
            (SemanticTypeDto::Code, "code"),
            (SemanticTypeDto::Html, "html"),
        ];
        for (semantic_type, wire_value) in semantic_types {
            let dto = StringDetectionDto {
                semantic_type,
                detection_source: DetectionSourceDto::ContentDetected,
                plain_reason: None,
            };
            let encoded = serde_json::to_value(dto).unwrap();
            assert_eq!(encoded["semanticType"], wire_value);
            assert_eq!(encoded["detectionSource"], "contentDetected");
            assert_eq!(encoded["plainReason"], serde_json::Value::Null);
            assert_eq!(encoded.as_object().unwrap().len(), 3);
        }

        let plain_reasons = [
            (PlainReasonDto::Fallback, "fallback"),
            (PlainReasonDto::JsonParseFailed, "jsonParseFailed"),
            (PlainReasonDto::SizeLimit, "sizeLimit"),
            (PlainReasonDto::DepthLimit, "depthLimit"),
            (PlainReasonDto::CumulativeLimit, "cumulativeLimit"),
        ];
        for (plain_reason, wire_value) in plain_reasons {
            let dto = StringDetectionDto {
                semantic_type: SemanticTypeDto::PlainText,
                detection_source: DetectionSourceDto::ContentDetected,
                plain_reason: Some(plain_reason),
            };
            assert_eq!(
                serde_json::to_value(dto).unwrap()["plainReason"],
                wire_value
            );
        }
    }

    #[test]
    fn string_detection_enforces_two_mib_boundary_without_bumping_revision() {
        let exact_inner = format!(r#"{{"x":"{}"}}"#, "x".repeat(2 * 1024 * 1024 - 8));
        assert_eq!(exact_inner.len(), 2 * 1024 * 1024);
        let exact_value = serde_json::to_string(&exact_inner).unwrap();
        let exact_path = temp_path("ipc-string-detection-exact");
        fs::write(&exact_path, format!(r#"{{"value":{exact_value}}}"#)).unwrap();

        let over_inner = format!("{exact_inner}x");
        let over_value = serde_json::to_string(&over_inner).unwrap();
        let over_path = temp_path("ipc-string-detection-over");
        fs::write(&over_path, format!(r#"{{"value":{over_value}}}"#)).unwrap();

        let state = AppState::default();
        let exact = open_file_inner(&state, exact_path.to_str().unwrap()).unwrap();
        let exact_node = get_children_inner(
            &state,
            exact.root.as_ref().unwrap().id,
            0,
            1,
            exact.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;
        assert_eq!(
            get_string_detection_inner(&state, exact_node, exact.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::NestedJson
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            exact.session_revision
        );

        let over = open_file_inner(&state, over_path.to_str().unwrap()).unwrap();
        let over_node = get_children_inner(
            &state,
            over.root.as_ref().unwrap().id,
            0,
            1,
            over.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;
        let detection =
            get_string_detection_inner(&state, over_node, over.session_revision).unwrap();
        assert_eq!(detection.semantic_type, SemanticTypeDto::PlainText);
        assert_eq!(detection.plain_reason, Some(PlainReasonDto::SizeLimit));
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            over.session_revision
        );

        fs::remove_file(exact_path).unwrap();
        fs::remove_file(over_path).unwrap();
    }

    #[test]
    fn string_detection_reports_all_session_and_node_errors_without_mutation() {
        let no_session = AppState::default();
        assert_eq!(
            get_string_detection_inner(&no_session, 0, 0)
                .unwrap_err()
                .code,
            "no_session"
        );

        let document_path = temp_path("ipc-string-detection-errors-document");
        fs::write(&document_path, br#"{"value":"hello","number":1}"#).unwrap();
        let state = AppState::default();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let root = document.root.as_ref().unwrap().id;
        let children = get_children_inner(&state, root, 0, 10, document.session_revision)
            .unwrap()
            .nodes;
        let string_id = children[0].id;
        let number_id = children[1].id;
        assert_eq!(
            get_string_detection_inner(&state, 999, document.session_revision)
                .unwrap_err()
                .message,
            "node 999 was not found"
        );
        assert_eq!(
            get_string_detection_inner(&state, number_id, document.session_revision)
                .unwrap_err()
                .message,
            "node does not contain decoded text"
        );
        assert_eq!(
            get_string_detection_inner(&state, string_id, document.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::PlainText
        );

        let entry_path = temp_jsonl_path("ipc-string-detection-errors-entry");
        fs::write(&entry_path, br#"{"value":"hello"}"#).unwrap();
        let entry = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        assert_eq!(
            get_string_detection_inner(&state, 0, entry.session_revision)
                .unwrap_err()
                .message,
            "no valid entry is selected"
        );
        let selected = select_entry_inner(&state, 0, entry.session_revision).unwrap();
        let selected_value = get_children_inner(
            &state,
            selected.root.as_ref().unwrap().id,
            0,
            1,
            selected.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;
        assert_eq!(
            get_string_detection_inner(&state, selected_value, selected.session_revision)
                .unwrap()
                .semantic_type,
            SemanticTypeDto::PlainText
        );

        let raw_path = temp_path("ipc-string-detection-errors-raw");
        fs::write(&raw_path, b"{").unwrap();
        let raw = open_file_inner(&state, raw_path.to_str().unwrap()).unwrap();
        assert_eq!(
            get_string_detection_inner(&state, 0, raw.session_revision)
                .unwrap_err()
                .message,
            "command is unavailable for a raw-only document session"
        );
        assert_eq!(
            get_string_detection_inner(&state, 0, document.session_revision)
                .unwrap_err()
                .code,
            "stale_session"
        );

        let changed_path = temp_path("ipc-string-detection-errors-changed");
        fs::write(&changed_path, br#"{"value":"hello"}"#).unwrap();
        let changed = open_file_inner(&state, changed_path.to_str().unwrap()).unwrap();
        let before = fs::metadata(&changed_path).unwrap().modified().unwrap();
        let mut timestamp_changed = false;
        for _ in 0..100 {
            fs::write(&changed_path, br#"{"value":"world"}"#).unwrap();
            if fs::metadata(&changed_path).unwrap().modified().unwrap() != before {
                timestamp_changed = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            timestamp_changed,
            "filesystem did not expose modified timestamp change"
        );
        assert_eq!(
            get_string_detection_inner(&state, 1, changed.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );
        let next_path = temp_path("ipc-string-detection-errors-next");
        fs::write(&next_path, br#"{"value":"next"}"#).unwrap();
        let next = open_file_inner(&state, next_path.to_str().unwrap()).unwrap();
        assert_eq!(next.session_revision, changed.session_revision + 1);

        for path in [document_path, entry_path, raw_path, changed_path, next_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn string_metrics_ipc_covers_document_nested_entry_and_file_guards() {
        let path = temp_path("ipc-string-metrics-document");
        let input =
            r#"{"empty":"","unicode":"你😀é","escaped":"\ud83d\ude00","lines":"a\r\nb\rc\n"}"#;
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let document = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = document.root.as_ref().unwrap().id;
        let children = get_children_inner(&state, root, 0, 10, document.session_revision)
            .unwrap()
            .nodes;
        let metric_for = |label: &str| {
            children
                .iter()
                .find(|node| node.label == label)
                .map(|node| node.id)
                .unwrap()
        };
        let expected = [
            ("empty", 0, 0, 1),
            ("unicode", 10, 4, 1),
            ("escaped", 4, 1, 1),
            ("lines", 7, 7, 4),
        ];
        for (label, decoded_bytes, character_count, line_count) in expected {
            let metrics =
                get_string_metrics_inner(&state, metric_for(label), document.session_revision)
                    .unwrap();
            assert_eq!(
                metrics,
                StringMetricsDto {
                    decoded_bytes,
                    character_count,
                    line_count,
                },
                "{label}"
            );
            let payload = serde_json::to_value(metrics).unwrap();
            assert_eq!(payload["decodedBytes"], decoded_bytes);
            assert_eq!(payload["characterCount"], character_count);
            assert_eq!(payload["lineCount"], line_count);
            assert!(payload.get("decoded_bytes").is_none());
        }
        assert_eq!(
            get_string_metrics_inner(&state, root, document.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            get_string_metrics_inner(&state, 999, document.session_revision)
                .unwrap_err()
                .code,
            "invalid_request"
        );

        let large_path = temp_path("ipc-string-metrics-large");
        let large = "a".repeat(200_000);
        fs::write(
            &large_path,
            format!(r#"{{"large":{}}}"#, serde_json::to_string(&large).unwrap()),
        )
        .unwrap();
        let large_state = AppState::default();
        let large_summary = open_file_inner(&large_state, large_path.to_str().unwrap()).unwrap();
        let large_node = child_id(
            &large_state,
            None,
            large_summary.root.as_ref().unwrap().id,
            "large",
            large_summary.session_revision,
        );
        let large_metrics =
            get_string_metrics_inner(&large_state, large_node, large_summary.session_revision)
                .unwrap();
        assert_eq!(large_metrics.decoded_bytes, 200_000);
        assert_eq!(large_metrics.character_count, 200_000);
        assert_eq!(large_metrics.line_count, 1);
        assert!(serde_json::to_vec(&large_metrics).unwrap().len() < 128);

        let nested_path = temp_path("ipc-string-metrics-nested");
        fs::write(&nested_path, r#"{"payload":"{\"inner\":\"你😀\"}"}"#).unwrap();
        let nested_state = AppState::default();
        let nested_summary = open_file_inner(&nested_state, nested_path.to_str().unwrap()).unwrap();
        let payload_node = child_id(
            &nested_state,
            None,
            nested_summary.root.as_ref().unwrap().id,
            "payload",
            nested_summary.session_revision,
        );
        let scope = open_nested_json_inner(
            &nested_state,
            None,
            payload_node,
            None,
            nested_summary.session_revision,
        )
        .unwrap();
        let inner_node = get_children_scoped_inner(
            &nested_state,
            scope.root.id,
            0,
            1,
            Some(scope.scope_id),
            nested_summary.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;
        assert_eq!(
            get_string_metrics_scoped_inner(
                &nested_state,
                inner_node,
                Some(scope.scope_id),
                nested_summary.session_revision,
            )
            .unwrap(),
            StringMetricsDto {
                decoded_bytes: 7,
                character_count: 2,
                line_count: 1,
            }
        );

        let entry_path = temp_jsonl_path("ipc-string-metrics-entry");
        fs::write(&entry_path, "{\"value\":\"你😀\"}\n{\"value\":\"later\"}\n").unwrap();
        let entry_state = AppState::default();
        let entry = open_file_inner(&entry_state, entry_path.to_str().unwrap()).unwrap();
        assert_eq!(
            get_string_metrics_inner(&entry_state, 0, entry.session_revision)
                .unwrap_err()
                .message,
            "no valid entry is selected"
        );
        let selected = select_entry_inner(&entry_state, 0, entry.session_revision).unwrap();
        let value_node = child_id(
            &entry_state,
            None,
            selected.root.as_ref().unwrap().id,
            "value",
            selected.session_revision,
        );
        assert_eq!(
            get_string_metrics_inner(&entry_state, value_node, selected.session_revision)
                .unwrap()
                .character_count,
            2
        );
        assert_eq!(
            get_string_metrics_inner(&entry_state, value_node, selected.session_revision - 1)
                .unwrap_err()
                .code,
            "stale_session"
        );

        let raw_path = temp_path("ipc-string-metrics-raw");
        fs::write(&raw_path, b"{").unwrap();
        let raw = open_file_inner(&entry_state, raw_path.to_str().unwrap()).unwrap();
        assert_eq!(
            get_string_metrics_inner(&entry_state, 0, raw.session_revision)
                .unwrap_err()
                .message,
            "command is unavailable for a raw-only document session"
        );

        let changed_path = temp_path("ipc-string-metrics-changed");
        fs::write(&changed_path, r#"{"value":"before"}"#).unwrap();
        let changed_state = AppState::default();
        let changed = open_file_inner(&changed_state, changed_path.to_str().unwrap()).unwrap();
        let before = fs::metadata(&changed_path).unwrap().modified().unwrap();
        let mut timestamp_changed = false;
        for _ in 0..100 {
            fs::write(&changed_path, r#"{"value":"after"}"#).unwrap();
            if fs::metadata(&changed_path).unwrap().modified().unwrap() != before {
                timestamp_changed = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            timestamp_changed,
            "filesystem did not expose modified timestamp change"
        );
        assert_eq!(
            get_string_metrics_inner(&changed_state, 1, changed.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );

        for path in [
            path,
            large_path,
            nested_path,
            entry_path,
            raw_path,
            changed_path,
        ] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn string_detection_payload_never_contains_source_sentinel() {
        let path = temp_path("ipc-string-detection-sentinel");
        let sentinel = "STRING_DETECTION_SENTINEL_SHOULD_NOT_ESCAPE";
        fs::write(&path, format!(r#"{{"source":"{sentinel}"}}"#)).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let child = get_children_inner(
            &state,
            summary.root.as_ref().unwrap().id,
            0,
            1,
            summary.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;
        let payload = serde_json::to_vec(
            &get_string_detection_inner(&state, child, summary.session_revision).unwrap(),
        )
        .unwrap();
        assert!(payload.len() < MAX_IPC_PAYLOAD_BYTES);
        assert!(!payload
            .windows(sentinel.len())
            .any(|window| window == sentinel.as_bytes()));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_json_scope_opens_from_decoded_string() {
        let path = temp_path("ipc-nested-json-scope");
        fs::write(&path, br#"{"payload":"{\"answer\":42}"}"#).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let source_node = get_children_inner(
            &state,
            summary.root.as_ref().unwrap().id,
            0,
            1,
            summary.session_revision,
        )
        .unwrap()
        .nodes[0]
            .id;

        let scope =
            open_nested_json_inner(&state, None, source_node, None, summary.session_revision)
                .unwrap();
        assert_eq!(scope.parent_scope_id, None);
        assert_eq!(scope.source_node_id, source_node);
        assert_eq!(scope.depth, 1);
        assert_eq!(scope.max_depth, 5);
        assert_eq!(scope.parsed_bytes, br#"{"answer":42}"#.len());
        assert_eq!(scope.cumulative_bytes, scope.parsed_bytes);
        assert_eq!(scope.root.kind, "object");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_scope_dto_uses_contract_field_names() {
        let dto = NestedScopeDto {
            scope_id: 7,
            parent_scope_id: Some(3),
            source_node_id: 11,
            root: NodeDto {
                id: 0,
                kind: "object".to_owned(),
                span_start: 2,
                span_end: 14,
                label: "$".to_owned(),
                label_has_more: false,
                value_preview: None,
                value_has_more: false,
                child_count: 1,
            },
            depth: 2,
            max_depth: 5,
            parsed_bytes: 12,
            cumulative_bytes: 24,
            session_revision: 9,
        };
        let value = serde_json::to_value(dto).unwrap();
        assert_eq!(value["scopeId"], 7);
        assert_eq!(value["parentScopeId"], 3);
        assert_eq!(value["sourceNodeId"], 11);
        assert_eq!(value["parsedBytes"], 12);
        assert_eq!(value["cumulativeBytes"], 24);
        assert_eq!(value["sessionRevision"], 9);
        assert!(value.get("scope_id").is_none());
    }

    #[test]
    fn nested_scopes_preserve_whitespace_spans_raw_lexemes_and_nested_routes() {
        let path = temp_path("ipc-nested-json-routes");
        let object = " \n{\"answer\":42,\"text\":\"line\\n\",\"inner\":\"[1,2]\"}\t";
        let array = "[true,{\"value\":null}]";
        let input = format!(
            "{{\"object\":{},\"array\":{}}}",
            serde_json::to_string(object).unwrap(),
            serde_json::to_string(array).unwrap()
        );
        fs::write(&path, &input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = summary.root.as_ref().unwrap().id;
        let object_id = child_id(&state, None, root, "object", summary.session_revision);
        let array_id = child_id(&state, None, root, "array", summary.session_revision);

        let object_scope =
            open_nested_json_inner(&state, None, object_id, None, summary.session_revision)
                .unwrap();
        assert_eq!(object_scope.depth, 1);
        assert_eq!(object_scope.max_depth, 5);
        assert_eq!(object_scope.parsed_bytes, object.len());
        assert_eq!(object_scope.cumulative_bytes, object.len());
        assert_eq!(object_scope.root.span_start, 2);
        assert_eq!(object_scope.root.span_end, object.len() - 1);

        let raw = read_raw_slice_scoped_inner(
            &state,
            object_scope.root.span_start,
            object_scope.root.span_end - object_scope.root.span_start,
            Some(object_scope.scope_id),
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(
            raw.text,
            object[object_scope.root.span_start..object_scope.root.span_end]
        );

        let text_id = child_id(
            &state,
            Some(object_scope.scope_id),
            object_scope.root.id,
            "text",
            summary.session_revision,
        );
        let text_node = get_node_summary_scoped_inner(
            &state,
            text_id,
            Some(object_scope.scope_id),
            summary.session_revision,
        )
        .unwrap();
        let nested_raw = read_raw_slice_scoped_inner(
            &state,
            text_node.span_start,
            text_node.span_end - text_node.span_start,
            Some(object_scope.scope_id),
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(nested_raw.text, "\"line\\n\"");
        let decoded = read_decoded_text_scoped_inner(
            &state,
            text_id,
            0,
            usize::MAX,
            Some(object_scope.scope_id),
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(decoded.text, "line\n");

        let base_raw = read_raw_slice_inner(
            &state,
            summary.root.as_ref().unwrap().span_start,
            summary.root.as_ref().unwrap().span_end,
            summary.session_revision,
        )
        .unwrap();
        assert_ne!(base_raw.text, object);
        assert!(base_raw.text.contains("\\\"answer\\\""));
        let base_decoded =
            read_decoded_text_inner(&state, object_id, 0, usize::MAX, summary.session_revision)
                .unwrap();
        assert_eq!(base_decoded.text, object);

        let inner_id = child_id(
            &state,
            Some(object_scope.scope_id),
            object_scope.root.id,
            "inner",
            summary.session_revision,
        );
        let inner_scope = open_nested_json_inner(
            &state,
            Some(object_scope.scope_id),
            inner_id,
            None,
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(inner_scope.parent_scope_id, Some(object_scope.scope_id));
        assert_eq!(inner_scope.depth, 2);
        assert_eq!(inner_scope.root.kind, "array");
        assert_eq!(inner_scope.root.span_start, 0);
        assert_eq!(inner_scope.root.span_end, 5);

        let array_scope =
            open_nested_json_inner(&state, None, array_id, Some(10), summary.session_revision)
                .unwrap();
        assert_eq!(array_scope.parent_scope_id, None);
        assert_eq!(array_scope.max_depth, 10);
        assert_eq!(array_scope.root.kind, "array");
        assert!(get_root_node_scoped_inner(
            &state,
            Some(object_scope.scope_id),
            summary.session_revision
        )
        .is_err());

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_scope_rejects_non_json_inputs_and_keeps_previous_chain_atomically() {
        let path = temp_path("ipc-nested-json-errors");
        let valid = r#"{"ok":true}"#;
        let invalid = " \n{\"a\":1,}\t";
        let primitive = " true ";
        let input = format!(
            "{{\"valid\":{},\"invalid\":{},\"primitive\":{}}}",
            serde_json::to_string(valid).unwrap(),
            serde_json::to_string(invalid).unwrap(),
            serde_json::to_string(primitive).unwrap()
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = summary.root.as_ref().unwrap().id;
        let valid_id = child_id(&state, None, root, "valid", summary.session_revision);
        let invalid_id = child_id(&state, None, root, "invalid", summary.session_revision);
        let primitive_id = child_id(&state, None, root, "primitive", summary.session_revision);
        let scope =
            open_nested_json_inner(&state, None, valid_id, None, summary.session_revision).unwrap();
        let next_id_before = state.session.lock().unwrap().nested.next_scope_id;

        for (node_id, message) in [
            (invalid_id, "node is not parseable nested JSON"),
            (primitive_id, "node is not parseable nested JSON"),
        ] {
            let error =
                open_nested_json_inner(&state, None, node_id, None, summary.session_revision)
                    .unwrap_err();
            assert_eq!(error.message, message);
            assert!(get_root_node_scoped_inner(
                &state,
                Some(scope.scope_id),
                summary.session_revision
            )
            .is_ok());
        }
        assert_eq!(
            state.session.lock().unwrap().nested.next_scope_id,
            next_id_before
        );

        for (max_depth, message) in [
            (Some(0), "maxDepth must be between 1 and 10"),
            (Some(11), "maxDepth must be between 1 and 10"),
        ] {
            let error =
                open_nested_json_inner(&state, None, valid_id, max_depth, summary.session_revision)
                    .unwrap_err();
            assert_eq!(error.message, message);
        }
        let error = open_nested_json_inner(
            &state,
            Some(scope.scope_id),
            valid_id,
            Some(5),
            summary.session_revision,
        )
        .unwrap_err();
        assert_eq!(
            error.message,
            "maxDepth is only valid for a root nested scope"
        );
        let error =
            open_nested_json_inner(&state, Some(999), valid_id, None, summary.session_revision)
                .unwrap_err();
        assert_eq!(error.message, "nested scope 999 was not found");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_scope_pages_two_hundred_children_with_bounded_payload() {
        let path = temp_path("ipc-nested-json-page-200");
        let mut nested = String::from("{");
        for index in 0..200 {
            if index > 0 {
                nested.push(',');
            }
            nested.push_str(&format!(r#""k{index}":{index}"#));
        }
        nested.push('}');
        let input = format!(r#"{{"value":{}}}"#, serde_json::to_string(&nested).unwrap());
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value_id = child_id(
            &state,
            None,
            summary.root.as_ref().unwrap().id,
            "value",
            summary.session_revision,
        );
        let scope =
            open_nested_json_inner(&state, None, value_id, None, summary.session_revision).unwrap();
        let page = get_children_scoped_inner(
            &state,
            scope.root.id,
            0,
            usize::MAX,
            Some(scope.scope_id),
            summary.session_revision,
        )
        .unwrap();
        assert_eq!(page.nodes.len(), 200);
        assert!(!page.has_more);
        assert!(page
            .nodes
            .iter()
            .all(|node| node.span_end <= scope.parsed_bytes));
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_scope_enforces_exact_layer_and_cumulative_limits() {
        let exact_path = temp_path("ipc-nested-json-exact-layer");
        let exact = sized_nested_object(MAX_INPUT_BYTES, b'x');
        fs::write(
            &exact_path,
            format!(r#"{{"value":{}}}"#, serde_json::to_string(&exact).unwrap()),
        )
        .unwrap();
        let exact_state = AppState::default();
        let exact_summary = open_file_inner(&exact_state, exact_path.to_str().unwrap()).unwrap();
        let exact_id = child_id(
            &exact_state,
            None,
            exact_summary.root.as_ref().unwrap().id,
            "value",
            exact_summary.session_revision,
        );
        let exact_scope = open_nested_json_inner(
            &exact_state,
            None,
            exact_id,
            None,
            exact_summary.session_revision,
        )
        .unwrap();
        assert_eq!(exact_scope.parsed_bytes, MAX_INPUT_BYTES);

        let over_path = temp_path("ipc-nested-json-over-layer");
        let over = sized_nested_object(MAX_INPUT_BYTES + 1, b'x');
        fs::write(
            &over_path,
            format!(r#"{{"value":{}}}"#, serde_json::to_string(&over).unwrap()),
        )
        .unwrap();
        let over_state = AppState::default();
        let over_summary = open_file_inner(&over_state, over_path.to_str().unwrap()).unwrap();
        let over_id = child_id(
            &over_state,
            None,
            over_summary.root.as_ref().unwrap().id,
            "value",
            over_summary.session_revision,
        );
        let error = open_nested_json_inner(
            &over_state,
            None,
            over_id,
            None,
            over_summary.session_revision,
        )
        .unwrap_err();
        assert_eq!(error.message, "nested JSON exceeds the 2 MiB layer limit");

        let (cumulative_exact, exact_layer_sizes) =
            wrap_nested_chain(format!(r#"{{"payload":"{}"}}"#, "y".repeat(1_677_652)), 5);
        assert!(exact_layer_sizes
            .iter()
            .all(|size| *size <= MAX_INPUT_BYTES));
        assert_eq!(
            exact_layer_sizes.iter().sum::<usize>(),
            MAX_CUMULATIVE_BYTES
        );
        let cumulative_exact_path = temp_path("ipc-nested-json-cumulative-exact");
        fs::write(
            &cumulative_exact_path,
            format!(
                r#"{{"value":{}}}"#,
                serde_json::to_string(&cumulative_exact).unwrap()
            ),
        )
        .unwrap();
        let cumulative_exact_state = AppState::default();
        let cumulative_exact_summary = open_file_inner(
            &cumulative_exact_state,
            cumulative_exact_path.to_str().unwrap(),
        )
        .unwrap();
        let mut source_id = child_id(
            &cumulative_exact_state,
            None,
            cumulative_exact_summary.root.as_ref().unwrap().id,
            "value",
            cumulative_exact_summary.session_revision,
        );
        let mut scope = open_nested_json_inner(
            &cumulative_exact_state,
            None,
            source_id,
            Some(10),
            cumulative_exact_summary.session_revision,
        )
        .unwrap();
        for _ in 1..exact_layer_sizes.len() {
            source_id = child_id(
                &cumulative_exact_state,
                Some(scope.scope_id),
                scope.root.id,
                "next",
                cumulative_exact_summary.session_revision,
            );
            scope = open_nested_json_inner(
                &cumulative_exact_state,
                Some(scope.scope_id),
                source_id,
                None,
                cumulative_exact_summary.session_revision,
            )
            .unwrap();
        }
        assert_eq!(scope.cumulative_bytes, MAX_CUMULATIVE_BYTES);

        let (cumulative_over, over_layer_sizes) =
            wrap_nested_chain(format!(r#"{{"payload":"{}"}}"#, "y".repeat(1_677_653)), 5);
        assert!(over_layer_sizes.iter().all(|size| *size <= MAX_INPUT_BYTES));
        assert!(over_layer_sizes.iter().sum::<usize>() > MAX_CUMULATIVE_BYTES);
        let cumulative_over_path = temp_path("ipc-nested-json-cumulative-over");
        fs::write(
            &cumulative_over_path,
            format!(
                r#"{{"value":{}}}"#,
                serde_json::to_string(&cumulative_over).unwrap()
            ),
        )
        .unwrap();
        let cumulative_over_state = AppState::default();
        let cumulative_over_summary = open_file_inner(
            &cumulative_over_state,
            cumulative_over_path.to_str().unwrap(),
        )
        .unwrap();
        let mut source_id = child_id(
            &cumulative_over_state,
            None,
            cumulative_over_summary.root.as_ref().unwrap().id,
            "value",
            cumulative_over_summary.session_revision,
        );
        let mut scope = open_nested_json_inner(
            &cumulative_over_state,
            None,
            source_id,
            Some(10),
            cumulative_over_summary.session_revision,
        )
        .unwrap();
        let mut cumulative_error = None;
        for _ in 1..over_layer_sizes.len() {
            source_id = child_id(
                &cumulative_over_state,
                Some(scope.scope_id),
                scope.root.id,
                "next",
                cumulative_over_summary.session_revision,
            );
            match open_nested_json_inner(
                &cumulative_over_state,
                Some(scope.scope_id),
                source_id,
                None,
                cumulative_over_summary.session_revision,
            ) {
                Ok(next) => scope = next,
                Err(error) => {
                    cumulative_error = Some(error);
                    break;
                }
            }
        }
        assert_eq!(
            cumulative_error.unwrap().message,
            "nested JSON exceeds the 8 MiB cumulative limit"
        );

        for path in [
            exact_path,
            over_path,
            cumulative_exact_path,
            cumulative_over_path,
        ] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn nested_scope_depth_budget_detection_and_lifecycle_are_revision_safe() {
        let path = temp_path("ipc-nested-json-depth");
        let chain = nested_chain(6);
        let input = format!(r#"{{"value":{}}}"#, serde_json::to_string(&chain).unwrap());
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value_id = child_id(
            &state,
            None,
            summary.root.as_ref().unwrap().id,
            "value",
            summary.session_revision,
        );
        let mut scope =
            open_nested_json_inner(&state, None, value_id, None, summary.session_revision).unwrap();
        for expected_depth in 2..=5 {
            let next_id = child_id(
                &state,
                Some(scope.scope_id),
                scope.root.id,
                "next",
                summary.session_revision,
            );
            scope = open_nested_json_inner(
                &state,
                Some(scope.scope_id),
                next_id,
                None,
                summary.session_revision,
            )
            .unwrap();
            assert_eq!(scope.depth, expected_depth);
        }
        let next_id = child_id(
            &state,
            Some(scope.scope_id),
            scope.root.id,
            "next",
            summary.session_revision,
        );
        let error = open_nested_json_inner(
            &state,
            Some(scope.scope_id),
            next_id,
            None,
            summary.session_revision,
        )
        .unwrap_err();
        assert_eq!(error.message, "nested JSON depth limit reached");
        assert_eq!(
            get_string_detection_scoped_inner(
                &state,
                next_id,
                Some(scope.scope_id),
                summary.session_revision
            )
            .unwrap()
            .plain_reason,
            Some(PlainReasonDto::DepthLimit)
        );

        let root_scope_id = scope.scope_id;
        assert_eq!(
            close_nested_scope_inner(&state, root_scope_id, summary.session_revision),
            Ok(())
        );
        assert_eq!(
            get_root_node_scoped_inner(&state, Some(root_scope_id), summary.session_revision)
                .unwrap_err()
                .message,
            format!("nested scope {root_scope_id} was not found")
        );
        assert_eq!(
            close_nested_scope_inner(&state, root_scope_id, summary.session_revision)
                .unwrap_err()
                .message,
            format!("nested scope {root_scope_id} was not found")
        );
        let reopened =
            open_nested_json_inner(&state, None, value_id, Some(10), summary.session_revision)
                .unwrap();
        assert!(reopened.scope_id > root_scope_id);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn nested_scope_clears_on_entry_switch_and_rejects_raw_only_sessions() {
        let entry_path = temp_jsonl_path("ipc-nested-json-entry");
        fs::write(
            &entry_path,
            b"{\"value\":\"{\\\"entry\\\":1}\"}\n{\"value\":\"{\\\"entry\\\":2}\"}\n",
        )
        .unwrap();
        let state = AppState::default();
        let entry = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, entry.session_revision).unwrap();
        let value_id = child_id(
            &state,
            None,
            selected.root.as_ref().unwrap().id,
            "value",
            selected.session_revision,
        );
        let scope = open_nested_json_inner(&state, None, value_id, None, selected.session_revision)
            .unwrap();
        let next_selection = select_entry_inner(&state, 1, selected.session_revision).unwrap();
        assert!(next_selection.session_revision > selected.session_revision);
        assert_eq!(
            get_root_node_scoped_inner(
                &state,
                Some(scope.scope_id),
                next_selection.session_revision,
            )
            .unwrap_err()
            .code,
            "not_found"
        );

        let raw_path = temp_path("ipc-nested-json-raw-only");
        fs::write(&raw_path, b"{").unwrap();
        let raw = open_file_inner(&state, raw_path.to_str().unwrap()).unwrap();
        let error =
            open_nested_json_inner(&state, None, 0, None, raw.session_revision).unwrap_err();
        assert_eq!(
            error.message,
            "command is unavailable for a raw-only document session"
        );

        let collection_path = temp_path("ipc-nested-json-collection");
        fs::write(
            &collection_path,
            format!(r#"[{}]"#, serde_json::to_string(r#"{"x":1}"#).unwrap()),
        )
        .unwrap();
        let collection = open_file_inner(&state, collection_path.to_str().unwrap()).unwrap();
        assert_eq!(collection.mode, "collection");
        let collection_value = child_id(
            &state,
            None,
            collection.root.as_ref().unwrap().id,
            "[0]",
            collection.session_revision,
        );
        let collection_scope = open_nested_json_inner(
            &state,
            None,
            collection_value,
            None,
            collection.session_revision,
        )
        .unwrap();
        assert_eq!(collection_scope.root.kind, "object");

        for path in [entry_path, raw_path, collection_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn nested_scope_branch_replacement_and_file_identity_are_atomic() {
        let path = temp_path("ipc-nested-json-branch");
        let first = r#"{"a":"{\"left\":1}","b":"{\"right\":2}"}"#;
        fs::write(&path, first).unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = summary.root.as_ref().unwrap().id;
        let a_id = child_id(&state, None, root, "a", summary.session_revision);
        let b_id = child_id(&state, None, root, "b", summary.session_revision);
        let a_scope =
            open_nested_json_inner(&state, None, a_id, None, summary.session_revision).unwrap();
        let a_scope_id = a_scope.scope_id;
        let a_leaf = child_id(
            &state,
            Some(a_scope_id),
            a_scope.root.id,
            "left",
            summary.session_revision,
        );
        assert_eq!(
            get_node_summary_scoped_inner(
                &state,
                a_leaf,
                Some(a_scope_id),
                summary.session_revision,
            )
            .unwrap()
            .kind,
            "number"
        );

        let b_scope = open_nested_json_inner(
            &state,
            Some(a_scope_id),
            b_id,
            None,
            summary.session_revision,
        )
        .unwrap_err();
        assert_eq!(b_scope.message, "node 2 was not found");

        let b_scope =
            open_nested_json_inner(&state, None, b_id, None, summary.session_revision).unwrap();
        assert!(b_scope.scope_id > a_scope_id);
        assert_eq!(
            get_root_node_scoped_inner(&state, Some(a_scope_id), summary.session_revision)
                .unwrap_err()
                .message,
            format!("nested scope {a_scope_id} was not found")
        );

        let before_error =
            get_root_node_scoped_inner(&state, Some(b_scope.scope_id), summary.session_revision)
                .unwrap();
        let before_revision = summary.session_revision;
        let before_id = b_scope.scope_id;
        let rewritten = r#"{"a":"{\"left\":1}","b":"{\"right\":3}"}"#;
        let before_modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut changed = false;
        for _ in 0..100 {
            fs::write(&path, rewritten).unwrap();
            if fs::metadata(&path).unwrap().modified().unwrap() != before_modified {
                changed = true;
                break;
            }
            std::thread::yield_now();
        }
        assert!(
            changed,
            "filesystem did not expose modified timestamp change"
        );
        let error =
            get_root_node_scoped_inner(&state, Some(before_id), before_revision).unwrap_err();
        assert_eq!(error.code, "file_changed");
        assert_eq!(error.message, "the file changed on disk");
        assert_eq!(before_error.kind, "object");

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn html_preview_document_collection_and_wire_contract() {
        let document_path = temp_path("ipc-html-preview-document");
        fs::write(
            &document_path,
            br#"{"html":"<div onclick='bad'><strong>ok</strong></div>","number":1}"#,
        )
        .unwrap();
        let state = AppState::default();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let root = document.root.as_ref().unwrap().id;
        let html_node = child_id(&state, None, root, "html", document.session_revision);
        let preview =
            get_html_preview_inner(&state, html_node, None, document.session_revision).unwrap();
        assert_eq!(
            preview.html.as_deref(),
            Some("<div><strong>ok</strong></div>")
        );
        assert_eq!(preview.reason, None);
        let encoded = serde_json::to_value(&preview).unwrap();
        assert_eq!(encoded.as_object().unwrap().len(), 2);
        assert_eq!(encoded["html"], "<div><strong>ok</strong></div>");
        assert_eq!(encoded["reason"], serde_json::Value::Null);

        let number_node = child_id(&state, None, root, "number", document.session_revision);
        let error = get_html_preview_inner(&state, number_node, None, document.session_revision)
            .unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert_eq!(
            get_html_preview_inner(&state, html_node, None, document.session_revision + 1)
                .unwrap_err()
                .code,
            "stale_session"
        );

        let collection_path = temp_path("ipc-html-preview-collection");
        fs::write(&collection_path, br#"[{"html":"<p>item</p>"}]"#).unwrap();
        let collection = open_file_inner(&state, collection_path.to_str().unwrap()).unwrap();
        let item = child_id(
            &state,
            None,
            collection.root.as_ref().unwrap().id,
            "[0]",
            collection.session_revision,
        );
        let item_html = child_id(&state, None, item, "html", collection.session_revision);
        let item_preview =
            get_html_preview_inner(&state, item_html, None, collection.session_revision).unwrap();
        assert_eq!(item_preview.html.as_deref(), Some("<p>item</p>"));

        for path in [document_path, collection_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn html_preview_entry_nested_raw_and_file_change_contract() {
        let entry_path = temp_jsonl_path("ipc-html-preview-entry");
        fs::write(&entry_path, br#"{"html":"<p>entry</p>"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, entry_path.to_str().unwrap()).unwrap();
        let error = get_html_preview_inner(&state, 1, None, opened.session_revision).unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert_eq!(error.message, "no valid entry is selected");
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let selected_root = selected.root.as_ref().unwrap().id;
        let html_node = child_id(
            &state,
            None,
            selected_root,
            "html",
            selected.session_revision,
        );
        let preview =
            get_html_preview_inner(&state, html_node, None, selected.session_revision).unwrap();
        assert_eq!(preview.html.as_deref(), Some("<p>entry</p>"));

        let nested_path = temp_path("ipc-html-preview-nested");
        fs::write(
            &nested_path,
            br#"{"nested":"{\"html\":\"<p>nested</p>\",\"count\":1}"}"#,
        )
        .unwrap();
        let nested_state = AppState::default();
        let nested_document =
            open_file_inner(&nested_state, nested_path.to_str().unwrap()).unwrap();
        let nested_root = nested_document.root.as_ref().unwrap().id;
        let nested_source = child_id(
            &nested_state,
            None,
            nested_root,
            "nested",
            nested_document.session_revision,
        );
        let scope = open_nested_json_inner(
            &nested_state,
            None,
            nested_source,
            None,
            nested_document.session_revision,
        )
        .unwrap();
        let nested_html = child_id(
            &nested_state,
            Some(scope.scope_id),
            scope.root.id,
            "html",
            nested_document.session_revision,
        );
        let nested_preview = get_html_preview_inner(
            &nested_state,
            nested_html,
            Some(scope.scope_id),
            nested_document.session_revision,
        )
        .unwrap();
        assert_eq!(nested_preview.html.as_deref(), Some("<p>nested</p>"));
        assert_eq!(
            get_html_preview_inner(
                &nested_state,
                nested_html,
                Some(scope.scope_id),
                nested_document.session_revision + 1,
            )
            .unwrap_err()
            .code,
            "stale_session"
        );

        let raw_path = temp_path("ipc-html-preview-raw");
        fs::write(&raw_path, b"{\"html\":").unwrap();
        let raw_state = AppState::default();
        let raw = open_file_inner(&raw_state, raw_path.to_str().unwrap()).unwrap();
        assert!(raw.document_error.is_some());
        let error = get_html_preview_inner(&raw_state, 0, None, raw.session_revision).unwrap_err();
        assert_eq!(error.code, "invalid_request");

        let changed_path = temp_path("ipc-html-preview-file-change");
        fs::write(&changed_path, br#"{"html":"<p>before</p>"}"#).unwrap();
        let changed_state = AppState::default();
        let changed = open_file_inner(&changed_state, changed_path.to_str().unwrap()).unwrap();
        let changed_node = child_id(
            &changed_state,
            None,
            changed.root.as_ref().unwrap().id,
            "html",
            changed.session_revision,
        );
        fs::write(
            &changed_path,
            br#"{"html":"<p>after-with-a-different-size</p>"}"#,
        )
        .unwrap();
        assert_eq!(
            get_html_preview_inner(&changed_state, changed_node, None, changed.session_revision)
                .unwrap_err()
                .code,
            "file_changed"
        );

        for path in [entry_path, nested_path, raw_path, changed_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn html_preview_limit_reasons_and_missing_node_use_wire_contract() {
        let exact_path = temp_path("ipc-html-preview-exact");
        let exact_html = format!(
            "<p>{}</p>",
            "x".repeat(crate::html_sanitizer::MAX_INPUT_BYTES - 7)
        );
        assert_eq!(exact_html.len(), crate::html_sanitizer::MAX_INPUT_BYTES);
        fs::write(
            &exact_path,
            format!(
                r#"{{"html":{}}}"#,
                serde_json::to_string(&exact_html).unwrap()
            ),
        )
        .unwrap();
        let state = AppState::default();
        let exact = open_file_inner(&state, exact_path.to_str().unwrap()).unwrap();
        let exact_node = child_id(
            &state,
            None,
            exact.root.as_ref().unwrap().id,
            "html",
            exact.session_revision,
        );
        let exact_preview =
            get_html_preview_inner(&state, exact_node, None, exact.session_revision).unwrap();
        assert!(exact_preview.html.is_some());
        assert_eq!(exact_preview.reason, None);
        assert!(serde_json::to_vec(&exact_preview).unwrap().len() < MAX_IPC_PAYLOAD_BYTES);
        assert_eq!(
            get_html_preview_inner(&state, usize::MAX, None, exact.session_revision)
                .unwrap_err()
                .code,
            "not_found"
        );
        assert_eq!(
            get_file_summary_inner(&state).unwrap().session_revision,
            exact.session_revision
        );

        let over_path = temp_path("ipc-html-preview-size-limit");
        let over_html = format!(
            "<p>{}</p>",
            "x".repeat(crate::html_sanitizer::MAX_INPUT_BYTES - 6)
        );
        assert_eq!(over_html.len(), crate::html_sanitizer::MAX_INPUT_BYTES + 1);
        fs::write(
            &over_path,
            format!(
                r#"{{"html":{}}}"#,
                serde_json::to_string(&over_html).unwrap()
            ),
        )
        .unwrap();
        let over = open_file_inner(&state, over_path.to_str().unwrap()).unwrap();
        let over_node = child_id(
            &state,
            None,
            over.root.as_ref().unwrap().id,
            "html",
            over.session_revision,
        );
        let over_preview =
            get_html_preview_inner(&state, over_node, None, over.session_revision).unwrap();
        assert_eq!(over_preview.html, None);
        assert_eq!(over_preview.reason, Some(HtmlPreviewReasonDto::SizeLimit));
        let over_wire = serde_json::to_value(&over_preview).unwrap();
        assert_eq!(over_wire.as_object().unwrap().len(), 2);
        assert_eq!(over_wire["html"], serde_json::Value::Null);
        assert_eq!(over_wire["reason"], "sizeLimit");

        let render_path = temp_path("ipc-html-preview-render-limit");
        let render_html = format!("<p>{}</p>", ">".repeat(270_000));
        fs::write(
            &render_path,
            format!(
                r#"{{"html":{}}}"#,
                serde_json::to_string(&render_html).unwrap()
            ),
        )
        .unwrap();
        let render = open_file_inner(&state, render_path.to_str().unwrap()).unwrap();
        let render_node = child_id(
            &state,
            None,
            render.root.as_ref().unwrap().id,
            "html",
            render.session_revision,
        );
        let render_preview =
            get_html_preview_inner(&state, render_node, None, render.session_revision).unwrap();
        assert_eq!(render_preview.html, None);
        assert_eq!(
            render_preview.reason,
            Some(HtmlPreviewReasonDto::RenderLimit)
        );
        let render_wire = serde_json::to_value(&render_preview).unwrap();
        assert_eq!(render_wire.as_object().unwrap().len(), 2);
        assert_eq!(render_wire["html"], serde_json::Value::Null);
        assert_eq!(render_wire["reason"], "renderLimit");

        for path in [exact_path, over_path, render_path] {
            fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn search_current_routes_document_and_collection_with_tagged_wire_cursor() {
        let document_path = temp_path("ipc-search-document");
        fs::write(&document_path, br#"{"first":"hello","second":"hello"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();

        let first = search_current_inner(
            &state,
            "hello".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            1,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].field, SearchFieldDto::Value);
        assert_eq!(first.matches[0].node_id, Some(1));
        assert_eq!(first.matches[0].path_segments, ["$", "first"]);
        assert!(first.has_more);
        let cursor = first.next_cursor.clone().unwrap();
        assert_eq!(
            serde_json::to_value(&cursor).unwrap(),
            serde_json::json!({
                "kind": "decoded",
                "nodeId": 2,
                "field": "key",
                "byteOffset": 0,
                "query": "hello",
                "sessionRevision": 1,
                "scopeId": null,
                "targetNodeId": null
            })
        );
        let second = search_current_inner(
            &state,
            "hello".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            Some(cursor),
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].node_id, Some(2));
        assert!(!second.has_more);
        assert_eq!(second.next_cursor, None);
        assert_eq!(get_file_summary_inner(&state).unwrap().session_revision, 1);

        let mut wrong_query = first.next_cursor.clone().unwrap();
        let SearchCursorDto::Decoded { query, .. } = &mut wrong_query else {
            panic!("expected decoded cursor");
        };
        *query = "other".to_owned();
        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                Some(wrong_query),
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        let mut wrong_revision = first.next_cursor.clone().unwrap();
        let SearchCursorDto::Decoded {
            session_revision, ..
        } = &mut wrong_revision
        else {
            panic!("expected decoded cursor");
        };
        *session_revision += 1;
        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                Some(wrong_revision),
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                Some(1),
                Some(first.next_cursor.clone().unwrap()),
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        let raw = search_current_inner(
            &state,
            r#"\u0068"#.to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            opened.session_revision,
        )
        .unwrap();
        assert!(raw.matches.is_empty());

        let collection_path = temp_path("ipc-search-collection");
        fs::write(
            &collection_path,
            br#"[{"value":"hello"},{"value":"hello"}]"#,
        )
        .unwrap();
        let collection = open_file_inner(&state, collection_path.to_str().unwrap()).unwrap();
        assert_eq!(collection.mode, "collection");
        let collection_page = search_current_inner(
            &state,
            "hello".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            50,
            collection.session_revision,
        )
        .unwrap();
        assert_eq!(collection_page.matches.len(), 2);
        assert!(collection_page
            .matches
            .iter()
            .all(|item| item.path_segments.len() == 3));
        let collection_raw = search_current_inner(
            &state,
            r#""hello""#.to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            collection.session_revision,
        )
        .unwrap();
        assert_eq!(collection_raw.matches.len(), 2);
        assert!(collection_raw
            .matches
            .iter()
            .all(|item| item.field == SearchFieldDto::RawSource));
        let raw_first = search_current_inner(
            &state,
            r#""hello""#.to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            1,
            collection.session_revision,
        )
        .unwrap();
        let raw_cursor = raw_first.next_cursor.clone().unwrap();
        let mut wrong_raw_query = raw_cursor.clone();
        let SearchCursorDto::RawSource { query, .. } = &mut wrong_raw_query else {
            panic!("expected raw cursor");
        };
        *query = "other".to_owned();
        let mut wrong_raw_revision = raw_cursor.clone();
        let SearchCursorDto::RawSource {
            session_revision, ..
        } = &mut wrong_raw_revision
        else {
            panic!("expected raw cursor");
        };
        *session_revision += 1;
        let mut wrong_raw_scope = raw_cursor.clone();
        let SearchCursorDto::RawSource { scope_id, .. } = &mut wrong_raw_scope else {
            panic!("expected raw cursor");
        };
        *scope_id = Some(77);
        let mut wrong_raw_target = raw_cursor.clone();
        let SearchCursorDto::RawSource { target_node_id, .. } = &mut wrong_raw_target else {
            panic!("expected raw cursor");
        };
        *target_node_id = Some(1);
        for cursor in [
            wrong_raw_query,
            wrong_raw_revision,
            wrong_raw_scope,
            wrong_raw_target,
        ] {
            assert_eq!(
                search_current_inner(
                    &state,
                    r#""hello""#.to_owned(),
                    SearchRepresentationDto::RawSource,
                    None,
                    None,
                    Some(cursor),
                    50,
                    collection.session_revision,
                )
                .unwrap_err()
                .code,
                "invalid_request"
            );
        }

        let wire = serde_json::to_value(&collection_page).unwrap();
        assert_eq!(
            wire.as_object().unwrap().keys().collect::<Vec<_>>(),
            vec!["hasMore", "matches", "nextCursor"]
        );
        assert!(
            serde_json::from_value::<SearchCursorDto>(serde_json::json!({
                "kind": "decoded",
                "nodeId": 1,
                "field": "value",
                "byteOffset": 0,
                "query": "hello",
                "sessionRevision": 1,
                "scopeId": null,
                "targetNodeId": null,
                "extra": true
            }))
            .is_err()
        );

        fs::remove_file(document_path).unwrap();
        fs::remove_file(collection_path).unwrap();
    }

    #[test]
    fn search_current_routes_selected_valid_entry_and_rejects_old_revision() {
        let path = temp_jsonl_path("ipc-search-entry");
        fs::write(&path, b"{\"value\":\"hello\"}\n{\"value\":\"bye\"}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();

        let decoded = search_current_inner(
            &state,
            "hello".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(decoded.matches.len(), 1);
        assert_eq!(decoded.matches[0].source_span_start, 9);
        assert_eq!(decoded.matches[0].source_span_end, 16);

        let raw = search_current_inner(
            &state,
            r#""hello""#.to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(raw.matches.len(), 1);
        assert_eq!(raw.matches[0].field, SearchFieldDto::RawSource);
        assert_eq!(raw.matches[0].source_span_start, 9);
        assert_eq!(raw.matches[0].source_span_end, 16);

        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                None,
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "stale_session"
        );

        let second = select_entry_inner(&state, 1, selected.session_revision).unwrap();
        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                None,
                50,
                second.session_revision,
            )
            .unwrap()
            .matches
            .len(),
            0
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_routes_nested_scope_without_fallback_or_revision_bump() {
        let path = temp_path("ipc-search-nested");
        fs::write(&path, br#"{"payload":"{\"inner\":\"hello\"}"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let payload = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "payload",
            opened.session_revision,
        );
        let scope =
            open_nested_json_inner(&state, None, payload, None, opened.session_revision).unwrap();

        let decoded = search_current_inner(
            &state,
            "hello".to_owned(),
            SearchRepresentationDto::Decoded,
            Some(scope.scope_id),
            None,
            None,
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(decoded.matches.len(), 1);
        assert_eq!(decoded.matches[0].path_segments, ["$", "inner"]);
        assert_eq!(decoded.matches[0].source_span_start, 9);
        assert_eq!(decoded.matches[0].source_span_end, 16);

        let raw = search_current_inner(
            &state,
            r#""hello""#.to_owned(),
            SearchRepresentationDto::RawSource,
            Some(scope.scope_id),
            None,
            None,
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(raw.matches.len(), 1);
        assert_eq!(raw.matches[0].source_span_start, 9);
        assert_eq!(raw.matches[0].source_span_end, 16);

        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                Some(scope.scope_id),
                None,
                Some(SearchCursorDto::Decoded {
                    node_id: 1,
                    field: SearchFieldDto::Value,
                    byte_offset: 0,
                    query: "hello".to_owned(),
                    session_revision: opened.session_revision,
                    scope_id: None,
                    target_node_id: None,
                }),
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        assert_eq!(
            search_current_inner(
                &state,
                "hello".to_owned(),
                SearchRepresentationDto::Decoded,
                Some(scope.scope_id + 100),
                None,
                None,
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "not_found"
        );
        assert_eq!(get_file_summary_inner(&state).unwrap().session_revision, 1);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_scans_raw_document_windows_and_rejects_decoded() {
        let path = temp_path("ipc-search-raw-document");
        let boundary = 256 * 1024;
        let mut bytes = vec![b'x'; boundary - 2];
        bytes.extend_from_slice(b"needle");
        bytes.extend_from_slice(b"x trailing");
        fs::write(&path, &bytes).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert!(opened.document_error.is_some());

        let page = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].node_id, None);
        assert_eq!(page.matches[0].field, SearchFieldDto::RawSource);
        assert_eq!(page.matches[0].path_segments, ["$"]);
        assert_eq!(page.matches[0].source_span_start, boundary - 2);
        assert_eq!(page.matches[0].source_span_end, boundary + 4);
        assert!(!page.has_more);

        let error = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            50,
            opened.session_revision,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");
        assert!(error.message.contains("raw-only"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_scans_invalid_utf8_entry_only_inside_entry_range() {
        let path = temp_jsonl_path("ipc-search-invalid-utf8-entry");
        fs::write(&path, b"\xffneedle\n{\"other\":\"needle\"}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "invalidUtf8");

        let page = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].match_start, 1);
        assert_eq!(page.matches[0].match_end, 7);
        assert_eq!(page.matches[0].source_span_start, 1);
        assert_eq!(page.matches[0].source_span_end, 7);
        assert!(!page.has_more);

        let error = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            50,
            selected.session_revision,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid_request");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_scans_oversized_entry_with_bounded_windows() {
        let path = temp_jsonl_path("ipc-search-oversized-entry");
        let boundary = 256 * 1024;
        let mut entry = vec![b'x'; crate::jsonl_entry::MAX_ENTRY_BYTES + 1];
        entry[boundary - 2..boundary + 4].copy_from_slice(b"needle");
        let mut file = entry;
        file.push(b'\n');
        file.extend_from_slice(b"{\"other\":\"needle\"}\n");
        fs::write(&path, file).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        while !get_file_summary_inner(&state)
            .unwrap()
            .progress
            .as_ref()
            .unwrap()
            .complete
        {
            scan_entries_inner(&state, opened.session_revision).unwrap();
        }
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.entry.status, "oversized");

        let page = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            None,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].match_start, boundary - 2);
        assert_eq!(page.matches[0].source_span_start, boundary - 2);
        assert_eq!(page.matches[0].source_span_end, boundary + 4);
        assert!(page.has_more);
        let tail = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            page.next_cursor,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert!(tail.matches.is_empty());
        assert!(tail.has_more);
        let end = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            None,
            tail.next_cursor,
            50,
            selected.session_revision,
        )
        .unwrap();
        assert!(end.matches.is_empty());
        assert!(!end.has_more);

        assert_eq!(
            search_current_inner(
                &state,
                "needle".to_owned(),
                SearchRepresentationDto::RawSource,
                None,
                None,
                None,
                0,
                selected.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_raw_windows_stops_at_eight_mib_and_resumes_without_losing_matches() {
        let query = "needle";
        let mut source = vec![b'x'; MAX_SCAN_BYTES];
        source.extend_from_slice(query.as_bytes());
        let mut position = 0u64;
        let request = SearchRequest::raw(query, None, 50);
        let first = search_raw_windows(
            source.len(),
            query,
            None,
            50,
            &request,
            7,
            None,
            |offset, length| {
                assert_eq!(offset, position);
                let end = (offset as usize + length).min(source.len());
                let bytes = source[offset as usize..end].to_vec();
                position = end as u64;
                Ok(ReadChunk {
                    start: offset,
                    has_more: end < source.len(),
                    next_offset: (end < source.len()).then_some(end as u64),
                    bytes,
                })
            },
        )
        .unwrap();
        assert!(first.matches.is_empty());
        assert!(first.has_more);
        let cursor = first.next_cursor.unwrap();
        let SearchCursorDto::RawSource {
            byte_offset,
            query: cursor_query,
            session_revision,
            scope_id,
            target_node_id,
        } = cursor
        else {
            panic!("expected raw cursor");
        };
        assert!(byte_offset > 0);
        assert_eq!(cursor_query, query);
        assert_eq!(session_revision, 7);
        assert_eq!(scope_id, None);
        assert_eq!(target_node_id, None);

        let next_request = SearchRequest::raw(
            query,
            Some(crate::search::SearchCursor {
                mode: SearchMode::Raw,
                query: query.to_owned(),
                node_id: None,
                unit: 0,
                phase: SearchPhase::Value,
                offset: byte_offset,
            }),
            50,
        );
        let second = search_raw_windows(
            source.len(),
            query,
            Some(byte_offset),
            50,
            &next_request,
            7,
            None,
            |offset, length| {
                let end = (offset + length as u64).min(source.len() as u64) as usize;
                Ok(ReadChunk {
                    start: offset,
                    bytes: source[offset as usize..end].to_vec(),
                    has_more: end < source.len(),
                    next_offset: (end < source.len()).then_some(end as u64),
                })
            },
        )
        .unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].match_start, MAX_SCAN_BYTES);
        assert!(!second.has_more);
    }

    #[test]
    fn search_current_rejects_unselected_targets_and_malformed_cursor_routes() {
        let path = temp_jsonl_path("ipc-search-unselected");
        fs::write(&path, b"{\"value\":\"needle\"}\n").unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        for representation in [
            SearchRepresentationDto::Decoded,
            SearchRepresentationDto::RawSource,
        ] {
            assert_eq!(
                search_current_inner(
                    &state,
                    "needle".to_owned(),
                    representation,
                    None,
                    None,
                    None,
                    50,
                    opened.session_revision,
                )
                .unwrap_err()
                .code,
                "invalid_request"
            );
        }

        let document_path = temp_path("ipc-search-target-errors");
        fs::write(&document_path, br#"{"number":1,"text":"needle"}"#).unwrap();
        let document = open_file_inner(&state, document_path.to_str().unwrap()).unwrap();
        let scalar_target = search_current_inner(
            &state,
            "1".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(1),
            None,
            50,
            document.session_revision,
        )
        .unwrap();
        assert_eq!(scalar_target.matches.len(), 1);
        assert_eq!(scalar_target.matches[0].node_id, Some(1));
        assert_eq!(scalar_target.matches[0].field, SearchFieldDto::Value);
        assert_eq!(
            search_current_inner(
                &state,
                "needle".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                Some(99),
                None,
                50,
                document.session_revision,
            )
            .unwrap_err()
            .code,
            "not_found"
        );

        let first = search_current_inner(
            &state,
            "e".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            1,
            document.session_revision,
        )
        .unwrap();
        let cursor = first.next_cursor.unwrap();
        assert_eq!(
            search_current_inner(
                &state,
                "e".to_owned(),
                SearchRepresentationDto::RawSource,
                None,
                None,
                Some(cursor.clone()),
                50,
                document.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );
        assert_eq!(
            search_current_inner(
                &state,
                "e".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                Some(1),
                Some(cursor),
                50,
                document.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );
        assert_eq!(
            search_current_inner(
                &state,
                "needle".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                Some(SearchCursorDto::Decoded {
                    node_id: 0,
                    field: SearchFieldDto::Key,
                    byte_offset: 0,
                    query: "needle".to_owned(),
                    session_revision: document.session_revision,
                    scope_id: None,
                    target_node_id: None,
                }),
                50,
                document.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        fs::remove_file(path).unwrap();
        fs::remove_file(document_path).unwrap();
    }

    #[test]
    fn search_current_round_trips_container_target_cursor_without_sibling_leaks() {
        let path = temp_path("ipc-search-container-target");
        fs::write(
            &path,
            br#"[{"first":"needle","second":"needle"},{"sibling":"needle"}]"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let first = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(1),
            None,
            1,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].node_id, Some(2));
        assert_eq!(first.matches[0].path_segments, ["$", "[0]", "first"]);
        let cursor = first.next_cursor.clone().unwrap();
        let wire = serde_json::to_value(&cursor).unwrap();
        assert_eq!(wire["targetNodeId"], 1);
        assert_eq!(wire["nodeId"], 3);

        let second = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(1),
            Some(cursor),
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(
            second
                .matches
                .iter()
                .map(|item| item.node_id)
                .collect::<Vec<_>>(),
            vec![Some(3)]
        );
        assert_eq!(second.matches[0].path_segments, ["$", "[0]", "second"]);
        assert!(!second.has_more);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_accepts_a_container_value_cursor_on_the_next_page() {
        let path = temp_path("ipc-search-container-value-cursor");
        fs::write(
            &path,
            br#"[{"needle":{"child":"needle"}},{"needle":"outside"}]"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();

        let first = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(1),
            None,
            1,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].node_id, Some(2));
        assert_eq!(first.matches[0].field, SearchFieldDto::Key);
        assert_eq!(first.matches[0].path_segments, ["$", "[0]", "needle"]);
        let cursor = first.next_cursor.clone().unwrap();
        let SearchCursorDto::Decoded {
            node_id,
            field,
            byte_offset,
            target_node_id,
            ..
        } = cursor.clone()
        else {
            panic!("expected decoded cursor");
        };
        assert_eq!(node_id, 2);
        assert_eq!(field, SearchFieldDto::Value);
        assert_eq!(byte_offset, 0);
        assert_eq!(target_node_id, Some(1));

        let second = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(1),
            Some(cursor),
            50,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].node_id, Some(3));
        assert_eq!(second.matches[0].field, SearchFieldDto::Value);
        assert_eq!(
            second.matches[0].path_segments,
            ["$", "[0]", "needle", "child"]
        );
        assert!(!second.has_more);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_honors_query_and_limit_boundaries_and_string_lexemes() {
        let path = temp_path("ipc-search-boundaries");
        let exact = "a".repeat(MAX_QUERY_BYTES);
        fs::write(
            &path,
            format!(
                "{{\"text\":{},\"other\":\"needle\"}}",
                serde_json::to_string(&exact).unwrap()
            ),
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let exact_page = search_current_inner(
            &state,
            exact.clone(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            usize::MAX,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(exact_page.matches.len(), 1);
        assert_eq!(
            search_current_inner(
                &state,
                format!("{exact}x"),
                SearchRepresentationDto::Decoded,
                None,
                None,
                None,
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "invalid_request"
        );

        let escaped_path = temp_path("ipc-search-string-lexeme");
        fs::write(&escaped_path, br#"{"text":"\u4f60"}"#).unwrap();
        let escaped = open_file_inner(&state, escaped_path.to_str().unwrap()).unwrap();
        let node_id = child_id(
            &state,
            None,
            escaped.root.as_ref().unwrap().id,
            "text",
            escaped.session_revision,
        );
        let decoded = search_current_inner(
            &state,
            "你".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            Some(node_id),
            None,
            50,
            escaped.session_revision,
        )
        .unwrap();
        assert_eq!(decoded.matches.len(), 1);
        assert_eq!(
            (decoded.matches[0].match_start, decoded.matches[0].match_end),
            (0, 3)
        );

        let raw = search_current_inner(
            &state,
            r#"\u4f60"#.to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            Some(node_id),
            None,
            50,
            escaped.session_revision,
        )
        .unwrap();
        assert_eq!(raw.matches.len(), 1);
        assert_eq!(
            (raw.matches[0].match_start, raw.matches[0].match_end),
            (9, 15)
        );
        assert_eq!(
            (
                raw.matches[0].source_span_start,
                raw.matches[0].source_span_end
            ),
            (8, 16)
        );

        let raw_quotes = search_current_inner(
            &state,
            "\"".to_owned(),
            SearchRepresentationDto::RawSource,
            None,
            Some(node_id),
            None,
            50,
            escaped.session_revision,
        )
        .unwrap();
        assert_eq!(raw_quotes.matches.len(), 2);

        fs::remove_file(path).unwrap();
        fs::remove_file(escaped_path).unwrap();
    }

    #[test]
    fn search_current_keeps_malicious_path_payload_bounded() {
        let path = temp_path("ipc-search-path-payload");
        let key = "\0\n\t\\\"".repeat(60);
        let mut input = String::from("{");
        for index in 0..50 {
            if index > 0 {
                input.push(',');
            }
            input.push_str(&serde_json::to_string(&format!("{key}{index}")).unwrap());
            input.push_str(":\"needle\"");
        }
        input.push('}');
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let page = search_current_inner(
            &state,
            "needle".to_owned(),
            SearchRepresentationDto::Decoded,
            None,
            None,
            None,
            usize::MAX,
            opened.session_revision,
        )
        .unwrap();
        assert_eq!(page.matches.len(), 50);
        assert!(page.matches.iter().all(|item| item
            .path_segments
            .iter()
            .map(String::len)
            .sum::<usize>()
            <= 2048));
        let payload = serde_json::to_vec(&page).unwrap();
        assert!(payload.len() < MAX_IPC_PAYLOAD_BYTES);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn search_current_rejects_stale_files_and_closed_scopes_without_mutation() {
        let path = temp_path("ipc-search-stale");
        fs::write(&path, br#"{"payload":"{\"needle\":\"yes\"}"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let payload = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "payload",
            opened.session_revision,
        );
        let scope =
            open_nested_json_inner(&state, None, payload, None, opened.session_revision).unwrap();
        close_nested_scope_inner(&state, scope.scope_id, opened.session_revision).unwrap();
        assert_eq!(
            search_current_inner(
                &state,
                "yes".to_owned(),
                SearchRepresentationDto::Decoded,
                Some(scope.scope_id),
                None,
                None,
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "not_found"
        );

        fs::write(&path, br#"{"payload":"{\"needle\":\"yes\"}"}"#).unwrap();
        assert_eq!(
            search_current_inner(
                &state,
                "yes".to_owned(),
                SearchRepresentationDto::Decoded,
                None,
                None,
                None,
                50,
                opened.session_revision,
            )
            .unwrap_err()
            .code,
            "file_changed"
        );
        assert_eq!(state.session.lock().unwrap().revision, 1);
        fs::remove_file(path).unwrap();
    }

    fn capture_copy(
        state: &AppState,
        node_id: usize,
        scope_id: Option<u64>,
        revision: u64,
        format: CopyFormatDto,
    ) -> (Result<(), IpcError>, Vec<String>) {
        let mut writes = Vec::new();
        let result = copy_node_to_sink(state, node_id, scope_id, revision, format, |text| {
            writes.push(text);
            Ok(())
        });
        (result, writes)
    }

    #[test]
    fn copy_node_preserves_raw_decoded_scalar_and_path_contracts() {
        let path = temp_path("ipc-copy-node-contract");
        fs::write(
            &path,
            br#"{
  "escaped":"\u4f60\u597d\r\n",
  "empty":"",
  "big":922337203685477580712345,
  "flag":true,
  "none":null,
  "object":{"inside":1},
  "duplicate":1,
  "duplicate":2
}"#,
        )
        .unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = opened.root.as_ref().unwrap().id;
        let children =
            get_children_scoped_inner(&state, root, 0, 200, None, opened.session_revision).unwrap();
        let node = |label: &str| {
            children
                .nodes
                .iter()
                .find(|candidate| candidate.label == label)
                .unwrap()
                .id
        };

        let escaped = node("escaped");
        let (result, writes) = capture_copy(
            &state,
            escaped,
            None,
            opened.session_revision,
            CopyFormatDto::Raw,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [r#""\u4f60\u597d\r\n""#]);

        let (result, writes) = capture_copy(
            &state,
            escaped,
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
        );
        assert!(result.is_ok());
        assert_eq!(writes, ["你好\r\n"]);

        let empty = node("empty");
        let (result, writes) = capture_copy(
            &state,
            empty,
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [String::new()]);

        for (label, expected) in [
            ("big", "922337203685477580712345"),
            ("flag", "true"),
            ("none", "null"),
        ] {
            let (result, writes) = capture_copy(
                &state,
                node(label),
                None,
                opened.session_revision,
                CopyFormatDto::Decoded,
            );
            assert!(result.is_ok());
            assert_eq!(writes, [expected.to_owned()]);
        }

        let (result, writes) = capture_copy(
            &state,
            node("object"),
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
        );
        assert_eq!(result.unwrap_err().code, "invalid_request");
        assert!(writes.is_empty());

        let duplicate = children
            .nodes
            .iter()
            .find(|candidate| candidate.label == "duplicate#2")
            .unwrap()
            .id;
        let (result, writes) = capture_copy(
            &state,
            duplicate,
            None,
            opened.session_revision,
            CopyFormatDto::Path,
        );
        assert!(result.is_ok());
        assert_eq!(writes, ["$.duplicate#2"]);

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_path_keeps_long_and_special_keys_complete() {
        let path = temp_path("ipc-copy-node-path");
        let long_key = "k".repeat(400);
        let input = format!(
            "{{{long}:{value},\"a.b\":2,\"a.b\":3}}",
            long = serde_json::to_string(&long_key).unwrap(),
            value = 1,
        );
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let root = opened.root.as_ref().unwrap().id;
        let children =
            get_children_scoped_inner(&state, root, 0, 200, None, opened.session_revision).unwrap();
        assert!(children.nodes[0].label_has_more);
        let (result, writes) = capture_copy(
            &state,
            children.nodes[0].id,
            None,
            opened.session_revision,
            CopyFormatDto::Path,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [format!("$.{long_key}")]);
        let (result, writes) = capture_copy(
            &state,
            children.nodes[2].id,
            None,
            opened.session_revision,
            CopyFormatDto::Path,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [r#"$["a.b"]#2"#.to_owned()]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_parsed_requires_nested_scope_root_and_copies_full_internal_source() {
        let path = temp_path("ipc-copy-node-parsed");
        fs::write(&path, br#"{"payload":"{\"x\":\"hello\",\"n\":1}"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let payload = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "payload",
            opened.session_revision,
        );
        let (result, writes) = capture_copy(
            &state,
            payload,
            None,
            opened.session_revision,
            CopyFormatDto::Parsed,
        );
        assert_eq!(result.unwrap_err().code, "invalid_request");
        assert!(writes.is_empty());

        let scope =
            open_nested_json_inner(&state, None, payload, None, opened.session_revision).unwrap();
        let (result, writes) = capture_copy(
            &state,
            scope.root.id,
            Some(scope.scope_id),
            opened.session_revision,
            CopyFormatDto::Parsed,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [r#"{"x":"hello","n":1}"#.to_owned()]);

        let inner = child_id(
            &state,
            Some(scope.scope_id),
            scope.root.id,
            "x",
            opened.session_revision,
        );
        let (result, writes) = capture_copy(
            &state,
            inner,
            Some(scope.scope_id),
            opened.session_revision,
            CopyFormatDto::Parsed,
        );
        assert_eq!(result.unwrap_err().code, "invalid_request");
        assert!(writes.is_empty());

        close_nested_scope_inner(&state, scope.scope_id, opened.session_revision).unwrap();
        let (result, writes) = capture_copy(
            &state,
            scope.root.id,
            Some(scope.scope_id),
            opened.session_revision,
            CopyFormatDto::Parsed,
        );
        assert_eq!(result.unwrap_err().code, "not_found");
        assert!(writes.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_rejects_stale_or_changed_sessions_before_sink() {
        let path = temp_path("ipc-copy-node-stale");
        fs::write(&path, br#"{"value":"before"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "value",
            opened.session_revision,
        );
        let (result, writes) = capture_copy(
            &state,
            value,
            None,
            opened.session_revision + 1,
            CopyFormatDto::Raw,
        );
        assert_eq!(result.unwrap_err().code, "stale_session");
        assert!(writes.is_empty());

        fs::write(&path, br#"{"value":"after"}"#).unwrap();
        let (result, writes) = capture_copy(
            &state,
            value,
            None,
            opened.session_revision,
            CopyFormatDto::Raw,
        );
        assert_eq!(result.unwrap_err().code, "file_changed");
        assert!(writes.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_reports_sink_failures_without_hiding_the_os_error() {
        let path = temp_path("ipc-copy-node-sink-error");
        fs::write(&path, br#"{"value":"text"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "value",
            opened.session_revision,
        );
        let result = copy_node_to_sink(
            &state,
            value,
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
            |_| Err("clipboard denied by host".to_owned()),
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, "clipboard_failed");
        assert!(error.message.contains("clipboard denied by host"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_holds_session_lock_until_sink_returns() {
        let path = temp_path("ipc-copy-node-lock");
        fs::write(&path, br#"{"value":"text"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "value",
            opened.session_revision,
        );
        let result = copy_node_to_sink(
            &state,
            value,
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
            |_| {
                assert!(matches!(
                    state.session.try_lock(),
                    Err(TryLockError::WouldBlock)
                ));
                Ok(())
            },
        );
        assert!(result.is_ok());
        assert!(state.session.try_lock().is_ok());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_does_not_cap_large_raw_or_decoded_values() {
        let path = temp_path("ipc-copy-node-large");
        let value = "x".repeat(1024 * 1024 + 17);
        fs::write(&path, format!(r#"{{"value":"{value}"}}"#)).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let value_node = child_id(
            &state,
            None,
            opened.root.as_ref().unwrap().id,
            "value",
            opened.session_revision,
        );
        let (result, writes) = capture_copy(
            &state,
            value_node,
            None,
            opened.session_revision,
            CopyFormatDto::Raw,
        );
        assert!(result.is_ok());
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].len(), value.len() + 2);
        assert_eq!(&writes[0][1..writes[0].len() - 1], value);

        let (result, writes) = capture_copy(
            &state,
            value_node,
            None,
            opened.session_revision,
            CopyFormatDto::Decoded,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [value]);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_node_uses_selected_jsonl_tree_and_revision() {
        let path = temp_jsonl_path("ipc-copy-node-entry");
        fs::write(&path, br#"{"value":"\u4f60\u597d","number":1.20e+3}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        assert_eq!(selected.session_revision, opened.session_revision + 1);
        let value = child_id(
            &state,
            None,
            selected.root.as_ref().unwrap().id,
            "value",
            selected.session_revision,
        );
        let (result, writes) = capture_copy(
            &state,
            value,
            None,
            selected.session_revision,
            CopyFormatDto::Raw,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [r#""\u4f60\u597d""#]);
        let (result, writes) = capture_copy(
            &state,
            value,
            None,
            selected.session_revision,
            CopyFormatDto::Decoded,
        );
        assert!(result.is_ok());
        assert_eq!(writes, ["你好"]);

        let (result, writes) = capture_copy(
            &state,
            value,
            None,
            opened.session_revision,
            CopyFormatDto::Raw,
        );
        assert_eq!(result.unwrap_err().code, "stale_session");
        assert!(writes.is_empty());
        fs::remove_file(path).unwrap();
    }

    fn capture_current_bytes(
        state: &AppState,
        revision: u64,
        format: CopyCurrentBytesFormatDto,
    ) -> (Result<(), IpcError>, Vec<String>) {
        let mut writes = Vec::new();
        let result = copy_current_bytes_to_sink(state, revision, format, |text| {
            writes.push(text);
            Ok(())
        });
        (result, writes)
    }

    #[test]
    fn copy_current_bytes_formats_raw_document_hex_and_lossy_without_truncation() {
        let path = temp_path("ipc-copy-current-raw-document");
        let bytes = [
            b'0', b'1', b'2', b'3', b'4', b'5', b'6', b'7', b'8', b'9', b'a', b'b', b'c', b'd',
            b'e', b'f', 0xff,
        ];
        fs::write(&path, bytes).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let (result, writes) = capture_current_bytes(
            &state,
            opened.session_revision,
            CopyCurrentBytesFormatDto::Hex,
        );
        assert!(result.is_ok());
        assert_eq!(writes.len(), 1);
        assert_eq!(
            writes[0],
            "00000000  30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66  |0123456789abcdef|\n00000010  ff                                               |.               |"
        );

        let bom_path = temp_path("ipc-copy-current-bom");
        fs::write(&bom_path, b"\xEF\xBB\xBFx\xC3\xA9\xFF").unwrap();
        let bom_state = AppState::default();
        let bom = open_file_inner(&bom_state, bom_path.to_str().unwrap()).unwrap();
        let (result, writes) = capture_current_bytes(
            &bom_state,
            bom.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert!(result.is_ok());
        assert_eq!(writes, ["\u{feff}xé�"]);

        fs::remove_file(path).unwrap();
        fs::remove_file(bom_path).unwrap();
    }

    #[test]
    fn copy_current_bytes_reads_selected_entry_relative_span_without_crlf_or_neighbors() {
        let path = temp_jsonl_path("ipc-copy-current-entry");
        let input = b"{\"value\":\"a\"}\r\n  {\"value\":\"b\"}\r\n{\"value\":\"c\"}";
        fs::write(&path, input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 1, opened.session_revision).unwrap();
        let expected = "  {\"value\":\"b\"}";
        let (result, writes) = capture_current_bytes(
            &state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [expected.to_owned()]);
        let (result, writes) = capture_current_bytes(
            &state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Hex,
        );
        assert!(result.is_ok());
        assert_eq!(writes.len(), 1);
        assert!(writes[0].starts_with("00000000  20 20 7b 22 76 61 6c 75 65 22 3a 22 62 22 7d"));
        assert!(!writes[0].contains("0d 0a"));
        assert!(!writes[0].contains("7b 22 76 61 6c 75 65 22 3a 22 61"));
        assert!(!writes[0].contains("7b 22 76 61 6c 75 65 22 3a 22 63"));

        fs::remove_file(path).unwrap();
    }

    #[test]
    fn copy_current_bytes_rejects_unselected_entries_and_parsed_documents() {
        let entry_path = temp_jsonl_path("ipc-copy-current-unselected");
        fs::write(&entry_path, br#"{"value":"entry"}"#).unwrap();
        let entry_state = AppState::default();
        let entry = open_file_inner(&entry_state, entry_path.to_str().unwrap()).unwrap();
        let (result, writes) = capture_current_bytes(
            &entry_state,
            entry.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert_eq!(result.unwrap_err().code, "invalid_request");
        assert!(writes.is_empty());

        let document_path = temp_path("ipc-copy-current-document");
        fs::write(&document_path, br#"{"value":"document"}"#).unwrap();
        let document_state = AppState::default();
        let document = open_file_inner(&document_state, document_path.to_str().unwrap()).unwrap();
        let (result, writes) = capture_current_bytes(
            &document_state,
            document.session_revision,
            CopyCurrentBytesFormatDto::Hex,
        );
        assert_eq!(result.unwrap_err().code, "invalid_request");
        assert!(writes.is_empty());

        fs::remove_file(entry_path).unwrap();
        fs::remove_file(document_path).unwrap();
    }

    #[test]
    fn copy_current_bytes_preserves_utf8_across_chunks_and_replaces_invalid_bytes() {
        let path = temp_jsonl_path("ipc-copy-current-utf8-boundary");
        let prefix = br#"{"value":""#;
        let ascii_count = 256 * 1024 - prefix.len() - 1;
        let mut input = prefix.to_vec();
        input.extend(std::iter::repeat_n(b'a', ascii_count));
        input.extend_from_slice("é".as_bytes());
        input.extend(std::iter::repeat_n(b'z', 1024 * 1024));
        input.extend_from_slice(br#""}"#);
        fs::write(&path, &input).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        while !scan_entries_inner(&state, opened.session_revision)
            .unwrap()
            .complete
        {}
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let (result, writes) = capture_current_bytes(
            &state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert!(result.is_ok());
        assert_eq!(writes, [String::from_utf8(input.clone()).unwrap()]);

        let invalid_path = temp_jsonl_path("ipc-copy-current-invalid");
        fs::write(&invalid_path, b"prefix\xC3").unwrap();
        let invalid_state = AppState::default();
        let invalid = open_file_inner(&invalid_state, invalid_path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&invalid_state, 0, invalid.session_revision).unwrap();
        let (result, writes) = capture_current_bytes(
            &invalid_state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert!(result.is_ok());
        assert_eq!(writes, ["prefix�"]);

        fs::remove_file(path).unwrap();
        fs::remove_file(invalid_path).unwrap();
    }

    #[test]
    fn copy_current_bytes_rejects_stale_and_changed_state_before_sink() {
        let path = temp_jsonl_path("ipc-copy-current-stale");
        fs::write(&path, br#"{"value":"before"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let (result, writes) = capture_current_bytes(
            &state,
            selected.session_revision - 1,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert_eq!(result.unwrap_err().code, "stale_session");
        assert!(writes.is_empty());

        fs::write(&path, br#"{"value":"after!!"}"#).unwrap();
        let (result, writes) = capture_current_bytes(
            &state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
        );
        assert_eq!(result.unwrap_err().code, "file_changed");
        assert!(writes.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn hex_copy_layout_accounts_for_wide_offsets_without_allocating() {
        let (rows, width, capacity) = hex_copy_layout(17).unwrap();
        assert_eq!((rows, width, capacity), (2, 8, 155));
        if usize::BITS > 32 {
            let byte_len = (1u64 << 32) as usize + 16;
            let (rows, width, capacity) = hex_copy_layout(byte_len).unwrap();
            assert_eq!(rows, (1usize << 28) + 1);
            assert_eq!(width, 9);
            assert_eq!(capacity, rows * 78 + rows - 1);
        }
        assert!(hex_copy_layout(usize::MAX).is_err());
    }

    #[test]
    fn copy_current_bytes_holds_session_lock_until_sink_and_reports_sink_errors() {
        let path = temp_jsonl_path("ipc-copy-current-lock");
        fs::write(&path, br#"{"value":"text"}"#).unwrap();
        let state = AppState::default();
        let opened = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        let selected = select_entry_inner(&state, 0, opened.session_revision).unwrap();
        let result = copy_current_bytes_to_sink(
            &state,
            selected.session_revision,
            CopyCurrentBytesFormatDto::Lossy,
            |_| {
                assert!(matches!(
                    state.session.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                Err("clipboard unavailable".to_owned())
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.code, "clipboard_failed");
        assert!(error.message.contains("clipboard unavailable"));
        assert!(state.session.try_lock().is_ok());
        fs::remove_file(path).unwrap();
    }
}
