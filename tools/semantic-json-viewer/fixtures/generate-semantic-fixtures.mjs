import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const outputDirectory = path.resolve(
  process.argv[2] ?? "/tmp/semantic-json-viewer-semantic-fixtures"
);
const MIB = 1024 * 1024;
const sources = {
  "spec-f01": {
    kind: "spec-derived-synthetic",
    references: ["spec §12.5", "spec §12.6", "spec §14"],
    note: "Rich string detection and plain-text negative signals."
  },
  "spec-f02": {
    kind: "spec-derived-synthetic",
    references: ["spec §12.4", "spec F-02"],
    note: "Nested JSON shape, depth, size, and cumulative materialization limits."
  },
  "spec-f03": {
    kind: "spec-derived-synthetic",
    references: ["spec §15.3", "spec F-03"],
    note: "OpenAI message and tool-call adapter signals."
  },
  "spec-f04": {
    kind: "spec-derived-synthetic",
    references: ["spec §15.4", "spec F-04"],
    note: "Anthropic system and content block adapter signals."
  },
  "spec-f05": {
    kind: "spec-derived-synthetic",
    references: ["spec §15.6", "spec F-05"],
    note: "Generic role/content and from/value conversation thresholds."
  },
  "spec-f06": {
    kind: "spec-derived-synthetic",
    references: ["spec §7.4", "spec F-06A", "spec F-06B"],
    note: "Event Stream Hint field ratios and training-sample negative."
  }
};

function sourceIdForFile(file) {
  if (file === "rich-strings.json") return "spec-f01";
  if (file === "nested-json.json" || file === "nested-json-limits.json") return "spec-f02";
  if (file === "openai-conversation.json") return "spec-f03";
  if (file.startsWith("anthropic-")) return "spec-f04";
  if (file.startsWith("generic-")) return "spec-f05";
  return "spec-f06";
}

const richStrings = {
  data: [
    { id: "plain-unicode", data: "你好，Semantic Viewer 👋" },
    { id: "markdown-heading", data: "# Release notes\nA small, readable change." },
    { id: "markdown-list", data: "- first item\n- second item\n- third item" },
    { id: "markdown-quote", data: "> Preserve the source before rendering it." },
    { id: "markdown-table", data: "| Name | Value |\n| --- | --- |\n| mode | semantic |" },
    { id: "fenced-rust", data: "```rust\nfn main() {\n    println!(\"hello\");\n}\n```" },
    { id: "benign-html", data: "<section><h2>Safe heading</h2><p>Inline text.</p></section>" },
    { id: "underscore-negative", data: "foo_bar" },
    { id: "asterisk-negative", data: "a*b" },
    { id: "type-angle-negative", data: "<T>" },
    { id: "xml-negative", data: "<?xml version=\"1.0\"?>\n<root>technical text</root>" },
    { id: "technical-angle-negative", data: "Vec<T> -> Result<T, E>" }
  ]
};

const nestedObjectString = JSON.stringify({
  array: [1, 2, 3],
  enabled: true,
  unknown: "NESTED_UNKNOWN_SENTINEL"
});
const nestedArrayString = JSON.stringify([
  { id: "array-object", ok: true },
  false,
  "array scalar"
]);
let deepString = JSON.stringify({ level: 11, leaf: "done" });
for (let level = 10; level >= 1; level -= 1) {
  deepString = JSON.stringify({ level, next: deepString });
}
const nestedJson = {
  data: {
    objectString: nestedObjectString,
    arrayString: nestedArrayString,
    invalidJsonLooking: '{"a":1,}',
    primitiveStrings: {
      hello: "hello",
      number: "123",
      boolean: "true",
      null: "null"
    },
    deepObjectNextString: deepString
  }
};

const overLimitPrefix = '{"payload":"';
const overLimitSuffix = '"}';
const overLimitString = `${overLimitPrefix}${"x".repeat(
  2 * MIB + 1 - Buffer.byteLength(overLimitPrefix, "utf8") - Buffer.byteLength(overLimitSuffix, "utf8")
)}${overLimitSuffix}`;
const cumulativeBase = JSON.stringify({ payload: "y".repeat(Math.floor(1.4 * MIB)) });
const cumulativeLayerByteLengths = [];
let cumulativeString = cumulativeBase;
for (let layer = 0; layer < 6; layer += 1) {
  cumulativeString = JSON.stringify({ next: cumulativeString });
  cumulativeLayerByteLengths.push(Buffer.byteLength(cumulativeString, "utf8"));
}
const nestedLimits = {
  data: { overLimitString, cumulativeSixLayerString: cumulativeString, cumulativeLayerByteLengths }
};

function stringCase(id, file, pointer, semanticType, eligible, features, stopReason = null) {
  return {
    id,
    file,
    source: sourceIdForFile(file),
    pointer,
    kind: "string",
    expected: { semanticType, eligible, features, stopReason }
  };
}

function escapeJsonPointerToken(token) {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function collectSyntheticUnknownPointers(value, pointer = "", result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSyntheticUnknownPointers(item, `${pointer}/${index}`, result));
    return result;
  }
  if (value === null || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    const childPointer = `${pointer}/${escapeJsonPointerToken(key)}`;
    if (key === "synthetic_unknown") {
      if (item !== null && typeof item !== "object") result.push(childPointer);
    } else {
      collectSyntheticUnknownPointers(item, childPointer, result);
    }
  }
  return result.sort();
}

const stringCases = [
  stringCase("plain-unicode", "rich-strings.json", "/data/0/data", "Plain Text", true, ["unicode", "plain"]),
  stringCase("markdown-heading", "rich-strings.json", "/data/1/data", "Markdown", true, ["markdown", "heading"]),
  stringCase("markdown-list", "rich-strings.json", "/data/2/data", "Markdown", true, ["markdown", "list"]),
  stringCase("markdown-quote", "rich-strings.json", "/data/3/data", "Markdown", true, ["markdown", "blockquote"]),
  stringCase("markdown-table", "rich-strings.json", "/data/4/data", "Markdown", true, ["markdown", "table"]),
  stringCase("fenced-rust", "rich-strings.json", "/data/5/data", "Markdown", true, ["markdown", "fencedCode", "rust"]),
  stringCase("benign-html", "rich-strings.json", "/data/6/data", "HTML", true, ["html", "benignElement"]),
  stringCase("underscore-negative", "rich-strings.json", "/data/7/data", "Plain Text", true, ["negative", "underscoreOnly"], "weakSignal"),
  stringCase("asterisk-negative", "rich-strings.json", "/data/8/data", "Plain Text", true, ["negative", "asteriskOnly"], "weakSignal"),
  stringCase("type-angle-negative", "rich-strings.json", "/data/9/data", "Plain Text", true, ["negative", "ambiguousAngle"], "ambiguousAngle"),
  stringCase("xml-negative", "rich-strings.json", "/data/10/data", "Plain Text", true, ["negative", "xmlDeclaration"], "xmlDeclaration"),
  stringCase("technical-angle-negative", "rich-strings.json", "/data/11/data", "Plain Text", true, ["negative", "technicalAngle"], "ambiguousAngle"),
  stringCase("nested-object", "nested-json.json", "/data/objectString", "Nested JSON", true, ["object", "array", "boolean", "unknown"]),
  stringCase("nested-array", "nested-json.json", "/data/arrayString", "Nested JSON", true, ["array", "object", "scalar"]),
  stringCase("nested-invalid", "nested-json.json", "/data/invalidJsonLooking", "Plain Text", true, ["nestedJsonCandidate"], "jsonParseFailed"),
  stringCase("nested-primitive-hello", "nested-json.json", "/data/primitiveStrings/hello", "Plain Text", true, ["primitiveLooking"], "notObjectOrArray"),
  stringCase("nested-primitive-number", "nested-json.json", "/data/primitiveStrings/number", "Plain Text", true, ["primitiveLooking"], "notObjectOrArray"),
  stringCase("nested-primitive-boolean", "nested-json.json", "/data/primitiveStrings/boolean", "Plain Text", true, ["primitiveLooking"], "notObjectOrArray"),
  stringCase("nested-primitive-null", "nested-json.json", "/data/primitiveStrings/null", "Plain Text", true, ["primitiveLooking"], "notObjectOrArray"),
  stringCase("nested-depth-chain", "nested-json.json", "/data/deepObjectNextString", "Nested JSON", true, ["recursiveChain", "depth11"], "defaultDepth5HardDepth10"),
  stringCase("nested-size-limit", "nested-json-limits.json", "/data/overLimitString", "Plain Text", false, ["nestedJsonCandidate", "over2MiB"], "sizeLimit"),
  stringCase("nested-cumulative-limit", "nested-json-limits.json", "/data/cumulativeSixLayerString", "Nested JSON", true, ["recursiveChain", "cumulativeOver8MiB"], "cumulativeLimit")
];

const openaiConversation = {
  model: "gpt-5.6",
  messages: [
    {
      role: "system",
      content: "Follow the repository inspection policy.",
      synthetic_unknown: "OPENAI_SYSTEM_UNKNOWN_SENTINEL"
    },
    {
      role: "developer",
      content: "Return a concise, source-preserving answer.",
      synthetic_unknown: "OPENAI_DEVELOPER_UNKNOWN_SENTINEL"
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Inspect the sample data.",
          synthetic_unknown: "OPENAI_TEXT_UNKNOWN_SENTINEL"
        },
        {
          type: "image_url",
          image_url: { url: "https://example.invalid/synthetic.png" },
          synthetic_unknown: "OPENAI_IMAGE_UNKNOWN_SENTINEL"
        },
        {
          type: "extension_block",
          payload: "OPENAI_CONTENT_UNKNOWN_SENTINEL",
          synthetic_unknown: "OPENAI_EXTENSION_UNKNOWN_SENTINEL"
        }
      ],
      synthetic_unknown: "OPENAI_USER_UNKNOWN_SENTINEL"
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_lookup",
          type: "function",
          function: {
            name: "lookup_status",
            arguments: "{\"query\":\"status\"}",
            synthetic_unknown: "OPENAI_FUNCTION_STRING_UNKNOWN_SENTINEL"
          },
          synthetic_unknown: "OPENAI_CALL_STRING_UNKNOWN_SENTINEL"
        },
        {
          id: "call_echo",
          type: "function",
          function: {
            name: "echo_value",
            arguments: { value: "source-preserving" },
            synthetic_unknown: "OPENAI_FUNCTION_OBJECT_UNKNOWN_SENTINEL"
          },
          synthetic_unknown: "OPENAI_CALL_OBJECT_UNKNOWN_SENTINEL"
        }
      ],
      synthetic_unknown: "OPENAI_ASSISTANT_TOOL_UNKNOWN_SENTINEL"
    },
    {
      role: "tool",
      tool_call_id: "call_lookup",
      content: "status: ready",
      synthetic_unknown: "OPENAI_TOOL_UNKNOWN_SENTINEL"
    },
    {
      role: "assistant",
      content: null,
      function_call: {
        name: "legacy_lookup",
        arguments: { query: "legacy" },
        synthetic_unknown: "OPENAI_LEGACY_FUNCTION_UNKNOWN_SENTINEL"
      },
      synthetic_unknown: "OPENAI_ASSISTANT_LEGACY_UNKNOWN_SENTINEL"
    }
  ],
  synthetic_unknown: "OPENAI_ROOT_UNKNOWN_SENTINEL"
};

function anthropicConversation(system) {
  return {
    model: "claude-3-7-sonnet-latest",
    max_tokens: 512,
    system,
    messages: [
      {
        role: "user",
        content: "Please inspect the attached result.",
        synthetic_unknown: "ANTHROPIC_USER_UNKNOWN_SENTINEL"
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "I should inspect the tool result before answering.",
            synthetic_unknown: "ANTHROPIC_THINKING_UNKNOWN_SENTINEL"
          },
          {
            type: "redacted_thinking",
            data: "opaque-redacted-content",
            synthetic_unknown: "ANTHROPIC_REDACTED_UNKNOWN_SENTINEL"
          },
          {
            type: "text",
            text: "I will use the lookup tool.",
            synthetic_unknown: "ANTHROPIC_TEXT_UNKNOWN_SENTINEL"
          },
          {
            type: "tool_use",
            id: "toolu_lookup",
            name: "lookup_status",
            input: { query: "status" },
            synthetic_unknown: "ANTHROPIC_TOOL_USE_UNKNOWN_SENTINEL"
          },
          {
            type: "unknown_block",
            payload: "ANTHROPIC_UNKNOWN_BLOCK_SENTINEL",
            synthetic_unknown: "ANTHROPIC_UNKNOWN_BLOCK_META_SENTINEL"
          }
        ],
        synthetic_unknown: "ANTHROPIC_ASSISTANT_UNKNOWN_SENTINEL"
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_lookup",
            content: [
              {
                type: "text",
                text: "status: ready",
                synthetic_unknown: "ANTHROPIC_RESULT_TEXT_UNKNOWN_SENTINEL"
              }
            ],
            is_error: false,
            synthetic_unknown: "ANTHROPIC_TOOL_RESULT_UNKNOWN_SENTINEL"
          },
          {
            type: "unknown_block",
            payload: "ANTHROPIC_USER_UNKNOWN_BLOCK_SENTINEL",
            synthetic_unknown: "ANTHROPIC_USER_BLOCK_META_SENTINEL"
          }
        ],
        synthetic_unknown: "ANTHROPIC_RESULT_USER_UNKNOWN_SENTINEL"
      }
    ],
    synthetic_unknown: "ANTHROPIC_ROOT_UNKNOWN_SENTINEL"
  };
}

const anthropicSystemString = anthropicConversation(
  "Use source-preserving reasoning and identify tool results explicitly."
);
const anthropicSystemBlocks = anthropicConversation([
  {
    type: "text",
    text: "Use source-preserving reasoning.",
    synthetic_unknown: "ANTHROPIC_SYSTEM_TEXT_UNKNOWN_SENTINEL"
  },
  {
    type: "unknown_block",
    payload: "ANTHROPIC_SYSTEM_UNKNOWN_BLOCK_SENTINEL",
    synthetic_unknown: "ANTHROPIC_SYSTEM_BLOCK_META_SENTINEL"
  }
]);

const genericRoleContent = {
  conversation: [
    { role: "system", content: "Set the context.", synthetic_unknown: "GENERIC_ROLE_SYSTEM_UNKNOWN_SENTINEL" },
    { role: "human", content: "Please inspect the input.", synthetic_unknown: "GENERIC_ROLE_HUMAN_UNKNOWN_SENTINEL" },
    { role: "gpt", content: "I will inspect it.", synthetic_unknown: "GENERIC_ROLE_GPT_UNKNOWN_SENTINEL" },
    { role: "user", content: "Continue.", synthetic_unknown: "GENERIC_ROLE_USER_UNKNOWN_SENTINEL" },
    { role: "model", content: "The result is ready.", synthetic_unknown: "GENERIC_ROLE_MODEL_UNKNOWN_SENTINEL" },
    { role: "bot", content: "No source bytes were changed.", synthetic_unknown: "GENERIC_ROLE_BOT_UNKNOWN_SENTINEL" }
  ],
  synthetic_unknown: "GENERIC_ROLE_ROOT_UNKNOWN_SENTINEL"
};

const genericFromValue = {
  conversation: [
    { from: "human", value: "Please inspect the input.", synthetic_unknown: "GENERIC_FROM_HUMAN_UNKNOWN_SENTINEL" },
    { from: "gpt", value: "I will inspect it.", synthetic_unknown: "GENERIC_FROM_GPT_UNKNOWN_SENTINEL" },
    { from: "user", value: "Continue.", synthetic_unknown: "GENERIC_FROM_USER_UNKNOWN_SENTINEL" },
    { from: "model", value: "The result is ready.", synthetic_unknown: "GENERIC_FROM_MODEL_UNKNOWN_SENTINEL" }
  ],
  synthetic_unknown: "GENERIC_FROM_ROOT_UNKNOWN_SENTINEL"
};

const genericNonConversation = [
  { id: "metric", value: 42, synthetic_unknown: "GENERIC_NON_CONVERSATION_METRIC_SENTINEL" },
  { id: "sample", data: "plain record", synthetic_unknown: "GENERIC_NON_CONVERSATION_SAMPLE_SENTINEL" },
  { kind: "record", values: [1, 2, 3], synthetic_unknown: "GENERIC_NON_CONVERSATION_RECORD_SENTINEL" }
];

function genericThreshold(matchCount) {
  return Array.from({ length: 100 }, (_, index) => index < matchCount
    ? {
      role: index % 2 === 0 ? "user" : "assistant",
      content: `threshold matching message ${index}`
    }
    : {
      speaker: `speaker-${index}`,
      text: `threshold nonmatching sample ${index}`
    });
}

const genericThreshold79 = genericThreshold(79);
const genericThreshold80 = genericThreshold(80);

const eventTypeKeys = ["type", "event", "event_type", "kind"];
const timestampKeys = ["timestamp", "time", "ts", "created_at"];
const eventStreamPositive = Array.from({ length: 10 }, (_, index) => {
  const event = { id: `event-${index}`, payload: `positive-${index}` };
  if (index < 7) event[eventTypeKeys[index % eventTypeKeys.length]] = index % 2 === 0 ? "message" : "tool_call";
  if (index < 4) event[timestampKeys[index]] = `2026-01-01T00:00:0${index}Z`;
  return event;
});
const eventStreamTrainingNegative = Array.from({ length: 10 }, (_, index) => ({
  type: "training_sample",
  sample: index,
  payload: `negative-${index}`
}));

const conversationCases = [
  {
    id: "openai-conversation",
    file: "openai-conversation.json",
    source: "spec-f03",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "openai",
      possibleConversation: false,
      normalizedRoles: ["system", "developer", "user", "assistant", "tool", "assistant"],
      inputBlockTypes: ["text", "image_url", "extension_block"],
      expectedUnknownBlockPointers: ["/messages/2/content/2"],
      preservePointers: collectSyntheticUnknownPointers(openaiConversation),
      stopReason: null
    }
  },
  {
    id: "anthropic-system-string",
    file: "anthropic-system-string.json",
    source: "spec-f04",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "anthropic",
      possibleConversation: false,
      normalizedRoles: ["system", "user", "assistant", "user"],
      inputBlockTypes: ["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "unknown_block"],
      expectedUnknownBlockPointers: ["/messages/1/content/4", "/messages/2/content/1"],
      preservePointers: collectSyntheticUnknownPointers(anthropicSystemString),
      stopReason: null
    }
  },
  {
    id: "anthropic-system-blocks",
    file: "anthropic-system-blocks.json",
    source: "spec-f04",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "anthropic",
      possibleConversation: false,
      normalizedRoles: ["system", "user", "assistant", "user"],
      inputBlockTypes: ["text", "unknown_block", "thinking", "redacted_thinking", "tool_use", "tool_result"],
      expectedUnknownBlockPointers: ["/system/1", "/messages/1/content/4", "/messages/2/content/1"],
      preservePointers: collectSyntheticUnknownPointers(anthropicSystemBlocks),
      stopReason: null
    }
  },
  {
    id: "generic-role-content",
    file: "generic-role-content.json",
    source: "spec-f05",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "generic",
      possibleConversation: false,
      normalizedRoles: ["system", "user", "assistant", "user", "assistant", "assistant"],
      inputBlockTypes: [],
      expectedUnknownBlockPointers: [],
      preservePointers: collectSyntheticUnknownPointers(genericRoleContent),
      stopReason: null
    }
  },
  {
    id: "generic-from-value",
    file: "generic-from-value.json",
    source: "spec-f05",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "generic",
      possibleConversation: false,
      normalizedRoles: ["user", "assistant", "user", "assistant"],
      inputBlockTypes: [],
      expectedUnknownBlockPointers: [],
      preservePointers: collectSyntheticUnknownPointers(genericFromValue),
      stopReason: null
    }
  },
  {
    id: "generic-non-conversation",
    file: "generic-non-conversation.json",
    source: "spec-f05",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: null,
      possibleConversation: false,
      normalizedRoles: [],
      inputBlockTypes: [],
      expectedUnknownBlockPointers: [],
      preservePointers: collectSyntheticUnknownPointers(genericNonConversation),
      stopReason: "role/content shape absent"
    }
  }
];

const thresholdCases = [
  {
    id: "generic-threshold-79",
    file: "generic-threshold-79.json",
    source: "spec-f05",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: null,
      possibleConversation: true,
      normalizedRoles: [],
      inputBlockTypes: [],
      expectedUnknownBlockPointers: [],
      ratios: {
        objects: { numerator: 100, denominator: 100 },
        roleKeys: { numerator: 79, denominator: 100 },
        recognizedRoles: { numerator: 79, denominator: 100 },
        contents: { numerator: 79, denominator: 100 }
      },
      preservePointers: [],
      stopReason: "roleContentThreshold79Percent"
    }
  },
  {
    id: "generic-threshold-80",
    file: "generic-threshold-80.json",
    source: "spec-f05",
    pointer: "",
    kind: "conversation",
    expected: {
      expectedAdapter: "generic",
      possibleConversation: false,
      normalizedRoles: genericThreshold80.slice(0, 80).map((item) => item.role),
      inputBlockTypes: [],
      expectedUnknownBlockPointers: [],
      ratios: {
        objects: { numerator: 100, denominator: 100 },
        roleKeys: { numerator: 80, denominator: 100 },
        recognizedRoles: { numerator: 80, denominator: 100 },
        contents: { numerator: 80, denominator: 100 }
      },
      preservePointers: [],
      stopReason: null
    }
  }
];

const eventStreamCases = [
  {
    id: "event-stream-positive",
    file: "event-stream-positive.jsonl",
    source: "spec-f06",
    pointer: "",
    kind: "eventStream",
    expected: {
      expectedHint: true,
      metrics: {
        T: { numerator: 7, denominator: 10 },
        P: { numerator: 4, denominator: 10 },
        G: { numerator: 0, denominator: 10 },
        R: { numerator: 0, denominator: 0, defined: false },
        S: { numerator: 0, denominator: 10 }
      },
      preservePointers: [],
      stopReason: null
    }
  },
  {
    id: "event-stream-training-negative",
    file: "event-stream-training-negative.jsonl",
    source: "spec-f06",
    pointer: "",
    kind: "eventStream",
    expected: {
      expectedHint: false,
      metrics: {
        T: { numerator: 10, denominator: 10 },
        P: { numerator: 0, denominator: 10 },
        G: { numerator: 0, denominator: 10 },
        R: { numerator: 0, denominator: 0, defined: false },
        S: { numerator: 0, denominator: 10 }
      },
      preservePointers: [],
      stopReason: "trainingSampleOnly"
    }
  }
];

const cases = [...stringCases, ...conversationCases, ...thresholdCases, ...eventStreamCases];

const fixtureValues = new Map([
  ["rich-strings.json", richStrings],
  ["nested-json.json", nestedJson],
  ["nested-json-limits.json", nestedLimits],
  ["openai-conversation.json", openaiConversation],
  ["anthropic-system-string.json", anthropicSystemString],
  ["anthropic-system-blocks.json", anthropicSystemBlocks],
  ["generic-role-content.json", genericRoleContent],
  ["generic-from-value.json", genericFromValue],
  ["generic-non-conversation.json", genericNonConversation],
  ["generic-threshold-79.json", genericThreshold79],
  ["generic-threshold-80.json", genericThreshold80],
  ["event-stream-positive.jsonl", eventStreamPositive],
  ["event-stream-training-negative.jsonl", eventStreamTrainingNegative]
]);

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonlBytes(values) {
  return Buffer.from(`${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function pointerValue(value, pointer) {
  if (pointer === "") return value;
  if (!pointer.startsWith("/")) return undefined;
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => {
      if (current === null || current === undefined || !(part in Object(current))) return undefined;
      return current[part];
    }, value);
}

function inputBlockTypes(value, adapter) {
  const types = [];
  const collectContent = (content) => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block === null || typeof block !== "object" || typeof block.type !== "string") continue;
      types.push(block.type);
      if (block.type === "tool_result") collectContent(block.content);
    }
  };
  if (adapter === "openai") {
    for (const message of value.messages) collectContent(message.content);
  } else if (adapter === "anthropic") {
    collectContent(value.system);
    for (const message of value.messages) collectContent(message.content);
  }
  return [...new Set(types)].sort();
}

function knownBlockTypes(adapter) {
  return adapter === "openai"
    ? new Set(["text", "image_url"])
    : new Set(["text", "thinking", "redacted_thinking", "tool_use", "tool_result"]);
}

function readJson(name) {
  const bytes = fs.readFileSync(path.join(outputDirectory, name));
  if (name.endsWith(".jsonl")) {
    const lines = bytes.toString("utf8").split("\n");
    if (lines.at(-1) !== "") fail(`${name} must end with LF`);
    return { bytes, value: lines.slice(0, -1).filter((line) => line.length > 0).map((line) => JSON.parse(line)) };
  }
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

fs.mkdirSync(outputDirectory, { recursive: true });
const fixtureBytes = new Map();
for (const [name, value] of fixtureValues) {
  const bytes = name.endsWith(".jsonl") ? jsonlBytes(value) : jsonBytes(value);
  fixtureBytes.set(name, bytes);
  fs.writeFileSync(path.join(outputDirectory, name), bytes);
}

const groundTruth = {
  schemaVersion: 1,
  sources,
  files: [...fixtureBytes].map(([name, bytes]) => ({
    name,
    format: name.endsWith(".jsonl") ? "jsonl" : "json",
    byteLength: bytes.length,
    sha256: sha256(bytes)
  })),
  cases
};
const groundTruthBytes = jsonBytes(groundTruth);
fs.writeFileSync(path.join(outputDirectory, "ground-truth.json"), groundTruthBytes);

const expectedFiles = ["ground-truth.json", ...fixtureValues.keys()];
const actualFiles = fs.readdirSync(outputDirectory).filter((name) => !name.startsWith("."));
if (actualFiles.length !== expectedFiles.length || actualFiles.some((name) => !expectedFiles.includes(name))) {
  fail(`unexpected semantic fixture set: ${actualFiles.join(", ")}`);
}

const parsedFixtures = new Map();
for (const [name, bytes] of fixtureBytes) {
  const fixture = readJson(name);
  parsedFixtures.set(name, fixture);
  const manifest = groundTruth.files.find((entry) => entry.name === name);
  const expectedFormat = name.endsWith(".jsonl") ? "jsonl" : "json";
  if (!manifest || manifest.format !== expectedFormat || manifest.byteLength !== bytes.length || manifest.sha256 !== sha256(fixture.bytes)) {
    fail(`${name} manifest/hash does not match`);
  }
  if (!fixture.bytes.equals(bytes)) fail(`${name} is not deterministic`);
}
const truth = readJson("ground-truth.json");
const sourceIds = ["spec-f01", "spec-f02", "spec-f03", "spec-f04", "spec-f05", "spec-f06"];
if (truth.value.schemaVersion !== 1 || !truth.value.sources
  || sourceIds.some((sourceId) => !truth.value.sources[sourceId])) {
  fail("ground truth metadata is invalid");
}
for (const sourceId of sourceIds) {
  const source = truth.value.sources[sourceId];
  if (source.kind !== "spec-derived-synthetic" || !Array.isArray(source.references)
    || source.references.length === 0 || typeof source.note !== "string" || source.note.length === 0) {
    fail(`ground truth source metadata is invalid: ${sourceId}`);
  }
}
if (truth.value.files.length !== fixtureValues.size || truth.value.cases.length !== cases.length) {
  fail("ground truth coverage is incomplete");
}

const ids = new Set();
const pointers = new Set();
const semanticTypes = new Set();
const conversationAdapters = new Set();
for (const item of truth.value.cases) {
  if (ids.has(item.id)) fail(`duplicate ground truth id: ${item.id}`);
  ids.add(item.id);
  const pointerKey = `${item.file}:${item.pointer}`;
  if (pointers.has(pointerKey)) fail(`duplicate ground truth pointer: ${pointerKey}`);
  pointers.add(pointerKey);
  if (!parsedFixtures.has(item.file) || typeof item.source !== "string" || !sourceIds.includes(item.source) || !item.expected
    || (item.kind !== "string" && item.kind !== "conversation" && item.kind !== "eventStream")) {
    fail(`invalid ground truth case: ${item.id}`);
  }
  const target = pointerValue(parsedFixtures.get(item.file).value, item.pointer);
  if (target === undefined || target === null) {
    fail(`missing JSON pointer: ${item.file}${item.pointer}`);
  }
  if (item.kind === "string") {
    if (typeof item.expected.semanticType !== "string" || typeof item.expected.eligible !== "boolean"
      || !Array.isArray(item.expected.features)
      || (item.expected.stopReason !== null && typeof item.expected.stopReason !== "string")) {
      fail(`invalid string case: ${item.id}`);
    }
    semanticTypes.add(item.expected.semanticType);
  } else if (item.kind === "conversation") {
    if ((typeof item.expected.expectedAdapter !== "string" && item.expected.expectedAdapter !== null)
      || typeof item.expected.possibleConversation !== "boolean"
      || item.expected.expectedAdapter !== null && item.expected.possibleConversation
      || !Array.isArray(item.expected.normalizedRoles) || !item.expected.normalizedRoles.every((role) => typeof role === "string")
      || !Array.isArray(item.expected.inputBlockTypes) || !item.expected.inputBlockTypes.every((type) => typeof type === "string")
      || !Array.isArray(item.expected.expectedUnknownBlockPointers) || !item.expected.expectedUnknownBlockPointers.every((pointer) => typeof pointer === "string")
      || !Array.isArray(item.expected.preservePointers)
      || (item.expected.stopReason !== null && typeof item.expected.stopReason !== "string")) {
      fail(`invalid conversation case: ${item.id}`);
    }
    conversationAdapters.add(item.expected.expectedAdapter);
    const fixtureValue = parsedFixtures.get(item.file).value;
    const actualBlockTypes = inputBlockTypes(fixtureValue, item.expected.expectedAdapter);
    const expectedBlockTypes = [...new Set(item.expected.inputBlockTypes)].sort();
    if (actualBlockTypes.join("\n") !== expectedBlockTypes.join("\n")) {
      fail(`input block types do not match: ${item.id}`);
    }
    if (item.expected.expectedAdapter !== null) {
      const knownTypes = knownBlockTypes(item.expected.expectedAdapter);
      for (const unknownPointer of item.expected.expectedUnknownBlockPointers) {
        const block = pointerValue(fixtureValue, unknownPointer);
        if (block === null || typeof block !== "object" || Array.isArray(block)
          || typeof block.type !== "string" || knownTypes.has(block.type)) {
          fail(`unknown block pointer is not an unknown block: ${item.id}${unknownPointer}`);
        }
        const blockSentinels = collectSyntheticUnknownPointers(block, unknownPointer);
        if (blockSentinels.some((pointer) => !item.expected.preservePointers.includes(pointer))) {
          fail(`unknown block sentinel was not preserved: ${item.id}${unknownPointer}`);
        }
      }
    }
    for (const preservePointer of item.expected.preservePointers) {
      if (typeof preservePointer !== "string" || pointerValue(parsedFixtures.get(item.file).value, preservePointer) == null) {
        fail(`missing preserved pointer: ${item.file}${preservePointer}`);
      }
    }
  } else {
    if (typeof item.expected.expectedHint !== "boolean" || !item.expected.metrics
      || !Array.isArray(item.expected.preservePointers)
      || (item.expected.stopReason !== null && typeof item.expected.stopReason !== "string")) {
      fail(`invalid event stream case: ${item.id}`);
    }
    for (const metric of ["T", "P", "G", "R", "S"]) {
      const value = item.expected.metrics[metric];
      const undefinedRatio = metric === "R" && value?.defined === false;
      if (!value || !Number.isInteger(value.numerator) || !Number.isInteger(value.denominator)
        || undefinedRatio && (value.numerator !== 0 || value.denominator !== 0)
        || !undefinedRatio && (value.numerator < 0 || value.denominator <= 0 || value.numerator > value.denominator)) {
        fail(`invalid event metric ${metric}: ${item.id}`);
      }
    }
    for (const preservePointer of item.expected.preservePointers) {
      if (typeof preservePointer !== "string" || pointerValue(parsedFixtures.get(item.file).value, preservePointer) == null) {
        fail(`missing preserved pointer: ${item.file}${preservePointer}`);
      }
    }
  }
}
for (const expected of ["Plain Text", "Markdown", "HTML", "Nested JSON"]) {
  if (!semanticTypes.has(expected)) fail(`missing semantic label: ${expected}`);
}

for (const [name, value] of fixtureValues) {
  const expectedPointers = collectSyntheticUnknownPointers(value);
  const actualPointers = truth.value.cases
    .filter((item) => item.file === name)
    .flatMap((item) => item.expected.preservePointers ?? [])
    .sort();
  if (expectedPointers.join("\n") !== actualPointers.join("\n")) {
    fail(`${name} preservePointers do not exactly cover synthetic_unknown leaves`);
  }
  for (const pointer of expectedPointers) {
    if (pointerValue(parsedFixtures.get(name).value, pointer) == null) fail(`missing sentinel pointer: ${name}${pointer}`);
  }
}

const rich = parsedFixtures.get("rich-strings.json").value;
if (rich.data.length !== 12 || rich.data[5].data !== "```rust\nfn main() {\n    println!(\"hello\");\n}\n```") {
  fail("rich string variants are incomplete");
}
if (!rich.data[6].data.startsWith("<section><h2>") || !rich.data[6].data.endsWith("</section>")) {
  fail("benign HTML fixture is not a complete element");
}
const fencedCase = truth.value.cases.find((item) => item.id === "fenced-rust");
if (fencedCase.expected.semanticType !== "Markdown" || !fencedCase.expected.features.includes("fencedCode")) {
  fail("fenced Rust ground truth is not Markdown");
}

const nested = parsedFixtures.get("nested-json.json").value;
const parsedObject = JSON.parse(nested.data.objectString);
const parsedArray = JSON.parse(nested.data.arrayString);
if (!Array.isArray(parsedObject.array) || parsedObject.enabled !== true || parsedObject.unknown !== "NESTED_UNKNOWN_SENTINEL") {
  fail("nested object string variants are incomplete");
}
if (!Array.isArray(parsedArray) || parsedArray.length !== 3) fail("nested array string is invalid");
function isAutomaticNestedCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}
if (isAutomaticNestedCandidate(nested.data.invalidJsonLooking)
  || Object.values(nested.data.primitiveStrings).some(isAutomaticNestedCandidate)) {
  fail("invalid or primitive nested strings look automatically nested");
}
let depth = 0;
let current = nested.data.deepObjectNextString;
while (true) {
  const value = JSON.parse(current);
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("deep nested chain is not object-shaped");
  depth += 1;
  if (typeof value.next !== "string") break;
  current = value.next;
}
if (depth !== 11) fail(`deep nested chain depth is ${depth}, expected 11`);

const limits = parsedFixtures.get("nested-json-limits.json").value;
if (Buffer.byteLength(limits.data.overLimitString, "utf8") !== 2 * MIB + 1
  || !limits.data.overLimitString.startsWith("{")
  || JSON.parse(limits.data.overLimitString).payload.length <= 0) {
  fail("nested size-limit string is not an exact valid object JSON string");
}
if (limits.data.cumulativeLayerByteLengths.length !== 6
  || limits.data.cumulativeLayerByteLengths.some((size) => size >= 2 * MIB)
  || limits.data.cumulativeLayerByteLengths.reduce((sum, size) => sum + size, 0) <= 8 * MIB) {
  fail("nested cumulative materialization limits are not represented");
}
let cumulativeCurrent = limits.data.cumulativeSixLayerString;
for (let index = 5; index >= 0; index -= 1) {
  const layer = JSON.parse(cumulativeCurrent);
  if (layer === null || typeof layer !== "object" || Array.isArray(layer)
    || typeof layer.next !== "string"
    || Buffer.byteLength(cumulativeCurrent, "utf8") !== limits.data.cumulativeLayerByteLengths[index]) {
    fail("nested cumulative layer is not an object-next JSON string");
  }
  cumulativeCurrent = layer.next;
}
const cumulativeObject = JSON.parse(cumulativeCurrent);
if (cumulativeObject === null || typeof cumulativeObject !== "object" || Array.isArray(cumulativeObject)
  || typeof cumulativeObject.payload !== "string") {
  fail("nested cumulative base object is invalid");
}
if (fixtureBytes.get("nested-json-limits.json").length >= 4 * MIB) fail("nested-json-limits.json exceeds its file-size bound");
const totalBytes = [...fixtureBytes.values()].reduce((sum, bytes) => sum + bytes.length, groundTruthBytes.length);
if (totalBytes >= 6 * MIB) fail("semantic fixture set exceeds its total size bound");

function containsSentinels(value, sentinels) {
  const encoded = JSON.stringify(value);
  return sentinels.every((sentinel) => encoded.includes(sentinel));
}

const openai = parsedFixtures.get("openai-conversation.json").value;
const openaiMessages = openai.messages;
if (openai.model !== "gpt-5.6" || !Array.isArray(openaiMessages)
  || openaiMessages.map((message) => message.role).join(",") !== "system,developer,user,assistant,tool,assistant"
  || typeof openaiMessages[0].content !== "string"
  || !Array.isArray(openaiMessages[2].content)
  || openaiMessages[3].content !== null
  || typeof openaiMessages[3].tool_calls[0].function.arguments !== "string"
  || typeof openaiMessages[3].tool_calls[1].function.arguments !== "object"
  || typeof openaiMessages[4].tool_call_id !== "string"
  || typeof openaiMessages[5].function_call.arguments !== "object"
  || !containsSentinels(openai, [
    "OPENAI_ROOT_UNKNOWN_SENTINEL",
    "OPENAI_SYSTEM_UNKNOWN_SENTINEL",
    "OPENAI_CONTENT_UNKNOWN_SENTINEL",
    "OPENAI_CALL_STRING_UNKNOWN_SENTINEL",
    "OPENAI_FUNCTION_OBJECT_UNKNOWN_SENTINEL"
  ])) {
  fail("OpenAI conversation variants or sentinels are incomplete");
}

function verifyAnthropic(value, systemIsArray) {
  const messages = value.messages;
  const systemValid = systemIsArray
    ? Array.isArray(value.system) && value.system[0]?.type === "text" && value.system[1]?.type === "unknown_block"
    : typeof value.system === "string";
  const blockTypes = messages[1].content.map((block) => block.type);
  const resultBlock = messages[2].content[0];
  return value.model === "claude-3-7-sonnet-latest"
    && value.max_tokens === 512
    && systemValid
    && Array.isArray(messages)
    && messages.map((message) => message.role).join(",") === "user,assistant,user"
    && typeof messages[0].content === "string"
    && Array.isArray(messages[1].content)
    && blockTypes.join(",") === "thinking,redacted_thinking,text,tool_use,unknown_block"
    && resultBlock.type === "tool_result"
    && resultBlock.tool_use_id === "toolu_lookup"
    && resultBlock.is_error === false
    && containsSentinels(value, [
      "ANTHROPIC_ROOT_UNKNOWN_SENTINEL",
      "ANTHROPIC_THINKING_UNKNOWN_SENTINEL",
      "ANTHROPIC_TOOL_USE_UNKNOWN_SENTINEL",
      "ANTHROPIC_UNKNOWN_BLOCK_SENTINEL"
    ]);
}

const anthropicString = parsedFixtures.get("anthropic-system-string.json").value;
const anthropicBlocks = parsedFixtures.get("anthropic-system-blocks.json").value;
if (!verifyAnthropic(anthropicString, false) || !verifyAnthropic(anthropicBlocks, true)) {
  fail("Anthropic system or block variants are incomplete");
}

const genericRole = parsedFixtures.get("generic-role-content.json").value;
const genericFrom = parsedFixtures.get("generic-from-value.json").value;
const genericNon = parsedFixtures.get("generic-non-conversation.json").value;
if (genericRole.conversation.map((item) => item.role).join(",") !== "system,human,gpt,user,model,bot"
  || genericFrom.conversation.map((item) => item.from).join(",") !== "human,gpt,user,model"
  || !Array.isArray(genericNon)
  || genericNon.some((item) => "role" in item || "from" in item)
  || !conversationAdapters.has("openai") || !conversationAdapters.has("anthropic") || !conversationAdapters.has("generic")
  || truth.value.cases.find((item) => item.id === "generic-non-conversation").expected.possibleConversation !== false) {
  fail("Generic conversation variants are incomplete");
}

function thresholdStats(records) {
  const recognizedRoleValues = new Set(["system", "developer", "user", "assistant", "tool", "function", "human", "gpt", "bot", "model"]);
  const matching = records.filter((record) => typeof record.role === "string" && typeof record.content === "string");
  const nonmatching = records.filter((record) => typeof record.speaker === "string" && typeof record.text === "string");
  const roleKeys = records.filter((record) => typeof record.role === "string" || typeof record.from === "string");
  const recognizedRoles = records.filter((record) => {
    const role = typeof record.role === "string" ? record.role : record.from;
    return typeof role === "string" && recognizedRoleValues.has(role);
  });
  const contents = records.filter((record) => typeof record.content === "string"
    || typeof record.value === "string" || "tool_calls" in record || "function_call" in record || typeof record.tool_call_id === "string");
  return {
    objectCount: records.filter((record) => record !== null && typeof record === "object" && !Array.isArray(record)).length,
    matchingCount: matching.length,
    nonmatchingCount: nonmatching.length,
    roleKeys: roleKeys.length,
    recognizedRoles: recognizedRoles.length,
    contents: contents.length
  };
}

for (const [name, expectedMatching] of [["generic-threshold-79.json", 79], ["generic-threshold-80.json", 80]]) {
  const records = parsedFixtures.get(name).value;
  const stats = thresholdStats(records);
  if (!Array.isArray(records) || records.length !== 100 || stats.objectCount !== 100
    || stats.matchingCount !== expectedMatching || stats.nonmatchingCount !== 100 - expectedMatching) {
    fail(`${name} does not have the exact Generic threshold proportions`);
  }
  if (records.some((record) => !((typeof record.role === "string" && typeof record.content === "string")
    || (typeof record.speaker === "string" && typeof record.text === "string")))) {
    fail(`${name} contains an unexpected threshold row shape`);
  }
  const thresholdCase = truth.value.cases.find((item) => item.id === name.replace(".json", ""));
  const ratios = thresholdCase.expected.ratios;
  for (const [ratio, numerator] of [["objects", stats.objectCount], ["roleKeys", stats.roleKeys], ["recognizedRoles", stats.recognizedRoles], ["contents", stats.contents]]) {
    if (!ratios || ratios[ratio].numerator !== numerator || ratios[ratio].denominator !== 100) {
      fail(`${name} ground truth ratio ${ratio} is incorrect`);
    }
  }
}
const threshold79Case = truth.value.cases.find((item) => item.id === "generic-threshold-79");
const threshold80Case = truth.value.cases.find((item) => item.id === "generic-threshold-80");
if (threshold79Case.expected.expectedAdapter !== null || threshold79Case.expected.possibleConversation !== true
  || threshold80Case.expected.expectedAdapter !== "generic" || threshold80Case.expected.possibleConversation !== false) {
  fail("Generic threshold ground truth is incorrect");
}

function eventStats(records) {
  const groupingKeys = ["session_id", "sessionId", "trace_id", "traceId", "run_id", "runId", "conversation_id", "conversationId", "request_id", "requestId", "case_id", "caseId"];
  const sequenceKeys = ["seq", "sequence", "step", "step_index", "index"];
  const hasKey = (record, keys) => keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
  const groupingRecords = records.filter((record) => hasKey(record, groupingKeys));
  const groupingValueCounts = new Map();
  for (const record of groupingRecords) {
    for (const key of groupingKeys) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const value = `${key}:${JSON.stringify(record[key])}`;
      groupingValueCounts.set(value, (groupingValueCounts.get(value) ?? 0) + 1);
    }
  }
  const repeatedGroupingRecords = groupingRecords.filter((record) => groupingKeys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return false;
    return groupingValueCounts.get(`${key}:${JSON.stringify(record[key])}`) >= 2;
  })).length;
  return {
    eventTypes: records.filter((record) => hasKey(record, eventTypeKeys)).length,
    timestamps: records.filter((record) => hasKey(record, timestampKeys)).length,
    groupings: groupingRecords.length,
    repeatedGroupingRecords,
    sequences: records.filter((record) => hasKey(record, sequenceKeys)).length
  };
}

function verifyEventFixture(name, expected, trainingOnly = false) {
  const fixture = parsedFixtures.get(name);
  const records = fixture.value;
  const lines = fixture.bytes.toString("utf8").split("\n");
  if (!Array.isArray(records) || records.length !== 10 || !fixture.bytes.toString("utf8").endsWith("\n")
    || fixture.bytes.includes(0x0d) || lines.at(-1) !== "" || lines.slice(0, -1).some((line, index) => {
      if (line.length === 0 || JSON.stringify(records[index]) !== line) return true;
      return false;
    })) {
    fail(`${name} is not compact LF-terminated JSONL`);
  }
  if (records.some((record) => record === null || typeof record !== "object" || Array.isArray(record))) {
    fail(`${name} contains a non-object event record`);
  }
  if (trainingOnly && records.some((record) => record.type !== "training_sample")) {
    fail(`${name} is not training_sample-only`);
  }
  const stats = eventStats(records);
  if (stats.eventTypes !== expected.T || stats.timestamps !== expected.P
    || stats.groupings !== expected.G || stats.sequences !== expected.S) {
    fail(`${name} event metrics are not exact`);
  }
  const eventCase = truth.value.cases.find((item) => item.id === name.replace(".jsonl", ""));
  if (!eventCase || eventCase.expected.expectedHint !== expected.hint) fail(`${name} event hint ground truth is incorrect`);
  for (const metric of ["T", "P", "G", "R", "S"]) {
    const metricValue = eventCase.expected.metrics[metric];
    if (metric === "R" && expected.metrics.R.defined === false) {
      if (stats.groupings !== 0 || stats.repeatedGroupingRecords !== 0
        || metricValue.numerator !== 0 || metricValue.denominator !== 0 || metricValue.defined !== false) {
        fail(`${name} ground truth metric ${metric} is incorrect`);
      }
    } else if (metricValue.numerator !== expected.metrics[metric][0] || metricValue.denominator !== 10) {
      fail(`${name} ground truth metric ${metric} is incorrect`);
    }
  }
}

verifyEventFixture("event-stream-positive.jsonl", {
  T: 7,
  P: 4,
  G: 0,
  S: 0,
  hint: true,
  metrics: { T: [7, 10], P: [4, 10], G: [0, 10], R: { numerator: 0, denominator: 0, defined: false }, S: [0, 10] }
});
verifyEventFixture("event-stream-training-negative.jsonl", {
  T: 10,
  P: 0,
  G: 0,
  S: 0,
  hint: false,
  metrics: { T: [10, 10], P: [0, 10], G: [0, 10], R: { numerator: 0, denominator: 0, defined: false }, S: [0, 10] }
}, true);
if (eventTypeKeys.some((key) => !eventStreamPositive.slice(0, 7).some((record) => key in record))) {
  fail("positive event fixture does not cover event type aliases");
}
if (timestampKeys.some((key) => !eventStreamPositive.slice(0, 4).some((record) => key in record))) {
  fail("positive event fixture does not cover timestamp aliases");
}

if (!jsonBytes(truth.value).equals(truth.bytes)) fail("ground truth JSON formatting is not deterministic");

for (const [name, bytes] of fixtureBytes) console.log(`${name}: ${bytes.length} bytes`);
console.log(`ground-truth.json: ${groundTruthBytes.length} bytes`);
console.log(`semantic fixture verification: PASS (${totalBytes} bytes total)`);
