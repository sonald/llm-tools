use std::borrow::Cow;

use arboard::Clipboard;
use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClipboardImage {
    pub width: usize,
    pub height: usize,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Error)]
pub enum ClipboardError {
    #[error("failed to access the clipboard: {0}")]
    Access(String),
    #[error("clipboard does not contain an image: {0}")]
    NotImage(String),
    #[error("failed to write to the clipboard: {0}")]
    Write(String),
}

pub trait ClipboardBackend {
    fn get_image(&mut self) -> Result<ClipboardImage, ClipboardError>;
    fn set_text(&mut self, text: &str) -> Result<(), ClipboardError>;
}

pub struct SystemClipboard {
    inner: Clipboard,
}

impl SystemClipboard {
    pub fn new() -> Result<Self, ClipboardError> {
        let inner = Clipboard::new().map_err(|err| ClipboardError::Access(err.to_string()))?;
        Ok(Self { inner })
    }
}

impl ClipboardBackend for SystemClipboard {
    fn get_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
        let image = self
            .inner
            .get_image()
            .map_err(|err| ClipboardError::NotImage(err.to_string()))?;

        Ok(ClipboardImage {
            width: image.width,
            height: image.height,
            bytes: image.bytes.into_owned(),
        })
    }

    fn set_text(&mut self, text: &str) -> Result<(), ClipboardError> {
        self.inner
            .set_text(Cow::Owned(text.to_string()))
            .map_err(|err| ClipboardError::Write(err.to_string()))
    }
}
