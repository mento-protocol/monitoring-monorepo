export const BASIS_POINTS = 10_000n;
export const FIXED_15 = 10n ** 15n;
export const MAX_BUDGET_EURM_RAW = 100_000n * 10n ** 18n;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/u;
export const BLOCK_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/u;
const CANONICAL_INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/u;
const ISO_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{2}:\d{2})$/u;
export const EXPECTED_CHAIN_ID = 137n;
export const EXPECTED_PIN_BLOCK_NUMBER = 91_830_875n;
export const EXPECTED_PIN_BLOCK_HASH =
  "0x3f7cc53580045d0e9c7e862406891a9e152b7b2c47b0eeed1b73bcebe214af25";
export const EXPECTED_POOL_ADDRESS =
  "0xcd8c6811d975981f57e7fb32e59f0bee66af3201";
export const EXPECTED_PROTOCOL_FEE_RECIPIENT =
  "0x0dd57f6f181d0469143fe9380762d8a112e96e4a";
export const EXPECTED_QUOTE_TOKEN_ADDRESS =
  "0x4d502d735b4c574b487ed641ae87ceae884731c7";
export const EXPECTED_MONITORED_TOKEN_ADDRESS =
  "0x888883b5f5d21fb10dfeb70e8f9722b9fb0e5e51";
export const EXPECTED_QUOTE_TOKEN_DECIMALS = 18n;
export const EXPECTED_MONITORED_TOKEN_DECIMALS = 6n;
export const EXPECTED_SAFE_ADDRESS =
  "0x58099b74f4acd642da77b4b7966b4138ec5ba458";
export const EXPECTED_SAFE_THRESHOLD = 4n;
export const EXPECTED_SAFE_OWNER_COUNT = 6n;
export const EXPECTED_ORACLE_ADAPTER =
  "0xeb23e1339b2119c0f4a0097cb294e990c1fa6423";
export const EXPECTED_SORTED_ORACLES =
  "0x6f92c745346057a61b259579256159458a0a6a92";
export const EXPECTED_BREAKER_BOX =
  "0x9fc1e0d10fb38954da385b8b25ab2bbaf3241722";
export const EXPECTED_VALUE_DELTA_BREAKER =
  "0xca2e7563dfc30bc94687f3deacf682e1dbaffa13";
export const EXPECTED_RATE_FEED = "0xc22418a83dfc262b10a1f57e25309db83e7ea79e";
export const EXPECTED_OPEN_STRATEGY =
  "0x54e2ae8c8448912e17ce0b2453bafb7b0d80e40f";
export const EXPECTED_RESERVE_STRATEGY =
  "0xa0fb8b16ce6af3634ff9f3f4f40e49e1c1ae4f0b";
export const EXPECTED_RESERVE_V2 = "0x4255cf38e51516766180b33122029a88cb853806";
export const EXPECTED_LP_CUSTODY_SAFE =
  "0x3fac3fef4408cfb03aa190fbd94d571c42cfd1f1";
export const EXPECTED_RATE_RAW = 1_000_000_000_000_000_000_000_000n;
export const EXPECTED_HALT_RATE_RAW = 994_000_000_000_000_000_000_000n;
export const EXPECTED_VALUE_DELTA_THRESHOLD_RAW =
  5_000_000_000_000_000_000_000n;
export const EXPECTED_VALUE_DELTA_BPS = 50n;
export const EXPECTED_RATE_DECIMALS = 24n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const EXPECTED_WITNESS_MODEL = "europ-reserve-rebalance-51-cycle-v1";
export const EXPECTED_MENTO_CORE_COMMIT =
  "07ecf3df5650a33ea6957f1ad2966e02c5082253";
export const EXPECTED_LP_CUSTODY_BALANCE_RAW = 8_659_037_237_856_031n;
export const EXPECTED_LP_TOTAL_SUPPLY_RAW = 8_660_537_237_856_031n;
export const EXPECTED_QUOTE_RESERVE_RAW = 6_932_949_238_266_138_502_114n;
export const EXPECTED_MONITORED_RESERVE_RAW = 10_399_423_858n;
export const EXPECTED_TRADING_LIMITS = [
  {
    name: "L0",
    limitFixed15: 50_000_000_000_000_000_000n,
    durationSeconds: 300n,
    netflowFixed15: 3_498_250_000_000_000_000n,
    lastUpdated: 1_785_520_845n,
  },
  {
    name: "L1",
    limitFixed15: 250_000_000_000_000_000_000n,
    durationSeconds: 86_400n,
    netflowFixed15: 9_229_728_525_000_000_000n,
    lastUpdated: 1_785_453_845n,
  },
];
export const EXPECTED_BUDGET_APPROVER = "Philip Paetz";
export const EXPECTED_BUDGET_APPROVAL_REFERENCE =
  "https://github.com/mento-protocol/monitoring-monorepo/issues/1687#issuecomment-5254428553";
export const EXPECTED_ESCALATION_ROUTE =
  "active @support-engineer resolved from VictorOps / Splunk On-Call";
export const EXPECTED_EXECUTION_PROOF_REFERENCE =
  "https://polygonscan.com/tx/0x967535dc2f331298c2f88feb8a148e60a85fdc8a84dc1d3f83fcea547ef3b8b4";
export const EXPECTED_RESPONSE_SECONDS = 21_600n;
export const EXPECTED_EXECUTION_SECONDS = 7_889n;

export function requiredObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

export function requiredArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

export function integer(value, field) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} must be a safe integer number`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && CANONICAL_INTEGER_PATTERN.test(value)) {
    return BigInt(value);
  }
  throw new Error(
    `${field} must be a canonical integer string or safe integer number`,
  );
}

export function nonNegative(value, field) {
  const parsed = integer(value, field);
  if (parsed < 0n) throw new Error(`${field} must be non-negative`);
  return parsed;
}

export function positive(value, field) {
  const parsed = nonNegative(value, field);
  if (parsed === 0n) throw new Error(`${field} must be positive`);
  return parsed;
}

export function optionalNonNegative(value, field) {
  if (value === null || value === undefined) return null;
  return nonNegative(value, field);
}

export function ceilDiv(numerator, denominator) {
  if (numerator < 0n || denominator <= 0n) {
    throw new Error(
      "ceilDiv requires a non-negative numerator and positive denominator",
    );
  }
  return (numerator + denominator - 1n) / denominator;
}

export function min(values) {
  if (values.length === 0) throw new Error("cannot take minimum of no values");
  return values.reduce((current, value) => (value < current ? value : current));
}

export function issue(code, message) {
  return { code, message };
}

export function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function matchesAddress(value, expected) {
  return (
    hasText(value) &&
    ADDRESS_PATTERN.test(value) &&
    value.toLowerCase() === expected
  );
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return days[month - 1] ?? 0;
}

export function timestamp(value) {
  if (!hasText(value)) return null;
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    millisecondText,
    offsetText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = millisecondText ? Number(millisecondText) : 0;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (offsetText !== "Z") {
    if (offsetText === "-00:00") return null;
    const offsetHours = Number(offsetText.slice(1, 3));
    const offsetMinutePart = Number(offsetText.slice(4, 6));
    if (
      offsetHours > 14 ||
      offsetMinutePart > 59 ||
      (offsetHours === 14 && offsetMinutePart !== 0)
    ) {
      return null;
    }
    offsetMinutes = offsetHours * 60 + offsetMinutePart;
    if (offsetText.startsWith("-")) offsetMinutes = -offsetMinutes;
  }

  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  const parsed = wallClock.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(parsed) ? parsed : null;
}
