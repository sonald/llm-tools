import { t } from "./i18n";
import type { MessageKey } from "./i18n/en";

export type ParseErrorMessageInput = {
  code?: string;
  message: string;
};

const messageKeys = new Map<string, MessageKey>([
  ["trailing_data", "parseError.trailingData"],
  ["invalid_utf8", "parseError.invalidUtf8"],
  ["unexpected_end_of_input", "parseError.unexpectedEndOfInput"],
  ["expected_scalar_json_value", "parseError.expectedScalarJsonValue"],
  ["expected_object_key", "parseError.expectedObjectKey"],
  ["expected_colon_after_object_key", "parseError.expectedColonAfterObjectKey"],
  ["expected_object_value_separator", "parseError.expectedObjectValueSeparator"],
  ["expected_array_element_separator", "parseError.expectedArrayElementSeparator"],
  ["invalid_json_literal", "parseError.invalidJsonLiteral"],
  ["leading_zero_not_allowed", "parseError.leadingZeroNotAllowed"],
  ["expected_digit", "parseError.expectedDigit"],
  ["expected_digit_after_decimal_point", "parseError.expectedDigitAfterDecimalPoint"],
  ["expected_digit_in_exponent", "parseError.expectedDigitInExponent"],
  ["unterminated_string", "parseError.unterminatedString"],
  ["unescaped_control_character_in_string", "parseError.unescapedControlCharacterInString"],
  ["unterminated_string_escape", "parseError.unterminatedStringEscape"],
  ["invalid_string_escape", "parseError.invalidStringEscape"],
  ["unpaired_high_surrogate", "parseError.unpairedHighSurrogate"],
  ["invalid_low_surrogate", "parseError.invalidLowSurrogate"],
  ["unpaired_low_surrogate", "parseError.unpairedLowSurrogate"],
  ["incomplete_unicode_escape", "parseError.incompleteUnicodeEscape"],
  ["invalid_unicode_escape_digit", "parseError.invalidUnicodeEscapeDigit"]
]);

export function parseErrorMessage(error: ParseErrorMessageInput): string {
  if (!Object.prototype.hasOwnProperty.call(error, "code")) return error.message;
  const key = typeof error.code === "string" ? messageKeys.get(error.code) : undefined;
  return key === undefined ? error.message : t(key);
}
