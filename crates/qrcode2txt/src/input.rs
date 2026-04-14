use std::io::{self, Read};
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, RgbaImage};
use thiserror::Error;

use crate::clipboard::{ClipboardBackend, ClipboardError};
use crate::{LoadedSource, SourceKind};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceSpec {
    pub source_index: usize,
    pub source_kind: SourceKind,
    pub source_label: String,
    pub path: Option<PathBuf>,
}

#[derive(Debug, Error)]
pub enum StdinLoadError {
    #[error("{0}")]
    Read(String),
    #[error("{0}")]
    Content(String),
}

#[derive(Debug, Error)]
pub enum ClipboardLoadError {
    #[error("{0}")]
    Access(String),
    #[error("{0}")]
    Content(String),
}

pub fn file_specs(paths: &[PathBuf]) -> Vec<SourceSpec> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| SourceSpec {
            source_index: index,
            source_kind: SourceKind::File,
            source_label: path.display().to_string(),
            path: Some(path.clone()),
        })
        .collect()
}

pub fn load_file_source(spec: &SourceSpec) -> Result<LoadedSource> {
    let path = spec
        .path
        .as_ref()
        .ok_or_else(|| anyhow!("missing path for file source"))?;
    let image =
        image::open(path).with_context(|| format!("failed to open image '{}'", path.display()))?;

    Ok(LoadedSource {
        source_index: spec.source_index,
        source_kind: spec.source_kind,
        source_label: spec.source_label.clone(),
        image,
    })
}

pub fn load_stdin_source() -> std::result::Result<LoadedSource, StdinLoadError> {
    let mut bytes = Vec::new();
    io::stdin()
        .read_to_end(&mut bytes)
        .context("failed to read image bytes from stdin")
        .map_err(|err| StdinLoadError::Read(err.to_string()))?;

    if bytes.is_empty() {
        return Err(StdinLoadError::Content("stdin was empty".to_string()));
    }

    let image = image::load_from_memory(&bytes)
        .context("failed to decode image bytes from stdin")
        .map_err(|err| StdinLoadError::Content(err.to_string()))?;

    Ok(LoadedSource {
        source_index: 0,
        source_kind: SourceKind::Stdin,
        source_label: "<stdin>".to_string(),
        image,
    })
}

pub fn load_clipboard_source<C>(
    clipboard: &mut C,
) -> std::result::Result<LoadedSource, ClipboardLoadError>
where
    C: ClipboardBackend,
{
    let image = clipboard.get_image().map_err(map_clipboard_read_error)?;
    let image = image_from_clipboard_bytes(image.width, image.height, image.bytes)
        .map_err(|err| ClipboardLoadError::Content(err.to_string()))?;

    Ok(LoadedSource {
        source_index: 0,
        source_kind: SourceKind::Clipboard,
        source_label: "<clipboard>".to_string(),
        image,
    })
}

fn map_clipboard_read_error(error: ClipboardError) -> ClipboardLoadError {
    match error {
        ClipboardError::Access(message) => ClipboardLoadError::Access(message),
        ClipboardError::NotImage(message) | ClipboardError::Write(message) => {
            ClipboardLoadError::Content(message)
        }
    }
}

fn image_from_clipboard_bytes(width: usize, height: usize, bytes: Vec<u8>) -> Result<DynamicImage> {
    let image = RgbaImage::from_raw(width as u32, height as u32, bytes)
        .ok_or_else(|| anyhow!("clipboard image data had an unexpected size"))?;
    Ok(DynamicImage::ImageRgba8(image))
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, Rgba, RgbaImage};

    use crate::clipboard::{ClipboardBackend, ClipboardError, ClipboardImage};

    use super::load_clipboard_source;

    #[derive(Default)]
    struct MockClipboard {
        image: Option<ClipboardImage>,
        text: Option<String>,
    }

    impl ClipboardBackend for MockClipboard {
        fn get_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
            self.image
                .clone()
                .ok_or_else(|| ClipboardError::NotImage("no image in clipboard".to_string()))
        }

        fn set_text(&mut self, text: &str) -> Result<(), ClipboardError> {
            self.text = Some(text.to_string());
            Ok(())
        }
    }

    #[test]
    fn loads_clipboard_image_into_dynamic_image() {
        let image = DynamicImage::ImageRgba8(RgbaImage::from_pixel(4, 3, Rgba([10, 20, 30, 255])));
        let mut clipboard = MockClipboard {
            image: Some(ClipboardImage {
                width: image.width() as usize,
                height: image.height() as usize,
                bytes: image.to_rgba8().into_raw(),
            }),
            text: None,
        };

        let loaded = load_clipboard_source(&mut clipboard).expect("clipboard image should load");

        assert_eq!(loaded.source_label, "<clipboard>");
        assert_eq!(loaded.image.width(), 4);
        assert_eq!(loaded.image.height(), 3);
    }
}
