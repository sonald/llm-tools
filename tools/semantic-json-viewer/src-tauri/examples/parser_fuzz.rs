use semantic_json_viewer::json::{
    parse_json, ChildLocator, JsonKind, JsonNode, NodeId, ParsedJson, SourceSpan,
};
use std::any::Any;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

const DEFAULT_SEED: u64 = 0x534a_565f_4655_5a5f;
const DEFAULT_ITERATIONS: usize = 10_000;
const DEFAULT_MAX_INPUT: usize = 64 * 1024;
const SELF_CHECK_ITERATIONS: usize = 128;
const SELF_CHECK_MAX_INPUT: usize = 16 * 1024;
const MAX_ITERATIONS: usize = 1_000_000;
const MAX_INPUT: usize = 4 * 1024 * 1024;

const SEEDS: &[&[u8]] = &[
    br#"null"#,
    br#"true"#,
    br#"{"a":[1,2,3],"b":{"ok":false}}"#,
    br#"{"a":1,"a":2,"\u0061":3}"#,
    br#"["plain","escaped\\ntext","unicode \uD83E\uDD80"]"#,
    br#"[{"role":"user","content":"hello"},{"role":"assistant","content":null}]"#,
    br#"{"big":123456789012345678901234567890,"exp":-1.234e+567890}"#,
];

const MUTATION_NAMES: &[&str] = &[
    "seed",
    "random-mutation",
    "invalid-utf8",
    "invalid-escape",
    "invalid-surrogate",
    "duplicate-key",
    "big-number",
    "depth",
    "truncated",
    "trailing-bytes",
    "arbitrary-bytes",
];

struct Config {
    seed: u64,
    iterations: usize,
    max_input: usize,
}

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 0x9e3779b97f4a7c15 } else { seed })
    }

    fn next_u64(&mut self) -> u64 {
        let mut value = self.0;
        value ^= value << 7;
        value ^= value >> 9;
        value ^= value << 8;
        self.0 = value;
        value
    }

    fn range(&mut self, upper: usize) -> usize {
        if upper == 0 {
            return 0;
        }
        (self.next_u64() as usize) % upper
    }
}

enum CaseError {
    Rejected,
    Invariant(String),
}

fn main() {
    let config = match parse_args() {
        Ok(Some(config)) => config,
        Ok(None) => {
            print_usage();
            return;
        }
        Err(error) => {
            eprintln!("parser_fuzz argument error: {error}");
            print_usage();
            std::process::exit(2);
        }
    };

    if let Err(error) = run(config) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn parse_args() -> Result<Option<Config>, String> {
    let mut seed = DEFAULT_SEED;
    let mut iterations = DEFAULT_ITERATIONS;
    let mut max_input = DEFAULT_MAX_INPUT;
    let mut seed_seen = false;
    let mut iterations_seen = false;
    let mut max_input_seen = false;
    let mut self_check = false;
    let mut args = std::env::args().skip(1);

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--help" | "-h" => return Ok(None),
            "--selfcheck" => {
                if self_check {
                    return Err("--selfcheck may only be supplied once".into());
                }
                self_check = true;
            }
            "--seed" => {
                if seed_seen {
                    return Err("--seed may only be supplied once".into());
                }
                seed_seen = true;
                seed = parse_u64(&next_value(&mut args, "--seed")?)?;
            }
            "--iterations" => {
                if iterations_seen {
                    return Err("--iterations may only be supplied once".into());
                }
                iterations_seen = true;
                iterations = parse_usize(&next_value(&mut args, "--iterations")?, "iterations")?;
            }
            "--max-input" => {
                if max_input_seen {
                    return Err("--max-input may only be supplied once".into());
                }
                max_input_seen = true;
                max_input = parse_usize(&next_value(&mut args, "--max-input")?, "max-input")?;
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }

    if self_check && (iterations_seen || max_input_seen) {
        return Err("--selfcheck cannot be combined with --iterations or --max-input".into());
    }
    if self_check {
        iterations = SELF_CHECK_ITERATIONS;
        max_input = SELF_CHECK_MAX_INPUT;
    }
    if iterations == 0 || iterations > MAX_ITERATIONS {
        return Err(format!("iterations must be in 1..={MAX_ITERATIONS}"));
    }
    if max_input == 0 || max_input > MAX_INPUT {
        return Err(format!("max-input must be in 1..={MAX_INPUT}"));
    }

    Ok(Some(Config {
        seed,
        iterations,
        max_input,
    }))
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_usize(value: &str, name: &str) -> Result<usize, String> {
    value
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a decimal integer"))
}

fn parse_u64(value: &str) -> Result<u64, String> {
    if let Some(hex) = value.strip_prefix("0x") {
        u64::from_str_radix(hex, 16)
            .map_err(|_| "seed must be a u64 or 0x-prefixed hexadecimal value".into())
    } else {
        value
            .parse::<u64>()
            .map_err(|_| "seed must be a u64 or 0x-prefixed hexadecimal value".into())
    }
}

fn print_usage() {
    println!(
        "usage: parser_fuzz [--seed U64|0xHEX] [--iterations N] [--max-input BYTES] [--selfcheck]"
    );
    println!(
        "defaults: iterations={DEFAULT_ITERATIONS}, max-input={DEFAULT_MAX_INPUT}, fixed seed=0x{DEFAULT_SEED:016x}"
    );
}

fn run(config: Config) -> Result<(), String> {
    let mut accepted = 0usize;
    let mut rejected = 0usize;

    for iteration in 0..config.iterations {
        let iteration_seed = config
            .seed
            .wrapping_add((iteration as u64).wrapping_mul(0x9e3779b97f4a7c15));
        let mut rng = Rng::new(iteration_seed);
        let (input, mutation) = make_input(iteration, &mut rng, config.max_input);
        let current_repro = if mutation == "depth" {
            Some(write_repro_named(
                config.seed,
                iteration,
                &input,
                "current",
            )?)
        } else {
            None
        };
        let result = catch_unwind(AssertUnwindSafe(|| check_input(&input)));
        match result {
            Ok(Ok(())) => {
                if let Some(path) = current_repro.as_ref() {
                    let _ = fs::remove_file(path);
                }
                accepted += 1;
            }
            Ok(Err(CaseError::Rejected)) => {
                if let Some(path) = current_repro.as_ref() {
                    let _ = fs::remove_file(path);
                }
                rejected += 1;
            }
            Ok(Err(CaseError::Invariant(reason))) => {
                return report_failure(
                    &config,
                    iteration,
                    mutation,
                    &input,
                    &reason,
                    current_repro,
                );
            }
            Err(payload) => {
                return report_failure(
                    &config,
                    iteration,
                    mutation,
                    &input,
                    &format!("parser panic: {}", panic_message(&payload)),
                    current_repro,
                );
            }
        }
    }

    println!(
        "parser_fuzz summary: seed=0x{:016x} iterations={} max_input={} accepted={} rejected={}",
        config.seed, config.iterations, config.max_input, accepted, rejected
    );
    Ok(())
}

fn report_failure(
    config: &Config,
    iteration: usize,
    mutation: &str,
    input: &[u8],
    reason: &str,
    current_repro: Option<PathBuf>,
) -> Result<(), String> {
    let repro = match current_repro {
        Some(path) => path,
        None => write_repro(config.seed, iteration, input)?,
    };
    Err(format!(
        "parser_fuzz FAIL: seed=0x{:016x} iteration={} mutation={} bytes={} reason={} repro={}",
        config.seed,
        iteration,
        mutation,
        input.len(),
        reason,
        repro.display()
    ))
}

fn write_repro(seed: u64, iteration: usize, input: &[u8]) -> Result<PathBuf, String> {
    write_repro_named(seed, iteration, input, "failure")
}

fn write_repro_named(
    seed: u64,
    iteration: usize,
    input: &[u8],
    kind: &str,
) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir();
    let stem = format!(
        "sjv-parser-fuzz-{kind}-{seed:016x}-{iteration}-{}",
        std::process::id()
    );
    for attempt in 0..1000usize {
        let path = directory.join(format!("{stem}-{attempt}.bin"));
        let file = OpenOptions::new().write(true).create_new(true).open(&path);
        let Ok(mut file) = file else {
            if file
                .err()
                .is_some_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
            {
                continue;
            }
            return Err(format!(
                "could not create repro file in {}",
                directory.display()
            ));
        };
        if let Err(error) = file.write_all(input).and_then(|()| file.flush()) {
            let _ = fs::remove_file(&path);
            return Err(format!(
                "could not write repro file {}: {error}",
                path.display()
            ));
        }
        return Ok(path);
    }
    Err(format!(
        "could not allocate a unique repro file in {}",
        directory.display()
    ))
}

fn panic_message(payload: &Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    "non-string panic payload".into()
}

fn check_input(input: &[u8]) -> Result<(), CaseError> {
    let parsed = match parse_json(input) {
        Ok(parsed) => parsed,
        Err(_) => return Err(CaseError::Rejected),
    };
    validate_tree(input, &parsed).map_err(CaseError::Invariant)
}

fn validate_tree(input: &[u8], parsed: &ParsedJson<'_>) -> Result<(), String> {
    let node_count = parsed.node_count();
    if node_count == 0 {
        return Err("parsed tree has no root node".into());
    }
    let root = parsed.root();
    if root.index() != 0 {
        return Err("root NodeId is not zero".into());
    }
    let root_node = parsed.node(root);
    if root_node.parent.is_some() || !matches!(root_node.locator, ChildLocator::Root) {
        return Err("root parent or locator invariant failed".into());
    }

    let mut seen = vec![false; node_count];
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let index = id.index();
        if index >= node_count {
            return Err(format!("node id {index} is outside node table"));
        }
        if seen[index] {
            return Err(format!("node id {index} is reachable more than once"));
        }
        seen[index] = true;
        let node = parsed.node(id);
        validate_span(input, node.span, index)?;
        if parsed.raw_lexeme(id) != &input[node.span.start..node.span.end] {
            return Err(format!(
                "node id {index} raw lexeme does not match its span"
            ));
        }

        match node.parent {
            Some(parent_id) => {
                if parent_id.index() >= node_count {
                    return Err(format!("node id {index} parent is outside node table"));
                }
                let parent = parsed.node(parent_id);
                if !contains_span(parent.span, node.span) || !parent.children.contains(&id) {
                    return Err(format!("node id {index} parent relation is inconsistent"));
                }
            }
            None if id != root => return Err(format!("non-root node {index} has no parent")),
            None => {}
        }

        validate_locator(parsed, id, node)?;
        let mut child_ids = HashSet::with_capacity(node.children.len());
        for &child_id in &node.children {
            if !child_ids.insert(child_id.index()) {
                return Err(format!("node id {index} contains a duplicate child"));
            }
            if child_id.index() >= node_count {
                return Err(format!("node id {index} has an out-of-range child"));
            }
            let child = parsed.node(child_id);
            if child.parent != Some(id) || !contains_span(node.span, child.span) {
                return Err(format!("node id {index} child relation is inconsistent"));
            }
            stack.push(child_id);
        }
    }

    if seen.iter().any(|is_seen| !is_seen) {
        return Err("node table contains an unreachable node".into());
    }
    Ok(())
}

fn validate_span(input: &[u8], span: SourceSpan, index: usize) -> Result<(), String> {
    if span.start >= span.end || span.end > input.len() {
        return Err(format!("node id {index} has an invalid source span"));
    }
    Ok(())
}

fn contains_span(outer: SourceSpan, inner: SourceSpan) -> bool {
    outer.start <= inner.start && inner.end <= outer.end
}

fn validate_locator(parsed: &ParsedJson<'_>, id: NodeId, node: &JsonNode) -> Result<(), String> {
    match &node.locator {
        ChildLocator::Root => {
            if id != parsed.root() {
                return Err(format!("non-root node {} has Root locator", id.index()));
            }
        }
        ChildLocator::ArrayIndex(array_index) => {
            let parent_id = node
                .parent
                .ok_or_else(|| format!("array child {} has no parent", id.index()))?;
            let parent = parsed.node(parent_id);
            if parent.kind != JsonKind::Array || parent.children.get(*array_index) != Some(&id) {
                return Err(format!(
                    "array locator for node {} is inconsistent",
                    id.index()
                ));
            }
        }
        ChildLocator::ObjectKey {
            key,
            key_span,
            occurrence,
        } => {
            let parent_id = node
                .parent
                .ok_or_else(|| format!("object child {} has no parent", id.index()))?;
            let parent = parsed.node(parent_id);
            if parent.kind != JsonKind::Object
                || !contains_span(parent.span, *key_span)
                || key_span.end > node.span.start
            {
                return Err(format!(
                    "object locator for node {} is inconsistent",
                    id.index()
                ));
            }
            let position = parent
                .children
                .iter()
                .position(|child_id| *child_id == id)
                .ok_or_else(|| format!("object child {} is missing from parent", id.index()))?;
            let prior_occurrences = parent.children[..position]
                .iter()
                .filter(|child_id| match &parsed.node(**child_id).locator {
                    ChildLocator::ObjectKey { key: prior_key, .. } => prior_key == key,
                    _ => false,
                })
                .count();
            if prior_occurrences + 1 != *occurrence {
                return Err(format!(
                    "object occurrence for node {} is inconsistent",
                    id.index()
                ));
            }
        }
    }
    Ok(())
}

fn make_input(iteration: usize, rng: &mut Rng, max_input: usize) -> (Vec<u8>, &'static str) {
    let seed = SEEDS[rng.range(SEEDS.len())];
    match iteration % MUTATION_NAMES.len() {
        0 => (fit(seed.to_vec(), max_input), "seed"),
        1 => (random_mutation(seed, rng, max_input), "random-mutation"),
        2 => (fit(vec![b'\"', 0xff, b'\"'], max_input), "invalid-utf8"),
        3 => (fit(b"\"\\q\"".to_vec(), max_input), "invalid-escape"),
        4 => (fit(b"\"\\uD800\"".to_vec(), max_input), "invalid-surrogate"),
        5 => (
            fit(br#"{"a":1,"a":2,"b":[true,false]}"#.to_vec(), max_input),
            "duplicate-key",
        ),
        6 => (
            fit(
                br#"{"n":1234567890123456789012345678901234567890,"e":1e999999}"#.to_vec(),
                max_input,
            ),
            "big-number",
        ),
        7 => (depth_case(iteration, max_input), "depth"),
        8 => {
            let source = fit(seed.to_vec(), max_input);
            let end = rng.range(source.len().saturating_add(1));
            (source[..end].to_vec(), "truncated")
        }
        9 => {
            let mut input = fit(seed.to_vec(), max_input);
            input.extend_from_slice(b"{}trailing");
            input.truncate(max_input);
            (input, "trailing-bytes")
        }
        _ => {
            let length = rng.range(max_input.saturating_add(1));
            let mut input = Vec::with_capacity(length);
            for _ in 0..length {
                input.push(rng.next_u64() as u8);
            }
            (input, "arbitrary-bytes")
        }
    }
}

fn fit(mut input: Vec<u8>, max_input: usize) -> Vec<u8> {
    input.truncate(max_input);
    input
}

fn random_mutation(seed: &[u8], rng: &mut Rng, max_input: usize) -> Vec<u8> {
    let mut input = fit(seed.to_vec(), max_input);
    let operation_count = rng.range(8) + 1;
    for _ in 0..operation_count {
        match rng.range(4) {
            0 => {
                if input.is_empty() {
                    continue;
                }
                let start = rng.range(input.len());
                let max_length = (input.len() - start).min(64);
                let length = rng.range(max_length) + 1;
                let replacement = random_bytes(rng, length);
                let _ = input.splice(start..start + length, replacement);
            }
            1 => {
                let room = max_input.saturating_sub(input.len());
                if room == 0 {
                    continue;
                }
                let length = (rng.range(64) + 1).min(room);
                let start = rng.range(input.len() + 1);
                let _ = input.splice(start..start, random_bytes(rng, length));
            }
            2 => {
                if input.is_empty() {
                    continue;
                }
                let start = rng.range(input.len());
                let max_length = (input.len() - start).min(64);
                let length = rng.range(max_length) + 1;
                input.drain(start..start + length);
            }
            _ => {
                let other = SEEDS[rng.range(SEEDS.len())];
                if input.is_empty() {
                    input.extend_from_slice(&other[..other.len().min(max_input)]);
                    continue;
                }
                let start = rng.range(input.len());
                let max_length = (input.len() - start).min(32);
                let replaced = rng.range(max_length) + 1;
                let fragment_start = rng.range(other.len());
                let fragment_end =
                    (fragment_start + rng.range(other.len() - fragment_start) + 1).min(other.len());
                let fragment = &other[fragment_start..fragment_end];
                let available = max_input.saturating_sub(input.len() - replaced);
                let fragment = &fragment[..fragment.len().min(available)];
                let _ = input.splice(start..start + replaced, fragment.iter().copied());
            }
        }
    }
    input
}

fn random_bytes(rng: &mut Rng, length: usize) -> Vec<u8> {
    (0..length).map(|_| rng.next_u64() as u8).collect()
}

fn depth_case(iteration: usize, max_input: usize) -> Vec<u8> {
    const DEPTHS: &[usize] = &[1, 2, 127, 128, 255, 256, 257, 384, 512];
    nested_array(
        DEPTHS[(iteration / MUTATION_NAMES.len()) % DEPTHS.len()],
        max_input,
    )
}

fn nested_array(depth: usize, max_input: usize) -> Vec<u8> {
    let mut input = Vec::with_capacity(depth.saturating_mul(2).saturating_add(1));
    input.extend(std::iter::repeat_n(b'[', depth));
    input.push(b'0');
    input.extend(std::iter::repeat_n(b']', depth));
    fit(input, max_input)
}
