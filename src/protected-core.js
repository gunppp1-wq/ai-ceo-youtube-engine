// ============================================================
// PROTECTED CORE — DO NOT MODIFY
// This file contains the 3 structurally-locked rules for the
// AI CEO YouTube Engine. Any future self-modification system
// must NEVER be given write access to this file.
//
// Rule 1: No payment information, ever.
// Rule 2: Zero cost until the program generates real revenue.
// Rule 3: Safety and legality are absolute gates.
// ============================================================

const SAFETY_BLOCKLIST = {
  violent_dangerous: ["shooting", "murder", "death", "war crime", "explosion", "terrorist", "weapon sale", "torture", "execution", "massacre"],
  child_safety: ["child", "minor", "csam", "groom", "underage"],
  self_harm: ["suicide", "self-harm", "self harm", "cutting", "overdose"],
  hate_harassment: ["hate speech", "slur", "extremist", "nazi", "genocide", "ethnic cleansing"],
  spam_scam: ["scam", "phishing", "counterfeit", "pyramid scheme", "get rich quick", "guaranteed profit"],
  regulated_goods: ["illegal drug", "drug trafficking", "firearm sale", "explosive sale"],
  misinformation: ["election fraud", "vaccine hoax", "fake cure"]
};

export function passesPlatformSafetyGate(text) {
  if (!text) return { passes: false, reason: "empty content" };
  const lower = text.toLowerCase();

  for (const [category, words] of Object.entries(SAFETY_BLOCKLIST)) {
    const matched = words.find(word => lower.includes(word));
    if (matched) {
      return { passes: false, reason: `${category}: matched "${matched}"` };
    }
  }

  return { passes: true, reason: null };
}

export const MIN_PROFIT_SCORE = 100;
export const MIN_SCRIPT_LENGTH = 80;

export function passesEconomicsGate(opp, generatedScript) {
  if (!opp.profit_score || opp.profit_score < MIN_PROFIT_SCORE) {
    return { passes: false, reason: `profit_score too low or missing: ${opp.profit_score}` };
  }

  if (!generatedScript || generatedScript.trim().length < MIN_SCRIPT_LENGTH) {
    return { passes: false, reason: `script too short or missing: ${generatedScript ? generatedScript.trim().length : 0} chars` };
  }

  const words = generatedScript.trim().split(/\s+/);
  const uniqueWords = new Set(words.map(w => w.toLowerCase()));
  const repetitionRatio = uniqueWords.size / words.length;
  if (words.length > 10 && repetitionRatio < 0.4) {
    return { passes: false, reason: `script appears too repetitive: ${uniqueWords.size}/${words.length} unique words` };
  }

  return { passes: true, reason: null };
}

const FORBIDDEN_PAYMENT_KEYWORDS = ["card_number", "cvv", "bank_account_number", "routing_number", "swift_code", "iban", "ssn", "social_security"];

export function containsForbiddenPaymentField(obj) {
  const str = JSON.stringify(obj).toLowerCase();
  return FORBIDDEN_PAYMENT_KEYWORDS.some(kw => str.includes(kw));
}
