use std::borrow::Cow;
use std::collections::HashMap;
use std::str::{self, from_utf8};

const DECODED_CHECKPOINT_RAW_STRIDE: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NodeId(usize);

impl NodeId {
    pub fn index(self) -> usize {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JsonKind {
    String,
    Number,
    True,
    False,
    Null,
    Object,
    Array,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChildLocator {
    Root,
    ArrayIndex(usize),
    ObjectKey {
        key: String,
        key_span: SourceSpan,
        occurrence: usize,
    },
}

#[derive(Debug, Eq, PartialEq)]
pub struct JsonNode {
    pub kind: JsonKind,
    pub span: SourceSpan,
    pub locator: ChildLocator,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub decoded: Option<String>,
    pub string_has_escape: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedCheckpoint {
    pub node_id: usize,
    pub source_offset: usize,
    pub decoded_offset: usize,
}

/// A validated JSON string exposed through its source span. Literal strings
/// borrow their UTF-8 payload; escaped strings are decoded only as callers
/// iterate or materialize them. The parser still validates every escape and
/// surrogate pair before a `ParsedJson` is returned.
#[derive(Clone, Copy, Debug)]
pub struct DecodedString<'a> {
    source: &'a [u8],
    text: &'a str,
    span: SourceSpan,
    has_escape: bool,
    checkpoints: &'a [DecodedCheckpoint],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DecodedScalar {
    pub value: char,
    pub start: usize,
    pub end: usize,
}

pub struct DecodedScalarIter<'a> {
    source: &'a [u8],
    index: usize,
    end: usize,
    decoded_offset: usize,
    escaped: bool,
}

#[derive(Debug)]
pub struct ParsedJson<'a> {
    source: Cow<'a, str>,
    nodes: Vec<JsonNode>,
    checkpoints: Vec<DecodedCheckpoint>,
}

impl<'a> ParsedJson<'a> {
    pub fn root(&self) -> NodeId {
        NodeId(0)
    }

    pub fn node(&self, id: NodeId) -> &JsonNode {
        &self.nodes[id.0]
    }

    pub fn source(&self) -> &[u8] {
        self.source.as_bytes()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn node_at(&self, index: usize) -> Option<&JsonNode> {
        self.nodes.get(index)
    }

    pub fn raw_lexeme(&self, id: NodeId) -> &[u8] {
        let span = self.node(id).span;
        &self.source.as_bytes()[span.start..span.end]
    }

    pub fn decoded_string_at(&self, id: usize) -> Option<DecodedString<'_>> {
        let node = self.node_at(id)?;
        let start = self
            .checkpoints
            .partition_point(|checkpoint| checkpoint.node_id < id);
        let end = self
            .checkpoints
            .partition_point(|checkpoint| checkpoint.node_id <= id);
        self.decoded_string(node, &self.checkpoints[start..end])
    }

    pub fn decoded_string_for_node(&self, node: &JsonNode) -> Option<DecodedString<'_>> {
        self.decoded_string(node, &[])
    }

    fn decoded_string<'b>(
        &'b self,
        node: &JsonNode,
        checkpoints: &'b [DecodedCheckpoint],
    ) -> Option<DecodedString<'b>> {
        (node.kind == JsonKind::String).then_some(DecodedString {
            source: self.source(),
            text: self.source.as_ref(),
            span: node.span,
            has_escape: node.string_has_escape,
            checkpoints,
        })
    }
}

impl<'a> DecodedString<'a> {
    fn inner(self) -> &'a [u8] {
        &self.source[self.span.start + 1..self.span.end - 1]
    }

    pub fn borrowed(self) -> Option<&'a str> {
        if self.has_escape {
            return None;
        }
        Some(&self.text[self.span.start + 1..self.span.end - 1])
    }

    pub(crate) fn source_start(self) -> usize {
        self.span.start + 1
    }

    pub(crate) fn source_end(self) -> usize {
        self.span.end - 1
    }

    pub fn iter(self) -> DecodedScalarIter<'a> {
        DecodedScalarIter {
            source: self.source,
            index: self.span.start + 1,
            end: self.span.end - 1,
            decoded_offset: 0,
            escaped: self.has_escape,
        }
    }

    pub(crate) fn iter_from_decoded_offset(
        self,
        decoded_offset: usize,
    ) -> Option<(DecodedScalarIter<'a>, usize)> {
        if !self.has_escape {
            return None;
        }
        let checkpoint_index = self
            .checkpoints
            .partition_point(|checkpoint| checkpoint.decoded_offset <= decoded_offset);
        let checkpoint = checkpoint_index
            .checked_sub(1)
            .and_then(|index| self.checkpoints.get(index));
        let (source_offset, checkpoint_offset) = checkpoint
            .map(|checkpoint| (checkpoint.source_offset, checkpoint.decoded_offset))
            .unwrap_or((self.source_start(), 0));
        if checkpoint_offset > decoded_offset {
            return None;
        }
        let mut iterator = DecodedScalarIter {
            source: self.source,
            index: source_offset,
            end: self.source_end(),
            decoded_offset: checkpoint_offset,
            escaped: true,
        };
        while iterator.decoded_offset() < decoded_offset {
            let before = iterator.source_offset();
            iterator.next()?;
            if iterator.source_offset() == before || iterator.decoded_offset() > decoded_offset {
                return None;
            }
        }
        (iterator.decoded_offset() == decoded_offset).then_some((iterator, source_offset))
    }

    pub fn decoded_len(self) -> usize {
        if !self.has_escape {
            return self.inner().len();
        }
        self.iter().map(|scalar| scalar.value.len_utf8()).sum()
    }

    pub fn is_char_boundary(self, offset: usize) -> bool {
        if let Some(text) = self.borrowed() {
            return offset <= text.len() && text.is_char_boundary(offset);
        }
        if offset == 0 {
            return true;
        }
        self.iter().any(|scalar| scalar.end == offset)
    }

    pub fn to_cow(self) -> Cow<'a, str> {
        self.borrowed().map_or_else(
            || Cow::Owned(self.iter().map(|scalar| scalar.value).collect()),
            Cow::Borrowed,
        )
    }

    pub fn to_cow_limit(self, max_bytes: usize) -> Option<Cow<'a, str>> {
        if !self.has_escape {
            if self.inner().len() > max_bytes {
                return None;
            }
            let text = self.borrowed().expect("literal JSON string is valid UTF-8");
            return Some(Cow::Borrowed(text));
        }

        let mut output = String::new();
        for scalar in self.iter() {
            let next_len = output.len().checked_add(scalar.value.len_utf8())?;
            if next_len > max_bytes {
                return None;
            }
            output.push(scalar.value);
        }
        Some(Cow::Owned(output))
    }

    pub fn prefix_chars(self, max_chars: usize) -> (String, bool) {
        let mut output = String::new();
        let mut iter = self.iter();
        for _ in 0..max_chars {
            let Some(scalar) = iter.next() else {
                return (output, false);
            };
            output.push(scalar.value);
        }
        (output, iter.next().is_some())
    }
}

impl<'a> DecodedScalarIter<'a> {
    fn next_literal(&self) -> (char, usize) {
        let width = utf8_width(self.source[self.index]);
        let end = (self.index + width).min(self.end);
        let text = str::from_utf8(&self.source[self.index..end])
            .expect("parser validated JSON string UTF-8");
        let character = text.chars().next().expect("iterator is not at the end");
        (character, self.index + character.len_utf8())
    }

    pub(crate) fn source_offset(&self) -> usize {
        self.index
    }

    pub(crate) fn source_end(&self) -> usize {
        self.end
    }

    pub(crate) fn next_raw_width(&self) -> Option<usize> {
        if self.index >= self.end {
            return None;
        }
        if self.source[self.index] != b'\\' {
            return Some(utf8_width(self.source[self.index]));
        }
        let escape = *self.source.get(self.index + 1)?;
        if escape != b'u' {
            return Some(2);
        }
        let high = self.parse_hex4(self.index + 2);
        Some(if (0xd800..=0xdbff).contains(&high) {
            12
        } else {
            6
        })
    }

    pub(crate) fn decoded_offset(&self) -> usize {
        self.decoded_offset
    }

    fn parse_hex4(&self, index: usize) -> u16 {
        let mut value = 0u16;
        for byte in &self.source[index..index + 4] {
            let digit = match *byte {
                b'0'..=b'9' => *byte - b'0',
                b'a'..=b'f' => *byte - b'a' + 10,
                b'A'..=b'F' => *byte - b'A' + 10,
                _ => unreachable!("parser validated unicode escape digits"),
            };
            value = (value << 4) | u16::from(digit);
        }
        value
    }

    fn next_escape(&self) -> (char, usize) {
        debug_assert_eq!(self.source[self.index], b'\\');
        let escape = self.source[self.index + 1];
        let next = self.index + 2;
        match escape {
            b'"' => ('"', next),
            b'\\' => ('\\', next),
            b'/' => ('/', next),
            b'b' => ('\u{8}', next),
            b'f' => ('\u{c}', next),
            b'n' => ('\n', next),
            b'r' => ('\r', next),
            b't' => ('\t', next),
            b'u' => {
                let high = self.parse_hex4(next);
                let mut end = next + 4;
                let code_point = if (0xd800..=0xdbff).contains(&high) {
                    debug_assert_eq!(self.source[end], b'\\');
                    debug_assert_eq!(self.source[end + 1], b'u');
                    let low = self.parse_hex4(end + 2);
                    end += 6;
                    0x10000 + (((u32::from(high) - 0xd800) << 10) | (u32::from(low) - 0xdc00))
                } else {
                    u32::from(high)
                };
                (
                    char::from_u32(code_point).expect("parser validated Unicode scalar"),
                    end,
                )
            }
            _ => unreachable!("parser validated JSON string escape"),
        }
    }
}

fn utf8_width(first: u8) -> usize {
    match first {
        0..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => unreachable!("parser validated string UTF-8"),
    }
}

impl Iterator for DecodedScalarIter<'_> {
    type Item = DecodedScalar;

    fn next(&mut self) -> Option<Self::Item> {
        if self.index >= self.end {
            return None;
        }
        let (value, end) = if self.escaped && self.source[self.index] == b'\\' {
            self.next_escape()
        } else {
            self.next_literal()
        };
        self.index = end;
        let decoded_start = self.decoded_offset;
        self.decoded_offset += value.len_utf8();
        Some(DecodedScalar {
            value,
            start: decoded_start,
            end: self.decoded_offset,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParseError {
    pub message: String,
    pub byte_offset: usize,
    pub line: usize,
    pub column: usize,
}

pub fn parse_json(input: &[u8]) -> Result<ParsedJson<'_>, ParseError> {
    let (parsed, consumed) = parse_json_prefix(input)?;

    if consumed < input.len() {
        return Err(error_at(input, consumed, "trailing data"));
    }

    Ok(parsed)
}

pub fn parse_json_owned(input: Vec<u8>) -> Result<ParsedJson<'static>, ParseError> {
    let (nodes, checkpoints) = {
        let parsed = parse_json(&input)?;
        (parsed.nodes, parsed.checkpoints)
    };
    let source = String::from_utf8(input).expect("parse_json validated UTF-8");

    Ok(ParsedJson {
        source: Cow::Owned(source),
        nodes,
        checkpoints,
    })
}

pub(crate) fn parse_json_prefix(input: &[u8]) -> Result<(ParsedJson<'_>, usize), ParseError> {
    let text = from_utf8(input)
        .map_err(|error| error_at(input, error.valid_up_to(), "input is not valid UTF-8"))?;
    let mut parser = Parser {
        input,
        text,
        index: if input.starts_with(b"\xEF\xBB\xBF") {
            3
        } else {
            0
        },
        nodes: Vec::new(),
        checkpoints: Vec::new(),
    };
    let _root = parser.parse_value(None, ChildLocator::Root)?;
    parser.skip_whitespace();

    Ok((
        ParsedJson {
            source: Cow::Borrowed(text),
            nodes: parser.nodes,
            checkpoints: parser.checkpoints,
        },
        parser.index,
    ))
}

struct Parser<'a> {
    input: &'a [u8],
    text: &'a str,
    index: usize,
    nodes: Vec<JsonNode>,
    checkpoints: Vec<DecodedCheckpoint>,
}

impl<'a> Parser<'a> {
    fn error(&self, message: &str) -> ParseError {
        error_at(self.input, self.index, message)
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.byte(self.index), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.index += 1;
        }
    }

    fn byte(&self, index: usize) -> Option<u8> {
        self.input.get(index).copied()
    }

    fn parse_scalar(&mut self) -> Result<JsonNode, ParseError> {
        let start = self.index;
        let Some(byte) = self.byte(start) else {
            return Err(self.error("unexpected end of input"));
        };

        match byte {
            b'"' => self.parse_string(start),
            b'-' | b'0'..=b'9' => self.parse_number(start),
            b't' => self.parse_keyword(start, b"true", JsonKind::True),
            b'f' => self.parse_keyword(start, b"false", JsonKind::False),
            b'n' => self.parse_keyword(start, b"null", JsonKind::Null),
            _ => Err(self.error("expected a scalar JSON value")),
        }
    }

    fn parse_value(
        &mut self,
        parent: Option<NodeId>,
        locator: ChildLocator,
    ) -> Result<NodeId, ParseError> {
        self.skip_whitespace();

        match self.byte(self.index) {
            Some(b'{') => self.parse_object(parent, locator),
            Some(b'[') => self.parse_array(parent, locator),
            _ => {
                let mut node = self.parse_scalar()?;
                node.parent = parent;
                node.locator = locator;
                node.children = Vec::new();
                let id = NodeId(self.nodes.len());
                if node.kind == JsonKind::String && node.string_has_escape {
                    self.add_decoded_checkpoints(id.index(), node.span);
                }
                self.nodes.push(node);
                Ok(id)
            }
        }
    }

    fn parse_object(
        &mut self,
        parent: Option<NodeId>,
        locator: ChildLocator,
    ) -> Result<NodeId, ParseError> {
        let start = self.index;
        let id = NodeId(self.nodes.len());
        self.nodes.push(JsonNode {
            kind: JsonKind::Object,
            span: SourceSpan { start, end: start },
            locator,
            parent,
            children: Vec::new(),
            decoded: None,
            string_has_escape: false,
        });
        self.index += 1;
        self.skip_whitespace();

        if self.byte(self.index) == Some(b'}') {
            self.index += 1;
            self.nodes[id.0].span.end = self.index;
            return Ok(id);
        }

        let mut occurrences = HashMap::new();
        loop {
            self.skip_whitespace();
            if self.byte(self.index) != Some(b'"') {
                return Err(self.error("expected object key"));
            }

            let key_node = self.parse_string(self.index)?;
            let key = key_node
                .decoded
                .ok_or_else(|| self.error("expected object key"))?;
            let key_span = key_node.span;
            let occurrence = occurrences.entry(key.clone()).or_insert(0);
            *occurrence += 1;
            let occurrence = *occurrence;

            self.skip_whitespace();
            if self.byte(self.index) != Some(b':') {
                return Err(self.error("expected ':' after object key"));
            }
            self.index += 1;

            let child = self.parse_value(
                Some(id),
                ChildLocator::ObjectKey {
                    key,
                    key_span,
                    occurrence,
                },
            )?;
            self.nodes[id.0].children.push(child);

            self.skip_whitespace();
            match self.byte(self.index) {
                Some(b',') => self.index += 1,
                Some(b'}') => {
                    self.index += 1;
                    self.nodes[id.0].span.end = self.index;
                    return Ok(id);
                }
                _ => return Err(self.error("expected ',' or '}' after object value")),
            }
        }
    }

    fn parse_array(
        &mut self,
        parent: Option<NodeId>,
        locator: ChildLocator,
    ) -> Result<NodeId, ParseError> {
        let start = self.index;
        let id = NodeId(self.nodes.len());
        self.nodes.push(JsonNode {
            kind: JsonKind::Array,
            span: SourceSpan { start, end: start },
            locator,
            parent,
            children: Vec::new(),
            decoded: None,
            string_has_escape: false,
        });
        self.index += 1;
        self.skip_whitespace();

        if self.byte(self.index) == Some(b']') {
            self.index += 1;
            self.nodes[id.0].span.end = self.index;
            return Ok(id);
        }

        let mut array_index = 0;
        loop {
            let child = self.parse_value(Some(id), ChildLocator::ArrayIndex(array_index))?;
            self.nodes[id.0].children.push(child);
            array_index += 1;

            self.skip_whitespace();
            match self.byte(self.index) {
                Some(b',') => self.index += 1,
                Some(b']') => {
                    self.index += 1;
                    self.nodes[id.0].span.end = self.index;
                    return Ok(id);
                }
                _ => return Err(self.error("expected ',' or ']' after array element")),
            }
        }
    }

    fn parse_keyword(
        &mut self,
        start: usize,
        keyword: &[u8],
        kind: JsonKind,
    ) -> Result<JsonNode, ParseError> {
        if self.input[start..].starts_with(keyword) {
            self.index = start + keyword.len();
            Ok(JsonNode {
                kind,
                span: SourceSpan {
                    start,
                    end: self.index,
                },
                locator: ChildLocator::Root,
                parent: None,
                children: Vec::new(),
                decoded: None,
                string_has_escape: false,
            })
        } else {
            Err(self.error("invalid JSON literal"))
        }
    }

    fn parse_number(&mut self, start: usize) -> Result<JsonNode, ParseError> {
        let mut index = start;
        if self.byte(index) == Some(b'-') {
            index += 1;
        }

        match self.byte(index) {
            Some(b'0') => {
                index += 1;
                if matches!(self.byte(index), Some(b'0'..=b'9')) {
                    return Err(error_at(self.input, index, "leading zero is not allowed"));
                }
            }
            Some(b'1'..=b'9') => {
                index += 1;
                while matches!(self.byte(index), Some(b'0'..=b'9')) {
                    index += 1;
                }
            }
            _ => return Err(error_at(self.input, index, "expected a digit")),
        }

        if self.byte(index) == Some(b'.') {
            index += 1;
            let fraction_start = index;
            while matches!(self.byte(index), Some(b'0'..=b'9')) {
                index += 1;
            }
            if index == fraction_start {
                return Err(error_at(
                    self.input,
                    index,
                    "expected a digit after decimal point",
                ));
            }
        }

        if matches!(self.byte(index), Some(b'e' | b'E')) {
            index += 1;
            if matches!(self.byte(index), Some(b'+' | b'-')) {
                index += 1;
            }
            let exponent_start = index;
            while matches!(self.byte(index), Some(b'0'..=b'9')) {
                index += 1;
            }
            if index == exponent_start {
                return Err(error_at(self.input, index, "expected a digit in exponent"));
            }
        }

        self.index = index;
        Ok(JsonNode {
            kind: JsonKind::Number,
            span: SourceSpan { start, end: index },
            locator: ChildLocator::Root,
            parent: None,
            children: Vec::new(),
            decoded: None,
            string_has_escape: false,
        })
    }

    fn parse_string(&mut self, start: usize) -> Result<JsonNode, ParseError> {
        let mut decoded = String::new();
        let mut string_has_escape = false;
        self.index += 1;

        loop {
            let Some(character) = self.text[self.index..].chars().next() else {
                return Err(self.error("unterminated string"));
            };
            let character_start = self.index;

            if character == '"' {
                self.index += 1;
                return Ok(JsonNode {
                    kind: JsonKind::String,
                    span: SourceSpan {
                        start,
                        end: self.index,
                    },
                    locator: ChildLocator::Root,
                    parent: None,
                    children: Vec::new(),
                    decoded: Some(decoded),
                    string_has_escape,
                });
            }

            if character == '\\' {
                string_has_escape = true;
                self.parse_escape(&mut decoded)?;
            } else if matches!(character, '\u{0}'..='\u{1f}') {
                return Err(error_at(
                    self.input,
                    character_start,
                    "unescaped control character in string",
                ));
            } else {
                decoded.push(character);
                self.index += character.len_utf8();
            }
        }
    }

    fn add_decoded_checkpoints(&mut self, node_id: usize, span: SourceSpan) {
        let decoded = DecodedString {
            source: self.input,
            text: self.text,
            span,
            has_escape: true,
            checkpoints: &[],
        };
        let mut iterator = decoded.iter();
        let mut next_raw = span.start + 1 + DECODED_CHECKPOINT_RAW_STRIDE;
        while let Some(scalar) = iterator.next() {
            let source_offset = iterator.source_offset();
            if source_offset < next_raw {
                continue;
            }
            self.checkpoints.push(DecodedCheckpoint {
                node_id,
                source_offset,
                decoded_offset: scalar.end,
            });
            next_raw = next_raw.saturating_add(DECODED_CHECKPOINT_RAW_STRIDE);
        }
    }

    fn parse_escape(&mut self, decoded: &mut String) -> Result<(), ParseError> {
        let escape_start = self.index;
        self.index += 1;
        let Some(character) = self.text[self.index..].chars().next() else {
            return Err(self.error("unterminated string escape"));
        };
        self.index += character.len_utf8();

        match character {
            '"' => decoded.push('"'),
            '\\' => decoded.push('\\'),
            '/' => decoded.push('/'),
            'b' => decoded.push('\u{8}'),
            'f' => decoded.push('\u{c}'),
            'n' => decoded.push('\n'),
            'r' => decoded.push('\r'),
            't' => decoded.push('\t'),
            'u' => self.parse_unicode_escape(decoded, escape_start)?,
            _ => return Err(error_at(self.input, escape_start, "invalid string escape")),
        }

        Ok(())
    }

    fn parse_unicode_escape(
        &mut self,
        decoded: &mut String,
        escape_start: usize,
    ) -> Result<(), ParseError> {
        let high = self.parse_hex4()?;

        if (0xd800..=0xdbff).contains(&high) {
            if !self.input[self.index..].starts_with(b"\\u") {
                return Err(error_at(self.input, self.index, "unpaired high surrogate"));
            }
            self.index += 2;
            let low = self.parse_hex4()?;
            if !(0xdc00..=0xdfff).contains(&low) {
                return Err(error_at(
                    self.input,
                    self.index - 4,
                    "invalid low surrogate",
                ));
            }
            let code_point =
                0x10000 + (((u32::from(high) - 0xd800) << 10) | (u32::from(low) - 0xdc00));
            decoded.push(char::from_u32(code_point).expect("valid surrogate pair"));
        } else if (0xdc00..=0xdfff).contains(&high) {
            return Err(error_at(self.input, escape_start, "unpaired low surrogate"));
        } else {
            decoded.push(char::from_u32(u32::from(high)).expect("valid non-surrogate scalar"));
        }

        Ok(())
    }

    fn parse_hex4(&mut self) -> Result<u16, ParseError> {
        if self.index + 4 > self.input.len() {
            return Err(error_at(
                self.input,
                self.index,
                "incomplete unicode escape",
            ));
        }

        let mut value = 0;
        for offset in 0..4 {
            let byte = self.input[self.index + offset];
            let digit = match byte {
                b'0'..=b'9' => byte - b'0',
                b'a'..=b'f' => byte - b'a' + 10,
                b'A'..=b'F' => byte - b'A' + 10,
                _ => {
                    return Err(error_at(
                        self.input,
                        self.index + offset,
                        "invalid unicode escape digit",
                    ))
                }
            };
            value = (value << 4) | u16::from(digit);
        }

        self.index += 4;
        Ok(value)
    }
}

fn error_at(input: &[u8], byte_offset: usize, message: &str) -> ParseError {
    let valid = from_utf8(&input[..byte_offset]).unwrap_or("");
    let line = valid.bytes().filter(|byte| *byte == b'\n').count() + 1;
    let line_start = valid.rfind('\n').map_or(0, |index| index + 1);
    ParseError {
        message: message.to_owned(),
        byte_offset,
        line,
        column: byte_offset - line_start + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexeme<'a>(parsed: &'a ParsedJson<'_>) -> &'a str {
        str::from_utf8(parsed.raw_lexeme(parsed.root())).unwrap()
    }

    fn root<'a>(parsed: &'a ParsedJson<'_>) -> &'a JsonNode {
        parsed.node(parsed.root())
    }

    #[test]
    fn preserves_big_integer_and_exponent_lexemes() {
        let parsed = parse_json(b"123456789012345678901234567890").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::Number);
        assert_eq!(root(&parsed).decoded, None);
        assert_eq!(lexeme(&parsed), "123456789012345678901234567890");

        let parsed = parse_json(b"-1.234e+567890").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::Number);
        assert_eq!(lexeme(&parsed), "-1.234e+567890");
    }

    #[test]
    fn preserves_unicode_escape_and_literal_emoji() {
        let parsed = parse_json(b"\"\\u0041\"").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::String);
        assert_eq!(root(&parsed).decoded.as_deref(), Some("A"));
        assert_eq!(lexeme(&parsed), "\"\\u0041\"");

        let parsed = parse_json("\"🦀\"".as_bytes()).unwrap();
        assert_eq!(root(&parsed).decoded.as_deref(), Some("🦀"));
        assert_eq!(lexeme(&parsed), "\"🦀\"");
    }

    #[test]
    fn decodes_valid_surrogate_pair() {
        let parsed = parse_json(b"\"\\ud83d\\ude00\"").unwrap();
        assert_eq!(root(&parsed).decoded.as_deref(), Some("\u{1f600}"));
    }

    #[test]
    fn decodes_all_simple_string_escapes() {
        let cases = [
            (&b"\"\\\"\""[..], "\""),
            (&b"\"\\\\\""[..], "\\"),
            (&b"\"\\/\""[..], "/"),
            (&b"\"\\b\""[..], "\u{8}"),
            (&b"\"\\f\""[..], "\u{c}"),
            (&b"\"\\n\""[..], "\n"),
            (&b"\"\\r\""[..], "\r"),
            (&b"\"\\t\""[..], "\t"),
        ];

        for (input, expected) in cases {
            let parsed = parse_json(input).unwrap();
            assert_eq!(root(&parsed).kind, JsonKind::String);
            assert_eq!(root(&parsed).decoded.as_deref(), Some(expected));
        }
    }

    #[test]
    fn rejects_invalid_surrogate() {
        let error = parse_json(b"\"\\ud83d\"").unwrap_err();
        assert_eq!(error.byte_offset, 7);

        let error = parse_json(b"\"\\udc00\"").unwrap_err();
        assert_eq!(error.byte_offset, 1);
        assert_eq!(error.line, 1);
        assert_eq!(error.column, 2);
    }

    #[test]
    fn preserves_tabs_and_crlf_in_exact_span() {
        let parsed = parse_json(b"\t\"A\"\r\n").unwrap();
        assert_eq!(root(&parsed).span, SourceSpan { start: 1, end: 4 });
        assert_eq!(lexeme(&parsed), "\"A\"");
    }

    #[test]
    fn skips_utf8_bom() {
        let parsed = parse_json(b"\xEF\xBB\xBFtrue").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::True);
        assert_eq!(root(&parsed).span, SourceSpan { start: 3, end: 7 });
        assert_eq!(lexeme(&parsed), "true");

        let parsed = parse_json(b"\xEF\xBB\xBF\"A\"").unwrap();
        assert_eq!(root(&parsed).decoded.as_deref(), Some("A"));
        assert_eq!(root(&parsed).span, SourceSpan { start: 3, end: 6 });
        assert_eq!(lexeme(&parsed), "\"A\"");
    }

    #[test]
    fn rejects_invalid_utf8_and_non_json_whitespace() {
        let error = parse_json(b"\xFFtrue").unwrap_err();
        assert_eq!(error.byte_offset, 0);
        assert_eq!(error.message, "input is not valid UTF-8");

        let error = parse_json(b"true\xFF").unwrap_err();
        assert_eq!(error.byte_offset, 4);
        assert_eq!(error.message, "input is not valid UTF-8");

        let error = parse_json(b"\xC2\xA0").unwrap_err();
        assert_eq!(error.byte_offset, 0);
        assert_eq!(error.message, "expected a scalar JSON value");

        let error = parse_json(b"true\xC2\xA0").unwrap_err();
        assert_eq!(error.byte_offset, 4);
        assert_eq!(error.message, "trailing data");
    }

    #[test]
    fn parses_bool_and_null_roots() {
        let parsed = parse_json(b"true").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::True);

        let parsed = parse_json(b"false").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::False);

        let parsed = parse_json(b"null").unwrap();
        assert_eq!(root(&parsed).kind, JsonKind::Null);
    }

    #[test]
    fn reports_illegal_number_positions() {
        let cases = [
            (&b"-x"[..], 1),
            (&b"01"[..], 1),
            (&b"1."[..], 2),
            (&b"1e"[..], 2),
            (&b"1e+"[..], 3),
            (&b"1e+x"[..], 3),
        ];
        for (input, byte_offset) in cases {
            assert_eq!(parse_json(input).unwrap_err().byte_offset, byte_offset);
        }
    }

    #[test]
    fn reports_trailing_data_positions() {
        let error = parse_json(b"null\r\nfalse").unwrap_err();
        assert_eq!(error.byte_offset, 6);
        assert_eq!(error.line, 2);
        assert_eq!(error.column, 1);

        let error = parse_json(b"true x").unwrap_err();
        assert_eq!(error.byte_offset, 5);
        assert_eq!(error.line, 1);
        assert_eq!(error.column, 6);
    }

    #[test]
    fn parses_empty_container_roots() {
        let parsed = parse_json(b"{}").unwrap();
        let object = root(&parsed);
        assert_eq!(object.kind, JsonKind::Object);
        assert_eq!(object.locator, ChildLocator::Root);
        assert_eq!(object.parent, None);
        assert!(object.children.is_empty());
        assert_eq!(object.span, SourceSpan { start: 0, end: 2 });
        assert_eq!(lexeme(&parsed), "{}");

        let parsed = parse_json(b"[]").unwrap();
        let array = root(&parsed);
        assert_eq!(array.kind, JsonKind::Array);
        assert_eq!(array.locator, ChildLocator::Root);
        assert_eq!(array.parent, None);
        assert!(array.children.is_empty());
        assert_eq!(array.span, SourceSpan { start: 0, end: 2 });
        assert_eq!(lexeme(&parsed), "[]");
    }

    #[test]
    fn nested_parent_child_locators_and_spans() {
        let parsed = parse_json(b"{\"a\":[true,null]}").unwrap();
        let root_id = parsed.root();
        let object = parsed.node(root_id);
        let array_id = object.children[0];
        let true_id = parsed.node(array_id).children[0];
        let null_id = parsed.node(array_id).children[1];

        assert_eq!(object.kind, JsonKind::Object);
        assert_eq!(object.span, SourceSpan { start: 0, end: 17 });
        assert_eq!(object.locator, ChildLocator::Root);
        assert_eq!(object.parent, None);
        assert_eq!(object.children, [array_id]);

        assert_eq!(parsed.node(array_id).kind, JsonKind::Array);
        assert_eq!(parsed.node(array_id).span, SourceSpan { start: 5, end: 16 });
        assert_eq!(
            parsed.node(array_id).locator,
            ChildLocator::ObjectKey {
                key: "a".to_string(),
                key_span: SourceSpan { start: 1, end: 4 },
                occurrence: 1,
            }
        );
        assert_eq!(parsed.node(array_id).parent, Some(root_id));
        assert_eq!(parsed.node(array_id).children, [true_id, null_id]);

        assert_eq!(parsed.node(true_id).kind, JsonKind::True);
        assert_eq!(parsed.node(true_id).span, SourceSpan { start: 6, end: 10 });
        assert_eq!(parsed.node(true_id).locator, ChildLocator::ArrayIndex(0));
        assert_eq!(parsed.node(true_id).parent, Some(array_id));
        assert_eq!(str::from_utf8(parsed.raw_lexeme(true_id)).unwrap(), "true");

        assert_eq!(parsed.node(null_id).kind, JsonKind::Null);
        assert_eq!(parsed.node(null_id).span, SourceSpan { start: 11, end: 15 });
        assert_eq!(parsed.node(null_id).locator, ChildLocator::ArrayIndex(1));
        assert_eq!(parsed.node(null_id).parent, Some(array_id));
        assert_eq!(str::from_utf8(parsed.raw_lexeme(null_id)).unwrap(), "null");
        assert_eq!(lexeme(&parsed), "{\"a\":[true,null]}");
    }

    #[test]
    fn preserves_duplicate_key_occurrences() {
        let parsed = parse_json(b"{\"a\":1,\"a\":2,\"\\u0061\":3}").unwrap();
        let root_id = parsed.root();
        let object = parsed.node(root_id);

        assert_eq!(object.span, SourceSpan { start: 0, end: 24 });
        assert_eq!(object.children, [NodeId(1), NodeId(2), NodeId(3)]);

        let first = parsed.node(NodeId(1));
        assert_eq!(first.kind, JsonKind::Number);
        assert_eq!(first.parent, Some(root_id));
        assert_eq!(
            first.locator,
            ChildLocator::ObjectKey {
                key: "a".to_string(),
                key_span: SourceSpan { start: 1, end: 4 },
                occurrence: 1,
            }
        );
        assert_eq!(str::from_utf8(parsed.raw_lexeme(NodeId(1))).unwrap(), "1");

        let second = parsed.node(NodeId(2));
        assert_eq!(second.parent, Some(root_id));
        assert_eq!(
            second.locator,
            ChildLocator::ObjectKey {
                key: "a".to_string(),
                key_span: SourceSpan { start: 7, end: 10 },
                occurrence: 2,
            }
        );
        assert_eq!(str::from_utf8(parsed.raw_lexeme(NodeId(2))).unwrap(), "2");

        let third = parsed.node(NodeId(3));
        assert_eq!(third.parent, Some(root_id));
        assert_eq!(
            third.locator,
            ChildLocator::ObjectKey {
                key: "a".to_string(),
                key_span: SourceSpan { start: 13, end: 21 },
                occurrence: 3,
            }
        );
        assert_eq!(str::from_utf8(parsed.raw_lexeme(NodeId(3))).unwrap(), "3");
    }

    #[test]
    fn preserves_f08_mixed_object() {
        let source = "{\r\n  \"count\": 123456789012345678901234567890,\r\n  \"rate\": -1.234e+567890,\r\n  \"escaped\": \"\\u0041\",\r\n  \"emoji\": \"🦀\"\r\n}".as_bytes();
        let parsed = parse_json(source).unwrap();
        let root_id = parsed.root();
        let children = &parsed.node(root_id).children;

        assert_eq!(children.len(), 4);
        assert_eq!(lexeme(&parsed), str::from_utf8(source).unwrap());

        let count = parsed.node(children[0]);
        assert_eq!(count.kind, JsonKind::Number);
        assert_eq!(count.decoded, None);
        assert_eq!(
            str::from_utf8(parsed.raw_lexeme(children[0])).unwrap(),
            "123456789012345678901234567890"
        );

        let rate = parsed.node(children[1]);
        assert_eq!(rate.kind, JsonKind::Number);
        assert_eq!(rate.decoded, None);
        assert_eq!(
            str::from_utf8(parsed.raw_lexeme(children[1])).unwrap(),
            "-1.234e+567890"
        );

        let escaped = parsed.node(children[2]);
        assert_eq!(escaped.kind, JsonKind::String);
        assert_eq!(escaped.decoded.as_deref(), Some("A"));
        assert_eq!(
            str::from_utf8(parsed.raw_lexeme(children[2])).unwrap(),
            "\"\\u0041\""
        );

        let emoji = parsed.node(children[3]);
        assert_eq!(emoji.kind, JsonKind::String);
        assert_eq!(emoji.decoded.as_deref(), Some("🦀"));
        assert_eq!(
            str::from_utf8(parsed.raw_lexeme(children[3])).unwrap(),
            "\"🦀\""
        );
    }

    #[test]
    fn reports_container_syntax_error_positions() {
        let cases = [
            (
                &b"{ \"a\"\r\n1 }"[..],
                "expected ':' after object key",
                7,
                2,
                1,
            ),
            (
                &b"{ \"a\": 1\r\n\"b\": 2 }"[..],
                "expected ',' or '}' after object value",
                10,
                2,
                1,
            ),
            (&b"{ \"a\": 1, }"[..], "expected object key", 10, 1, 11),
            (&b"[ 1, ]"[..], "expected a scalar JSON value", 5, 1, 6),
            (
                &b"{ \"a\": 1"[..],
                "expected ',' or '}' after object value",
                8,
                1,
                9,
            ),
            (
                &b"[ 1"[..],
                "expected ',' or ']' after array element",
                3,
                1,
                4,
            ),
        ];

        for (input, message, byte_offset, line, column) in cases {
            let error = parse_json(input).unwrap_err();
            assert_eq!(error.message, message);
            assert_eq!(error.byte_offset, byte_offset);
            assert_eq!(error.line, line);
            assert_eq!(error.column, column);
        }
    }

    #[test]
    fn borrowed_source_and_lexeme_are_zero_copy() {
        let source = br#"{"value":1}"#;
        let parsed = parse_json(source).unwrap();

        assert_eq!(parsed.source().as_ptr(), source.as_ptr());
        assert_eq!(parsed.raw_lexeme(parsed.root()), source);
    }

    #[test]
    fn owned_arena_preserves_source_and_node_access() {
        let source = br#"{"a":1,"a":922337203685477580712345}"#.to_vec();
        let source_pointer = source.as_ptr();
        let parsed = parse_json_owned(source).unwrap();

        assert_eq!(parsed.source().as_ptr(), source_pointer);
        assert_eq!(parsed.node_count(), 3);
        let children = &parsed.node(parsed.root()).children;
        assert_eq!(children[0].index(), 1);
        assert_eq!(children[1].index(), 2);
        assert!(parsed.node_at(2).is_some());
        assert!(parsed.node_at(99).is_none());
        assert!(matches!(
            parsed.node(children[1]).locator,
            ChildLocator::ObjectKey { occurrence: 2, .. }
        ));
        assert_eq!(parsed.raw_lexeme(children[1]), b"922337203685477580712345");
    }

    #[test]
    fn decoded_string_borrows_literal_payload_without_materializing_it() {
        let source = "[\"literal 😀\"]".as_bytes();
        let parsed = parse_json(source).unwrap();
        let decoded = parsed.decoded_string_at(1).unwrap();
        let borrowed = decoded.borrowed().unwrap();

        assert_eq!(borrowed, "literal 😀");
        assert_eq!(borrowed.as_ptr(), source[2..].as_ptr());
        assert_eq!(decoded.to_cow().as_ref(), "literal 😀");
    }

    #[test]
    fn decoded_string_iter_decodes_escape_scalars_and_byte_offsets() {
        let parsed = parse_json("[\"\\u4f60\\u597d😀\"]".as_bytes()).unwrap();
        let decoded = parsed.decoded_string_at(1).unwrap();
        let scalars: Vec<_> = decoded.iter().collect();

        assert_eq!(decoded.to_cow().as_ref(), "你好😀");
        assert_eq!(
            scalars,
            vec![
                DecodedScalar {
                    value: '你',
                    start: 0,
                    end: 3,
                },
                DecodedScalar {
                    value: '好',
                    start: 3,
                    end: 6,
                },
                DecodedScalar {
                    value: '😀',
                    start: 6,
                    end: 10,
                },
            ]
        );
        assert!(decoded.is_char_boundary(6));
        assert!(!decoded.is_char_boundary(5));
        assert_eq!(decoded.prefix_chars(2), ("你好".to_owned(), true));
        assert!(decoded.to_cow_limit(9).is_none());
        assert_eq!(decoded.to_cow_limit(10).unwrap().as_ref(), "你好😀");
    }

    #[test]
    fn escaped_value_sparse_checkpoints_bound_cursor_relocation_and_keep_short_values_free() {
        let long_value = format!(
            "{}\\\\u1234{}\\u1234\\ud83d\\ude00",
            "a".repeat(70_000),
            "b".repeat(70_000)
        );
        let parsed = parse_json_owned(format!(r#"["{long_value}"]"#).into_bytes()).unwrap();
        let decoded = parsed.decoded_string_at(1).unwrap();
        assert!(!parsed.checkpoints.is_empty());

        let target = 70_000 + 6 + 70_000 + 'ሴ'.len_utf8();
        let (iterator, checkpoint_source) = decoded.iter_from_decoded_offset(target).unwrap();
        assert!(
            iterator.source_offset().saturating_sub(checkpoint_source)
                <= DECODED_CHECKPOINT_RAW_STRIDE + 12
        );
        assert!(decoded
            .iter_from_decoded_offset(decoded.decoded_len() + 1)
            .is_none());

        let key = "k".repeat(DECODED_CHECKPOINT_RAW_STRIDE + 1);
        let keyed =
            parse_json_owned(format!(r#"{{"{key}":"{long_value}"}}"#).into_bytes()).unwrap();
        assert!(!keyed.checkpoints.is_empty());
        assert!(keyed
            .checkpoints
            .iter()
            .all(|checkpoint| checkpoint.node_id == 1));

        let short = parse_json_owned(br#"["\u1234"]"#.to_vec()).unwrap();
        let short_decoded = short.decoded_string_at(1).unwrap();
        assert!(short.checkpoints.is_empty());
        assert!(short_decoded.iter_from_decoded_offset(3).is_some());
        assert!(short_decoded.iter_from_decoded_offset(2).is_none());
    }
}
