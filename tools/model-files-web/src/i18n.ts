export type Locale = 'zh-Hans' | 'en'

export const messageCatalog = {
  summaryModelConfigTitle: {
    'zh-Hans': '模型配置',
    en: 'Model configuration',
  },
  summaryModelScale: {
    'zh-Hans': '模型规模',
    en: 'Model scale',
  },
  summaryHiddenSize: {
    'zh-Hans': '隐藏层维度（hidden_size）',
    en: 'Hidden size (hidden_size)',
  },
  summaryIntermediateSize: {
    'zh-Hans': '中间层维度（intermediate_size）',
    en: 'Intermediate size (intermediate_size)',
  },
  summaryVocabSize: {
    'zh-Hans': '词表大小（vocab_size）',
    en: 'Vocabulary size (vocab_size)',
  },
  summaryAttentionHeads: {
    'zh-Hans': '注意力头数（num_attention_heads）',
    en: 'Attention heads (num_attention_heads)',
  },
  summaryKeyValueHeads: {
    'zh-Hans': 'KV 头数（num_key_value_heads）',
    en: 'KV heads (num_key_value_heads)',
  },
  summaryHeadDim: {
    'zh-Hans': '头维度（head_dim）',
    en: 'Head dimension (head_dim)',
  },
  summaryContext: {
    'zh-Hans': '上下文',
    en: 'Context',
  },
  summaryMaxPositions: {
    'zh-Hans': '最大上下文长度（max_position_embeddings）',
    en: 'Maximum context length (max_position_embeddings)',
  },
  summaryRopeTheta: {
    'zh-Hans': 'RoPE θ（rope_theta）',
    en: 'RoPE θ (rope_theta)',
  },
  summaryGenerationTitle: {
    'zh-Hans': '生成默认值',
    en: 'Generation defaults',
  },
  summaryGenerationSubtitle: {
    'zh-Hans': '推理框架在调用 generate 时使用的模型目录默认参数。',
    en: 'Defaults from the model folder that inference frameworks use when calling generate.',
  },
  summarySampling: {
    'zh-Hans': '采样',
    en: 'Sampling',
  },
  summaryStopAndLength: {
    'zh-Hans': '终止与长度',
    en: 'Stopping and length',
  },
  summaryMaxNewTokens: {
    'zh-Hans': '最大新 token',
    en: 'Max new tokens',
  },
  summaryRepetitionPenalty: {
    'zh-Hans': '重复惩罚',
    en: 'Repetition penalty',
  },
  summaryTokenizerConfigTitle: {
    'zh-Hans': 'Tokenizer 配置',
    en: 'Tokenizer configuration',
  },
  summaryTokenizerConfigSubtitle: {
    'zh-Hans': '特殊 token、最大长度，以及随模型发布的对话格式。',
    en: 'Special tokens, maximum length, and the chat format shipped with the model.',
  },
  summaryCoreSettings: {
    'zh-Hans': '核心设置',
    en: 'Core settings',
  },
  summaryMaxLength: {
    'zh-Hans': '最大长度',
    en: 'Maximum length',
  },
  summaryWeightIndexTitle: {
    'zh-Hans': '权重分片索引',
    en: 'Weight shard index',
  },
  summaryWeightIndexSubtitle: {
    'zh-Hans': '只读取映射关系，不读取任何权重分片。',
    en: 'Reads only the mapping, never any weight shard.',
  },
  summaryOverview: {
    'zh-Hans': '概览',
    en: 'Overview',
  },
  summaryParameterTensors: {
    'zh-Hans': '参数张量',
    en: 'Parameter tensors',
  },
  summaryShardCount: {
    'zh-Hans': '分片数量',
    en: 'Shard count',
  },
  summaryTotalWeightSize: {
    'zh-Hans': '权重总大小',
    en: 'Total weight size',
  },
  summaryFirstMappings: {
    'zh-Hans': '前 80 条映射',
    en: 'First 80 mappings',
  },
  summaryVocabTitle: {
    'zh-Hans': '词表',
    en: 'Vocabulary',
  },
  summaryVocabSubtitle: {
    'zh-Hans': '共 {count} 个 token；列表最多展示当前筛选结果的前 1,000 项。',
    en: '{count} tokens in total; the list shows at most the first 1,000 matches.',
  },
  summaryVocabSearch: {
    'zh-Hans': '搜索 token 或 ID',
    en: 'Search tokens or IDs',
  },
  appWeightsPreviewable: {
    'zh-Hans': '{count}/{total} 可预览',
    en: '{count}/{total} previewable',
  },
  appNoteEmbeddedChatTemplate: {
    'zh-Hans': '含内嵌 Chat Template（如有）',
    en: 'Includes the embedded chat template (if any)',
  },
  appNoteSafeTensors: {
    'zh-Hans': '只读取 JSON Header',
    en: 'Reads only the JSON header',
  },
  appNoteGGUF: {
    'zh-Hans': '只读取 metadata 前缀',
    en: 'Reads only the metadata prefix',
  },
  appNoteLocked: {
    'zh-Hans': '不可预览',
    en: 'Not previewable',
  },
  appUnableToOpenLocationTitle: {
    'zh-Hans': '无法打开位置',
    en: 'Unable to open location',
  },
  appNoModelOpenTitle: {
    'zh-Hans': '尚未打开模型',
    en: 'No model open',
  },
  appNoModelOpenMessage: {
    'zh-Hans': '输入模型 ID 或 HTTPS 地址，或选择本地目录后打开。',
    en: 'Enter a model ID or HTTPS address, or choose a local folder, then open it.',
  },
  appNoMatchingFilesTitle: {
    'zh-Hans': '没有匹配文件',
    en: 'No matching files',
  },
  appNoMatchingFilesMessage: {
    'zh-Hans': '换个关键词，或清除当前筛选。',
    en: 'Try another keyword, or clear the filter.',
  },
  appClearFilterAction: {
    'zh-Hans': '清除筛选',
    en: 'Clear filter',
  },
  appSourceGeneric: {
    'zh-Hans': '来源',
    en: 'Source',
  },
  appLoadingSafeTensors: {
    'zh-Hans': '正在读取 SafeTensors Header…',
    en: 'Reading SafeTensors header…',
  },
  appLoadingGGUF: {
    'zh-Hans': '正在读取 GGUF metadata 前缀…',
    en: 'Reading GGUF metadata prefix…',
  },
  appLoadingImatrix: {
    'zh-Hans': '正在读取 Imatrix 数据…',
    en: 'Reading Imatrix data…',
  },
  appLoadingJinja: {
    'zh-Hans': '正在读取 Jinja 源码…',
    en: 'Reading Jinja source…',
  },
  appLoadingPdf: {
    'zh-Hans': '正在读取 PDF 文档…',
    en: 'Reading PDF document…',
  },
  appLoadingImage: {
    'zh-Hans': '正在读取图片…',
    en: 'Reading image…',
  },
  appHeaderCopyPathHelp: {
    'zh-Hans': '复制文件路径',
    en: 'Copy file path',
  },
  appHeaderCopyFullPathHelp: {
    'zh-Hans': '复制文件完整路径或 URL',
    en: 'Copy the file’s full path or URL',
  },
  appHeaderOpenSourceHelp: {
    'zh-Hans': '在浏览器中打开当前版本',
    en: 'Open this version in the browser',
  },
  appPurposeConfiguration: {
    'zh-Hans': '模型配置',
    en: 'Model configuration',
  },
  appPurposeTokenizer: {
    'zh-Hans': '分词器资源',
    en: 'Tokenizer resource',
  },
  appPurposeTemplates: {
    'zh-Hans': '对话模板',
    en: 'Chat template',
  },
  appPurposeWeightIndex: {
    'zh-Hans': '权重分片索引',
    en: 'Weight shard index',
  },
  appPurposeDocumentation: {
    'zh-Hans': '模型文档',
    en: 'Model documentation',
  },
  appPurposeOther: {
    'zh-Hans': '模型文件',
    en: 'Model file',
  },
  appPurposeSafeTensors: {
    'zh-Hans': 'SafeTensors 权重结构',
    en: 'SafeTensors weight structure',
  },
  appPurposeGGUF: {
    'zh-Hans': 'GGUF 模型结构',
    en: 'GGUF model structure',
  },
  appPurposeLockedWeights: {
    'zh-Hans': '模型权重（禁止加载）',
    en: 'Model weights (not loaded)',
  },
  appSourceLocal: {
    'zh-Hans': '本地',
    en: 'Local',
  },
  appLiveDirectoryStatus: {
    'zh-Hans': '实时目录',
    en: 'Live folder',
  },
  appLiveSourceStatus: {
    'zh-Hans': '实时来源',
    en: 'Live source',
  },
  byteCountZero: {
    'zh-Hans': '0 KB',
    en: 'Zero KB',
  },
  byteCountOne: {
    'zh-Hans': '{count} 字节',
    en: '{count} byte',
  },
  byteCountMany: {
    'zh-Hans': '{count} 字节',
    en: '{count} bytes',
  },
  appHttpsFileHint: {
    'zh-Hans': '文件模式需要 HEAD 返回 Content-Length；不会自动寻找相邻配置或词表。',
    en: 'File mode needs HEAD with Content-Length; adjacent configs and vocabularies are not discovered automatically.',
  },
  appHttpsManifestHint: {
    'zh-Hans': '清单不超过 1 MiB；size 是文件实际字节数，url 可相对于清单地址。仅访问清单列出的文件，不扫描目录。',
    en: 'Manifest limit: 1 MiB. size is the exact byte count; url can be relative to the manifest URL. Only listed files are accessed; directories are not scanned.',
  },
  appHttpsHint: {
    'zh-Hans': '直接打开一个文件，或用 JSON 清单打开多个关联文件。服务器必须允许跨域读取；权重检查还需要精确 Range。地址仅保留在当前会话，刷新后需重新打开。',
    en: 'Open one file directly, or related files with a JSON manifest. The server must allow cross-origin reads; weight inspection also requires exact ranges. URLs stay in this session; reopen after refreshing.',
  },
  appHttpsHelp: {
    'zh-Hans': '使用说明',
    en: 'Loading help',
  },
  appHttpsUrlLabel: {
    'zh-Hans': 'HTTPS 地址',
    en: 'HTTPS URL',
  },
  appHttpsManifest: {
    'zh-Hans': 'HTTPS 清单',
    en: 'HTTPS manifest',
  },
  appHttpsFile: {
    'zh-Hans': 'HTTPS 文件',
    en: 'HTTPS file',
  },
  appSourceLabel: {
    'zh-Hans': '加载方式',
    en: 'Source',
  },
  httpsFetchFailed: {
    'zh-Hans': 'HTTPS 请求失败：请检查地址、网络和服务端 CORS 许可；本页不会使用代理。',
    en: 'HTTPS request failed. Check the URL, network and server CORS permissions; this page does not use a proxy.',
  },
  httpsManifestInvalid: {
    'zh-Hans': '清单必须包含 1–10,000 个 files 条目，每项包含 path、url 和非负整数 size（字节）。',
    en: 'A manifest needs 1–10,000 files, each with path, url and a non-negative integer size in bytes.',
  },
  httpsManifestJsonRequired: {
    'zh-Hans': '清单地址必须指向 .json 文件。模型文件请使用“HTTPS 文件”模式。',
    en: 'The manifest URL must point to a .json file. Use HTTPS file mode for model files.',
  },
  httpsHeadSizeRequired: {
    'zh-Hans': '无法通过 HEAD 获取有效的 Content-Length。请使用提供文件字节大小的 HTTPS 清单。',
    en: 'HEAD did not return a valid Content-Length. Use an HTTPS manifest with file sizes in bytes.',
  },
  httpsUrlRequired: {
    'zh-Hans': '请输入不含用户名和密码的 HTTPS 地址。',
    en: 'Enter an HTTPS URL without a username or password.',
  },
  greeting: {
    'zh-Hans': '你好，{name}',
    en: 'Hello, {name}',
  },
  fileCount: {
    'zh-Hans': '{count} 个文件',
    en: '{count} files',
  },
  chatTemplateUnsupportedObjectValue: {
    'zh-Hans': 'chat_template 不支持的形态：对象值必须是字符串。',
    en: 'Unsupported chat_template shape: object values must be strings.',
  },
  chatTemplateNamedItemInvalidShape: {
    'zh-Hans': 'chat_template 的第 {index} 个 named 条目无效：必须是包含 name 和 template 的对象。',
    en: 'Invalid named chat_template item at index {index}: expected an object containing name and template.',
  },
  chatTemplateNamedItemInvalidName: {
    'zh-Hans': 'chat_template 的第 {index} 个 named 条目无效：name 必须是非空字符串。',
    en: 'Invalid named chat_template item at index {index}: name must be a non-empty string.',
  },
  chatTemplateNamedItemInvalidTemplate: {
    'zh-Hans': 'chat_template 的第 {index} 个 named 条目无效：template 必须是字符串。',
    en: 'Invalid named chat_template item at index {index}: template must be a string.',
  },
  chatTemplateUnsupportedValue: {
    'zh-Hans': 'chat_template 不支持的形态：null、数字或布尔值。支持字符串、对象字典或 named 数组。',
    en: 'Unsupported chat_template shape: null, number, or boolean. Supported forms are a string, an object map, or a named array.',
  },
  invalidUtf8Text: {
    'zh-Hans': '文本不是有效的 UTF-8。',
    en: 'Text is not valid UTF-8.',
  },
  textContainsNulByte: {
    'zh-Hans': '文本包含 NUL 字节。',
    en: 'Text contains a NUL byte.',
  },
  invalidPdfSignature: {
    'zh-Hans': '不是有效的 PDF 文件签名。',
    en: 'Not a valid PDF file signature.',
  },
  metadataFieldCountLabel: {
    'zh-Hans': 'Metadata 字段',
    en: 'Metadata fields',
  },
  messagesMustBeJsonArray: {
    'zh-Hans': 'Messages 必须是 JSON 数组。',
    en: 'Messages must be a JSON array.',
  },
  chatMessageInvalidShape: {
    'zh-Hans': '第 {index} 项必须是非数组对象，且 role 是字符串、content 存在。',
    en: 'Item {index} must be a non-array object whose role is a string and whose content exists.',
  },
  chatContentNotSerializable: {
    'zh-Hans': '第 {index} 项 content 不可序列化为 JSON。',
    en: 'Content of item {index} cannot be serialized as JSON.',
  },
  toolsMustBeJsonArray: {
    'zh-Hans': 'Tools 必须是 JSON 数组。',
    en: 'Tools must be a JSON array.',
  },
  typedVariablesMustBeJsonObject: {
    'zh-Hans': 'Typed Variables 必须是 JSON 对象。',
    en: 'Typed Variables must be a JSON object.',
  },
  typedVariablesReservedKey: {
    'zh-Hans': 'Typed Variables 不能使用保留键：{key}。',
    en: 'Typed Variables cannot use the reserved key: {key}.',
  },
  tokenOverheadCountInvalid: {
    'zh-Hans': 'Token overhead count 必须是非负安全整数。',
    en: 'A Token overhead count must be a non-negative safe integer.',
  },
  jsonRootNotObject: {
    'zh-Hans': 'JSON 根节点不是对象。',
    en: 'The JSON root is not an object.',
  },
  consistencyChecking: {
    'zh-Hans': '检查中',
    en: 'Checking',
  },
  consistencyWarningCount: {
    'zh-Hans': '{count} 项警告',
    en: '{count} warnings',
  },
  consistencyConsistent: {
    'zh-Hans': '一致',
    en: 'Consistent',
  },
  consistencyInsufficientMaterials: {
    'zh-Hans': '材料不足',
    en: 'Insufficient materials',
  },
  vocabularyMismatchTitle: {
    'zh-Hans': '词表大小不一致',
    en: 'Vocabulary sizes do not match',
  },
  vocabularyMismatchDetail: {
    'zh-Hans': 'config.json 与 tokenizer.json 的词表项数不同。',
    en: 'The vocabulary counts in config.json and tokenizer.json differ.',
  },
  missingTokenizerClassTitle: {
    'zh-Hans': '缺少 tokenizer_class',
    en: 'tokenizer_class is missing',
  },
  missingTokenizerClassDetail: {
    'zh-Hans': '严格 tokenizer runtime 无法在未显式指定 class 时构造。',
    en: 'A strict tokenizer runtime cannot be constructed without an explicit class.',
  },
  statusRead: {
    'zh-Hans': '已读取',
    en: 'Read',
  },
  statusMissing: {
    'zh-Hans': '缺失',
    en: 'Missing',
  },
  missingChatTemplateTitle: {
    'zh-Hans': '缺少可用 Chat Template',
    en: 'No usable chat template',
  },
  missingChatTemplateDetail: {
    'zh-Hans': '仓库中没有可用的独立或内嵌 Chat Template。',
    en: 'The repository has no usable standalone or embedded chat template.',
  },
  ggufPrefixTooShort: {
    'zh-Hans': 'GGUF 前缀不足。',
    en: 'The GGUF prefix is too short.',
  },
  ggufCountExceeded: {
    'zh-Hans': 'GGUF 计数超过安全上限。',
    en: 'The GGUF count exceeds the safety limit.',
  },
  safeTensorsPrefixLengthInvalid: {
    'zh-Hans': 'SafeTensors 长度前缀必须为 8 bytes。',
    en: 'The SafeTensors length prefix must be 8 bytes.',
  },
  safeTensorsHeaderLengthInvalid: {
    'zh-Hans': 'SafeTensors Header 长度无效或超过安全上限。',
    en: 'The SafeTensors header length is invalid or exceeds the safety limit.',
  },
  safeTensorsRootNotObject: {
    'zh-Hans': 'SafeTensors header 根节点不是对象。',
    en: 'The SafeTensors header root is not an object.',
  },
  safeTensorsMetadataNotStringDictionary: {
    'zh-Hans': 'SafeTensors __metadata__ 必须是字符串字典。',
    en: 'SafeTensors __metadata__ must be a string dictionary.',
  },
  safeTensorsTensorShapeInvalid: {
    'zh-Hans': 'SafeTensors tensor {name} 的结构无效。',
    en: 'The structure of SafeTensors tensor {name} is invalid.',
  },
  safeTensorsDtypeUnsupported: {
    'zh-Hans': 'SafeTensors tensor {name} 的 dtype {dtype} 不受支持。',
    en: 'The dtype {dtype} of SafeTensors tensor {name} is unsupported.',
  },
  safeTensorsTensorOffsetsInvalid: {
    'zh-Hans': 'SafeTensors tensor {name} 的 data_offsets 无效。',
    en: 'The data_offsets of SafeTensors tensor {name} are invalid.',
  },
  safeTensorsShapeOverflow: {
    'zh-Hans': 'SafeTensors tensor {name} 的 shape 溢出。',
    en: 'The shape of SafeTensors tensor {name} overflows.',
  },
  safeTensorsByteAlignmentInvalid: {
    'zh-Hans': 'SafeTensors tensor {name} 的 dtype 无法按完整字节对齐。',
    en: 'The dtype of SafeTensors tensor {name} cannot be aligned to complete bytes.',
  },
  safeTensorsTensorLayoutMismatch: {
    'zh-Hans': 'SafeTensors tensor {name} 的 shape、dtype 与 data_offsets 不匹配。',
    en: 'The shape, dtype, and data_offsets of SafeTensors tensor {name} do not match.',
  },
  safeTensorsParameterTotalOverflow: {
    'zh-Hans': 'SafeTensors 参数汇总值溢出。',
    en: 'The SafeTensors parameter total overflows.',
  },
  safeTensorsTensorOffsetsNonContiguous: {
    'zh-Hans': 'SafeTensors tensor {name} 的 data_offsets 不连续。',
    en: 'The data_offsets of SafeTensors tensor {name} are not contiguous.',
  },
  safeTensorsDataSizeMismatch: {
    'zh-Hans': 'SafeTensors 数据区大小无效：Header 索引 {actual} bytes，文件包含 {expected} bytes。',
    en: 'The SafeTensors data size is invalid: the header declares {actual} bytes; the file contains {expected} bytes.',
  },
  statusNotFound: {
    'zh-Hans': '未发现',
    en: 'Not found',
  },
  statusUnavailable: {
    'zh-Hans': '不可用',
    en: 'Unavailable',
  },
  eosMismatchTitle: {
    'zh-Hans': 'EOS Token 不一致',
    en: 'EOS tokens do not match',
  },
  eosMismatchDetail: {
    'zh-Hans': 'generation_config 与 tokenizer 的可靠 EOS ID 不同。',
    en: 'generation_config and tokenizer report different reliable EOS IDs.',
  },
  contextLengthMismatchTitle: {
    'zh-Hans': '上下文长度声明不同',
    en: 'Context length declarations differ',
  },
  contextLengthMismatchDetail: {
    'zh-Hans': '模型与 tokenizer 的长度上限经常承担不同语义，请人工确认。',
    en: 'Model and tokenizer length limits often carry different semantics; review them manually.',
  },
  missingModelConfigTitle: {
    'zh-Hans': '缺少模型配置',
    en: 'Model configuration is missing',
  },
  currentRepository: {
    'zh-Hans': '当前仓库',
    en: 'Current repository',
  },
  missingConfigDetail: {
    'zh-Hans': '仓库中没有 config.json 或 configuration.json。',
    en: 'The repository has no config.json or configuration.json.',
  },
  ggufWebSkippedReason: {
    'zh-Hans': 'Web 仅读取 24-byte prefix，缺少 metadata/tensor directory。',
    en: 'The web reads only the 24-byte prefix and lacks metadata/tensor directories.',
  },
  ggufParseFailed: {
    'zh-Hans': 'GGUF 解析失败：{reason}',
    en: 'GGUF parsing failed: {reason}',
  },
  ggufMagicInvalid: {
    'zh-Hans': 'GGUF magic 无效。',
    en: 'The GGUF magic is invalid.',
  },
  ggufVersionUnsupported: {
    'zh-Hans': '不支持的 GGUF 版本。',
    en: 'The GGUF version is unsupported.',
  },
  ggufTensorCountExceeded: {
    'zh-Hans': 'GGUF tensor 数量超过安全上限。',
    en: 'The GGUF tensor count exceeds the safety limit.',
  },
  ggufMetadataCountExceeded: {
    'zh-Hans': 'GGUF metadata 数量超过安全上限。',
    en: 'The GGUF metadata count exceeds the safety limit.',
  },
  ggufMetadataKeyInvalidOrDuplicate: {
    'zh-Hans': 'GGUF metadata key 无效或重复。',
    en: 'The GGUF metadata key is invalid or duplicated.',
  },
  ggufAlignmentInvalid: {
    'zh-Hans': 'GGUF general.alignment 无效。',
    en: 'The GGUF general.alignment is invalid.',
  },
  ggufTensorNameInvalidOrDuplicate: {
    'zh-Hans': 'GGUF tensor 名称无效或重复。',
    en: 'The GGUF tensor name is invalid or duplicated.',
  },
  ggufTensorDimensionCountExceeded: {
    'zh-Hans': 'GGUF tensor {name} 的维数超过安全上限。',
    en: 'The GGUF tensor {name} dimension count exceeds the safety limit.',
  },
  ggufTensorOffsetMisaligned: {
    'zh-Hans': 'GGUF tensor {name} 的 offset 未按 alignment 对齐。',
    en: 'The GGUF tensor {name} offset is not aligned to alignment.',
  },
  ggufShapeOverflow: {
    'zh-Hans': 'GGUF {context} 溢出。',
    en: 'The GGUF {context} overflows.',
  },
  ggufParameterTotalOverflowContext: {
    'zh-Hans': '参数总数',
    en: 'parameter total',
  },
  ggufTensorDataOffsetOverflow: {
    'zh-Hans': 'GGUF tensor data offset 溢出。',
    en: 'The GGUF tensor data offset overflows.',
  },
  ggufTensorShapeContext: {
    'zh-Hans': 'tensor {name} shape',
    en: 'tensor {name} shape',
  },
  ggufStringLimitExceeded: {
    'zh-Hans': 'GGUF 字符串超过安全上限。',
    en: 'The GGUF string exceeds the safety limit.',
  },
  ggufStringUtf8Invalid: {
    'zh-Hans': 'GGUF 字符串不是有效 UTF-8。',
    en: 'The GGUF string is not valid UTF-8.',
  },
  ggufV1MetadataTypeUnsupported: {
    'zh-Hans': 'GGUF v1 包含不支持的 metadata 类型 {typeCode}。',
    en: 'GGUF v1 contains unsupported metadata type {typeCode}.',
  },
  ggufBoolValueInvalid: {
    'zh-Hans': 'GGUF bool 值必须为 0 或 1。',
    en: 'A GGUF bool value must be 0 or 1.',
  },
  ggufArrayDepthExceeded: {
    'zh-Hans': 'GGUF metadata array 嵌套超过安全上限。',
    en: 'The GGUF metadata array nesting exceeds the safety limit.',
  },
  ggufArrayElementTypeInvalid: {
    'zh-Hans': 'GGUF metadata array 类型无效。',
    en: 'The GGUF metadata array type is invalid.',
  },
  ggufArrayElementCountExceeded: {
    'zh-Hans': 'GGUF metadata array 元素数量超过安全上限。',
    en: 'The GGUF metadata array element count exceeds the safety limit.',
  },
  ggufArrayPreviewDisplay: {
    'zh-Hans': '[{preview}] · {count} 项',
    en: '[{preview}] · {count} items',
  },
  ggufMetadataTypeInvalid: {
    'zh-Hans': 'GGUF metadata 类型 {typeCode} 无效。',
    en: 'The GGUF metadata type {typeCode} is invalid.',
  },
  imatrixFileTooLarge: {
    'zh-Hans': 'Imatrix 文件超过 {limit} 上限。',
    en: 'The Imatrix file exceeds the {limit} limit.',
  },
  imatrixEntryCountInvalid: {
    'zh-Hans': 'Imatrix 条目数量无效或超过安全上限。',
    en: 'The Imatrix entry count is invalid or exceeds the safety limit.',
  },
  imatrixTensorNameInvalid: {
    'zh-Hans': 'Imatrix tensor 名称无效或重复。',
    en: 'The Imatrix tensor name is invalid or duplicated.',
  },
  imatrixCountsInvalid: {
    'zh-Hans': 'Imatrix {name} 的计数无效或超过安全上限。',
    en: 'The Imatrix counts for {name} are invalid or exceed the safety limit.',
  },
  imatrixNonFiniteValues: {
    'zh-Hans': 'Imatrix {name} 包含非有限数值。',
    en: 'The Imatrix values for {name} include non-finite numbers.',
  },
  imatrixChunkCountInvalid: {
    'zh-Hans': 'Imatrix chunk 数量无效。',
    en: 'The Imatrix chunk count is invalid.',
  },
  imatrixDatasetLengthInvalid: {
    'zh-Hans': 'Imatrix dataset 长度无效。',
    en: 'The Imatrix dataset length is invalid.',
  },
  imatrixDatasetInvalid: {
    'zh-Hans': 'Imatrix dataset 无效。',
    en: 'The Imatrix dataset is invalid.',
  },
  imatrixUtf8Invalid: {
    'zh-Hans': 'Imatrix tensor 名称或 dataset 不是有效 UTF-8。',
    en: 'The Imatrix tensor name or dataset is not valid UTF-8.',
  },
  imatrixFileTruncated: {
    'zh-Hans': 'Imatrix 文件提前结束。',
    en: 'The Imatrix file ends prematurely.',
  },
  huggingfaceModelIdRequired: {
    'zh-Hans': '请输入 owner/model 或公开 Hugging Face 仓库 URL。',
    en: 'Enter owner/model or a public Hugging Face repository URL.',
  },
  huggingfaceManifestRequestFailed: {
    'zh-Hans': 'Hugging Face 清单请求失败：HTTP {status}',
    en: 'The Hugging Face manifest request failed: HTTP {status}',
  },
  huggingfaceManifestInvalid: {
    'zh-Hans': 'Hugging Face 清单格式无效。',
    en: 'The Hugging Face manifest is invalid.',
  },
  localDirectoryFileLimitExceeded: {
    'zh-Hans': '本地目录超过 {limit} 个文件上限。',
    en: 'The local directory exceeds the {limit}-file limit.',
  },
  localDirectoryNotSelected: {
    'zh-Hans': '没有选择本地目录。',
    en: 'No local directory is selected.',
  },
  localDirectoryMultipleRoots: {
    'zh-Hans': '本地目录清单包含多个根目录。',
    en: 'The local directory contains multiple root directories.',
  },
  localFilePathTooLarge: {
    'zh-Hans': '本地文件路径超过 {limit} 上限。',
    en: 'The local file path exceeds the {limit} limit.',
  },
  localFileSizeInvalid: {
    'zh-Hans': '本地文件大小无效。',
    en: 'The local file size is invalid.',
  },
  duplicateRepositoryPath: {
    'zh-Hans': '本地目录包含重复路径：{path}',
    en: 'The local directory contains the duplicate path: {path}',
  },
  fileSizeUnavailableForWholeRead: {
    'zh-Hans': '来源没有提供文件大小，已拒绝全文读取。',
    en: 'The source does not provide a file size; whole-file reading is refused.',
  },
  wholeFileLimitExceeded: {
    'zh-Hans': '文件超过 {limit} 阅读上限。',
    en: 'The file exceeds the {limit} reading limit.',
  },
  responseOverLimit: {
    'zh-Hans': '响应超过 {limit} 阅读上限。',
    en: 'The response exceeds the {limit} reading limit.',
  },
  wholeFileSizeMismatch: {
    'zh-Hans': '文件响应字节数为 {actual}，与声明的 {expected} 不一致。',
    en: 'The file response has {actual} bytes, which differs from the declared {expected}.',
  },
  changedLocalFile: {
    'zh-Hans': '本地文件已变化，请重新选择目录。',
    en: 'The local file has changed; select the directory again.',
  },
  fileRequestFailed: {
    'zh-Hans': '文件请求失败：HTTP {status}',
    en: 'The file request failed: HTTP {status}',
  },
  rangeInvalid: {
    'zh-Hans': 'Range 无效。',
    en: 'The Range is invalid.',
  },
  fileSizeUnavailableForRangeRead: {
    'zh-Hans': '来源没有提供文件大小，已拒绝 Range 读取。',
    en: 'The source does not provide a file size; Range reading is refused.',
  },
  rangeExceedsDeclaredSize: {
    'zh-Hans': 'Range 超过来源声明的文件大小。',
    en: 'The Range exceeds the file size declared by the source.',
  },
  rangeShortRead: {
    'zh-Hans': 'Range 短读：期望 {expected}，收到 {actual} bytes。',
    en: 'Short Range read: expected {expected}, received {actual} bytes.',
  },
  rangeNotConfirmed: {
    'zh-Hans': '源站未确认 Range（HTTP {status}），已停止以避免完整下载。',
    en: 'The origin did not confirm the Range (HTTP {status}); stopped to avoid a full download.',
  },
  contentRangeInvalid: {
    'zh-Hans': '源站 Content-Range 无效：{contentRange}。',
    en: 'The origin Content-Range is invalid: {contentRange}.',
  },
  repositoryRevisionInvalid: {
    'zh-Hans': '仓库 revision 无效。',
    en: 'The repository revision is invalid.',
  },
  invalidRepositoryPath: {
    'zh-Hans': '仓库文件路径无效。',
    en: 'The repository file path is invalid.',
  },
  repositoryFileSizeInvalid: {
    'zh-Hans': '仓库文件大小无效。',
    en: 'The repository file size is invalid.',
  },
  tokenizerBundleSameDirectory: {
    'zh-Hans': 'Tokenizer 资源必须是同目录的 tokenizer.json 与 tokenizer_config.json。',
    en: 'Tokenizer resources must be tokenizer.json and tokenizer_config.json in the same directory.',
  },
  tokenizerBundleSizeMissing: {
    'zh-Hans': '仓库未提供完整的 tokenizer 资源大小，已拒绝加载。',
    en: 'The repository does not provide complete tokenizer resource sizes; loading was rejected.',
  },
  tokenizerBundleTooLarge: {
    'zh-Hans': 'Tokenizer 资源超过 {limit} 上限。',
    en: 'Tokenizer resources exceed the {limit} limit.',
  },
  tokenizerRootNotObject: {
    'zh-Hans': 'tokenizer.json 根节点不是对象。',
    en: 'The tokenizer.json root is not an object.',
  },
  tokenizerIdPieceCountMismatch: {
    'zh-Hans': 'Tokenizer 返回的 ID 与 piece 数量不一致。',
    en: 'The IDs and pieces returned by the tokenizer have different counts.',
  },
  tokenizerIdFlagCountMismatch: {
    'zh-Hans': 'Tokenizer 返回的 ID 与 flags 数量不一致。',
    en: 'The IDs and flags returned by the tokenizer have different counts.',
  },
  tokenNegative: {
    'zh-Hans': '第 {index} 个 token（index {zeroBasedIndex}）不能是负数：{token}',
    en: 'Token {index} (index {zeroBasedIndex}) cannot be negative: {token}',
  },
  tokenOverflow: {
    'zh-Hans': '第 {index} 个 token（index {zeroBasedIndex}）超过 Int 范围：{token}',
    en: 'Token {index} (index {zeroBasedIndex}) exceeds the Int range: {token}',
  },
  tokenIdJsonInvalid: {
    'zh-Hans': 'Token ID JSON 数组无效：{message}',
    en: 'Invalid Token ID JSON array: {message}',
  },
  tokenIdJsonRootArray: {
    'zh-Hans': '根节点必须是数组。',
    en: 'The root node must be an array.',
  },
  tokenIdInputTooLarge: {
    'zh-Hans': 'Token ID 输入超过 {limit} 上限。',
    en: 'Token ID input exceeds the {limit} limit.',
  },
  tokenIdInputEmpty: {
    'zh-Hans': '请输入至少一个 Token ID。',
    en: 'Enter at least one Token ID.',
  },
  tokenInvalid: {
    'zh-Hans': '第 {index} 个 token（index {zeroBasedIndex}）不是整数：{token}',
    en: 'Token {index} (index {zeroBasedIndex}) is not an integer: {token}',
  },
  vocabularyInvalidTokenId: {
    'zh-Hans': '词表包含重复或无效 Token ID，无法分析。',
    en: 'The vocabulary contains duplicate or invalid Token IDs; it cannot be analyzed.',
  },
  vocabularyUnigramInvalid: {
    'zh-Hans': 'Unigram 词表结构无效，无法分析。',
    en: 'The Unigram vocabulary structure is invalid; it cannot be analyzed.',
  },
  vocabularyUnrecognized: {
    'zh-Hans': '未识别 model.vocab，无法分析。',
    en: 'model.vocab is unrecognized; the vocabulary cannot be analyzed.',
  },
  arrayValueSummary: {
    'zh-Hans': '数组 · {count} 项',
    en: 'array · {count} items',
  },
  objectValueSummary: {
    'zh-Hans': '对象 · {count} 字段{suffix}',
    en: 'object · {count} fields{suffix}',
  },
  stringValueSummary: {
    'zh-Hans': '字符串 · {count} 字符',
    en: 'string · {count} characters',
  },
  valueTypeSuffix: {
    'zh-Hans': ' · type: {type}',
    en: ' · type: {type}',
  },
  tokenizerNotLoaded: {
    'zh-Hans': 'Tokenizer 尚未加载。',
    en: 'The Tokenizer is not loaded.',
  },
  missingTokenizerConfigRuntime: {
    'zh-Hans': '缺少 tokenizer_config.json，当前运行时无法严格构造 Tokenizer。',
    en: 'tokenizer_config.json is missing; the current runtime cannot construct a strict Tokenizer.',
  },
  tokenizerConfigRootNotObject: {
    'zh-Hans': 'tokenizer_config.json 根节点不是对象。',
    en: 'The tokenizer_config.json root is not an object.',
  },
  tokenizerIdentityChanged: {
    'zh-Hans': 'Tokenizer 身份已变化，请重新加载。',
    en: 'The Tokenizer identity has changed; reload it.',
  },
  vocabularySearchUnsupported: {
    'zh-Hans': '当前 vocab 结构无法搜索：{reason}',
    en: 'The current vocab structure cannot be searched: {reason}',
  },
  leftTokenizerRootNotObject: {
    'zh-Hans': '左侧 tokenizer.json 根节点不是对象。',
    en: 'The left tokenizer.json root is not an object.',
  },
  leftTokenizerMissingModel: {
    'zh-Hans': '左侧 tokenizer.json 缺少 model 节点。',
    en: 'The left tokenizer.json is missing its model node.',
  },
  leftVocabularyCompareUnsupported: {
    'zh-Hans': '左侧 vocab 结构无法比较：{reason}',
    en: 'The left vocab structure cannot be compared: {reason}',
  },
  rightVocabularyCompareUnsupported: {
    'zh-Hans': '右侧 vocab 结构无法比较：{reason}',
    en: 'The right vocab structure cannot be compared: {reason}',
  },
  vocabularyDiffNotPrepared: {
    'zh-Hans': '词表差集尚未准备。',
    en: 'The vocabulary diff has not been prepared.',
  },
  chatRenderedInputLabel: {
    'zh-Hans': 'Chat 渲染输入',
    en: 'The rendered Chat input',
  },
  chatProbeInputLabel: {
    'zh-Hans': 'Chat 正文 probe',
    en: 'The Chat body probe',
  },
  inputLabel: {
    'zh-Hans': '输入',
    en: 'The input',
  },
  encodedInputTooLarge: {
    'zh-Hans': '{label}超过 64 KiB 上限。',
    en: '{label} exceeds the 64 KiB limit.',
  },
  tokenizerDataTooLarge: {
    'zh-Hans': 'Tokenizer 数据超过 {limit} 上限。',
    en: 'The Tokenizer data exceeds the {limit} limit.',
  },
  tokenizerRequestCancelled: {
    'zh-Hans': 'Tokenizer 请求已取消。',
    en: 'The Tokenizer request was cancelled.',
  },
  textTooLarge: {
    'zh-Hans': '输入超过 64 KiB 上限。',
    en: 'The input exceeds the 64 KiB limit.',
  },
  vocabularySearchInputTooLarge: {
    'zh-Hans': '词表搜索输入超过 64 KiB 上限。',
    en: 'The vocabulary search input exceeds the 64 KiB limit.',
  },
  vocabularyDiffSearchInputTooLarge: {
    'zh-Hans': '词表差集搜索输入超过 64 KiB 上限。',
    en: 'The vocabulary diff search input exceeds the 64 KiB limit.',
  },
  tokenIdArrayInvalid: {
    'zh-Hans': 'Token ID 数组必须是非负 safe integer。',
    en: 'The Token ID array must contain non-negative safe integers.',
  },
  tokenizerSessionReleased: {
    'zh-Hans': 'Tokenizer session 已释放。',
    en: 'The Tokenizer session has been released.',
  },
  tokenizerResourceSizeInvalid: {
    'zh-Hans': 'Tokenizer 资源大小无效。',
    en: 'The Tokenizer resource size is invalid.',
  },
  tokenizerWorkerFailed: {
    'zh-Hans': 'Tokenizer Worker 失败。',
    en: 'The Tokenizer Worker failed.',
  },
  tokenizerWorkerProtocolInvalid: {
    'zh-Hans': 'Tokenizer Worker 协议无效。',
    en: 'The Tokenizer Worker protocol is invalid.',
  },
  tokenizerWorkerProtocolMismatch: {
    'zh-Hans': 'Tokenizer Worker 协议不一致。',
    en: 'The Tokenizer Worker protocol is inconsistent.',
  },
  comparisonSessionExists: {
    'zh-Hans': 'Tokenizer comparison session 已存在。',
    en: 'A Tokenizer comparison session already exists.',
  },
  vocabularyDiffCountsInvalid: {
    'zh-Hans': '词表差集统计无效。',
    en: 'The vocabulary diff counts are invalid.',
  },
  vocabularyDiffSearchResultInvalid: {
    'zh-Hans': '词表差集结果无效。',
    en: 'The vocabulary diff result is invalid.',
  },
  tokenizerWorkerReturnedResultInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的结果结构无效。',
    en: 'The result structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedPieceCountMismatch: {
    'zh-Hans': 'Tokenizer Worker 返回的 ID、piece 与 flag 数量不一致。',
    en: 'The ID, piece, and flag counts returned by the Tokenizer Worker do not match.',
  },
  tokenizerWorkerReturnedSegmentInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的片段结构无效。',
    en: 'The segment structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedStructureInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的结构无效。',
    en: 'The structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedFieldsInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的结构字段无效。',
    en: 'The structure fields returned by the Tokenizer Worker are invalid.',
  },
  tokenizerWorkerReturnedAddedTokensInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 added tokens 摘要无效。',
    en: 'The added tokens summary returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedVocabularySummaryInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的词表摘要无效。',
    en: 'The vocabulary summary returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedLongestOrStatisticsInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的最长 Token 或词表统计无效。',
    en: 'The longest tokens or vocabulary statistics returned by the Tokenizer Worker are invalid.',
  },
  tokenizerWorkerReturnedSearchResultInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的搜索结果结构无效。',
    en: 'The search-result structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedSearchOrderInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的搜索结果排序无效。',
    en: 'The search-result order returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedChatTemplateCatalogInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 Chat Template catalog 结构无效。',
    en: 'The Chat Template catalog structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedChatTemplateEntryInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 Chat Template entry 结构无效。',
    en: 'A Chat Template entry structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedActiveChatTemplateInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 active Chat Template 无效。',
    en: 'The active Chat Template returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedExactChatMissingRoles: {
    'zh-Hans': 'Tokenizer Worker 返回的 Exact Chat 结果缺少 roles。',
    en: 'The Exact Chat result returned by the Tokenizer Worker is missing roles.',
  },
  tokenizerWorkerReturnedRolesInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 Token roles 结构无效。',
    en: 'The Token roles structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedUnexpectedRoles: {
    'zh-Hans': 'Tokenizer Worker 返回的结果不应包含 Token roles。',
    en: 'The result returned by the Tokenizer Worker must not contain Token roles.',
  },
  tokenizerWorkerReturnedRolesCountMismatch: {
    'zh-Hans': 'Tokenizer Worker 返回的 Token roles 与 ID 数量不一致。',
    en: 'The Token roles and ID counts returned by the Tokenizer Worker do not match.',
  },
  tokenizerWorkerReturnedRoleInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 Token role 结构无效。',
    en: 'A Token role structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedOverheadInvalid: {
    'zh-Hans': 'Tokenizer Worker 返回的 Chat overhead 结构无效。',
    en: 'The Chat overhead structure returned by the Tokenizer Worker is invalid.',
  },
  tokenizerWorkerReturnedUnexpectedOverhead: {
    'zh-Hans': 'Tokenizer Worker 返回的结果不应包含 Chat overhead。',
    en: 'The result returned by the Tokenizer Worker must not contain Chat overhead.',
  },
  tokenizerWorkerReturnedOverheadCountMismatch: {
    'zh-Hans': 'Tokenizer Worker 返回的 Chat overhead 与 Token ID 数量不一致。',
    en: 'The Chat overhead and Token ID counts returned by the Tokenizer Worker do not match.',
  },
  tokenizerWorkerReturnedChatMissingOverhead: {
    'zh-Hans': 'Tokenizer Worker 返回的 Chat 结果缺少 overhead。',
    en: 'The Chat result returned by the Tokenizer Worker is missing overhead.',
  },
  readerOverview: {
    'zh-Hans': '概览',
    en: 'Overview',
  },
  readerAllFields: {
    'zh-Hans': '全部字段',
    en: 'All Fields',
  },
  readerRawSource: {
    'zh-Hans': '原文',
    en: 'Raw Text',
  },
  // Native TemplatePlaygroundView / TemplateRenderer / RenderedOutputInspector / JinjaWorkspaceView copy.
  templateSpecialToken: {
    'zh-Hans': '特殊 token',
    en: 'Special token',
  },
  templateVariableNameRequired: {
    'zh-Hans': '变量名不能为空。',
    en: 'A variable name is required.',
  },
  templateVariableReserved: {
    'zh-Hans': '“{name}”由专用编辑器管理。',
    en: '"{name}" is managed by its dedicated editor.',
  },
  templateVariableDuplicate: {
    'zh-Hans': '变量“{name}”重复。',
    en: 'Duplicate variable "{name}".',
  },
  templateVariableInteger: {
    'zh-Hans': '变量“{name}”需要整数。',
    en: 'Variable "{name}" requires an integer.',
  },
  templateVariableNumber: {
    'zh-Hans': '变量“{name}”需要数字。',
    en: 'Variable "{name}" requires a number.',
  },
  templateVariableLabel: {
    'zh-Hans': '变量 {name}',
    en: 'Variable {name}',
  },
  templateJsonInvalid: {
    'zh-Hans': '{label} JSON 无效：{message}',
    en: 'Invalid {label} JSON: {message}',
  },
  templateToolNameRequired: {
    'zh-Hans': 'Tool 名称不能为空。',
    en: 'A tool name is required.',
  },
  templateToolParametersObject: {
    'zh-Hans': 'Tool {name} 的 parameters 必须是 JSON 对象。',
    en: 'The parameters for tool {name} must be a JSON object.',
  },
  templateStatusRendering: {
    'zh-Hans': '渲染中',
    en: 'Rendering',
  },
  templateStatusError: {
    'zh-Hans': '输入或模板有错误',
    en: 'Input or template error',
  },
  templateStatusLive: {
    'zh-Hans': '实时预览',
    en: 'Live preview',
  },
  templateLoadExample: {
    'zh-Hans': '载入示例',
    en: 'Load example',
  },
  templateExampleBasic: {
    'zh-Hans': '基础对话',
    en: 'Basic conversation',
  },
  templateExampleTools: {
    'zh-Hans': '工具调用',
    en: 'Tool calling',
  },
  templateExampleMultimodal: {
    'zh-Hans': '多模态 content',
    en: 'Multimodal content',
  },
  templateRestoreTemplate: {
    'zh-Hans': '恢复原模板',
    en: 'Restore original template',
  },
  templateTemplatePane: {
    'zh-Hans': 'Jinja 模板',
    en: 'Jinja template',
  },
  templateLines: {
    'zh-Hans': '{count} 行',
    en: '{count} lines',
  },
  templateOutputPane: {
    'zh-Hans': '渲染结果',
    en: 'Rendered output',
  },
  templateBytes: {
    'zh-Hans': '{count} 字节',
    en: '{count} bytes',
  },
  templateNotGenerated: {
    'zh-Hans': '未生成',
    en: 'Not generated',
  },
  templateCopyRaw: {
    'zh-Hans': '复制原始输出',
    en: 'Copy raw output',
  },
  templateEmptyOutput: {
    'zh-Hans': '模板没有产生输出。',
    en: 'The template did not produce output.',
  },
  templateStructureTitle: {
    'zh-Hans': '结构索引 · 只读',
    en: 'Structure index · read-only',
  },
  templateNoBoundaries: {
    'zh-Hans': '未识别可索引的消息边界',
    en: 'No indexable message boundaries recognized',
  },
  templateContentInspector: {
    'zh-Hans': '内容检查器',
    en: 'Content inspector',
  },
  templateContentInspectorNote: {
    'zh-Hans': '解析视图，不属于输出',
    en: 'Parsed view; not part of the output',
  },
  templateStructureFooter: {
    'zh-Hans': '仅引用原文范围；渲染结果未修改',
    en: 'References original ranges only; rendered output is unchanged',
  },
  templateRawTitle: {
    'zh-Hans': '原始输出 · 权威',
    en: 'Raw output · authoritative',
  },
  templateRawNote: {
    'zh-Hans': '软换行仅用于显示，不属于输出',
    en: 'Soft wraps are display-only and are not part of the output',
  },
  templateRunOptions: {
    'zh-Hans': '运行选项',
    en: 'Run options',
  },
  templateAdd: {
    'zh-Hans': '添加',
    en: 'Add',
  },
  templateMessageRole: {
    'zh-Hans': '消息角色',
    en: 'Message role',
  },
  templateAddMessage: {
    'zh-Hans': '添加消息',
    en: 'Add message',
  },
  templateAdvancedOptions: {
    'zh-Hans': '高级选项',
    en: 'Advanced options',
  },
  tkpModeRaw: {
    'zh-Hans': '原始文本',
    en: 'Raw text',
  },
  tkpModeChat: {
    'zh-Hans': 'Chat 对话',
    en: 'Chat conversation',
  },
  tkpModeAria: {
    'zh-Hans': '输入模式',
    en: 'Input mode',
  },
  tkpModeHelp: {
    'zh-Hans': '选择原始文本、Chat Template 或 Token IDs 输入',
    en: 'Choose raw text, Chat Template, or Token IDs input',
  },
  tkpModeHelpNoTemplate: {
    'zh-Hans': '当前目录没有可用 Chat Template；Token IDs 仍可用',
    en: 'No usable Chat Template in this directory; Token IDs remain available',
  },
  tkpInput: {
    'zh-Hans': '输入',
    en: 'Input',
  },
  tkpBytes: {
    'zh-Hans': '{count} 字节',
    en: '{count} bytes',
  },
  tkpClear: {
    'zh-Hans': '清空',
    en: 'Clear',
  },
  tkpIdsHint: {
    'zh-Hans': '支持逗号、空白或 JSON 数组',
    en: 'Supports commas, whitespace, or a JSON array',
  },
  tkpDecodedText: {
    'zh-Hans': '解码文本',
    en: 'Decoded text',
  },
  tkpTokenizerText: {
    'zh-Hans': '送入 tokenizer 的文本',
    en: 'Text sent to the tokenizer',
  },
  tkpDecodedDetail: {
    'zh-Hans': '由 Token ID 解码 · {count} 字节',
    en: 'Decoded from Token IDs · {count} bytes',
  },
  tkpSourceDetail: {
    'zh-Hans': '{source} · {count} 字节',
    en: '{source} · {count} bytes',
  },
  tkpSourceRendered: {
    'zh-Hans': 'chat_template 渲染结果',
    en: 'chat_template render result',
  },
  tkpCopy: {
    'zh-Hans': '复制',
    en: 'Copy',
  },
  tkpDecodedEmpty: {
    'zh-Hans': '输入 Token ID 后显示解码文本。',
    en: 'Decoded text appears after entering Token IDs.',
  },
  tkpTextEmpty: {
    'zh-Hans': '输入内容后显示实际编码文本。',
    en: 'The actual encoded text appears after entering content.',
  },
  tkpTokenCount: {
    'zh-Hans': 'Token 数量',
    en: 'Token count',
  },
  tkpUnicodeCharacters: {
    'zh-Hans': 'Unicode 字符',
    en: 'Unicode characters',
  },
  tkpBytesPerToken: {
    'zh-Hans': '字节 / Token',
    en: 'Bytes / Token',
  },
  tkpContentTokens: {
    'zh-Hans': '正文 token',
    en: 'Content tokens',
  },
  tkpTemplateOverhead: {
    'zh-Hans': '模板开销（近似）',
    en: 'Template overhead (approx.)',
  },
  tkpCannotSplit: {
    'zh-Hans': '无法按差量拆分',
    en: 'Cannot split by difference',
  },
  tkpResult: {
    'zh-Hans': '分词结果',
    en: 'Tokenization result',
  },
  tkpComparison: {
    'zh-Hans': '对照',
    en: 'Comparison',
  },
  tkpCopyIds: {
    'zh-Hans': '复制 IDs',
    en: 'Copy IDs',
  },
  tkpShowWhitespace: {
    'zh-Hans': '显示空白符',
    en: 'Show whitespace',
  },
  tkpCloseComparison: {
    'zh-Hans': '关闭对照',
    en: 'Close comparison',
  },
  tkpOtherRepositoryMenu: {
    'zh-Hans': '选择另一仓库…',
    en: 'Select another repository…',
  },
  tkpOtherRepository: {
    'zh-Hans': '另一仓库',
    en: 'Another repository',
  },
  tkpLoadComparison: {
    'zh-Hans': '加载对照',
    en: 'Load comparison',
  },
  tkpResultStatusIds: {
    'zh-Hans': '{path} · 由 Token ID 解码',
    en: '{path} · Decoded from Token IDs',
  },
  tkpResultStatus: {
    'zh-Hans': '{path} · {mapping}',
    en: '{path} · {mapping}',
  },
  tkpWaitingResult: {
    'zh-Hans': '等待结果',
    en: 'Waiting for result',
  },
  tkpStatusRendering: {
    'zh-Hans': '正在渲染',
    en: 'Rendering',
  },
  tkpStatusTemplateError: {
    'zh-Hans': '模板错误',
    en: 'Template error',
  },
  tkpStatusDecoded: {
    'zh-Hans': '由 Token ID 解码',
    en: 'Decoded from Token IDs',
  },
  tkpStatusLive: {
    'zh-Hans': '实时编码',
    en: 'Live encoding',
  },
  tkpLoading: {
    'zh-Hans': '正在加载 tokenizer…',
    en: 'Loading tokenizer…',
  },
  tkpTokenizing: {
    'zh-Hans': '正在编码最新输入…',
    en: 'Encoding latest input…',
  },
  tkpInputTooLarge: {
    'zh-Hans': '输入超过 {limit} 上限',
    en: 'Input exceeds the {limit} limit',
  },
  tkpRetry: {
    'zh-Hans': '重试',
    en: 'Retry',
  },
  tkpDecodedOnly: {
    'zh-Hans': '当前映射是 Decoded only，不能按原文划分角色',
    en: 'The current mapping is Decoded only; roles cannot be split from the original text',
  },
  tkpEmptyResult: {
    'zh-Hans': '输入内容后显示 token。',
    en: 'Tokens appear after entering content.',
  },
  tkpSegmentAria: {
    'zh-Hans': 'Token {start} 到 {end}，ID {ids}，文本 {text}，角色 {role}',
    en: 'Token {start} through {end}, IDs {ids}, text {text}, role {role}',
  },
  tkpNone: {
    'zh-Hans': '无',
    en: 'None',
  },
  tkpTableAria: {
    'zh-Hans': 'Token 表，共 {count} 行',
    en: 'Token table, {count} rows',
  },
  tkpRowAria: {
    'zh-Hans': 'Token {index}，ID {id}，Piece {piece}，Decoded {decoded}，Role {role}，Special {special}，{mapping}',
    en: 'Token {index}, ID {id}, Piece {piece}, Decoded {decoded}, Role {role}, Special {special}, {mapping}',
  },
  tkpCopyId: {
    'zh-Hans': '复制 ID',
    en: 'Copy ID',
  },
  tkpCopyPiece: {
    'zh-Hans': '复制 Token Piece',
    en: 'Copy Token Piece',
  },
  tkpCopyDecoded: {
    'zh-Hans': '复制解码片段',
    en: 'Copy decoded segment',
  },
  tkpChipAria: {
    'zh-Hans': 'Token {index}，ID {id}，文本 {text}',
    en: 'Token {index}, ID {id}, text {text}',
  },
  tkpIndex: {
    'zh-Hans': '序号',
    en: 'Index',
  },
  tkpDecodedFragment: {
    'zh-Hans': '解码片段',
    en: 'Decoded',
  },
  tkpRole: {
    'zh-Hans': '角色',
    en: 'Role',
  },
  cmpLoading: {
    'zh-Hans': '正在加载对照 tokenizer…',
    en: 'Loading comparison tokenizer…',
  },
  cmpEmpty: {
    'zh-Hans': '输入内容后显示对照结果。',
    en: 'Comparison results appear after entering content.',
  },
  cmpPrimary: {
    'zh-Hans': '主侧',
    en: 'Primary',
  },
  cmpLeftCount: {
    'zh-Hans': '主 {count}',
    en: 'Primary {count}',
  },
  cmpRightCount: {
    'zh-Hans': '对照 {count}',
    en: 'Comparison {count}',
  },
  cmpDelta: {
    'zh-Hans': '差值 {delta}',
    en: 'Delta: {delta}',
  },
  cmpIdsSame: {
    'zh-Hans': 'ID 序列相同',
    en: 'ID sequences match',
  },
  cmpIdsDifferent: {
    'zh-Hans': 'ID 序列不同',
    en: 'ID sequences differ',
  },
  cmpFirstDifference: {
    'zh-Hans': '第一处不同：index {index}，主 {left}，对照 {right}',
    en: 'First difference: index {index}, primary {left}, comparison {right}',
  },
  cmpFirstDifferenceNone: {
    'zh-Hans': '第一处不同：无',
    en: 'First difference: none',
  },
  cmpOverhead: {
    'zh-Hans': '模板开销（近似）：主 {left} · 对照 {right}',
    en: 'Template overhead (approx.): primary {left} · comparison {right}',
  },
  cmpVocabulary: {
    'zh-Hans': '词表差集',
    en: 'Vocabulary difference',
  },
  cmpPrimaryOnlyCount: {
    'zh-Hans': '仅主 {count}',
    en: 'Primary only {count}',
  },
  cmpComparisonOnlyCount: {
    'zh-Hans': '仅对照 {count}',
    en: 'Comparison only {count}',
  },
  cmpSharedCount: {
    'zh-Hans': '共有 {count}',
    en: 'Shared {count}',
  },
  cmpPrimaryOnly: {
    'zh-Hans': '仅主',
    en: 'Primary only',
  },
  cmpComparisonOnly: {
    'zh-Hans': '仅对照',
    en: 'Comparison only',
  },
  cmpDiffSide: {
    'zh-Hans': '差集侧',
    en: 'Difference side',
  },
  cmpSearch: {
    'zh-Hans': '搜索 token piece',
    en: 'Search token piece',
  },
  cmpShowing: {
    'zh-Hans': '显示 {count} 条，最多 {limit} 条',
    en: 'Showing count: {count}; maximum: {limit}',
  },
  cmpEmptyToken: {
    'zh-Hans': '（空 Token）',
    en: '(empty token)',
  },
  cmpSkipSentencePiece: {
    'zh-Hans': 'SentencePiece 不提供可解析的 tokenizer.json 词表；编码对照仍可用。',
    en: 'SentencePiece does not provide a parseable tokenizer.json vocabulary; encoding comparison remains available.',
  },
  cmpSkipUnparseable: {
    'zh-Hans': '一侧 tokenizer.json 的 model.vocab 无法解析，已跳过词表差集。',
    en: 'The model.vocab in one tokenizer.json could not be parsed; the vocabulary difference was skipped.',
  },
  cmpSkipPrimaryNotReady: {
    'zh-Hans': '主侧 tokenizer 尚未就绪，已跳过词表差集。',
    en: 'The primary tokenizer is not ready yet; the vocabulary difference was skipped.',
  },
  cmpMissingTemplate: {
    'zh-Hans': '对照侧没有可用 Chat Template。',
    en: 'No chat template is available on the comparison side.',
  },
  cmpRenderFailed: {
    'zh-Hans': '对照侧模板渲染失败：{message}',
    en: 'Comparison-side template rendering failed: {message}',
  },
  tokenizerComparisonMissingEntry: {
    'zh-Hans': 'snapshot 中没有可用 tokenizer 入口：{path}',
    en: 'No usable tokenizer entry found in snapshot: {path}',
  },
  cmpNoEntry: {
    'zh-Hans': '对方仓库没有可用 tokenizer 入口。',
    en: 'The other repository has no usable tokenizer entry.',
  },
  tjvParsing: {
    'zh-Hans': '正在后台解析 tokenizer.json…',
    en: 'Parsing tokenizer.json in the background…',
  },
  tjvSubtitle: {
    'zh-Hans': '大型 tokenizer.json 在后台解析；摘要不会展开完整词表和合并规则。',
    en: 'Large tokenizer.json files are parsed in the background; the summary does not expand the full vocabulary or merge rules.',
  },
  tjvStructure: {
    'zh-Hans': '结构',
    en: 'Structure',
  },
  tjvVersion: {
    'zh-Hans': '格式版本',
    en: 'Format version',
  },
  tjvModelType: {
    'zh-Hans': '模型类型',
    en: 'Model type',
  },
  tjvVocabEntries: {
    'zh-Hans': '词表项',
    en: 'Vocabulary entries',
  },
  tjvMerges: {
    'zh-Hans': '合并规则',
    en: 'Merge rules',
  },
  tjvAddedTokens: {
    'zh-Hans': '新增 Token',
    en: 'Added tokens',
  },
  tjvVocabEmpty: {
    'zh-Hans': 'model.vocab 为空，没有可分析的 Token。',
    en: 'model.vocab is empty, so there are no tokens to analyze.',
  },
  tjvVocabUnsupported: {
    'zh-Hans': '当前 model.vocab 结构无法进行词表长度分析。',
    en: 'The current model.vocab structure does not support vocabulary length analysis.',
  },
  tjvFooter: {
    'zh-Hans': '需要逐项查看时，优先使用仓库中的 vocab.json 和 merges.txt；它们有分页阅读器。',
    en: 'To inspect items individually, prefer vocab.json and merges.txt in the repository; they have paginated readers.',
  },
  tjvSearchTitle: {
    'zh-Hans': '词表搜索',
    en: 'Vocabulary search',
  },
  tjvSearchSubtitle: {
    'zh-Hans': '首次输入非空查询时按需构建索引；最多显示 1,000 条匹配。',
    en: 'An index is built on demand for the first nonempty query; at most 1,000 matches are shown.',
  },
  tjvSearchPlaceholder: {
    'zh-Hans': '搜索 token 或 ID',
    en: 'Search tokens or IDs',
  },
  tjvSearchPreparing: {
    'zh-Hans': '正在准备词表索引…',
    en: 'Preparing vocabulary index…',
  },
  tjvSearchPrompt: {
    'zh-Hans': '输入 token 或十进制 ID 开始搜索。',
    en: 'Enter a token or decimal ID to search.',
  },
  tjvSearchCount: {
    'zh-Hans': '匹配 {count} 条',
    en: '{count} matches',
  },
  tjvSearchUnsupported: {
    'zh-Hans': '当前 vocab 结构无法搜索。',
    en: 'The current vocab structure cannot be searched.',
  },
  tjvLengthTitle: {
    'zh-Hans': '词表长度',
    en: 'Vocabulary length',
  },
  tjvLengthSubtitle: {
    'zh-Hans': '基础词表 {count} 项；按原始 Token Piece 的 Unicode 标量计数。',
    en: 'Base vocabulary: {count} entries; counted in Unicode scalars of the original token pieces.',
  },
  tjvAverage: {
    'zh-Hans': '平均',
    en: 'Average',
  },
  tjvLongest: {
    'zh-Hans': '最长',
    en: 'Longest',
  },
  tjvDistribution: {
    'zh-Hans': '长度分布',
    en: 'Length distribution',
  },
  tjvBucketAria: {
    'zh-Hans': '长度 {label}，{count} 个 Token，占 {percent}',
    en: 'Length {label}, {count} tokens, {percent}',
  },
  tjvBucketSummary: {
    'zh-Hans': '长度 {label}：{count} 项，占基础词表 {percent}。',
    en: 'Length {label}: {count} entries, {percent} of the base vocabulary.',
  },
  tjvBasis: {
    'zh-Hans': '统计口径',
    en: 'Counting basis',
  },
  tjvBasisPieces: {
    'zh-Hans': '统计 tokenizer.json 中 model.vocab 的原始 Piece，不先解码 ByteLevel，也不做 Unicode 归一化。',
    en: 'Counts original pieces in tokenizer.json model.vocab without decoding ByteLevel first or applying Unicode normalization.',
  },
  tjvBasisAdded: {
    'zh-Hans': 'Added Token 单独计数，不进入本分布。最长 Token 用于理解词表构成，不代表 tokenizer 质量。',
    en: 'Added tokens are counted separately and excluded from this distribution. The longest tokens help explain vocabulary composition and do not indicate tokenizer quality.',
  },
  tjvLongestTitle: {
    'zh-Hans': '最长 Token',
    en: 'Longest tokens',
  },
  tjvLongestOrder: {
    'zh-Hans': '长度降序，ID 升序',
    en: 'Length descending, ID ascending',
  },
  tjvCollapse: {
    'zh-Hans': '收起到 Top 20',
    en: 'Collapse to Top 20',
  },
  tjvExpand: {
    'zh-Hans': '展开 Top {count}',
    en: 'Expand Top {count}',
  },
  tjvScalars: {
    'zh-Hans': '标量',
    en: 'Scalars',
  },
  tjvRowAria: {
    'zh-Hans': '第 {rank} 名，Token ID {id}，{piece}，{count} 个 Unicode 标量',
    en: 'Rank {rank}, token ID {id}, {piece}, Unicode scalar count: {count}',
  },
  tjvCopyRaw: {
    'zh-Hans': '复制 Raw',
    en: 'Copy Raw',
  },
  tjvEmptyString: {
    'zh-Hans': '（空字符串）',
    en: '(empty string)',
  },
  tjvTokenDetail: {
    'zh-Hans': '{piece} · {scalars} 标量 · {bytes} UTF-8 bytes',
    en: '{piece} · Scalar count: {scalars} · UTF-8 byte count: {bytes}',
  },
  tjvEmptyToken: {
    'zh-Hans': '空 Token',
    en: 'Empty token',
  },
  tjvNewline: {
    'zh-Hans': '换行',
    en: 'newline',
  },
  tjvReturn: {
    'zh-Hans': '回车',
    en: 'carriage return',
  },
  tjvSpace: {
    'zh-Hans': '空格',
    en: 'space',
  },
  templateDeleteMessage: {
    'zh-Hans': '删除消息',
    en: 'Delete message',
  },
  templateAddTool: {
    'zh-Hans': '添加 Tool',
    en: 'Add tool',
  },
  templateDeleteTool: {
    'zh-Hans': '删除 Tool',
    en: 'Delete tool',
  },
  templateOtherVariables: {
    'zh-Hans': '其他变量',
    en: 'Other variables',
  },
  templateVariablesHint: {
    'zh-Hans': '用于特殊 token 和任意 template kwargs。对象与数组使用 JSON。',
    en: 'For special tokens and arbitrary template kwargs. Objects and arrays use JSON.',
  },
  templateDeleteVariable: {
    'zh-Hans': '删除变量',
    en: 'Delete variable',
  },
  templateFunctionName: {
    'zh-Hans': '函数名',
    en: 'Function name',
  },
  templateDescription: {
    'zh-Hans': '描述',
    en: 'Description',
  },
  templateVariableName: {
    'zh-Hans': '变量名',
    en: 'Variable name',
  },
  templateType: {
    'zh-Hans': '类型',
    en: 'Type',
  },
  templateValue: {
    'zh-Hans': '值',
    en: 'Value',
  },
  templateKindString: {
    'zh-Hans': '字符串',
    en: 'String',
  },
  templateKindInteger: {
    'zh-Hans': '整数',
    en: 'Integer',
  },
  templateKindDecimal: {
    'zh-Hans': '小数',
    en: 'Decimal',
  },
  templateKindBoolean: {
    'zh-Hans': '布尔',
    en: 'Boolean',
  },
  templateContentText: {
    'zh-Hans': '文本',
    en: 'Text',
  },
  templateContentKind: {
    'zh-Hans': 'Content 类型',
    en: 'Content type',
  },
  jinjaOverviewSubtitle: {
    'zh-Hans': '在源码和试验台之间切换时，临时修改会保留。',
    en: 'Temporary changes are preserved when switching between source and playground.',
  },
  jinjaUtf8Size: {
    'zh-Hans': 'UTF-8 大小',
    en: 'UTF-8 Size',
  },
  jinjaLines: {
    'zh-Hans': '行数',
    en: 'Lines',
  },
  jinjaSourceLabel: {
    'zh-Hans': '来源',
    en: 'Source',
  },
  jinjaModelFiles: {
    'zh-Hans': '模型文件',
    en: 'Model files',
  },
  jinjaCurrentState: {
    'zh-Hans': '当前状态',
    en: 'Current status',
  },
  jinjaModified: {
    'zh-Hans': '临时修改',
    en: 'Temporarily modified',
  },
  jinjaUnmodified: {
    'zh-Hans': '未修改',
    en: 'Unmodified',
  },
  jinjaViewSource: {
    'zh-Hans': '查看源码',
    en: 'View source',
  },
  jinjaOpenPlayground: {
    'zh-Hans': '打开试验台',
    en: 'Open playground',
  },
  jinjaSourceDetails: {
    'zh-Hans': '源码详情',
    en: 'Source details',
  },
  jinjaFormat: {
    'zh-Hans': '格式',
    en: 'Format',
  },
  jinjaStatus: {
    'zh-Hans': '状态',
    en: 'Status',
  },
  jinjaSourceOriginal: {
    'zh-Hans': '来源原文',
    en: 'Source original',
  },
  jinjaChangesNote: {
    'zh-Hans': '修改只保留在当前文件工作台，不会写回来源。',
    en: 'Changes remain in the current file workbench and are not written back to the source.',
  },
  jinjaSourceTitle: {
    'zh-Hans': 'Jinja 源码',
    en: 'Jinja source',
  },
  jinjaRestoreSource: {
    'zh-Hans': '恢复来源原文',
    en: 'Restore source original',
  },
  jinjaOriginDerived: {
    'zh-Hans': '应用推导',
    en: 'Derived by app',
  },
  jinjaOriginRepository: {
    'zh-Hans': '来源信息',
    en: 'Source Information',
  },
  jinjaOriginRuntime: {
    'zh-Hans': '运行结果',
    en: 'Runtime Result',
  },
  templateMessageAria: {
    'zh-Hans': '{role} 消息',
    en: '{role} message',
  },
  templateEmbeddedPlaygroundTitle: {
    'zh-Hans': 'Chat Template 试验台',
    en: 'Chat Template playground',
  },
  templateEmbeddedPlaygroundHint: {
    'zh-Hans': '展开后编辑输入并实时查看渲染结果',
    en: 'Expand to edit input and see rendered results live',
  },
  readerPreviewView: {
    'zh-Hans': '预览',
    en: 'Preview',
  },
  readerRenderedView: {
    'zh-Hans': '渲染',
    en: 'Rendered',
  },
  readerLayoutLabel: {
    'zh-Hans': '排版',
    en: 'Layout',
  },
  readerDefaultLayout: {
    'zh-Hans': '默认',
    en: 'Default',
  },
  readerCompactLayout: {
    'zh-Hans': '紧凑',
    en: 'Compact',
  },
  readerExternalImage: {
    'zh-Hans': '图片：{alt}',
    en: 'Image: {alt}',
  },
  readerNoImageAlt: {
    'zh-Hans': '无说明',
    en: 'No description',
  },
  readerOpenLink: {
    'zh-Hans': '打开链接',
    en: 'Open link',
  },
  readerPdfDocumentTitle: {
    'zh-Hans': 'PDF 文档',
    en: 'PDF document',
  },
  readerOpenPdfNewTab: {
    'zh-Hans': '在新标签页打开 PDF',
    en: 'Open PDF in new tab',
  },
  readerImageFit: {
    'zh-Hans': '适应窗口',
    en: 'Fit',
  },
  readerImageActual: {
    'zh-Hans': '原始尺寸',
    en: '100%',
  },
  readerZoomIn: {
    'zh-Hans': '放大',
    en: 'Zoom in',
  },
  readerZoomOut: {
    'zh-Hans': '缩小',
    en: 'Zoom out',
  },
  readerImageFailed: {
    'zh-Hans': '无法渲染图片',
    en: 'Unable to render image',
  },
  readerExpandAllFolds: {
    'zh-Hans': '全部展开',
    en: 'Expand all',
  },
  readerCurrentFileFind: {
    'zh-Hans': '当前文件查找',
    en: 'Find in current file',
  },
  readerPreviousMatch: {
    'zh-Hans': '上一个命中',
    en: 'Previous match',
  },
  readerNextMatch: {
    'zh-Hans': '下一个命中',
    en: 'Next match',
  },
  noticeSafeTensors: {
    'zh-Hans': '只读取了 {size} JSON Header；没有请求 tensor 数据。',
    en: 'Read only the {size} JSON header; no tensor data was requested.',
  },
  // ponytail: native adds 「；最后一个 Range 可能包含少量首个 tensor 数据。」, true only once D-1 reads 1 MiB chunks.
  noticeGguf: {
    'zh-Hans': '只读取了 {size} GGUF 文件前缀。',
    en: 'Read only a {size} GGUF prefix.',
  },
  noticeImatrix: {
    'zh-Hans': '读取了完整的 {size} legacy imatrix 文件；只解析，不执行。',
    en: 'Read the whole {size} legacy imatrix file; parsed only, never executed.',
  },
  // Platform adaptation (matrix P-6): the browser's built-in viewer replaces PDFKit.
  noticePdf: {
    'zh-Hans': '读取了完整的 {size} PDF，使用浏览器内置查看器本地预览。',
    en: 'Read the whole {size} PDF; previewed locally in the browser’s built-in viewer.',
  },
  noticeImage: {
    'zh-Hans': '读取了完整的 {size} 图片数据，在本地直接渲染。',
    en: 'Read the whole {size} of image data; rendered locally.',
  },
  noticeWeightIndex: {
    'zh-Hans': '只读取权重分片索引；不会请求任何权重文件。',
    en: 'Reads only the weight shard index; no weight file is requested.',
  },
  readerFileProblems: {
    'zh-Hans': '文件问题',
    en: 'File problems',
  },
  readerDiagnosticLine: {
    'zh-Hans': '第 {line} 行',
    en: 'Line {line}',
  },
  appFileProblemCount: {
    'zh-Hans': '{count} 个问题',
    en: 'Problems: {count}',
  },
  readerFoldStructureLine: {
    'zh-Hans': '{action}第 {line} 行结构',
    en: '{action} structure on line {line}',
  },
  readerExpandAction: {
    'zh-Hans': '展开',
    en: 'Expand',
  },
  readerCollapseAction: {
    'zh-Hans': '折叠',
    en: 'Collapse',
  },
  readerReadingView: {
    'zh-Hans': '阅读视图',
    en: 'Reading view',
  },
  readerShowingCount: {
    'zh-Hans': '显示 {visible} / {total}',
    en: 'Showing {visible} / {total}',
  },
  templateSourceTab: {
    'zh-Hans': '源码',
    en: 'Source',
  },
  templatePlaygroundTab: {
    'zh-Hans': '试验台',
    en: 'Playground',
  },
  templateCopiedState: {
    'zh-Hans': '已复制',
    en: 'Copied',
  },
  templateCopyFailedState: {
    'zh-Hans': '复制失败',
    en: 'Copy failed',
  },
  tokenizer: {
    'zh-Hans': 'Tokenizer',
    en: 'Tokenizer',
  },
  appCategoryConfiguration: {
    'zh-Hans': '配置',
    en: 'Configuration',
  },
  appCategoryTemplates: {
    'zh-Hans': '模板',
    en: 'Templates',
  },
  appCategoryWeightMetadata: {
    'zh-Hans': '权重元数据',
    en: 'Weight metadata',
  },
  appCategoryDocumentation: {
    'zh-Hans': '文档',
    en: 'Documentation',
  },
  appCategoryOther: {
    'zh-Hans': '其他',
    en: 'Other',
  },
  appCategoryWeights: {
    'zh-Hans': '权重文件',
    en: 'Weights',
  },
  appDeepLinkFileMissing: {
    'zh-Hans': '深链接文件不存在：{path}',
    en: 'Deep-link file does not exist: {path}',
  },
  appSafeTensorsSizeUnavailable: {
    'zh-Hans': '仓库没有提供文件大小，已拒绝 SafeTensors 检查。',
    en: 'The repository does not provide the file size; SafeTensors inspection was refused.',
  },
  appSafeTensorsHeaderTooLarge: {
    'zh-Hans': 'SafeTensors Header 超过文件大小。',
    en: 'The SafeTensors header exceeds the file size.',
  },
  appGgufNotOpenedThisSession: {
    'zh-Hans': '未在当前会话打开',
    en: 'Not opened in this session',
  },
  appHuggingFaceRepositoryLabel: {
    'zh-Hans': 'Hugging Face 仓库',
    en: 'Hugging Face repository',
  },
  appRepositoryPlaceholder: {
    'zh-Hans': 'owner/model 或 Hugging Face URL',
    en: 'owner/model or Hugging Face URL',
  },
  appRepositoryOpeningAction: {
    'zh-Hans': '打开中…',
    en: 'Opening…',
  },
  appRepositoryOpenAction: {
    'zh-Hans': '打开',
    en: 'Open',
  },
  appSelectLocalDirectory: {
    'zh-Hans': '选择本地目录',
    en: 'Select local directory',
  },
  appClearHistoryAction: {
    'zh-Hans': '清除历史',
    en: 'Clear history',
  },
  appLoadingManifestStatus: {
    'zh-Hans': '读取文件清单…',
    en: 'Reading file list…',
  },
  appFilterFilesLabel: {
    'zh-Hans': '筛选文件',
    en: 'Filter files',
  },
  appRetryAction: {
    'zh-Hans': '重试',
    en: 'Retry',
  },
  appRepositoryFilesAriaLabel: {
    'zh-Hans': '仓库文件',
    en: 'Repository files',
  },
  appCopyPathAction: {
    'zh-Hans': '复制路径',
    en: 'Copy path',
  },
  appCopyRelativePathAction: {
    'zh-Hans': '复制相对路径',
    en: 'Copy relative path',
  },
  appCopyFullPathAction: {
    'zh-Hans': '复制全路径',
    en: 'Copy full path',
  },
  appOpenOriginalFileAction: {
    'zh-Hans': '打开原始文件',
    en: 'Open original file',
  },
  appFileActionsMenuAriaLabel: {
    'zh-Hans': '文件操作',
    en: 'File actions',
  },
  appSelectFileTitle: {
    'zh-Hans': '选择一个文件',
    en: 'Select a file',
  },
  appSelectFileMessage: {
    'zh-Hans': '文件内容只会在选中后加载。',
    en: 'File contents load only after you select a file.',
  },
  appUnknownSize: {
    'zh-Hans': '未知大小',
    en: 'Unknown size',
  },
  appSourceLinkAction: {
    'zh-Hans': '在源站打开',
    en: 'Open on source',
  },
  appUnableToReadFileTitle: {
    'zh-Hans': '无法读取文件',
    en: 'Unable to read file',
  },
  appLockedWeightsTitle: {
    'zh-Hans': '权重文件已锁定',
    en: 'Weight file locked',
  },
  appLockedWeightsMessage: {
    'zh-Hans': '为避免意外下载大文件，应用只展示文件名、大小和哈希。',
    en: 'To avoid downloading large files by accident, the app shows only the file name, size and hash.',
  },
  appParameterTotalLabel: {
    'zh-Hans': '参数总数',
    en: 'Parameter total',
  },
  appDataRegionSizeLabel: {
    'zh-Hans': '数据区大小',
    en: 'Data region size',
  },
  appSafeTensorsScopeNote: {
    'zh-Hans': '名称、dtype、shape、offset 与 Metadata 来自 Header；参数量和字节数为浏览器推导。',
    en: 'Names, dtype, shape, offsets, and metadata come from the header; parameter and byte totals are derived in the browser.',
  },
  appFilterMetadataLabel: {
    'zh-Hans': '筛选 Metadata',
    en: 'Filter metadata',
  },
  appFilterTensorLabel: {
    'zh-Hans': '筛选 Tensor',
    en: 'Filter tensors',
  },
  appKeyOrValueContainsPlaceholder: {
    'zh-Hans': 'Key 或 Value 包含…',
    en: 'Key or value contains…',
  },
  appNameOrDtypeContainsPlaceholder: {
    'zh-Hans': '名称或 dtype 包含…',
    en: 'Name or dtype contains…',
  },
  appShowingTensorCount: {
    'zh-Hans': '显示 {visible} 行 / 匹配 {matching} 个 Tensor（总计 {total}）',
    en: 'Showing {visible} rows / {matching} matching tensors ({total} total)',
  },
  appSafeTensorsMetadataTableAriaLabel: {
    'zh-Hans': 'SafeTensors Metadata',
    en: 'SafeTensors metadata',
  },
  appKeyColumn: {
    'zh-Hans': 'Key',
    en: 'Key',
  },
  appValueColumn: {
    'zh-Hans': 'Value',
    en: 'Value',
  },
  appSafeTensorsTensorsTableAriaLabel: {
    'zh-Hans': 'SafeTensors Tensors',
    en: 'SafeTensors tensors',
  },
  appTensorColumn: {
    'zh-Hans': 'Tensor',
    en: 'Tensor',
  },
  appDTypeColumn: {
    'zh-Hans': 'DType',
    en: 'dtype',
  },
  appShapeColumn: {
    'zh-Hans': 'Shape',
    en: 'Shape',
  },
  appParametersColumn: {
    'zh-Hans': '参数',
    en: 'Parameters',
  },
  appBytesColumn: {
    'zh-Hans': 'Bytes',
    en: 'Bytes',
  },
  appTensorGroupCount: {
    'zh-Hans': '{count} 个 Tensor',
    en: '{count} tensors',
  },
  appExpandGroupAction: {
    'zh-Hans': '{label}，展开，{count} 个 Tensor',
    en: '{label}, expand, {count} tensors',
  },
  appCollapseGroupAction: {
    'zh-Hans': '{label}，收起，{count} 个 Tensor',
    en: '{label}, collapse, {count} tensors',
  },
  appCollapseAllAction: {
    'zh-Hans': '全部收起',
    en: 'Collapse all',
  },
  appHideTensorDetailsAction: {
    'zh-Hans': '隐藏详情',
    en: 'Hide details',
  },
  appShowTensorDetailsAction: {
    'zh-Hans': '显示详情',
    en: 'Show details',
  },
  appTensorBreadcrumbAriaLabel: {
    'zh-Hans': 'Tensor 路径：{path}',
    en: 'Tensor path: {path}',
  },
  appShowMoreTensorRowsAction: {
    'zh-Hans': '再显示 100 行',
    en: 'Show 100 more rows',
  },
  appSelectedTensorTitle: {
    'zh-Hans': '选中 Tensor · {name}',
    en: 'Selected tensor · {name}',
  },
  appDataOffsetsLabel: {
    'zh-Hans': 'Data Offsets',
    en: 'Data offsets',
  },
  appViewConsistencyReportAriaLabel: {
    'zh-Hans': '查看仓库一致性报告',
    en: 'View repository consistency report',
  },
  appRepositoryConsistencyReportAriaLabel: {
    'zh-Hans': '仓库一致性报告',
    en: 'Repository consistency report',
  },
  appBottomPanelAriaLabel: {
    'zh-Hans': '底部面板',
    en: 'Bottom panel',
  },
  appProblemsTab: {
    'zh-Hans': '问题',
    en: 'Problems',
  },
  appSeverityWarning: {
    'zh-Hans': '警告',
    en: 'Warning',
  },
  appSeverityInfo: {
    'zh-Hans': '提示',
    en: 'Info',
  },
  appInspectorAriaLabel: {
    'zh-Hans': '检查器',
    en: 'Inspector',
  },
  appToggleInspectorAction: {
    'zh-Hans': '显示或隐藏检查器',
    en: 'Show or hide inspector',
  },
  appInspectorSelectedProblem: {
    'zh-Hans': '选中问题',
    en: 'Selected problem',
  },
  appInspectorFileSection: {
    'zh-Hans': '文件',
    en: 'File',
  },
  appInspectorPathLabel: {
    'zh-Hans': '路径',
    en: 'Path',
  },
  appInspectorSizeLabel: {
    'zh-Hans': '大小',
    en: 'Size',
  },
  appInspectorEmpty: {
    'zh-Hans': '打开文件或在问题面板中选择一项，这里会显示详情。',
    en: 'Open a file or pick a problem to see its details here.',
  },
  appTogglePanelAction: {
    'zh-Hans': '显示或隐藏底部面板',
    en: 'Show or hide bottom panel',
  },
  appPanelTokensTab: {
    'zh-Hans': 'Token 表',
    en: 'Token table',
  },
  appPanelTokenIdsTab: {
    'zh-Hans': 'Token IDs',
    en: 'Token IDs',
  },
  appInspectorSelectedToken: {
    'zh-Hans': '选中 Token',
    en: 'Selected token',
  },
  appCloseAction: {
    'zh-Hans': '关闭',
    en: 'Close',
  },
  appCheckingRepositoryMaterials: {
    'zh-Hans': '正在检查仓库材料…',
    en: 'Checking repository materials…',
  },
  appRepositoryIdentityAriaLabel: {
    'zh-Hans': '仓库身份',
    en: 'Repository identity',
  },
  appConsistencyCoverageAriaLabel: {
    'zh-Hans': '一致性 Coverage',
    en: 'Consistency coverage',
  },
  appMaterialColumn: {
    'zh-Hans': 'Material',
    en: 'Material',
  },
  appStatusColumn: {
    'zh-Hans': 'Status',
    en: 'Status',
  },
  appGgufVersionLabel: {
    'zh-Hans': 'GGUF 版本',
    en: 'GGUF version',
  },
  appTensorCountLabel: {
    'zh-Hans': 'Tensor 数量',
    en: 'Tensor count',
  },
  appGgufMetadataCountLabel: {
    'zh-Hans': 'Metadata 数量',
    en: 'Metadata count',
  },
  appEndiannessLabel: {
    'zh-Hans': '字节序',
    en: 'Byte order',
  },
  appLittleEndianValue: {
    'zh-Hans': 'Little-endian',
    en: 'Little-endian',
  },
  appBigEndianValue: {
    'zh-Hans': 'Big-endian',
    en: 'Big-endian',
  },
  appGgufScopeNote: {
    'zh-Hans': 'v0.1 仅提供 GGUF 基础摘要。完整 metadata/tensor directory 因无法保证 0 bytes tensor 数据而未启用。',
    en: 'v0.1 provides only a basic GGUF summary. Full metadata/tensor directories are disabled because 0-byte tensor data cannot be guaranteed.',
  },
  appMetadataTab: {
    'zh-Hans': 'Metadata',
    en: 'Metadata',
  },
  appActualReadBytesValue: {
    'zh-Hans': '{count} bytes',
    en: '{count} bytes',
  },
  appLoadingFileTitle: {
    'zh-Hans': '正在后台读取 {name}…',
    en: 'Reading {name} in the background…',
  },
  appLoadingSwitchHint: {
    'zh-Hans': '可切换到其他文件取消',
    en: 'switch to another file to cancel',
  },
  appEntryCountLabel: {
    'zh-Hans': 'Entry 数量',
    en: 'Entry count',
  },
  appChunkCountLabel: {
    'zh-Hans': 'Chunk 数量',
    en: 'Chunk count',
  },
  appDatasetLabel: {
    'zh-Hans': '数据集',
    en: 'Dataset',
  },
  appFileSizeLabel: {
    'zh-Hans': '文件大小',
    en: 'File size',
  },
  appNoneValue: {
    'zh-Hans': '无',
    en: 'None',
  },
  appFilterEntryLabel: {
    'zh-Hans': '筛选 Entry',
    en: 'Filter entries',
  },
  appTensorNameContainsPlaceholder: {
    'zh-Hans': 'Tensor 名称包含…',
    en: 'Tensor name contains…',
  },
  appImatrixEntriesTableAriaLabel: {
    'zh-Hans': 'Imatrix Entries',
    en: 'Imatrix entries',
  },
  appCallsColumn: {
    'zh-Hans': 'Calls',
    en: 'Calls',
  },
  appValuesColumn: {
    'zh-Hans': 'Values',
    en: 'Values',
  },
  appMinColumn: {
    'zh-Hans': 'Min',
    en: 'Min',
  },
  appMaxColumn: {
    'zh-Hans': 'Max',
    en: 'Max',
  },
  appMeanColumn: {
    'zh-Hans': 'Mean',
    en: 'Mean',
  },
  appSelectedItemTitle: {
    'zh-Hans': '选中项 · {name}',
    en: 'Selected item · {name}',
  },
  appCallCountLabel: {
    'zh-Hans': 'Call Count',
    en: 'Call count',
  },
  appValueCountLabel: {
    'zh-Hans': 'Value Count',
    en: 'Value count',
  },
  appMinMaxLabel: {
    'zh-Hans': 'Min / Max',
    en: 'Min / Max',
  },
  appMeanLabel: {
    'zh-Hans': 'Mean',
    en: 'Mean',
  },
  comparisonSecondLocalDirectoryLabel: {
    'zh-Hans': '选择第二个本地目录',
    en: 'Select the second local directory',
  },
  consistencyCoverageChecked: {
    'zh-Hans': '已检查',
    en: 'Checked',
  },
  consistencyCoverageSkipped: {
    'zh-Hans': '跳过：{reason}',
    en: 'Skipped: {reason}',
  },
  consistencyCoverageFailed: {
    'zh-Hans': '失败：{message}',
    en: 'Failed: {message}',
  },
  sentencepieceVocabularyUnavailable: {
    'zh-Hans': 'SentencePiece 不提供可解析的 tokenizer.json 词表；编码对照仍可用。',
    en: 'SentencePiece does not provide a parsable tokenizer.json vocabulary; encoding comparison remains available.',
  },
  sentencepieceModelBytesRequired: {
    'zh-Hans': 'SentencePiece 模型必须是 Uint8Array。',
    en: 'SentencePiece model must be a Uint8Array.',
  },
  sentencepieceInputRequired: {
    'zh-Hans': 'SentencePiece 输入必须是字符串。',
    en: 'SentencePiece input must be a string.',
  },
  sentencepieceIdRange: {
    'zh-Hans': 'SentencePiece ID 必须是 32 位有符号整数。',
    en: 'SentencePiece ID must be an integer in the signed 32-bit range.',
  },
  sentencepieceReturnedIdsInvalid: {
    'zh-Hans': 'SentencePiece 模块返回了无效 ID。',
    en: 'SentencePiece module returned invalid IDs.',
  },
  sentencepieceReturnedPiecesInvalid: {
    'zh-Hans': 'SentencePiece 模块返回了无效 pieces。',
    en: 'SentencePiece module returned invalid pieces.',
  },
  sentencepieceReturnedTextInvalid: {
    'zh-Hans': 'SentencePiece 模块返回了无效输出。',
    en: 'SentencePiece module returned invalid output.',
  },
  sentencepieceIdsRequired: {
    'zh-Hans': 'SentencePiece IDs 必须是数组。',
    en: 'SentencePiece IDs must be an array.',
  },
  sentencepieceInvalidModel: {
    'zh-Hans': 'SentencePiece 模型无效：{reason}',
    en: 'Invalid SentencePiece model: {reason}',
  },
  sentencepieceTiktokenRanks: {
    'zh-Hans': '这是 tiktoken BPE ranks 文本，不是 SentencePiece 模型。请打开同仓库的 tokenizer.json。',
    en: 'This is a tiktoken BPE ranks file, not a SentencePiece model. Open tokenizer.json in the same repository instead.',
  },
  sentencepieceOperationFailed: {
    'zh-Hans': 'SentencePiece 操作失败：{reason}',
    en: 'SentencePiece operation failed: {reason}',
  },
  sentencepieceDisposed: {
    'zh-Hans': '已释放',
    en: 'disposed',
  },
} as const satisfies Record<string, Record<Locale, string>>

export type MessageKey = keyof typeof messageCatalog

let current: Locale = 'zh-Hans'

export function resolveLocale(languages: readonly string[] | undefined): Locale {
  const language = languages?.[0]?.toLowerCase()

  if (language === 'en' || language?.startsWith('en-')) return 'en'
  if (language?.startsWith('zh-')) return 'zh-Hans'
  return 'zh-Hans'
}

export function currentLocale(): Locale {
  return current
}

export function initializeLocalization(
  languages?: readonly string[],
  root?: { lang: string },
) {
  current = resolveLocale(
    languages ?? (typeof navigator === 'undefined' ? undefined : navigator.languages),
  )

  const target = root ?? (typeof document === 'undefined' ? undefined : document.documentElement)
  if (target) target.lang = current
}

function placeholders(text: string) {
  return new Set((text.match(/\{[^}]+\}/g) ?? []).map((placeholder) => placeholder.slice(1, -1)))
}

export function translate(key: MessageKey, values?: Record<string, unknown>) {
  const text = messageCatalog[key][current]
  const expected = placeholders(text)
  const supplied = Object.keys(values ?? {})
  const missing = [...expected].filter((name) => !supplied.includes(name))
  const extra = supplied.filter((name) => !expected.has(name))

  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Translation values mismatch for "${key}": missing ${missing}, extra ${extra}`)
  }

  return text.replace(/\{([^}]+)\}/g, (_, name: string) => String(values![name]))
}

export function formatNumber(
  value: number | bigint,
  options?: Intl.NumberFormatOptions,
  locale: Locale = currentLocale(),
) {
  return new Intl.NumberFormat(locale, options).format(value)
}
