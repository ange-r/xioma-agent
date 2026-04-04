// Pure distribution logic — no network calls, no side effects.
// Receives a cashflow input and returns a distribution plan.

const VALID_CATEGORIES = ["salaries", "suppliers", "taxes", "services", "operating_cash"];
const SUPPORTED_CURRENCIES = ["USDC"];
const MAX_AMOUNT = 1_000_000;
const STELLAR_DECIMALS = 7;

// Validates the incoming cashflow payload before any calculation.
// Throws a descriptive error if the input is invalid.
function validateInput(amount, currency, obligations) {
  // Validate amount
  if (amount === undefined || amount === null) {
    throw new Error("Missing required field: amount");
  }
  if (typeof amount !== "number" || isNaN(amount)) {
    throw new Error("Invalid amount: must be a number");
  }
  if (amount <= 0) {
    throw new Error("Invalid amount: must be greater than zero");
  }
  if (amount > MAX_AMOUNT) {
    throw new Error(`Amount exceeds maximum allowed: ${MAX_AMOUNT} USDC`);
  }

  // Validate currency
  if (!currency) {
    throw new Error("Missing required field: currency");
  }
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw new Error(`Unsupported currency: "${currency}". Supported: ${SUPPORTED_CURRENCIES.join(", ")}`);
  }

  // Validate obligations structure
  if (!obligations || typeof obligations !== "object" || Array.isArray(obligations)) {
    throw new Error("Invalid obligations: must be a non-empty object");
  }

  const categories = Object.keys(obligations);
  if (categories.length === 0) {
    throw new Error("Invalid obligations: at least one category is required");
  }

  // Validate each category
  for (const category of categories) {
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(
        `Invalid category: "${category}". Valid categories are: ${VALID_CATEGORIES.join(", ")}`
      );
    }
    const pct = obligations[category];
    if (typeof pct !== "number" || isNaN(pct)) {
      throw new Error(`Invalid percentage for "${category}": must be a number`);
    }
    if (pct < 0 || pct > 1) {
      throw new Error(`Invalid percentage for "${category}": must be between 0 and 1`);
    }
  }

  // Warn about zero-value categories — valid but suspicious
  const zeroCategories = categories.filter((c) => obligations[c] === 0);
  if (zeroCategories.length > 0) {
    console.warn(
      `[Xioma Agent] Warning: zero allocation for categories: ${zeroCategories.join(", ")}`
    );
  }

  // Percentages must sum to exactly 1 (allow small floating point tolerance)
  const total = Object.values(obligations).reduce((sum, pct) => sum + pct, 0);
  if (Math.abs(total - 1) > 0.0001) {
    throw new Error(
      `Obligations must sum to 1. Current sum: ${total.toFixed(4)}`
    );
  }
}

// Calculates the distribution plan for a given cashflow amount.
// Returns the amount allocated to each obligation category,
// rounded to Stellar's 7 decimal precision.
export function calculateDistribution(amount, currency, obligations) {
  validateInput(amount, currency, obligations);

  console.log(`[Xioma Agent] Calculating distribution for ${amount} ${currency}`);

  const plan = {};
  let allocated = 0;

  for (const [category, percentage] of Object.entries(obligations)) {
    const categoryAmount = parseFloat(
      (amount * percentage).toFixed(STELLAR_DECIMALS)
    );
    plan[category] = {
      percentage,
      amount: categoryAmount,
    };
    allocated += categoryAmount;
    console.log(
      `[Xioma Agent] ${category}: ${percentage * 100}% → ${categoryAmount} ${currency}`
    );
  }

  // Log rounding difference for transparency and auditability
  const difference = parseFloat((amount - allocated).toFixed(STELLAR_DECIMALS));
  if (difference !== 0) {
    console.warn(`[Xioma Agent] Rounding difference: ${difference} ${currency}`);
  }

  console.log(
    `[Xioma Agent] Distribution complete — total allocated: ${allocated} ${currency}`
  );

  return {
    input: { amount, currency },
    plan,
    totalAllocated: allocated,
    roundingDifference: difference,
    timestamp: new Date().toISOString(),
  };
}