use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::State;

use crate::document_session::DocumentSession;
use crate::json::JsonKind;
use crate::tree::{NodePage, NodeProjection, TextChunk};

#[derive(Default)]
pub struct AppState {
    session: Mutex<(u64, Option<DocumentSession>)>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub size: u64,
    pub mode: String,
    pub root: NodeDto,
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

#[tauri::command(async)]
pub fn open_file(path: String, state: State<'_, AppState>) -> Result<FileSummary, IpcError> {
    open_file_inner(&state, &path)
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

fn open_file_inner(state: &AppState, path: &str) -> Result<FileSummary, IpcError> {
    if path.trim().is_empty() {
        return Err(invalid_request("path must not be empty"));
    }

    let session = DocumentSession::open(Path::new(path)).map_err(open_error)?;
    let mut guard = lock_session(state)?;
    let next_revision = guard
        .0
        .checked_add(1)
        .ok_or_else(|| internal("session revision overflow"))?;
    let summary = file_summary(&session, next_revision)?;
    *guard = (next_revision, Some(session));
    Ok(summary)
}

fn file_summary(session: &DocumentSession, session_revision: u64) -> Result<FileSummary, IpcError> {
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
        root: node_dto(root),
        session_revision,
    })
}

fn get_file_summary_inner(state: &AppState) -> Result<FileSummary, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.1.as_ref().ok_or_else(no_session)?;
    file_summary(session, guard.0)
}

fn get_root_node_inner(state: &AppState, session_revision: u64) -> Result<NodeDto, IpcError> {
    with_session(state, session_revision, |session| {
        session.root().map(node_dto).map_err(session_error)
    })
}

fn get_node_summary_inner(
    state: &AppState,
    node_id: usize,
    session_revision: u64,
) -> Result<NodeDto, IpcError> {
    with_session(state, session_revision, |session| {
        session
            .node(node_id)
            .map_err(session_error)?
            .map(node_dto)
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
        let parent = session
            .node(node_id)
            .map_err(session_error)?
            .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if limit == 0 || cursor > parent.child_count {
            return Err(invalid_request("invalid cursor or limit"));
        }
        session
            .children(node_id, cursor, limit)
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
        session
            .read_raw_text(source_start, length)
            .map_err(session_error)?
            .map(text_chunk_dto)
            .ok_or_else(|| invalid_request("raw slice is unavailable"))
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
        let node = session
            .node(node_id)
            .map_err(session_error)?
            .ok_or_else(|| not_found(format!("node {node_id} was not found")))?;
        if node.kind != JsonKind::String {
            return Err(invalid_request("node does not contain decoded text"));
        }
        session
            .read_decoded_text(node_id, offset, length)
            .map_err(session_error)?
            .map(text_chunk_dto)
            .ok_or_else(|| invalid_request("decoded text is unavailable"))
    })
}

fn with_session<T>(
    state: &AppState,
    session_revision: u64,
    operation: impl FnOnce(&DocumentSession) -> Result<T, IpcError>,
) -> Result<T, IpcError> {
    let guard = lock_session(state)?;
    let session = guard.1.as_ref().ok_or_else(no_session)?;
    if guard.0 != session_revision {
        return Err(stale_session());
    }
    operation(session)
}

fn lock_session(
    state: &AppState,
) -> Result<MutexGuard<'_, (u64, Option<DocumentSession>)>, IpcError> {
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
}

fn no_session() -> IpcError {
    IpcError {
        code: "no_session".to_owned(),
        message: "no document is open".to_owned(),
    }
}

fn file_changed() -> IpcError {
    IpcError {
        code: "file_changed".to_owned(),
        message: "the file changed on disk".to_owned(),
    }
}

fn stale_session() -> IpcError {
    IpcError {
        code: "stale_session".to_owned(),
        message: "the document session is stale".to_owned(),
    }
}

fn invalid_request(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "invalid_request".to_owned(),
        message: message.into(),
    }
}

fn not_found(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "not_found".to_owned(),
        message: message.into(),
    }
}

fn open_error(error: crate::document_session::DocumentOpenError) -> IpcError {
    IpcError {
        code: "open_failed".to_owned(),
        message: error.to_string(),
    }
}

fn internal(message: impl Into<String>) -> IpcError {
    IpcError {
        code: "internal".to_owned(),
        message: message.into(),
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
            summary.root.id,
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
            summary.root.id + 1,
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
    fn open_and_read_commands_share_one_session() {
        let path = temp_path("ipc-session");
        fs::write(&path, r#"{"name":"Ada","items":[1,2]}"#).unwrap();
        let state = AppState::default();

        let summary = open_file_inner(&state, path.to_str().unwrap()).unwrap();
        assert_eq!(summary.mode, "document");
        assert_eq!(summary.root.kind, "object");
        assert_eq!(summary.root.child_count, 2);
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
        assert_eq!(summary.root.kind, "array");
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

        assert_eq!(
            open_file_inner(&state, invalid.to_str().unwrap())
                .unwrap_err()
                .code,
            "open_failed"
        );
        assert_eq!(
            open_file_inner(&state, missing.to_str().unwrap())
                .unwrap_err()
                .code,
            "open_failed"
        );
        assert_eq!(get_file_summary_inner(&state).unwrap(), summary);
        assert_eq!(
            get_root_node_inner(&state, summary.session_revision).unwrap(),
            summary.root
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
