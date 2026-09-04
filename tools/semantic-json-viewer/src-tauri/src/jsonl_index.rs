use std::mem::size_of;

use crate::jsonl_entry::MAX_ENTRY_BYTES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Checkpoint {
    pub entry_ordinal: u64,
    pub source_line: u64,
    pub byte_offset: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EntryLocation {
    pub entry_ordinal: u64,
    pub source_line: u64,
    pub byte_start: u64,
    pub byte_end: u64,
}

const ENTRY_CHECKPOINT_LIMIT: u64 = 4_000_000;
const CHECKPOINT_MEMORY_LIMIT_BYTES: u64 = 128 * 1024 * 1024;
const MEMORY_CHECKPOINT_LIMIT: u64 = CHECKPOINT_MEMORY_LIMIT_BYTES / size_of::<Checkpoint>() as u64;
const CHECKPOINT_COUNT_LIMIT: u64 = if ENTRY_CHECKPOINT_LIMIT < MEMORY_CHECKPOINT_LIMIT {
    ENTRY_CHECKPOINT_LIMIT
} else {
    MEMORY_CHECKPOINT_LIMIT
};

#[derive(Debug)]
pub struct JsonlIndexer {
    byte_offset: u64,
    source_line_count: u64,
    entry_count: u64,
    checkpoints: Vec<Checkpoint>,
    // At most one cached span per >16 MiB line; ordinary entries stay checkpoint-only.
    oversized_locations: Vec<EntryLocation>,
    stride: u64,
    line_start_byte: u64,
    in_line: bool,
    line_has_content: bool,
    line_last_byte: Option<u8>,
}

impl Default for JsonlIndexer {
    fn default() -> Self {
        Self {
            byte_offset: 0,
            source_line_count: 0,
            entry_count: 0,
            checkpoints: Vec::new(),
            oversized_locations: Vec::new(),
            stride: 1,
            line_start_byte: 0,
            in_line: false,
            line_has_content: false,
            line_last_byte: None,
        }
    }
}

impl JsonlIndexer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entry_count(&self) -> u64 {
        self.entry_count
    }

    pub fn indexed_through_line(&self) -> u64 {
        self.source_line_count
    }

    pub fn stride(&self) -> u64 {
        self.stride
    }

    pub fn nearest_checkpoint(&self, ordinal: u64) -> Option<Checkpoint> {
        match self
            .checkpoints
            .binary_search_by(|checkpoint| checkpoint.entry_ordinal.cmp(&ordinal))
        {
            Ok(index) => self.checkpoints.get(index).copied(),
            Err(0) => None,
            Err(next_index) => self.checkpoints.get(next_index - 1).copied(),
        }
    }

    pub fn oversized_location(&self, ordinal: u64) -> Option<EntryLocation> {
        self.oversized_locations
            .binary_search_by(|location| location.entry_ordinal.cmp(&ordinal))
            .ok()
            .and_then(|index| self.oversized_locations.get(index).copied())
    }

    pub fn feed(&mut self, chunk: &[u8]) {
        let chunk_start = self.byte_offset;
        let chunk_length = u64::try_from(chunk.len()).expect("chunk length exceeds u64");
        self.byte_offset = self
            .byte_offset
            .checked_add(chunk_length)
            .expect("JSONL byte offset overflow");

        for (offset, &byte) in chunk.iter().enumerate() {
            if byte == b'\n' {
                let delimiter_offset = chunk_start
                    .checked_add(u64::try_from(offset).expect("offset exceeds u64"))
                    .expect("JSONL byte offset overflow");
                self.record_line(
                    self.line_start_byte,
                    delimiter_offset,
                    self.line_has_content,
                    self.line_last_byte == Some(b'\r'),
                );
                self.line_last_byte = None;
                self.in_line = false;
                self.line_has_content = false;
                self.line_start_byte = delimiter_offset
                    .checked_add(1)
                    .expect("JSONL byte offset overflow");
            } else {
                self.in_line = true;
                if !matches!(byte, b' ' | b'\t' | b'\r') {
                    self.line_has_content = true;
                }
                self.line_last_byte = Some(byte);
            }
        }
    }

    pub fn finish(mut self) -> JsonlIndex {
        if self.in_line {
            self.record_line(
                self.line_start_byte,
                self.byte_offset,
                self.line_has_content,
                false,
            );
            self.in_line = false;
            self.line_has_content = false;
            self.line_last_byte = None;
        }

        JsonlIndex {
            checkpoints: self.checkpoints,
            oversized_locations: self.oversized_locations,
            total_entry_count: self.entry_count,
            total_source_line_count: self.source_line_count,
            stride: self.stride,
        }
    }

    fn record_line(
        &mut self,
        start: u64,
        end_before_delimiter: u64,
        has_content: bool,
        is_crlf: bool,
    ) {
        let end = if is_crlf {
            end_before_delimiter
                .checked_sub(1)
                .expect("CRLF delimiter precedes line start")
        } else {
            end_before_delimiter
        };
        let source_line = self
            .source_line_count
            .checked_add(1)
            .expect("JSONL source line overflow");
        self.source_line_count = source_line;

        if has_content && start < end {
            let entry_ordinal = self.entry_count;
            if end - start > u64::try_from(MAX_ENTRY_BYTES).expect("entry size exceeds u64") {
                self.oversized_locations.push(EntryLocation {
                    entry_ordinal,
                    source_line,
                    byte_start: start,
                    byte_end: end,
                });
            }
            self.push_checkpoint(Checkpoint {
                entry_ordinal,
                source_line,
                byte_offset: start,
            });
            self.entry_count = self
                .entry_count
                .checked_add(1)
                .expect("JSONL entry count overflow");
        }
    }

    fn push_checkpoint(&mut self, checkpoint: Checkpoint) {
        if !checkpoint.entry_ordinal.is_multiple_of(self.stride) {
            return;
        }
        if self.checkpoints.len() as u64 >= CHECKPOINT_COUNT_LIMIT {
            self.downsample_checkpoints();
            if !checkpoint.entry_ordinal.is_multiple_of(self.stride) {
                return;
            }
        }
        self.checkpoints.push(checkpoint);
    }

    fn downsample_checkpoints(&mut self) {
        let next_stride = self
            .stride
            .checked_mul(2)
            .expect("checkpoint stride overflow");
        self.stride = next_stride;
        self.checkpoints
            .retain(|checkpoint| checkpoint.entry_ordinal % next_stride == 0);
    }
}

#[derive(Debug, Eq, PartialEq)]
pub struct JsonlIndex {
    pub checkpoints: Vec<Checkpoint>,
    pub(crate) oversized_locations: Vec<EntryLocation>,
    pub total_entry_count: u64,
    pub total_source_line_count: u64,
    pub stride: u64,
}

impl JsonlIndex {
    pub fn nearest_checkpoint(&self, ordinal: u64) -> Option<Checkpoint> {
        match self
            .checkpoints
            .binary_search_by(|checkpoint| checkpoint.entry_ordinal.cmp(&ordinal))
        {
            Ok(index) => self.checkpoints.get(index).copied(),
            Err(0) => None,
            Err(next_index) => self.checkpoints.get(next_index - 1).copied(),
        }
    }

    pub fn oversized_location(&self, ordinal: u64) -> Option<EntryLocation> {
        self.oversized_locations
            .binary_search_by(|location| location.entry_ordinal.cmp(&ordinal))
            .ok()
            .and_then(|index| self.oversized_locations.get(index).copied())
    }

    pub fn locate(&self, bytes: &[u8], ordinal: u64) -> Option<EntryLocation> {
        if ordinal >= self.total_entry_count || self.stride == 0 || !self.stride.is_power_of_two() {
            return None;
        }

        let checkpoint_index = match self
            .checkpoints
            .binary_search_by(|checkpoint| checkpoint.entry_ordinal.cmp(&ordinal))
        {
            Ok(index) => index,
            Err(0) => return None,
            Err(next_index) => next_index - 1,
        };
        let checkpoint = self.checkpoints.get(checkpoint_index)?;
        if checkpoint.entry_ordinal % self.stride != 0 {
            return None;
        }

        let mut byte_start = usize::try_from(checkpoint.byte_offset).ok()?;
        if byte_start > bytes.len() {
            return None;
        }

        let mut current_ordinal = checkpoint.entry_ordinal;
        let mut current_line = checkpoint.source_line;
        while byte_start < bytes.len() {
            let line_bytes = &bytes[byte_start..];
            let Some(relative_lf) = line_bytes.iter().position(|&byte| byte == b'\n') else {
                let content_end = bytes.len();
                let has_content = line_bytes
                    .iter()
                    .any(|&byte| !matches!(byte, b' ' | b'\t' | b'\r'));
                if has_content && current_ordinal == ordinal {
                    return Some(EntryLocation {
                        entry_ordinal: ordinal,
                        source_line: current_line,
                        byte_start: u64::try_from(byte_start).ok()?,
                        byte_end: u64::try_from(content_end).ok()?,
                    });
                }
                return None;
            };

            let lf = byte_start
                .checked_add(relative_lf)
                .expect("line terminator is within input");
            let content_end = if lf > byte_start && bytes[lf - 1] == b'\r' {
                lf - 1
            } else {
                lf
            };
            let has_content = line_bytes[..relative_lf]
                .iter()
                .any(|&byte| !matches!(byte, b' ' | b'\t' | b'\r'));
            if has_content && content_end > byte_start {
                if current_ordinal == ordinal {
                    return Some(EntryLocation {
                        entry_ordinal: ordinal,
                        source_line: current_line,
                        byte_start: u64::try_from(byte_start).ok()?,
                        byte_end: u64::try_from(content_end).ok()?,
                    });
                }
                if current_ordinal > ordinal {
                    return None;
                }
                current_ordinal = current_ordinal.checked_add(1)?;
            }

            current_line = current_line.checked_add(1)?;
            byte_start = lf.checked_add(1)?;
        }

        None
    }
}

pub fn scan_jsonl(bytes: &[u8]) -> JsonlIndex {
    let mut indexer = JsonlIndexer::new();
    indexer.feed(bytes);
    indexer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_location(
        index: &JsonlIndex,
        bytes: &[u8],
        ordinal: u64,
        source_line: u64,
        byte_start: u64,
        byte_end: u64,
    ) {
        assert_eq!(
            index.locate(bytes, ordinal),
            Some(EntryLocation {
                entry_ordinal: ordinal,
                source_line,
                byte_start,
                byte_end,
            })
        );
    }

    #[test]
    fn indexes_lf_crlf_blank_and_whitespace_lines() {
        let bytes = b"a\n\n   \r\nb\r\n\n";
        let index = scan_jsonl(bytes);

        assert_eq!(index.total_entry_count, 2);
        assert_eq!(index.total_source_line_count, 5);
        assert_eq!(index.stride, 1);
        assert_location(&index, bytes, 0, 1, 0, 1);
        assert_location(&index, bytes, 1, 4, 8, 9);
    }

    #[test]
    fn handles_chunk_boundaries_including_data_and_crlf_splits() {
        let mut indexer = JsonlIndexer::new();
        indexer.feed(b"{\"name\":\"va");
        assert_eq!(indexer.entry_count(), 0);
        assert_eq!(indexer.indexed_through_line(), 0);
        indexer.feed(b"lue\"}\r");
        assert_eq!(indexer.entry_count(), 0);
        indexer.feed(b"\n \r");
        indexer.feed(b"\nlast");

        let index = indexer.finish();
        let bytes = b"{\"name\":\"value\"}\r\n \r\nlast";

        assert_eq!(index.total_entry_count, 2);
        assert_eq!(index.total_source_line_count, 3);
        assert_location(&index, bytes, 0, 1, 0, 16);
        assert_location(&index, bytes, 1, 3, 21, 25);
    }

    #[test]
    fn default_indexer_feeds_single_entry_with_stride_one() {
        let mut indexer = JsonlIndexer::default();
        indexer.feed(b"x\n");

        let index = indexer.finish();
        assert_eq!(index.total_entry_count, 1);
        assert_eq!(index.stride, 1);
    }

    #[test]
    fn locates_first_middle_and_tail_entries() {
        let bytes = b"one\ntwo\nthree\n";
        let index = scan_jsonl(bytes);

        assert_location(&index, bytes, 0, 1, 0, 3);
        assert_location(&index, bytes, 1, 2, 4, 7);
        assert_location(&index, bytes, 2, 3, 8, 13);
    }

    #[test]
    fn locates_with_synthetic_stride_two_index() {
        let bytes = b"alpha\nbeta\ngamma\n";
        let index = JsonlIndex {
            checkpoints: vec![
                Checkpoint {
                    entry_ordinal: 0,
                    source_line: 1,
                    byte_offset: 0,
                },
                Checkpoint {
                    entry_ordinal: 2,
                    source_line: 3,
                    byte_offset: 11,
                },
            ],
            oversized_locations: Vec::new(),
            total_entry_count: 3,
            total_source_line_count: 3,
            stride: 2,
        };

        assert_location(&index, bytes, 0, 1, 0, 5);
        assert_location(&index, bytes, 1, 2, 6, 10);
        assert_location(&index, bytes, 2, 3, 11, 16);
    }

    #[test]
    fn sparse_lookup_skips_whitespace_only_lines() {
        let bytes = b"zero\n   \r\none\n";
        let index = JsonlIndex {
            checkpoints: vec![Checkpoint {
                entry_ordinal: 0,
                source_line: 1,
                byte_offset: 0,
            }],
            oversized_locations: Vec::new(),
            total_entry_count: 2,
            total_source_line_count: 3,
            stride: 2,
        };

        assert_location(&index, bytes, 1, 3, 10, 13);
    }

    #[test]
    fn checkpoint_limit_matches_entry_and_memory_caps() {
        assert_eq!(ENTRY_CHECKPOINT_LIMIT, 4_000_000);
        assert_eq!(
            MEMORY_CHECKPOINT_LIMIT,
            CHECKPOINT_MEMORY_LIMIT_BYTES / size_of::<Checkpoint>() as u64
        );
        assert_eq!(CHECKPOINT_COUNT_LIMIT, 4_000_000);
    }

    #[test]
    fn downsamples_checkpoints_only_when_pushing_at_capacity() {
        let mut indexer = JsonlIndexer::new();
        let chunk = b"x\n".repeat(4_000_000);

        indexer.feed(&chunk);
        assert_eq!(indexer.entry_count(), 4_000_000);
        assert_eq!(indexer.stride, 1);
        assert_eq!(indexer.checkpoints.len(), 4_000_000);

        indexer.feed(&chunk);
        assert_eq!(indexer.entry_count(), 8_000_000);
        assert_eq!(indexer.stride, 2);
        assert_eq!(indexer.checkpoints.len(), 4_000_000);
        assert_eq!(indexer.checkpoints[0].entry_ordinal, 0);
        assert_eq!(indexer.checkpoints[1].entry_ordinal, 2);
        assert!(indexer
            .checkpoints
            .iter()
            .all(|checkpoint| checkpoint.entry_ordinal % 2 == 0));
        assert_eq!(
            indexer
                .checkpoints
                .last()
                .map(|checkpoint| checkpoint.entry_ordinal),
            Some(7_999_998)
        );

        indexer.feed(b"x\n");
        assert_eq!(indexer.entry_count(), 8_000_001);
        assert_eq!(indexer.stride, 4);
        assert_eq!(indexer.checkpoints.len(), 2_000_001);
        assert_eq!(indexer.checkpoints[0].entry_ordinal, 0);
        assert_eq!(indexer.checkpoints[1].entry_ordinal, 4);
        assert!(indexer
            .checkpoints
            .iter()
            .all(|checkpoint| checkpoint.entry_ordinal % 4 == 0));
        assert_eq!(
            indexer
                .checkpoints
                .last()
                .map(|checkpoint| checkpoint.entry_ordinal),
            Some(8_000_000)
        );
    }

    #[test]
    fn locate_returns_none_for_out_of_range_or_mismatched_stride() {
        let bytes = b"one\ntwo\n";
        let mut index = scan_jsonl(bytes);
        assert_eq!(index.locate(bytes, 2), None);

        index.stride = 4;
        assert_eq!(index.locate(bytes, 1), None);
    }
}
