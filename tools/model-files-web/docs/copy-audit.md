# 文案对照：错误消息与英文（2026-11-14）

矩阵行见 `full-parity-matrix.md` §3.12（错误消息，zh-Hans）、§3.13（英文）。

**2026-11-14 已按本表修复**（M-1 至 M-4、E-1 至 E-3），保留的例外写在矩阵对应行。下表记录的是修复前的状态。

# 一、英文

原生英文：`tools/model-files/Sources/ModelFiles/Resources/Localizable.xcstrings`（551 个 key，全部有 `en`）。Web：`src/i18n.ts`（650 条）。按 zh-Hans 原文精确匹配，占位符归一化后比较英文。

## 计数

| 类别 | 条数 |
| --- | --- |
| zh 精确匹配到原生 | 466 |
| ├ 英文一致 | 373 |
| ├ 英文一致，且 Web 有 One/Many 分支 | 8 |
| ├ 只对上原生复数形式，Web 没做单复数（E-2） | 9 |
| └ 英文不同（E-1） | 76 |
| zh 无精确匹配 | 184 |
| ├ zh 有偏差但明显对应原生（E-3） | 30 |
| ├ 原生是 catalog 外的中文字面量（E-4） | 7 |
| ├ AppKit / SwiftUI 系统字符串（查找栏、边栏开关），英文一致 | 12 |
| └ Web 独有（HTTPS 来源、清除历史、复制反馈、Worker / 本地目录 / Range 错误、aria-label 等） | 135 |

## E-1 英文不同（zh 相同）

系统性差异：原生用 directory，Web 用 folder；原生 safe limit，Web safety limit；原生「Invalid X.」/「Missing X」，Web「The X is invalid.」/「X is missing」；原生菜单项和分类 Title Case，Web Sentence case；原生 Can't，Web Unable to。

| Web key | 原生 en | Web en |
| --- | --- | --- |
| summaryModelScale | Model size | Model scale |
| summaryGenerationSubtitle | …from the model directory… | …from the model folder… |
| summaryMaxNewTokens | Maximum new tokens | Max new tokens |
| summaryWeightIndexSubtitle | Only mappings are read; no weight shards are read. | Reads only the mapping, never any weight shard. |
| summaryVocabSubtitle | %lld token(s) total; the list shows at most the first 1,000 filtered items. | {count} tokens in total; …first 1,000 matches. |
| appNoteEmbeddedChatTemplate | Contains an embedded chat template (if present) | Includes the embedded chat template (if any) |
| appNoteSafeTensors | Reads the JSON header only | Reads only the JSON header |
| appNoteGGUF | Reads the metadata prefix only | Reads only the metadata prefix |
| appUnableToOpenLocationTitle | Can't open location | Unable to open location |
| appNoModelOpenTitle | No model open yet | No model open |
| appNoMatchingFilesMessage | …or clear the current filter. | …or clear the filter. |
| appHeaderCopyPathHelp | Copy the file path | Copy file path |
| appHeaderCopyFullPathHelp | Copy the file's full path or URL（直引号） | Copy the file’s full path or URL |
| appHeaderOpenSourceHelp | Open the current version in a browser | Open this version in the browser |
| appPurposeTokenizer | Tokenizer resources | Tokenizer resource |
| appPurposeTemplates | Chat templates | Chat template |
| appPurposeOther | Model files | Model file |
| appPurposeLockedWeights | Model weights (loading disabled) | Model weights (not loaded) |
| appLiveDirectoryStatus | Live directory | Live folder |
| consistencyInsufficientMaterials | Insufficient data | Insufficient materials |
| vocabularyMismatchTitle | Vocabulary size mismatch | Vocabulary sizes do not match |
| vocabularyMismatchDetail | config.json and tokenizer.json have different vocabulary counts. | The vocabulary counts in config.json and tokenizer.json differ. |
| missingTokenizerClassTitle | Missing tokenizer_class | tokenizer_class is missing |
| missingChatTemplateTitle | Missing usable chat template | No usable chat template |
| safeTensorsMetadataNotStringDictionary | …must be a dictionary of strings. | …must be a string dictionary. |
| safeTensorsTensorShapeInvalid | Invalid structure for SafeTensors tensor %@. | The structure of SafeTensors tensor {name} is invalid. |
| safeTensorsTensorOffsetsInvalid | Invalid data_offsets for SafeTensors tensor %@. | The data_offsets of SafeTensors tensor {name} are invalid. |
| eosMismatchTitle | EOS token mismatch | EOS tokens do not match |
| eosMismatchDetail | …and the tokenizer have different reliable EOS IDs. | …and tokenizer report different reliable EOS IDs. |
| contextLengthMismatchDetail | …often have different semantics; confirm manually. | …often carry different semantics; review them manually. |
| missingModelConfigTitle | Missing model configuration | Model configuration is missing |
| ggufParseFailed | Failed to parse GGUF: %@ | GGUF parsing failed: {reason} |
| ggufMagicInvalid | Invalid GGUF magic. | The GGUF magic is invalid. |
| ggufVersionUnsupported | Unsupported GGUF version. | The GGUF version is unsupported. |
| ggufTensorCountExceeded / ggufMetadataCountExceeded / ggufArrayElementCountExceeded | …exceeds the safe limit. | …exceeds the safety limit. |
| ggufMetadataKeyInvalidOrDuplicate | Invalid or duplicate GGUF metadata key. | The GGUF metadata key is invalid or duplicated. |
| ggufAlignmentInvalid | Invalid GGUF general.alignment. | The GGUF general.alignment is invalid. |
| ggufTensorNameInvalidOrDuplicate | Invalid or duplicate GGUF tensor name. | The GGUF tensor name is invalid or duplicated. |
| ggufTensorDimensionCountExceeded | GGUF tensor %@ has too many dimensions. | The GGUF tensor {name} dimension count exceeds the safety limit. |
| ggufTensorOffsetMisaligned | The offset of GGUF tensor %@ is not aligned to alignment. | The GGUF tensor {name} offset is not aligned to alignment. |
| ggufShapeOverflow | GGUF %@ overflow. | The GGUF {context} overflows. |
| ggufParameterTotalOverflowContext | total parameter count | parameter total |
| ggufStringLimitExceeded | A GGUF string exceeds the safe length limit. | The GGUF string exceeds the safety limit. |
| ggufStringUtf8Invalid | A GGUF string is not valid UTF-8. | The GGUF string is not valid UTF-8. |
| ggufBoolValueInvalid | A GGUF boolean must be 0 or 1. | A GGUF bool value must be 0 or 1. |
| ggufArrayDepthExceeded | GGUF metadata array nesting exceeds the safe limit. | The GGUF metadata array nesting exceeds the safety limit. |
| ggufArrayElementTypeInvalid | Invalid GGUF metadata array type. | The GGUF metadata array type is invalid. |
| ggufMetadataTypeInvalid | Invalid GGUF metadata type %@. | The GGUF metadata type {typeCode} is invalid. |
| tokenizerRootNotObject | The tokenizer.json root node is not an object. | The tokenizer.json root is not an object. |
| arrayValueSummary | Array · %lld item(s) | array · {count} items |
| stringValueSummary | String · %lld character(s) | string · {count} characters |
| inputLabel | Input | The input |
| cmpLeftCount | Primary: %lld token(s) | Primary {count} |
| cmpRightCount | Comparison: %lld token(s) | Comparison {count} |
| cmpPrimaryOnlyCount | Primary only: %lld token(s) | Primary only {count} |
| cmpComparisonOnlyCount | Comparison only: %lld token(s) | Comparison only {count} |
| cmpSharedCount | Shared: %lld token(s) | Shared {count} |
| tjvLengthSubtitle | %lld base vocabulary entr(y/ies); counted as Unicode scalars of the original token piece. | Base vocabulary: {count} entries; counted in Unicode scalars of the original token pieces. |
| tjvBucketSummary | Length %@: %lld entr(y/ies), %@ of base vocabulary. | …{percent} of the base vocabulary. |
| readerExpandAllFolds | Expand All | Expand all |
| noticeImatrix | Read the complete %@ legacy imatrix file… | Read the whole {size} legacy imatrix file… |
| noticeWeightIndex | Only the weight shard index is read; no weight files are requested. | Reads only the weight shard index; no weight file is requested. |
| appFileProblemCount | %lld problems | Problems: {count} |
| appCategoryWeightMetadata | Weight Metadata | Weight metadata |
| appCategoryWeights | Weight Files | Weights |
| appCopyPathAction | Copy Path | Copy path |
| appCopyRelativePathAction | Copy Relative Path | Copy relative path |
| appCopyFullPathAction | Copy Full Path | Copy full path |
| appOpenOriginalFileAction | Open Original File | Open original file |
| appSelectFileMessage | File contents load after a file is selected. | File contents load only after you select a file. |
| appSourceLinkAction | Open at source | Open on source |
| appUnableToReadFileTitle | Can't read file | Unable to read file |
| appLockedWeightsMessage | To avoid accidentally downloading…size, and hash. | To avoid downloading large files by accident…size and hash. |
| sentencepieceVocabularyUnavailable | …parseable… | …parsable… |

## E-2 缺单复数

数量为 1 时会显示「1 warnings」之类。原生 xcstrings 有 plural 变体，Web 直接 `t(key, { count })`：consistencyWarningCount、templateLines、templateBytes、tkpBytes、tkpDecodedDetail、tkpSourceDetail、tkpTableAria、tjvSearchCount、tjvBucketAria；E-1 里的 cmp*、arrayValueSummary、stringValueSummary、tjvLengthSubtitle、tjvBucketSummary、summaryVocabSubtitle 同样。

## E-3 zh 也有偏差的条目

原生两段拼接的消息已先拼好再比。

| Web key | 原生（zh / en） | Web 偏差 |
| --- | --- | --- |
| imatrix* 8 条（EntryCount / TensorName / Counts / NonFinite / ChunkCount / DatasetLength / Dataset / FileTruncated） | 小写 `imatrix`；「Invalid imatrix …」句式，「The imatrix file ended early.」 | zh、en 都写成 `Imatrix`，en 句式不同 |
| sentencepieceInvalidModel | 「… model 无效」 | 「模型无效」 |
| vocabularySearchUnsupported | 当前 vocab 结构无法搜索。 | 多了「：{reason}」 |
| leftTokenizerRootNotObject | 同 tokenizerRootNotObject | 多了「左侧」 |
| chatTemplateUnsupportedObjectValue | 带尾句「支持字符串、对象字典或 named 数组。」 | 缺尾句。原生英文拼出来是「strings..」双句点，属原生 bug，不照抄 |
| chatTemplateUnsupportedValue | …null, a number, or a Boolean value. …object dictionary… | …null, number, or boolean. …object map… |
| chatTemplateNamedItemInvalid{Shape,Name,Template} | 「index %lld 的 named chat_template 条目无效：理由」拼接 | 展开成整句，英文以 Invalid… 开头；原生理由片段首字母大小写不统一 |
| appRepositoryConsistencyReportAriaLabel | 查看仓库一致性报告 | 少「查看」 |
| appLoadingSwitchHint | 「· 可切换到其他文件取消」 | 少前缀「· 」 |
| readerFoldStructureLine | Expand / Collapse structure at line %@（两条） | 一条带 {action}，on line |
| objectValueSummary + valueTypeSuffix | Object · %lld field(s) [· type: %@] | object · {count} fields{suffix} |
| rangeNotConfirmed / fileRequestFailed / wholeFileLimitExceeded / localDirectoryFileLimitExceeded | 见 §3.12 错误文案 | |
| noticePdf / appNoModelOpenMessage | 平台调整后的改写（P-6、P-2/P-3） | 保留 |

## E-4 原生英文界面显示中文的字面量

catalog 外的字面量，原生英文界面直接显示中文；Web 给的是英文。**D-15 已裁决（2026-11-14）**：Web 保留英文，原生补进 catalog。

| Web key | 原生字面量 | Web en |
| --- | --- | --- |
| appLoadingImage | 正在读取图片…（InspectionDocument.swift:29） | Reading image… |
| noticeImage | 读取了完整的 %@ 图片数据，在本地直接渲染。（InspectionDocument.swift:159） | Read the whole {size} of image data; rendered locally. |
| readerImageFit | 适应窗口（ImageReaderView.swift:72） | Fit |
| readerZoomOut | .help("缩小")（ImageReaderView.swift:95） | Zoom out |
| readerZoomIn | .help("放大")（ImageReaderView.swift:108） | Zoom in |
| readerImageCannotDisplay | 无法显示图片（ImageReaderView.swift:146） | Unable to Display Image |
| readerImageCannotDecode | 系统无法解码此图片格式。（ImageReaderView.swift:148） | The system can’t decode this image format. |

另：RepositoryService.swift:86「无法解析图片文件。」也在 catalog 外。

# 二、错误消息（zh-Hans）

约 49 条逐字一致：GGUF inspector 全部、SafeTensors 8 条、Token ID 空输入 / 根数组 / 超限、chat_template null、模板变量与 Tool 8 条、tokenizer.json 根节点、对照会话与词表差集跳过、「无法打开位置 / 无法读取文件」。

**数字分组**：原生 `String(localized:)` 插值的 Int 也分组（swift 实测「第 12,345 个 token（index 12,344）」），Web `translate()` 用 `String(value)`。凡直接传 number 的都要走 `formatNumber`。

## M-1 差异表

| 原生（file:line） | Web（`i18n.ts` key） | 结论 |
| --- | --- | --- |
| shortRead「读取不完整：需要 N 字节，只收到 M 字节。」RepositoryService.swift:96（本地） | `rangeShortRead`「Range 短读：期望 {expected}，收到 {actual} bytes。」（huggingface.ts:383 本地 slice） | 不同：混入 bytes、未分组 |
| RangeError.incomplete「Range 响应不完整：需要 N 字节，只收到 M 字节。」HTTPRangeLoader.swift:13 | 同上 `rangeShortRead`（huggingface.ts:402） | 两条合成了一条 |
| RangeError.unsupported「源站未确认 HTTP Range（状态码 N），已取消以避免下载完整权重。」HTTPRangeLoader.swift:11 | `rangeNotConfirmed`「源站未确认 Range（HTTP {status}），已停止以避免完整下载。」 | 措辞 |
| fileTooLarge「文件大小为 {size}，超过 32 MB 阅读上限。」:74 | `wholeFileLimitExceeded`「文件超过 {limit} 阅读上限。」，limit = formatBytes(32 MiB) =「33.6 MB」 | 缺实际大小；上限显示成 33.6 MB |
| requestFailed「请求失败（HTTP N）：{响应体前 512 字节}」:68 | `huggingfaceManifestRequestFailed` / `fileRequestFailed`「…HTTP {status}」 | 丢了服务端消息 |
| invalidModelID「模型 ID 无效，请使用类似 Qwen/Qwen3-4B 的格式。」:44 | `huggingfaceModelIdRequired`「请输入 owner/model 或公开 Hugging Face 仓库 URL。」 | 不同 |
| tooManyFiles「模型目录超过 100,000 个文件，请选择更小的目录。」:52 | `localDirectoryFileLimitExceeded`「本地目录超过 {limit} 个文件上限。」 | 措辞 |
| unsafePath「文件路径不安全，已拒绝读取：{path}」:56 | `invalidRepositoryPath`「仓库文件路径无效。」；`localFilePathTooLarge`「…4 KiB 上限。」 | 缺路径；原生同情况走 unsafePath |
| fileChanged「文件已在清单生成后发生变化，请刷新目录：{path}」:58 | `changedLocalFile`「本地文件已变化，请重新选择目录。」 | 缺路径（「重新选择」属 P-3） |
| invalidUTF8（.jinja）「文件不是有效的 UTF-8 文本。」:92；unsupportedBinary「该文件没有专用阅读器，且内容不是可安全显示的 UTF-8 文本。」:94 | 都用 `invalidUtf8Text`「文本不是有效的 UTF-8。」/ `textContainsNulByte` | 缺 unsupportedBinary |
| invalidImage「无法解析图片文件。」:86 | 无预解码，落到阅读器兜底「无法显示图片」 | Web 缺（可用 createImageBitmap 预检） |
| 「Imatrix 无效：{msg}」:82 + 小写内层 9 条（IMatrixInspector.swift:36-152） | 只抛内层，首字母大写「Imatrix …」 | 9 条不同 |
| TokenizerBundleLoader missingSize「来源没有提供 {path} 的大小，无法在安全上限内读取。」:22 | `tokenizerBundleSizeMissing`「仓库未提供完整的 tokenizer 资源大小，已拒绝加载。」 | 缺路径 |
| fileTooLarge「{path} 大小为 {size}，超过分词器单文件上限 {limit}。」:24；bundleTooLarge「分词器资源合计 {size}，超过 {limit} 安全上限。」:26 | `tokenizerBundleTooLarge`「Tokenizer 资源超过 {limit} 上限。」 | 两条合一，缺路径和大小 |
| invalidSelection「只能为 tokenizer.json 或 SentencePiece .model 打开分词试验台：{path}」:20 | `tokenizerBundleSameDirectory` | 条件和文案都不同 |
| TokenizerRuntime 外壳「tokenizer.json 无效：」「tokenizer_config.json 无效：」「当前运行时无法加载该 tokenizer：」:17-25 | worker 直接抛 JSON.parse / TextDecoder / 库的英文消息（tokenizer.worker.ts:45-110） | 缺前缀，内层英文 |
| 缺 tokenizer_config 时报 unsupported | `missingTokenizerConfigRuntime` | 不同 |
| 「SentencePiece model 无效：{msg}」:19 | `sentencepieceInvalidModel`「SentencePiece 模型无效：…」 | model / 模型 |
| chat_template 对象值「…对象值必须是字符串。支持字符串、对象字典或 named 数组。」 | `chatTemplateUnsupportedObjectValue` 缺后半句 | 不同 |
| named 条目「chat_template 的第 {i} 个 named 条目无效：…」句末无句号，index 分组 | 句末多「。」，index 未分组 | 细节 |
| invalidJinja「chat_template.jinja 无效：不是有效 UTF-8」:31 | `invalidUtf8Text` | 不同 |
| 一致性检查：「tokenizer_config.json 根节点不是对象。」「tokenizer_config.json 不是有效 JSON：…」 | `jsonRootNotObject`「JSON 根节点不是对象。」；无效 JSON 透出英文 SyntaxError | 不同 |
| Token 序号「第 {i} 个 token（index {i}）…」分组 | `tokenNegative` / `tokenInvalid` / `tokenOverflow` 未分组 | ≥1000 时不同 |
| GGUF typeCode `.formatted()` | gguf.ts:158/236 原样 | ≥1000 时不同 |
| tojson sort_keys / separators 报错 TemplateRenderer.swift:121/126 | 无 | D-13 ① 已裁决，不做 |
| 原生平台限定：noSourceAvailable（ModelScope）、invalidPDF（PDFKit）、SSH 系列 | — | 保留差异 |
| Web 多出的检查（size 缺失拒读、Content-Range、响应超限、size 不符、Worker 协议、64 KiB 搜索等） | — | Web 独有条件；size 缺失见 W-6 |

## M-2 中英混杂

- 透出浏览器英文：JSON.parse SyntaxError（`templateJsonInvalid`、`tokenIdJsonInvalid`、一致性检查、tokenizer worker）、TextDecoder TypeError、**Hugging Face 来源的 fetch 网络错误**（「Failed to fetch」；只有 HTTPS 来源经 `fetchHttps` 映射，huggingface.ts:198、357 没有）
- 文案夹英文：`rangeShortRead` 的 bytes、`tokenIdArrayInvalid` 的 safe integer、`tokenOverheadCountInvalid` 的 Token overhead count
- 硬编码单位：`textTooLarge`、`vocabularySearchInputTooLarge`、`encodedInputTooLarge` 写「64 KiB」，`localFilePathTooLarge` 写「4 KiB」；原生 ByteCountFormatter 显示「66 KB」「4 KB」

## M-3 潜在 bug

`tokenizerClient.ts:277` 调 `t('tokenIdInputTooLarge')` 没传 `{limit}`，`translate()` 会抛英文「Translation values mismatch…」。目前走不到（调用方先经过 `parseTokenIds` 的 64 KiB 检查）。
