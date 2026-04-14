pub mod cli;
pub mod clipboard;
pub mod decode;
pub mod format;
pub mod input;
pub mod sink;

use anyhow::{Context, Result};
use image::DynamicImage;
use rayon::prelude::*;
use serde::Serialize;
use thiserror::Error;

use crate::cli::{Cli, InputMode, OutputDestination};
use crate::clipboard::SystemClipboard;
use crate::input::{ClipboardLoadError, SourceSpec, StdinLoadError};
use crate::sink::OutputTarget;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    File,
    Stdin,
    Clipboard,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Ok,
    Error,
}

#[derive(Clone, Debug)]
pub struct LoadedSource {
    pub source_index: usize,
    pub source_kind: SourceKind,
    pub source_label: String,
    pub image: DynamicImage,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct CodeResult {
    pub index: usize,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SourceResult {
    pub source_index: usize,
    pub source_kind: SourceKind,
    pub source_label: String,
    pub status: SourceStatus,
    pub codes: Vec<CodeResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl SourceResult {
    fn ok(
        source_index: usize,
        source_kind: SourceKind,
        source_label: String,
        texts: Vec<String>,
    ) -> Self {
        let codes = texts
            .into_iter()
            .enumerate()
            .map(|(index, text)| CodeResult { index, text })
            .collect();

        Self {
            source_index,
            source_kind,
            source_label,
            status: SourceStatus::Ok,
            codes,
            error: None,
        }
    }

    fn error(
        source_index: usize,
        source_kind: SourceKind,
        source_label: String,
        error: impl Into<String>,
    ) -> Self {
        Self {
            source_index,
            source_kind,
            source_label,
            status: SourceStatus::Error,
            codes: Vec::new(),
            error: Some(error.into()),
        }
    }

    fn is_ok(&self) -> bool {
        self.status == SourceStatus::Ok
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Summary {
    pub total_sources: usize,
    pub succeeded_sources: usize,
    pub failed_sources: usize,
    pub total_codes: usize,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Report {
    pub summary: Summary,
    pub results: Vec<SourceResult>,
}

impl Report {
    fn from_results(results: Vec<SourceResult>) -> Self {
        let total_sources = results.len();
        let succeeded_sources = results.iter().filter(|result| result.is_ok()).count();
        let failed_sources = total_sources.saturating_sub(succeeded_sources);
        let total_codes = results.iter().map(|result| result.codes.len()).sum();

        Self {
            summary: Summary {
                total_sources,
                succeeded_sources,
                failed_sources,
                total_codes,
            },
            results,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExitCode {
    Success = 0,
    Usage = 1,
    PartialFailure = 2,
    InitFailure = 3,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Usage(String),
    #[error("{0}")]
    Init(String),
}

impl AppError {
    pub fn exit_code(&self) -> ExitCode {
        match self {
            Self::Usage(_) => ExitCode::Usage,
            Self::Init(_) => ExitCode::InitFailure,
        }
    }
}

pub fn run(cli: Cli) -> Result<ExitCode, AppError> {
    cli.validate().map_err(AppError::Usage)?;

    let output_target = output_target_from_cli(&cli)?;
    let needs_clipboard = matches!(cli.input_mode(), InputMode::Clipboard)
        || matches!(output_target, OutputTarget::Clipboard);

    let mut system_clipboard = if needs_clipboard {
        Some(SystemClipboard::new().map_err(|err| AppError::Init(err.to_string()))?)
    } else {
        None
    };

    let results = match cli.input_mode() {
        InputMode::Files(paths) => process_file_inputs(&paths, cli.jobs, cli.fail_fast)?,
        InputMode::Stdin => match input::load_stdin_source() {
            Ok(loaded) => vec![process_loaded_result(loaded)],
            Err(StdinLoadError::Read(message)) => return Err(AppError::Init(message)),
            Err(StdinLoadError::Content(message)) => {
                vec![SourceResult::error(
                    0,
                    SourceKind::Stdin,
                    "<stdin>".to_string(),
                    message,
                )]
            }
        },
        InputMode::Clipboard => {
            let clipboard = system_clipboard.as_mut().ok_or_else(|| {
                AppError::Init("clipboard backend was not initialized".to_string())
            })?;
            match input::load_clipboard_source(clipboard) {
                Ok(loaded) => vec![process_loaded_result(loaded)],
                Err(ClipboardLoadError::Access(message)) => return Err(AppError::Init(message)),
                Err(ClipboardLoadError::Content(message)) => vec![SourceResult::error(
                    0,
                    SourceKind::Clipboard,
                    "<clipboard>".to_string(),
                    message,
                )],
            }
        }
    };

    if !cli.quiet_errors {
        emit_failures_to_stderr(&results).map_err(|err| AppError::Init(err.to_string()))?;
    }

    let report = Report::from_results(results);
    let rendered = format::render_report(&report, cli.format, cli.pretty)
        .map_err(|err| AppError::Init(err.to_string()))?;

    match output_target {
        OutputTarget::Stdout => {
            sink::write_output::<SystemClipboard>(&output_target, &rendered, None)
                .map_err(|err| AppError::Init(err.to_string()))?
        }
        OutputTarget::File(_) => {
            sink::write_output::<SystemClipboard>(&output_target, &rendered, None)
                .map_err(|err| AppError::Init(err.to_string()))?
        }
        OutputTarget::Clipboard => {
            let clipboard = system_clipboard.as_mut().ok_or_else(|| {
                AppError::Init("clipboard backend was not initialized".to_string())
            })?;
            sink::write_output(&output_target, &rendered, Some(clipboard))
                .map_err(|err| AppError::Init(err.to_string()))?;
        }
    }

    if report.summary.failed_sources > 0 || report.summary.succeeded_sources == 0 {
        Ok(ExitCode::PartialFailure)
    } else {
        Ok(ExitCode::Success)
    }
}

fn output_target_from_cli(cli: &Cli) -> Result<OutputTarget, AppError> {
    match cli.output {
        OutputDestination::Stdout => Ok(OutputTarget::Stdout),
        OutputDestination::File => {
            let path = cli.output_file.clone().ok_or_else(|| {
                AppError::Usage("--output file requires --output-file <PATH>".to_string())
            })?;
            Ok(OutputTarget::File(path))
        }
        OutputDestination::Clipboard => Ok(OutputTarget::Clipboard),
    }
}

fn process_file_inputs(
    paths: &[std::path::PathBuf],
    jobs: usize,
    fail_fast: bool,
) -> Result<Vec<SourceResult>, AppError> {
    let specs = input::file_specs(paths);

    if fail_fast || jobs == 1 {
        let mut results = Vec::with_capacity(specs.len());
        for spec in specs {
            let result = process_file_spec(&spec);
            let failed = !result.is_ok();
            results.push(result);
            if fail_fast && failed {
                break;
            }
        }
        return Ok(results);
    }

    if jobs == 0 {
        Ok(specs.par_iter().map(process_file_spec).collect())
    } else {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(jobs)
            .build()
            .context("failed to create Rayon thread pool")
            .map_err(|err| AppError::Init(err.to_string()))?;
        Ok(pool.install(|| specs.par_iter().map(process_file_spec).collect()))
    }
}

fn process_file_spec(spec: &SourceSpec) -> SourceResult {
    match input::load_file_source(spec) {
        Ok(loaded) => process_loaded_result(loaded),
        Err(err) => SourceResult::error(
            spec.source_index,
            spec.source_kind,
            spec.source_label.clone(),
            err.to_string(),
        ),
    }
}

fn process_loaded_result(loaded: LoadedSource) -> SourceResult {
    match decode::decode_qr_texts(&loaded.image) {
        Ok(texts) => SourceResult::ok(
            loaded.source_index,
            loaded.source_kind,
            loaded.source_label,
            texts,
        ),
        Err(err) => SourceResult::error(
            loaded.source_index,
            loaded.source_kind,
            loaded.source_label,
            err.to_string(),
        ),
    }
}

fn emit_failures_to_stderr(results: &[SourceResult]) -> Result<()> {
    use std::io::Write;

    let mut stderr = std::io::stderr().lock();
    for result in results.iter().filter(|result| !result.is_ok()) {
        if let Some(error) = &result.error {
            writeln!(stderr, "{}: {}", result.source_label, error)?;
        }
    }
    Ok(())
}
