cmake_minimum_required(VERSION 3.16)
project(sentencepiece_wasm VERSION 0.2.2 LANGUAGES CXX)

set(SPM_ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(SPM_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_TCMALLOC OFF CACHE BOOL "" FORCE)
set(SPM_ENABLE_BENCHMARK OFF CACHE BOOL "" FORCE)
set(SPM_PROTOBUF_PROVIDER internal CACHE STRING "" FORCE)

include(GNUInstallDirs)
set(INSTALL_DATADIR "${CMAKE_INSTALL_PREFIX}/${CMAKE_INSTALL_DATADIR}/sentencepiece")
configure_file(
  "${SENTENCEPIECE_SOURCE}/config.h.in"
  "${CMAKE_BINARY_DIR}/sentencepiece-src/config.h"
  @ONLY
)
add_subdirectory(${ABSEIL_SOURCE} absl)

set(ABSL_INCLUDE_OVERLAY "${CMAKE_BINARY_DIR}/sentencepiece-include")
set(ABSL_INCLUDE_LINK "${ABSL_INCLUDE_OVERLAY}/third_party/absl")
file(MAKE_DIRECTORY "${ABSL_INCLUDE_OVERLAY}/third_party")
if(IS_SYMLINK "${ABSL_INCLUDE_LINK}")
  file(READ_SYMLINK "${ABSL_INCLUDE_LINK}" ABSL_INCLUDE_LINK_TARGET)
  if(NOT ABSL_INCLUDE_LINK_TARGET STREQUAL "${ABSEIL_SOURCE}/absl")
    message(FATAL_ERROR "Abseil include overlay symlink mismatch: ${ABSL_INCLUDE_LINK_TARGET}")
  endif()
elseif(EXISTS "${ABSL_INCLUDE_LINK}")
  message(FATAL_ERROR "Abseil include overlay is not a symlink: ${ABSL_INCLUDE_LINK}")
else()
  file(CREATE_LINK "${ABSEIL_SOURCE}/absl" "${ABSL_INCLUDE_LINK}" SYMBOLIC)
endif()

include_directories(BEFORE
  "${ABSL_INCLUDE_OVERLAY}"
  "${ABSEIL_SOURCE}"
  "${SENTENCEPIECE_SOURCE}"
)
add_subdirectory("${SENTENCEPIECE_SOURCE}/src" sentencepiece-src)
add_executable(sentencepiece-wasm wrapper.cc)
target_compile_features(sentencepiece-wasm PRIVATE cxx_std_17)
target_include_directories(sentencepiece-wasm PRIVATE
  "${ABSL_INCLUDE_OVERLAY}"
  "${ABSEIL_SOURCE}"
  "${SENTENCEPIECE_SOURCE}"
  "${SENTENCEPIECE_SOURCE}/src"
)
target_compile_options(sentencepiece-wasm PRIVATE -fno-exceptions)
target_link_libraries(sentencepiece-wasm PRIVATE sentencepiece-static)
target_link_options(sentencepiece-wasm PRIVATE
  -lembind
  -sDISABLE_EXCEPTION_CATCHING=1
  -sDYNAMIC_EXECUTION=0
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sALLOW_MEMORY_GROWTH=1
  -sFILESYSTEM=0
  -sENVIRONMENT=web,worker,node
)
set_target_properties(sentencepiece-wasm PROPERTIES SUFFIX ".mjs")
