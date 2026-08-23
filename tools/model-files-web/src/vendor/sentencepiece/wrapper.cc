#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <emscripten/bind.h>

#include "sentencepiece_processor.h"

namespace {

std::unique_ptr<sentencepiece::SentencePieceProcessor> processor;
int last_status = 0;
std::string last_error_message;

void clear_error() {
  last_status = 0;
  last_error_message.clear();
}

void record_error(std::string message) {
  last_status = 1;
  last_error_message = std::move(message);
}

}  // namespace

void LoadFromSerializedProto(emscripten::val model) {
  clear_error();
  if (!model.instanceof(emscripten::val::global("Uint8Array"))) {
    record_error("Model must be a Uint8Array");
    return;
  }
  auto loaded = std::make_unique<sentencepiece::SentencePieceProcessor>();
  const size_t size = model["byteLength"].as<size_t>();
  std::vector<uint8_t> bytes(size);
  emscripten::val memory_view{
      emscripten::typed_memory_view(size, bytes.data())};
  memory_view.call<void>("set", model);
  const auto status = loaded->LoadFromSerializedProto(
      absl::string_view(reinterpret_cast<const char*>(bytes.data()),
                        static_cast<absl::string_view::size_type>(bytes.size())));
  if (!status.ok()) {
    record_error(std::string(status.message()));
    processor.reset();
    return;
  }
  processor = std::move(loaded);
}

emscripten::val EncodeAsIds(const std::string& input) {
  emscripten::val result = emscripten::val::array();
  if (!processor) {
    record_error("Processor is not loaded");
    return result;
  }

  clear_error();
  std::vector<int> ids;
  const auto status = processor->Encode(input, &ids);
  if (!status.ok()) {
    record_error(std::string(status.message()));
    return result;
  }
  for (size_t i = 0; i < ids.size(); ++i) {
    result.set(static_cast<uint32_t>(i), emscripten::val(ids[i]));
  }
  return result;
}

emscripten::val EncodeAsPieces(const std::string& input) {
  emscripten::val result = emscripten::val::array();
  if (!processor) {
    record_error("Processor is not loaded");
    return result;
  }

  clear_error();
  std::vector<std::string> pieces;
  const auto status = processor->Encode(input, &pieces);
  if (!status.ok()) {
    record_error(std::string(status.message()));
    return result;
  }
  for (size_t i = 0; i < pieces.size(); ++i) {
    result.set(static_cast<uint32_t>(i), emscripten::val(pieces[i]));
  }
  return result;
}

std::string DecodeIds(emscripten::val ids) {
  if (!processor) {
    record_error("Processor is not loaded");
    return "";
  }

  clear_error();
  if (!ids.isArray()) {
    record_error("IDs must be an array");
    return "";
  }

  const auto decoded_ids =
      emscripten::convertJSArrayToNumberVector<int32_t>(ids);
  std::string decoded;
  const auto status = processor->Decode(decoded_ids, &decoded);
  if (!status.ok()) {
    record_error(std::string(status.message()));
    return "";
  }
  return decoded;
}

std::string IdToPiece(int32_t id) {
  if (!processor) {
    record_error("Processor is not loaded");
    return "";
  }

  clear_error();
  if (id < 0 || id >= processor->GetPieceSize()) {
    record_error("Invalid id: " + std::to_string(id));
    return "";
  }
  return std::string(processor->IdToPiece(id));
}

std::string lastError() {
  return last_error_message;
}

int status() {
  return last_status;
}

void release() {
  processor.reset();
  clear_error();
}

EMSCRIPTEN_BINDINGS(sentencepiece_wasm) {
  emscripten::function("LoadFromSerializedProto", &LoadFromSerializedProto);
  emscripten::function("EncodeAsIds", &EncodeAsIds);
  emscripten::function("EncodeAsPieces", &EncodeAsPieces);
  emscripten::function("DecodeIds", &DecodeIds);
  emscripten::function("IdToPiece", &IdToPiece);
  emscripten::function("lastError", &lastError);
  emscripten::function("status", &status);
  emscripten::function("release", &release);
}
