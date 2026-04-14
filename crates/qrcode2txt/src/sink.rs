use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{anyhow, Context, Result};

use crate::clipboard::ClipboardBackend;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutputTarget {
    Stdout,
    File(PathBuf),
    Clipboard,
}

pub fn write_output<C>(
    target: &OutputTarget,
    content: &str,
    clipboard: Option<&mut C>,
) -> Result<()>
where
    C: ClipboardBackend,
{
    match target {
        OutputTarget::Stdout => {
            let mut stdout = io::stdout().lock();
            stdout.write_all(content.as_bytes())?;
            stdout.flush()?;
            Ok(())
        }
        OutputTarget::File(path) => fs::write(path, content)
            .with_context(|| format!("failed to write output file '{}'", path.display())),
        OutputTarget::Clipboard => {
            let clipboard =
                clipboard.ok_or_else(|| anyhow!("clipboard backend was not initialized"))?;
            clipboard
                .set_text(content)
                .map_err(|err| anyhow!(err.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::clipboard::{ClipboardBackend, ClipboardError, ClipboardImage};

    use super::{write_output, OutputTarget};

    #[derive(Default)]
    struct MockClipboard {
        text: Option<String>,
    }

    impl ClipboardBackend for MockClipboard {
        fn get_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
            Err(ClipboardError::NotImage("not used".to_string()))
        }

        fn set_text(&mut self, text: &str) -> Result<(), ClipboardError> {
            self.text = Some(text.to_string());
            Ok(())
        }
    }

    #[test]
    fn writes_text_to_mock_clipboard() {
        let mut clipboard = MockClipboard::default();

        write_output(
            &OutputTarget::Clipboard,
            "decoded text",
            Some(&mut clipboard),
        )
        .expect("clipboard output");

        assert_eq!(clipboard.text.as_deref(), Some("decoded text"));
    }
}
