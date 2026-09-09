use std::borrow::Cow;
use std::io::{self, ErrorKind};
use std::path::Path;
use std::str::from_utf8;

use crate::conversation::{
    ConversationCandidate, ConversationStyle, GenericConversationCursor, GenericConversationPage,
};
use crate::file_source::{FileIdentity, FileSource, ReadChunk};
use crate::jsonl_entry::{inspect_entry, EntryStatus, MAX_ENTRY_BYTES, PREVIEW_BYTES};
use crate::jsonl_index::{Checkpoint, EntryLocation, JsonlIndex, JsonlIndexer};
use crate::search::{SearchError, SearchPage, SearchRequest};
use crate::semantic_detection::{Detection, NestedBudget};
use crate::tree::{NodePage, NodeProjection, StringMetrics, TextChunk, TreeDocument};

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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntrySummary {
    pub location: EntryLocation,
    pub status: EntryStatus,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EntrySummaryPage {
    pub summaries: Vec<EntrySummary>,
    pub has_more: bool,
    pub next_cursor: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OversizedPreview {
    pub location: EntryLocation,
    pub head: Vec<u8>,
    pub tail: Vec<u8>,
}

pub struct EntrySelection {
    pub summary: EntrySummary,
    pub root: Option<NodeProjection>,
}

struct LoadedEntry {
    location: EntryLocation,
    bytes: Option<Vec<u8>>,
}

pub struct JsonlSession {
    source: FileSource,
    indexer: Option<JsonlIndexer>,
    index: Option<JsonlIndex>,
    next_offset: u64,
    complete: bool,
    selected: Option<(u64, TreeDocument)>,
    selected_location: Option<EntryLocation>,
    many_invalid_utf8_warning: bool,
}

fn append_entry_byte(bytes: &mut Vec<u8>, byte: u8) -> io::Result<()> {
    if bytes.len() >= MAX_ENTRY_BYTES {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "uncached oversized JSONL entry",
        ));
    }
    bytes
        .try_reserve(1)
        .map_err(|error| io::Error::new(ErrorKind::OutOfMemory, error))?;
    bytes.push(byte);
    Ok(())
}

impl JsonlSession {
    pub fn open(path: &Path) -> io::Result<Self> {
        let mut session = Self {
            source: FileSource::open(path)?,
            indexer: Some(JsonlIndexer::new()),
            index: None,
            next_offset: 0,
            complete: false,
            selected: None,
            selected_location: None,
            many_invalid_utf8_warning: false,
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

    pub fn set_many_invalid_utf8_warning(&mut self, warning: bool) {
        self.many_invalid_utf8_warning = warning;
    }

    pub fn many_invalid_utf8_warning(&self) -> bool {
        self.many_invalid_utf8_warning
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

        if let Some(location) = self.oversized_location(ordinal) {
            return Ok(Some(location));
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
        let checkpoint = self.nearest_checkpoint(start).or_else(|| {
            self.oversized_location(start).map(|location| Checkpoint {
                entry_ordinal: start,
                source_line: location.source_line,
                byte_offset: location.byte_start,
            })
        });
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

    pub fn entry_summary(&self, ordinal: u64) -> io::Result<Option<EntrySummary>> {
        self.ensure_current()?;
        let Some(location) = self.locate_entry(ordinal)? else {
            return Ok(None);
        };
        self.summarize_location(location).map(Some)
    }

    pub fn list_entry_summaries(
        &self,
        start: u64,
        limit: usize,
    ) -> io::Result<Option<EntrySummaryPage>> {
        self.ensure_current()?;
        let Some(page) = self.list_entries(start, limit)? else {
            return Ok(None);
        };
        let summaries = page
            .locations
            .into_iter()
            .map(|location| self.summarize_location(location))
            .collect::<io::Result<Vec<_>>>()?;
        Ok(Some(EntrySummaryPage {
            summaries,
            has_more: page.has_more,
            next_cursor: page.next_cursor,
        }))
    }

    pub fn oversized_preview(&self, ordinal: u64) -> io::Result<Option<OversizedPreview>> {
        self.ensure_current()?;
        let Some(summary) = self.entry_summary(ordinal)? else {
            return Ok(None);
        };
        if summary.status != EntryStatus::Oversized {
            return Ok(None);
        }

        let length = summary
            .location
            .byte_end
            .checked_sub(summary.location.byte_start)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let preview_len = u64::try_from(PREVIEW_BYTES).expect("preview size exceeds u64");
        if length <= preview_len {
            return Ok(None);
        }
        let head = self.read_range(summary.location.byte_start, preview_len)?;
        let tail_start = summary
            .location
            .byte_end
            .checked_sub(preview_len)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let tail = self.read_range(tail_start, preview_len)?;
        self.ensure_current()?;
        Ok(Some(OversizedPreview {
            location: summary.location,
            head,
            tail,
        }))
    }

    pub fn select_entry(&mut self, ordinal: u64) -> io::Result<Option<EntrySelection>> {
        self.selected = None;
        self.selected_location = None;
        self.ensure_current()?;
        let Some(loaded) = self.load_entry_once(ordinal)? else {
            self.ensure_current()?;
            return Ok(None);
        };
        let location = loaded.location;
        let length = location
            .byte_end
            .checked_sub(location.byte_start)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let (status, tree) = match loaded.bytes {
            None => (EntryStatus::Oversized, None),
            Some(_bytes)
                if length > u64::try_from(MAX_ENTRY_BYTES).expect("entry size exceeds u64") =>
            {
                (EntryStatus::Oversized, None)
            }
            Some(bytes) if from_utf8(&bytes).is_err() => (EntryStatus::InvalidUtf8, None),
            Some(bytes) => match TreeDocument::from_bytes(bytes) {
                Ok(tree) => (EntryStatus::Valid, Some(tree)),
                Err(error) => (EntryStatus::InvalidJson(error), None),
            },
        };
        self.ensure_current()?;
        let root = tree.as_ref().map(TreeDocument::root);
        if let Some(tree) = tree {
            self.selected = Some((ordinal, tree));
        }
        self.selected_location = Some(location);
        Ok(Some(EntrySelection {
            summary: EntrySummary { location, status },
            root,
        }))
    }

    pub fn selected_ordinal(&self) -> io::Result<Option<u64>> {
        self.ensure_current()?;
        Ok(self.selected.as_ref().map(|(ordinal, _)| *ordinal))
    }

    pub fn selected_root(&self) -> io::Result<Option<NodeProjection>> {
        self.ensure_current()?;
        Ok(self.selected.as_ref().map(|(_, tree)| tree.root()))
    }

    pub fn selected_node(&self, node_id: usize) -> io::Result<Option<NodeProjection>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.node(node_id)))
    }

    pub fn selected_children(
        &self,
        parent_id: usize,
        cursor: usize,
        limit: usize,
    ) -> io::Result<Option<NodePage>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.children(parent_id, cursor, limit)))
    }

    pub fn read_raw_text(
        &self,
        offset: usize,
        requested_len: usize,
    ) -> io::Result<Option<TextChunk>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.read_raw_text(offset, requested_len)))
    }

    pub fn read_decoded_text(
        &self,
        node_id: usize,
        offset: usize,
        requested_len: usize,
    ) -> io::Result<Option<TextChunk>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.read_decoded_text(node_id, offset, requested_len)))
    }

    pub fn detect_string(&self, node_id: usize) -> io::Result<Option<Detection>> {
        self.detect_string_with_budget(node_id, NestedBudget::default())
    }

    pub fn selected_decoded_text(&self, node_id: usize) -> io::Result<Option<Cow<'_, str>>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.decoded_text(node_id)))
    }

    pub fn selected_decoded_text_limited(
        &self,
        node_id: usize,
        max_bytes: usize,
    ) -> io::Result<Option<Cow<'_, str>>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.decoded_text_limited(node_id, max_bytes)))
    }

    pub fn selected_decoded_text_len(&self, node_id: usize) -> io::Result<Option<usize>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.decoded_text_len(node_id)))
    }

    pub fn selected_string_metrics(&self, node_id: usize) -> io::Result<Option<StringMetrics>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.string_metrics(node_id)))
    }

    pub fn selected_raw_text(&self, node_id: usize) -> io::Result<Option<&str>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.raw_text(node_id)))
    }

    pub fn selected_path(&self, node_id: usize) -> io::Result<Option<String>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.path(node_id)))
    }

    pub fn detect_string_with_budget(
        &self,
        node_id: usize,
        budget: NestedBudget,
    ) -> io::Result<Option<Detection>> {
        self.ensure_current()?;
        Ok(self
            .selected
            .as_ref()
            .and_then(|(_, tree)| tree.detect_string_with_budget(node_id, budget)))
    }

    pub fn selected_search(
        &self,
        request: SearchRequest,
    ) -> io::Result<Option<Result<SearchPage, SearchError>>> {
        self.ensure_current()?;
        Ok(self.selected.as_ref().map(|(_, tree)| tree.search(request)))
    }

    pub fn selected_conversation_candidate(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
    ) -> io::Result<Option<ConversationCandidate>> {
        self.ensure_current()?;
        let Some((_, tree)) = self.selected.as_ref() else {
            return Ok(None);
        };
        Ok(tree.conversation_candidate(scope_root_id, candidate_node_id))
    }

    pub fn selected_generic_conversation_page(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
        cursor: Option<GenericConversationCursor>,
        limit: usize,
    ) -> io::Result<Option<GenericConversationPage>> {
        self.ensure_current()?;
        let Some((_, tree)) = self.selected.as_ref() else {
            return Ok(None);
        };
        Ok(tree.conversation_page(
            scope_root_id,
            candidate_node_id,
            cursor,
            limit,
            ConversationStyle::Generic,
        ))
    }

    pub fn selected_conversation_page(
        &self,
        scope_root_id: usize,
        candidate_node_id: usize,
        cursor: Option<GenericConversationCursor>,
        limit: usize,
        style: ConversationStyle,
    ) -> io::Result<Option<GenericConversationPage>> {
        self.ensure_current()?;
        let Some((_, tree)) = self.selected.as_ref() else {
            return Ok(None);
        };
        Ok(tree.conversation_page(scope_root_id, candidate_node_id, cursor, limit, style))
    }

    pub fn selected_raw_range(&self) -> io::Result<Option<(u64, u64)>> {
        self.ensure_current()?;
        self.selected_location
            .as_ref()
            .map(|location| (location.byte_start, location.byte_end))
            .map_or(Ok(None), |(start, end)| {
                if end < start {
                    Err(ErrorKind::InvalidData.into())
                } else {
                    Ok(Some((start, end)))
                }
            })
    }

    pub fn read_selected_raw_window(
        &self,
        offset: u64,
        length: usize,
    ) -> io::Result<Option<ReadChunk>> {
        self.ensure_current()?;
        let Some(location) = self.selected_location.as_ref() else {
            return Ok(None);
        };
        if length == 0 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "length must be greater than zero",
            ));
        }
        let entry_length = location
            .byte_end
            .checked_sub(location.byte_start)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        if offset > entry_length {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "offset exceeds selected Entry length",
            ));
        }
        if offset == entry_length {
            self.ensure_current()?;
            return Ok(Some(ReadChunk {
                start: offset,
                bytes: Vec::new(),
                has_more: false,
                next_offset: None,
            }));
        }

        let requested = u64::try_from(length)
            .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "length exceeds u64"))?
            .min(256 * 1024)
            .min(entry_length - offset);
        let absolute_offset = location
            .byte_start
            .checked_add(offset)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let requested_usize =
            usize::try_from(requested).map_err(|_| io::Error::from(ErrorKind::InvalidData))?;
        let chunk = self.source.read_chunk(absolute_offset, requested_usize)?;
        if chunk.start != absolute_offset || chunk.bytes.is_empty() {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "file ended before the selected JSONL entry range",
            ));
        }
        let read = u64::try_from(chunk.bytes.len()).expect("chunk length exceeds u64");
        if read > requested {
            return Err(ErrorKind::InvalidData.into());
        }
        let next = offset
            .checked_add(read)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        if next > entry_length {
            return Err(ErrorKind::InvalidData.into());
        }
        self.ensure_current()?;
        let has_more = next < entry_length;
        Ok(Some(ReadChunk {
            start: offset,
            bytes: chunk.bytes,
            has_more,
            next_offset: has_more.then_some(next),
        }))
    }

    pub fn read_selected_entry_bytes(
        &self,
        offset: u64,
        length: usize,
    ) -> io::Result<Option<ReadChunk>> {
        self.ensure_current()?;
        let Some(location) = self.selected_location.as_ref() else {
            return Ok(None);
        };
        let entry_length = location
            .byte_end
            .checked_sub(location.byte_start)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        if length == 0 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "length must be greater than zero",
            ));
        }
        if self.selected.is_some() {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "selected Entry is valid; use read_raw_slice",
            ));
        }
        if entry_length > u64::try_from(MAX_ENTRY_BYTES).expect("entry size exceeds u64") {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "selected Entry is oversized; use get_oversized_preview",
            ));
        }
        if offset > entry_length {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "offset exceeds selected Entry length",
            ));
        }
        if offset == entry_length {
            self.ensure_current()?;
            return Ok(Some(ReadChunk {
                start: offset,
                bytes: Vec::new(),
                has_more: false,
                next_offset: None,
            }));
        }

        let requested = u64::try_from(length)
            .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "length exceeds u64"))?
            .min(128 * 1024)
            .min(entry_length - offset);
        let absolute_offset = location
            .byte_start
            .checked_add(offset)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let requested_usize =
            usize::try_from(requested).map_err(|_| io::Error::from(ErrorKind::InvalidData))?;
        let chunk = self.source.read_chunk(absolute_offset, requested_usize)?;
        if chunk.start != absolute_offset || chunk.bytes.is_empty() {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "file ended before the selected JSONL entry range",
            ));
        }
        let read = u64::try_from(chunk.bytes.len()).expect("chunk length exceeds u64");
        if read > requested {
            return Err(ErrorKind::InvalidData.into());
        }
        let next = offset
            .checked_add(read)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        if next > entry_length {
            return Err(ErrorKind::InvalidData.into());
        }
        let has_more = next < entry_length;
        let next_offset = has_more.then_some(next);
        self.ensure_current()?;
        Ok(Some(ReadChunk {
            start: offset,
            bytes: chunk.bytes,
            has_more,
            next_offset,
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

    fn load_entry_once(&self, ordinal: u64) -> io::Result<Option<LoadedEntry>> {
        self.ensure_current()?;
        if ordinal >= self.indexed_entries_unchecked() {
            return Ok(None);
        }
        if let Some(location) = self.oversized_location(ordinal) {
            return Ok(Some(LoadedEntry {
                location,
                bytes: None,
            }));
        }

        let Some(checkpoint) = self.nearest_checkpoint(ordinal) else {
            return Ok(None);
        };
        if checkpoint.entry_ordinal > ordinal {
            return Ok(None);
        }

        let mut offset = checkpoint.byte_offset;
        let mut line_start = checkpoint.byte_offset;
        let mut source_line = checkpoint.source_line;
        let mut current_ordinal = checkpoint.entry_ordinal;
        let mut line_has_content = false;
        let mut last_byte = None;
        let mut pending_target_cr = false;
        let mut target_bytes = Vec::new();

        loop {
            if let Some(location) = self.oversized_location(current_ordinal) {
                if location.byte_start == line_start && offset <= location.byte_end {
                    if current_ordinal == ordinal {
                        return Ok(Some(LoadedEntry {
                            location,
                            bytes: None,
                        }));
                    }
                    current_ordinal = current_ordinal
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    let Some(next_offset) = self.next_after_cached_line(location)? else {
                        break;
                    };
                    source_line = source_line
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    line_start = next_offset;
                    offset = next_offset;
                    line_has_content = false;
                    last_byte = None;
                    pending_target_cr = false;
                    continue;
                }
            }

            let chunk = self.source.read_chunk(offset, usize::MAX)?;
            if chunk.bytes.is_empty() {
                if chunk.has_more {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "file ended before the requested JSONL entry",
                    ));
                }
                if line_has_content && current_ordinal == ordinal {
                    if pending_target_cr {
                        append_entry_byte(&mut target_bytes, b'\r')?;
                    }
                    return Ok(Some(LoadedEntry {
                        location: EntryLocation {
                            entry_ordinal: ordinal,
                            source_line,
                            byte_start: line_start,
                            byte_end: offset,
                        },
                        bytes: Some(target_bytes),
                    }));
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
                    if !line_has_content && current_ordinal == ordinal {
                        target_bytes.clear();
                    }
                    if line_has_content && line_start < content_end {
                        if current_ordinal == ordinal {
                            return Ok(Some(LoadedEntry {
                                location: EntryLocation {
                                    entry_ordinal: ordinal,
                                    source_line,
                                    byte_start: line_start,
                                    byte_end: content_end,
                                },
                                bytes: Some(target_bytes),
                            }));
                        }
                        current_ordinal = current_ordinal
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
                    pending_target_cr = false;
                } else {
                    if current_ordinal == ordinal {
                        if pending_target_cr {
                            append_entry_byte(&mut target_bytes, b'\r')?;
                            pending_target_cr = false;
                        }
                        if byte == b'\r' {
                            pending_target_cr = true;
                        } else {
                            append_entry_byte(&mut target_bytes, byte)?;
                        }
                    }
                    if !matches!(byte, b' ' | b'\t' | b'\r') {
                        line_has_content = true;
                    }
                    last_byte = Some(byte);
                }
            }

            offset = if chunk.has_more {
                chunk.next_offset.ok_or_else(|| {
                    io::Error::new(
                        ErrorKind::InvalidData,
                        "JSONL chunk omitted its next offset",
                    )
                })?
            } else {
                chunk
                    .start
                    .checked_add(chunk.bytes.len() as u64)
                    .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?
            };
        }

        self.ensure_current()?;
        Ok(None)
    }

    fn oversized_location(&self, ordinal: u64) -> Option<EntryLocation> {
        self.index.as_ref().map_or_else(
            || {
                self.indexer
                    .as_ref()
                    .expect("indexer exists")
                    .oversized_location(ordinal)
            },
            |index| index.oversized_location(ordinal),
        )
    }

    fn summarize_location(&self, location: EntryLocation) -> io::Result<EntrySummary> {
        let length = location
            .byte_end
            .checked_sub(location.byte_start)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        let status = if length > u64::try_from(MAX_ENTRY_BYTES).expect("entry size exceeds u64") {
            EntryStatus::Oversized
        } else {
            let bytes = self.read_range(location.byte_start, length)?;
            inspect_entry(&bytes)
        };
        self.ensure_current()?;
        Ok(EntrySummary { location, status })
    }

    fn read_range(&self, start: u64, length: u64) -> io::Result<Vec<u8>> {
        let end = start
            .checked_add(length)
            .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        if end > self.source.identity().size {
            return Err(ErrorKind::InvalidData.into());
        }

        let capacity = usize::try_from(length).map_err(|_| {
            io::Error::new(
                ErrorKind::InvalidData,
                "entry range exceeds addressable memory",
            )
        })?;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(capacity)
            .map_err(|error| io::Error::new(ErrorKind::OutOfMemory, error))?;
        let mut offset = start;
        while offset < end {
            let remaining = end - offset;
            let requested = usize::try_from(remaining).map_err(|_| {
                io::Error::new(
                    ErrorKind::InvalidData,
                    "entry range exceeds addressable memory",
                )
            })?;
            let chunk = self.source.read_chunk(offset, requested)?;
            if chunk.bytes.is_empty() {
                return Err(io::Error::new(
                    ErrorKind::UnexpectedEof,
                    "file ended before the requested JSONL range",
                ));
            }
            let read = u64::try_from(chunk.bytes.len()).expect("chunk length exceeds u64");
            if read > remaining {
                return Err(ErrorKind::InvalidData.into());
            }
            bytes.extend_from_slice(&chunk.bytes);
            offset = offset
                .checked_add(read)
                .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
        }
        self.ensure_current()?;
        Ok(bytes)
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
            if let Some(location) = self.oversized_location(ordinal) {
                if location.byte_start == line_start && offset <= location.byte_end {
                    if ordinal >= first_ordinal && locations.len() < requested {
                        locations.push(location);
                        if locations.len() == requested {
                            self.ensure_current()?;
                            return Ok(locations);
                        }
                    }
                    ordinal = ordinal
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    let Some(next_offset) = self.next_after_cached_line(location)? else {
                        break;
                    };
                    source_line = source_line
                        .checked_add(1)
                        .ok_or_else(|| io::Error::from(ErrorKind::InvalidData))?;
                    line_start = next_offset;
                    offset = next_offset;
                    line_has_content = false;
                    last_byte = None;
                    continue;
                }
            }

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

    fn next_after_cached_line(&self, location: EntryLocation) -> io::Result<Option<u64>> {
        let file_size = self.source.identity().size;
        if location.byte_end > file_size {
            return Err(ErrorKind::InvalidData.into());
        }
        if location.byte_end == file_size {
            return Ok(None);
        }
        let delimiter = self.source.read_chunk(location.byte_end, 2)?;
        let Some(&first) = delimiter.bytes.first() else {
            return Err(io::Error::new(
                ErrorKind::UnexpectedEof,
                "file ended before the oversized JSONL delimiter",
            ));
        };
        if first == b'\n' {
            return location
                .byte_end
                .checked_add(1)
                .map(Some)
                .ok_or_else(|| io::Error::from(ErrorKind::InvalidData));
        }
        if first == b'\r' && delimiter.bytes.get(1) == Some(&b'\n') {
            return location
                .byte_end
                .checked_add(2)
                .map(Some)
                .ok_or_else(|| io::Error::from(ErrorKind::InvalidData));
        }
        Err(io::Error::new(
            ErrorKind::InvalidData,
            "cached oversized JSONL span has no LF delimiter",
        ))
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
                oversized_locations: Vec::new(),
                total_entry_count: 2,
                total_source_line_count: 3,
                stride: 2,
            }),
            next_offset: bytes.len() as u64,
            complete: true,
            selected: None,
            selected_location: None,
            many_invalid_utf8_warning: false,
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
        assert!(session
            .index
            .as_ref()
            .expect("completed session index")
            .oversized_locations
            .is_empty());
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
    fn entry_summaries_keep_invalid_rows_independent() {
        let bytes = b"{\"ok\":true}\n{\"bad\":\xff}\n{\n{\"after\":1}\r\n";
        let (path, session) = session("jsonl-session-statuses", bytes);
        let page = session.list_entry_summaries(0, 200).unwrap().unwrap();
        assert_eq!(page.summaries.len(), 4);
        assert_eq!(page.summaries[0].status, EntryStatus::Valid);
        assert_eq!(page.summaries[1].status, EntryStatus::InvalidUtf8);
        assert!(matches!(
            page.summaries[2].status,
            EntryStatus::InvalidJson(_)
        ));
        assert_eq!(page.summaries[3].status, EntryStatus::Valid);
        assert_eq!(page.summaries[3].location.source_line, 4);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selects_valid_object_and_exposes_tree_and_text_views() {
        let (path, mut session) = session(
            "jsonl-session-select-object",
            br#"{"name":"Ada","items":[true,false]}"#.as_ref(),
        );
        let selection = session.select_entry(0).unwrap().unwrap();
        assert_eq!(selection.summary.status, EntryStatus::Valid);
        let root = selection.root.expect("valid entry root");
        assert_eq!(root.kind, crate::json::JsonKind::Object);
        assert_eq!(root.child_count, 2);
        assert_eq!(session.selected_ordinal().unwrap(), Some(0));
        assert_eq!(
            session.selected_root().unwrap().unwrap().kind,
            crate::json::JsonKind::Object
        );

        let children = session.selected_children(root.id, 0, 200).unwrap().unwrap();
        assert_eq!(children.nodes[0].label, "name");
        assert_eq!(children.nodes[1].label, "items");
        let name = session
            .selected_node(children.nodes[0].id)
            .unwrap()
            .unwrap();
        assert_eq!(name.value_preview.as_deref(), Some("Ada"));

        let raw = session.read_raw_text(0, usize::MAX).unwrap().unwrap();
        assert_eq!(raw.text, r#"{"name":"Ada","items":[true,false]}"#);
        let decoded = session
            .read_decoded_text(name.id, 0, usize::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(decoded.text, "Ada");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selects_array_and_scalar_entries() {
        let (path, mut session) = session("jsonl-session-select-kinds", b"[1,2]\nfalse\n");
        let array = session.select_entry(0).unwrap().unwrap();
        assert_eq!(array.summary.status, EntryStatus::Valid);
        assert_eq!(array.root.unwrap().kind, crate::json::JsonKind::Array);
        let scalar = session.select_entry(1).unwrap().unwrap();
        assert_eq!(scalar.summary.status, EntryStatus::Valid);
        let root = scalar.root.unwrap();
        assert_eq!(root.kind, crate::json::JsonKind::False);
        assert_eq!(root.child_count, 0);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selecting_a_large_valid_entry_reads_across_chunks_once() {
        let value = "a".repeat(300_000);
        let input = format!(r#"{{"text":"{value}"}}"#);
        let (path, mut session) = session("jsonl-session-select-large", input.as_bytes());
        finish(&mut session);
        let selection = session.select_entry(0).unwrap().unwrap();
        assert_eq!(selection.summary.status, EntryStatus::Valid);
        let root = selection.root.unwrap();
        let child = session
            .selected_children(root.id, 0, 1)
            .unwrap()
            .unwrap()
            .nodes[0]
            .id;
        let mut decoded_len = 0;
        let mut offset = Some(0);
        while let Some(current_offset) = offset {
            let decoded = session
                .read_decoded_text(child, current_offset, usize::MAX)
                .unwrap()
                .unwrap();
            decoded_len += decoded.text.len();
            offset = decoded.next_offset;
        }
        assert_eq!(decoded_len, value.len());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn invalid_and_out_of_range_selection_clears_the_previous_tree() {
        let bytes = b"{\"ok\":true}\n{\n\"bad\":\xff\n";
        let (path, mut session) = session("jsonl-session-select-invalid", bytes);
        assert!(session.select_entry(0).unwrap().unwrap().root.is_some());

        let invalid_json = session.select_entry(1).unwrap().unwrap();
        assert!(matches!(
            invalid_json.summary.status,
            EntryStatus::InvalidJson(_)
        ));
        assert!(invalid_json.root.is_none());
        assert_eq!(session.selected_ordinal().unwrap(), None);
        assert!(session.selected_root().unwrap().is_none());

        let invalid_utf8 = session.select_entry(2).unwrap().unwrap();
        assert_eq!(invalid_utf8.summary.status, EntryStatus::InvalidUtf8);
        assert!(invalid_utf8.root.is_none());
        assert!(session.select_entry(99).unwrap().is_none());
        assert!(session.selected_node(0).unwrap().is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn selecting_after_blank_lines_keeps_the_target_span_exact() {
        let bytes = b"zero\n  \t\r\n{\"ok\":1}\n";
        let (path, mut session) = session("jsonl-session-select-blank", bytes);
        let selection = session.select_entry(1).unwrap().unwrap();
        assert_eq!(selection.summary.status, EntryStatus::Valid);
        let root = selection.root.unwrap();
        assert_eq!(selection.summary.location.byte_start, 10);
        assert_eq!(selection.summary.location.byte_end, 18);
        assert_eq!(root.span.start, 0);
        assert_eq!(root.span.end, 8);
        let raw = session.read_raw_text(0, usize::MAX).unwrap().unwrap();
        assert_eq!(raw.text, r#"{"ok":1}"#);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn an_entry_at_exactly_the_limit_is_read_and_parsed() {
        let mut bytes = Vec::with_capacity(MAX_ENTRY_BYTES + 1);
        bytes.push(b'0');
        bytes.extend(std::iter::repeat_n(b' ', MAX_ENTRY_BYTES - 1));
        bytes.push(b'\n');
        let (path, mut session) = session("jsonl-session-exact-limit", &bytes);
        finish(&mut session);

        let summary = session.entry_summary(0).unwrap().unwrap();
        assert_eq!(summary.status, EntryStatus::Valid);
        assert_eq!(
            summary.location.byte_end - summary.location.byte_start,
            MAX_ENTRY_BYTES as u64
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn oversized_entry_returns_bounded_head_and_tail_and_keeps_following_rows() {
        let mut bytes = Vec::with_capacity(MAX_ENTRY_BYTES + 32);
        bytes.push(0xff);
        bytes.extend(std::iter::repeat_n(b'a', MAX_ENTRY_BYTES));
        bytes.push(b'\n');
        let following = br#"{"ok":true}"#;
        let following_start = bytes.len();
        bytes.extend_from_slice(following);
        bytes.push(b'\n');
        let (path, mut session) = session("jsonl-session-oversized", &bytes);
        finish(&mut session);

        let oversized = session.entry_summary(0).unwrap().unwrap();
        assert_eq!(oversized.status, EntryStatus::Oversized);
        let cached_location = session
            .index
            .as_ref()
            .expect("completed session index")
            .oversized_location(0)
            .expect("oversized span is cached");
        assert_eq!(cached_location, oversized.location);
        assert_eq!(
            session
                .index
                .as_ref()
                .expect("completed session index")
                .oversized_locations
                .len(),
            1
        );
        let valid = session.entry_summary(1).unwrap().unwrap();
        assert_eq!(valid.status, EntryStatus::Valid);
        assert_eq!(valid.location.byte_start, following_start as u64);

        assert!(session.select_entry(1).unwrap().unwrap().root.is_some());
        let oversized_selection = session.select_entry(0).unwrap().unwrap();
        assert_eq!(oversized_selection.summary.status, EntryStatus::Oversized);
        assert!(oversized_selection.root.is_none());
        assert_eq!(session.selected_ordinal().unwrap(), None);
        assert!(session.selected_root().unwrap().is_none());

        session
            .index
            .as_mut()
            .expect("completed session index")
            .checkpoints
            .clear();
        let locations = session.list_entries(0, 2).unwrap().unwrap();
        assert_eq!(locations.locations.len(), 2);
        assert_eq!(locations.locations[0], oversized.location);
        assert_eq!(locations.locations[1], valid.location);
        let summaries = session.list_entry_summaries(0, 2).unwrap().unwrap();
        assert_eq!(summaries.summaries.len(), 2);
        assert_eq!(summaries.summaries[0].status, EntryStatus::Oversized);
        assert_eq!(summaries.summaries[1].status, EntryStatus::Valid);
        let preview = session.oversized_preview(0).unwrap().unwrap();
        assert_eq!(preview.location, oversized.location);
        assert_eq!(preview.head.len(), PREVIEW_BYTES);
        assert_eq!(preview.tail.len(), PREVIEW_BYTES);
        assert_eq!(preview.head[0], 0xff);
        assert!(preview.head[1..].iter().all(|&byte| byte == b'a'));
        assert!(preview.tail.iter().all(|&byte| byte == b'a'));
        assert!(session.oversized_preview(1).unwrap().is_none());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn entry_summary_page_is_capped_and_carries_statuses() {
        let bytes = (0..205)
            .map(|index| format!("{index}\n"))
            .collect::<String>();
        let (path, mut session) = session("jsonl-session-summary-page", bytes.as_bytes());
        finish(&mut session);
        let page = session
            .list_entry_summaries(0, usize::MAX)
            .unwrap()
            .unwrap();
        assert_eq!(page.summaries.len(), 200);
        assert!(page.has_more);
        assert_eq!(page.next_cursor, Some(200));
        assert!(page
            .summaries
            .iter()
            .all(|summary| summary.status == EntryStatus::Valid));
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
        assert_eq!(
            session.entry_summary(0).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        assert_eq!(
            session.list_entry_summaries(0, 1).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        assert_eq!(
            session.oversized_preview(0).unwrap_err().kind(),
            ErrorKind::InvalidData
        );
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn stale_file_is_rejected_by_selected_tree_operations() {
        let (path, mut session) = session("jsonl-session-selected-stale", b"{\"ok\":true}\n");
        let selection = session.select_entry(0).unwrap().unwrap();
        let root = selection.root.unwrap();
        fs::write(&path, b"changed\n").unwrap();

        for result in [
            session
                .selected_ordinal()
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .selected_root()
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .selected_node(root.id)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .selected_children(root.id, 0, 1)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .read_raw_text(0, 1)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .read_decoded_text(root.id, 0, 1)
                .map(|_| ())
                .map_err(|error| error.kind()),
            session
                .select_entry(0)
                .map(|_| ())
                .map_err(|error| error.kind()),
        ] {
            assert_eq!(result, Err(ErrorKind::InvalidData));
        }
        fs::remove_file(path).unwrap();
    }
}
