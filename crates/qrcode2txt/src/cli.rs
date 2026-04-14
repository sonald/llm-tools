use std::path::PathBuf;

use clap::{ArgAction, Parser, ValueEnum};

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputFormat {
    Json,
    Yaml,
    Raw,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub enum OutputDestination {
    Stdout,
    File,
    Clipboard,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InputMode {
    Files(Vec<PathBuf>),
    Stdin,
    Clipboard,
}

#[derive(Debug, Parser)]
#[command(
    author,
    version,
    about = "Decode QR codes from files, stdin, or the clipboard"
)]
pub struct Cli {
    #[arg(value_name = "PATH")]
    pub paths: Vec<PathBuf>,

    #[arg(long, help = "Read a single image from stdin as raw image bytes")]
    pub stdin: bool,

    #[arg(long, help = "Read a single image from the system clipboard")]
    pub clipboard: bool,

    #[arg(long, value_enum, default_value_t = OutputFormat::Json)]
    pub format: OutputFormat,

    #[arg(long, value_enum, default_value_t = OutputDestination::Stdout)]
    pub output: OutputDestination,

    #[arg(long, value_name = "PATH")]
    pub output_file: Option<PathBuf>,

    #[arg(
        long,
        default_value_t = 0,
        help = "Parallel worker count for file inputs; 0 uses Rayon default"
    )]
    pub jobs: usize,

    #[arg(long, action = ArgAction::Set, default_value_t = true, help = "Pretty-print structured output")]
    pub pretty: bool,

    #[arg(
        long,
        default_value_t = false,
        help = "Suppress stderr messages for failed sources"
    )]
    pub quiet_errors: bool,

    #[arg(
        long,
        default_value_t = false,
        help = "Stop after the first failed source"
    )]
    pub fail_fast: bool,
}

impl Cli {
    pub fn validate(&self) -> Result<(), String> {
        let active_inputs = usize::from(!self.paths.is_empty())
            + usize::from(self.stdin)
            + usize::from(self.clipboard);

        if active_inputs == 0 {
            return Err(
                "requires at least one input path or one of --stdin/--clipboard".to_string(),
            );
        }

        if active_inputs > 1 {
            return Err("file paths, --stdin, and --clipboard are mutually exclusive".to_string());
        }

        if self.output == OutputDestination::File && self.output_file.is_none() {
            return Err("--output file requires --output-file <PATH>".to_string());
        }

        if self.output != OutputDestination::File && self.output_file.is_some() {
            return Err("--output-file can only be used together with --output file".to_string());
        }

        Ok(())
    }

    pub fn input_mode(&self) -> InputMode {
        if self.stdin {
            InputMode::Stdin
        } else if self.clipboard {
            InputMode::Clipboard
        } else {
            InputMode::Files(self.paths.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Cli, OutputDestination, OutputFormat};

    #[test]
    fn rejects_missing_input() {
        let cli = Cli {
            paths: vec![],
            stdin: false,
            clipboard: false,
            format: OutputFormat::Json,
            output: OutputDestination::Stdout,
            output_file: None,
            jobs: 0,
            pretty: true,
            quiet_errors: false,
            fail_fast: false,
        };

        let error = cli.validate().expect_err("expected validation error");
        assert!(error.contains("requires at least one input path"));
    }
}
