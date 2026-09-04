use std::io::{self, ErrorKind};
use std::path::Path;

use crate::file_source::{FileIdentity, FileSource};
use crate::jsonl_index::{Checkpoint, EntryLocation, JsonlIndex, JsonlIndexer};

const MAX_ENTRY_PAGE: usize = 200;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct JsonlProgress {
    pub indexed_entries: u64,
    pub indexed_source_lines: u64,
    pub complete: bool,
    pub stride: u64,
    pub total_entries: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntryPage {
    pub locations: Vec<EntryLocation>,
    pub has_more: bool,
    pub next_cursor: Option<u64>,
}

pub struct JsonlSession {
    source: FileSource,
    indexer: Option<JsonlIndexer>,
    index: Option<JsonlIndex>,
    next_offset: u64,
    complete: bool,
}

impl JsonlSession {
    pub fn open(path: &Path) -> io::Result<Self> {
        let mut session = Self {
            source: FileSource::open(path)?,
            indexer: Some(JsonlIndexer::new()),
            index: None,
            next_offset: 0,
            complete: false,
        };
        session.scan_next()?;
        Ok(session)
    }

    pub fn identity(&self) -> &FileIdentity {
        self.source.identity()
    }

    pub fn is_current(&self) -> bool {
        self.source.is_current()
    }

    pub fn progress(&self) -> io::Result<JsonlProgress> {
        self.ensure_current()?;
        Ok(self.progress_unchecked())
    }

    pub fn scan_next(&mut self) -> io::Result<JsonlProgress> {
        self.ensure_current()?;
        if self.complete {
            return Ok(self.progress_unchecked());
        }

        let chunk = self.source.read_chunk(self.next_offset, usize::MAX)?;
        if chunk.bytes.is_empty() {
            if chunk.has_more {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "file ended before the next JSONL chunk",
                ));
            }
            self.finish_index();
            self.ensure_current()?;
            return Ok(self.progress_unchecked());
        }

        self.indexer
            .as_mut()
            .expect("incomplete JSONL session has an indexer")
            .feed(&chunk.bytes);
        self.next_offset = if chunk.has_more {
            chunk.next_offset.ok_or_else(|| {
                io::Error::new(
                    ErrorKind::InvalidData,
                    "JSONL chunk omitted its next offset",
                )
            })?
        } else {
            self.source.identity().size
        };
        if !chunk.has_more {
            self.finish_index();
        }

        self.ensure_current()?;
        Ok(self.progress_unchecked())
    }

    pub fn locate_entry(&self, ordinal: u64) -> io::Result<Option<EntryLocation>> {
        self.ensure_current()?;
        let indexed_entries = self.indexed_entries_unchecked();
        if ordinal >= indexed_entries {
            return Ok(None);
        }

        let checkpoint = self.nearest_checkpoint(ordinal);
        let Some(checkpoint) = checkpoint else {
            return Ok(None);
        };
        self.scan_locations(checkpoint, ordinal, 1)
            .map(|locations| locations.into_iter().next())
    }

    pub fn list_entries(&self, start: u64, limit: usize) -> io::Result<Option<EntryPage>> {
        self.ensure_current()?;
        if limit == 0 {
            return Ok(None);
        }

        let page_size = limit.min(MAX_ENTRY_PAGE);
        let indexed_entries = self.indexed_entries_unchecked();
        if start > indexed_entries {
            return Ok(None);
        }
        if start == indexed_entries {
            return Ok(Some(EntryPage {
                locations: Vec::new(),
                has_more: false,
                next_cursor: None,
            }));
        }

        let end = start.saturating_add(page_size as u64).min(indexed_entries);
        let checkpoint = self.nearest_checkpoint(start);
        let Some(checkpoint) = checkpoint else {
            return Ok(None);
        };
        let locations = self.scan_locations(checkpoint, start, (end - start) as usize)?;
        let has_more = end < indexed_entries;
        let next_cursor = has_more.then_some(end);
        Ok(Some(EntryPage {
            locations,
            has_more,
            next_cursor,
        }))
    }

    fn ensure_current(&self) -> io::Result<()> {
        if self.source.is_current() {
            Ok(())
        } else {
            Err(ErrorKind::InvalidData.into())
        }
    }

    fn indexed_entries_unchecked(&self) -> u64 {
        self.index.as_ref().map_or_else(
            || self.indexer.as_ref().expect("indexer exists").entry_count(),
            |index| index.total_entry_count,
        )
    }

    fn progress_unchecked(&self) -> JsonlProgress {
        if let Some(index) = &self.index {
            JsonlProgress {
                indexed_entries: index.total_entry_count,
                indexed_source_lines: index.total_source_line_count,
                complete: true,
                stride: index.stride,
                total_entries: Some(index.total_entry_count),
            }
        } else {
            let indexer = self
                .indexer
                .as_ref()
                .expect("incomplete session has an indexer");
            JsonlProgress {
                indexed_entries: indexer.entry_count(),
                indexed_source_lines: indexer.indexed_through_line(),
                complete: false,
                stride: indexer.stride(),
                total_entries: None,
            }
        }
    }

    fn nearest_checkpoint(&self, ordinal: u64) -> Option<Checkpoint> {
        self.index.as_ref().map_or_else(
            || {
                self.indexer
                    .as_ref()
                    .expect("indexer exists")
                    .nearest_checkpoint(ordinal)
            },
            |index| index.nearest_checkpoint(ordinal),
        )
    }

    fn finish_index(&mut self) {
        if self.complete {
            return;
        }
        let indexer = self
            .indexer
            .take()
            .expect("incomplete session has an indexer");
        self.index = Some(indexer.finish());
        self.complete = true;
    }

    fn scan_locations(
        &self,
        checkpoint: Checkpoint,
        first_ordinal: u64,
        requested: usize,
    ) -> io::Result<Vec<EntryLocation>> {
        if requested == 0 {
            return Ok(Vec::new());
        }
        if checkpoint.entry_ordinal > first_ordinal {
            return Ok(Vec::new());
        }

        let mut locations = Vec::with_capacity(requested);
        let mut offset = checkpoint.byte_offset;
        let mut line_start = checkpoint.byte_offset;
        let mut source_line = checkpoint.source_line;
        let mut ordinal = checkpoint.entry_ordinal;
        let mut line_has_content = false;
        let mut last_byte = None;

        loop {
            let chunk = self.source.read_chunk(offset, usize::MAX)?;
            if chunk.bytes.is_empty() {
                if chunk.has_more {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "file ended before the JSONL entry",
                    ));
                }
                if line_has_content
                    && line_start < offset
                    && ordinal >= first_ordinal
                    && locations.len() < requested
                {
                    locations.push(EntryLocation {
                        entry_ordinal: ordinal,
                        source_line,
                        byte_start: line_start,
                        byte_end: offset,
                    });
                }
                break;
            }

            for (relative, &byte) in chunk.bytes.iter().enumerate() {
                if byte == b'\n' {
                    let lf = chunk
                        .start
                        .checked_add(relative as u64)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    let content_end = if last_byte == Some(b'\r') {
                        lf.checked_sub(1)
                            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?
                    } else {
                        lf
                    };
                    if line_has_content && line_start < content_end {
                        if ordinal >= first_ordinal && locations.len() < requested {
                            locations.push(EntryLocation {
                                entry_ordinal: ordinal,
                                source_line,
                                byte_start: line_start,
                                byte_end: content_end,
                            });
                            if locations.len() == requested {
                                self.ensure_current()?;
                                return Ok(locations);
                            }
                        }
                        ordinal = ordinal
                            .checked_add(1)
                            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    }
                    source_line = source_line
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    line_start = lf
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    line_has_content = false;
                    last_byte = None;
                } else {
                    if !matches!(byte, b' ' | b'\t' | b'\r') {
                        line_has_content = true;
                    }
                    last_byte = Some(byte);
                }
            }

            if !chunk.has_more {
                offset = chunk
                    .start
                    .checked_add(chunk.bytes.len() as u64)
                    .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                continue;
            }
            offset = chunk.next_offset.ok_or_else(|| {
                io::Error::new(
                    ErrorKind::InvalidData,
                    "JSONL chunk omitted its next offset",
                )
            })?;
        }

        self.ensure_current()?;
        Ok(locations)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::SystemTime;

    fn temp_path(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}.jsonl", std::process::id()))
    }

    fn session(prefix: &str, bytes: &[u8]) -> (PathBuf, JsonlSession) {
        let path = temp_path(prefix);
        fs::write(&path, bytes).unwrap();
        let session = JsonlSession::open(&path).unwrap();
        (path, session)
    }

    fn finish(session: &mut JsonlSession) -> JsonlProgress {
        loop {
            let progress = session.scan_next().unwrap();
            if progress.complete {
                return progress;
            }
        }
    }

    #[test]
    fn open_scans_only_the_first_chunk() {
        let mut bytes = b"one\ntwo\nthree\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 256 * 1024));
        let (path, session) = session("jsonl-session-open", &bytes);
        assert_eq!(
            session.progress().unwrap(),
            JsonlProgress {
                indexed_entries: 3,
                indexed_source_lines: 3,
                complete: false,
                stride: 1,
                total_entries: None,
            }
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn first_scan_exposes_entries_without_fabricating_total() {
        let mut bytes = b"one\ntwo\nthree\n".to_vec();
        bytes.extend(std::iter::repeat_n(b'x', 256 * 1024));
        let (path, session) = session("jsonl-session-first", &bytes);
        let progress = session.progress().unwrap();
        assert_eq!(progress.indexed_entries, 3);
        assert_eq!(progress.total_entries, None);
        assert_eq!(
            session.locate_entry(0).unwrap(),
            Some(EntryLocation {
                entry_ordinal: 0,
                source_line: 1,
                byte_start: 0,
                byte_end: 3,
            })
        );
        assert!(session.locate_entry(3).unwrap().is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn first_chunk_can_list_at_least_twenty_entries_while_indexing_continues() {
        let mut bytes = (0..20)
            .map(|index| format!("{index}\n"))
            .collect::<String>()
            .into_bytes();
        bytes.extend(std::iter::repeat_n(b'x', 256 * 1024));
        let (path, session) = session("jsonl-session-first-page", &bytes);

        let progress = session.progress().unwrap();
        assert!(progress.indexed_entries >= 20);
        assert!(!progress.complete);
        assert_eq!(progress.total_entries, None);

        let page = session.list_entries(0, 200).unwrap().unwrap();
        assert_eq!(page.locations.len(), 20);
        assert!(!page.has_more);
        assert_eq!(page.next_cursor, None);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn scans_cross_chunk_lines_blank_lines_and_crlf() {
        let mut bytes = vec![b'a'; 256 * 1024 - 2];
        bytes.extend_from_slice(b"\r\n\r\nsecond\r\nlast");
        let (path, mut session) = session("jsonl-session-cross", &bytes);
        let first = session.progress().unwrap();
        assert!(!first.complete);
        assert_eq!(first.indexed_entries, 1);
        assert_eq!(
            session.locate_entry(0).unwrap(),
            Some(EntryLocation {
                entry_ordinal: 0,
                source_line: 1,
                byte_start: 0,
                byte_end: (256 * 1024 - 2) as u64,
            })
        );
        assert!(session.locate_entry(1).unwrap().is_none());

        let progress = finish(&mut session);
        assert_eq!(progress.total_entries, Some(3));
        assert_eq!(progress.indexed_source_lines, 4);
        assert_eq!(
            session.locate_entry(1).unwrap(),
            Some(EntryLocation {
                entry_ordinal: 1,
                source_line: 3,
                byte_start: (256 * 1024 + 2) as u64,
                byte_end: (256 * 1024 + 8) as u64,
            })
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn completed_session_locates_first_middle_tail_and_rejects_out_of_range() {
        let (path, mut session) = session("jsonl-session-locate", b"first\nmid\nlast");
        let progress = finish(&mut session);
        assert_eq!(progress.total_entries, Some(3));
        assert!(session.locate_entry(0).unwrap().is_some());
        assert!(session.locate_entry(1).unwrap().is_some());
        assert!(session.locate_entry(2).unwrap().is_some());
        assert!(session.locate_entry(3).unwrap().is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn sparse_checkpoint_lookup_scans_forward_over_blank_lines() {
        let bytes = b"zero\n   \r\none\n";
        let path = temp_path("jsonl-session-sparse");
        fs::write(&path, bytes).unwrap();
        let source = FileSource::open(&path).unwrap();
        let session = JsonlSession {
            source,
            indexer: None,
            index: Some(JsonlIndex {
                checkpoints: vec![Checkpoint {
                    entry_ordinal: 0,
                    source_line: 1,
                    byte_offset: 0,
                }],
                total_entry_count: 2,
                total_source_line_count: 3,
                stride: 2,
            }),
            next_offset: bytes.len() as u64,
            complete: true,
        };

        assert_eq!(
            session.locate_entry(1).unwrap(),
            Some(EntryLocation {
                entry_ordinal: 1,
                source_line: 3,
                byte_start: 10,
                byte_end: 13,
            })
        );
        let page = session.list_entries(0, 200).unwrap().unwrap();
        assert_eq!(page.locations.len(), 2);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn list_entries_is_capped_at_two_hundred() {
        let bytes = (0..205)
            .map(|index| format!("{index}\n"))
            .collect::<String>();
        let (path, mut session) = session("jsonl-session-list", bytes.as_bytes());
        finish(&mut session);
        let page = session.list_entries(0, usize::MAX).unwrap().unwrap();
        assert_eq!(page.locations.len(), 200);
        assert!(page.has_more);
        assert_eq!(page.next_cursor, Some(200));
        let tail = session.list_entries(200, 200).unwrap().unwrap();
        assert_eq!(tail.locations.len(), 5);
        assert!(!tail.has_more);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_file_is_rejected_by_every_operation() {
        let (path, mut session) = session("jsonl-session-stale", b"one\ntwo\n");
        fs::write(&path, b"changed\n").unwrap();
        assert_eq!(
            session.progress().unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        assert_eq!(
            session.scan_next().unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        assert_eq!(
            session.locate_entry(0).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        assert_eq!(
            session.list_entries(0, 1).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        fs::remove_file(path).unwrap();
    }
}
