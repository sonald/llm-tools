use std::{
    collections::HashMap,
    fmt,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub const MAX_PATTERN_BYTES: usize = 4096;
pub const MAX_PATTERN_TOKENS: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Syntax {
    Literal,
    Glob,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PatternError {
    Empty,
    TooLong,
    TooManyTokens,
    OnlyWildcards,
    InvalidEscape,
}

impl fmt::Display for PatternError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Empty => "query must not be empty",
            Self::TooLong => "query exceeds the 4096-byte limit",
            Self::TooManyTokens => "glob pattern exceeds the 256-token limit",
            Self::OnlyWildcards => "glob pattern must contain a literal or question mark",
            Self::InvalidEscape => "glob pattern contains an invalid escape",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Token {
    Literal(char),
    Any,
    Star,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pattern {
    syntax: Syntax,
    tokens: Vec<Token>,
    query: String,
    literal: String,
}

#[derive(Clone, Debug)]
pub struct Task {
    pub id: u64,
    pub file_generation: u64,
    pub query: String,
    pub syntax: Syntax,
    pub mode: crate::search::SearchMode,
    pub pattern: Pattern,
    pub next_ordinal: u64,
    pub scanned: u64,
    pub matches: Vec<u64>,
    pub done: bool,
    pub stopped: bool,
    pub cancelled: Arc<AtomicBool>,
    pub results_cancelled: Arc<AtomicBool>,
    pub in_flight: bool,
    pub skipped_invalid_json: u64,
    pub skipped_invalid_utf8: u64,
    pub skipped_oversized: u64,
}

impl Task {
    pub fn new(
        id: u64,
        file_generation: u64,
        query: String,
        syntax: Syntax,
        mode: crate::search::SearchMode,
    ) -> Result<Self, PatternError> {
        let pattern = Pattern::parse(&query, syntax)?;
        Ok(Self {
            id,
            file_generation,
            query,
            syntax,
            mode,
            pattern,
            next_ordinal: 0,
            scanned: 0,
            matches: Vec::new(),
            done: false,
            stopped: false,
            cancelled: Arc::new(AtomicBool::new(false)),
            results_cancelled: Arc::new(AtomicBool::new(false)),
            in_flight: false,
            skipped_invalid_json: 0,
            skipped_invalid_utf8: 0,
            skipped_oversized: 0,
        })
    }

    pub fn record(&mut self, ordinal: u64, bytes: u64, matched: bool) {
        if matched {
            self.matches.push(ordinal);
        }
        self.next_ordinal = ordinal.saturating_add(1);
        self.scanned = self.scanned.saturating_add(bytes);
    }
}

impl Pattern {
    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn is_glob(&self) -> bool {
        self.syntax == Syntax::Glob
    }

    pub fn parse(query: &str, syntax: Syntax) -> Result<Self, PatternError> {
        if query.is_empty() {
            return Err(PatternError::Empty);
        }
        if query.len() > MAX_PATTERN_BYTES {
            return Err(PatternError::TooLong);
        }
        let tokens = match syntax {
            Syntax::Literal => query.chars().map(Token::Literal).collect(),
            Syntax::Glob => parse_glob(query)?,
        };
        let literal = if syntax == Syntax::Literal {
            query.to_owned()
        } else {
            String::new()
        };
        Ok(Self {
            syntax,
            tokens,
            query: query.to_owned(),
            literal,
        })
    }

    pub fn stream(&self) -> StreamMatcher<'_> {
        StreamMatcher::new(self)
    }

    pub fn find(&self, text: &str) -> Option<(usize, usize)> {
        self.find_cancellable(text, &AtomicBool::new(false))
            .unwrap()
    }

    pub fn find_cancellable(
        &self,
        text: &str,
        cancelled: &AtomicBool,
    ) -> Result<Option<(usize, usize)>, ()> {
        let mut stream = self.stream();
        for chunk in text.as_bytes().chunks(4096) {
            if cancelled.load(Ordering::Relaxed) {
                return Err(());
            }
            stream.feed(chunk);
            if stream.range.is_some() {
                return Ok(stream.range);
            }
        }
        Ok(stream.range)
    }

    pub fn matches_bytes(&self, bytes: &[u8]) -> Option<bool> {
        let mut stream = self.stream();
        stream.feed(bytes);
        stream.finish()
    }
}

fn parse_glob(query: &str) -> Result<Vec<Token>, PatternError> {
    let mut tokens = Vec::new();
    let mut characters = query.chars();
    let mut has_content = false;
    while let Some(character) = characters.next() {
        let token = match character {
            '*' => {
                if tokens.last() == Some(&Token::Star) {
                    continue;
                }
                Token::Star
            }
            '?' => {
                has_content = true;
                Token::Any
            }
            '\\' => match characters.next() {
                Some(escaped @ ('*' | '?' | '\\')) => {
                    has_content = true;
                    Token::Literal(escaped)
                }
                _ => return Err(PatternError::InvalidEscape),
            },
            literal => {
                has_content = true;
                Token::Literal(literal)
            }
        };
        tokens.push(token);
        if tokens.len() > MAX_PATTERN_TOKENS {
            return Err(PatternError::TooManyTokens);
        }
    }
    if !has_content {
        return Err(PatternError::OnlyWildcards);
    }
    Ok(tokens)
}

// Each star separates independently searchable fixed-length pieces. Shift-and
// matches a piece in at most four word operations per character, including '?'.
struct Piece {
    literals: HashMap<char, [u64; 4]>,
    any: [u64; 4],
    len: usize,
}

pub struct StreamMatcher<'a> {
    pattern: &'a Pattern,
    prefix: Vec<usize>,
    literal_matched: usize,
    pieces: Vec<Piece>,
    piece_index: usize,
    active: [u64; 4],
    starts: [usize; MAX_PATTERN_TOKENS],
    character_count: usize,
    start: usize,
    offset: usize,
    pending: Vec<u8>,
    invalid: bool,
    range: Option<(usize, usize)>,
}

impl<'a> StreamMatcher<'a> {
    fn new(pattern: &'a Pattern) -> Self {
        let mut prefix = vec![0; pattern.literal.len()];
        for i in 1..prefix.len() {
            let mut j = prefix[i - 1];
            while j > 0 && pattern.literal.as_bytes()[i] != pattern.literal.as_bytes()[j] {
                j = prefix[j - 1];
            }
            if pattern.literal.as_bytes()[i] == pattern.literal.as_bytes()[j] {
                j += 1;
            }
            prefix[i] = j;
        }
        let pieces = if pattern.is_glob() {
            pattern
                .tokens
                .split(|token| *token == Token::Star)
                .filter(|tokens| !tokens.is_empty())
                .map(|tokens| {
                    let mut piece = Piece {
                        literals: HashMap::new(),
                        any: [0; 4],
                        len: tokens.len(),
                    };
                    for (i, token) in tokens.iter().enumerate() {
                        let mask = match token {
                            Token::Literal(c) => piece.literals.entry(*c).or_insert([0; 4]),
                            Token::Any => &mut piece.any,
                            Token::Star => unreachable!(),
                        };
                        mask[i / 64] |= 1 << (i % 64);
                    }
                    piece
                })
                .collect()
        } else {
            Vec::new()
        };
        Self {
            pattern,
            prefix,
            literal_matched: 0,
            pieces,
            piece_index: 0,
            active: [0; 4],
            starts: [0; MAX_PATTERN_TOKENS],
            character_count: 0,
            start: 0,
            offset: 0,
            pending: Vec::new(),
            invalid: false,
            range: None,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        if self.invalid {
            return;
        }
        if !self.pattern.is_glob() {
            if self.range.is_some() {
                return;
            }
            let needle = self.pattern.literal.as_bytes();
            for &byte in bytes {
                while self.literal_matched > 0 && needle[self.literal_matched] != byte {
                    self.literal_matched = self.prefix[self.literal_matched - 1];
                }
                if needle[self.literal_matched] == byte {
                    self.literal_matched += 1;
                }
                self.offset += 1;
                if self.literal_matched == needle.len() {
                    self.range = Some((self.offset - needle.len(), self.offset));
                    return;
                }
            }
            return;
        }
        // At most one split UTF-8 character is carried between chunks.
        if !self.pending.is_empty() {
            let needed = match self.pending[0] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                _ => 4,
            } - self.pending.len();
            let take = needed.min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            if take < needed {
                return;
            }
            let pending = std::mem::take(&mut self.pending);
            self.feed(&pending);
            self.feed(&bytes[take..]);
            return;
        }
        let (valid, tail) = match std::str::from_utf8(bytes) {
            Ok(text) => (text, &[][..]),
            Err(error) => {
                if error.error_len().is_some() {
                    self.invalid = true;
                    return;
                }
                (
                    std::str::from_utf8(&bytes[..error.valid_up_to()]).unwrap(),
                    &bytes[error.valid_up_to()..],
                )
            }
        };
        for character in valid.chars() {
            if self.range.is_none() {
                self.feed_character(character);
            }
            self.offset += character.len_utf8();
        }
        self.pending.extend_from_slice(tail);
    }

    fn feed_character(&mut self, character: char) {
        let piece = &self.pieces[self.piece_index];
        let literals = piece.literals.get(&character).copied().unwrap_or([0; 4]);
        let mut carry = 1;
        for (word, literal) in literals.iter().enumerate().take(piece.len.div_ceil(64)) {
            let next_carry = self.active[word] >> 63;
            self.active[word] = ((self.active[word] << 1) | carry) & (literal | piece.any[word]);
            carry = next_carry;
        }
        self.starts[self.character_count % MAX_PATTERN_TOKENS] = self.offset;
        self.character_count += 1;
        if self.active[(piece.len - 1) / 64] & (1 << ((piece.len - 1) % 64)) == 0 {
            return;
        }
        if self.piece_index == 0 && self.pattern.tokens.first() != Some(&Token::Star) {
            self.start = self.starts[(self.character_count - piece.len) % MAX_PATTERN_TOKENS];
        }
        self.piece_index += 1;
        self.active = [0; 4];
        if self.piece_index == self.pieces.len() {
            self.range = Some((self.start, self.offset + character.len_utf8()));
        }
    }

    pub fn range(&self) -> Option<(usize, usize)> {
        self.range
    }

    pub fn finish(&self) -> Option<bool> {
        if self.invalid || !self.pending.is_empty() {
            None
        } else {
            Some(self.range.is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_unicode_and_escapes_without_crossing_fields() {
        let pattern = Pattern::parse("user_?", Syntax::Glob).unwrap();
        assert_eq!(pattern.find("x user_猫"), Some((2, 10)));
        assert_eq!(pattern.find("user_"), None);
        assert_eq!(
            Pattern::parse(r"a\*b", Syntax::Glob).unwrap().find("xa*b"),
            Some((1, 4))
        );
        assert_eq!(
            Pattern::parse("err*timeout", Syntax::Glob)
                .unwrap()
                .find("err\nthen timeout"),
            Some((0, 16))
        );
    }

    #[test]
    fn streams_globs_and_literals_across_byte_boundaries() {
        for (query, syntax, text) in [
            ("err*猫?timeout", Syntax::Glob, "xxerr\n猫!timeout!"),
            ("猫timeout", Syntax::Literal, "xx猫timeout!"),
            (
                &"a".repeat(256),
                Syntax::Glob,
                &format!("x{}", "a".repeat(256)),
            ),
            ("?*?", Syntax::Glob, "猫狗"),
        ] {
            let pattern = Pattern::parse(query, syntax).unwrap();
            assert!(pattern.find(text).is_some());
            for size in 1..=8 {
                let mut stream = pattern.stream();
                for chunk in text.as_bytes().chunks(size) {
                    stream.feed(chunk);
                }
                assert_eq!(stream.finish(), Some(true), "query={query}, size={size}");
                assert_eq!(stream.range, pattern.find(text));
            }
        }
    }

    #[test]
    fn raw_glob_validates_entire_stream_and_literal_accepts_invalid_utf8() {
        let glob = Pattern::parse("err*timeout", Syntax::Glob).unwrap();
        let mut stream = glob.stream();
        stream.feed(b"err timeout");
        stream.feed(&[0xff]);
        assert_eq!(stream.finish(), None);
        let mut stream = glob.stream();
        stream.feed(b"err timeout");
        stream.feed(&[0xe7]);
        assert_eq!(stream.finish(), None);
        assert_eq!(
            Pattern::parse("err", Syntax::Literal)
                .unwrap()
                .matches_bytes(b"err\xff"),
            Some(true)
        );
        assert!(glob
            .find_cancellable("err timeout", &AtomicBool::new(true))
            .is_err());
    }

    #[test]
    fn glob_streams_more_than_sixteen_megabytes_without_retaining_text() {
        let pattern = Pattern::parse("error*timeout", Syntax::Glob).unwrap();
        let mut stream = pattern.stream();
        stream.feed(b"error");
        let chunk = [b'x'; 4096];
        for _ in 0..4097 {
            stream.feed(&chunk);
        }
        stream.feed(b"timeout");
        assert_eq!(stream.finish(), Some(true));
        assert_eq!(stream.range, Some((0, 5 + 4097 * 4096 + 7)));
    }

    #[test]
    fn glob_rejects_empty_wildcards_and_bad_escapes() {
        assert_eq!(
            Pattern::parse("***", Syntax::Glob),
            Err(PatternError::OnlyWildcards)
        );
        assert_eq!(
            Pattern::parse("a\\", Syntax::Glob),
            Err(PatternError::InvalidEscape)
        );
        assert_eq!(
            Pattern::parse("", Syntax::Literal),
            Err(PatternError::Empty)
        );
    }
}
