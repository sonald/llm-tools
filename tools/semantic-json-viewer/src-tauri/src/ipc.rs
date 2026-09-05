use std::io::{self, ErrorKind};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::State;

use crate::document_session::DocumentSession;
use crate::file_route::{
    route_read_limit, route_with_override, FileMode, OpenDecision, OverrideError,
};
use crate::file_source::{FileIdentity, FileSource};
use crate::json::JsonKind;
use crate::jsonl_entry::EntryStatus;
use crate::jsonl_session::{
    EntrySelection, EntrySummary, JsonlProgress, JsonlSession, OversizedPreview,
};
use crate::tree::{NodePage, NodeProjection, TextChunk};

// AppState is a singleton with one session; boxing this variant adds indirection without value.
#[allow(clippy::large_enum_variant)]
enum OpenSession {
    Document(DocumentSession),
    Entry(JsonlSession),
}

#[derive(Default)]
pub struct AppState {
    session: Mutex<(u64, Option<OpenSession>)>,
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
pub struct TextChunkDto {
    pub start: usize,
    pub text: String,
    pub has_more: bool,
    pub next_offset: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryByteChunkDto {
    pub start: u64,
    pub bytes: Vec<u8>,
    pub has_more: bool,
    pub next_offset: Option<u64>,
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
    state: State<'_, AppState>,
) -> Result<NodeDto, IpcError> {
    get_root_node_inner(&state, session_revision)
}

#[tauri::command]
pub fn get_node_summary(
    node_id: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<NodeDto, IpcError> {
    get_node_summary_inner(&state, node_id, session_revision)
}

#[tauri::command]
pub fn get_children(
    node_id: usize,
    cursor: usize,
    limit: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<NodePageDto, IpcError> {
    get_children_inner(&state, node_id, cursor, limit, session_revision)
}

#[tauri::command]
pub fn read_raw_slice(
    source_start: usize,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<TextChunkDto, IpcError> {
    read_raw_slice_inner(&state, source_start, length, session_revision)
}

#[tauri::command(async)]
pub fn read_selected_entry_bytes(
    offset: u64,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<EntryByteChunkDto, IpcError> {
    read_selected_entry_bytes_inner(&state, offset, length, session_revision)
}

#[tauri::command]
pub fn read_decoded_text(
    node_id: usize,
    offset: usize,
    length: usize,
    session_revision: u64,
    state: State<'_, AppState>,
) -> Result<TextChunkDto, IpcError> {
    read_decoded_text_inner(&state, node_id, offset, length, session_revision)
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
    let (mode, many_invalid_utf8_warning) = decision_mode(decision)?;
    // ponytail: route and session currently reread the selected file; reuse route bytes only if v0.1 benchmarks miss the target.
    drop(route_bytes);

    let session = match mode {
        FileMode::Entry => {
            let mut session = JsonlSession::open(path).map_err(open_error)?;
            session.set_many_invalid_utf8_warning(many_invalid_utf8_warning);
            OpenSession::Entry(session)
        }
        FileMode::Document | FileMode::Collection => {
            OpenSession::Document(DocumentSession::open(path).map_err(open_error)?)
        }
    };
    if route_source.identity() != session_identity(&session) {
        return Err(file_changed());
    }
    let mut guard = lock_session(state)?;
    let next_revision = guard
        .0
        .checked_add(1)
        .ok_or_else(|| internal("session revision overflow"))?;
    let summary = file_summary(&session, next_revision)?;
    *guard = (next_revision, Some(session));
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

fn decision_mode(decision: OpenDecision) -> Result<(FileMode, bool), IpcError> {
    match decision {
        OpenDecision::Open {
            mode,
            many_invalid_utf8_warning,
            ..
        } => Ok((mode, many_invalid_utf8_warning)),
        OpenDecision::InvalidJson(error) => Err(invalid_json(error)),
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
            session_revision,
        }),
    }
}

fn get_file_summary_inner(state: &AppState) -> Result<FileSummary, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.1.as_ref().ok_or_else(no_session)?;
    file_summary(session, guard.0)
}

fn get_root_node_inner(state: &AppState, session_revision: u64) -> Result<NodeDto, IpcError> {
    with_session(state, session_revision, |session| match session {
        OpenSession::Document(session) => session.root().map(node_dto).map_err(session_error),
        OpenSession::Entry(session) => session
            .selected_root()
            .map_err(session_error)?
            .map(node_dto)
            .ok_or_else(|| invalid_request("no valid entry is selected")),
    })
}

fn get_node_summary_inner(
    state: &AppState,
    node_id: usize,
    session_revision: u64,
) -> Result<NodeDto, IpcError> {
    with_session(state, session_revision, |session| {
        let node = match session {
            OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
            OpenSession::Entry(session) => {
                require_selected(session)?;
                session.selected_node(node_id).map_err(session_error)?
            }
        };
        node.map(node_dto)
            .ok_or_else(|| not_found(format!("node {node_id} was not found")))
    })
}

fn get_children_inner(
    state: &AppState,
    node_id: usize,
    cursor: usize,
    limit: usize,
    session_revision: u64,
) -> Result<NodePageDto, IpcError> {
    with_session(state, session_revision, |session| {
        let parent = match session {
            OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
            OpenSession::Entry(session) => {
                require_selected(session)?;
                session.selected_node(node_id).map_err(session_error)?
            }
        }
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if limit == 0 || cursor > parent.child_count {
            return Err(invalid_request("invalid cursor or limit"));
        }
        match session {
            OpenSession::Document(session) => session.children(node_id, cursor, limit),
            OpenSession::Entry(session) => session.selected_children(node_id, cursor, limit),
        }
        .map_err(session_error)?
        .map(node_page_dto)
        .ok_or_else(|| invalid_request("invalid cursor or limit"))
    })
}

fn read_raw_slice_inner(
    state: &AppState,
    source_start: usize,
    length: usize,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    with_session(state, session_revision, |session| {
        match session {
            OpenSession::Document(session) => session.read_raw_text(source_start, length),
            OpenSession::Entry(session) => session.read_raw_text(source_start, length),
        }
        .map_err(session_error)?
        .map(text_chunk_dto)
        .ok_or_else(|| invalid_request("raw slice is unavailable"))
    })
}

fn read_selected_entry_bytes_inner(
    state: &AppState,
    offset: u64,
    length: usize,
    session_revision: u64,
) -> Result<EntryByteChunkDto, IpcError> {
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
        Ok(EntryByteChunkDto {
            start: chunk.start,
            bytes: chunk.bytes,
            has_more: chunk.has_more,
            next_offset: chunk.next_offset,
        })
    })
}

fn read_decoded_text_inner(
    state: &AppState,
    node_id: usize,
    offset: usize,
    length: usize,
    session_revision: u64,
) -> Result<TextChunkDto, IpcError> {
    with_session(state, session_revision, |session| {
        let node = match session {
            OpenSession::Document(session) => session.node(node_id).map_err(session_error)?,
            OpenSession::Entry(session) => {
                require_selected(session)?;
                session.selected_node(node_id).map_err(session_error)?
            }
        }
        .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if node.kind != JsonKind::String {
            return Err(invalid_request("node does not contain decoded text"));
        }
        match session {
            OpenSession::Document(session) => session.read_decoded_text(node_id, offset, length),
            OpenSession::Entry(session) => session.read_decoded_text(node_id, offset, length),
        }
        .map_err(session_error)?
        .map(text_chunk_dto)
        .ok_or_else(|| invalid_request("decoded text is unavailable"))
    })
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
    if guard.0 != session_revision {
        return Err(stale_session());
    }
    let next_revision = guard
        .0
        .checked_add(1)
        .ok_or_else(|| internal("session revision overflow"))?;
    let session = guard.1.as_mut().ok_or_else(no_session)?;
    let selection = match session {
        OpenSession::Document(_) => {
            return Err(invalid_request("command requires a JSONL session"));
        }
        OpenSession::Entry(session) => session.select_entry(ordinal).map_err(session_error)?,
    };
    let Some(selection) = selection else {
        guard.0 = next_revision;
        return Err(invalid_request("entry is not indexed"));
    };
    let dto = selection_dto(selection, next_revision);
    guard.0 = next_revision;
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
    let session = guard.1.as_ref().ok_or_else(no_session)?;
    if guard.0 != session_revision {
        return Err(stale_session());
    }
    operation(session)
}

fn with_entry_session<T>(
    state: &AppState,
    session_revision: u64,
    operation: impl FnOnce(&JsonlSession) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    with_session(state, session_revision, |session| match session {
        OpenSession::Document(_) => Err(invalid_request("command requires a JSONL session")),
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
    if guard.0 != session_revision {
        return Err(stale_session());
    }
    let session = guard.1.as_mut().ok_or_else(no_session)?;
    match session {
        OpenSession::Document(_) => Err(invalid_request("command requires a JSONL session")),
        OpenSession::Entry(session) => operation(session),
    }
}

fn lock_session(state: &AppState) -> Result<MutexGuard<'_, (u64, Option<OpenSession>)>, IpcError> {
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

fn text_chunk_dto(chunk: TextChunk) -> TextChunkDto {
    TextChunkDto {
        start: chunk.start,
        text: chunk.text,
        has_more: chunk.has_more,
        next_offset: chunk.next_offset,
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

        assert_eq!(
            open_file_with_override(&state, path.to_str().unwrap(), Some("json"))
                .unwrap_err()
                .code,
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
        let error = open_file_inner(&state, json.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code, "invalid_json");
        assert!(error.parse_error.is_some());
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
        let dto = EntryByteChunkDto {
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
        let invalid = temp_path("ipc-open-invalid");
        let missing = temp_path("ipc-open-missing");
        fs::write(&first, b"{\"name\":\"Ada\"}").unwrap();
        fs::write(&invalid, b"{").unwrap();
        let state = AppState::default();
        let summary = open_file_inner(&state, first.to_str().unwrap()).unwrap();

        let invalid_error = open_file_inner(&state, invalid.to_str().unwrap()).unwrap_err();
        assert_eq!(invalid_error.code, "invalid_json");
        let parse_error = invalid_error.parse_error.as_ref().unwrap();
        assert_eq!(parse_error.message, "expected object key");
        assert_eq!(parse_error.byte_offset, 1);
        assert_eq!(parse_error.line, 1);
        assert_eq!(parse_error.column, 2);
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
}
