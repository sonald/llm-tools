#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_OUTPUT_DIR = "/tmp/semantic-json-viewer-security-fixtures";
const MAX_HTML_BYTES = 512 * 1024;
const PROBE_TOKEN = "SJV_F11_PROBE_V1";
const SYNTHETIC_UNKNOWN = "SJV_F11_SYNTHETIC_UNKNOWN_V1";
const MARKDOWN_SYNTHETIC_UNKNOWN = "F11_MARKDOWN_ROOT_SENTINEL";
const FENCE = String.fromCharCode(96).repeat(3);
const EFFECT_KEYS = [
  "scriptExecutions",
  "eventHandlerExecutions",
  "sentinelNetworkRequests",
  "previewAppIpcAttempts",
  "topNavigations",
  "hostDomMutations",
  "probeMessages",
];
const EXPECTED_EFFECTS = Object.freeze(
  Object.fromEntries(EFFECT_KEYS.map((key) => [key, 0])),
);
const REQUIRED_CSP = Object.freeze({
  "default-src": ["'none'"],
  "script-src": ["'none'"],
  "connect-src": ["'none'"],
  "img-src": ["'none'"],
  "media-src": ["'none'"],
  "font-src": ["'none'"],
  "frame-src": ["'none'"],
  "object-src": ["'none'"],
  "form-action": ["'none'"],
  "base-uri": ["'none'"],
  "style-src": ["'unsafe-inline'"],
});
const FORBIDDEN_SANDBOX_TOKENS = Object.freeze([
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-top-navigation",
]);

const vector = (id, sentinel, render) => Object.freeze({ id, sentinel, render });
const attributes = (id, sentinel) =>
  'data-f11-vector="' + id + '" data-f11-url="' + sentinel + '"';

const htmlVectors = [
  vector(
    "html-inline-script",
    "https://f11-html-inline-script.invalid/probe",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>window.postMessage("' +
      PROBE_TOKEN +
      '", "*");</script>',
  ),
  vector(
    "html-remote-script",
    "https://f11-html-remote-script.invalid/script.js",
    ({ id, sentinel }) =>
      '<script data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '"></script>',
  ),
  vector(
    "html-iframe",
    "https://f11-html-iframe.invalid/frame",
    ({ id, sentinel }) =>
      '<iframe data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '"></iframe>',
  ),
  vector(
    "html-srcdoc",
    "https://f11-html-srcdoc.invalid/inner",
    ({ id, sentinel }) =>
      '<iframe ' +
      attributes(id, sentinel) +
      ' srcdoc=\'<img src="' +
      sentinel +
      '">\'></iframe>',
  ),
  vector(
    "html-form",
    "https://f11-html-form.invalid/submit",
    ({ id, sentinel }) =>
      '<form ' +
      attributes(id, sentinel) +
      ' id="f11-form-target" action="' +
      sentinel +
      '"><input name="q"><button type="submit">submit form</button></form>',
  ),
  vector(
    "html-formaction",
    "https://f11-html-formaction.invalid/submit",
    ({ id, sentinel }) =>
      '<button type="submit" ' +
      attributes(id, sentinel) +
      ' form="f11-form-target" formaction="' +
      sentinel +
      '">submit</button>',
  ),
  vector(
    "html-event-handlers",
    "https://f11-html-events.invalid/handler",
    ({ id, sentinel }) =>
      "<button " +
      attributes(id, sentinel) +
      " onclick='window.postMessage(\"" +
      PROBE_TOKEN +
      "\", \"*\")' onfocus='window.postMessage(\"" +
      PROBE_TOKEN +
      "\", \"*\")'>event handlers</button>",
  ),
  vector(
    "html-javascript-url",
    "https://f11-html-javascript.invalid/url",
    ({ id, sentinel }) =>
      "<a data-f11-vector=\"" +
      id +
      "\" href=\"javascript:window.postMessage('" +
      PROBE_TOKEN +
      "','*');/*" +
      sentinel +
      "*/\">javascript URL</a>",
  ),
  vector(
    "html-remote-img",
    "https://f11-html-remote-img.invalid/image.png",
    ({ id, sentinel }) =>
      '<img data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '" alt="remote image">',
  ),
  vector(
    "html-srcset",
    "https://f11-html-srcset.invalid/image-2x.png",
    ({ id, sentinel }) =>
      '<img data-f11-vector="' +
      id +
      '" srcset="' +
      sentinel +
      ' 2x" alt="srcset">',
  ),
  vector(
    "html-style-import",
    "https://f11-html-style-import.invalid/style.css",
    ({ id, sentinel }) =>
      "<style " +
      attributes(id, sentinel) +
      '>@import url("' +
      sentinel +
      '");</style>',
  ),
  vector(
    "html-style-background",
    "https://f11-html-style-background.invalid/bg.png",
    ({ id, sentinel }) =>
      "<style " +
      attributes(id, sentinel) +
      ">.f11-bg{background:url('" +
      sentinel +
      "')}</style>",
  ),
  vector(
    "html-inline-style-url",
    "https://f11-html-inline-style.invalid/bg.png",
    ({ id, sentinel }) =>
      '<div ' +
      attributes(id, sentinel) +
      ' style="background-image:url(\'' +
      sentinel +
      '\')">inline style URL</div>',
  ),
  vector(
    "html-fetch",
    "https://f11-html-fetch.invalid/request",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>fetch("' +
      sentinel +
      "?probe=" +
      PROBE_TOKEN +
      '");</script>',
  ),
  vector(
    "html-xhr",
    "https://f11-html-xhr.invalid/request",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>const x = new XMLHttpRequest(); x.open("GET", "' +
      sentinel +
      "?probe=" +
      PROBE_TOKEN +
      '"); x.send();</script>',
  ),
  vector(
    "html-websocket",
    "wss://f11-html-websocket.invalid/socket",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>new WebSocket("' +
      sentinel +
      '");</script>',
  ),
  vector(
    "html-eventsource",
    "https://f11-html-eventsource.invalid/events",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>new EventSource("' +
      sentinel +
      '");</script>',
  ),
  vector(
    "html-data-html",
    "https://f11-html-data-html.invalid/pixel",
    ({ id, sentinel }) =>
      '<iframe ' +
      attributes(id, sentinel) +
      ' src="data:text/html,<img src=\'' +
      sentinel +
      '\'>"></iframe>',
  ),
  vector(
    "html-data-svg",
    "https://f11-html-data-svg.invalid/pixel",
    ({ id, sentinel }) =>
      '<img ' +
      attributes(id, sentinel) +
      ' src="data:image/svg+xml,<svg><image href=\'' +
      sentinel +
      '\'></image></svg">',
  ),
  vector(
    "html-parent-postmessage",
    "https://f11-html-parent.invalid/target",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>try { parent.document.body.setAttribute("data-f11-parent-probe", "' +
      PROBE_TOKEN +
      '"); } catch (_) {} parent.postMessage("' +
      PROBE_TOKEN +
      '", "' +
      sentinel +
      '");</script>',
  ),
  vector(
    "html-top-navigation",
    "https://f11-html-top.invalid/navigate",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>try { top.document.body.setAttribute("data-f11-top-probe", "' +
      PROBE_TOKEN +
      '"); } catch (_) {} top.location.href = "' +
      sentinel +
      "?probe=" +
      PROBE_TOKEN +
      '";</script>',
  ),
  vector(
    "html-host-dom",
    "https://f11-html-host-dom.invalid/mutate",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>window.host && window.host.document.body.setAttribute("data-f11-probe", "' +
      PROBE_TOKEN +
      '");</script>',
  ),
  vector(
    "html-tauri-invoke",
    "https://f11-html-tauri.invalid/invoke",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke("security_fixture_probe", {token: "' +
      PROBE_TOKEN +
      '", sentinel: "' +
      sentinel +
      '" });</script>',
  ),
];

const markdownSignal = (id, sentinel) =>
  '<!-- data-f11-vector="' +
  id +
  '" data-f11-sentinel="' +
  sentinel +
  '" -->\n';
const markdownUrlSignal = (id, sentinel) =>
  '<!-- data-f11-vector="' +
  id +
  '" data-f11-url="' +
  sentinel +
  '" -->\n';
const markdownIdSignal = (id) => '<!-- data-f11-vector="' + id + '" -->\n';
const markdownVectors = [
  vector(
    "md-heading",
    "F11_MD_HEADING_SIGNAL",
    ({ id, sentinel }) => markdownSignal(id, sentinel) + "\n# F-11 heading",
  ),
  vector(
    "md-list",
    "F11_MD_LIST_SIGNAL",
    ({ id, sentinel }) =>
      markdownSignal(id, sentinel) + "\n- first markdown item\n- second markdown item",
  ),
  vector(
    "md-blockquote",
    "F11_MD_BLOCKQUOTE_SIGNAL",
    ({ id, sentinel }) =>
      markdownSignal(id, sentinel) + "\n> F-11 blockquote signal",
  ),
  vector(
    "md-raw-inline-script",
    "https://f11-md-raw-inline.invalid/probe",
    ({ id, sentinel }) =>
      "<script " +
      attributes(id, sentinel) +
      '>window.postMessage("' +
      PROBE_TOKEN +
      '", "*");</script>',
  ),
  vector(
    "md-raw-remote-script",
    "https://f11-md-raw-remote.invalid/script.js",
    ({ id, sentinel }) =>
      '<script data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '"></script>',
  ),
  vector(
    "md-raw-iframe",
    "https://f11-md-raw-iframe.invalid/frame",
    ({ id, sentinel }) =>
      '<iframe data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '"></iframe>',
  ),
  vector(
    "md-raw-form",
    "https://f11-md-raw-form.invalid/submit",
    ({ id, sentinel }) =>
      '<form ' +
      attributes(id, sentinel) +
      ' id="f11-markdown-form"><input name="q"><button type="submit">submit</button></form>',
  ),
  vector(
    "md-raw-img",
    "https://f11-md-raw-img.invalid/image.png",
    ({ id, sentinel }) =>
      '<img data-f11-vector="' +
      id +
      '" src="' +
      sentinel +
      '" alt="raw image">',
  ),
  vector(
    "md-raw-event-handler",
    "https://f11-md-raw-event.invalid/handler",
    ({ id, sentinel }) =>
      "<button " +
      attributes(id, sentinel) +
      " onclick='window.postMessage(\"" +
      PROBE_TOKEN +
      "\", \"*\")'>raw event handler</button>",
  ),
  vector(
    "md-raw-style-url",
    "https://f11-md-raw-style.invalid/style.css",
    ({ id, sentinel }) =>
      '<style data-f11-vector="' +
      id +
      '">.f11-md{background:url("' +
      sentinel +
      '")}</style>',
  ),
  vector(
    "md-javascript-link",
    "https://f11-md-javascript.invalid/request",
    ({ id, sentinel }) =>
      markdownIdSignal(id) +
      "\n[javascript link](javascript:fetch('" +
      sentinel +
      "'))",
  ),
  vector(
    "md-remote-image",
    "https://f11-md-remote-image.invalid/image.png",
    ({ id, sentinel }) =>
      markdownIdSignal(id) + "\n![markdown remote image](" + sentinel + ")",
  ),
  vector(
    "md-data-uri-link",
    "https://f11-md-data-link.invalid/pixel",
    ({ id, sentinel }) =>
      markdownIdSignal(id) +
      "\n[data URI link](data:text/html,%3Cimg%20src%3D%22" +
      sentinel +
      "%22%3E)",
  ),
  vector(
    "md-data-uri-image",
    "https://f11-md-data-image.invalid/pixel",
    ({ id, sentinel }) =>
      markdownIdSignal(id) +
      "\n![data URI image](data:image/svg+xml,%3Csvg%3E%3Cimage%20href%3D%22" +
      sentinel +
      "%22%3E%3C%2Fimage%3E%3C%2Fsvg%3E)",
  ),
  vector(
    "md-fenced-script",
    "https://f11-md-fenced.invalid/literal",
    ({ id, sentinel }) =>
      markdownUrlSignal(id, sentinel) +
      "\n" +
      FENCE +
      "html\n<script>" +
      PROBE_TOKEN +
      "</script>\n" +
      FENCE,
  ),
];

const renderVectors = (vectors, separator = "\n") =>
  vectors.map((item) => item.render(item)).join(separator);
const htmlSource = [
  "<!doctype html>",
  '<html><head><meta charset="utf-8"></head><body>',
  '<main data-f11-probe="' + PROBE_TOKEN + '">',
  renderVectors(htmlVectors),
  "</main></body></html>",
].join("\n");
const markdownSource = [
  "# F-11 markdown security fixtures",
  renderVectors(markdownVectors, "\n\n"),
].join("\n\n");

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const byteLength = (value) => Buffer.byteLength(value, "utf8");
const needleFor = (id) => 'data-f11-vector="' + id + '"';
const caseFor = (id, sourceRef, file, source, renderer, vectors) => ({
  id,
  source: sourceRef,
  file,
  pointer: "/data",
  renderer,
  decodedSource: { sha256: sha256(source), length: byteLength(source) },
  vectors: vectors.map((item) => ({
    id: item.id,
    needle: needleFor(item.id),
    sentinel: item.sentinel,
  })),
  sourceAccessible: true,
  plainTextFallback: true,
  copySourceExact: true,
  expectedEffects: { ...EXPECTED_EFFECTS },
});

const buildArtifacts = () => {
  const htmlRecord = {
    id: "security-html",
    data: htmlSource,
    synthetic_unknown: SYNTHETIC_UNKNOWN,
  };
  const markdownRecord = {
    id: "f11-markdown",
    data: markdownSource,
    synthetic_unknown: MARKDOWN_SYNTHETIC_UNKNOWN,
  };
  const htmlText = JSON.stringify(htmlRecord, null, 2) + "\n";
  const markdownText = JSON.stringify(markdownRecord, null, 2) + "\n";
  const groundTruth = {
    schemaVersion: 1,
    sources: {
      "spec-f11": {
        kind: "spec",
        references: ["F-11"],
        note: "Fixed F-11 security fixture contract",
      },
    },
    files: {
      "security-html.json": {
        role: "source",
        bytes: byteLength(htmlText),
        sha256: sha256(htmlText),
      },
      "security-markdown.json": {
        role: "source",
        bytes: byteLength(markdownText),
        sha256: sha256(markdownText),
      },
      "security-ground-truth.json": { role: "ground-truth" },
    },
    preservation: {
      synthetic_unknown: SYNTHETIC_UNKNOWN,
      markdownSyntheticUnknown: MARKDOWN_SYNTHETIC_UNKNOWN,
      sourceAccessible: true,
      plainTextFallback: true,
      copySourceExact: true,
    },
    probeToken: PROBE_TOKEN,
    csp: { requiredDirectives: { ...REQUIRED_CSP } },
    forbiddenSandboxTokens: [...FORBIDDEN_SANDBOX_TOKENS],
    cases: [
      caseFor(
        "security-html",
        "spec-f11",
        "security-html.json",
        htmlRecord.data,
        "html",
        htmlVectors,
      ),
      caseFor(
        "security-markdown",
        "spec-f11",
        "security-markdown.json",
        markdownRecord.data,
        "markdown",
        markdownVectors,
      ),
    ],
  };
  return {
    "security-html.json": htmlText,
    "security-markdown.json": markdownText,
    "security-ground-truth.json": JSON.stringify(groundTruth, null, 2) + "\n",
  };
};

const vectorHosts = (source) =>
  [...source.matchAll(/(?:https?|wss):\/\/([a-z0-9-]+\.invalid)\b/gi)].map(
    (match) => match[1].toLowerCase(),
  );
const vectorIds = (source) =>
  [...source.matchAll(/data-f11-vector="([^"]+)"/g)].map((match) => match[1]);
const countOccurrences = (source, needle) => {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
};

const externalSentinel = (sentinel) =>
  /^(?:https?|wss):\/\/[^/]+\.invalid\//.test(sentinel);
const truthVectors = (vectors) =>
  vectors.map((item) => ({
    id: item.id,
    needle: needleFor(item.id),
    sentinel: item.sentinel,
  }));
const verifyVectorSource = (source, vectors, label) => {
  const ids = vectors.map((item) => item.id);
  const sentinels = vectors.map((item) => item.sentinel);
  assert.equal(new Set(ids).size, ids.length, label + " vector IDs are not unique");
  assert.equal(new Set(sentinels).size, sentinels.length, label + " sentinels are not unique");
  const actualIds = vectorIds(source);
  assert.equal(actualIds.length, ids.length, label + " vector ID count mismatch");
  assert.deepStrictEqual([...actualIds].sort(), [...ids].sort());
  const expectedHosts = sentinels
    .filter(externalSentinel)
    .map((sentinel) => new URL(sentinel).hostname.toLowerCase());
  const actualHosts = vectorHosts(source);
  for (const host of actualHosts) {
    assert.equal(expectedHosts.includes(host), true, label + " has undeclared sentinel host: " + host);
  }
  for (const item of vectors) {
    const needle = needleFor(item.id);
    assert.equal(countOccurrences(source, needle), 1, label + " needle must occur once: " + needle);
    assert.equal(source.includes(item.sentinel), true, label + " missing sentinel: " + item.sentinel);
    if (externalSentinel(item.sentinel)) {
      assert.equal(
        actualHosts.includes(new URL(item.sentinel).hostname.toLowerCase()),
        true,
        label + " missing sentinel host: " + item.sentinel,
      );
    }
  }
};

const selfCheck = (artifacts) => {
  const secondPass = buildArtifacts();
  assert.deepStrictEqual(artifacts, secondPass, "fixture generation is not deterministic");
  assert.deepStrictEqual(Object.keys(artifacts).sort(), [
    "security-ground-truth.json",
    "security-html.json",
    "security-markdown.json",
  ]);
  const htmlText = artifacts["security-html.json"];
  const markdownText = artifacts["security-markdown.json"];
  const groundTruthText = artifacts["security-ground-truth.json"];
  assert.ok(byteLength(htmlText) < MAX_HTML_BYTES, "security HTML exceeds 512 KiB");
  assert.ok(byteLength(markdownText) < MAX_HTML_BYTES, "security Markdown exceeds 512 KiB");
  const htmlRecord = JSON.parse(htmlText);
  const markdownRecord = JSON.parse(markdownText);
  assert.deepStrictEqual(Object.keys(htmlRecord).sort(), ["data", "id", "synthetic_unknown"]);
  assert.deepStrictEqual(Object.keys(markdownRecord).sort(), ["data", "id", "synthetic_unknown"]);
  assert.equal(htmlRecord.id, "security-html");
  assert.equal(htmlRecord.synthetic_unknown, SYNTHETIC_UNKNOWN);
  assert.equal(htmlRecord.data, htmlSource);
  assert.equal(htmlRecord.data.includes(PROBE_TOKEN), true);
  assert.equal(markdownRecord.id, "f11-markdown");
  assert.equal(markdownRecord.synthetic_unknown, MARKDOWN_SYNTHETIC_UNKNOWN);
  assert.equal(markdownRecord.data, markdownSource);
  assert.equal(markdownRecord.data.includes(PROBE_TOKEN), true);
  verifyVectorSource(htmlRecord.data, htmlVectors, "HTML");
  verifyVectorSource(markdownRecord.data, markdownVectors, "Markdown");
  for (const required of [
    "<script",
    "srcdoc=",
    "<iframe",
    "<form",
    'id="f11-form-target"',
    "formaction=",
    'form="f11-form-target"',
    "onclick=",
    "href=\"javascript:",
    "srcset=",
    "@import",
    "background:url",
    "background-image:url",
    "fetch(",
    "new XMLHttpRequest",
    "new WebSocket",
    "new EventSource",
    "data:text/html",
    "data:image/svg+xml",
    "try { parent.document",
    "catch (_) {} parent.postMessage",
    "parent.postMessage",
    "try { top.document",
    "catch (_) {} top.location",
    "top.location",
    "window.host",
    "__TAURI_INTERNALS__",
    'window.__TAURI_INTERNALS__.invoke("security_fixture_probe"',
    "{token:",
    "sentinel:",
  ]) {
    assert.equal(htmlRecord.data.includes(required), true, "missing HTML vector marker: " + required);
  }
  for (const required of [
    "# F-11 markdown security fixtures",
    "# F-11 heading",
    "- first markdown item",
    "> F-11 blockquote signal",
    "<script",
    "<iframe",
    "<form",
    "<img",
    "onclick=",
    "<style",
    "background:url",
    "javascript:fetch(",
    "markdown remote image",
    "data:text/html,%3Cimg%20src%3D%22",
    "data:image/svg+xml,%3Csvg%3E",
    FENCE + "html",
    "<script>",
    PROBE_TOKEN,
  ]) {
    assert.equal(markdownRecord.data.includes(required), true, "missing Markdown vector marker: " + required);
  }
  assert.equal(markdownRecord.data.includes("data:text/html,<"), false);
  assert.equal(markdownRecord.data.includes("data:image/svg+xml,<"), false);
  for (const item of markdownVectors) {
    const rendered = item.render(item);
    assert.equal(
      markdownRecord.data.includes("\n\n" + rendered),
      true,
      "Markdown vector is not block-separated: " + item.id,
    );
  }

  const groundTruth = JSON.parse(groundTruthText);
  assert.equal(groundTruth.schemaVersion, 1);
  assert.deepStrictEqual(groundTruth.sources["spec-f11"], {
    kind: "spec",
    references: ["F-11"],
    note: "Fixed F-11 security fixture contract",
  });
  assert.deepStrictEqual(Object.keys(groundTruth.files).sort(), [
    "security-ground-truth.json",
    "security-html.json",
    "security-markdown.json",
  ]);
  assert.deepStrictEqual(groundTruth.files["security-html.json"], {
    role: "source",
    bytes: byteLength(htmlText),
    sha256: sha256(htmlText),
  });
  assert.deepStrictEqual(groundTruth.files["security-markdown.json"], {
    role: "source",
    bytes: byteLength(markdownText),
    sha256: sha256(markdownText),
  });
  assert.equal(groundTruth.files["security-ground-truth.json"].role, "ground-truth");
  assert.deepStrictEqual(groundTruth.preservation, {
    synthetic_unknown: SYNTHETIC_UNKNOWN,
    markdownSyntheticUnknown: MARKDOWN_SYNTHETIC_UNKNOWN,
    sourceAccessible: true,
    plainTextFallback: true,
    copySourceExact: true,
  });
  assert.equal(htmlRecord.synthetic_unknown, groundTruth.preservation.synthetic_unknown);
  assert.equal(markdownRecord.synthetic_unknown, groundTruth.preservation.markdownSyntheticUnknown);
  assert.equal(groundTruth.probeToken, PROBE_TOKEN);
  assert.deepStrictEqual(groundTruth.csp.requiredDirectives, REQUIRED_CSP);
  assert.deepStrictEqual(groundTruth.forbiddenSandboxTokens, FORBIDDEN_SANDBOX_TOKENS);
  assert.equal(groundTruthText.includes(htmlSource), false, "ground truth repeats payload");
  assert.equal(groundTruthText.includes(markdownSource), false, "ground truth repeats Markdown payload");
  assert.equal(groundTruth.cases.length, 2);
  const htmlCase = groundTruth.cases[0];
  assert.equal(htmlCase.id, "security-html");
  assert.equal(htmlCase.source, "spec-f11");
  assert.equal(htmlCase.file, "security-html.json");
  assert.equal(htmlCase.pointer, "/data");
  assert.equal(htmlCase.renderer, "html");
  assert.equal(htmlCase.decodedSource.sha256, sha256(htmlRecord.data));
  assert.equal(htmlCase.decodedSource.length, byteLength(htmlRecord.data));
  assert.deepStrictEqual(htmlCase.vectors, truthVectors(htmlVectors));
  assert.equal(htmlCase.sourceAccessible, true);
  assert.equal(htmlCase.plainTextFallback, true);
  assert.equal(htmlCase.copySourceExact, true);
  assert.deepStrictEqual(htmlCase.expectedEffects, EXPECTED_EFFECTS);
  assert.deepStrictEqual(Object.keys(htmlCase.expectedEffects).sort(), [...EFFECT_KEYS].sort());
  const markdownCase = groundTruth.cases[1];
  assert.equal(markdownCase.id, "security-markdown");
  assert.equal(markdownCase.source, "spec-f11");
  assert.equal(markdownCase.file, "security-markdown.json");
  assert.equal(markdownCase.pointer, "/data");
  assert.equal(markdownCase.renderer, "markdown");
  assert.equal(markdownCase.decodedSource.sha256, sha256(markdownRecord.data));
  assert.equal(markdownCase.decodedSource.length, byteLength(markdownRecord.data));
  assert.deepStrictEqual(markdownCase.vectors, truthVectors(markdownVectors));
  assert.equal(markdownCase.sourceAccessible, true);
  assert.equal(markdownCase.plainTextFallback, true);
  assert.equal(markdownCase.copySourceExact, true);
  assert.deepStrictEqual(markdownCase.expectedEffects, EXPECTED_EFFECTS);
  assert.deepStrictEqual(Object.keys(markdownCase.expectedEffects).sort(), [...EFFECT_KEYS].sort());
};

const writeArtifacts = async (outputDir) => {
  const artifacts = buildArtifacts();
  selfCheck(artifacts);
  await mkdir(outputDir, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    const path = resolve(outputDir, name);
    await writeFile(path, content, "utf8");
    const written = await readFile(path, "utf8");
    assert.equal(written, content, "written fixture differs: " + name);
  }
  for (const name of ["security-html.json", "security-markdown.json"]) {
    assert.ok((await stat(resolve(outputDir, name))).size < MAX_HTML_BYTES);
  }
  return artifacts;
};

const outputDir = resolve(process.argv[2] || DEFAULT_OUTPUT_DIR);
writeArtifacts(outputDir)
  .then((artifacts) => {
    console.log("security fixture verification: PASS");
    for (const [name, content] of Object.entries(artifacts)) {
      console.log(
        name +
          " bytes=" +
          byteLength(content) +
          " sha256=" +
          sha256(content),
      );
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
