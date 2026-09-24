use std::fmt;

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

#[derive(Clone, Debug, Eq, PartialEq)]
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

    pub fn find(&self, text: &str) -> Option<(usize, usize)> {
        match self.syntax {
            Syntax::Literal => text
                .match_indices(&self.literal)
                .next()
                .map(|(start, value)| (start, start + value.len())),
            Syntax::Glob => find_glob(&self.tokens, text),
        }
    }

    pub fn matches_bytes(&self, bytes: &[u8]) -> Option<bool> {
        match self.syntax {
            Syntax::Literal => Some(
                bytes
                    .windows(self.query.len())
                    .any(|window| window == self.query.as_bytes()),
            ),
            Syntax::Glob => std::str::from_utf8(bytes)
                .ok()
                .map(|text| self.find(text).is_some()),
        }
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

fn find_glob(tokens: &[Token], text: &str) -> Option<(usize, usize)> {
    let text: Vec<(usize, char)> = text.char_indices().collect();
    let mut pieces: Vec<Vec<Token>> = Vec::new();
    let mut piece = Vec::new();
    for token in tokens {
        if *token == Token::Star {
            if !piece.is_empty() {
                pieces.push(std::mem::take(&mut piece));
            }
        } else {
            piece.push(*token);
        }
    }
    if !piece.is_empty() {
        pieces.push(piece);
    }

    let starts_anywhere = tokens.first() == Some(&Token::Star);
    let mut search_from = 0usize;
    let mut match_start = 0usize;
    let mut match_end = 0usize;
    for (index, piece) in pieces.iter().enumerate() {
        let Some(start) = find_piece(&text, piece, search_from) else {
            return None;
        };
        if index == 0 && !starts_anywhere {
            match_start = start;
        }
        match_end = start + piece.len();
        search_from = match_end;
    }
    if pieces.is_empty() {
        return Some((0, 0));
    }
    let start = if starts_anywhere { 0 } else { match_start };
    let end = match_end;
    let byte_start = text.get(start).map_or(0, |(byte, _)| *byte);
    let byte_end = text.get(end).map_or_else(
        || {
            text.last()
                .map_or(0, |(byte, character)| byte + character.len_utf8())
        },
        |(byte, _)| *byte,
    );
    Some((byte_start, byte_end))
}

fn find_piece(text: &[(usize, char)], piece: &[Token], from: usize) -> Option<usize> {
    let last_start = text.len().checked_sub(piece.len())?;
    (from..=last_start).find(|&start| {
        piece.iter().enumerate().all(|(offset, token)| match token {
            Token::Literal(expected) => text[start + offset].1 == *expected,
            Token::Any => true,
            Token::Star => false,
        })
    })
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
