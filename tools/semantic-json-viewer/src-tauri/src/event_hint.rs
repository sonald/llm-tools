use std::collections::{HashMap, HashSet};
use std::mem;

use crate::json::{parse_json, ChildLocator, JsonKind, ParsedJson};

pub(crate) const MAX_EVENT_HINT_SAMPLES: usize = 200;
pub(crate) const MAX_EVENT_HINT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum GroupFamily {
    Session,
    Trace,
    Run,
    Conversation,
    Request,
    Case,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Signal {
    EventType,
    Timestamp,
    Grouping(GroupFamily),
    Sequence,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum RawKind {
    Number,
    True,
    False,
    Null,
    Object,
    Array,
}

#[derive(Debug, Eq, Hash, PartialEq)]
enum GroupingValue {
    String(String),
    Raw(RawKind, Vec<u8>),
}

#[derive(Debug, Default)]
pub(crate) struct EventHintSampler {
    input_bytes: usize,
    line: Vec<u8>,
    sample_count: usize,
    event_type_samples: usize,
    timestamp_samples: usize,
    grouping_samples: usize,
    repeated_grouping_samples: usize,
    sequence_samples: usize,
    group_occurrences: HashMap<(GroupFamily, GroupingValue), Vec<usize>>,
    repeated_grouping_sample_ids: Vec<usize>,
    done: bool,
    result: Option<bool>,
}

impl EventHintSampler {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feed physical JSONL bytes. Once the byte or valid-sample bound is hit,
    /// an unfinished line is deliberately discarded and no later bytes are
    /// inspected. `end_of_file` permits the final line without a line feed.
    pub(crate) fn feed(&mut self, bytes: &[u8], end_of_file: bool) {
        if self.done {
            return;
        }

        for (index, &byte) in bytes.iter().enumerate() {
            if self.done {
                break;
            }

            self.input_bytes += 1;
            if byte == b'\n' {
                self.finish_line();
            } else {
                self.line.push(byte);
            }

            if self.input_bytes == MAX_EVENT_HINT_BYTES
                && !(end_of_file && index + 1 == bytes.len())
            {
                self.finish_sampling();
            }
        }

        if end_of_file && !self.done {
            if !self.line.is_empty() {
                self.finish_line();
            }
            self.finish_sampling();
        }
    }

    pub(crate) fn hint(&self) -> Option<bool> {
        self.result
    }

    fn finish_line(&mut self) {
        let mut line = mem::take(&mut self.line);
        if line
            .iter()
            .any(|&byte| !matches!(byte, b' ' | b'\t' | b'\r'))
        {
            self.inspect_line(&line);
        }
        if !self.done {
            line.clear();
            self.line = line;
        }
    }

    fn inspect_line(&mut self, line: &[u8]) {
        let Ok(parsed) = parse_json(line) else {
            return;
        };
        let root = parsed.node(parsed.root());
        if root.kind != JsonKind::Object {
            return;
        }

        self.record_sample(&parsed);
        if self.sample_count == MAX_EVENT_HINT_SAMPLES {
            self.finish_sampling();
        }
    }

    fn record_sample(&mut self, parsed: &ParsedJson<'_>) {
        let mut has_event_type = false;
        let mut has_timestamp = false;
        let mut has_sequence = false;
        let mut grouping_values = HashSet::new();

        for &child_id in &parsed.node(parsed.root()).children {
            let child = parsed.node(child_id);
            let ChildLocator::ObjectKey { key, .. } = &child.locator else {
                continue;
            };

            match signal_for_key(key) {
                Some(Signal::EventType) => has_event_type = true,
                Some(Signal::Timestamp) => has_timestamp = true,
                Some(Signal::Sequence) => has_sequence = true,
                Some(Signal::Grouping(family)) => {
                    let Some(value) = grouping_value(parsed, child_id) else {
                        continue;
                    };
                    grouping_values.insert((family, value));
                }
                None => {}
            }
        }

        let sample_index = self.sample_count;
        self.sample_count += 1;
        self.event_type_samples += usize::from(has_event_type);
        self.timestamp_samples += usize::from(has_timestamp);
        self.sequence_samples += usize::from(has_sequence);
        if !grouping_values.is_empty() {
            self.grouping_samples += 1;
            for key in grouping_values {
                if let Some(prior_samples) = self.group_occurrences.get(&key) {
                    let prior_samples = prior_samples.clone();
                    for prior_sample in prior_samples {
                        self.mark_repeated_grouping_sample(prior_sample);
                    }
                    self.mark_repeated_grouping_sample(sample_index);
                }
                self.group_occurrences
                    .entry(key)
                    .or_default()
                    .push(sample_index);
            }
        }
    }

    fn mark_repeated_grouping_sample(&mut self, sample_index: usize) {
        if !self.repeated_grouping_sample_ids.contains(&sample_index) {
            self.repeated_grouping_sample_ids.push(sample_index);
            self.repeated_grouping_samples += 1;
        }
    }

    fn finish_sampling(&mut self) {
        if self.done {
            return;
        }
        self.result = Some(self.is_event_stream());
        self.done = true;
        self.line = Vec::new();
        self.group_occurrences = HashMap::new();
        self.repeated_grouping_sample_ids = Vec::new();
    }

    fn is_event_stream(&self) -> bool {
        let samples = self.sample_count;
        if samples < 10 {
            return false;
        }

        let type_signal = at_least(self.event_type_samples, samples, 70);
        let timestamp_signal = at_least(self.timestamp_samples, samples, 40);
        let grouping_signal = at_least(self.grouping_samples, samples, 50);
        let repeated_grouping_signal = self.grouping_samples > 0
            && at_least(self.repeated_grouping_samples, self.grouping_samples, 50);
        let sequence_signal = at_least(self.sequence_samples, samples, 40);
        let first_rule = type_signal
            && (timestamp_signal
                || (grouping_signal && repeated_grouping_signal)
                || sequence_signal);

        let second_rule = at_least(self.timestamp_samples, samples, 70)
            && at_least(self.grouping_samples, samples, 70)
            && repeated_grouping_signal;

        first_rule || second_rule
    }
}

fn at_least(numerator: usize, denominator: usize, percent: usize) -> bool {
    numerator * 100 >= denominator * percent
}

fn signal_for_key(key: &str) -> Option<Signal> {
    match key {
        "type" | "event" | "event_type" | "kind" => Some(Signal::EventType),
        "timestamp" | "time" | "ts" | "created_at" | "createdAt" => Some(Signal::Timestamp),
        "session_id" | "sessionId" => Some(Signal::Grouping(GroupFamily::Session)),
        "trace_id" | "traceId" => Some(Signal::Grouping(GroupFamily::Trace)),
        "run_id" | "runId" => Some(Signal::Grouping(GroupFamily::Run)),
        "conversation_id" | "conversationId" => Some(Signal::Grouping(GroupFamily::Conversation)),
        "request_id" | "requestId" => Some(Signal::Grouping(GroupFamily::Request)),
        "case_id" | "caseId" => Some(Signal::Grouping(GroupFamily::Case)),
        "seq" | "sequence" | "step" | "step_index" | "index" => Some(Signal::Sequence),
        _ => None,
    }
}

fn grouping_value(parsed: &ParsedJson<'_>, child_id: crate::json::NodeId) -> Option<GroupingValue> {
    let child = parsed.node(child_id);
    match child.kind {
        JsonKind::String => parsed
            .decoded_string_for_node(child)
            .map(|value| GroupingValue::String(value.to_cow().into_owned())),
        kind => Some(GroupingValue::Raw(
            raw_kind(kind),
            parsed.raw_lexeme(child_id).to_vec(),
        )),
    }
}

fn raw_kind(kind: JsonKind) -> RawKind {
    match kind {
        JsonKind::Number => RawKind::Number,
        JsonKind::True => RawKind::True,
        JsonKind::False => RawKind::False,
        JsonKind::Null => RawKind::Null,
        JsonKind::Object => RawKind::Object,
        JsonKind::Array => RawKind::Array,
        JsonKind::String => unreachable!("string grouping values are decoded separately"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_lines(lines: &[&str]) -> EventHintSampler {
        let mut sampler = EventHintSampler::new();
        let input = lines.join("\n");
        sampler.feed(input.as_bytes(), true);
        sampler
    }

    #[test]
    fn recognizes_generated_positive_shape_and_rejects_training_only_shape() {
        let positive = (0..10)
            .map(|index| {
                if index < 7 {
                    format!(r#"{{"type":"message","timestamp":"t{index}"}}"#)
                } else {
                    r#"{"payload":"dataset"}"#.to_owned()
                }
            })
            .collect::<Vec<_>>();
        let positive_refs = positive.iter().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(feed_lines(&positive_refs).hint(), Some(true));

        let negative = (0..10)
            .map(|index| format!(r#"{{"type":"training_sample","sample":{index}}}"#))
            .collect::<Vec<_>>();
        let negative_refs = negative.iter().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(feed_lines(&negative_refs).hint(), Some(false));
    }

    #[test]
    fn grouping_repetition_is_cross_sample_and_family_and_type_sensitive() {
        let lines = [
            r#"{"session_id":"same","sessionId":"same","trace_id":"same","value":1}"#,
            r#"{"sessionId":"same","trace_id":"other","value":2}"#,
            r#"{"session_id":"different","value":3}"#,
            r#"{"session_id":"different","value":4}"#,
            r#"{"session_id":1,"value":5}"#,
            r#"{"session_id":1.0,"value":6}"#,
            r#"{"session_id":"escaped\u002Dvalue","value":7}"#,
            r#"{"session_id":"escaped-value","value":8}"#,
            r#"{"session_id":null,"value":9}"#,
            r#"{"session_id":null,"value":10}"#,
        ];
        let sampler = feed_lines(&lines);
        assert_eq!(sampler.sample_count, 10);
        assert_eq!(sampler.grouping_samples, 10);
        assert_eq!(sampler.repeated_grouping_samples, 8);
        assert_eq!(sampler.hint(), Some(false));
    }

    #[test]
    fn exact_ten_sample_threshold_and_g_zero_are_deterministic() {
        let nine = vec![r#"{"type":"event","createdAt":"now"}"#; 9];
        assert_eq!(feed_lines(&nine).hint(), Some(false));

        let mut lines = Vec::new();
        for index in 0..10 {
            lines.push(if index < 7 {
                r#"{"kind":"tool"}"#
            } else {
                r#"{"value":true}"#
            });
        }
        assert_eq!(feed_lines(&lines).hint(), Some(false));

        let mut lines = Vec::new();
        for index in 0..10 {
            lines.push(if index < 7 {
                r#"{"kind":"tool","createdAt":"now"}"#
            } else {
                r#"{"value":true}"#
            });
        }
        assert_eq!(feed_lines(&lines).hint(), Some(true));
    }

    #[test]
    fn invalid_blank_nonobject_and_truncated_budget_input_do_not_become_samples() {
        let mut sampler = EventHintSampler::new();
        sampler.feed(b"\nnot json\n[]\n{\"type\":\"ok\"}", true);
        assert_eq!(sampler.sample_count, 1);
        assert_eq!(sampler.hint(), Some(false));

        let mut sampler = EventHintSampler::new();
        sampler.feed(&vec![b' '; MAX_EVENT_HINT_BYTES - 2], false);
        sampler.feed(b"{\"type\":\"truncated\"}", false);
        assert_eq!(sampler.input_bytes, MAX_EVENT_HINT_BYTES);
        assert_eq!(sampler.sample_count, 0);
        assert_eq!(sampler.hint(), Some(false));
    }

    #[test]
    fn counts_both_members_of_each_repeated_group_once() {
        let mut lines = Vec::new();
        for index in 0..3 {
            lines.push(format!(r#"{{"session_id":"pair-{index}"}}"#));
            lines.push(format!(r#"{{"sessionId":"pair-{index}"}}"#));
        }
        for index in 0..4 {
            lines.push(format!(r#"{{"session_id":"single-{index}"}}"#));
        }
        let refs = lines.iter().map(String::as_str).collect::<Vec<_>>();
        let sampler = feed_lines(&refs);
        assert_eq!(sampler.grouping_samples, 10);
        assert_eq!(sampler.repeated_grouping_samples, 6);
    }

    #[test]
    fn handles_many_duplicate_group_keys_without_treating_same_sample_as_repeated() {
        let fields = (0..2_000)
            .map(|index| format!(r#""session_id":"value-{index}""#))
            .collect::<Vec<_>>()
            .join(",");
        let first = format!("{{{fields}}}");
        let mut lines = vec![first];
        for index in 0..9 {
            lines.push(format!(r#"{{"sessionId":"other-{index}"}}"#));
        }
        let refs = lines.iter().map(String::as_str).collect::<Vec<_>>();
        let sampler = feed_lines(&refs);
        assert_eq!(sampler.sample_count, 10);
        assert_eq!(sampler.grouping_samples, 10);
        assert_eq!(sampler.repeated_grouping_samples, 0);
        assert_eq!(sampler.hint(), Some(false));
    }

    #[test]
    fn parses_a_complete_unterminated_final_line_at_the_exact_byte_budget() {
        let mut input = (0..9)
            .map(|index| {
                if index < 4 {
                    r#"{"type":"event","createdAt":"now"}"#
                } else {
                    r#"{"type":"event"}"#
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes();
        input.push(b'\n');
        let tail = br#"{"type":"event","createdAt":"now"}"#;
        input.extend(std::iter::repeat_n(
            b' ',
            MAX_EVENT_HINT_BYTES - input.len() - tail.len(),
        ));
        input.extend_from_slice(tail);

        let mut sampler = EventHintSampler::new();
        sampler.feed(&input, true);
        assert_eq!(input.len(), MAX_EVENT_HINT_BYTES);
        assert_eq!(sampler.input_bytes, MAX_EVENT_HINT_BYTES);
        assert_eq!(sampler.sample_count, 10);
        assert_eq!(sampler.hint(), Some(true));
    }

    #[test]
    fn stops_at_two_hundred_valid_objects_and_releases_sampling_caches() {
        let mut sampler = EventHintSampler::new();
        let mut input = (0..200)
            .map(|index| format!(r#"{{"type":"event","session_id":"s{index}"}}"#))
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes();
        input.extend_from_slice(b"\nnot json\n");
        sampler.feed(&input, true);
        assert_eq!(sampler.sample_count, 200);
        assert_eq!(sampler.hint(), Some(false));
        assert!(sampler.line.is_empty());
        assert!(sampler.group_occurrences.is_empty());
        assert!(sampler.repeated_grouping_sample_ids.is_empty());
    }
}
