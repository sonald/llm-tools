use std::str::{self, from_utf8};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NodeId(usize);

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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChildLocator {
    Root,
}

#[derive(Debug, Eq, PartialEq)]
pub struct JsonNode {
    pub kind: JsonKind,
    pub span: SourceSpan,
    pub locator: ChildLocator,
    pub decoded: Option<String>,
}

#[derive(Debug)]
pub struct ParsedJson<'a> {
    source: &'a [u8],
    nodes: [JsonNode; 1],
}

impl<'a> ParsedJson<'a> {
    pub fn root(&self) -> NodeId {
        NodeId(0)
    }

    pub fn node(&self, id: NodeId) -> &JsonNode {
        &self.nodes[id.0]
    }

    pub fn raw_lexeme(&self, id: NodeId) -> &'a [u8] {
        let span = self.node(id).span;
        &self.source[span.start..span.end]
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
    };
    let node = parser.parse_scalar()?;
    parser.skip_whitespace();

    if parser.index < parser.input.len() {
        return Err(parser.error("trailing data"));
    }

    Ok(ParsedJson {
        source: input,
        nodes: [node],
    })
}

struct Parser<'a> {
    input: &'a [u8],
    text: &'a str,
    index: usize,
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
        self.skip_whitespace();
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
            b'{' | b'[' => Err(self.error(
                "unsupported container root; object and array support is not implemented yet",
            )),
            _ => Err(self.error("expected a scalar JSON value")),
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
                decoded: None,
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
            decoded: None,
        })
    }

    fn parse_string(&mut self, start: usize) -> Result<JsonNode, ParseError> {
        let mut decoded = String::new();
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
                    decoded: Some(decoded),
                });
            }

            if character == '\\' {
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
    fn rejects_container_roots() {
        for input in [b"{}" as &[u8], b"[]"] {
            let error = parse_json(input).unwrap_err();
            assert!(error.message.contains("unsupported container root"));
        }
    }
}
