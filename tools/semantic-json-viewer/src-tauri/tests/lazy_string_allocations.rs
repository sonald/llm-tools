use semantic_json_viewer::json::{parse_json, parse_json_owned, JsonKind};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingAllocator;

static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static GLOBAL_ALLOCATOR: CountingAllocator = CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        if !pointer.is_null() {
            ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc_zeroed(layout);
        if !pointer.is_null() {
            ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_pointer = System.realloc(pointer, layout, new_size);
        if !new_pointer.is_null() {
            ALLOCATED_BYTES.fetch_add(new_size, Ordering::Relaxed);
        }
        new_pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout);
    }
}

fn root_literal(value_bytes: usize) -> Vec<u8> {
    let mut source = Vec::with_capacity(value_bytes + 2);
    source.push(b'"');
    source.extend(std::iter::repeat_n(b'a', value_bytes));
    source.push(b'"');
    source
}

fn root_escaped(minimum_bytes: usize) -> Vec<u8> {
    let mut source = Vec::with_capacity(minimum_bytes + 2);
    source.push(b'"');
    while source.len() < minimum_bytes + 1 {
        source.extend_from_slice(br#"\u0061"#);
    }
    source.push(b'"');
    source
}

#[test]
fn root_strings_do_not_materialize_decoded_values_during_parse() {
    const INPUT_BYTES: usize = 4 * 1024 * 1024;
    const MAX_PARSE_ALLOCATION_BYTES: usize = 64 * 1024;
    let literal = root_literal(INPUT_BYTES);
    let escaped = root_escaped(INPUT_BYTES);
    let escaped_pointer = escaped.as_ptr();

    let _ = parse_json(br#""warmup""#).expect("warmup literal must parse");
    let _ = parse_json_owned(br#""warmup""#.to_vec()).expect("warmup owned must parse");

    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    let parsed_literal = parse_json(&literal).expect("literal source must parse");
    let literal_allocations = ALLOCATED_BYTES.load(Ordering::Relaxed);
    assert_eq!(parsed_literal.node_count(), 1);
    assert_eq!(
        parsed_literal.node(parsed_literal.root()).kind,
        JsonKind::String
    );
    assert!(parsed_literal
        .decoded_string_at(0)
        .expect("literal string accessor")
        .borrowed()
        .is_some());
    drop(parsed_literal);
    assert!(
        literal_allocations < MAX_PARSE_ALLOCATION_BYTES,
        "literal parse allocated {literal_allocations} bytes"
    );

    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    let parsed_escaped = parse_json_owned(escaped).expect("escaped source must parse");
    let escaped_allocations = ALLOCATED_BYTES.load(Ordering::Relaxed);
    assert_eq!(parsed_escaped.source().as_ptr(), escaped_pointer);
    assert_eq!(parsed_escaped.node_count(), 1);
    assert_eq!(
        parsed_escaped.node(parsed_escaped.root()).kind,
        JsonKind::String
    );
    assert!(parsed_escaped.node(parsed_escaped.root()).string_has_escape);
    assert!(parsed_escaped.decoded_string_at(0).is_some());
    drop(parsed_escaped);
    assert!(
        escaped_allocations < MAX_PARSE_ALLOCATION_BYTES,
        "escaped parse allocated {escaped_allocations} bytes"
    );
}
