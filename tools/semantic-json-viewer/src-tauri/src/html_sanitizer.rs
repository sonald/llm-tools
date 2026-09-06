use std::time::{Duration, Instant};

use dom_query::{Document, NodeRef};

pub(crate) const MAX_INPUT_BYTES: usize = 512 * 1024;
pub(crate) const MAX_NODES: usize = 10_000;
pub(crate) const MAX_DEPTH: usize = 32;
pub(crate) const MAX_RENDER_MILLIS: u64 = 100;
pub(crate) const MAX_OUTPUT_JSON_BYTES: usize = 1024 * 1024;
const HTML_PREVIEW_JSON_OVERHEAD: usize = b"{\"html\":\"".len() + b"\",\"reason\":null}".len() - 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HtmlPreviewReason {
    SizeLimit,
    RenderLimit,
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct HtmlPreview {
    pub html: Option<String>,
    pub reason: Option<HtmlPreviewReason>,
}

pub(crate) fn sanitize_html(input: &str) -> HtmlPreview {
    let deadline = Instant::now() + Duration::from_millis(MAX_RENDER_MILLIS);
    sanitize_html_with_deadline(input, deadline)
}

#[cfg(test)]
pub(crate) fn sanitize_html_with_deadline(input: &str, deadline: Instant) -> HtmlPreview {
    sanitize_html_until(input, deadline)
}

#[cfg(not(test))]
fn sanitize_html_with_deadline(input: &str, deadline: Instant) -> HtmlPreview {
    sanitize_html_until(input, deadline)
}

fn sanitize_html_until(input: &str, deadline: Instant) -> HtmlPreview {
    if input.len() > MAX_INPUT_BYTES {
        return limited(HtmlPreviewReason::SizeLimit);
    }
    if Instant::now() >= deadline {
        return limited(HtmlPreviewReason::RenderLimit);
    }

    let document = Document::fragment(input);
    if Instant::now() >= deadline {
        return limited(HtmlPreviewReason::RenderLimit);
    }

    let mut renderer = Renderer {
        deadline,
        nodes: 0,
        output: String::new(),
        output_json_bytes: 2,
    };
    let root = document.root();
    let root_children = root.children();
    let content_children = if root_children.len() == 1
        && root_children[0]
            .node_name()
            .is_some_and(|name| name.as_ref().eq_ignore_ascii_case("html"))
    {
        root_children[0].children()
    } else {
        root_children
    };
    for child in content_children {
        if renderer.render(child, child_depth(0, child)).is_err() {
            return limited(HtmlPreviewReason::RenderLimit);
        }
    }

    HtmlPreview {
        html: Some(renderer.output),
        reason: None,
    }
}

fn limited(reason: HtmlPreviewReason) -> HtmlPreview {
    HtmlPreview {
        html: None,
        reason: Some(reason),
    }
}

struct Renderer {
    deadline: Instant,
    nodes: usize,
    output: String,
    output_json_bytes: usize,
}

impl Renderer {
    fn render(&mut self, node: NodeRef<'_>, depth: usize) -> Result<(), ()> {
        self.visit_node()?;
        if node.is_element() && depth > MAX_DEPTH {
            return Err(());
        }

        if node.is_text() {
            return self.append_escaped_text(node.immediate_text().as_ref());
        }
        if !node.is_element() {
            return Ok(());
        }

        let name = node.node_name().ok_or(())?;
        let name = name.as_ref().to_ascii_lowercase();
        if is_dangerous(&name) {
            for child in node.children() {
                self.discard(child, child_depth(depth, child))?;
            }
            self.discard_template_contents(node, depth)?;
            return Ok(());
        }

        if is_allowed(&name) {
            self.append_raw("<")?;
            self.append_raw(&name)?;
            self.append_raw(">")?;
        }
        for child in node.children() {
            self.render(child, child_depth(depth, child))?;
        }
        self.discard_template_contents(node, depth)?;
        if is_allowed(&name) && !is_void(&name) {
            self.append_raw("</")?;
            self.append_raw(&name)?;
            self.append_raw(">")?;
        }
        Ok(())
    }

    fn discard(&mut self, node: NodeRef<'_>, depth: usize) -> Result<(), ()> {
        self.visit_node()?;
        if node.is_element() && depth > MAX_DEPTH {
            return Err(());
        }
        for child in node.children() {
            self.discard(child, child_depth(depth, child))?;
        }
        self.discard_template_contents(node, depth)?;
        Ok(())
    }

    fn discard_template_contents(&mut self, node: NodeRef<'_>, depth: usize) -> Result<(), ()> {
        let Some(contents) = node
            .query(|tree_node| {
                tree_node
                    .as_element()
                    .and_then(|element| element.template_contents)
            })
            .flatten()
            .map(|id| NodeRef::new(id, node.tree))
        else {
            return Ok(());
        };

        for child in contents.children() {
            self.discard(child, child_depth(depth, child))?;
        }
        Ok(())
    }

    fn visit_node(&mut self) -> Result<(), ()> {
        if Instant::now() >= self.deadline {
            return Err(());
        }
        self.nodes = self.nodes.checked_add(1).ok_or(())?;
        if self.nodes > MAX_NODES {
            return Err(());
        }
        Ok(())
    }

    fn append_escaped_text(&mut self, text: &str) -> Result<(), ()> {
        if !text
            .bytes()
            .any(|byte| matches!(byte, b'&' | b'<' | b'>' | b'"' | b'\''))
        {
            return self.append_raw(text);
        }

        let mut escaped = String::with_capacity(text.len());
        for (index, character) in text.chars().enumerate() {
            if index % 4096 == 0 && Instant::now() >= self.deadline {
                return Err(());
            }
            match character {
                '&' => escaped.push_str("&amp;"),
                '<' => escaped.push_str("&lt;"),
                '>' => escaped.push_str("&gt;"),
                '"' => escaped.push_str("&quot;"),
                '\'' => escaped.push_str("&#39;"),
                _ => escaped.push(character),
            }
        }
        self.append_raw(&escaped)
    }

    fn append_raw(&mut self, fragment: &str) -> Result<(), ()> {
        let json_bytes = json_string_fragment_bytes(fragment)?;
        let next = self.output_json_bytes.checked_add(json_bytes).ok_or(())?;
        if next
            .checked_add(HTML_PREVIEW_JSON_OVERHEAD)
            .is_none_or(|size| size >= MAX_OUTPUT_JSON_BYTES)
        {
            return Err(());
        }
        self.output.push_str(fragment);
        self.output_json_bytes = next;
        Ok(())
    }
}

fn child_depth(parent_depth: usize, child: NodeRef<'_>) -> usize {
    parent_depth + usize::from(child.is_element())
}

fn json_string_fragment_bytes(fragment: &str) -> Result<usize, ()> {
    fragment.bytes().try_fold(0usize, |size, byte| {
        let increment = match byte {
            b'"' | b'\\' | 0x08 | 0x0c | b'\n' | b'\r' | b'\t' => 2,
            0..=0x1f => 6,
            _ => 1,
        };
        size.checked_add(increment).ok_or(())
    })
}

fn is_allowed(name: &str) -> bool {
    matches!(
        name,
        "article"
            | "aside"
            | "blockquote"
            | "br"
            | "code"
            | "div"
            | "dl"
            | "dt"
            | "dd"
            | "em"
            | "figure"
            | "figcaption"
            | "footer"
            | "header"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "hr"
            | "b"
            | "i"
            | "kbd"
            | "li"
            | "main"
            | "mark"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "q"
            | "s"
            | "samp"
            | "section"
            | "small"
            | "span"
            | "strong"
            | "sub"
            | "sup"
            | "table"
            | "thead"
            | "tbody"
            | "tfoot"
            | "tr"
            | "th"
            | "td"
            | "u"
            | "ul"
            | "var"
            | "wbr"
            | "abbr"
            | "cite"
    )
}

fn is_void(name: &str) -> bool {
    matches!(name, "br" | "hr" | "wbr")
}

fn is_dangerous(name: &str) -> bool {
    matches!(
        name,
        "script"
            | "style"
            | "iframe"
            | "object"
            | "embed"
            | "template"
            | "svg"
            | "math"
            | "base"
            | "link"
            | "meta"
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use serde_json::Value;

    use super::*;

    fn preview(source: &str) -> String {
        let result = sanitize_html(source);
        assert_eq!(result.reason, None);
        result.html.expect("HTML preview should be available")
    }

    #[test]
    fn allowlist_strips_attributes_and_escapes_text() {
        assert_eq!(
            preview(r#"<div class="x" onclick="alert(1)"><p>a &amp; &lt; b &gt; " '</p></div>"#),
            "<div><p>a &amp; &lt; b &gt; &quot; &#39;</p></div>"
        );
    }

    #[test]
    fn unknown_elements_unwrap_safe_children() {
        assert_eq!(
            preview("<custom data-x='1'>before<a href='javascript:bad()'><strong>ok</strong></a>after</custom>"),
            "before<strong>ok</strong>after"
        );
    }

    #[test]
    fn dangerous_elements_remove_the_entire_subtree() {
        let result = preview(
            r#"<main>safe<script><p>script text</p></script><style>.x{}</style><iframe><p>frame</p></iframe><object><p>object</p></object><embed><template><p>template</p></template><svg><text>svg</text></svg><math><mi>math</mi></math><base href="x"><link href="x"><meta charset="utf-8">done</main>"#,
        );
        assert_eq!(result, "<main>safedone</main>");
    }

    #[test]
    fn comments_doctypes_and_processing_instructions_are_dropped() {
        assert_eq!(
            preview("<!doctype html><!-- hidden --><?xml version='1.0'?><p>shown</p>"),
            "<p>shown</p>"
        );
    }

    #[test]
    fn exact_input_limit_is_allowed_and_plus_one_is_size_limit() {
        let prefix = "<p>";
        let suffix = "</p>";
        let exact = format!(
            "{prefix}{}{suffix}",
            "x".repeat(MAX_INPUT_BYTES - prefix.len() - suffix.len())
        );
        assert_eq!(exact.len(), MAX_INPUT_BYTES);
        assert_eq!(sanitize_html(&exact).reason, None);
        let over = format!("{exact}x");
        assert_eq!(
            sanitize_html(&over),
            HtmlPreview {
                html: None,
                reason: Some(HtmlPreviewReason::SizeLimit),
            }
        );
    }

    #[test]
    fn node_and_depth_limits_are_render_limits() {
        let siblings = (0..5_001).map(|_| "<span>x</span>").collect::<String>();
        assert_eq!(
            sanitize_html(&siblings).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );

        let deep = format!(
            "{}x{}",
            "<div>".repeat(MAX_DEPTH + 1),
            "</div>".repeat(MAX_DEPTH + 1)
        );
        assert_eq!(
            sanitize_html(&deep).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );
    }

    #[test]
    fn exact_node_limit_counts_elements_and_text_nodes() {
        let exactly = (0..5_000).map(|_| "<span>x</span>").collect::<String>();
        assert_eq!(sanitize_html(&exactly).reason, None);

        let over = format!("x{exactly}");
        assert_eq!(
            sanitize_html(&over).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );
    }

    #[test]
    fn exact_element_depth_limit_allows_text_below_depth_32() {
        let at_limit = format!(
            "{}x{}",
            "<div>".repeat(MAX_DEPTH),
            "</div>".repeat(MAX_DEPTH)
        );
        assert_eq!(sanitize_html(&at_limit).reason, None);

        let over = format!(
            "{}x{}",
            "<div>".repeat(MAX_DEPTH + 1),
            "</div>".repeat(MAX_DEPTH + 1)
        );
        assert_eq!(
            sanitize_html(&over).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );
    }

    #[test]
    fn template_contents_are_budgeted_but_never_rendered() {
        let many_nodes = (0..5_000).map(|_| "<span>x</span>").collect::<String>();
        let over_nodes = format!("<template>{many_nodes}</template><p>safe</p>");
        assert_eq!(
            sanitize_html(&over_nodes).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );

        let at_depth = format!(
            "<template>{}x{}</template>",
            "<div>".repeat(MAX_DEPTH - 1),
            "</div>".repeat(MAX_DEPTH - 1)
        );
        assert_eq!(sanitize_html(&at_depth).reason, None);
        let over_depth = format!(
            "<template>{}x{}</template>",
            "<div>".repeat(MAX_DEPTH),
            "</div>".repeat(MAX_DEPTH)
        );
        assert_eq!(
            sanitize_html(&over_depth).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );

        let shadow = "<div><template shadowrootmode='open'><p>shadow</p></template></div>";
        assert_eq!(preview(shadow), "<div></div>");
    }

    #[test]
    fn output_and_deadline_limits_are_render_limits() {
        let escaped = format!("<p>{}</p>", ">".repeat(270_000));
        let escaped_result = sanitize_html(&escaped);
        assert_eq!(
            escaped_result.reason,
            Some(HtmlPreviewReason::RenderLimit),
            "output length={}",
            escaped_result.html.as_ref().map_or(0, String::len)
        );
        let deadline = Instant::now() - Duration::from_millis(1);
        assert_eq!(
            sanitize_html_with_deadline("<p>ok</p>", deadline).reason,
            Some(HtmlPreviewReason::RenderLimit)
        );
    }

    #[test]
    fn serialized_preview_payload_stays_below_one_mib_at_boundary() {
        let count = (MAX_OUTPUT_JSON_BYTES - HTML_PREVIEW_JSON_OVERHEAD - 2 - 7 - 1) / 4;
        let source = format!("<p>{}</p>", ">".repeat(count));
        let result = sanitize_html(&source);
        assert_eq!(result.reason, None, "preview={result:?}");
        let dto = crate::ipc::HtmlPreviewDto {
            html: result.html,
            reason: None,
        };
        assert!(serde_json::to_vec(&dto).unwrap().len() < MAX_OUTPUT_JSON_BYTES);

        let over_source = format!("<p>{}</p>", ">".repeat(count + 1));
        let over_result = sanitize_html(&over_source);
        assert_eq!(
            over_result.reason,
            Some(HtmlPreviewReason::RenderLimit),
            "output length={}",
            over_result.html.as_ref().map_or(0, String::len)
        );
    }

    #[test]
    fn f11_html_payload_contains_only_safe_serialized_markup() {
        let output = temp_dir();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/generate-security-fixtures.mjs");
        let generated = Command::new("node")
            .arg(script)
            .arg(&output)
            .output()
            .expect("node must be available for F-11");
        assert!(
            generated.status.success(),
            "F-11 generation failed: {}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let source = fs::read_to_string(output.join("security-html.json")).unwrap();
        let source: Value = serde_json::from_str(&source).unwrap();
        let html_source = source["data"].as_str().unwrap();
        let sanitized = preview(html_source);
        for forbidden in [
            "<script",
            "<style",
            "<iframe",
            "<form",
            "<img",
            "onclick",
            "javascript:",
            "https://f11-",
            "wss://f11-",
            "data:text/",
            "data:image/",
            "SJV_F11_PROBE_V1",
            "data-f11-vector",
        ] {
            assert!(
                !sanitized.contains(forbidden),
                "sanitized output contains {forbidden}"
            );
        }
        assert!(sanitized.contains("<main>"));
        let _ = fs::remove_dir_all(output);
    }

    fn temp_dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("semantic-json-viewer-html-{nanos}"))
    }
}
