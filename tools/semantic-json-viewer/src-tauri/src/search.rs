use std::fmt;
use std::str;

use crate::json::{
    ChildLocator, DecodedScalarIter, DecodedString, JsonKind, ParsedJson, SourceSpan,
};

pub const MAX_QUERY_BYTES: usize = 4096;
pub const MAX_PAGE_SIZE: usize = 50;
pub const MAX_SCAN_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_PATH_BYTES: usize = 2048;
const MAX_PATH_LABEL_CHARS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchMode {
    Decoded,
    Raw,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchPhase {
    Key,
    Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchCursor {
    pub mode: SearchMode,
    pub query: String,
    pub node_id: Option<usize>,
    pub unit: usize,
    pub phase: SearchPhase,
    pub offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchRequest {
    pub mode: SearchMode,
    pub query: String,
    pub cursor: Option<SearchCursor>,
    pub limit: usize,
    pub node_id: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchField {
    Key,
    Value,
    RawSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchMatch {
    pub node_id: Option<usize>,
    pub field: SearchField,
    pub path: Vec<String>,
    pub path_truncated: bool,
    pub span: SourceSpan,
    pub match_start: usize,
    pub match_end: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchPage {
    pub matches: Vec<SearchMatch>,
    pub has_more: bool,
    pub next_cursor: Option<SearchCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SearchError {
    EmptyQuery,
    QueryTooLong,
    InvalidLimit,
    CursorMismatch,
    InvalidCursor,
    InvalidTarget,
}

impl fmt::Display for SearchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            SearchError::EmptyQuery => "query must not be empty",
            SearchError::QueryTooLong => "query exceeds the 4096-byte limit",
            SearchError::InvalidLimit => "limit must be greater than zero",
            SearchError::CursorMismatch => "cursor does not match the search request",
            SearchError::InvalidCursor => "cursor is invalid",
            SearchError::InvalidTarget => "search target node is invalid",
        };
        f.write_str(message)
    }
}

impl std::error::Error for SearchError {}

impl SearchRequest {
    pub fn decoded(
        query: impl Into<String>,
        node_id: Option<usize>,
        cursor: Option<SearchCursor>,
        limit: usize,
    ) -> Self {
        Self {
            mode: SearchMode::Decoded,
            query: query.into(),
            cursor,
            limit,
            node_id,
        }
    }

    pub fn raw(query: impl Into<String>, cursor: Option<SearchCursor>, limit: usize) -> Self {
        Self {
            mode: SearchMode::Raw,
            query: query.into(),
            cursor,
            limit,
            node_id: None,
        }
    }
}

pub fn search(parsed: &ParsedJson<'_>, request: SearchRequest) -> Result<SearchPage, SearchError> {
    validate_request(&request)?;
    match request.mode {
        SearchMode::Decoded => search_decoded(parsed, &request),
        SearchMode::Raw => search_raw(parsed, &request),
    }
}

fn validate_request(request: &SearchRequest) -> Result<(), SearchError> {
    if request.query.is_empty() {
        return Err(SearchError::EmptyQuery);
    }
    if request.query.len() > MAX_QUERY_BYTES {
        return Err(SearchError::QueryTooLong);
    }
    if request.limit == 0 {
        return Err(SearchError::InvalidLimit);
    }
    if let Some(cursor) = &request.cursor {
        if cursor.mode != request.mode
            || cursor.query != request.query
            || cursor.node_id != request.node_id
        {
            return Err(SearchError::CursorMismatch);
        }
    }
    Ok(())
}

fn search_decoded(
    parsed: &ParsedJson<'_>,
    request: &SearchRequest,
) -> Result<SearchPage, SearchError> {
    let end_unit = request
        .node_id
        .map(|target| {
            parsed
                .node_at(target)
                .ok_or(SearchError::InvalidTarget)
                .map(|_| subtree_end(parsed, target))
        })
        .transpose()?
        .unwrap_or(parsed.node_count());
    let (mut unit, mut phase, mut offset) = request.cursor.as_ref().map_or_else(
        || (request.node_id.unwrap_or(0), SearchPhase::Value, 0),
        |cursor| (cursor.unit, cursor.phase, cursor.offset),
    );
    if request.cursor.is_some() || request.node_id.is_some() {
        validate_decoded_cursor(parsed, request.node_id, end_unit, unit, phase, offset)?;
    }

    let mut matches = Vec::new();
    let mut scanned: usize = 0;
    let mut visited_nodes: usize = 0;
    let page_size = request.limit.min(MAX_PAGE_SIZE);
    while unit < end_unit {
        if matches.len() >= page_size {
            break;
        }
        if visited_nodes >= MAX_SCAN_BYTES {
            break;
        }
        visited_nodes += 1;

        let Some(candidate) = decoded_candidate(parsed, unit, phase)? else {
            let Some((next_unit, next_phase)) =
                next_decoded_position(parsed, end_unit, unit, phase)
            else {
                unit = end_unit;
                break;
            };
            unit = next_unit;
            phase = next_phase;
            offset = 0;
            if scanned >= MAX_SCAN_BYTES {
                break;
            }
            continue;
        };

        let remaining_budget = MAX_SCAN_BYTES.saturating_sub(scanned);
        if remaining_budget == 0 {
            break;
        }
        let start = offset;
        let scan = scan_decoded_text(
            &candidate.text,
            start,
            remaining_budget,
            &request.query,
            page_size.saturating_sub(matches.len()),
        )?;
        if !scan.exhausted && scan.consumed_end == start {
            break;
        }
        for (match_start, match_end) in scan.matches {
            let (path, path_truncated) = path_for(parsed, unit);
            matches.push(SearchMatch {
                node_id: Some(unit),
                field: candidate.field,
                path,
                path_truncated,
                span: candidate.span,
                match_start,
                match_end,
            });
            if matches.len() >= page_size {
                break;
            }
        }

        let consumed_end = scan.consumed_end;
        scanned = scanned.saturating_add(scan.work_bytes);
        offset = consumed_end;
        if scan.exhausted {
            let Some((next_unit, next_phase)) =
                next_decoded_position(parsed, end_unit, unit, phase)
            else {
                unit = end_unit;
                break;
            };
            unit = next_unit;
            phase = next_phase;
            offset = 0;
        }

        if matches.len() >= page_size || scanned >= MAX_SCAN_BYTES {
            break;
        }
    }

    let has_more = unit < end_unit;
    let next_cursor = has_more.then(|| SearchCursor {
        mode: request.mode,
        query: request.query.clone(),
        node_id: request.node_id,
        unit,
        phase,
        offset,
    });
    Ok(SearchPage {
        matches,
        has_more,
        next_cursor,
    })
}

struct DecodedCandidate<'a> {
    field: SearchField,
    text: DecodedCandidateText<'a>,
    span: SourceSpan,
}

enum DecodedCandidateText<'a> {
    Borrowed(&'a str),
    String(DecodedString<'a>),
}

struct DecodedScan {
    matches: Vec<(usize, usize)>,
    consumed_end: usize,
    work_bytes: usize,
    exhausted: bool,
}

fn scan_decoded_text(
    text: &DecodedCandidateText<'_>,
    start: usize,
    budget: usize,
    query: &str,
    limit: usize,
) -> Result<DecodedScan, SearchError> {
    match text {
        DecodedCandidateText::Borrowed(text) => {
            if start > text.len() || !text.is_char_boundary(start) {
                return Err(SearchError::InvalidCursor);
            }
            let scan = scan_borrowed_text(text, start, budget, query, limit);
            Ok(scan)
        }
        DecodedCandidateText::String(decoded) => {
            if let Some(text) = decoded.borrowed() {
                if start > text.len() || !text.is_char_boundary(start) {
                    return Err(SearchError::InvalidCursor);
                }
                return Ok(scan_borrowed_text(text, start, budget, query, limit));
            }
            let (mut iterator, checkpoint_source) = decoded
                .iter_from_decoded_offset(start)
                .ok_or(SearchError::InvalidCursor)?;
            let cursor_source = iterator.source_offset();
            let locator_work = cursor_source.saturating_sub(checkpoint_source);
            let mut scan = scan_scalar_iter(
                &mut iterator,
                start,
                budget.saturating_sub(locator_work),
                query,
                limit,
            );
            scan.work_bytes = scan.work_bytes.saturating_add(locator_work);
            Ok(scan)
        }
    }
}

fn scan_borrowed_text(
    text: &str,
    start: usize,
    budget: usize,
    query: &str,
    limit: usize,
) -> DecodedScan {
    let query_extra = query.len();
    let lookahead_budget = query_extra.saturating_add(3);
    if budget < lookahead_budget && start < text.len() {
        return DecodedScan {
            matches: Vec::new(),
            consumed_end: start,
            work_bytes: 0,
            exhausted: false,
        };
    }
    let scan_end = advance_to_boundary(text, start, budget.saturating_sub(lookahead_budget));
    let lookahead_end = next_boundary(text, scan_end.saturating_add(query_extra).min(text.len()));
    let haystack = &text[start..lookahead_end];
    let mut matches = Vec::new();
    let mut last_match_end = start;
    for (relative, _) in haystack.match_indices(query) {
        let match_start = start + relative;
        let lookahead_reaches_eof = lookahead_end == text.len();
        if match_start > scan_end || (match_start == scan_end && !lookahead_reaches_eof) {
            break;
        }
        let match_end = match_start + query.len();
        matches.push((match_start, match_end));
        last_match_end = match_end;
        if matches.len() >= limit {
            return DecodedScan {
                matches,
                consumed_end: match_end,
                work_bytes: match_end.saturating_sub(start),
                exhausted: match_end == text.len(),
            };
        }
    }
    let exhausted = scan_end == text.len();
    let consumed_end = if exhausted {
        text.len()
    } else {
        scan_end.max(last_match_end)
    };
    DecodedScan {
        matches,
        consumed_end,
        work_bytes: lookahead_end.saturating_sub(start),
        exhausted,
    }
}

fn scan_scalar_iter(
    iterator: &mut DecodedScalarIter<'_>,
    start: usize,
    budget: usize,
    query: &str,
    limit: usize,
) -> DecodedScan {
    let query_bytes = query.as_bytes();
    let prefix = kmp_prefix(query_bytes);
    let mut matched = 0usize;
    let raw_start = iterator.source_offset();
    let mut last_match_end = start;
    let mut matches = Vec::new();

    loop {
        let current_source = iterator.source_offset();
        if current_source == iterator.source_end() {
            return DecodedScan {
                matches,
                consumed_end: iterator.decoded_offset(),
                work_bytes: current_source.saturating_sub(raw_start),
                exhausted: true,
            };
        }
        let Some(raw_width) = iterator.next_raw_width() else {
            return DecodedScan {
                matches,
                consumed_end: iterator.decoded_offset(),
                work_bytes: current_source.saturating_sub(raw_start),
                exhausted: true,
            };
        };
        if current_source
            .saturating_sub(raw_start)
            .saturating_add(raw_width)
            > budget
        {
            let current_decoded = iterator.decoded_offset();
            let consumed_end = if matched > 0 {
                current_decoded.saturating_sub(matched).max(last_match_end)
            } else {
                current_decoded
            };
            return DecodedScan {
                matches,
                consumed_end,
                work_bytes: current_source.saturating_sub(raw_start),
                exhausted: false,
            };
        }
        let Some(scalar) = iterator.next() else {
            return DecodedScan {
                matches,
                consumed_end: iterator.decoded_offset(),
                work_bytes: iterator.source_offset().saturating_sub(raw_start),
                exhausted: true,
            };
        };

        let mut encoded = [0u8; 4];
        let bytes = scalar.value.encode_utf8(&mut encoded).as_bytes();
        for (byte_index, &byte) in bytes.iter().enumerate() {
            while matched > 0 && byte != query_bytes[matched] {
                matched = prefix[matched - 1];
            }
            if byte == query_bytes[matched] {
                matched += 1;
            }
            if matched == query_bytes.len() {
                if byte_index + 1 == bytes.len() {
                    let match_end = scalar.end;
                    let match_start = match_end - query_bytes.len();
                    if match_start >= last_match_end {
                        matches.push((match_start, match_end));
                        last_match_end = match_end;
                        if matches.len() >= limit {
                            return DecodedScan {
                                matches,
                                consumed_end: match_end,
                                work_bytes: iterator.source_offset().saturating_sub(raw_start),
                                exhausted: iterator.source_offset() == iterator.source_end(),
                            };
                        }
                    }
                    matched = 0;
                } else {
                    matched = prefix[matched - 1];
                }
            }
        }
    }
}

fn kmp_prefix(needle: &[u8]) -> Vec<usize> {
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
    prefix
}

fn decoded_candidate<'a>(
    parsed: &'a ParsedJson<'_>,
    unit: usize,
    phase: SearchPhase,
) -> Result<Option<DecodedCandidate<'a>>, SearchError> {
    let node = parsed.node_at(unit).ok_or(SearchError::InvalidCursor)?;
    match phase {
        SearchPhase::Key => match &node.locator {
            ChildLocator::ObjectKey { key, key_span, .. } => Ok(Some(DecodedCandidate {
                field: SearchField::Key,
                text: DecodedCandidateText::Borrowed(key),
                span: *key_span,
            })),
            ChildLocator::Root | ChildLocator::ArrayIndex(_) => Err(SearchError::InvalidCursor),
        },
        SearchPhase::Value => match node.kind {
            JsonKind::String => Ok(Some(DecodedCandidate {
                field: SearchField::Value,
                text: DecodedCandidateText::String(
                    parsed
                        .decoded_string_at(unit)
                        .ok_or(SearchError::InvalidTarget)?,
                ),
                span: node.span,
            })),
            JsonKind::Number | JsonKind::True | JsonKind::False | JsonKind::Null => {
                Ok(Some(DecodedCandidate {
                    field: SearchField::Value,
                    text: DecodedCandidateText::Borrowed(
                        str::from_utf8(&parsed.source()[node.span.start..node.span.end])
                            .map_err(|_| SearchError::InvalidCursor)?,
                    ),
                    span: node.span,
                }))
            }
            JsonKind::Object | JsonKind::Array => Ok(None),
        },
    }
}

fn next_decoded_position(
    parsed: &ParsedJson<'_>,
    end_unit: usize,
    unit: usize,
    phase: SearchPhase,
) -> Option<(usize, SearchPhase)> {
    match phase {
        SearchPhase::Key => Some((unit, SearchPhase::Value)),
        SearchPhase::Value => {
            let next = unit.checked_add(1)?;
            if next >= end_unit {
                return None;
            }
            let node = parsed.node_at(next)?;
            let phase = if matches!(node.locator, ChildLocator::ObjectKey { .. }) {
                SearchPhase::Key
            } else {
                SearchPhase::Value
            };
            Some((next, phase))
        }
    }
}

fn validate_decoded_cursor(
    parsed: &ParsedJson<'_>,
    target: Option<usize>,
    end_unit: usize,
    unit: usize,
    phase: SearchPhase,
    offset: usize,
) -> Result<(), SearchError> {
    if let Some(target) = target {
        parsed.node_at(target).ok_or(SearchError::InvalidTarget)?;
        if unit < target || unit > end_unit {
            return Err(SearchError::InvalidCursor);
        }
        if unit == target && phase == SearchPhase::Key {
            return Err(SearchError::InvalidCursor);
        }
        if unit == end_unit {
            return Err(SearchError::InvalidCursor);
        }
    }
    if unit > end_unit {
        return Err(SearchError::InvalidCursor);
    }
    if unit == end_unit {
        return Err(SearchError::InvalidCursor);
    }
    let node = parsed.node_at(unit).ok_or(SearchError::InvalidCursor)?;
    if phase == SearchPhase::Key && !matches!(node.locator, ChildLocator::ObjectKey { .. }) {
        return Err(SearchError::InvalidCursor);
    }
    let Some(_candidate) = decoded_candidate(parsed, unit, phase)? else {
        return (phase == SearchPhase::Value && offset == 0)
            .then_some(())
            .ok_or(SearchError::InvalidCursor);
    };
    Ok(())
}

fn subtree_end(parsed: &ParsedJson<'_>, target: usize) -> usize {
    let end = parsed
        .node_at(target)
        .expect("validated target node id")
        .span
        .end;
    let mut low = target.saturating_add(1);
    let mut high = parsed.node_count();
    while low < high {
        let middle = low + (high - low) / 2;
        if parsed
            .node_at(middle)
            .expect("arena node id is in range")
            .span
            .start
            < end
        {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
}

fn search_raw(parsed: &ParsedJson<'_>, request: &SearchRequest) -> Result<SearchPage, SearchError> {
    let (range_start, range_end) = if let Some(target) = request.node_id {
        let node = parsed.node_at(target).ok_or(SearchError::InvalidTarget)?;
        (node.span.start, node.span.end)
    } else {
        (0, parsed.source().len())
    };
    let mut offset = request
        .cursor
        .as_ref()
        .map_or(range_start, |cursor| cursor.offset);
    if let Some(cursor) = request.cursor.as_ref() {
        if cursor.unit != 0 || cursor.phase != SearchPhase::Value {
            return Err(SearchError::InvalidCursor);
        }
    }
    let source = str::from_utf8(parsed.source()).expect("JSON source is valid UTF-8");
    if offset < range_start || offset > range_end || !source.is_char_boundary(offset) {
        return Err(SearchError::InvalidCursor);
    }

    let mut matches = Vec::new();
    let mut scanned = 0;
    let page_size = request.limit.min(MAX_PAGE_SIZE);
    while offset < range_end && matches.len() < page_size {
        let remaining_budget = MAX_SCAN_BYTES.saturating_sub(scanned);
        if remaining_budget == 0 {
            break;
        }
        let scan_end =
            advance_to_boundary_bytes(parsed.source(), offset, remaining_budget).min(range_end);
        let lookahead = scan_end
            .saturating_add(request.query.len().saturating_sub(1))
            .min(range_end);
        let haystack = str::from_utf8(
            &parsed.source()[offset..next_boundary_bytes(parsed.source(), lookahead)],
        )
        .expect("JSON source is valid UTF-8");
        let found = haystack
            .find(&request.query)
            .map(|relative| offset + relative)
            .filter(|&start| start < scan_end);
        if let Some(start) = found {
            let end = start + request.query.len();
            let (path, path_truncated) = request.node_id.map_or_else(
                || (vec!["$".to_owned()], false),
                |node_id| path_for(parsed, node_id),
            );
            matches.push(SearchMatch {
                node_id: request.node_id,
                field: SearchField::RawSource,
                path,
                path_truncated,
                span: request
                    .node_id
                    .map_or(SourceSpan { start, end }, |node_id| {
                        parsed
                            .node_at(node_id)
                            .expect("validated target node id")
                            .span
                    }),
                match_start: start,
                match_end: end,
            });
            let consumed = end.saturating_sub(offset);
            scanned = scanned.saturating_add(consumed);
            offset = end;
        } else {
            scanned = scanned.saturating_add(scan_end.saturating_sub(offset));
            offset = scan_end;
        }
        if scanned >= MAX_SCAN_BYTES {
            break;
        }
    }

    let has_more = offset < range_end;
    let next_cursor = has_more.then(|| SearchCursor {
        mode: request.mode,
        query: request.query.clone(),
        node_id: request.node_id,
        unit: 0,
        phase: SearchPhase::Value,
        offset,
    });
    Ok(SearchPage {
        matches,
        has_more,
        next_cursor,
    })
}

fn path_for(parsed: &ParsedJson<'_>, node_id: usize) -> (Vec<String>, bool) {
    let mut ids = Vec::new();
    let mut current = Some(node_id);
    while let Some(id) = current {
        let node = parsed.node_at(id).expect("arena node id is in range");
        ids.push(id);
        current = node.parent.map(|id| id.index());
    }
    ids.reverse();

    let mut path = Vec::new();
    let mut bytes = 0;
    let mut path_truncated = false;
    let last_position = ids.len().saturating_sub(1);
    for (position, id) in ids.into_iter().enumerate() {
        let node = parsed.node_at(id).expect("arena node id is in range");
        let (segment, segment_truncated) = match &node.locator {
            ChildLocator::Root => ("$".to_owned(), false),
            ChildLocator::ArrayIndex(index) => (format!("[{index}]"), false),
            ChildLocator::ObjectKey {
                key, occurrence, ..
            } => object_path_segment(key, *occurrence),
        };
        path_truncated |= segment_truncated;
        if bytes == 0 {
            path.push(segment);
            bytes = path[0].len();
            continue;
        }
        let remaining = MAX_PATH_BYTES.saturating_sub(bytes);
        if remaining == 0 {
            path_truncated = true;
            break;
        }
        let original_segment_len = segment.len();
        let segment = truncate_utf8_bytes(&segment, remaining);
        if segment.is_empty() {
            path_truncated = true;
            break;
        }
        if segment.len() < original_segment_len {
            path_truncated = true;
        }
        bytes += segment.len();
        path.push(segment);
        if bytes >= MAX_PATH_BYTES {
            if position != last_position {
                path_truncated = true;
            }
            break;
        }
    }
    (path, path_truncated)
}

fn object_path_segment(key: &str, occurrence: usize) -> (String, bool) {
    let mut chars = key.chars();
    let base: String = chars.by_ref().take(MAX_PATH_LABEL_CHARS).collect();
    let key_truncated = chars.next().is_some();
    let safe_key = occurrence == 1 && !key.is_empty() && !key.starts_with('[');
    let mut segment = if safe_key {
        base
    } else {
        format!("[\"{}\"]", json_escape(&base))
    };
    if occurrence > 1 {
        segment.push('#');
        segment.push_str(&occurrence.to_string());
    }
    (segment, key_truncated)
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::new();
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write;
                write!(escaped, "\\u{:04x}", character as u32).expect("String write cannot fail");
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn valid_prefix_len(text: &str, max_bytes: usize) -> usize {
    if text.len() <= max_bytes {
        return text.len();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn advance_to_boundary(text: &str, start: usize, budget: usize) -> usize {
    let mut end = start.saturating_add(budget).min(text.len());
    while end > start && !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == start {
        end = text[start..]
            .chars()
            .next()
            .map_or(start, |character| start + character.len_utf8());
    }
    end
}

fn next_boundary(text: &str, mut offset: usize) -> usize {
    while offset < text.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

fn advance_to_boundary_bytes(source: &[u8], start: usize, budget: usize) -> usize {
    let text = str::from_utf8(source).expect("JSON source is valid UTF-8");
    advance_to_boundary(text, start, budget)
}

fn next_boundary_bytes(source: &[u8], mut offset: usize) -> usize {
    let text = str::from_utf8(source).expect("JSON source is valid UTF-8");
    while offset < source.len() && !text.is_char_boundary(offset) {
        offset += 1;
    }
    offset
}

fn truncate_utf8_bytes(text: &str, max_bytes: usize) -> String {
    text[..valid_prefix_len(text, max_bytes)].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse_json_owned;

    fn parsed(input: &str) -> ParsedJson<'static> {
        parse_json_owned(input.as_bytes().to_vec()).unwrap()
    }

    fn request(query: &str) -> SearchRequest {
        SearchRequest::decoded(query, None, None, 50)
    }

    #[test]
    fn decoded_searches_keys_escaped_values_numbers_and_literals_in_node_order() {
        let parsed = parsed(r#"{"\u0061":"hello", "number": 12.30e+2, "ok":true, "none":null}"#);
        let page = search(&parsed, request("a")).unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].node_id, Some(1));
        assert_eq!(page.matches[0].field, SearchField::Key);
        assert_eq!(page.matches[0].span, SourceSpan { start: 1, end: 9 });
        assert_eq!(page.matches[0].match_start, 0);
        assert_eq!(page.matches[0].match_end, 1);

        let value = search(&parsed, request("hello")).unwrap();
        assert_eq!(value.matches[0].node_id, Some(1));
        assert_eq!(value.matches[0].field, SearchField::Value);
        assert_eq!(value.matches[0].match_start, 0);

        let number = search(&parsed, request("12.30e+2")).unwrap();
        assert_eq!(number.matches[0].node_id, Some(2));
        let boolean = search(&parsed, request("true")).unwrap();
        assert_eq!(boolean.matches[0].node_id, Some(3));
        let null = search(&parsed, request("null")).unwrap();
        assert_eq!(null.matches[0].node_id, Some(4));

        let key_before_value = parse_json_owned(br#"{"a":"a"}"#.to_vec()).unwrap();
        let page = search(&key_before_value, request("a")).unwrap();
        assert_eq!(page.matches.len(), 2);
        assert_eq!(page.matches[0].span, SourceSpan { start: 1, end: 4 });
        assert_eq!(page.matches[1].span, SourceSpan { start: 5, end: 8 });
    }

    #[test]
    fn decoded_search_is_case_sensitive_and_does_not_normalize_nfc_nfd() {
        let parsed = parsed(r#"["é", "é", "É"]"#);
        assert_eq!(search(&parsed, request("é")).unwrap().matches.len(), 1);
        assert_eq!(search(&parsed, request("é")).unwrap().matches.len(), 1);
        assert_eq!(search(&parsed, request("É")).unwrap().matches.len(), 1);
        assert_eq!(search(&parsed, request("E")).unwrap().matches.len(), 0);
    }

    #[test]
    fn decoded_search_reports_multibyte_offsets_and_non_overlapping_matches() {
        let parsed = parsed(r#"["😀😀aaaa"]"#);
        let emoji = search(&parsed, request("😀")).unwrap();
        assert_eq!(
            emoji
                .matches
                .iter()
                .map(|item| (item.match_start, item.match_end))
                .collect::<Vec<_>>(),
            vec![(0, 4), (4, 8)]
        );
        let overlapping = search(&parsed, request("aa")).unwrap();
        assert_eq!(
            overlapping
                .matches
                .iter()
                .map(|item| (item.match_start, item.match_end))
                .collect::<Vec<_>>(),
            vec![(8, 10), (10, 12)]
        );
    }

    #[test]
    fn decoded_search_preserves_duplicate_and_deep_paths() {
        let parsed = parsed(r#"{"x": {"x": 1}, "x": 2}"#);
        let page = search(&parsed, request("x")).unwrap();
        assert_eq!(page.matches.len(), 3);
        assert_eq!(page.matches[0].path, vec!["$", "x"]);
        assert_eq!(page.matches[1].path, vec!["$", "x", "x"]);
        assert_eq!(page.matches[2].path, vec!["$", "[\"x\"]#2"]);
        assert_eq!(page.matches[2].field, SearchField::Key);
    }

    #[test]
    fn paths_reuse_tree_labels_and_stop_at_the_2048_byte_budget() {
        let depth = 700;
        let input = format!("{}\"needle\"{}", "[".repeat(depth), "]".repeat(depth));
        let parsed = parsed(&input);
        let page = search(&parsed, request("needle")).unwrap();
        assert_eq!(page.matches.len(), 1);
        assert!(page.matches[0].path.iter().map(String::len).sum::<usize>() <= MAX_PATH_BYTES);
        assert!(page.matches[0].path_truncated);
        assert_eq!(page.matches[0].path.first().map(String::as_str), Some("$"));
        assert_eq!(page.matches[0].path.get(1).map(String::as_str), Some("[0]"));

        let object_key = parse_json_owned(br#"{"[0]":"needle"}"#.to_vec()).unwrap();
        let page = search(&object_key, request("needle")).unwrap();
        assert_eq!(page.matches[0].path, vec!["$", "[\"[0]\"]"]);

        let prefix = "k".repeat(MAX_PATH_LABEL_CHARS);
        let common_prefix = parse_json_owned(
            format!(r#"{{"{prefix}a":"needle","{prefix}b":"needle"}}"#).into_bytes(),
        )
        .unwrap();
        let page = search(&common_prefix, request("needle")).unwrap();
        assert_eq!(page.matches[0].path, page.matches[1].path);
        assert!(page.matches.iter().all(|item| item.path_truncated));
    }

    #[test]
    fn object_key_path_segments_do_not_collide_with_array_indices_or_empty_keys() {
        let parsed = parsed(r#"{"":["needle"],"[0]":["needle"],"array":["needle"]}"#);
        let page = search(&parsed, request("needle")).unwrap();
        assert_eq!(
            page.matches
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>(),
            vec![
                vec!["$", "[\"\"]", "[0]"],
                vec!["$", "[\"[0]\"]", "[0]"],
                vec!["$", "array", "[0]"],
            ]
        );
    }

    #[test]
    fn duplicate_occurrence_suffixes_are_unambiguous() {
        let parsed =
            parsed(r#"{"[0]":"needle","[0]":"needle","x":"needle","x":"needle","x#2":"needle"}"#);
        let page = search(&parsed, request("needle")).unwrap();
        assert_eq!(
            page.matches
                .iter()
                .map(|item| item.path.clone())
                .collect::<Vec<_>>(),
            vec![
                vec!["$", "[\"[0]\"]"],
                vec!["$", "[\"[0]\"]#2"],
                vec!["$", "x"],
                vec!["$", "[\"x\"]#2"],
                vec!["$", "x#2"],
            ]
        );
    }

    #[test]
    fn raw_search_matches_original_escape_bytes() {
        let parsed = parsed(r#"{"value":"\u4f60\u597d"}"#);
        let page = search(
            &parsed,
            SearchRequest {
                mode: SearchMode::Raw,
                query: r#"\u4f60"#.to_owned(),
                cursor: None,
                limit: 50,
                node_id: None,
            },
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].node_id, None);
        assert_eq!(page.matches[0].field, SearchField::RawSource);
        assert_eq!(page.matches[0].path, vec!["$"]);
        assert_eq!(page.matches[0].span, SourceSpan { start: 10, end: 16 });
        assert_eq!(page.matches[0].match_start, 10);
        assert_eq!(page.matches[0].match_end, 16);
    }

    #[test]
    fn target_restricts_decoded_and_raw_string_search() {
        let parsed = parsed(r#"{"a":"needle", "b":"needle"}"#);
        let decoded = search(&parsed, SearchRequest::decoded("needle", Some(1), None, 50)).unwrap();
        assert_eq!(decoded.matches.len(), 1);
        assert_eq!(decoded.matches[0].node_id, Some(1));
        assert_eq!(decoded.matches[0].field, SearchField::Value);
        assert_eq!(decoded.matches[0].path, vec!["$", "a"]);

        let raw = search(
            &parsed,
            SearchRequest {
                mode: SearchMode::Raw,
                query: "needle".to_owned(),
                cursor: None,
                limit: 50,
                node_id: Some(1),
            },
        )
        .unwrap();
        assert_eq!(raw.matches.len(), 1);
        assert_eq!(raw.matches[0].node_id, Some(1));
        assert_eq!(raw.matches[0].field, SearchField::RawSource);
        assert_eq!(raw.matches[0].path, vec!["$", "a"]);

        let object = search(&parsed, SearchRequest::decoded("needle", Some(0), None, 50)).unwrap();
        assert_eq!(object.matches.len(), 2);
        assert!(object.matches.iter().all(|item| item.node_id != Some(0)));
    }

    #[test]
    fn decoded_target_search_stays_inside_an_object_subtree_across_pages() {
        let parsed = parsed(
            r#"{"before":"needle","target":{"first":"needle","items":["needle",{"deep":"needle"}]},"after":"needle"}"#,
        );
        let first = search(&parsed, SearchRequest::decoded("needle", Some(2), None, 1)).unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].node_id, Some(3));
        assert_eq!(first.matches[0].path, vec!["$", "target", "first"]);
        assert!(first.has_more);

        let second = search(
            &parsed,
            SearchRequest::decoded("needle", Some(2), first.next_cursor, 50),
        )
        .unwrap();
        assert_eq!(
            second
                .matches
                .iter()
                .map(|item| item.node_id)
                .collect::<Vec<_>>(),
            vec![Some(5), Some(7)]
        );
        assert!(second.matches.iter().all(|item| item.path[1] == "target"));
        assert!(!second.has_more);
    }

    #[test]
    fn decoded_target_search_supports_scalar_kinds_without_matching_the_target_key() {
        let parsed = parsed(
            r#"{"before":"needle","target":{"number":12.30e+2,"truth":true,"nothing":null,"empty":"","emptyArray":[]},"after":"needle"}"#,
        );
        assert!(
            search(&parsed, SearchRequest::decoded("target", Some(2), None, 50))
                .unwrap()
                .matches
                .is_empty()
        );
        for (query, node_id) in [("12.30e+2", 3), ("true", 4), ("null", 5)] {
            let page = search(&parsed, SearchRequest::decoded(query, Some(2), None, 50)).unwrap();
            assert_eq!(page.matches.len(), 1);
            assert_eq!(page.matches[0].node_id, Some(node_id));
            assert_eq!(page.matches[0].field, SearchField::Value);
        }

        let empty = search(&parsed, SearchRequest::decoded("needle", Some(7), None, 50)).unwrap();
        assert!(empty.matches.is_empty());
        assert!(!empty.has_more);
    }

    #[test]
    fn direct_scalar_targets_keep_their_original_value_lexemes() {
        let parsed = parsed(r#"[12.30e+2,true,null,"text"]"#);
        for (node_id, query) in [(1, "12.30e+2"), (2, "true"), (3, "null")] {
            let page = search(
                &parsed,
                SearchRequest::decoded(query, Some(node_id), None, 50),
            )
            .unwrap();
            assert_eq!(page.matches.len(), 1);
            assert_eq!(page.matches[0].node_id, Some(node_id));
            assert_eq!(page.matches[0].match_start, 0);
            assert_eq!(page.matches[0].match_end, query.len());
        }
        let array = search(&parsed, SearchRequest::decoded("nope", Some(0), None, 50)).unwrap();
        assert!(array.matches.is_empty());
        assert!(!array.has_more);
    }

    #[test]
    fn raw_target_search_stays_inside_the_exact_container_span() {
        let parsed =
            parsed(r#"{"before":"needle", "target":{"inside":"needle"} , "after":"needle"}"#);
        let target_span = parsed.node_at(2).unwrap().span;
        let page = search(
            &parsed,
            SearchRequest {
                mode: SearchMode::Raw,
                query: "needle".to_owned(),
                cursor: None,
                limit: 50,
                node_id: Some(2),
            },
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].node_id, Some(2));
        assert_eq!(page.matches[0].span, target_span);
        assert_eq!(page.matches[0].match_start, target_span.start + 11);
        assert_eq!(page.matches[0].match_end, target_span.start + 17);

        let parent_key = SearchRequest {
            mode: SearchMode::Raw,
            query: "target".to_owned(),
            cursor: None,
            limit: 50,
            node_id: Some(2),
        };
        assert!(search(&parsed, parent_key).unwrap().matches.is_empty());
        let crosses_target_end = SearchRequest {
            mode: SearchMode::Raw,
            query: "} ,".to_owned(),
            cursor: None,
            limit: 50,
            node_id: Some(2),
        };
        assert!(search(&parsed, crosses_target_end)
            .unwrap()
            .matches
            .is_empty());
    }

    #[test]
    fn target_arrays_and_escaped_duplicate_keys_keep_distinct_paths() {
        let empty_array = parsed(r#"{"target":[],"after":"needle"}"#);
        let empty = search(
            &empty_array,
            SearchRequest::decoded("needle", Some(1), None, 50),
        )
        .unwrap();
        assert!(empty.matches.is_empty());
        assert!(!empty.has_more);

        let parsed = parsed(
            r#"{"before":"needle","target":{"\u006eeedle":"needle","needle":"needle","needle":"needle"},"after":"needle"}"#,
        );
        let page = search(&parsed, SearchRequest::decoded("needle", Some(2), None, 50)).unwrap();
        assert_eq!(
            page.matches
                .iter()
                .map(|item| (item.field, item.path.join(".")))
                .collect::<Vec<_>>(),
            vec![
                (SearchField::Key, "$.target.needle".to_owned()),
                (SearchField::Value, "$.target.needle".to_owned()),
                (SearchField::Key, "$.target.[\"needle\"]#2".to_owned()),
                (SearchField::Value, "$.target.[\"needle\"]#2".to_owned()),
                (SearchField::Key, "$.target.[\"needle\"]#3".to_owned()),
                (SearchField::Value, "$.target.[\"needle\"]#3".to_owned()),
            ]
        );
    }

    #[test]
    fn target_cursor_rejects_parent_key_and_nodes_outside_the_subtree() {
        let parsed = parsed(
            r#"{"before":"needle","target":{"inside":"needle","second":"other"},"after":"needle"}"#,
        );
        let first = search(&parsed, SearchRequest::decoded("needle", Some(2), None, 1)).unwrap();
        let cursor = first.next_cursor.unwrap();

        let mut parent_key = cursor.clone();
        parent_key.unit = 2;
        parent_key.phase = SearchPhase::Key;
        parent_key.offset = 0;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("needle", Some(2), Some(parent_key), 1),
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let mut ancestor = cursor.clone();
        ancestor.unit = 0;
        ancestor.phase = SearchPhase::Value;
        ancestor.offset = 0;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("needle", Some(2), Some(ancestor), 1),
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let mut sibling = cursor;
        sibling.unit = subtree_end(&parsed, 2);
        sibling.phase = SearchPhase::Value;
        sibling.offset = 0;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("needle", Some(2), Some(sibling), 1),
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );
    }

    #[test]
    fn cursor_rejects_query_mode_and_target_mismatch() {
        let parsed = parsed(r#"["a", "a"]"#);
        let first = search(&parsed, SearchRequest::decoded("a", None, None, 1)).unwrap();
        let cursor = first.next_cursor.unwrap();
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("b", None, Some(cursor.clone()), 1)
            )
            .unwrap_err(),
            SearchError::CursorMismatch
        );
        assert_eq!(
            search(
                &parsed,
                SearchRequest {
                    mode: SearchMode::Raw,
                    query: "a".to_owned(),
                    cursor: Some(cursor),
                    limit: 1,
                    node_id: None,
                }
            )
            .unwrap_err(),
            SearchError::CursorMismatch
        );
    }

    #[test]
    fn cursor_rejects_same_mode_with_a_different_node_target() {
        let parsed = parsed(r#"["a", "a"]"#);
        let first = search(&parsed, SearchRequest::decoded("a", None, None, 1)).unwrap();
        let cursor = first.next_cursor.unwrap();
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("a", Some(1), Some(cursor), 1)
            )
            .unwrap_err(),
            SearchError::CursorMismatch
        );
    }

    #[test]
    fn cursor_rejects_invalid_unit_phase_offsets_and_raw_units() {
        let parsed = parsed(r#"["😀x"]"#);
        let first = search(&parsed, SearchRequest::decoded("😀", None, None, 1)).unwrap();
        let cursor = first.next_cursor.unwrap();

        let mut invalid_unit = cursor.clone();
        invalid_unit.unit = usize::MAX;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("😀", None, Some(invalid_unit), 1)
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let mut invalid_phase = cursor.clone();
        invalid_phase.phase = SearchPhase::Key;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("😀", None, Some(invalid_phase), 1)
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let mut invalid_offset = cursor;
        invalid_offset.offset = 1;
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("😀", None, Some(invalid_offset), 1)
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let raw_cursor = SearchCursor {
            mode: SearchMode::Raw,
            query: "x".to_owned(),
            node_id: None,
            unit: 1,
            phase: SearchPhase::Value,
            offset: 0,
        };
        assert_eq!(
            search(&parsed, SearchRequest::raw("x", Some(raw_cursor), 1)).unwrap_err(),
            SearchError::InvalidCursor
        );

        let eof_cursor = SearchCursor {
            mode: SearchMode::Decoded,
            query: "x".to_owned(),
            node_id: None,
            unit: parsed.node_count(),
            phase: SearchPhase::Value,
            offset: 0,
        };
        assert_eq!(
            search(
                &parsed,
                SearchRequest::decoded("x", None, Some(eof_cursor), 1),
            )
            .unwrap_err(),
            SearchError::InvalidCursor
        );

        let escaped =
            parse_json_owned(format!(r#"["{}\u1234"]"#, "a".repeat(70_000)).into_bytes()).unwrap();
        for offset in [70_001, usize::MAX] {
            let cursor = SearchCursor {
                mode: SearchMode::Decoded,
                query: "needle".to_owned(),
                node_id: Some(1),
                unit: 1,
                phase: SearchPhase::Value,
                offset,
            };
            assert_eq!(
                search(
                    &escaped,
                    SearchRequest::decoded("needle", Some(1), Some(cursor), 1),
                )
                .unwrap_err(),
                SearchError::InvalidCursor
            );
        }
    }

    #[test]
    fn limit_one_advances_from_key_to_value_and_then_end() {
        let parsed = parsed(r#"{"a":"a"}"#);
        let first = search(&parsed, SearchRequest::decoded("a", None, None, 1)).unwrap();
        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].field, SearchField::Key);
        let cursor = first.next_cursor.unwrap();
        assert_eq!(cursor.unit, 1);
        assert_eq!(cursor.phase, SearchPhase::Value);
        assert_eq!(cursor.offset, 0);

        let second = search(&parsed, SearchRequest::decoded("a", None, Some(cursor), 1)).unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].field, SearchField::Value);
        assert!(!second.has_more);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn query_and_limit_are_validated_and_limit_is_clamped() {
        let parsed = parsed(r#"["a", "a", "a"]"#);
        assert_eq!(
            search(&parsed, request("")).unwrap_err(),
            SearchError::EmptyQuery
        );
        assert_eq!(
            search(&parsed, request(&"a".repeat(MAX_QUERY_BYTES + 1))).unwrap_err(),
            SearchError::QueryTooLong
        );
        assert_eq!(
            search(&parsed, SearchRequest::decoded("a", None, None, 0)).unwrap_err(),
            SearchError::InvalidLimit
        );
        let page = search(&parsed, SearchRequest::decoded("a", None, None, usize::MAX)).unwrap();
        assert_eq!(page.matches.len(), 3);

        let many = parse_json_owned(format!("[{}]", ["\"a\""; 60].join(",")).into_bytes()).unwrap();
        let first = search(&many, SearchRequest::decoded("a", None, None, usize::MAX)).unwrap();
        assert_eq!(first.matches.len(), MAX_PAGE_SIZE);
        let second = search(
            &many,
            SearchRequest::decoded("a", None, first.next_cursor, usize::MAX),
        )
        .unwrap();
        assert_eq!(second.matches.len(), 10);
        assert!(!second.has_more);
    }

    #[test]
    fn scan_budget_returns_empty_page_with_a_progressing_cursor() {
        let value = "z".repeat(MAX_SCAN_BYTES + 128);
        let parsed = parsed(&format!(r#"["{value}"]"#));
        let page = search(&parsed, request("needle")).unwrap();
        assert!(page.matches.is_empty());
        assert!(page.has_more);
        let cursor = page.next_cursor.unwrap();
        assert_eq!(cursor.unit, 1);
        assert!(cursor.offset < MAX_SCAN_BYTES);
        assert!(cursor.offset > MAX_SCAN_BYTES - 32);

        let second = search(
            &parsed,
            SearchRequest::decoded("needle", None, Some(cursor.clone()), 50),
        )
        .unwrap();
        assert!(second.matches.is_empty());
        assert!(!second.has_more);
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn decoded_scan_window_keeps_utf8_lookahead_on_a_boundary() {
        let value = "😀".repeat(MAX_SCAN_BYTES / "😀".len() + 8);
        let parsed = parsed(&format!(r#"["{value}"]"#));
        let page = search(&parsed, SearchRequest::decoded("🦀🦀", Some(1), None, 50)).unwrap();
        assert!(page.matches.is_empty());
        assert!(page.has_more);
        let offset = page.next_cursor.unwrap().offset;
        assert!(offset < MAX_SCAN_BYTES);
        assert!(offset > MAX_SCAN_BYTES - 32);
    }

    #[test]
    fn raw_search_finds_a_match_crossing_the_scan_window() {
        let mut value = "a".repeat(MAX_SCAN_BYTES + 8);
        let value_offset = MAX_SCAN_BYTES - 3;
        value.insert_str(value_offset, "XY");
        let parsed = parsed(&format!(r#"["{value}"]"#));
        let page = search(
            &parsed,
            SearchRequest {
                mode: SearchMode::Raw,
                query: "XY".to_owned(),
                cursor: None,
                limit: 50,
                node_id: None,
            },
        )
        .unwrap();
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].match_start, MAX_SCAN_BYTES - 1);
        assert_eq!(page.matches[0].match_end, MAX_SCAN_BYTES + 1);
    }

    #[test]
    fn decoded_search_finds_escaped_match_crossing_scan_window_without_duplicate_next_page() {
        let mut value = "a".repeat(MAX_SCAN_BYTES + 8);
        let value_offset = MAX_SCAN_BYTES - 13;
        value.replace_range(value_offset..value_offset + 2, r#"\u0058\u0059"#);
        let parsed = parsed(&format!(r#"["{value}"]"#));
        let first = search(&parsed, SearchRequest::decoded("XY", Some(1), None, 50)).unwrap();

        assert_eq!(first.matches.len(), 1);
        assert_eq!(first.matches[0].match_start, value_offset);
        assert_eq!(first.matches[0].match_end, value_offset + 2);
        assert!(first.has_more);

        let second = search(
            &parsed,
            SearchRequest::decoded("XY", Some(1), first.next_cursor, 50),
        )
        .unwrap();
        assert!(second.matches.is_empty());
        assert!(!second.has_more);
    }

    #[test]
    fn borrowed_eof_multibyte_match_survives_scan_boundary() {
        let value = format!("{}你", "a".repeat(MAX_SCAN_BYTES - 5));
        let parsed = parsed(&format!(r#"["{value}"]"#));
        let mut page = search(&parsed, SearchRequest::decoded("你", Some(1), None, 50)).unwrap();
        let mut matches = Vec::new();
        for _ in 0..3 {
            matches.extend(page.matches.clone());
            if !page.has_more {
                break;
            }
            page = search(
                &parsed,
                SearchRequest::decoded("你", Some(1), page.next_cursor, 50),
            )
            .unwrap();
        }

        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].match_start, MAX_SCAN_BYTES - 5);
        assert_eq!(matches[0].match_end, MAX_SCAN_BYTES - 2);
        assert!(!page.has_more);
    }

    #[test]
    fn escaped_locator_and_scan_work_stay_within_raw_budget() {
        let raw = r#"\u0061"#.repeat(2 * 1024 * 1024);
        let parsed = parsed(&format!(r#"["{raw}"]"#));
        let text = DecodedCandidateText::String(parsed.decoded_string_at(1).unwrap());
        let scan = scan_decoded_text(&text, 100_000, MAX_SCAN_BYTES, "z", 50).unwrap();

        assert!(scan.work_bytes <= MAX_SCAN_BYTES + 12);
        assert!(scan.consumed_end > 100_000);
        assert!(!scan.exhausted);
    }

    #[test]
    fn escaped_raw_budget_tail_match_is_resumed_at_decoded_boundary() {
        let raw = format!("{}\\u0062", r#"\u0061"#.repeat(1_398_101));
        let parsed = parsed(&format!(r#"["{raw}"]"#));
        let text = DecodedCandidateText::String(parsed.decoded_string_at(1).unwrap());
        let scan = scan_decoded_text(&text, 0, MAX_SCAN_BYTES, "b", 50).unwrap();
        assert!(scan.work_bytes <= MAX_SCAN_BYTES + 12);
        assert!(!scan.exhausted);
        let first = search(&parsed, SearchRequest::decoded("b", Some(1), None, 50)).unwrap();
        assert!(first.matches.is_empty());
        assert!(first.has_more);

        let second = search(
            &parsed,
            SearchRequest::decoded("b", Some(1), first.next_cursor, 50),
        )
        .unwrap();
        assert_eq!(second.matches.len(), 1);
        assert_eq!(second.matches[0].match_start, 1_398_101);
        assert!(!second.has_more);
    }

    #[test]
    fn low_budget_stops_before_a_scalar_or_borrowed_lookahead_without_spinning() {
        for budget in 0..=6 {
            let borrowed = scan_borrowed_text("tail", 0, budget, "needle", 50);
            assert!(borrowed.matches.is_empty());
            assert_eq!(borrowed.consumed_end, 0);
            assert_eq!(borrowed.work_bytes, 0);
            assert!(!borrowed.exhausted);
        }

        let parsed = parsed(r#"["\u0061"]"#);
        let text = DecodedCandidateText::String(parsed.decoded_string_at(1).unwrap());
        for budget in 0..6 {
            let scan = scan_decoded_text(&text, 0, budget, "b", 50).unwrap();
            assert!(scan.matches.is_empty());
            assert_eq!(scan.consumed_end, 0);
            assert_eq!(scan.work_bytes, 0);
            assert!(!scan.exhausted);
        }
    }

    #[test]
    fn search_page_has_stable_core_payload_shape() {
        let parsed = parsed(r#"{"message":"hi"}"#);
        let page = search(&parsed, request("hi")).unwrap();
        assert_eq!(page.matches[0].node_id, Some(1));
        assert_eq!(page.matches[0].field, SearchField::Value);
        assert_eq!(page.matches[0].path, vec!["$", "message"]);
        assert_eq!(page.matches[0].span, SourceSpan { start: 11, end: 15 });
        assert_eq!(page.matches[0].match_start, 0);
        assert_eq!(page.matches[0].match_end, 2);
        assert!(!page.has_more);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn long_key_front_matches_are_bounded_and_do_not_scan_the_suffix_for_paths() {
        let prefix = "needle".repeat(50);
        let key = format!("{prefix}{}", "x".repeat(2 * 1024 * 1024 - prefix.len()));
        let input = format!("{{{}:\"value\"}}", serde_json::to_string(&key).unwrap());
        let parsed = parsed(&input);
        let page = search(
            &parsed,
            SearchRequest::decoded("needle", None, None, MAX_PAGE_SIZE),
        )
        .unwrap();

        assert_eq!(page.matches.len(), MAX_PAGE_SIZE);
        assert!(page.has_more);
        assert_eq!(page.next_cursor.as_ref().unwrap().offset, prefix.len());
        assert!(page.matches.iter().all(|item| {
            item.field == SearchField::Key
                && item.path_truncated
                && item.path.iter().map(String::len).sum::<usize>() <= MAX_PATH_BYTES
        }));
    }
}
