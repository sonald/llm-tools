use anyhow::Result;

use crate::cli::OutputFormat;
use crate::Report;

pub fn render_report(report: &Report, format: OutputFormat, pretty: bool) -> Result<String> {
    match format {
        OutputFormat::Json => {
            if pretty {
                Ok(serde_json::to_string_pretty(report)?)
            } else {
                Ok(serde_json::to_string(report)?)
            }
        }
        OutputFormat::Yaml => Ok(serde_yaml::to_string(report)?),
        OutputFormat::Raw => Ok(render_raw(report)),
    }
}

fn render_raw(report: &Report) -> String {
    let mut rendered = String::new();

    for result in &report.results {
        for code in &result.codes {
            rendered.push_str(&code.text);
            rendered.push('\n');
        }
    }

    rendered
}

#[cfg(test)]
mod tests {
    use crate::{CodeResult, Report, SourceKind, SourceResult, SourceStatus, Summary};

    use super::render_report;

    #[test]
    fn raw_output_contains_only_payload_lines() {
        let report = Report {
            summary: Summary {
                total_sources: 1,
                succeeded_sources: 1,
                failed_sources: 0,
                total_codes: 2,
            },
            results: vec![SourceResult {
                source_index: 0,
                source_kind: SourceKind::File,
                source_label: "demo.png".to_string(),
                status: SourceStatus::Ok,
                codes: vec![
                    CodeResult {
                        index: 0,
                        text: "alpha".to_string(),
                    },
                    CodeResult {
                        index: 1,
                        text: "beta".to_string(),
                    },
                ],
                error: None,
            }],
        };

        let raw = render_report(&report, crate::cli::OutputFormat::Raw, true).expect("raw output");
        assert_eq!(raw, "alpha\nbeta\n");
    }
}
