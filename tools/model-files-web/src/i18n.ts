export type Locale = 'zh-Hans' | 'en'

export const messageCatalog = {
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
  jsonRootType: {
    'zh-Hans': '根类型',
    en: 'Root type',
  },
  arrayTypeLabel: {
    'zh-Hans': '数组',
    en: 'array',
  },
  jsonRootFieldCount: {
    'zh-Hans': '根字段',
    en: 'Root fields',
  },
  modelTypeLabel: {
    'zh-Hans': '模型类型',
    en: 'Model type',
  },
  architectureLabel: {
    'zh-Hans': '架构',
    en: 'Architecture',
  },
  layerCountLabel: {
    'zh-Hans': '层数',
    en: 'Layers',
  },
  vocabularySizeLabel: {
    'zh-Hans': '词表大小',
    en: 'Vocabulary size',
  },
  dataTypeLabel: {
    'zh-Hans': '数据类型',
    en: 'Data type',
  },
  maxLengthLabel: {
    'zh-Hans': '最大长度',
    en: 'Maximum length',
  },
  samplingLabel: {
    'zh-Hans': '采样',
    en: 'Sampling',
  },
  tensorEntryCountLabel: {
    'zh-Hans': 'Tensor 条目',
    en: 'Tensor entries',
  },
  shardCountLabel: {
    'zh-Hans': '分片数量',
    en: 'Shards',
  },
  declaredTotalSizeLabel: {
    'zh-Hans': '声明总大小',
    en: 'Declared total size',
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
    'zh-Hans': 'Imatrix 文件超过 32 MiB 上限。',
    en: 'The Imatrix file exceeds the 32 MiB limit.',
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
    'zh-Hans': 'Tokenizer 资源超过 32 MiB 上限。',
    en: 'Tokenizer resources exceed the 32 MiB limit.',
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
  tokenIdInputTooLarge: {
    'zh-Hans': 'Token ID 输入超过 64 KiB 上限。',
    en: 'Token ID input exceeds the 64 KiB limit.',
  },
  tokenIdInputEmpty: {
    'zh-Hans': 'Token ID 输入为空。',
    en: 'Token ID input is empty.',
  },
  tokenIdJsonParseFailed: {
    'zh-Hans': 'Token ID JSON 解析失败：{reason}',
    en: 'Failed to parse Token ID JSON: {reason}',
  },
  tokenIdJsonMustBeArray: {
    'zh-Hans': 'Token ID JSON 必须是数组。',
    en: 'Token ID JSON must be an array.',
  },
  tokenInvalid: {
    'zh-Hans': '第 {index} 个 Token 无效（zero-based index {zeroBasedIndex}）：{token}。',
    en: 'Token {index} is invalid (zero-based index {zeroBasedIndex}): {token}.',
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
    'zh-Hans': 'Tokenizer 数据超过 32 MiB 上限。',
    en: 'The Tokenizer data exceeds the 32 MiB limit.',
  },
  tokenizerRequestCancelled: {
    'zh-Hans': 'Tokenizer 请求已取消。',
    en: 'The Tokenizer request was cancelled.',
  },
  textTooLarge: {
    'zh-Hans': '输入超过 64 KiB 上限。',
    en: 'The input exceeds the 64 KiB limit.',
  },
  templateSourceTooLarge: {
    'zh-Hans': '模板源码超过 64 KiB 上限。',
    en: 'The template source exceeds the 64 KiB limit.',
  },
  templateContextTooLarge: {
    'zh-Hans': '模板输入超过 64 KiB 上限。',
    en: 'The template input exceeds the 64 KiB limit.',
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
  readerReadMethod: {
    'zh-Hans': '读取方式',
    en: 'Read method',
  },
  readerLimitedFullText: {
    'zh-Hans': '受限全文',
    en: 'Limited full text',
  },
  readerActualRead: {
    'zh-Hans': '实际读取',
    en: 'Bytes read',
  },
  readerParseResult: {
    'zh-Hans': '解析结果',
    en: 'Parse result',
  },
  readerJsonValid: {
    'zh-Hans': 'JSON 有效',
    en: 'Valid JSON',
  },
  readerUtf8Valid: {
    'zh-Hans': 'UTF-8 有效',
    en: 'Valid UTF-8',
  },
  readerOverview: {
    'zh-Hans': '概览',
    en: 'Overview',
  },
  readerAllFields: {
    'zh-Hans': '全部字段',
    en: 'All fields',
  },
  readerRawSource: {
    'zh-Hans': '原文',
    en: 'Raw source',
  },
  readerLineColumn: {
    'zh-Hans': '行',
    en: 'Line',
  },
  readerContentColumn: {
    'zh-Hans': '内容',
    en: 'Content',
  },
  readerFieldColumn: {
    'zh-Hans': '字段',
    en: 'Field',
  },
  readerValueColumn: {
    'zh-Hans': '值',
    en: 'Value',
  },
  readerMarkdownHtmlDisabled: {
    'zh-Hans': 'Markdown · raw HTML 已禁用',
    en: 'Markdown · raw HTML is disabled',
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
  readerPdfValid: {
    'zh-Hans': 'PDF 签名有效',
    en: 'PDF signature valid',
  },
  readerPdfDocumentTitle: {
    'zh-Hans': 'PDF 文档',
    en: 'PDF document',
  },
  readerOpenPdfNewTab: {
    'zh-Hans': '在新标签页打开 PDF',
    en: 'Open PDF in new tab',
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
  readerSearchFieldsAndContent: {
    'zh-Hans': '搜索',
    en: 'Search',
  },
  readerFieldOrContentContainsPlaceholder: {
    'zh-Hans': '字段或内容包含…',
    en: 'Field or content contains…',
  },
  readerShowingCount: {
    'zh-Hans': '显示 {visible} / {total}',
    en: 'Showing {visible} / {total}',
  },
  readerListAriaLabel: {
    'zh-Hans': '{column}列表',
    en: '{column} list',
  },
  readerShowMoreItems: {
    'zh-Hans': '再显示 {count} 项',
    en: 'Show {count} more items',
  },
  templateConfigTab: {
    'zh-Hans': '配置',
    en: 'Config',
  },
  templateOverviewTabWithConfig: {
    'zh-Hans': '模板概览',
    en: 'Template overview',
  },
  templateOverviewTab: {
    'zh-Hans': '概览',
    en: 'Overview',
  },
  templateSourceTab: {
    'zh-Hans': '源码',
    en: 'Source',
  },
  templatePlaygroundTab: {
    'zh-Hans': '试验台',
    en: 'Playground',
  },
  templateViewsAriaLabel: {
    'zh-Hans': 'Template 视图',
    en: 'Template views',
  },
  templateOriginLabel: {
    'zh-Hans': '模板来源',
    en: 'Template origin',
  },
  templateSourceSizeLabel: {
    'zh-Hans': '源码大小',
    en: 'Source size',
  },
  templateBytesReadLabel: {
    'zh-Hans': '读取总量',
    en: 'Bytes read',
  },
  templateLineCountLabel: {
    'zh-Hans': '行数',
    en: 'Lines',
  },
  templateJinjaExpressionsLabel: {
    'zh-Hans': 'Jinja 表达式',
    en: 'Jinja expressions',
  },
  templateJinjaStatementsLabel: {
    'zh-Hans': 'Jinja 语句',
    en: 'Jinja statements',
  },
  templateModificationStatusLabel: {
    'zh-Hans': '修改状态',
    en: 'Modification status',
  },
  templateOriginalSourceState: {
    'zh-Hans': '来源原文',
    en: 'Original source',
  },
  templateTemporaryChangesState: {
    'zh-Hans': '临时修改',
    en: 'Temporary changes',
  },
  templateModifiedState: {
    'zh-Hans': '已修改',
    en: 'Modified',
  },
  templateScopeNote: {
    'zh-Hans': '模板只在 Web Worker 中执行；不支持 include，不执行 JavaScript，不写回仓库。',
    en: 'Templates run only in a Web Worker; includes are unsupported, JavaScript is not executed, and the repository is not written back.',
  },
  templateLineCountSuffix: {
    'zh-Hans': '{count} 行',
    en: '{count} lines',
  },
  templateRestoreSourceAction: {
    'zh-Hans': '恢复来源',
    en: 'Restore source',
  },
  templateJinjaSourceAriaLabel: {
    'zh-Hans': 'Jinja 源码',
    en: 'Jinja source',
  },
  templateJinjaHighlightAriaLabel: {
    'zh-Hans': 'Jinja 高亮预览',
    en: 'Jinja highlighted preview',
  },
  templatePresetLabel: {
    'zh-Hans': 'Preset',
    en: 'Preset',
  },
  templateBasicConversationOption: {
    'zh-Hans': '基础对话',
    en: 'Basic conversation',
  },
  templateMultimodalOption: {
    'zh-Hans': '多模态',
    en: 'Multimodal',
  },
  templateMessagesLabel: {
    'zh-Hans': 'Messages',
    en: 'Messages',
  },
  templateMessagesInputAriaLabel: {
    'zh-Hans': 'Template Messages',
    en: 'Template Messages',
  },
  templateToolsLabel: {
    'zh-Hans': 'Tools',
    en: 'Tools',
  },
  templateToolsInputAriaLabel: {
    'zh-Hans': 'Template Tools',
    en: 'Template Tools',
  },
  templateVariablesLabel: {
    'zh-Hans': 'Typed Variables',
    en: 'Typed Variables',
  },
  templateVariablesInputAriaLabel: {
    'zh-Hans': 'Template Variables',
    en: 'Template Variables',
  },
  templateRenderAction: {
    'zh-Hans': '渲染',
    en: 'Render',
  },
  templateRenderingState: {
    'zh-Hans': '渲染中…',
    en: 'Rendering…',
  },
  templateOutputTitle: {
    'zh-Hans': '渲染输出',
    en: 'Rendered output',
  },
  templateStructureIndexAction: {
    'zh-Hans': '结构索引',
    en: 'Structure index',
  },
  templateRawOutputAction: {
    'zh-Hans': '原始输出',
    en: 'Raw output',
  },
  templateCopyOutputAction: {
    'zh-Hans': '复制输出',
    en: 'Copy output',
  },
  templateCopiedState: {
    'zh-Hans': '已复制',
    en: 'Copied',
  },
  templateCopyFailedState: {
    'zh-Hans': '复制失败',
    en: 'Copy failed',
  },
  templateEditJsonHint: {
    'zh-Hans': '编辑 JSON 后点击“渲染”。',
    en: 'Edit the JSON, then click Render.',
  },
  templateWorkerRenderingState: {
    'zh-Hans': 'Worker 正在渲染…',
    en: 'Worker is rendering…',
  },
  templateOutputStructureTableAriaLabel: {
    'zh-Hans': 'Template 输出结构',
    en: 'Template output structure',
  },
  templateSelectedRowFact: {
    'zh-Hans': '选中行',
    en: 'Selected row',
  },
  templateCharacterCountFact: {
    'zh-Hans': '字符',
    en: 'Characters',
  },
  templateUtf8BytesFact: {
    'zh-Hans': 'UTF-8 Bytes',
    en: 'UTF-8 bytes',
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
  appPublicRepositoryStatus: {
    'zh-Hans': '公开仓库 · SHA {revision} · {count} 个文件',
    en: 'Public repository · SHA {revision} · {count} files',
  },
  appLocalDirectoryStatus: {
    'zh-Hans': '本地目录 · live · {count} 个文件',
    en: 'Local directory · live · {count} files',
  },
  appLoadingManifestStatus: {
    'zh-Hans': '正在读取清单…',
    en: 'Loading manifest…',
  },
  appBrowserReadonlyStatus: {
    'zh-Hans': '纯浏览器 · 只读',
    en: 'Browser-only · read-only',
  },
  appFilterFilesLabel: {
    'zh-Hans': '筛选文件',
    en: 'Filter files',
  },
  appRetryAction: {
    'zh-Hans': '重试',
    en: 'Retry',
  },
  appRepositoryEmptyHint: {
    'zh-Hans': '打开公开仓库或选择本地目录后，这里显示真实文件清单。',
    en: 'After opening a public repository or selecting a local directory, the real file manifest appears here.',
  },
  appRepositoryFilesAriaLabel: {
    'zh-Hans': '仓库文件',
    en: 'Repository files',
  },
  appCopyPathAction: {
    'zh-Hans': '复制路径',
    en: 'Copy path',
  },
  appOpenModelRepositoryTitle: {
    'zh-Hans': '打开模型仓库',
    en: 'Open model repository',
  },
  appSelectFileTitle: {
    'zh-Hans': '选择文件',
    en: 'Select a file',
  },
  appOpenModelRepositoryMessage: {
    'zh-Hans': '输入公开 Hugging Face 仓库，验证清单、Range 与 tokenizer 的纯 Web 数据链路。',
    en: 'Enter a public Hugging Face repository to verify the browser-only manifest, Range, and tokenizer data path.',
  },
  appSelectFileMessage: {
    'zh-Hans': '从左侧选择当前 revision 中的文件。',
    en: 'Select a file from the current revision on the left.',
  },
  appUnknownSize: {
    'zh-Hans': '未知大小',
    en: 'Unknown size',
  },
  appSourceLinkAction: {
    'zh-Hans': '源站',
    en: 'Source',
  },
  appConfigConsistencyReportTitle: {
    'zh-Hans': 'Config 一致性报告',
    en: 'Config consistency report',
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
    'zh-Hans': '该格式不在 Web 纵向验证范围内，不会请求文件内容。',
    en: 'This format is outside web vertical validation; file content is not requested.',
  },
  appReadMethodTwoLocalSlices: {
    'zh-Hans': '2 次 File.slice()',
    en: '2 File.slice() calls',
  },
  appReadMethodTwoHttpRanges: {
    'zh-Hans': '2 次 HTTP 206 Range',
    en: '2 HTTP 206 Range requests',
  },
  appTensorDataLabel: {
    'zh-Hans': 'Tensor 数据',
    en: 'Tensor data',
  },
  appZeroBytesValue: {
    'zh-Hans': '0 bytes',
    en: '0 bytes',
  },
  appSafeTensorsViewAriaLabel: {
    'zh-Hans': 'SafeTensors 视图',
    en: 'SafeTensors views',
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
    'zh-Hans': '名称、dtype、shape、offset 与 Metadata 来自 Header；参数量和字节数为浏览器推导。Tensor 数据保持 0 bytes。',
    en: 'Names, dtype, shape, offsets, and metadata come from the header; parameter and byte totals are derived in the browser. Tensor data remains 0 bytes.',
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
    'zh-Hans': '显示 {visible} / {matching}（总计 {total}）',
    en: 'Showing {visible} / {matching} ({total} total)',
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
  appShowMoreTensorsAction: {
    'zh-Hans': '再显示 100 个 Tensor',
    en: 'Show 100 more tensors',
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
  appReadMethodOneLocalSlice: {
    'zh-Hans': '1 次 File.slice()',
    en: '1 File.slice() call',
  },
  appReadMethodOneHttpRange: {
    'zh-Hans': '1 次 HTTP 206 Range',
    en: '1 HTTP 206 Range request',
  },
  appMetadataTab: {
    'zh-Hans': 'Metadata',
    en: 'Metadata',
  },
  appTensorsTab: {
    'zh-Hans': 'Tensors',
    en: 'Tensors',
  },
  appActualReadBytesValue: {
    'zh-Hans': '{count} bytes',
    en: '{count} bytes',
  },
  appLoadingFileTitle: {
    'zh-Hans': '正在读取 {name}…',
    en: 'Reading {name}…',
  },
  appLoadingSwitchHint: {
    'zh-Hans': '切换文件会取消并丢弃旧结果。',
    en: 'Switching files cancels and discards the previous result.',
  },
  appModelDataLabel: {
    'zh-Hans': '模型数据',
    en: 'Model data',
  },
  appFormatLabel: {
    'zh-Hans': '格式',
    en: 'Format',
  },
  appLlamaCppLegacyImatrixValue: {
    'zh-Hans': 'llama.cpp legacy imatrix',
    en: 'llama.cpp legacy imatrix',
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
  appTokenizerRawSample: {
    'zh-Hans': 'Hello，世界 👋',
    en: 'Hello, world 👋',
  },
  appCopyInputAction: {
    'zh-Hans': '复制输入',
    en: 'Copy input',
  },
  appComparisonCurrentRepositorySource: {
    'zh-Hans': '当前仓库 · {path}',
    en: 'Current repository · {path}',
  },
  appComparisonLocalDirectorySource: {
    'zh-Hans': '本地目录 · {revision} · {name} · {path}',
    en: 'Local directory · {revision} · {name} · {path}',
  },
  appComparisonRepositoryNoTokenizer: {
    'zh-Hans': '对照仓库没有可用 tokenizer.json 或 SentencePiece .model。',
    en: 'The comparison repository has no usable tokenizer.json or SentencePiece .model.',
  },
  appComparisonLocalDirectoryNoTokenizer: {
    'zh-Hans': '对照本地目录没有可用 tokenizer.json 或 SentencePiece .model。',
    en: 'The comparison local directory has no usable tokenizer.json or SentencePiece .model.',
  },
  appComparisonSourceUnavailable: {
    'zh-Hans': '对照来源不可用。',
    en: 'The comparison source is unavailable.',
  },
  appComparisonMissingChatTemplate: {
    'zh-Hans': '对照 Tokenizer 没有可用的 Chat Template。',
    en: 'The comparison Tokenizer has no usable chat template.',
  },
  appChatTemplateLoading: {
    'zh-Hans': '正在读取独立 Chat Template。',
    en: 'Reading the standalone chat template.',
  },
  appChatTemplateUnavailable: {
    'zh-Hans': '模板不可用。',
    en: 'Template unavailable.',
  },
  comparisonOpenAction: {
    'zh-Hans': '打开对照',
    en: 'Open comparison',
  },
  comparisonTokenizerLabel: {
    'zh-Hans': '对照 Tokenizer',
    en: 'Comparison Tokenizer',
  },
  comparisonOtherPublicRepositoryAction: {
    'zh-Hans': '另一公开 Hugging Face…',
    en: 'Another public Hugging Face…',
  },
  comparisonRepositoryLabel: {
    'zh-Hans': '对照 Hugging Face 仓库',
    en: 'Comparison Hugging Face repository',
  },
  comparisonLoadAction: {
    'zh-Hans': '加载对照',
    en: 'Load comparison',
  },
  comparisonRepositoryLoadingStatus: {
    'zh-Hans': '正在读取对照仓库清单…',
    en: 'Reading the comparison repository manifest…',
  },
  comparisonCancelLoadAction: {
    'zh-Hans': '取消加载',
    en: 'Cancel loading',
  },
  comparisonSecondLocalDirectoryLabel: {
    'zh-Hans': '选择第二个本地目录',
    en: 'Select the second local directory',
  },
  comparisonCloseAction: {
    'zh-Hans': '关闭对照',
    en: 'Close comparison',
  },
  comparisonCloseAriaLabel: {
    'zh-Hans': '关闭 Tokenizer 对照',
    en: 'Close Tokenizer comparison',
  },
  comparisonNoTargetsStatus: {
    'zh-Hans': '当前快照没有可用 tokenizer.json 或 SentencePiece .model 对照目标。',
    en: 'The current snapshot has no usable tokenizer.json or SentencePiece .model comparison targets.',
  },
  tokenizerViewsAriaLabel: {
    'zh-Hans': 'Tokenizer 视图',
    en: 'Tokenizer views',
  },
  tokenizerStructureTab: {
    'zh-Hans': '结构与词表',
    en: 'Structure and vocabulary',
  },
  tokenizerRawTab: {
    'zh-Hans': 'Raw 工作台',
    en: 'Raw workbench',
  },
  tokenizerDecodeTab: {
    'zh-Hans': 'Token IDs 工作台',
    en: 'Token IDs workbench',
  },
  tokenizerChatTab: {
    'zh-Hans': 'Chat 工作台',
    en: 'Chat workbench',
  },
  tokenIdsLabel: {
    'zh-Hans': 'Token IDs',
    en: 'Token IDs',
  },
  inputMaxSizeStatus: {
    'zh-Hans': '最多 64 KiB',
    en: 'Up to 64 KiB',
  },
  tokenIdsInputPlaceholder: {
    'zh-Hans': '逗号、空白、换行或 JSON 数组，例如 [1,3,2]',
    en: 'Commas, whitespace, newlines, or a JSON array, such as [1,3,2]',
  },
  tokenIdsByteStatus: {
    'zh-Hans': '{count} bytes · 解析失败不会请求 Worker',
    en: '{count} bytes · parse failures do not request the Worker',
  },
  tokenIdsDecodeAction: {
    'zh-Hans': '解码 ID',
    en: 'Decode IDs',
  },
  mainTokenizerResultHeading: {
    'zh-Hans': '主 Tokenizer 结果',
    en: 'Main Tokenizer result',
  },
  mainTokenizerTokensTableLabel: {
    'zh-Hans': '主 Tokenizer Tokens',
    en: 'Main Tokenizer Tokens',
  },
  rawInputLabel: {
    'zh-Hans': 'Raw 输入',
    en: 'Raw input',
  },
  rawInputClearAction: {
    'zh-Hans': '清空',
    en: 'Clear',
  },
  rawInputByteStatus: {
    'zh-Hans': '{count} bytes · 自动等待 225 ms',
    en: '{count} bytes · automatic 225 ms wait',
  },
  rawInputTokenizeAction: {
    'zh-Hans': '立即分词',
    en: 'Tokenize now',
  },
  chatMessagesLabel: {
    'zh-Hans': 'Chat Messages',
    en: 'Chat Messages',
  },
  chatTemplateLabel: {
    'zh-Hans': 'Chat Template',
    en: 'Chat Template',
  },
  chatTemplateLoadingStatus: {
    'zh-Hans': '正在读取 chat_template.jinja',
    en: 'Reading chat_template.jinja',
  },
  chatTemplateUnavailableStatus: {
    'zh-Hans': '模板不可用',
    en: 'Template unavailable',
  },
  chatToolsAndVariablesLabel: {
    'zh-Hans': 'Tools 与 Variables',
    en: 'Tools and Variables',
  },
  chatToolsInputAriaLabel: {
    'zh-Hans': 'Chat Tools',
    en: 'Chat Tools',
  },
  chatVariablesInputAriaLabel: {
    'zh-Hans': 'Chat Typed Variables',
    en: 'Chat Typed Variables',
  },
  chatAuthoritativeInputLabel: {
    'zh-Hans': 'Chat 权威输入',
    en: 'Chat authoritative input',
  },
  chatPreviewEmptyStatus: {
    'zh-Hans': '渲染后，这里显示唯一权威编码输入。',
    en: 'After rendering, this shows the single authoritative encoded input.',
  },
  chatRenderAndTokenizeAction: {
    'zh-Hans': '渲染并分词',
    en: 'Render and tokenize',
  },
  comparisonTitle: {
    'zh-Hans': '对照',
    en: 'Comparison',
  },
  comparisonChatTemplateAria: {
    'zh-Hans': '对照 Chat Template',
    en: 'Comparison Chat Template',
  },
  comparisonLoadingTokenizer: {
    'zh-Hans': '正在加载对照 Tokenizer…',
    en: 'Loading comparison Tokenizer…',
  },
  comparisonLoadingTemplate: {
    'zh-Hans': '正在读取对照 chat_template.jinja…',
    en: 'Reading the comparison chat_template.jinja…',
  },
  comparisonSummaryAria: {
    'zh-Hans': 'Tokenizer 对照摘要',
    en: 'Tokenizer comparison summary',
  },
  comparisonSummaryTitle: {
    'zh-Hans': '对照摘要',
    en: 'Comparison summary',
  },
  comparisonLeftRightCountLabel: {
    'zh-Hans': 'Left / Right Count',
    en: 'Left / Right Count',
  },
  comparisonDeltaLabel: {
    'zh-Hans': 'Delta',
    en: 'Delta',
  },
  comparisonIdSequenceLabel: {
    'zh-Hans': 'ID 序列',
    en: 'ID sequence',
  },
  comparisonIdsSame: {
    'zh-Hans': '相同',
    en: 'Same',
  },
  comparisonIdsDifferent: {
    'zh-Hans': '不同',
    en: 'Different',
  },
  comparisonFirstDifferenceLabel: {
    'zh-Hans': 'First Difference（zero-based）',
    en: 'First Difference (zero-based)',
  },
  comparisonEmDashValue: {
    'zh-Hans': '—',
    en: '—',
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
  comparisonTemplateOverheadLabel: {
    'zh-Hans': '模板开销（左 / 右）',
    en: 'Template overhead (left / right)',
  },
  comparisonVocabularyDiffStatsAria: {
    'zh-Hans': 'Tokenizer 词表差集统计',
    en: 'Tokenizer vocabulary diff statistics',
  },
  comparisonVocabularyDiffTitle: {
    'zh-Hans': '词表差集',
    en: 'Vocabulary diff',
  },
  comparisonVocabularyDiffScopeAria: {
    'zh-Hans': '词表差集范围',
    en: 'Vocabulary diff scope',
  },
  comparisonVocabularyDiffScopeButton: {
    'zh-Hans': '{scope} · {count}',
    en: '{scope} · {count}',
  },
  comparisonVocabularySearchAria: {
    'zh-Hans': '对照词表搜索',
    en: 'Comparison vocabulary search',
  },
  comparisonVocabularySearchPlaceholder: {
    'zh-Hans': '包含匹配…',
    en: 'Contains match…',
  },
  comparisonPreparingDiffIndex: {
    'zh-Hans': '正在准备差集索引…',
    en: 'Preparing diff index…',
  },
  comparisonSearchingDiff: {
    'zh-Hans': '正在搜索…',
    en: 'Searching…',
  },
  comparisonDiffUnavailable: {
    'zh-Hans': '差集不可用',
    en: 'Diff unavailable',
  },
  comparisonVocabularyDiffTableAria: {
    'zh-Hans': 'Tokenizer 词表差集',
    en: 'Tokenizer vocabulary diff',
  },
  comparisonTokenPieceColumn: {
    'zh-Hans': 'Token Piece',
    en: 'Token Piece',
  },
  comparisonTokenizerResultHeading: {
    'zh-Hans': '对照 Tokenizer 结果',
    en: 'Comparison Tokenizer result',
  },
  comparisonTokenizerTokensTableLabel: {
    'zh-Hans': '对照 Tokenizer Tokens',
    en: 'Comparison Tokenizer Tokens',
  },
  tokenizerStructureLoadingStatus: {
    'zh-Hans': '正在 Worker 中分析 Tokenizer…',
    en: 'Analyzing the Tokenizer in the Worker…',
  },
  tokenizerStructureRunLocationLabel: {
    'zh-Hans': '运行位置',
    en: 'Run location',
  },
  tokenizerStructureWebWorkerValue: {
    'zh-Hans': 'Web Worker',
    en: 'Web Worker',
  },
  tokenizerStructureConfigLabel: {
    'zh-Hans': 'Tokenizer Config',
    en: 'Tokenizer Config',
  },
  tokenizerStructureConfigSameDirectoryValue: {
    'zh-Hans': '同目录',
    en: 'Same directory',
  },
  tokenizerStructureConfigMissingRawUnsupportedValue: {
    'zh-Hans': '缺失 · Raw 不支持',
    en: 'Missing · Raw unsupported',
  },
  tokenizerStructureConfigMissingValue: {
    'zh-Hans': '缺失 · Raw 与 Token IDs 可用',
    en: 'Missing · Raw and Token IDs available',
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
  sentencepieceOperationFailed: {
    'zh-Hans': 'SentencePiece 操作失败：{reason}',
    en: 'SentencePiece operation failed: {reason}',
  },
  sentencepieceDisposed: {
    'zh-Hans': '已释放',
    en: 'disposed',
  },
  tokenizerStructureAddedTokenLabel: {
    'zh-Hans': 'Added Token',
    en: 'Added Token',
  },
  tokenizerStructureSpecialAddedTokensLabel: {
    'zh-Hans': 'Special Added Tokens',
    en: 'Special Added Tokens',
  },
  tokenizerStructureIdColumn: {
    'zh-Hans': 'ID',
    en: 'ID',
  },
  tokenizerStructureTokenColumn: {
    'zh-Hans': 'Token',
    en: 'Token',
  },
  tokenizerStructureFormatVersionLabel: {
    'zh-Hans': '格式版本',
    en: 'Format version',
  },
  tokenizerStructureModelTypeLabel: {
    'zh-Hans': 'Model Type',
    en: 'Model Type',
  },
  tokenizerStructureBaseVocabularyLabel: {
    'zh-Hans': '基础词表',
    en: 'Base vocabulary',
  },
  tokenizerStructureMergeCountLabel: {
    'zh-Hans': 'Merge 数量',
    en: 'Merge count',
  },
  tokenizerStructureUnknownValue: {
    'zh-Hans': '未知',
    en: 'Unknown',
  },
  tokenizerStructureNotApplicableValue: {
    'zh-Hans': '不适用',
    en: 'N/A',
  },
  tokenizerStructureRootFieldsTableLabel: {
    'zh-Hans': 'Tokenizer 根字段',
    en: 'Tokenizer root fields',
  },
  tokenizerStructureDetailColumn: {
    'zh-Hans': 'Detail',
    en: 'Detail',
  },
  tokenizerStructureVocabularyUnavailable: {
    'zh-Hans': '词表不可分析。',
    en: 'The vocabulary cannot be analyzed.',
  },
  tokenizerStructureVocabularyEmpty: {
    'zh-Hans': 'model.vocab 为空，没有可分析的 Token。',
    en: 'model.vocab is empty; there are no Tokens to analyze.',
  },
  tokenizerStructureAverageScalarLengthLabel: {
    'zh-Hans': '平均标量长度',
    en: 'Average scalar length',
  },
  tokenizerStructureP50P90Label: {
    'zh-Hans': 'P50 / P90',
    en: 'P50 / P90',
  },
  tokenizerStructureP95P99Label: {
    'zh-Hans': 'P95 / P99',
    en: 'P95 / P99',
  },
  tokenizerStructureMaximumScalarLengthLabel: {
    'zh-Hans': '最大标量长度',
    en: 'Maximum scalar length',
  },
  tokenizerStructureLengthDistributionLabel: {
    'zh-Hans': '长度分布（Unicode 标量）',
    en: 'Length distribution (Unicode scalars)',
  },
  tokenizerStructureLengthDistributionTableLabel: {
    'zh-Hans': 'Tokenizer 长度分布',
    en: 'Tokenizer length distribution',
  },
  tokenizerStructureLengthColumn: {
    'zh-Hans': '长度',
    en: 'Length',
  },
  tokenizerStructureTokenCountColumn: {
    'zh-Hans': 'Token 数',
    en: 'Token count',
  },
  tokenizerStructureUnicodeScalarColumn: {
    'zh-Hans': 'Unicode 标量',
    en: 'Unicode scalar',
  },
  tokenizerStructureLongestTokensLabel: {
    'zh-Hans': '最长 Token',
    en: 'Longest Tokens',
  },
  tokenizerStructureCollapseTop20Action: {
    'zh-Hans': '收起到 Top 20',
    en: 'Collapse to Top 20',
  },
  tokenizerStructureExpandTopAction: {
    'zh-Hans': '展开 Top {count}',
    en: 'Expand Top {count}',
  },
  tokenizerStructureSearchLabel: {
    'zh-Hans': '词表搜索',
    en: 'Vocabulary search',
  },
  tokenizerStructureSearchPlaceholder: {
    'zh-Hans': '搜索 token 或十进制 ID',
    en: 'Search for a token or decimal ID',
  },
  tokenizerStructureSearchEmptyStatus: {
    'zh-Hans': '输入 token 或十进制 ID 开始搜索',
    en: 'Enter a token or decimal ID to start searching',
  },
  tokenizerStructureSearchPreparingStatus: {
    'zh-Hans': '正在准备词表索引',
    en: 'Preparing the vocabulary index',
  },
  tokenizerStructureSearchMatchCountStatus: {
    'zh-Hans': '匹配 {count} 条',
    en: 'Matches: {count}',
  },
  tokenizerStructureSearchFailedStatus: {
    'zh-Hans': '词表搜索失败',
    en: 'Vocabulary search failed',
  },
  tokenizerStructureSearchResultsTableLabel: {
    'zh-Hans': '词表搜索结果',
    en: 'Vocabulary search results',
  },
  tokenizerResultUnableToSplitValue: {
    'zh-Hans': '无法拆分',
    en: 'Unable to split',
  },
  tokenizerResultCopyIdAction: {
    'zh-Hans': '复制 ID',
    en: 'Copy ID',
  },
  tokenizerResultMergedSegmentDecodedSummary: {
    'zh-Hans': '合并片段（{count} tokens，完整 Decoded 见下方）',
    en: 'Merged segment ({count} tokens; see the full Decoded below)',
  },
  tokenizerResultDecodeHeading: {
    'zh-Hans': '由 Token ID 解码',
    en: 'Decoded from Token IDs',
  },
  tokenizerResultHeading: {
    'zh-Hans': 'Token 结果',
    en: 'Token result',
  },
  tokenizerResultShowWhitespaceAction: {
    'zh-Hans': '显示空白符',
    en: 'Show whitespace',
  },
  tokenizerResultIdleStatus: {
    'zh-Hans': '等待输入或点击运行。',
    en: 'Waiting for input or Run.',
  },
  tokenizerResultLoadingStatus: {
    'zh-Hans': 'Web Worker 正在处理 latest-only 请求…',
    en: 'The Web Worker is processing the latest-only request…',
  },
  tokenizerResultDirectionLabel: {
    'zh-Hans': '方向',
    en: 'Direction',
  },
  tokenizerResultContentTokenLabel: {
    'zh-Hans': '正文 Token',
    en: 'Content tokens',
  },
  tokenizerResultApproximateTemplateOverheadLabel: {
    'zh-Hans': '模板开销（近似）',
    en: 'Template overhead (approximate)',
  },
  tokenizerResultBytesPerTokenLabel: {
    'zh-Hans': 'Bytes / Token',
    en: 'Bytes / Token',
  },
  tokenizerResultMappingLabel: {
    'zh-Hans': '映射',
    en: 'Mapping',
  },
  tokenizerResultMappingColumn: {
    'zh-Hans': 'Mapping',
    en: 'Mapping',
  },
  tokenizerResultDecodedOnlyWarning: {
    'zh-Hans': '当前映射是 {mapping}，不能按原文划分角色',
    en: 'The current mapping is {mapping}; roles cannot be divided by source text.',
  },
  tokenizerResultGraphemeHeading: {
    'zh-Hans': 'Grapheme-safe 片段',
    en: 'Grapheme-safe segments',
  },
  tokenizerResultMergedSegmentChip: {
    'zh-Hans': '合并片段 · {count} tokens（完整 Decoded 见下方）',
    en: 'Merged segment · {count} tokens (see the full Decoded below)',
  },
  tokenizerResultSegmentTitleIds: {
    'zh-Hans': 'Token #{start}–{end} · IDs {ids}',
    en: 'Token #{start}–{end} · IDs {ids}',
  },
  tokenizerResultSegmentTitleCount: {
    'zh-Hans': 'Token #{start}–{end} · {count} IDs',
    en: 'Token #{start}–{end} · {count} IDs',
  },
  tokenizerResultSelectedTokenLabel: {
    'zh-Hans': '选中 Token',
    en: 'Selected token',
  },
  tokenizerResultSelectedRoleLabel: {
    'zh-Hans': 'Role',
    en: 'Role',
  },
  tokenizerResultSelectedPieceLabel: {
    'zh-Hans': 'Piece',
    en: 'Piece',
  },
  tokenizerResultTokenIdChipsAria: {
    'zh-Hans': 'Token ID 选择',
    en: 'Token ID selection',
  },
  tokenizerResultTokenIdChipAria: {
    'zh-Hans': 'Token ID {id}，index {index}',
    en: 'Token ID {id}, index {index}',
  },
  tokenizerResultTokensTableLabel: {
    'zh-Hans': 'Tokenizer Tokens',
    en: 'Tokenizer Tokens',
  },
  tokenizerResultPositionColumn: {
    'zh-Hans': '#',
    en: '#',
  },
  tokenizerResultSpecialColumn: {
    'zh-Hans': 'Special',
    en: 'Special',
  },
  tokenizerResultDecodedColumn: {
    'zh-Hans': 'Decoded',
    en: 'Decoded',
  },
  tokenizerResultLoadMoreAction: {
    'zh-Hans': '再显示 {count} 个 Token',
    en: 'Show {count} more tokens',
  },
  tokenizerResultTokenIdsPrefix: {
    'zh-Hans': 'Token IDs：',
    en: 'Token IDs: ',
  },
  tokenizerResultAuthoritativeInputPrefix: {
    'zh-Hans': '权威输入：',
    en: 'Authoritative input: ',
  },
  tokenizerResultDecodedTextPrefix: {
    'zh-Hans': '解码文本：',
    en: 'Decoded text: ',
  },
  tokenizerResultDecodedPrefix: {
    'zh-Hans': 'Decoded：',
    en: 'Decoded: ',
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
