use std::io::{self, ErrorKind};
use std::path::Path;

use crate::file_source::FileSource;
use crate::json::ParseError;
use crate::search::{SearchError, SearchPage, SearchRequest};
use crate::semantic_detection::{Detection, NestedBudget};
use crate::tree::{NodePage, NodeProjection, TextChunk, TreeDocument};

#[derive(Debug)]
pub enum DocumentOpenError {
    Io(io::Error),
    Json(ParseError),
}

impl std::fmt::Display for DocumentOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DocumentOpenError::Io(error) => write!(f, "failed to read document: {error}"),
            DocumentOpenError::Json(error) => write!(
                f,
                "failed to parse document: {} at byte offset {} (line {}, column {})",
                error.message, error.byte_offset, error.line, error.column
            ),
        }
    }
}

impl std::error::Error for DocumentOpenError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            DocumentOpenError::Io(error) => Some(error),
            DocumentOpenError::Json(_) => None,
        }
    }
}

impl From<io::Error> for DocumentOpenError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ParseError> for DocumentOpenError {
    fn from(value: ParseError) -> Self {
        Self::Json(value)
    }
}

pub struct DocumentSession {
    source: FileSource,
    tree: TreeDocument,
}

impl DocumentSession {
    pub fn open(path: &Path) -> Result<Self, DocumentOpenError> {
        let source = FileSource::open(path)?;
        let capacity = usize::try_from(source.identity().size).map_err(|_| {
            DocumentOpenError::Io(io::Error::new(
                ErrorKind::InvalidData,
                "file size exceeds addressable range",
            ))
        })?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(capacity).map_err(|error| {
            DocumentOpenError::Io(io::Error::new(ErrorKind::OutOfMemory, error))
        })?;
        let mut next_offset = Some(0);

        while let Some(offset) = next_offset {
            let chunk = source.read_chunk(offset, usize::MAX)?;
            if chunk.bytes.is_empty() && chunk.next_offset.is_some() {
                return Err(DocumentOpenError::Io(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "file ended before its recorded size",
                )));
            }
            bytes.extend_from_slice(&chunk.bytes);
            next_offset = chunk.next_offset;
        }

        Ok(Self {
            source,
            tree: TreeDocument::from_bytes(bytes)?,
        })
    }

    pub fn identity(&self) -> &crate::file_source::FileIdentity {
        self.source.identity()
    }

    pub fn is_current(&self) -> bool {
        self.source.is_current()
    }

    fn ensure_current(&self) -> io::Result<()> {
        if self.source.is_current() {
            Ok(())
        } else {
            Err(ErrorKind::InvalidData.into())
        }
    }

    pub fn root(&self) -> io::Result<NodeProjection> {
        self.ensure_current()?;
        Ok(self.tree.root())
    }

    pub fn node(&self, id: usize) -> io::Result<Option<NodeProjection>> {
        self.ensure_current()?;
        Ok(self.tree.node(id))
    }

    pub fn children(
        &self,
        parent_id: usize,
        cursor: usize,
        limit: usize,
    ) -> io::Result<Option<NodePage>> {
        self.ensure_current()?;
        Ok(self.tree.children(parent_id, cursor, limit))
    }

    pub fn read_raw_text(
        &self,
        offset: usize,
        requested_len: usize,
    ) -> io::Result<Option<TextChunk>> {
        self.ensure_current()?;
        Ok(self.tree.read_raw_text(offset, requested_len))
    }

    pub fn read_decoded_text(
        &self,
        node_id: usize,
        offset: usize,
        requested_len: usize,
    ) -> io::Result<Option<TextChunk>> {
        self.ensure_current()?;
        Ok(self.tree.read_decoded_text(node_id, offset, requested_len))
    }

    pub fn detect_string(&self, node_id: usize) -> io::Result<Option<Detection>> {
        self.detect_string_with_budget(node_id, NestedBudget::default())
    }

    pub fn decoded_text(&self, node_id: usize) -> io::Result<Option<&str>> {
        self.ensure_current()?;
        Ok(self.tree.decoded_text(node_id))
    }

    pub fn raw_text(&self, node_id: usize) -> io::Result<Option<&str>> {
        self.ensure_current()?;
        Ok(self.tree.raw_text(node_id))
    }

    pub fn path(&self, node_id: usize) -> io::Result<Option<String>> {
        self.ensure_current()?;
        Ok(self.tree.path(node_id))
    }

    pub fn detect_string_with_budget(
        &self,
        node_id: usize,
        budget: NestedBudget,
    ) -> io::Result<Option<Detection>> {
        self.ensure_current()?;
        Ok(self.tree.detect_string_with_budget(node_id, budget))
    }

    pub fn search(&self, request: SearchRequest) -> io::Result<Result<SearchPage, SearchError>> {
        self.ensure_current()?;
        Ok(self.tree.search(request))
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;

    use super::*;

    fn temp_path(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{}.tmp", std::process::id(), nanos))
    }

    #[test]
    fn exposes_tree_content_after_loading_document() {
        let path = temp_path("document-session-normal");
        let input = r#"{"name":"Ada","count":42}"#;
        fs::write(&path, input).unwrap();

        let session = DocumentSession::open(&path).unwrap();
        let root = session.root().unwrap();
        assert_eq!(root.child_count, 2);

        let children = session.children(root.id, 0, 10).unwrap().unwrap();
        assert_eq!(children.nodes[0].label, "name");
        assert_eq!(children.nodes[1].label, "count");
        assert!(session.node(1).unwrap().is_some());
        assert!(session.node(999).unwrap().is_none());
        assert!(session.children(root.id, 3, 10).unwrap().is_none());

        let raw = session.read_raw_text(8, 5).unwrap().unwrap();
        assert_eq!(raw.text, r#""Ada""#);
        let decoded = session.read_decoded_text(1, 0, 10).unwrap().unwrap();
        assert_eq!(decoded.text, "Ada");

        drop(session);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn loads_documents_across_multiple_read_chunks() {
        let path = temp_path("document-session-large");
        let value = "a".repeat(300_000);
        let input = format!(r#"["{value}"]"#);
        fs::write(&path, input).unwrap();

        let session = DocumentSession::open(&path).unwrap();
        let node = session.node(1).unwrap().unwrap();
        let mut text_len = 0;
        let mut offset = Some(0);
        while let Some(current_offset) = offset {
            let text = session
                .read_decoded_text(node.id, current_offset, usize::MAX)
                .unwrap()
                .unwrap();
            text_len += text.text.len();
            offset = text.next_offset;
        }
        assert_eq!(text_len, 300_000);

        drop(session);
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn reports_invalid_json_as_parse_error() {
        let path = temp_path("document-session-invalid");
        fs::write(&path, b"{").unwrap();

        let error = match DocumentSession::open(&path) {
            Ok(_) => panic!("invalid JSON should not open"),
            Err(error) => error,
        };
        assert!(matches!(error, DocumentOpenError::Json(_)));

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn rejects_reads_after_file_size_changes() {
        let path = temp_path("document-session-stale");
        fs::write(&path, r#"{"name":"Ada"}"#).unwrap();
        let session = DocumentSession::open(&path).unwrap();
        fs::write(&path, b"abc").unwrap();

        assert!(!session.is_current());
        for result in [
            session.root().map(|_| ()).map_err(|error| error.kind()),
            session.node(1).map(|_| ()).map_err(|error| error.kind()),
            session
                .children(0, 0, 10)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .read_raw_text(0, 10)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .read_decoded_text(1, 0, 10)
                .map(|_| ())
                .map_err(|error| error.kind()),
        ] {
            assert_eq!(result, Err(ErrorKind::InvalidData));
        }

        drop(session);
        fs::remove_file(&path).unwrap();
    }
}
